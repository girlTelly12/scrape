const fs = require("fs");
const path = require("path");

const SUCCESS_STATUSES = new Set(["downloaded", "already_exists"]);

function nowSql() {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function normalizeAssetUrl(value) {
    try {
        const parsed = new URL(String(value || ""));
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return String(value || "").trim();
    }
}

function extractHttpStatus(error) {
    const direct = Number(error && error.statusCode);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const match = /HTTP\s+(\d{3})/i.exec(String((error && error.message) || error || ""));
    return match ? Number(match[1]) : null;
}

function classifyDownloadError(error) {
    const httpStatus = extractHttpStatus(error);
    const text = String((error && error.message) || error || "");
    let status = "failed";

    if (error && error.code === "URL_SKIPPED_BY_POLICY") status = "skipped_external";
    else if (httpStatus === 404 || httpStatus === 410) status = "not_found";
    else if (httpStatus === 403) status = "forbidden";
    else if (httpStatus === 401) status = "unauthorized";
    else if (httpStatus === 429) status = "rate_limited";
    else if (httpStatus >= 500) status = "server_error";
    else if (/timeout|timed out|ETIMEDOUT/i.test(text)) status = "timeout";
    else if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(text)) {
        status = "network_error";
    }

    return {
        status,
        httpStatus,
        errorMessage: text.slice(0, 2000),
    };
}

function contentType(headers = {}) {
    const raw = headers["content-type"] || headers["Content-Type"] || "";
    return String(raw).split(";")[0].trim().toLowerCase();
}

function detectFileSignature(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

    const startsWith = (...bytes) =>
        buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
    const ascii = (start, end) => buffer.slice(start, end).toString("ascii");

    // PDF headers are normally at byte 0, but the specification allows leading bytes.
    const pdfHeaderIndex = buffer.slice(0, 1024).indexOf(Buffer.from("%PDF-", "ascii"));
    if (pdfHeaderIndex >= 0) {
        return { kind: "pdf", extension: ".pdf", mimeType: "application/pdf" };
    }

    // Microsoft Office Open XML files (.docx/.xlsx) and ordinary ZIP files.
    if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06) || startsWith(0x50, 0x4b, 0x07, 0x08)) {
        return { kind: "zip", extension: ".zip", mimeType: "application/zip" };
    }

    // Legacy Microsoft Office Compound Binary Format (.doc/.xls).
    if (startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
        return { kind: "ole", extension: "", mimeType: "application/x-ole-storage" };
    }

    if (startsWith(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) {
        return { kind: "rar", extension: ".rar", mimeType: "application/vnd.rar" };
    }
    if (startsWith(0xff, 0xd8, 0xff)) {
        return { kind: "jpeg", extension: ".jpg", mimeType: "image/jpeg" };
    }
    if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
        return { kind: "png", extension: ".png", mimeType: "image/png" };
    }
    if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
        return { kind: "gif", extension: ".gif", mimeType: "image/gif" };
    }
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
        return { kind: "webp", extension: ".webp", mimeType: "image/webp" };
    }
    if (startsWith(0x42, 0x4d)) {
        return { kind: "bmp", extension: ".bmp", mimeType: "image/bmp" };
    }
    if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) {
        return { kind: "tiff", extension: ".tif", mimeType: "image/tiff" };
    }

    // Common direct video/audio formats. These signatures let the scraper trust
    // actual bytes even when a legacy server sends text/html or octet-stream.
    if (buffer.length >= 12 && ascii(4, 8) === "ftyp") {
        return { kind: "mp4", extension: ".mp4", mimeType: "video/mp4" };
    }
    if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) {
        return { kind: "webm", extension: ".webm", mimeType: "video/webm" };
    }
    if (ascii(0, 4) === "OggS") {
        return { kind: "ogg", extension: ".ogg", mimeType: "application/ogg" };
    }
    if (ascii(0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
        return { kind: "mp3", extension: ".mp3", mimeType: "audio/mpeg" };
    }
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
        return { kind: "wav", extension: ".wav", mimeType: "audio/wav" };
    }

    return null;
}

function bodyLooksLikeHtml(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
    const sample = buffer.slice(0, 4096).toString("utf8").replace(/^\uFEFF/, "");
    return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<script\b|<meta\b)/i.test(sample);
}

