const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { captureRenderedImagesFromPage } = require("../browser-client");
const {
    cleanText,
    downloadBinary,
    ensureDir,
    fetchHtml,
    fetchHtmlResult,
    htmlDecode,
    extractLinks,
    isSameHostname,
    param,
    safeName,
    sleepWithStop,
    alignUrlOriginToReferer,
    sameSiteIgnoringWww,
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
    chooseBestActivityTitle,
    detectActivityParserProfile,
    discoverActivityPageLinks,
    ensureImageExtension,
    extractGalleryImageUrls,
    listingPageNo: flexibleListingPageNo,
    safeActivityFolderName,
    isExcludedActivityImageUrl,
} = require("./activity-url-parser");
const { extractMediaCandidates, mediaFileName } = require("./media-utils");
const { getUrlSkipReason } = require("../url-skip-policy");

function extractActivityLinks(html, baseUrl) {
    const out = new Map();

    for (const link of extractLinks(html, baseUrl)) {
        try {
            const href = link.href;
            const parsed = new URL(href);
            const albumId = param(href, "salb_id") || param(href, "album_id");
            if (!albumId) continue;
            const pathname = parsed.pathname.toLowerCase();
            const isSupportedActivityUrl =
                pathname.endsWith("/activities.php") || pathname.endsWith("/album/view.php");
            if (!isSupportedActivityUrl) continue;
            const title = link.text || `activity-${albumId}`;
            const current = out.get(href);
            if (!current || current.title.length < title.length) out.set(href, { href, albumId, title });
        } catch {
            // ignore malformed URL
        }
    }
    return [...out.values()];
}

