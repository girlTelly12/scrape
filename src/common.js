const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { TextDecoder } = require("util");
const { downloadWithBrowser } = require("./browser-client");
const { looksLikeHtml } = require("./file-audit");
const { alignUrlOriginToReferer, sameSiteIgnoringWww } = require("./url-origin");
const { createSkippedUrlError, getUrlSkipReason } = require("./url-skip-policy");

const browserOnlyHosts = new Set();

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithStop(ms, shouldStop, stepMs = 250) {
    const total = Number(ms) || 0;
    if (total <= 0) return;
    const isStopped = typeof shouldStop === "function" ? shouldStop : () => false;
    let elapsed = 0;
    while (elapsed < total) {
        if (isStopped()) throw new Error("JOB_STOPPED_BY_USER");
        const chunk = Math.min(stepMs, total - elapsed);
        await sleep(chunk);
        elapsed += chunk;
    }
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function htmlDecode(value) {
    const named = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
    };
    return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
        if (entity[0] === "#") {
            const isHex = entity[1].toLowerCase() === "x";
            const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        }
        return named[entity.toLowerCase()] || _;
    });
}

function decodeBuffer(buffer, headers = {}) {
    const contentType = headers["content-type"] || "";
    const sample = buffer.slice(0, 4096).toString("latin1");
    const charsetMatch = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(`${contentType}\n${sample}`);
    const rawCharset = (charsetMatch && charsetMatch[1] ? charsetMatch[1] : "utf-8").toLowerCase();
    const charset = ["tis-620", "tis620", "windows-874", "cp874"].includes(rawCharset) ? "windows-874" : rawCharset;

    try {
        return new TextDecoder(charset).decode(buffer);
    } catch {
        return buffer.toString("utf8");
    }
}

function cleanText(html) {
    return htmlDecode(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function safeName(s) {
    return (
        htmlDecode(String(s || ""))
            .replace(/<[^>]+>/g, " ")
            .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180) || "file"
    );
}

function param(url, name) {
    try {
        return new URL(url).searchParams.get(name);
    } catch {
        return null;
    }
}

function extractHrefs(html, baseUrl) {
    const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            out.add(new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString());
        } catch {
            // ignore malformed href
        }
    }
    return [...out];
}

function extractLinks(html, baseUrl) {
    const re = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const out = [];
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            out.push({
                href: new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString(),
                text: cleanText(m[4]),
            });
        } catch {
            // ignore malformed href
        }
    }
    return out;
}

function extractSrcs(html, baseUrl) {
    const re = /src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            out.add(new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString());
        } catch {
            // ignore malformed src
        }
    }
    return [...out];
}

function extractDataUrls(html, baseUrl) {
    const re = /\bdata\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            out.add(new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString());
        } catch {
            // ignore malformed data attribute
        }
    }
    return [...out];
}

function isSameHostname(url, hostname) {
    try {
        return new URL(url).hostname.toLowerCase() === String(hostname || "").toLowerCase();
    } catch {
        return false;
    }
}

function fileNameFromHeadersOrUrl(headers, fileUrl) {
    const cd = headers["content-disposition"];
    if (cd) {
        const utfMatch = /filename\*\s*=\s*UTF-8''([^;\n]+)/i.exec(cd);
        const plainMatch = /filename\s*=\s*"?([^";\n]+)"?/i.exec(cd);
        const rawName = utfMatch ? utfMatch[1] : plainMatch && plainMatch[1];
        if (rawName) {
            try {
                return safeName(decodeURIComponent(rawName));
            } catch {
                return safeName(rawName);
            }
        }
    }

    const parsed = new URL(fileUrl);
    const fromPath = path.basename(parsed.pathname);
    if (fromPath && fromPath !== "/" && fromPath !== ".") {
        try {
            return safeName(decodeURIComponent(fromPath));
        } catch {
            return safeName(fromPath);
        }
    }
    return `file-${Date.now()}`;
}

function buildBrowserHeaders(url, referer = "") {
    const parsed = new URL(url);
    const isHtml = !/\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|jpe?g|png|gif|webp|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#]|$)/i.test(parsed.pathname);
    const headers = {
        "User-Agent": USER_AGENT,
        Accept: isHtml
            ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
            : "*/*",
        "Accept-Language": "th,en-US;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Connection: "keep-alive",
        Referer: referer || `${parsed.protocol}//${parsed.host}/`,
    };
    if (isHtml) headers["Upgrade-Insecure-Requests"] = "1";
    return headers;
}

function createHttpError(statusCode, url, source = "HTTP") {
    const status = Number(statusCode) || 0;
    const error = new Error(`HTTP ${status || "UNKNOWN"} on ${url}${source === "Browser" ? " (Browser)" : ""}`);
    error.statusCode = status || null;
    error.url = url;
    error.code = status ? `HTTP_${status}` : "HTTP_UNKNOWN";
    return error;
}

function createRequestError(message, code, url) {
    const error = new Error(message);
    if (code) error.code = code;
    if (url) error.url = url;
    return error;
}