function looksLikeHtml(buffer, headers = {}) {
    // Trust the actual file bytes before trusting a frequently incorrect server header.
    // Some Thai local-government sites return PDF bytes with Content-Type: text/html.
    if (detectFileSignature(buffer)) return false;
    if (bodyLooksLikeHtml(buffer)) return true;

    const type = contentType(headers);
    return type === "text/html" || type === "application/xhtml+xml";
}

function detectedContentType(buffer, headers = {}) {
    const signature = detectFileSignature(buffer);
    return signature ? signature.mimeType : contentType(headers);
}

function extensionFromContentType(headers = {}) {
    const type = contentType(headers);
    const map = {
        "application/pdf": ".pdf",
        "application/msword": ".doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/zip": ".zip",
        "application/x-zip-compressed": ".zip",
        "application/vnd.rar": ".rar",
        "application/x-rar-compressed": ".rar",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "video/quicktime": ".mov",
        "video/x-msvideo": ".avi",
        "audio/mpeg": ".mp3",
        "audio/mp4": ".m4a",
        "audio/wav": ".wav",
        "audio/ogg": ".ogg",
        "application/ogg": ".ogg",
        "application/vnd.apple.mpegurl": ".m3u8",
        "application/x-mpegurl": ".m3u8",
    };
    return map[type] || "";
}

function ensureFileNameExtension(fileName, headers = {}, buffer = null) {
    const name = String(fileName || "file");
    if (/\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|jpe?g|png|gif|webp|bmp|tiff?|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac)$/i.test(name)) return name;

    const signature = detectFileSignature(buffer);
    const ext = (signature && signature.extension) || extensionFromContentType(headers);
    return ext ? `${name}${ext}` : name;
}

function uniqueFilePath(directory, fileName) {
    const parsed = path.parse(fileName);
    let candidate = path.join(directory, fileName);
    let index = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
        index += 1;
    }
    return candidate;
}

function createAuditRecord(values = {}) {
    return {
        runId: values.runId || null,
        sectionKey: values.sectionKey || null,
        sectionLabel: values.sectionLabel || null,
        tableName: values.tableName || null,
        sourceType: values.sourceType || "news",
        detailId: values.detailId == null ? null : String(values.detailId),
        detailUrl: values.detailUrl || null,
        title: values.title || "",
        fileUrl: values.fileUrl || "",
        normalizedFileUrl: normalizeAssetUrl(values.normalizedFileUrl || values.fileUrl),
        fileName: values.fileName || null,
        fileType: values.fileType || null,
        discoveredVia: values.discoveredVia || null,
        linkText: values.linkText || null,
        status: values.status || "failed",
        httpStatus: values.httpStatus == null ? null : Number(values.httpStatus),
        downloadable:
            values.downloadable == null ? SUCCESS_STATUSES.has(values.status) : Boolean(values.downloadable),
        downloaded: values.downloaded == null ? values.status === "downloaded" : Boolean(values.downloaded),
        errorMessage: values.errorMessage || null,
        localPath: values.localPath || null,
        fileSize: values.fileSize == null ? null : Number(values.fileSize),
        contentType: values.contentType || null,
        finalUrl: values.finalUrl || null,
        duplicateOfUrl: values.duplicateOfUrl || null,
        checkedAt: values.checkedAt || nowSql(),
    };
}

