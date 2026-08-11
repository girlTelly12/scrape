const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
    cleanText,
    downloadBinary,
    ensureDir,
    extractHrefs,
    fetchHtmlResult,
    fileNameFromHeadersOrUrl,
    safeName,
    sameSiteIgnoringWww,
    sleepWithStop,
} = require("../common");
const { captureRenderedPageSnapshot } = require("../browser-client");
const {
    classifyDownloadError,
    contentType,
    detectFileSignature,
    detectedContentType,
    ensureFileNameExtension,
    looksLikeHtml,
    normalizeAssetUrl,
    uniqueFilePath,
} = require("../file-audit");
const { extractMediaCandidates } = require("./media-utils");
const { getUrlSkipReason } = require("../url-skip-policy");

const PAGE_EXT_RE = /\.(?:html?|php|asp|aspx|jsp|cfm)(?:$|[?#])/i;
const ASSET_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|xml|json|zip|rar|7z|jpe?g|png|gif|webp|bmp|tiff?|svg|ico|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac|css|js|map|woff2?|ttf|otf|eot)(?:$|[?#])/i;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp|tiff?|svg|ico)(?:$|[?#])/i;
const DOCUMENT_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|xml|json|zip|rar|7z)(?:$|[?#])/i;
const VIDEO_EXT_RE = /\.(?:mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8)(?:$|[?#])/i;
const AUDIO_EXT_RE = /\.(?:mp3|m4a|aac|wav|ogg|oga|flac)(?:$|[?#])/i;
const STYLE_EXT_RE = /\.css(?:$|[?#])/i;
const SCRIPT_EXT_RE = /\.(?:js|map)(?:$|[?#])/i;
const FONT_EXT_RE = /\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i;
const BLOCKED_ROUTE_RE = /(?:^|\/)(?:admin|administrator|backend|backoffice|wp-admin|login|logout|signin|signout|member|members|private|auth|oauth|captcha)(?:\/|$)|(?:[?&](?:action|do|task)=(?:delete|remove|logout|signout))/i;
const TRACKING_PARAM_RE = /^(?:utm_(?:source|medium|campaign|term|content)|fbclid|gclid|yclid|mc_cid|mc_eid)$/i;

function boolValue(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function shortHash(value) {
    return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function canonicalUrl(raw, baseUrl = undefined) {
    try {
        const url = new URL(String(raw || "").trim(), baseUrl);
        if (!["http:", "https:"].includes(url.protocol)) return "";
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
            if (TRACKING_PARAM_RE.test(key)) url.searchParams.delete(key);
        }
        url.hostname = url.hostname.toLowerCase();
        return url.toString();
    } catch {
        return "";
    }
}

function isPublicPageUrl(url) {
    if (!url || ASSET_EXT_RE.test(url) || BLOCKED_ROUTE_RE.test(url)) return false;
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return false;
        if (/\.(?:exe|msi|apk|dmg|iso)(?:$|[?#])/i.test(parsed.pathname)) return false;
        return !parsed.searchParams.has("download");
    } catch {
        return false;
    }
}

function classifyAsset(url, mimeType = "") {
    const target = String(url || "").toLowerCase();
    const mime = String(mimeType || "").toLowerCase();
    if (IMAGE_EXT_RE.test(target) || /^image\//i.test(mime)) return "images";
    if (VIDEO_EXT_RE.test(target) || /^video\//i.test(mime)) return "videos";
    if (AUDIO_EXT_RE.test(target) || /^audio\//i.test(mime)) return "audio";
    if (STYLE_EXT_RE.test(target) || /text\/css/i.test(mime)) return "styles";
    if (SCRIPT_EXT_RE.test(target) || /(?:javascript|ecmascript)/i.test(mime)) return "scripts";
    if (FONT_EXT_RE.test(target) || /font\//i.test(mime)) return "fonts";
    if (DOCUMENT_EXT_RE.test(target) || /application\/(?:pdf|msword|zip|json|xml)|officedocument|spreadsheet|presentation/i.test(mime)) return "documents";
    return "other";
}

function pageFolderName(url, index) {
    try {
        const parsed = new URL(url);
        const slug = safeName(
            `${parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/[\/]+/g, "_") || "home"}${parsed.search ? `_${parsed.search}` : ""}`,
        ).slice(0, 90);
        return `${String(index).padStart(5, "0")}_${slug || "page"}_${shortHash(url)}`;
    } catch {
        return `${String(index).padStart(5, "0")}_page_${shortHash(url)}`;
    }
}

function extractTitle(html, fallback = "") {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
    return cleanText(match ? match[1] : fallback).slice(0, 2000);
}

function extractCssUrls(css, baseUrl) {
    const urls = [];
    const add = (raw, via) => {
        const resolved = canonicalUrl(raw, baseUrl);
        if (resolved) urls.push({ url: resolved, via });
    };
    let match;
    const urlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    while ((match = urlRe.exec(String(css || ""))) !== null) add(match[1], "css-url");
    const importRe = /@import\s+(?:url\()?\s*["']([^"']+)["']/gi;
    while ((match = importRe.exec(String(css || ""))) !== null) add(match[1], "css-import");
    return urls;
}

function extractGenericAssets(html, baseUrl) {
    const out = new Map();
    const add = (raw, via, options = {}) => {
        const url = canonicalUrl(raw, baseUrl);
        if (!url) return;
        const forceAsset = Boolean(options.forceAsset);
        if (!forceAsset && !ASSET_EXT_RE.test(url)) return;
        const key = normalizeAssetUrl(url);
        const current = out.get(key);
        const next = {
            url,
            via,
            forceAsset,
            mimeType: options.mimeType || "",
            resourceType: options.resourceType || "",
            linkText: options.linkText || "",
        };
        if (!current) out.set(key, next);
        else if (forceAsset) current.forceAsset = true;
    };

    for (const candidate of extractMediaCandidates(html, baseUrl, {
        includeDocuments: true,
        includeImages: true,
        includeVideo: true,
        includeAudio: true,
        includeEmbeds: false,
    })) add(candidate.url, candidate.discoveredVia || "html-media", { forceAsset: true, linkText: candidate.linkText });

    // รองรับ endpoint ไม่มีนามสกุล เช่น download.php?id=123 หรือ attachment?id=123
    let match;
    const anchorRe = /<a\b([^>]*)href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;
    while ((match = anchorRe.exec(String(html || ""))) !== null) {
        const attrs = `${match[1] || ""} ${match[5] || ""}`;
        const linkText = cleanText(match[6] || "");
        const href = match[2] || match[3] || match[4];
        const signal = `${attrs} ${linkText} ${href || ""}`;
        const forceAsset = /(?:download|attachment|file|document|เอกสาร|ดาวน์โหลด|แบบฟอร์ม|ไฟล์แนบ|pdf|docx?|xlsx?|pptx?|zip)/i.test(signal);
        add(href, forceAsset ? "download-anchor" : "anchor", { forceAsset, linkText });
    }

    const attrRe = /\b(?:src|href|data|poster|data-src|data-url|data-file|data-original|data-lazy-src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    while ((match = attrRe.exec(String(html || ""))) !== null) add(match[1] || match[2] || match[3], "html-attribute");
    const srcsetRe = /\b(?:srcset|data-srcset)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
    while ((match = srcsetRe.exec(String(html || ""))) !== null) {
        for (const item of String(match[1] || match[2]).split(",")) add(item.trim().split(/\s+/)[0], "html-srcset");
    }
    const cssRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    while ((match = cssRe.exec(String(html || ""))) !== null) add(match[1], "inline-css-url");
    const quotedRe = /["']((?:https?:\/\/|\/|\.\.?\/)[^"']+\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|xml|json|zip|rar|7z|jpe?g|png|gif|webp|bmp|tiff?|svg|ico|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac|css|js|map|woff2?|ttf|otf|eot)(?:\?[^"']*)?)["']/gi;
    while ((match = quotedRe.exec(String(html || ""))) !== null) add(match[1], "javascript-string");
    return [...out.values()];
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function loadCheckpoint(checkpointPath) {
    try {
        return JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    } catch {
        return null;
    }
}

async function fetchPageSnapshot(url, logger, shouldStop) {
    const mode = String(process.env.BROWSER_MODE || "auto").toLowerCase();
    if (mode !== "http") {
        return captureRenderedPageSnapshot(url, logger, { shouldStop, maxResources: 30000 });
    }
    const result = await fetchHtmlResult(url, logger, { shouldStop });
    return {
        requestedUrl: url,
        finalUrl: result.finalUrl || url,
        statusCode: result.statusCode || 200,
        headers: result.headers || {},
        html: result.html || "",
        title: extractTitle(result.html),
        detailText: cleanText(result.html),
        links: extractHrefs(result.html, result.finalUrl || url),
        resources: extractGenericAssets(result.html, result.finalUrl || url),
        loadedResources: [],
        failedResources: [],
    };
}

async function discoverSitemapUrls(startUrl, logger, shouldStop, maxUrls = 5000) {
    const origin = new URL(startUrl).origin;
    const candidates = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"];
    const output = new Set();
    const seenMaps = new Set();
    const queue = candidates.map((value) => new URL(value, origin).toString());
    while (queue.length && output.size < maxUrls && seenMaps.size < 30) {
        const sitemapUrl = queue.shift();
        if (seenMaps.has(sitemapUrl)) continue;
        seenMaps.add(sitemapUrl);
        try {
            const result = await fetchHtmlResult(sitemapUrl, logger, { shouldStop, referer: origin + "/" });
            const xml = result.html || "";
            const locs = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
                .map((match) => cleanText(match[1]))
                .map((value) => canonicalUrl(value, sitemapUrl))
                .filter(Boolean);
            for (const value of locs) {
                if (/\.xml(?:$|[?#])/i.test(value) && seenMaps.size < 30) queue.push(value);
                else if (sameSiteIgnoringWww(value, startUrl) && isPublicPageUrl(value)) output.add(value);
                if (output.size >= maxUrls) break;
            }
        } catch {
            // sitemap เป็นตัวช่วย ไม่ถือเป็นข้อผิดพลาดหลัก
        }
    }
    return [...output];
}

async function scrapeWholePublicSite(options) {
    const {
        startUrl,
        outDir,
        logger,
        shouldStop,
        onAuditRecord,
        runId = null,
        fileStore = null,
    } = options;
    if (!startUrl) throw new Error("โหมดสำรวจทั้งเว็บไซต์ต้องมีเว็บไซต์หลัก");

    const maxPages = clampNumber(options.maxPages ?? process.env.MIGRATION_MAX_PAGES, 1000, 1, 50000);
    const maxAssets = clampNumber(options.maxAssets ?? process.env.MIGRATION_MAX_ASSETS, 10000, 1, 200000);
    const maxDepth = clampNumber(options.maxDepth ?? process.env.MIGRATION_MAX_DEPTH, 12, 0, 100);
    const delayMs = clampNumber(options.delayMs ?? process.env.MIGRATION_REQUEST_DELAY_MS, 700, 0, 60000);
    const maxFileMb = clampNumber(options.maxFileMb ?? process.env.MIGRATION_MAX_FILE_MB, 500, 1, 4096);
    const includeExternalAssets = boolValue(
        options.includeExternalAssets ?? process.env.MIGRATION_INCLUDE_EXTERNAL_ASSETS,
        true,
    );
    const resume = boolValue(options.resume ?? process.env.MIGRATION_RESUME, true);
    const rootUrl = canonicalUrl(startUrl);
    if (!rootUrl) throw new Error("เว็บไซต์หลักไม่ถูกต้อง");

    ensureDir(outDir);
    const pagesDir = path.join(outDir, "pages");
    const assetsDir = path.join(outDir, "assets");
    const reportsDir = path.join(outDir, "reports");
    ensureDir(pagesDir);
    ensureDir(assetsDir);
    ensureDir(reportsDir);

    const checkpointPath = path.join(reportsDir, "migration-checkpoint.json");
    const manifestPath = path.join(reportsDir, "migration-manifest.json");
    const pageRows = [];
    const assetRows = [];
    const queue = [{ url: rootUrl, depth: 0, from: null }];
    const queued = new Set([rootUrl]);
    const visited = new Set();
    const assetSeen = new Set();
    const contentHashes = new Map();

    if (resume) {
        const checkpoint = loadCheckpoint(checkpointPath);
        if (checkpoint && checkpoint.rootUrl === rootUrl) {
            for (const value of checkpoint.visited || []) visited.add(value);
            for (const value of checkpoint.assets || []) assetSeen.add(value);
            for (const item of checkpoint.queue || []) {
                const url = canonicalUrl(item.url);
                if (url && !visited.has(url) && !queued.has(url)) {
                    queue.push({ url, depth: Number(item.depth) || 0, from: item.from || null });
                    queued.add(url);
                }
            }
            if (logger) logger(`ทำงานต่อจาก checkpoint: pages=${visited.size}, assets=${assetSeen.size}`);
        }
    }

    if (visited.size === 0) {
        const sitemapUrls = await discoverSitemapUrls(rootUrl, logger, shouldStop, maxPages * 3);
        for (const url of sitemapUrls) {
            if (!queued.has(url)) {
                queue.push({ url, depth: 1, from: "sitemap" });
                queued.add(url);
            }
        }
        if (logger && sitemapUrls.length) logger(`พบ URL จาก sitemap ${sitemapUrls.length} หน้า`);
    }

    const saveCheckpoint = () => {
        writeJson(checkpointPath, {
            version: 1,
            rootUrl,
            updatedAt: new Date().toISOString(),
            visited: [...visited],
            assets: [...assetSeen],
            queue: queue.slice(0, 100000),
        });
    };

    const downloadAsset = async (candidate, pageMeta) => {
        if (assetRows.length >= maxAssets) return;
        const assetUrl = canonicalUrl(candidate.url, pageMeta.finalUrl);
        if (!assetUrl || assetSeen.has(assetUrl)) return;
        const skipReason = getUrlSkipReason(assetUrl);
        if (skipReason) {
            assetSeen.add(assetUrl);
            onAuditRecord?.({
                sourceType: "migration",
                detailUrl: pageMeta.finalUrl,
                title: pageMeta.title,
                fileUrl: assetUrl,
                fileName: safeName(path.basename(new URL(assetUrl).pathname) || "skipped-url"),
                fileType: classifyAsset(assetUrl, candidate.mimeType),
                discoveredVia: candidate.via,
                status: "skipped_external",
                downloadable: false,
                downloaded: false,
                errorMessage: `ข้าม URL โดยไม่เปิดตามนโยบาย: ${skipReason}`,
            });
            if (logger) logger(`[migration] ข้าม URL โดยไม่เปิด: ${assetUrl} — ${skipReason}`);
            return;
        }
        const isExternal = !sameSiteIgnoringWww(assetUrl, rootUrl);
        const loadedByBrowser = pageMeta.loadedResourceSet.has(assetUrl) || pageMeta.loadedResourcePaths.has(new URL(assetUrl).pathname);
        if (isExternal && (!includeExternalAssets || !loadedByBrowser)) {
            assetSeen.add(assetUrl);
            onAuditRecord?.({
                sourceType: "migration",
                detailUrl: pageMeta.finalUrl,
                title: pageMeta.title,
                fileUrl: assetUrl,
                fileName: safeName(path.basename(new URL(assetUrl).pathname) || "external"),
                fileType: classifyAsset(assetUrl, candidate.mimeType),
                discoveredVia: candidate.via,
                status: "skipped_external",
                downloadable: false,
                downloaded: false,
                errorMessage: "ข้ามทรัพยากรต่างเว็บไซต์ที่ไม่ได้ถูก Chrome โหลดจากหน้าต้นทาง",
            });
            return;
        }

        assetSeen.add(assetUrl);
        const startedAt = new Date();
        // ข้ามดาวน์โหลดลิงก์ที่เคยดาวน์โหลดแล้ว (index ถาวรต่อเว็บไซต์) — ไม่เสีย bandwidth
        const preExisting = fileStore ? fileStore.find(assetUrl) : null;
        try {
            let result = null;
            let digest = null;
            let mimeType = "";
            let category = "";
            let fileName = "";
            let localPath;
            let status = "downloaded";
            let duplicateOfUrl = null;
            let finalUrl = assetUrl;
            let httpStatus = 200;
            let fileSize = null;

            if (preExisting) {
                localPath = preExisting.localPath;
                status = "already_exists";
                duplicateOfUrl = preExisting.url || assetUrl;
                fileName = path.basename(localPath);
                mimeType = preExisting.mimeType || "";
                category = classifyAsset(localPath, mimeType || candidate.mimeType);
                digest = preExisting.sha256 || null;
                fileSize =
                    preExisting.fileSize != null
                        ? preExisting.fileSize
                        : fs.statSync(localPath).size;
                if (fileStore) {
                    fileStore.register({
                        url: assetUrl,
                        finalUrl,
                        localPath,
                        sha256: digest,
                        fileSize,
                        mimeType,
                        addedAt: preExisting.addedAt,
                    });
                }
            } else {
                result = await downloadBinary(assetUrl, logger, 5, {
                    shouldStop,
                    expectFile: true,
                    referer: pageMeta.finalUrl,
                    listingReferer: rootUrl,
                });
                if (!result.buffer || result.buffer.length === 0) throw new Error("ไฟล์ว่าง");
                if (result.buffer.length > maxFileMb * 1024 * 1024) {
                    throw new Error(`ไฟล์ใหญ่เกินกำหนด ${maxFileMb} MB`);
                }
                if (looksLikeHtml(result.buffer, result.headers || {})) {
                    throw new Error("URL ไฟล์ตอบกลับเป็น HTML ไม่ใช่ไฟล์จริง");
                }

                mimeType = detectedContentType(result.buffer, result.headers || {}) || contentType(result.headers || {});
                category = classifyAsset(result.finalUrl || assetUrl, mimeType || candidate.mimeType);
                const targetDir = path.join(assetsDir, category);
                ensureDir(targetDir);
                fileName = fileNameFromHeadersOrUrl(result.headers || {}, result.finalUrl || assetUrl);
                fileName = ensureFileNameExtension(safeName(fileName).slice(0, 180), result.headers || {}, result.buffer);
                digest = sha256(result.buffer);
                finalUrl = result.finalUrl || assetUrl;
                httpStatus = result.statusCode || 200;
                fileSize = result.buffer.length;

                // ข้ามไฟล์ที่เคยบันทึกเนื้อหาเดียวกันไว้แล้ว (ในรอบนี้หรือจาก index ถาวร)
                const existing =
                    contentHashes.get(digest) ||
                    (fileStore ? fileStore.findByDigest(digest) : null) ||
                    null;
                if (existing) {
                    localPath = existing.localPath;
                    status = "already_exists";
                    duplicateOfUrl = existing.url || assetUrl;
                    if (fileStore) {
                        fileStore.register({
                            url: assetUrl,
                            finalUrl,
                            localPath,
                            sha256: digest,
                            fileSize,
                            mimeType,
                            addedAt: existing.addedAt || null,
                        });
                    }
                } else {
                    localPath = uniqueFilePath(targetDir, `${digest.slice(0, 10)}_${fileName}`);
                    fs.writeFileSync(localPath, result.buffer);
                    contentHashes.set(digest, { localPath, url: assetUrl });
                    if (fileStore) {
                        fileStore.register({
                            url: assetUrl,
                            finalUrl,
                            localPath,
                            sha256: digest,
                            fileSize,
                            mimeType,
                        });
                    }
                }
            }

            const isPdf =
                (result && detectFileSignature(result.buffer)?.kind === "pdf") ||
                /application\/pdf/i.test(mimeType || "") ||
                /\.pdf$/i.test(fileName);
            const storePdf = boolValue(process.env.STORE_PDF_IN_DB, true);
            const pdfMaxMb = clampNumber(process.env.PDF_DB_MAX_MB, 32, 1, 1024);
            let pdfData = null;
            if (isPdf && storePdf && fileSize <= pdfMaxMb * 1024 * 1024) {
                // รอบที่ข้ามดาวน์โหลด (preExisting) ไม่มี buffer ในหน่วยความจำ -> อ่านจากไฟล์เดิม
                pdfData = result ? result.buffer : fs.readFileSync(localPath);
            }

            const row = {
                runId,
                pageUrl: pageMeta.finalUrl,
                assetUrl,
                finalUrl,
                assetType: category,
                fileName,
                localPath,
                mimeType,
                fileSize,
                fileSha256: digest,
                status,
                httpStatus,
                discoveredVia: candidate.via || "page",
                pdfData,
                pdfStoredInDb: Boolean(pdfData),
                downloadedAt:
                    preExisting && preExisting.addedAt
                        ? preExisting.addedAt
                        : startedAt.toISOString().slice(0, 19).replace("T", " "),
            };
            assetRows.push(row);
            onAuditRecord?.({
                sourceType: "migration",
                detailUrl: pageMeta.finalUrl,
                title: pageMeta.title,
                fileUrl: assetUrl,
                normalizedFileUrl: assetUrl,
                fileName,
                fileType: category,
                discoveredVia: candidate.via,
                status,
                httpStatus,
                downloadable: true,
                downloaded: status === "downloaded",
                localPath,
                fileSize,
                contentType: mimeType,
                finalUrl,
                duplicateOfUrl,
            });

            if (category === "styles" && result && result.buffer) {
                const cssText = result.buffer.toString("utf8");
                for (const nested of extractCssUrls(cssText, finalUrl)) {
                    await downloadAsset(nested, pageMeta);
                    if (assetRows.length >= maxAssets) break;
                }
            }
        } catch (error) {
            const failure = classifyDownloadError(error);
            assetRows.push({
                runId,
                pageUrl: pageMeta.finalUrl,
                assetUrl,
                finalUrl: null,
                assetType: classifyAsset(assetUrl, candidate.mimeType),
                fileName: safeName(path.basename(new URL(assetUrl).pathname) || "file"),
                localPath: null,
                mimeType: null,
                fileSize: null,
                fileSha256: null,
                status: failure.status,
                httpStatus: failure.httpStatus,
                discoveredVia: candidate.via || "page",
                pdfData: null,
                pdfStoredInDb: false,
                errorMessage: failure.errorMessage,
                downloadedAt: null,
            });
            onAuditRecord?.({
                sourceType: "migration",
                detailUrl: pageMeta.finalUrl,
                title: pageMeta.title,
                fileUrl: assetUrl,
                fileName: safeName(path.basename(new URL(assetUrl).pathname) || "file"),
                fileType: classifyAsset(assetUrl, candidate.mimeType),
                discoveredVia: candidate.via,
                status: failure.status,
                httpStatus: failure.httpStatus,
                downloadable: false,
                downloaded: false,
                errorMessage: failure.errorMessage,
            });
        }
    };

    while (queue.length && visited.size < maxPages) {
        if (typeof shouldStop === "function" && shouldStop()) throw new Error("JOB_STOPPED_BY_USER");
        const item = queue.shift();
        const pageUrl = canonicalUrl(item.url);
        if (!pageUrl || visited.has(pageUrl) || item.depth > maxDepth) continue;
        if (!sameSiteIgnoringWww(pageUrl, rootUrl) || !isPublicPageUrl(pageUrl)) continue;
        visited.add(pageUrl);
        const pageIndex = visited.size;
        if (logger) logger(`[migration] หน้า ${pageIndex}/${maxPages}: ${pageUrl}`);

        try {
            const snapshot = await fetchPageSnapshot(pageUrl, logger, shouldStop);
            const finalUrl = canonicalUrl(snapshot.finalUrl || pageUrl);
            const title = snapshot.title || extractTitle(snapshot.html, finalUrl);
            const pageFolder = path.join(pagesDir, pageFolderName(finalUrl, pageIndex));
            ensureDir(pageFolder);
            const htmlPath = path.join(pageFolder, "index.html");
            const textPath = path.join(pageFolder, "รายละเอียดหน้า.txt");
            const metaPath = path.join(pageFolder, "metadata.json");
            const detailText = String(snapshot.detailText || cleanText(snapshot.html || "")).trim();
            fs.writeFileSync(htmlPath, snapshot.html || "", "utf8");
            fs.writeFileSync(
                textPath,
                `\uFEFFหัวข้อ: ${title || "-"}\r\nURL: ${finalUrl}\r\nดึงข้อมูลเมื่อ: ${new Date().toISOString()}\r\n\r\n${detailText}\r\n`,
                "utf8",
            );
            const htmlHash = sha256(Buffer.from(snapshot.html || "", "utf8"));
            const pageRow = {
                runId,
                pageUrl,
                finalUrl,
                title,
                depth: item.depth,
                status: "downloaded",
                httpStatus: snapshot.statusCode || 200,
                htmlPath,
                textPath,
                detailText,
                discoveredFrom: item.from,
                contentSha256: htmlHash,
                scrapedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            };
            pageRows.push(pageRow);

            const loadedResourceItems = (snapshot.loadedResources || []).map((item) =>
                typeof item === "string" ? { url: item } : item || {},
            );
            const loadedResourceSet = new Set(
                loadedResourceItems.map((item) => canonicalUrl(item.url)).filter(Boolean),
            );
            const loadedResourcePaths = new Set(
                [...loadedResourceSet].map((value) => {
                    try { return new URL(value).pathname; } catch { return ""; }
                }).filter(Boolean),
            );
            const pageMeta = { ...pageRow, loadedResourceSet, loadedResourcePaths };
            const resources = new Map();
            const addResource = (value, via, options = {}) => {
                const url = canonicalUrl(value, finalUrl);
                if (!url || url === finalUrl) return;
                const mimeType = String(options.mimeType || "");
                const resourceType = String(options.resourceType || "").toLowerCase();
                const forcedByNetwork = ["image", "media", "font", "stylesheet", "script"].includes(resourceType) ||
                    Boolean(mimeType && !/^(?:text\/html|application\/xhtml\+xml)/i.test(mimeType));
                const forceAsset = Boolean(options.forceAsset || forcedByNetwork);
                if (!forceAsset && !ASSET_EXT_RE.test(url)) return;
                const key = normalizeAssetUrl(url);
                const current = resources.get(key);
                const next = { url, via, forceAsset, mimeType, resourceType, linkText: options.linkText || "" };
                if (!current) resources.set(key, next);
                else {
                    if (forceAsset) current.forceAsset = true;
                    if (!current.mimeType && mimeType) current.mimeType = mimeType;
                    if (!current.resourceType && resourceType) current.resourceType = resourceType;
                }
            };
            for (const candidate of extractGenericAssets(snapshot.html || "", finalUrl)) {
                addResource(candidate.url, candidate.via, candidate);
            }
            for (const candidate of snapshot.resources || []) {
                addResource(candidate.url || candidate, candidate.via || "rendered-dom", candidate);
            }
            for (const item of loadedResourceItems) {
                addResource(item.url, "browser-network", item);
            }

            writeJson(metaPath, {
                ...pageRow,
                htmlPath: path.relative(outDir, htmlPath),
                textPath: path.relative(outDir, textPath),
                linksFound: (snapshot.links || []).length,
                resourcesFound: resources.size,
                failedResources: snapshot.failedResources || [],
            });

            const resourceUrlKeys = new Set(resources.keys());
            for (const rawLink of [...(snapshot.links || []), ...extractHrefs(snapshot.html || "", finalUrl)]) {
                const link = canonicalUrl(rawLink, finalUrl);
                if (!link || resourceUrlKeys.has(normalizeAssetUrl(link)) || queued.has(link) || visited.has(link)) continue;
                if (sameSiteIgnoringWww(link, rootUrl) && isPublicPageUrl(link) && item.depth < maxDepth) {
                    queue.push({ url: link, depth: item.depth + 1, from: finalUrl });
                    queued.add(link);
                }
            }

            for (const resource of resources.values()) {
                if (assetRows.length >= maxAssets) break;
                await downloadAsset(resource, pageMeta);
                if (delayMs) await sleepWithStop(Math.min(delayMs, 5000), shouldStop);
            }
        } catch (error) {
            const failure = classifyDownloadError(error);
            pageRows.push({
                runId,
                pageUrl,
                finalUrl: null,
                title: "",
                depth: item.depth,
                status: failure.status,
                httpStatus: failure.httpStatus,
                htmlPath: null,
                textPath: null,
                detailText: null,
                discoveredFrom: item.from,
                contentSha256: null,
                errorMessage: failure.errorMessage,
                scrapedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
            });
            if (logger) logger(`[migration] ข้ามหน้า: ${pageUrl} — ${failure.errorMessage}`);
        }

        if (pageIndex % 5 === 0) saveCheckpoint();
        if (delayMs) await sleepWithStop(delayMs, shouldStop);
    }

    saveCheckpoint();
    const summary = {
        rootUrl,
        pageCount: pageRows.filter((row) => row.status === "downloaded").length,
        pageFailed: pageRows.filter((row) => row.status !== "downloaded").length,
        assetCount: assetRows.filter((row) => ["downloaded", "already_exists"].includes(row.status)).length,
        assetFailed: assetRows.filter((row) => !["downloaded", "already_exists"].includes(row.status)).length,
        uniqueUrlsVisited: visited.size,
        queuedRemaining: queue.length,
        limits: { maxPages, maxAssets, maxDepth, maxFileMb },
        finishedAt: new Date().toISOString(),
    };
    writeJson(manifestPath, { summary, pages: pageRows, assets: assetRows.map(({ pdfData, ...row }) => row) });
    fs.writeFileSync(path.join(reportsDir, "pages.jsonl"), pageRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    fs.writeFileSync(
        path.join(reportsDir, "assets.jsonl"),
        assetRows.map(({ pdfData, ...row }) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
    );
    return { pageRows, assetRows, summary, manifestPath, checkpointPath };
}

module.exports = {
    ASSET_EXT_RE,
    canonicalUrl,
    classifyAsset,
    isPublicPageUrl,
    scrapeWholePublicSite,
};