function extractPaginationLinks(html, baseUrl) {
    const re =
        /href\s*=\s*(?:"([^"]*index\.php(?:\?[^"]*)?)"|'([^']*index\.php(?:\?[^']*)?)'|([^\s>]*index\.php(?:\?[^\s>]*)?))/gi;
    const out = new Set();
    let match;
    while ((match = re.exec(html)) !== null) {
        const raw = htmlDecode(match[1] || match[2] || match[3]);
        try {
            out.add(new URL(raw, baseUrl).toString());
        } catch {
            // ignore malformed URL
        }
    }
    return [...out];
}

function isSupportedListingUrl(pageUrl) {
    try {
        const pathname = new URL(pageUrl).pathname.toLowerCase();
        return pathname.endsWith("/albums/index.php") || pathname.endsWith("/album/index.php");
    } catch {
        return false;
    }
}

function listingPageNo(pageUrl) {
    const page = param(pageUrl, "Page") || param(pageUrl, "pageid");
    return page ? Number(page) : 1;
}


function extractActivityPageTextFallback(html, title = "") {
    const withoutNoise = String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<(?:nav|header|footer|aside|form)\b[\s\S]*?<\/(?:nav|header|footer|aside|form)>/gi, " ");
    const match =
        /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(withoutNoise) ||
        /<[^>]+\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(withoutNoise) ||
        /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(withoutNoise);
    let text = cleanText(match ? match[1] : withoutNoise)
        .replace(String(title || "").trim(), " ")
        .replace(/หน้าแรก\s*>\s*/gi, " ")
        .replace(/อัลบั้มภาพกิจกรรม\s*>\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    // ไม่เก็บหน้าที่เหลือแต่เมนูหรือข้อความสั้นมาก
    const thaiChars = (text.match(/[ก-๙]/g) || []).length;
    if (thaiChars < 12 || text.length < 35) return "";
    return text.slice(0, 50000);
}

function extractActivityDetails(html, activityUrl, fallbackTitle) {
    const activityId =
        param(activityUrl, "salb_id") ||
        param(activityUrl, "album_id") ||
        /\/(?:detail|view|show)\/([^/?#]+)/i.exec(activityUrl)?.[1] ||
        "";
    const titlePatterns = [
        { pattern: /<b>\s*อัลบั้มภาพ\s*"([\s\S]*?)"\s*<\/b>/i, weight: 220 },
        {
            pattern: /<td\b[^>]*class\s*=\s*["'][^"']*\btitle3\b[^"']*["'][^>]*>[\s\S]*?(?:เรื่อง|หัวข้อ)\s*:?\s*[\s\S]*?<\/td>\s*<td\b[^>]*class\s*=\s*["'][^"']*\bstyles1\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
            weight: 210,
        },
        {
            pattern: /<a\b[^>]*href\s*=\s*["'][^"']*activities\.php\?salb_id=[^"']*["'][^>]*class\s*=\s*["'][^"']*linktextblack[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
            weight: 190,
        },
        { pattern: /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i, weight: 155 },
        { pattern: /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["'][^>]*>/i, weight: 155 },
        { pattern: /<h1\b[^>]*>([\s\S]*?)<\/h1>/i, weight: 170 },
        { pattern: /<h2\b[^>]*class\s*=\s*["'][^"']*(?:gallery|album|activity|page)[-_ ]?title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i, weight: 180 },
        { pattern: /<[^>]+class\s*=\s*["'][^"']*(?:gallery|album|activity)[-_ ]?title[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i, weight: 180 },
        { pattern: /<title[^>]*>([\s\S]*?)<\/title>/i, weight: 20 },
    ];
    const titleCandidates = titlePatterns
        .map(({ pattern, weight }) => {
            const match = pattern.exec(html);
            return match ? { value: match[1], weight } : null;
        })
        .filter(Boolean);
    if (fallbackTitle) titleCandidates.push({ value: fallbackTitle, weight: 145 });
    const selectedTitle = chooseBestActivityTitle(titleCandidates, {
        pageUrl: activityUrl,
        activityId,
    });
    const title = selectedTitle.value || `activity-${activityId || Date.now()}`;

    const pageText = cleanText(html);
    const dateSources = [
        [/<meta[^>]+(?:property|name)\s*=\s*["'](?:article:published_time|date|publish-date)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/i, html],
        [/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["'](?:article:published_time|date|publish-date)["'][^>]*>/i, html],
        [/<time[^>]+datetime\s*=\s*["']([^"']+)["'][^>]*>/i, html],
        [/ประกาศเมื่อ(?:วันที่)?\s*([^)<|]{3,160})/i, pageText],
        [/(?:เผยแพร่|วันที่เผยแพร่|วันที่สร้าง|วันที่ลงข่าว|ลงวันที่|วันที่)\s*:?\s*([^)<|]{3,160})/i, pageText],
        [/(?:posted|published)\s*(?:on)?\s*:?\s*([^)<|]{3,160})/i, pageText],
    ];
    const dateMatch = dateSources.map(([pattern, source]) => pattern.exec(source)).find(Boolean);
    const announcedDate = dateMatch ? cleanText(dateMatch[1]).trim() : "";

    const explicitDetailHtml = extractDetailHtmlBySpan(html);
    const labeledDetailHtml = extractDetailHtmlByLabel(html, "รายละเอียด");
    const legacyBeforeGalleryHtml = extractDetailHtmlBeforeLegacyGallery(html);
    const legacyBelowGalleryHtml = extractDetailHtmlByLegacyBelowGallery(html);
    const rawDetailHtml =
        explicitDetailHtml ||
        labeledDetailHtml ||
        legacyBeforeGalleryHtml ||
        legacyBelowGalleryHtml ||
        extractDetailHtmlByLegacyMarker(html) ||
        extractBestDetailHtml(html);
    const cleanedText = sanitizeDetailText(cleanText(rawDetailHtml), title).slice(0, 50000);
    const hasRealDetail =
        (explicitDetailHtml || labeledDetailHtml || legacyBeforeGalleryHtml || legacyBelowGalleryHtml
            ? hasLabeledDetailText(cleanedText)
            : hasMeaningfulDetailText(cleanedText)) &&
        !isBreadcrumbOnlyText(cleanedText);
    const fallbackDetailText = hasRealDetail
        ? ""
        : extractActivityPageTextFallback(html, title);
    const detailHtml = hasRealDetail ? rawDetailHtml : "";
    const detailText = hasRealDetail ? cleanedText : fallbackDetailText;

    return {
        title,
        titleScore: selectedTitle.score,
        announcedDate,
        announcedText: announcedDate,
        announcedAt: announcedDate,
        detailHtml,
        detailText,
    };
}

function extractDetailHtmlBySpan(html) {
    const match = /<span\b(?=[^>]*class\s*=\s*(?:"[^"]*\bdetail\b[^"]*"|'[^']*\bdetail\b[^']*'|[^\s>]*\bdetail\b[^\s>]*))[^>]*>([\s\S]*?)<\/span>/i.exec(
        html,
    );
    return match ? trimFragment(match[1]) : "";
}

function extractDetailHtmlByLabel(html, label) {
    const safeLabel = escapeRegExp(label);
    const re = new RegExp(
        `<td\\b[^>]*class\\s*=\\s*["'][^"']*\\btitle3\\b[^"']*["'][^>]*>[\\s\\S]*?${safeLabel}\\s*:?\\s*[\\s\\S]*?<\\/td>\\s*<td\\b[^>]*class\\s*=\\s*["'][^"']*\\bstyles1\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`,
        "i",
    );
    const match = re.exec(html);
    return match ? trimFragment(match[1]) : "";
}

function extractDetailHtmlBeforeLegacyGallery(html) {
    const galleryStart = findFirstIndex(html, [
        'id="svDivAlbums5RowA"',
        "id='svDivAlbums5RowA'",
        "/photoThumbnail/albums/",
        'rel="lightbox',
        "rel='lightbox",
    ]);
    if (galleryStart < 0) return "";

    const titleBlock = /<b>\s*อัลบั้มภาพ\s*"[\s\S]*?"\s*<\/b>/i.exec(html);
    const from = titleBlock ? titleBlock.index + titleBlock[0].length : Math.max(0, galleryStart - 12000);
    const area = html.slice(from, galleryStart);
    const detailDivRe =
        /<div\b(?=[^>]*\bstyle\s*=\s*(?:"[^"]*margin-top\s*:\s*20px[^"]*"|'[^']*margin-top\s*:\s*20px[^']*'))[^>]*>([\s\S]*?)<\/div>/gi;
    const candidates = [];
    let match;
    while ((match = detailDivRe.exec(area)) !== null) {
        const fragment = trimFragment(match[1]);
        if (!hasLabeledDetailText(fragment)) continue;
        const text = cleanText(fragment);
        const thaiChars = (text.match(/[ก-๙]/g) || []).length;
        if (thaiChars < 20 || text.length < 60) continue;
        candidates.push({ fragment, score: thaiChars + text.length });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].fragment.slice(0, 20000) : "";
}

function extractDetailHtmlByLegacyBelowGallery(html) {
    const marker = /<div\b[^>]*id\s*=\s*["']svDivAlbumsMoreC["'][^>]*>[\s\S]*?<\/div>/i.exec(html);
    const contentStart = marker ? marker.index + marker[0].length : -1;
    if (contentStart < 0) return "";

    const contentEnd = findFirstIndex(html, ["<iframe", "<form", "</body>"], contentStart);
    const area = html.slice(contentStart, contentEnd > contentStart ? contentEnd : html.length);
    const detailDivRe =
        /<div\b(?=[^>]*\balign\s*=\s*(?:"center"|'center'))(?=[^>]*\bstyle\s*=\s*(?:"[^"]*margin-top\s*:\s*20px[^"]*"|'[^']*margin-top\s*:\s*20px[^']*'))[^>]*>([\s\S]*?)<\/div>/gi;
    let match;
    while ((match = detailDivRe.exec(area)) !== null) {
        const fragment = trimFragment(match[1]);
        if (hasLabeledDetailText(fragment)) return fragment;
    }
    return "";
}

function extractDetailHtmlByLegacyMarker(html) {
    const moreMarker = /<div\b[^>]*id\s*=\s*["']svDivAlbumsMoreC["'][^>]*>[\s\S]*?<\/div>/i.exec(html);
    const contentStart = moreMarker ? moreMarker.index + moreMarker[0].length : -1;
    if (contentStart < 0) return "";
    const attachStart = html.indexOf("<!--attach files", contentStart);
    const iframeStart = html.indexOf("<iframe", contentStart);
    const contentEnd = [attachStart, iframeStart]
        .filter((index) => index > contentStart)
        .sort((a, b) => a - b)[0];
    if (!contentEnd) return "";
    return html.slice(contentStart, contentEnd).trim();
}

function findFirstIndex(html, markers, fromIndex = 0) {
    const indexes = markers
        .map((marker) => html.indexOf(marker, fromIndex))
        .filter((idx) => idx >= 0)
        .sort((a, b) => a - b);
    return indexes.length ? indexes[0] : -1;
}

function findLastIndex(html, markers) {
    const indexes = markers.map((marker) => html.lastIndexOf(marker)).filter((idx) => idx >= 0).sort((a, b) => b - a);
    return indexes.length ? indexes[0] : -1;
}

function trimFragment(fragment) {
    return String(fragment || "")
        .replace(/^\s+|\s+$/g, "")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<(?:img|iframe)\b[\s\S]*?>/gi, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
}

function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeDetailText(text, title = "") {
    let out = String(text || "");
    out = out
        .replace(/\u00a0/g, " ")
        .replace(/\s*>\s*/g, " > ")
        .replace(/\s+/g, " ")
        .trim();

    // ตัด prefix หัวข้ออัลบั้มที่ไม่ใช่เนื้อหารายละเอียด
    out = out.replace(/^อัลบั้มภาพ\s*"?[^"]{1,260}"?\s*/i, "");

    // ตัด breadcrumb นำทางที่มักปะปนเข้ามาโดยไม่ใช่เนื้อหาจริง
    out = out.replace(/^(?:หน้าแรก\s*>\s*)?(?:อัลบั้มภาพกิจกรรม|อัลบั้มภาพ)\s*>\s*/i, "");
    out = out.replace(/^(?:[^>]{1,160}\s*>\s*){2,6}/, "");

    if (title) {
        const titleRe = new RegExp(`^${escapeRegExp(title)}\\s*>\\s*`, "i");
        out = out.replace(titleRe, "");
    }

    // เก็บเฉพาะข้อความจริง ตัดเศษแท็กที่ติดท้าย
    out = out.replace(/<[^>]*$/g, "").trim();

    return out.trim();
}

function isBreadcrumbOnlyText(text) {
    const value = String(text || "").trim();
    if (!value) return true;
    const thaiChars = (value.match(/[ก-๙]/g) || []).length;
    const separators = (value.match(/>/g) || []).length;
    const sentenceMarks = (value.match(/[.!?ฯ]/g) || []).length;

    if (thaiChars < 10) return true;
    if (separators >= 2 && sentenceMarks === 0 && value.length < 260) return true;
    if (separators >= 1 && sentenceMarks === 0 && value.length < 360) return true;
    if (/(?:หน้าแรก|อัลบั้มภาพกิจกรรม|อัลบั้มภาพ)/.test(value) && value.length < 360) return true;
    return false;
}

function scoreDetailFragment(fragment, source = "unknown") {
    const text = cleanText(fragment);
    if (!text) return 0;
    const thaiChars = (text.match(/[ก-๙]/g) || []).length;
    const longEnough = text.length >= 30 ? 20 : 0;
    const hasSentence = /[.!?]|[ฯ]/.test(text) ? 8 : 0;
    const noisePenalty = /หน้าแรก|อัลบั้มภาพกิจกรรม|ประกาศเมื่อวันที่|>>|</.test(text) ? 15 : 0;
    const sourceBonus = source === "below-gallery" ? 35 : source === "above-gallery" ? 0 : 5;
    return thaiChars + longEnough + hasSentence + sourceBonus - noisePenalty;
}

function hasMeaningfulDetailText(fragment) {
    const text = cleanText(fragment);
    if (!text) return false;
    const thaiChars = (text.match(/[ก-๙]/g) || []).length;
    if (thaiChars < 20) return false;
    if (text.length < 80) return false;
    if (/^หน้าแรก|^อัลบั้มภาพกิจกรรม|^ประกาศเมื่อวันที่/.test(text)) return false;
    return true;
}

function hasLabeledDetailText(fragment) {
    const text = cleanText(fragment);
    if (!text) return false;
    const thaiChars = (text.match(/[ก-๙]/g) || []).length;
    if (thaiChars < 5) return false;
    if (/^หน้าแรก|^อัลบั้มภาพกิจกรรม|^ประกาศเมื่อวันที่/.test(text)) return false;
    return true;
}

function extractBestDetailHtml(html) {
    const candidates = [];
    const pushCandidate = (fragment, source) => {
        const trimmed = trimFragment(fragment);
        if (!trimmed) return;
        candidates.push({ fragment: trimmed, source });
    };

    const titleBlock = /<b>\s*อัลบั้มภาพ\s*"[\s\S]*?"\s*<\/b>/i.exec(html);
    const titleEnd = titleBlock ? titleBlock.index + titleBlock[0].length : 0;

    const galleryMarkers = [
        "/photoThumbnail/albums/",
        "/album/picture/",
        "picture/b_",
        "slides[",
        'rel="lightbox',
        "rel='lightbox",
        'id="svDivAlbums5A"',
        "id='svDivAlbums5A'",
        'id="svDivAlbumsMoreC"',
        "id='svDivAlbumsMoreC'",
    ];
    const galleryStart = findFirstIndex(html, galleryMarkers);
    const galleryLast = findLastIndex(html, galleryMarkers);

    // กรณีข้อความอยู่เหนือบล็อครูป
    if (titleEnd > 0 && galleryStart > titleEnd) {
        pushCandidate(html.slice(titleEnd, galleryStart), "above-gallery");
    }

    // กรณีข้อความอยู่ใต้บล็อครูป
    let belowGalleryCandidate = "";
    if (galleryLast > 0) {
        const start = findFirstIndex(html, ["</table>", "</div>"], galleryLast);
        const from = start > galleryLast ? start + 8 : galleryLast;
        const end = findFirstIndex(
            html,
            ["<!--attach files", "<iframe", "<script", "</body>", "<!-- end content -->"],
            from,
        );
        const to = end > from ? end : html.length;
        if (to > from) {
            belowGalleryCandidate = trimFragment(html.slice(from, to));
            if (belowGalleryCandidate) {
                // เคสหลายเว็บวางรายละเอียดไว้หลัง gallery ทั้งหมด
                // ถ้าพบข้อความไทยยาวพอ ให้ยึดส่วนล่างเป็นหลักทันที
                if (hasMeaningfulDetailText(belowGalleryCandidate)) {
                    return belowGalleryCandidate.slice(0, 20000);
                }
                pushCandidate(belowGalleryCandidate, "below-gallery");
            }
        }
    }

    // กรณีข้อความอยู่ใต้ marker กลางหน้า
    const moreMarker = /<div\b[^>]*id\s*=\s*["']svDivAlbumsMoreC["'][^>]*>[\s\S]*?<\/div>/i.exec(html);
    if (moreMarker) {
        const start = moreMarker.index + moreMarker[0].length;
        const end = findFirstIndex(
            html,
            ["<!--attach files", "<iframe", "/photoThumbnail/albums/", 'id="svDivAlbums5A"', "id='svDivAlbums5A'"],
            start,
        );
        if (end > start) pushCandidate(html.slice(start, end), "mid-marker");
    }

    // fallback กว้างๆ จาก title ถึงท้าย body
    const bodyStart = html.indexOf("<body");
    const bodyOpenEnd = bodyStart >= 0 ? html.indexOf(">", bodyStart) + 1 : 0;
    const bodyEnd = html.lastIndexOf("</body>");
    if (bodyOpenEnd > 0 && bodyEnd > bodyOpenEnd) {
        const looseEnd = galleryStart > bodyOpenEnd ? galleryStart : bodyEnd;
        if (looseEnd > bodyOpenEnd) pushCandidate(html.slice(bodyOpenEnd, looseEnd), "body-fallback");
    }

    const scored = candidates
        .map((candidate) => ({
            ...candidate,
            score: scoreDetailFragment(candidate.fragment, candidate.source),
        }))
        .sort((a, b) => b.score - a.score);

    return scored.length ? scored[0].fragment.slice(0, 20000) : "";
}

function extractImageUrls(html, activityUrl, albumId) {
    const rawUrls = [];
    const attrRe =
        /(?:src|href)\s*=\s*(?:"([^"]+\.(?:jpg|jpeg|png|gif|webp))"|'([^']+\.(?:jpg|jpeg|png|gif|webp))'|([^\s>]+\.(?:jpg|jpeg|png|gif|webp)))/gi;
    const slideRe = /slides\d*\[\d+\]\s*=\s*\[\s*"([^"]+\.(?:jpg|jpeg|png|gif|webp))"/gi;
    let match;

    while ((match = attrRe.exec(html)) !== null) rawUrls.push(match[1] || match[2] || match[3]);
    while ((match = slideRe.exec(html)) !== null) rawUrls.push(match[1]);

    const marker = `/photoThumbnail/albums/a${albumId}_a/`;
    const out = new Set();
    for (const raw of rawUrls) {
        try {
            const url = new URL(htmlDecode(raw), activityUrl).toString();
            const pathname = new URL(url).pathname.toLowerCase();
            const isLegacyAlbumImage = url.includes(marker) && !url.includes("/thumb/");
            const isKantangtaiAlbumImage = pathname.includes("/album/picture/");
            if (!isLegacyAlbumImage && !isKantangtaiAlbumImage) continue;
            out.add(url);
        } catch {
            // ignore malformed URL
        }
    }
    return [...out];
}

function fileNameFromUrl(fileUrl) {
    const fromPath = path.basename(new URL(fileUrl).pathname);
    try {
        return safeName(decodeURIComponent(fromPath));
    } catch {
        return safeName(fromPath);
    }
}

function nowSql() {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function boolEnv(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function sameSiteHostname(a, b) {
    try {
        const normalize = (value) => new URL(value).hostname.toLowerCase().replace(/^www\./, "");
        return normalize(a) === normalize(b);
    } catch {
        return false;
    }
}

function pdfStorageForMediaBuffer(buffer, mimeType, fileName, logger) {
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
    if (buffer.length > maxMb * 1024 * 1024) {
        if (logger) {
            logger(
                `PDF ${fileName} มีขนาด ${(buffer.length / 1024 / 1024).toFixed(2)} MB ` +
                    `เกิน PDF_DB_MAX_MB=${maxMb} จึงเก็บเฉพาะไฟล์และ metadata`,
            );
        }
        return { fileSha256, pdfData: null, pdfStoredInDb: false };
    }
    return { fileSha256, pdfData: null, pdfStoredInDb: true };
}

function writeActivityDetailText(folderPath, details, source, activityUrl) {
    const filePath = path.join(folderPath, "รายละเอียดกิจกรรม.txt");
    const body = [
        `หัวข้อกิจกรรม: ${details.title || ""}`,
        `วันที่/เวลาประกาศ: ${details.announcedText || details.announcedDate || "ไม่พบข้อมูล"}`,
        `รหัสกิจกรรม: ${source.albumId || ""}`,
        `ลิงก์หน้ารายการ: ${source.listingUrl || ""}`,
        `ลิงก์รายละเอียด: ${activityUrl || ""}`,
        `เวลาที่ดึงข้อมูล: ${new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`,
        "",
        "รายละเอียดกิจกรรม",
        "--------------------",
        details.detailText || "ไม่พบข้อความรายละเอียดในหน้าเว็บไซต์",
        "",
    ].join("\r\n");
    fs.writeFileSync(filePath, `\uFEFF${body}`, "utf8");
    return filePath;
}

async function scrapeActivityPictures({
    startUrl,
    outDir,
    logger,
    shouldStop = () => false,
    onAuditRecord = () => {},
    adapterProfile = {},
    fileStore = null,
}) {
    const outputDir = outDir || path.join(__dirname, "..", "..", "nongtalay-activity-downloads");
    ensureDir(outputDir);
    let effectiveStartUrl = startUrl;
    const startHostname = new URL(startUrl).hostname;
    const parserProfile = detectActivityParserProfile(startUrl);
    logger(`Adapter กิจกรรม: ${adapterProfile.vendorName || "Generic"} (${adapterProfile.vendorId || "generic"})`);
    logger(`รูปแบบหน้ากิจกรรม: ${parserProfile.mode} path=${parserProfile.pathname}`);
    const assertNotStopped = () => {
        if (shouldStop()) throw new Error("JOB_STOPPED_BY_USER");
    };
    const rethrowIfStopped = (error) => {
        if (error && error.message === "JOB_STOPPED_BY_USER") throw error;
    };

    const listingQueue = [startUrl];
    const visitedListingUrls = new Set();
    const queuedListingUrls = new Set(listingQueue);
    const activityMap = new Map();

    while (listingQueue.length) {
        assertNotStopped();
        const listUrl = listingQueue.shift();
        if (visitedListingUrls.has(listUrl)) continue;
        visitedListingUrls.add(listUrl);

        try {
            logger(`เยี่ยมชมหน้ารายการอัลบั้ม: ${listUrl}`);
            const listingResult = await fetchHtmlResult(listUrl, logger, { shouldStop });
            const html = listingResult.html;
            const effectiveListUrl = listingResult.finalUrl || listUrl;
            if (effectiveListUrl !== listUrl) {
                logger(`หน้ารายการ Redirect ไปยัง Origin จริง: ${listUrl} -> ${effectiveListUrl}`);
            }
            if (listUrl === startUrl || effectiveStartUrl === startUrl) {
                effectiveStartUrl = effectiveListUrl;
            }

            const discovered = discoverActivityPageLinks(
                html,
                effectiveListUrl,
                effectiveStartUrl,
                adapterProfile,
            );
            const pageNo = flexibleListingPageNo(effectiveListUrl);
            const activities = discovered.details.filter((activity) =>
                sameSiteIgnoringWww(activity.href, startUrl),
            );
            logger(
                `[activity-parser] หน้านี้พบกิจกรรม=${activities.length}, หน้าถัดไป=${discovered.listings.length}`,
            );
            for (const activity of activities) {
                const effectiveActivityHref = alignUrlOriginToReferer(
                    activity.href,
                    effectiveListUrl,
                );
                const current = activityMap.get(effectiveActivityHref);
                if (!current || current.title.length < activity.title.length) {
                    activityMap.set(effectiveActivityHref, {
                        ...activity,
                        href: effectiveActivityHref,
                        albumId: activity.activityId,
                        listingUrl: effectiveListUrl,
                        pageNo,
                    });
                }
            }

            for (const page of discovered.listings) {
                const pageUrl = alignUrlOriginToReferer(page.href, effectiveListUrl);
                if (!sameSiteIgnoringWww(pageUrl, startUrl)) continue;
                if (queuedListingUrls.has(pageUrl)) continue;
                queuedListingUrls.add(pageUrl);
                listingQueue.push(pageUrl);
            }

            await sleepWithStop(100, shouldStop);
        } catch (error) {
            rethrowIfStopped(error);
            logger(`ข้ามหน้ารายการอัลบั้ม (โหลดไม่สำเร็จ): ${listUrl} - ${error.message}`);
        }
    }

    logger(`รวมลิงก์กิจกรรมได้ ${activityMap.size} รายการ`);

    const rows = [];
    const detailRows = [];
    const mediaRows = [];
    const auditRows = [];
    const seenReferenceUrls = new Set();
    let imageCount = 0;

    const emitAudit = (values) => {
        const record = createAuditRecord(values);
        auditRows.push(record);
        onAuditRecord(record);
        return record;
    };
    for (const [activityUrl, source] of activityMap.entries()) {
        assertNotStopped();
        logger(`ดึงหน้ากิจกรรม: ${activityUrl}`);
        const activityResult = await fetchHtmlResult(activityUrl, logger, {
            shouldStop,
            referer: source.listingUrl,
        });
        const html = activityResult.html;
        const effectiveActivityUrl = activityResult.finalUrl || activityUrl;
        if (effectiveActivityUrl !== activityUrl) {
            logger(`หน้ากิจกรรม Redirect ไปยัง Origin จริง: ${activityUrl} -> ${effectiveActivityUrl}`);
        }
        const details = extractActivityDetails(html, effectiveActivityUrl, source.title);
        if (details.title && details.title !== source.title) {
            logger(`ชื่อกิจกรรมที่ตรวจพบ: ${details.title}`);
        }
        const htmlImageUrls = extractGalleryImageUrls(
            html,
            effectiveActivityUrl,
            source.albumId,
        ).map((imageUrl) => alignUrlOriginToReferer(imageUrl, effectiveActivityUrl));

        let renderedCapture = { images: [] };
        try {
            renderedCapture = await captureRenderedImagesFromPage(
                effectiveActivityUrl,
                logger,
                {
                    listingReferer: source.listingUrl,
                    shouldStop,
                },
            );
        } catch (error) {
            rethrowIfStopped(error);
            logger(
                `ไม่สามารถจับรูปที่ Chrome แสดงจากหน้ากิจกรรมได้ จะใช้ URL จาก HTML ต่อ: ${error.message}`,
            );
        }

        const handledRenderedUrls = new Set();
        const imageJobs = [];
        for (const rendered of renderedCapture.images || []) {
            const renderedUrl = alignUrlOriginToReferer(
                rendered.url || rendered.result?.finalUrl || effectiveActivityUrl,
                effectiveActivityUrl,
            );
            const linkedOriginalUrl = rendered.linkedOriginalUrl
                ? alignUrlOriginToReferer(rendered.linkedOriginalUrl, effectiveActivityUrl)
                : "";
            if (
                (renderedUrl && isExcludedActivityImageUrl(renderedUrl)) ||
                (linkedOriginalUrl && isExcludedActivityImageUrl(linkedOriginalUrl))
            ) {
                logger(`ข้ามรูปประกอบระบบ Lightbox/หน้าเว็บ: ${renderedUrl || linkedOriginalUrl}`);
                continue;
            }
            if (renderedUrl) handledRenderedUrls.add(normalizeAssetUrl(renderedUrl));
            if (linkedOriginalUrl) handledRenderedUrls.add(normalizeAssetUrl(linkedOriginalUrl));
            imageJobs.push({
                imageUrl: renderedUrl,
                linkedOriginalUrl,
                preloadedResult: rendered.result,
                discoveredVia: "browser-rendered",
            });
        }

        for (const imageUrl of htmlImageUrls) {
            if (isExcludedActivityImageUrl(imageUrl)) {
                logger(`ข้ามรูปประกอบระบบ Lightbox/หน้าเว็บ: ${imageUrl}`);
                continue;
            }
            if (handledRenderedUrls.has(normalizeAssetUrl(imageUrl))) continue;
            imageJobs.push({
                imageUrl,
                linkedOriginalUrl: "",
                preloadedResult: null,
                discoveredVia: "activity-gallery-html",
            });
        }

        const uniqueJobs = [];
        const seenJobUrls = new Set();
        for (const job of imageJobs) {
            const key = normalizeAssetUrl(job.imageUrl || job.linkedOriginalUrl);
            if (!key || seenJobUrls.has(key)) continue;
            seenJobUrls.add(key);
            uniqueJobs.push(job);
        }

        const folderPath = path.join(
            outputDir,
            safeActivityFolderName(details.title, source.albumId),
        );
        ensureDir(folderPath);
        const detailTextPath = writeActivityDetailText(
            folderPath,
            details,
            source,
            effectiveActivityUrl,
        );
        detailRows.push({
            pageNo: source.pageNo,
            albumId: source.albumId,
            listingUrl: source.listingUrl,
            activityUrl: effectiveActivityUrl,
            title: details.title,
            detailHtml: details.detailHtml,
            detailText: details.detailText,
            detailTextPath,
            announcedText: details.announcedText,
            announcedDate: details.announcedDate,
            announcedAt: details.announcedAt,
            folderPath,
            scrapedAt: nowSql(),
        });
        logger(`บันทึกรายละเอียดกิจกรรม: ${detailTextPath}`);

        const additionalMedia = extractMediaCandidates(html, effectiveActivityUrl, {
            includeDocuments: true,
            includeImages: false,
            includeVideo: true,
            includeAudio: true,
            includeEmbeds: true,
        });

        let imageIndex = 0;
        for (const imageJob of uniqueJobs) {
            assertNotStopped();
            const imageUrl = imageJob.imageUrl || imageJob.linkedOriginalUrl;
            if (isExcludedActivityImageUrl(imageUrl)) {
                logger(`ข้ามรูปประกอบระบบ Lightbox/หน้าเว็บก่อนดาวน์โหลด: ${imageUrl}`);
                continue;
            }
            imageIndex += 1;
            const normalizedFileUrl = normalizeAssetUrl(imageUrl);
            const duplicateOfUrl = seenReferenceUrls.has(normalizedFileUrl) ? normalizedFileUrl : null;
            seenReferenceUrls.add(normalizedFileUrl);
            const auditBase = {
                sourceType: "activity_image",
                detailId: source.albumId,
                detailUrl: effectiveActivityUrl,
                title: details.title,
                fileUrl: imageUrl,
                normalizedFileUrl,
                fileName: fileNameFromUrl(imageUrl),
                fileType: "image",
                discoveredVia: imageJob.discoveredVia,
                linkText: imageJob.linkedOriginalUrl
                    ? `original=${imageJob.linkedOriginalUrl}`
                    : "",
                duplicateOfUrl,
            };

            const imageSkipReason = getUrlSkipReason(imageUrl);
            if (imageSkipReason) {
                emitAudit({
                    ...auditBase,
                    status: "skipped_external",
                    downloadable: false,
                    downloaded: false,
                    errorMessage: `ข้าม URL โดยไม่เปิดตามนโยบาย: ${imageSkipReason}`,
                });
                logger(`ข้าม URL รูปโดยไม่เปิด: ${imageUrl} — ${imageSkipReason}`);
                continue;
            }

            try {
                // ข้ามไฟล์ซ้ำโดยไม่ดาวน์โหลดเลย — ตรวจ index ก่อนดาวน์โหลด (URL + SHA-256 ถาวรต่อเว็บไซต์)
                let reuseRecord = fileStore ? fileStore.find(imageUrl) : null;

                let result = null;
                let imageDigest = null;
                if (!reuseRecord) {
                    const doDownload = () =>
                        downloadBinary(imageUrl, logger, 5, {
                            referer: effectiveActivityUrl,
                            listingReferer: source.listingUrl,
                            shouldStop,
                            expectFile: true,
                        });
                    result = imageJob.preloadedResult
                        ? imageJob.preloadedResult
                        : fileStore
                          ? await fileStore.claimDownload(imageUrl, doDownload)
                          : await doDownload();
                    const { buffer, headers = {}, statusCode = 200, finalUrl = imageUrl } = result;

                    if (!buffer || buffer.length === 0) {
                        emitAudit({
                            ...auditBase,
                            status: "empty_file",
                            httpStatus: statusCode,
                            downloadable: false,
                            downloaded: false,
                            contentType: contentType(headers),
                            finalUrl,
                            errorMessage: "เซิร์ฟเวอร์ส่งรูปขนาด 0 ไบต์",
                        });
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
                            errorMessage: "ลิงก์รูปตอบกลับเป็นหน้า HTML",
                        });
                        continue;
                    }

                    imageDigest = crypto.createHash("sha256").update(buffer).digest("hex");
                    if (fileStore) {
                        reuseRecord =
                            fileStore.find(imageUrl, finalUrl || imageUrl) ||
                            fileStore.findByDigest(imageDigest);
                    }
                }
                const actualContentType = reuseRecord
                    ? reuseRecord.mimeType
                    : detectedContentType(result.buffer, result.headers || {});
                const finalUrl =
                    (result && result.finalUrl) ||
                    (reuseRecord && reuseRecord.finalUrl) ||
                    imageUrl;
                const downloadSource = result
                    ? result.headers["x-scraper-source"] || result.headers["X-Scraper-Source"] || "direct"
                    : "direct";
                const usedRenderedCopy = result
                    ? ["rendered-element-screenshot", "rendered-image-canvas"].includes(
                          String(downloadSource),
                      )
                    : false;
                let localPath;
                let saveStatus = "downloaded";
                if (reuseRecord) {
                    localPath = reuseRecord.localPath;
                    saveStatus = "already_exists";
                    // จด URL ใหม่ชี้ไปไฟล์เดิม เพื่อให้รอบถัดไปข้ามได้โดยไม่ต้องดาวน์โหลด
                    if (fileStore) {
                        fileStore.register({
                            url: imageUrl,
                            finalUrl,
                            localPath,
                            sha256: reuseRecord.sha256 || imageDigest,
                            fileSize: reuseRecord.fileSize,
                            mimeType: reuseRecord.mimeType || actualContentType,
                            addedAt: reuseRecord.addedAt,
                        });
                    }
                } else {
                    const imageName = ensureImageExtension(
                        fileNameFromUrl(imageUrl),
                        actualContentType,
                    );
                    localPath = uniqueFilePath(folderPath, imageName);
                    fs.writeFileSync(localPath, result.buffer);
                    if (fileStore) {
                        fileStore.register({
                            url: imageUrl,
                            finalUrl,
                            localPath,
                            sha256: imageDigest,
                            fileSize: result.buffer.length,
                            mimeType: actualContentType,
                        });
                    }
                }
                const fileSize = reuseRecord ? reuseRecord.fileSize : result.buffer.length;
                const savedAt = reuseRecord ? reuseRecord.addedAt : nowSql();
                imageCount += 1;
                const actualImageName = path.basename(localPath);
                rows.push({
                    pageNo: source.pageNo,
                    albumId: source.albumId,
                    listingUrl: source.listingUrl,
                    activityUrl: effectiveActivityUrl,
                    title: details.title,
                    detailHtml: details.detailHtml,
                    detailText: details.detailText,
                    announcedDate: details.announcedDate,
                    announcedText: details.announcedText,
                    announcedAt: details.announcedAt,
                    detailTextPath,
                    folderPath,
                    imageIndex,
                    imageName: actualImageName,
                    imageUrl,
                    localPath,
                    fileSize,
                    downloadSource,
                    mediaType: "image",
                    mediaMimeType: actualContentType,
                    mediaProvider: null,
                    embedUrl: null,
                    downloadedAt: savedAt,
                });
                mediaRows.push({
                    albumId: source.albumId,
                    activityUrl: effectiveActivityUrl,
                    title: details.title,
                    mediaIndex: imageIndex,
                    mediaType: "image",
                    mediaProvider: null,
                    mediaName: actualImageName,
                    mediaUrl: imageUrl,
                    embedUrl: null,
                    localPath,
                    fileSize,
                    mediaMimeType: actualContentType,
                    fileSha256: imageDigest || (reuseRecord ? reuseRecord.sha256 : null),
                    pdfData: null,
                    pdfStoredInDb: false,
                    downloadSource,
                    isDownloaded: true,
                    downloadedAt: savedAt,
                });
                emitAudit({
                    ...auditBase,
                    status: saveStatus,
                    httpStatus: result ? result.statusCode : null,
                    downloadable: true,
                    downloaded: saveStatus === "downloaded",
                    fileName: actualImageName,
                    fileSize,
                    contentType: actualContentType,
                    localPath,
                    finalUrl,
                    duplicateOfUrl: duplicateOfUrl || (reuseRecord ? reuseRecord.url : null),
                    errorMessage: usedRenderedCopy
                        ? "URL รูปต้นฉบับถูกปฏิเสธ ระบบบันทึกสำเนาภาพที่ Chrome แสดงบนหน้าอัลบั้มแทน"
                        : reuseRecord
                          ? `ข้ามรูปซ้ำ: เคยดาวน์โหลด ${reuseRecord.url} ไว้แล้ว`
                          : null,
                });
                if (reuseRecord) {
                    logger(`ข้ามรูปซ้ำ (ใช้ไฟล์เดิม): ${actualImageName} — ${reuseRecord.url}`);
                } else if (usedRenderedCopy || imageJob.preloadedResult) {
                    logger(`บันทึกภาพที่ Chrome แสดงจริง: ${actualImageName}`);
                } else {
                    logger(`บันทึกรูป: ${actualImageName}`);
                }
                await sleepWithStop(25, shouldStop);
            } catch (error) {
                rethrowIfStopped(error);
                const classified = classifyDownloadError(error);
                emitAudit({
                    ...auditBase,
                    ...classified,
                    downloadable: false,
                    downloaded: false,
                });
                logger(`ข้ามรูป (โหลดไม่สำเร็จ): ${imageUrl} - ${error.message}`);
            }
        }

        let additionalMediaIndex = imageIndex;
        for (const media of additionalMedia) {
            assertNotStopped();
            additionalMediaIndex += 1;
            const auditBase = {
                sourceType: `activity_${media.mediaType}`,
                detailId: source.albumId,
                detailUrl: effectiveActivityUrl,
                title: details.title,
                fileUrl: media.url,
                normalizedFileUrl: media.normalizedUrl,
                fileName: mediaFileName(media.url, `${media.mediaType}-${additionalMediaIndex}`),
                fileType: media.mediaType,
                discoveredVia: media.discoveredVia,
                linkText: media.linkText,
            };

            const mediaSkipReason = getUrlSkipReason(media.url);
            if (mediaSkipReason) {
                emitAudit({
                    ...auditBase,
                    status: "skipped_external",
                    downloadable: false,
                    downloaded: false,
                    errorMessage: `ข้าม URL โดยไม่เปิดตามนโยบาย: ${mediaSkipReason}`,
                });
                logger(`ข้าม URL สื่อโดยไม่เปิด: ${media.url} — ${mediaSkipReason}`);
                continue;
            }

            if (media.downloadable === false) {
                mediaRows.push({
                    albumId: source.albumId,
                    activityUrl: effectiveActivityUrl,
                    title: details.title,
                    mediaIndex: additionalMediaIndex,
                    mediaType: media.mediaType,
                    mediaProvider: media.provider,
                    mediaName: null,
                    mediaUrl: media.url,
                    embedUrl: media.url,
                    localPath: null,
                    fileSize: null,
                    mediaMimeType: null,
                    fileSha256: null,
                    pdfData: null,
                    pdfStoredInDb: false,
                    downloadSource: "reference-only",
                    isDownloaded: false,
                    downloadedAt: nowSql(),
                });
                emitAudit({
                    ...auditBase,
                    status: media.mediaType === "video_embed" ? "referenced_embed" : "referenced_stream",
                    downloadable: false,
                    downloaded: false,
                    finalUrl: media.url,
                    errorMessage:
                        media.mediaType === "video_embed"
                            ? `เก็บลิงก์วิดีโอ ${media.provider || "embed"} ไว้ในฐานข้อมูล`
                            : "เก็บ URL stream ไว้ในฐานข้อมูล",
                });
                logger(`เก็บลิงก์วิดีโอ/สตรีมไว้ในฐานข้อมูล: ${media.url}`);
                continue;
            }

            if (!boolEnv("ALLOW_EXTERNAL_ASSETS", false) && !sameSiteHostname(media.url, effectiveActivityUrl)) {
                emitAudit({
                    ...auditBase,
                    status: "skipped_external",
                    downloadable: false,
                    downloaded: false,
                    errorMessage: "ข้ามไฟล์ต่างเว็บไซต์ตามค่า ALLOW_EXTERNAL_ASSETS=false",
                });
                continue;
            }

            try {
                // ข้ามไฟล์ซ้ำโดยไม่ดาวน์โหลดเลย — ตรวจ index ก่อนดาวน์โหลด (URL + SHA-256 ถาวรต่อเว็บไซต์)
                let reuseRecord = fileStore ? fileStore.find(media.url) : null;

                let result = null;
                let mediaDigest = null;
                if (!reuseRecord) {
                    const doDownload = () =>
                        downloadBinary(media.url, logger, 5, {
                            referer: effectiveActivityUrl,
                            listingReferer: source.listingUrl,
                            shouldStop,
                            expectFile: true,
                        });
                    result = fileStore
                        ? await fileStore.claimDownload(media.url, doDownload)
                        : await doDownload();
                    const { buffer, headers = {}, statusCode = 200, finalUrl = media.url } = result;
                    if (!buffer || !buffer.length || looksLikeHtml(buffer, headers)) {
                        throw new Error(`ลิงก์ ${media.mediaType} ไม่ได้ตอบกลับเป็นไฟล์จริง`);
                    }
                    mediaDigest = crypto.createHash("sha256").update(buffer).digest("hex");
                    if (fileStore) {
                        reuseRecord =
                            fileStore.find(media.url, finalUrl || media.url) ||
                            fileStore.findByDigest(mediaDigest);
                    }
                }
                const mediaMimeType = reuseRecord
                    ? reuseRecord.mimeType
                    : detectedContentType(result.buffer, result.headers || {});
                const finalUrl =
                    (result && result.finalUrl) ||
                    (reuseRecord && reuseRecord.finalUrl) ||
                    media.url;
                let mediaName;
                let localPath;
                let saveStatus = "downloaded";
                let savedAt;
                if (reuseRecord) {
                    localPath = reuseRecord.localPath;
                    saveStatus = "already_exists";
                    savedAt = reuseRecord.addedAt;
                    mediaName = path.basename(localPath);
                    // จด URL ใหม่ชี้ไปไฟล์เดิม เพื่อให้รอบถัดไปข้ามได้โดยไม่ต้องดาวน์โหลด
                    if (fileStore) {
                        fileStore.register({
                            url: media.url,
                            finalUrl,
                            localPath,
                            sha256: mediaDigest || reuseRecord.sha256,
                            fileSize: reuseRecord.fileSize,
                            mimeType: mediaMimeType,
                            addedAt: reuseRecord.addedAt,
                        });
                    }
                } else {
                    const { buffer, headers = {} } = result;
                    mediaName = ensureFileNameExtension(
                        safeName(mediaFileName(finalUrl, `${media.mediaType}-${additionalMediaIndex}`)),
                        headers,
                        buffer,
                    );
                    const mediaDir = path.join(
                        folderPath,
                        media.mediaType === "video"
                            ? "videos"
                            : media.mediaType === "audio"
                              ? "audio"
                              : "documents",
                    );
                    ensureDir(mediaDir);
                    localPath = uniqueFilePath(mediaDir, mediaName);
                    fs.writeFileSync(localPath, buffer);
                    mediaName = path.basename(localPath);
                    savedAt = nowSql();
                    if (fileStore) {
                        fileStore.register({
                            url: media.url,
                            finalUrl,
                            localPath,
                            sha256: mediaDigest,
                            fileSize: buffer.length,
                            mimeType: mediaMimeType,
                        });
                    }
                }
                const mediaFileSize = reuseRecord ? reuseRecord.fileSize : result.buffer.length;
                const pdfStorage =
                    reuseRecord && !result
                        ? { fileSha256: reuseRecord.sha256 || null, pdfData: null, pdfStoredInDb: false }
                        : pdfStorageForMediaBuffer(result.buffer, mediaMimeType, mediaName, logger);
                const downloadSource = result
                    ? result.headers["x-scraper-source"] || result.headers["X-Scraper-Source"] || "direct"
                    : "direct";
                mediaRows.push({
                    albumId: source.albumId,
                    activityUrl: effectiveActivityUrl,
                    title: details.title,
                    mediaIndex: additionalMediaIndex,
                    mediaType: media.mediaType,
                    mediaProvider: media.provider,
                    mediaName,
                    mediaUrl: media.url,
                    embedUrl: null,
                    localPath,
                    fileSize: mediaFileSize,
                    mediaMimeType,
                    fileSha256: mediaDigest || (reuseRecord ? reuseRecord.sha256 : null),
                    pdfData: pdfStorage.pdfData,
                    pdfStoredInDb: pdfStorage.pdfStoredInDb,
                    downloadSource,
                    isDownloaded: true,
                    downloadedAt: savedAt,
                });
                emitAudit({
                    ...auditBase,
                    status: saveStatus,
                    httpStatus: result ? result.statusCode : null,
                    downloadable: true,
                    downloaded: saveStatus === "downloaded",
                    fileName: mediaName,
                    fileSize: mediaFileSize,
                    contentType: mediaMimeType,
                    localPath,
                    finalUrl,
                    duplicateOfUrl: reuseRecord ? reuseRecord.url : null,
                    errorMessage: reuseRecord
                        ? `ข้ามไฟล์ซ้ำ: เคยดาวน์โหลด ${reuseRecord.url} ไว้แล้ว`
                        : null,
                });
                logger(
                    reuseRecord
                        ? `ข้ามไฟล์ซ้ำ (ใช้ไฟล์เดิม): ${mediaName} — ${reuseRecord.url}`
                        : `บันทึก${
                              media.mediaType === "video"
                                  ? "วิดีโอ"
                                  : media.mediaType === "audio"
                                    ? "เสียง"
                                    : "เอกสาร"
                          }: ${mediaName}` +
                              (pdfStorage.pdfStoredInDb ? " และเตรียมเก็บ PDF ลงฐานข้อมูล" : ""),
                );
            } catch (error) {
                rethrowIfStopped(error);
                emitAudit({
                    ...auditBase,
                    ...classifyDownloadError(error),
                    downloadable: false,
                    downloaded: false,
                });
                logger(`ข้ามสื่อ (โหลดไม่สำเร็จ): ${media.url} - ${error.message}`);
            }
        }
    }

    const fileAuditSummary = summarizeFileAudit(auditRows);
    logger(
        `ตรวจไฟล์ภาพเสร็จแล้ว: ทั้งหมด(unique)=${fileAuditSummary.uniqueFiles}, ` +
            `ดาวน์โหลดได้=${fileAuditSummary.downloadable}, 404=${fileAuditSummary.notFound}, ` +
            `403=${fileAuditSummary.forbidden}, ล้มเหลว=${fileAuditSummary.failed}`,
    );

    return {
        rows,
        detailRows,
        mediaRows,
        activityCount: activityMap.size,
        imageCount,
        mediaCount: mediaRows.length,
        fileAudit: auditRows,
        fileAuditSummary,
    };
}

module.exports = {
    extractActivityDetails,
    scrapeActivityPictures,
    writeActivityDetailText,
};