function summarizeFileAudit(records = []) {
    const groups = new Map();
    const priority = {
        downloaded: 100,
        already_exists: 95,
        not_found: 70,
        forbidden: 65,
        unauthorized: 64,
        rate_limited: 60,
        server_error: 55,
        timeout: 50,
        network_error: 45,
        invalid_content: 40,
        empty_file: 35,
        failed: 30,
        referenced_embed: 15,
        referenced_stream: 14,
        skipped_external: 10,
        duplicate: 0,
    };

    for (const record of records) {
        const key = record.normalizedFileUrl || normalizeAssetUrl(record.fileUrl) || `row:${groups.size}`;
        const current = groups.get(key);
        if (!current || (priority[record.status] || 0) > (priority[current.status] || 0)) {
            groups.set(key, record);
        }
    }

    const uniqueRecords = [...groups.values()];
    const byStatus = {};
    for (const record of uniqueRecords) {
        byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    }

    const failedStatuses = new Set([
        "not_found",
        "forbidden",
        "unauthorized",
        "rate_limited",
        "server_error",
        "timeout",
        "network_error",
        "invalid_content",
        "empty_file",
        "failed",
    ]);

    return {
        totalReferences: records.length,
        uniqueFiles: uniqueRecords.length,
        downloadable: uniqueRecords.filter((record) => SUCCESS_STATUSES.has(record.status)).length,
        downloaded: uniqueRecords.filter((record) => record.status === "downloaded").length,
        alreadyExists: uniqueRecords.filter((record) => record.status === "already_exists").length,
        notFound: uniqueRecords.filter((record) => record.status === "not_found").length,
        forbidden: uniqueRecords.filter((record) => record.status === "forbidden").length,
        unauthorized: uniqueRecords.filter((record) => record.status === "unauthorized").length,
        rateLimited: uniqueRecords.filter((record) => record.status === "rate_limited").length,
        serverError: uniqueRecords.filter((record) => record.status === "server_error").length,
        timeout: uniqueRecords.filter((record) => record.status === "timeout").length,
        networkError: uniqueRecords.filter((record) => record.status === "network_error").length,
        invalidContent: uniqueRecords.filter((record) => record.status === "invalid_content").length,
        emptyFile: uniqueRecords.filter((record) => record.status === "empty_file").length,
        skippedExternal: uniqueRecords.filter((record) => record.status === "skipped_external").length,
        referenced: uniqueRecords.filter((record) => ["referenced_embed", "referenced_stream"].includes(record.status)).length,
        referencedEmbed: uniqueRecords.filter((record) => record.status === "referenced_embed").length,
        referencedStream: uniqueRecords.filter((record) => record.status === "referenced_stream").length,
        failed: uniqueRecords.filter((record) => failedStatuses.has(record.status)).length,
        duplicateReferences: Math.max(0, records.length - uniqueRecords.length),
        byStatus,
    };
}

function csvCell(value) {
    if (value === null || value === undefined) return "";
    const text = String(value).replace(/\r?\n/g, " ");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
    ["run_id", "runId"],
    ["section_key", "sectionKey"],
    ["section_label", "sectionLabel"],
    ["table_name", "tableName"],
    ["source_type", "sourceType"],
    ["detail_id", "detailId"],
    ["title", "title"],
    ["detail_url", "detailUrl"],
    ["file_url", "fileUrl"],
    ["file_name", "fileName"],
    ["file_type", "fileType"],
    ["discovered_via", "discoveredVia"],
    ["link_text", "linkText"],
    ["status", "status"],
    ["http_status", "httpStatus"],
    ["downloadable", "downloadable"],
    ["downloaded", "downloaded"],
    ["file_size", "fileSize"],
    ["content_type", "contentType"],
    ["local_path", "localPath"],
    ["final_url", "finalUrl"],
    ["duplicate_of_url", "duplicateOfUrl"],
    ["error_message", "errorMessage"],
    ["checked_at", "checkedAt"],
];

function toCsv(records = []) {
    const header = CSV_COLUMNS.map(([label]) => csvCell(label)).join(",");
    const lines = records.map((record) =>
        CSV_COLUMNS.map(([, key]) => csvCell(record[key])).join(","),
    );
    return `\uFEFF${[header, ...lines].join("\r\n")}`;
}

function writeAuditReports(baseOutputDir, runId, records = []) {
    const reportsDir = path.join(baseOutputDir, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const safeRunId = String(runId || Date.now()).replace(/[^a-zA-Z0-9_-]+/g, "_");
    const csvPath = path.join(reportsDir, `file-audit-${safeRunId}.csv`);
    const jsonPath = path.join(reportsDir, `file-audit-${safeRunId}.json`);
    const latestCsvPath = path.join(reportsDir, "file-audit-latest.csv");
    const latestJsonPath = path.join(reportsDir, "file-audit-latest.json");
    const payload = {
        runId,
        generatedAt: new Date().toISOString(),
        summary: summarizeFileAudit(records),
        files: records,
    };
    const csv = toCsv(records);
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(csvPath, csv, "utf8");
    fs.writeFileSync(jsonPath, json, "utf8");
    fs.writeFileSync(latestCsvPath, csv, "utf8");
    fs.writeFileSync(latestJsonPath, json, "utf8");
    return { csvPath, jsonPath, latestCsvPath, latestJsonPath };
}

module.exports = {
    classifyDownloadError,
    contentType,
    createAuditRecord,
    detectFileSignature,
    detectedContentType,
    ensureFileNameExtension,
    extractHttpStatus,
    looksLikeHtml,
    normalizeAssetUrl,
    summarizeFileAudit,
    toCsv,
    uniqueFilePath,
    writeAuditReports,
};