function downloadBinaryHttp(url, logger, redirects = 5, requestOptions = {}) {
    return new Promise((resolve, reject) => {
        if (typeof requestOptions.shouldStop === "function" && requestOptions.shouldStop()) {
            reject(new Error("JOB_STOPPED_BY_USER"));
            return;
        }
        const client = url.startsWith("https:") ? https : http;
        let settled = false;
        let req;

        const finish = (fn, payload) => {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimer);
            clearInterval(stopTimer);
            fn(payload);
        };

        const stopTimer = setInterval(() => {
            if (typeof requestOptions.shouldStop === "function" && requestOptions.shouldStop()) {
                if (req) req.destroy(new Error("JOB_STOPPED_BY_USER"));
            }
        }, 250);

        const totalTimer = setTimeout(() => {
            if (req) req.destroy(createRequestError("timeout", "ETIMEDOUT", url));
        }, 30000);

        const rawHeaders = buildBrowserHeaders(url, requestOptions.referer);
        const headers = Object.fromEntries(
            Object.entries(rawHeaders).filter(([, v]) => v !== undefined && v !== null && String(v) !== ""),
        );

        req = client.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (redirects <= 0) return finish(reject, new Error(`too many redirects: ${url}`));
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return finish(
                    resolve,
                    downloadBinaryHttp(next, logger, redirects - 1, {
                        ...requestOptions,
                        referer: requestOptions.referer || url,
                    }),
                );
            }
            if (res.statusCode !== 200) {
                res.resume();
                return finish(reject, createHttpError(res.statusCode, url));
            }

            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
                finish(resolve, {
                    buffer: Buffer.concat(chunks),
                    headers: res.headers,
                    statusCode: res.statusCode,
                    finalUrl: url,
                }),
            );
            res.on("error", (error) => finish(reject, error));
        });

        req.on("error", (error) => finish(reject, error));
        req.setTimeout(30000, () => req.destroy(createRequestError("timeout", "ETIMEDOUT", url)));
    });
}

function shouldRetryExpectedFileWithBrowser(result, requestOptions = {}) {
    return Boolean(
        requestOptions.expectFile &&
            result &&
            Buffer.isBuffer(result.buffer) &&
            looksLikeHtml(result.buffer, result.headers || {}),
    );
}

async function downloadBinary(url, logger, redirects = 5, requestOptions = {}) {
    const skipReason = getUrlSkipReason(url);
    if (skipReason) {
        if (logger) logger(`ข้าม URL ตามนโยบายโดยไม่ส่งคำขอ: ${url} — ${skipReason}`);
        throw createSkippedUrlError(url, skipReason);
    }
    if (typeof requestOptions.shouldStop === "function" && requestOptions.shouldStop()) {
        throw new Error("JOB_STOPPED_BY_USER");
    }
    const hostname = new URL(url).hostname.toLowerCase();
    const mode = String(process.env.BROWSER_MODE || "auto").trim().toLowerCase();

    if (mode === "http") {
        return downloadBinaryHttp(url, logger, redirects, requestOptions);
    }

    if (mode === "browser" || mode === "cdp" || mode === "launch" || browserOnlyHosts.has(hostname)) {
        return downloadWithBrowser(url, logger, requestOptions);
    }

    try {
        const httpResult = await downloadBinaryHttp(url, logger, redirects, requestOptions);

        // บางเว็บไซต์ตอบ HTTP 200 เป็นหน้า HTML/ตัวดูเอกสารก่อน ทั้งที่ URL เป็นไฟล์ PDF จริง
        // เมื่อผู้เรียกคาดหวังไฟล์ ให้ลองผ่าน Browser session อีกครั้งเพื่อดึง response ดิบของไฟล์
        if (shouldRetryExpectedFileWithBrowser(httpResult, requestOptions)) {
            browserOnlyHosts.add(hostname);
            if (logger) {
                logger(
                    `ลิงก์ไฟล์จาก ${hostname} ตอบเป็นหน้า HTML — ` +
                        "เปลี่ยนไปดึง response ไฟล์จริงผ่าน Chrome อัตโนมัติ",
                );
            }
            return downloadWithBrowser(url, logger, requestOptions);
        }

        return httpResult;
    } catch (error) {
        if (!/HTTP 403/.test(String(error && error.message))) throw error;
        browserOnlyHosts.add(hostname);
        if (logger) logger(`เว็บไซต์ ${hostname} ตอบ HTTP 403 — เปลี่ยนไปใช้ Chrome จริงอัตโนมัติ`);
        return downloadWithBrowser(url, logger, requestOptions);
    }
}

async function fetchHtmlResult(url, logger, requestOptions = {}) {
    if (logger) logger(`GET ${url}`);
    const result = await downloadBinary(url, logger, 5, {
        ...requestOptions,
        referer: requestOptions.referer || new URL(url).origin + "/",
    });
    return {
        ...result,
        html: decodeBuffer(result.buffer, result.headers || {}),
        finalUrl: result.finalUrl || url,
    };
}

async function fetchHtml(url, logger, requestOptions = {}) {
    const result = await fetchHtmlResult(url, logger, requestOptions);
    return result.html;
}

module.exports = {
    cleanText,
    downloadBinary,
    ensureDir,
    extractDataUrls,
    extractHrefs,
    extractLinks,
    extractSrcs,
    fetchHtml,
    fetchHtmlResult,
    fileNameFromHeadersOrUrl,
    htmlDecode,
    isSameHostname,
    param,
    safeName,
    sleep,
    sleepWithStop,
    shouldRetryExpectedFileWithBrowser,
    alignUrlOriginToReferer,
    sameSiteIgnoringWww,
};
