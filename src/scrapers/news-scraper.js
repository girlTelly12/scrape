const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
    cleanText,
    downloadBinary,
    ensureDir,
    extractDataUrls,
    extractLinks,
    extractSrcs,
    fetchHtml,
    fileNameFromHeadersOrUrl,
    param,
    safeName,
    sleepWithStop,
} = require("../common");
const {
    classifyDownloadError,
    contentType,
    createAuditRecord,
    detectFileSignature,
    detectedContentType,
    ensureFileNameExtension,
    looksLikeHtml,
    normalizeAssetUrl,
    summarizeFileAudit,
    uniqueFilePath,
} = require("../file-audit");
const {
    canonicalizeUrl,
    detailIdFromUrl,
    detailIdParamFromUrl,
    detectParserProfile,
    discoverPageLinks,
    isLikelyDetailUrl,
    listingPageId,
} = require("./url-parser");
const { extractMediaCandidates } = require("./media-utils");
const { getUrlSkipReason } = require("../url-skip-policy");
const {
    cleanAnnouncementTitle,
    extractListingAnnouncementMetadata,
    extractPublishedRaw,
    writeAnnouncementTextFile,
} = require("./announcement-metadata");

function isUsefulTitle(text) {
    if (!text || text.length < 5) return false;
    const lower = text.toLowerCase();
    return ![
        "nongtalay.go.th",
        "naboncity.go.th",
        "องค์การบริหารส่วนตำบลหนองทะเล",
        "เทศบาลตำบลนาบอน",
        "หน้าหลัก",
        "เมนู",
        "search",
        "login",
        "ดาวน์โหลดเอกสาร",
    ].some((noise) => lower === noise.toLowerCase() || lower.startsWith(`${noise.toLowerCase()} `));
}

function extractDetailTitle(html, detailUrl) {
    const candidates = [];
    const patterns = [
        /<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/gi,
        /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:title["'][^>]*>/gi,
        /<[^>]+itemprop\s*=\s*["']headline["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
        /<span[^>]+class\s*=\s*["'][^"']*title3[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
        /<(?:td|div|span)[^>]+(?:id|class)\s*=\s*["'][^"']*(?:news[_-]?title|title[_-]?news|topic[_-]?news|head[_-]?news)[^"']*["'][^>]*>([\s\S]*?)<\/(?:td|div|span)>/gi,
        /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi,
        /<[^>]+class\s*=\s*["'][^"']*(?:topic|subject|headline|entry-title|post-title|news-title|title)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
        /(?:เรื่อง|หัวข้อ)\s*:?\s*<\/[^>]+>\s*<[^>]+>([\s\S]*?)<\/[^>]+>/gi,
        /<strong[^>]*>([\s\S]*?)<\/strong>/gi,
        /<title[^>]*>([\s\S]*?)<\/title>/gi,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
            const text = cleanText(match[1])
                .replace(/\s*[-|:]\s*(?:องค์การบริหารส่วนตำบลหนองทะเล|เทศบาลตำบลนาบอน).*$/i, "")
                .replace(/^เรื่อง\s*:?\s*/i, "")
                .trim();
            if (isUsefulTitle(text)) candidates.push(text);
        }
    }

    return candidates.find((text) => /[ก-๙]/.test(text)) || candidates[0] || `detail-${detailIdFromUrl(detailUrl) || Date.now()}`;
}

function extractDetailContentHtml(html) {
    const labeledPatterns = [
        /รายละเอียด\s*:?\s*<\/[^>]+>\s*<(?:td|div|span)\b[^>]*>([\s\S]*?)<\/(?:td|div|span)>/i,
        /<(?:td|div|span)\b[^>]*>\s*รายละเอียด\s*:?\s*<\/(?:td|div|span)>\s*<(?:td|div|span)\b[^>]*>([\s\S]*?)<\/(?:td|div|span)>/i,
    ];
    for (const pattern of labeledPatterns) {
        const match = pattern.exec(html);
        if (match && cleanText(match[1])) return match[1].trim();
    }

    const titleMatch = /<span[^>]+class\s*=\s*["'][^"']*title3[^"']*["'][^>]*>[\s\S]*?<\/span>/i.exec(html);
    const detailArea = titleMatch ? html.slice(titleMatch.index + titleMatch[0].length) : html;
    const candidates = [];
    const patterns = [
        /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
        /<(?:div|section|article|td)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:detail|content|entry-content|post-content|article-content|news-content|news-body|news_detail|news-detail|detail_news|detail-news|newsdata|news-data|content_news|content-news|description|detailcontent|detail-content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|article|td)>/gi,
        /<td\b[^>]*class\s*=\s*(?:"[^"]*\bstyles1\b[^"]*"|'[^']*\bstyles1\b[^']*')[^>]*>([\s\S]*?)<\/td>/gi,
        /<td\b[^>]*(?:width\s*=\s*["']?(?:5\d\d|6\d\d|7\d\d|8\d\d|9\d\d|100%)["']?)[^>]*>([\s\S]*?)<\/td>/gi,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(detailArea)) !== null) {
            const text = cleanText(match[1]);
            if (!text || text === "&nbsp;" || /^(?:หน้าหลัก|เมนู|ดาวน์โหลดเอกสาร)$/i.test(text)) continue;
            candidates.push({ html: match[1].trim(), score: text.length + ((text.match(/[ก-๙]/g) || []).length * 2) });
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].html : "";
}

function normalizeHtmlFragment(html) {
    const cleaned = String(html || "")
        .replace(/<img\b[^>]*\bsrc\s*=\s*(?:"[^"]*download\.gif[^"]*"|'[^']*download\.gif[^']*')[^>]*>/gi, " ")
        .replace(
            /<a\b[^>]*>\s*(?:<img\b[^>]*\bsrc\s*=\s*(?:"[^"]*download\.gif[^"]*"|'[^']*download\.gif[^']*')[^>]*>\s*)?ดาวน์โหลดเอกสารเพิ่มเติมได้ที่นี่\s*<\/a>/gi,
            " ",
        )
        .replace(/ดาวน์โหลดเอกสารเพิ่มเติมได้ที่นี่/gi, " ");
    return cleaned.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}


function extractDetailText(html, detailHtml, title = "") {
    let text = cleanText(detailHtml);
    if (text.length >= 20) return text.slice(0, 50000);

    const withoutNoise = String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<(?:nav|header|footer|aside|form)\b[\s\S]*?<\/(?:nav|header|footer|aside|form)>/gi, " ");
    const mainMatch =
        /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(withoutNoise) ||
        /<[^>]+\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(withoutNoise) ||
        /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(withoutNoise);
    text = cleanText(mainMatch ? mainMatch[1] : withoutNoise)
        .replace(String(title || "").trim(), " ")
        .replace(/\s+/g, " ")
        .trim();
    return text.slice(0, 50000);
}

function safeNewsFolderName(title, detailId) {
    const cleaned = safeName(title)
        .replace(/[.\s]+$/g, "")
        .slice(0, 90) || "news";
    const id = String(detailId || "no-id")
        .replace(/[^\p{L}\p{N}_-]+/gu, "_")
        .slice(0, 40);
    return `${id}_${cleaned}`.slice(0, 135);
}

function boolEnv(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function pdfStorageForBuffer(buffer, mimeType, fileName, logger) {
    const signature = detectFileSignature(buffer);
    const isPdf =
        String(mimeType || "").toLowerCase().startsWith("application/pdf") ||
        (signature && signature.mimeType === "application/pdf") ||
        /\.pdf$/i.test(String(fileName || ""));
    const fileSha256 = buffer && buffer.length
        ? crypto.createHash("sha256").update(buffer).digest("hex")
        : null;

    if (!isPdf || !boolEnv("STORE_PDF_IN_DB", true)) {
        return { fileSha256, pdfData: null, pdfStoredInDb: false };
    }

    const maxMb = Math.max(1, Number(process.env.PDF_DB_MAX_MB || 32));
    const maxBytes = maxMb * 1024 * 1024;
    if (buffer.length > maxBytes) {
        if (logger) {
            logger(
                `PDF ${fileName} มีขนาด ${(buffer.length / 1024 / 1024).toFixed(2)} MB ` +
                    `เกิน PDF_DB_MAX_MB=${maxMb} จึงเก็บเฉพาะไฟล์ในโฟลเดอร์และ metadata`,
            );
        }
        return { fileSha256, pdfData: null, pdfStoredInDb: false };
    }

    return { fileSha256, pdfData: null, pdfStoredInDb: true };
}

function extractPublishedText(html) {
    const patterns = [
        /<meta[^>]+(?:property|name)\s*=\s*["'](?:article:published_time|date|publish-date)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/i,
        /<time[^>]+datetime\s*=\s*["']([^"']+)["'][^>]*>/i,
        /ประกาศเมื่อ(?:วันที่)?\s*<span[^>]*>([\s\S]*?)<\/span>/i,
        /ประกาศเมื่อ(?:วันที่)?\s*([^:<\n]{3,80})/i,
        /วันที่สร้าง\s*:?\s*([^:<\n]{3,80})/i,
        /วันที่ลงข่าว\s*:?\s*([^:<\n]{3,80})/i,
        /ลงวันที่\s*:?\s*([^:<\n]{3,80})/i,
        /เผยแพร่(?:เมื่อ|วันที่)?\s*:?\s*([^:<\n]{3,80})/i,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(html);
        if (match) {
            const text = cleanText(match[1]).replace(/::.*$/, "").trim();
            if (text) return text;
        }
    }
    return extractPublishedRaw(html);
}

function sectionLabelFromKey(sectionKey) {
    const key = String(sectionKey || "").trim().toLowerCase();
    if (key === "procurement") return "จัดซื้อจัดจ้าง";
    if (key === "publicrelations" || key === "public_relations") return "ประชาสัมพันธ์";
    if (key === "bidwinner") return "ประกาศผู้ชนะการเสนอราคา";
    if (key === "referenceprice") return "ราคากลาง";
    if (key === "council") return "กิจการสภา";
    return "ข่าว/ประกาศ";
}

function hasFileExtensionInUrl(url, extensions) {
    try {
        const parsed = new URL(url);
        const values = [parsed.pathname, ...parsed.searchParams.values()];
        return values.some((value) => extensions.test(String(value || "")));
    } catch {
        return false;
    }
}

function isDocumentUrl(url) {
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return false;
        if (/(?:^|\/)(?:doc_download|downloads?|attachments?|files?|fileupload|upload_file|uploads?|documents?)(?:\/|$)/i.test(parsed.pathname)) {
            return true;
        }
        return hasFileExtensionInUrl(url, /\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|csv|zip|rar|7z)(?:$|[?#&])/i);
    } catch {
        return false;
    }
}

function isContentImageUrl(url) {
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return false;
        const fileName = path.basename(parsed.pathname).toLowerCase();
        if (!/\.(?:jpe?g|png|gif|webp)$/i.test(fileName)) return false;
        if (/^(?:logo|icon|bullet|spacer|captcha|loading|download|bg|background)(?:[-_.]|$)/i.test(fileName)) {
            return false;
        }
        return /\/(?:news|news1|datacenter|upload|uploads|fileupload|upload_file|files|attachments|doc_download|images?\/news|news\/images?)\//i.test(
            parsed.pathname,
        );
    } catch {
        return false;
    }
}

function isDownloadLinkText(text) {
    return /(?:ดาวน์โหลด|เอกสารแนบ|ไฟล์แนบ|download|attachment|เอกสารเพิ่มเติม)/i.test(
        String(text || ""),
    );
}

function isHttpAssetUrl(url) {
    try {
        return ["http:", "https:"].includes(new URL(url).protocol);
    } catch {
        return false;
    }
}

function extractAssetCandidates(html, detailUrl) {
    const byUrl = new Map();
    const add = (url, discoveredVia, linkText = "", metadata = {}) => {
        if (!isHttpAssetUrl(url)) return;
        const inferredType = metadata.mediaType || (isContentImageUrl(url) ? "image" : isDocumentUrl(url) ? "document" : null);
        const isKnownFile = Boolean(inferredType);
        if (!isKnownFile && !(discoveredVia === "href" && isDownloadLinkText(linkText))) return;
        const normalized = normalizeAssetUrl(url);
        const current = byUrl.get(normalized);
        if (current) {
            const via = new Set(String(current.discoveredVia || "").split("+").filter(Boolean));
            via.add(discoveredVia);
            current.discoveredVia = [...via].join("+");
            if (!current.linkText && linkText) current.linkText = linkText;
            if (!current.mediaProvider && metadata.provider) current.mediaProvider = metadata.provider;
            return;
        }
        byUrl.set(normalized, {
            url,
            normalizedUrl: normalized,
            discoveredVia,
            linkText: String(linkText || "").trim(),
            fileType: inferredType || "document",
            mediaType: inferredType || "document",
            mediaProvider: metadata.provider || null,
            downloadable: metadata.downloadable !== false,
            embedUrl: metadata.mediaType === "video_embed" ? url : null,
        });
    };

    for (const link of extractLinks(html, detailUrl)) add(link.href, "href", link.text);
    for (const url of extractSrcs(html, detailUrl)) add(url, "src");
    for (const url of extractDataUrls(html, detailUrl)) add(url, "object-data");

    // เว็บ PHP รุ่นเก่ามักใช้ data-src/data-url หรือฝังไฟล์ใน JavaScript viewer
    const attrRe = /\b(data-src|data-original|data-lazy-src|data-url|data-file|data-pdf|data-video|data-video-url|data-media|poster)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    let match;
    while ((match = attrRe.exec(html)) !== null) {
        try {
            add(new URL(match[2] || match[3] || match[4], detailUrl).toString(), match[1].toLowerCase());
        } catch {
            // ignore malformed URL
        }
    }

    const jsFileRe = /["']((?:https?:\/\/|\.{0,2}\/|\/)[^"']+\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|jpe?g|png|gif|webp|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac)(?:\?[^"']*)?)["']/gi;
    while ((match = jsFileRe.exec(html)) !== null) {
        try {
            add(new URL(match[1], detailUrl).toString(), "javascript-string");
        } catch {
            // ignore malformed URL
        }
    }
    for (const media of extractMediaCandidates(html, detailUrl, {
        includeDocuments: true,
        includeImages: false,
        includeVideo: true,
        includeAudio: true,
        includeEmbeds: true,
    })) {
        add(media.url, media.discoveredVia, media.linkText, media);
    }

    return [...byUrl.values()];
}

function sameSiteHostname(a, b) {
    try {
        const normalize = (value) => new URL(value).hostname.toLowerCase().replace(/^www\./, "");
        return normalize(a) === normalize(b);
    } catch {
        return false;
    }
}

function allowExternalAssets() {
    return ["1", "true", "yes", "on"].includes(
        String(process.env.ALLOW_EXTERNAL_ASSETS || "false").trim().toLowerCase(),
    );
}

function fileTypeFromResponse(candidate, headers, buffer) {
    const type = detectedContentType(buffer, headers);
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    return candidate.mediaType || candidate.fileType || "document";
}

function extractTotalCount(html) {
    const text = cleanText(html);
    const patterns = [
        /ข้อมูลทั้งหมด\s*([0-9,]+)\s*(?:รายการ|ข่าว)/,
        /ทั้งหมด\s*([0-9,]+)\s*(?:รายการ|ข่าว)/,
        /พบ(?:ข้อมูล|ข่าว)?\s*([0-9,]+)\s*(?:รายการ|ข่าว)/,
        /(?:total|results?)\s*[:=]?\s*([0-9,]+)/i,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match) return Number(match[1].replace(/,/g, ""));
    }
    return 0;
}

function isTargetCategoryDetail(html, catId) {
    const safeCatId = String(catId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`news\\.php\\?cat_id=${safeCatId}`, "i").test(html);
}

async function mapLimit(items, limit, worker) {
    const maxWorkers = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
    let nextIndex = 0;
    const workers = Array.from({ length: maxWorkers }, async () => {
        while (nextIndex < items.length) {
            const idx = nextIndex++;
            await worker(items[idx], idx);
        }
    });
    await Promise.all(workers);
}

async function scrapeNewsCategory({
    startUrl,
    outDir,
    logger,
    shouldStop = () => false,
    onAuditRecord = () => {},
    adapterProfile = {},
    sectionKey = adapterProfile.sectionKey || "news",
    sectionLabel = "",
    delayMsPerDownload = 150,
    delayMsPerListing = 100,
}) {
    ensureDir(outDir);
    const effectiveSectionKey = String(sectionKey || adapterProfile.sectionKey || "news").trim() || "news";
    const effectiveSectionLabel =
        String(sectionLabel || "").trim() || sectionLabelFromKey(effectiveSectionKey);

    const startParsed = new URL(startUrl);
    const parserProfile = detectParserProfile(startUrl);
    const startCatId = parserProfile.categoryConstraints.cat_id || null;
    logger(
        `Adapter ข่าว: ${adapterProfile.vendorName || "Generic"} (${adapterProfile.vendorId || "generic"})` +
            `${adapterProfile.sectionKey ? ` section=${adapterProfile.sectionKey}` : ""}`,
    );
    logger(
        `รูปแบบหน้ารายการ: ${parserProfile.mode} ` +
            `path=${parserProfile.pathname}` +
            `${Object.keys(parserProfile.categoryConstraints).length ? ` category=${JSON.stringify(parserProfile.categoryConstraints)}` : ""}`,
    );

    const assertNotStopped = () => {
        if (shouldStop()) throw new Error("JOB_STOPPED_BY_USER");
    };
    const rethrowIfStopped = (error) => {
        if (error && error.message === "JOB_STOPPED_BY_USER") throw error;
    };

    const detailMap = new Map();
    const detailQueue = [];
    const queuedDetailUrls = new Set();
    const listingQueue = [canonicalizeUrl(startUrl)];
    const queuedListingUrls = new Set(listingQueue);
    const visitedListingUrls = new Set();
    let expectedTotal = 0;
    let maxSeenDetailId = 0;

    function enqueueDetail(detailUrl, source) {
        const normalized = canonicalizeUrl(detailUrl);
        maxSeenDetailId = Math.max(maxSeenDetailId, Number(detailIdFromUrl(normalized)) || 0);
        const existingSource = detailMap.get(normalized);
        if (!existingSource) {
            detailMap.set(normalized, source);
        } else {
            detailMap.set(normalized, {
                ...existingSource,
                ...source,
                title:
                    String(source.title || "").length > String(existingSource.title || "").length
                        ? source.title
                        : existingSource.title,
                publishedText: source.publishedText || existingSource.publishedText || "",
                listingContextText:
                    String(source.listingContextText || "").length >
                    String(existingSource.listingContextText || "").length
                        ? source.listingContextText
                        : existingSource.listingContextText,
            });
        }
        if (!queuedDetailUrls.has(normalized)) {
            queuedDetailUrls.add(normalized);
            detailQueue.push(normalized);
        }
    }

    function enqueueListing(listingUrl) {
        let normalized;
        try {
            normalized = canonicalizeUrl(listingUrl);
        } catch {
            return;
        }
        if (visitedListingUrls.has(normalized) || queuedListingUrls.has(normalized)) return;
        queuedListingUrls.add(normalized);
        listingQueue.push(normalized);
    }

    while (listingQueue.length) {
        assertNotStopped();
        const listingUrl = listingQueue.shift();
        if (visitedListingUrls.has(listingUrl)) continue;

        try {
            visitedListingUrls.add(listingUrl);
            logger(`เยี่ยมชมหน้ารายการข่าว: ${listingUrl}`);
            const html = await fetchHtml(listingUrl, logger, { shouldStop });
            expectedTotal = Math.max(expectedTotal, extractTotalCount(html));

            const discovered = discoverPageLinks(html, listingUrl, startUrl, adapterProfile);
            for (const detail of discovered.details) {
                const listingMetadata = extractListingAnnouncementMetadata(
                    detail.contextText || detail.text,
                    detail.text,
                );
                enqueueDetail(detail.href, {
                    listingUrl,
                    pageId: listingPageId(listingUrl),
                    title: isUsefulTitle(listingMetadata.title) ? listingMetadata.title : "",
                    publishedText: listingMetadata.publishedRaw || "",
                    listingContextText: listingMetadata.contextText || "",
                    discoveredVia: detail.via,
                });
            }

            for (const listing of discovered.listings) enqueueListing(listing.href);
            logger(
                `[parser] หน้านี้พบ detail=${discovered.details.length}, ` +
                    `pagination=${discovered.listings.length}`,
            );
            await sleepWithStop(delayMsPerListing, shouldStop);
        } catch (error) {
            rethrowIfStopped(error);
            logger(`ข้ามหน้ารายการ (โหลดไม่สำเร็จ): ${listingUrl} - ${error.message}`);
        }
    }

    if (expectedTotal && detailQueue.length < expectedTotal && startCatId) {
        const scanMax = Number(process.env.SCAN_MAX_DETAIL_ID || maxSeenDetailId || 3000);
        const scanConcurrency = Number(process.env.SCAN_CONCURRENCY || 8);
        const firstDetailUrl = detailQueue[0] || `${startParsed.origin}/detail.php?id=1`;
        const detailPath = new URL(firstDetailUrl).pathname;
        const detailParam = detailIdParamFromUrl(firstDetailUrl) || "id";
        const detailBase = `${startParsed.protocol}//${startParsed.host}${detailPath}`;
        logger(`pagination อาจตอบซ้ำหน้าแรก (${detailQueue.length}/${expectedTotal}) -> scan detail IDs 1..${scanMax}`);
        const ids = Array.from({ length: scanMax }, (_, i) => i + 1);
        let scanned = 0;
        let matched = 0;
        await mapLimit(ids, scanConcurrency, async (id) => {
            assertNotStopped();
            const detailUrl = `${detailBase}?${detailParam}=${id}`;
            try {
                const html = await fetchHtml(detailUrl, logger, { shouldStop });
                scanned += 1;
                if (scanned % 200 === 0) logger(`[scan] ${scanned}/${scanMax} checked, ${matched} matched`);
                if (!isTargetCategoryDetail(html, startCatId)) return;
                matched += 1;
                enqueueDetail(detailUrl, {
                    listingUrl: startUrl,
                    pageId: null,
                    title: extractDetailTitle(html, detailUrl),
                });
            } catch (error) {
                rethrowIfStopped(error);
                scanned += 1;
            }
        });
    } else if (expectedTotal && detailQueue.length < expectedTotal && !startCatId) {
        logger(`พบลิงก์ ${detailQueue.length}/${expectedTotal} รายการ และข้ามการ scan ID เพื่อไม่ให้ดึงข่าวข้ามหมวด`);
    }

    logger(`รวมลิงก์ detail ได้ ${detailQueue.length} รายการ`);

    const rows = [];
    const auditRows = [];
    const seenReferenceUrls = new Set();
    let fileCount = 0;
    let detailsWithoutFiles = 0;

    const emitAudit = (values) => {
        const record = createAuditRecord(values);
        auditRows.push(record);
        onAuditRecord(record);
        return record;
    };

    for (const detailUrl of detailQueue) {
        assertNotStopped();
        try {
            const source = detailMap.get(detailUrl) || { listingUrl: startUrl, pageId: null, title: "" };
            logger(`ดึงหน้ารายละเอียด: ${detailUrl}`);
            const html = await fetchHtml(detailUrl, logger, { shouldStop });
            const title = cleanAnnouncementTitle(source.title || extractDetailTitle(html, detailUrl));
            const rawDetailHtml = extractDetailContentHtml(html);
            const detailHtml = normalizeHtmlFragment(rawDetailHtml);
            const detailText = extractDetailText(html, detailHtml, title);
            const publishedText = extractPublishedText(html) || source.publishedText || "";
            const detailId = detailIdFromUrl(detailUrl);
            const folderPath = path.join(outDir, safeNewsFolderName(title, detailId));
            ensureDir(folderPath);
            const recordTextPath = writeAnnouncementTextFile(folderPath, {
                sectionLabel: effectiveSectionLabel,
                title,
                publishedRaw: publishedText,
                listingUrl: source.listingUrl || startUrl,
                detailUrl,
                detailText,
                scrapedAt: new Date().toISOString(),
            });
            logger(
                `บันทึกรายละเอียดประกาศ: ${path.basename(recordTextPath)} ` +
                    `(เรื่อง=${title || "ไม่พบ"}, ประกาศเมื่อ=${publishedText || "ไม่พบ"})`,
            );

            // ตรวจทั้งส่วนรายละเอียดและ HTML เต็มหน้า เพื่อไม่พลาดลิงก์ที่อยู่ใต้ iframe/PDF viewer
            const assetSourceHtml = `${rawDetailHtml || ""}
${html}`;
            const candidates = extractAssetCandidates(assetSourceHtml, detailUrl);
            if (!candidates.length) detailsWithoutFiles += 1;

            let savedFiles = 0;
            for (const candidate of candidates) {
                assertNotStopped();
                const duplicateOfUrl = seenReferenceUrls.has(candidate.normalizedUrl)
                    ? candidate.normalizedUrl
                    : null;
                seenReferenceUrls.add(candidate.normalizedUrl);

                const auditBase = {
                    sourceType: "news",
                    sectionKey: effectiveSectionKey,
                    sectionLabel: effectiveSectionLabel,
                    detailId,
                    detailUrl,
                    title,
                    fileUrl: candidate.url,
                    normalizedFileUrl: candidate.normalizedUrl,
                    fileName: fileNameFromHeadersOrUrl({}, candidate.url),
                    fileType: candidate.fileType,
                    discoveredVia: candidate.discoveredVia,
                    linkText: candidate.linkText,
                    duplicateOfUrl,
                };

                const skipReason = getUrlSkipReason(candidate.url);
                if (skipReason) {
                    emitAudit({
                        ...auditBase,
                        status: "skipped_external",
                        downloadable: false,
                        downloaded: false,
                        errorMessage: `ข้าม URL โดยไม่เปิดตามนโยบาย: ${skipReason}`,
                    });
                    logger(`ข้าม URL โดยไม่เปิด: ${candidate.url} — ${skipReason}`);
                    continue;
                }

                if (candidate.downloadable === false) {
                    const referenceStatus = candidate.mediaType === "video_embed" ? "referenced_embed" : "referenced_stream";
                    rows.push({
                        sectionKey: effectiveSectionKey,
                        sectionLabel: effectiveSectionLabel,
                        pageId: source.pageId,
                        listingUrl: source.listingUrl,
                        listingPath: new URL(source.listingUrl || startUrl).pathname,
                        detailId,
                        detailUrl,
                        detailPath: new URL(detailUrl).pathname,
                        folderPath,
                        recordTextPath,
                        title,
                        detailText,
                        detailHtml,
                        publishedText,
                        publishedRaw: publishedText,
                        publishedAt: publishedText,
                        mediaType: candidate.mediaType,
                        mediaProvider: candidate.mediaProvider,
                        embedUrl: candidate.embedUrl || candidate.url,
                        isDownloaded: false,
                        fileType: candidate.fileType,
                        fileName: null,
                        fileUrl: candidate.url,
                        localPath: null,
                        fileSize: null,
                        fileMimeType: null,
                        fileSha256: null,
                        pdfData: null,
                        pdfStoredInDb: false,
                        downloadedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
                    });
                    emitAudit({
                        ...auditBase,
                        status: referenceStatus,
                        downloadable: false,
                        downloaded: false,
                        finalUrl: candidate.url,
                        errorMessage:
                            candidate.mediaType === "video_embed"
                                ? `เก็บลิงก์วิดีโอภายนอก (${candidate.mediaProvider || "embed"}) ไว้ในฐานข้อมูล`
                                : "เก็บ URL stream ไว้ในฐานข้อมูล โดยไม่ดาวน์โหลด playlist โดยตรง",
                    });
                    logger(`เก็บลิงก์สื่อไว้ในฐานข้อมูล: ${candidate.url}`);
                    savedFiles += 1;
                    continue;
                }

                if (!allowExternalAssets() && !sameSiteHostname(candidate.url, detailUrl)) {
                    emitAudit({
                        ...auditBase,
                        status: "skipped_external",
                        downloadable: false,
                        downloaded: false,
                        errorMessage: "ข้ามลิงก์ต่างเว็บไซต์ตามค่า ALLOW_EXTERNAL_ASSETS=false",
                    });
                    logger(`ข้ามลิงก์ไฟล์ต่างเว็บไซต์: ${candidate.url}`);
                    continue;
                }

                try {
                    const result = await downloadBinary(candidate.url, logger, 5, {
                        referer: detailUrl,
                        shouldStop,
                        expectFile: true,
                    });
                    const { buffer, headers = {}, statusCode = 200, finalUrl = candidate.url } = result;

                    const detectedSignature = detectFileSignature(buffer);
                    const declaredType = contentType(headers);
                    if (
                        detectedSignature &&
                        (declaredType === "text/html" || declaredType === "application/xhtml+xml")
                    ) {
                        logger(
                            `ตรวจพบไฟล์จริงจากลายเซ็น ${detectedSignature.mimeType} ` +
                                `แม้เซิร์ฟเวอร์แจ้ง ${declaredType}: ${candidate.url}`,
                        );
                    }

                    if (!buffer || buffer.length === 0) {
                        emitAudit({
                            ...auditBase,
                            status: "empty_file",
                            httpStatus: statusCode,
                            downloadable: false,
                            downloaded: false,
                            contentType: detectedContentType(buffer, headers),
                            finalUrl,
                            errorMessage: "เซิร์ฟเวอร์ส่งไฟล์ขนาด 0 ไบต์",
                        });
                        logger(`ไฟล์ว่าง 0 ไบต์: ${candidate.url}`);
                        continue;
                    }

                    if (looksLikeHtml(buffer, headers)) {
                        emitAudit({
                            ...auditBase,
                            status: "invalid_content",
                            httpStatus: statusCode,
                            downloadable: false,
                            downloaded: false,
                            fileSize: buffer.length,
                            contentType: detectedContentType(buffer, headers),
                            finalUrl,
                            errorMessage: "ลิงก์ตอบกลับเป็นหน้า HTML ไม่ใช่ไฟล์เอกสาร/รูปภาพ",
                        });
                        logger(`ข้ามลิงก์ที่ตอบกลับเป็น HTML: ${candidate.url}`);
                        continue;
                    }

                    let fileName = fileNameFromHeadersOrUrl(headers, finalUrl || candidate.url);
                    fileName = ensureFileNameExtension(fileName, headers, buffer);
                    const localPath = uniqueFilePath(folderPath, fileName);
                    fs.writeFileSync(localPath, buffer);
                    fileCount += 1;
                    savedFiles += 1;
                    const actualFileName = path.basename(localPath);
                    const actualFileType = fileTypeFromResponse(candidate, headers, buffer);
                    const actualMimeType = detectedContentType(buffer, headers);
                    const pdfStorage = pdfStorageForBuffer(
                        buffer,
                        actualMimeType,
                        actualFileName,
                        logger,
                    );

                    rows.push({
                        sectionKey: effectiveSectionKey,
                        sectionLabel: effectiveSectionLabel,
                        pageId: source.pageId,
                        listingUrl: source.listingUrl,
                        detailId,
                        detailUrl,
                        title,
                        detailText,
                        detailHtml,
                        publishedText,
                        publishedRaw: publishedText,
                        publishedAt: publishedText,
                        listingPath: new URL(source.listingUrl || startUrl).pathname,
                        detailPath: new URL(detailUrl).pathname,
                        folderPath,
                        recordTextPath,
                        mediaType: actualFileType,
                        mediaProvider: candidate.mediaProvider || null,
                        embedUrl: candidate.embedUrl || null,
                        isDownloaded: true,
                        fileType: actualFileType,
                        fileName: actualFileName,
                        fileUrl: candidate.url,
                        localPath,
                        fileSize: buffer.length,
                        fileMimeType: actualMimeType,
                        fileSha256: pdfStorage.fileSha256,
                        pdfData: pdfStorage.pdfData,
                        pdfStoredInDb: pdfStorage.pdfStoredInDb,
                        downloadedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
                    });
                    emitAudit({
                        ...auditBase,
                        status: "downloaded",
                        httpStatus: statusCode,
                        downloadable: true,
                        downloaded: true,
                        fileName: actualFileName,
                        fileType: actualFileType,
                        fileSize: buffer.length,
                        contentType: detectedContentType(buffer, headers),
                        localPath,
                        finalUrl,
                    });
                    logger(
                        `บันทึกไฟล์: ${actualFileName}` +
                            (pdfStorage.pdfStoredInDb ? " และเก็บ PDF ลงฐานข้อมูลแล้ว" : ""),
                    );
                    await sleepWithStop(delayMsPerDownload, shouldStop);
                } catch (error) {
                    rethrowIfStopped(error);
                    const classified = classifyDownloadError(error);
                    emitAudit({
                        ...auditBase,
                        ...classified,
                        downloadable: false,
                        downloaded: false,
                    });
                    logger(`ข้ามไฟล์ (โหลดไม่สำเร็จ): ${candidate.url} - ${error.message}`);
                }
            }

            if (!savedFiles) {
                rows.push({
                    sectionKey: effectiveSectionKey,
                    sectionLabel: effectiveSectionLabel,
                    pageId: source.pageId,
                    listingUrl: source.listingUrl,
                    detailId,
                    detailUrl,
                    title,
                    detailText,
                    detailHtml,
                    publishedText,
                    publishedRaw: publishedText,
                    publishedAt: publishedText,
                    listingPath: new URL(source.listingUrl || startUrl).pathname,
                    detailPath: new URL(detailUrl).pathname,
                    folderPath,
                    recordTextPath,
                    mediaType: null,
                    mediaProvider: null,
                    embedUrl: null,
                    isDownloaded: false,
                    fileType: null,
                    fileName: null,
                    fileUrl: null,
                    localPath: null,
                    fileSize: null,
                    fileMimeType: null,
                    fileSha256: null,
                    pdfData: null,
                    pdfStoredInDb: false,
                    downloadedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
                });
            }
        } catch (error) {
            rethrowIfStopped(error);
            logger(`ข้ามหน้ารายละเอียด (โหลดไม่สำเร็จ): ${detailUrl} - ${error.message}`);
        }
    }

    const fileAuditSummary = summarizeFileAudit(auditRows);
    logger(
        `ตรวจไฟล์เสร็จแล้ว: ทั้งหมด(unique)=${fileAuditSummary.uniqueFiles}, ` +
            `ดาวน์โหลดได้=${fileAuditSummary.downloadable}, 404=${fileAuditSummary.notFound}, ` +
            `403=${fileAuditSummary.forbidden}, ล้มเหลว=${fileAuditSummary.failed}, ` +
            `ลิงก์ซ้ำ=${fileAuditSummary.duplicateReferences}`,
    );

    return {
        rows,
        detailCount: detailQueue.length,
        fileCount,
        detailsWithoutFiles,
        fileAudit: auditRows,
        fileAuditSummary,
    };
}

module.exports = {
    scrapeNewsCategory,
    detailIdFromUrl,
    isDetailUrl: isLikelyDetailUrl,
};
