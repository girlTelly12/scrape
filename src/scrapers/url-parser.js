const path = require("path");
const { cleanText, htmlDecode } = require("../common");

const CATEGORY_PARAM_NAMES = [
    "cat_id",
    "catid",
    "cate_id",
    "cateid",
    "cate",
    "cid",
    "category_id",
    "categoryid",
    "category",
    "cat",
    "type_id",
    "typeid",
    "type",
    "group_id",
    "group",
    "news_type",
];

const PAGINATION_PARAM_NAMES = [
    "pageid",
    "page",
    "page_no",
    "pageno",
    "page_num",
    "pagenum",
    "curpage",
    "currentpage",
    "paged",
    "p",
    "pg",
    "start",
    "startrow",
    "start_row",
    "offset",
    "limitstart",
];

const DETAIL_ID_PARAM_NAMES = [
    "news_id",
    "newsid",
    "news_no",
    "newsno",
    "n_id",
    "id",
    "nid",
    "news",
    "detail_id",
    "detailid",
    "item_id",
    "itemid",
    "article_id",
    "articleid",
    "post_id",
    "postid",
    "view_id",
    "content_id",
    "contentid",
    "record_id",
    "recordid",
    "rec_id",
    "no",
];

const TRACKING_PARAM_NAMES = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
];

const DETAIL_PATH_RE = /(?:^|\/)(?:detail|details|view|read|show|article|articles|post|posts|news-detail|news_detail|newsdetail|detail-news|detail_news|view-news|view_news|readnews|news-view|news_view)(?:\.php|\/|$)/i;
const DETAIL_FILE_RE = /(?:^|\/)[^/]*(?:detail|view|read|show|article|content|data)[^/]*\.(?:php|html?|aspx?)(?:$|\?)/i;
const ROUTE_NOISE_RE = /(?:^|\/)(?:index|home|main|contact|about|history|vision|mission|personnel|structure|login|search|sitemap|calendar|webboard|guestbook)(?:[-_.\/]|$)/i;
const NAV_TEXT_RE = /^(?:หน้าแรก|หน้าหลัก|ย้อนกลับ|กลับ|ถัดไป|ก่อนหน้า|next|previous|home|เมนู|เข้าสู่ระบบ|ค้นหา|ทั้งหมด|ดูทั้งหมด|อ่านทั้งหมด|more|click here|[0-9]{1,4})$/i;
const ASSET_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpe?g|png|gif|webp|svg|mp3|mp4)(?:$|[?#])/i;
const ASSET_PATH_RE = /\/(?:doc_download|downloads?|attachments?|uploads?|files?|images?|assets?)\//i;

function lowerParamMap(url) {
    const parsed = new URL(url);
    const map = new Map();
    for (const [key, value] of parsed.searchParams.entries()) {
        const lower = key.toLowerCase();
        if (!map.has(lower)) map.set(lower, { key, value });
    }
    return { parsed, map };
}

function getParamCaseInsensitive(url, names) {
    try {
        const { map } = lowerParamMap(url);
        for (const name of names) {
            const found = map.get(String(name).toLowerCase());
            if (found && found.value !== "") return found;
        }
    } catch {
        // ignore malformed URL
    }
    return null;
}

function categoryConstraintsFromUrl(url) {
    try {
        const { map } = lowerParamMap(url);
        const constraints = {};
        for (const name of CATEGORY_PARAM_NAMES) {
            const found = map.get(name.toLowerCase());
            if (found && found.value !== "") constraints[name.toLowerCase()] = found.value;
        }
        return constraints;
    } catch {
        return {};
    }
}

function applyCategoryConstraints(url, constraints = {}) {
    const parsed = new URL(url);
    const existing = new Set([...parsed.searchParams.keys()].map((key) => key.toLowerCase()));
    for (const [key, value] of Object.entries(constraints || {})) {
        if (!existing.has(key.toLowerCase())) parsed.searchParams.set(key, value);
    }
    return parsed.toString();
}

function canonicalizeUrl(url) {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
        if (TRACKING_PARAM_NAMES.includes(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    const entries = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    parsed.search = "";
    for (const [key, value] of entries) parsed.searchParams.append(key, value);
    return parsed.toString();
}

function isHttpUrl(url) {
    try {
        return ["http:", "https:"].includes(new URL(url).protocol);
    } catch {
        return false;
    }
}

function isAssetLikeUrl(url) {
    try {
        const parsed = new URL(url);
        return ASSET_EXT_RE.test(parsed.pathname + parsed.search) || ASSET_PATH_RE.test(parsed.pathname);
    } catch {
        return false;
    }
}

function pathDetailToken(url) {
    try {
        const parsed = new URL(url);
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (!parts.length) return null;
        const last = decodeURIComponent(parts[parts.length - 1]);
        if (/^(?:detail|view|read|show|article|post|news|index)(?:\.php)?$/i.test(last)) return null;
        if (/\.(?:php|html?|aspx?)$/i.test(last)) return null;
        if (/^[0-9a-z][0-9a-z_-]{0,127}$/i.test(last)) return last;
    } catch {
        // ignore
    }
    return null;
}

function unknownDetailParam(url) {
    try {
        const parsed = new URL(url);
        const ignored = new Set([
            ...CATEGORY_PARAM_NAMES,
            ...PAGINATION_PARAM_NAMES,
            ...TRACKING_PARAM_NAMES,
            "lang",
            "search",
            "q",
            "sort",
            "order",
            "year",
            "month",
            "tag",
            "keyword",
        ].map((name) => name.toLowerCase()));
        for (const [key, value] of parsed.searchParams.entries()) {
            if (ignored.has(key.toLowerCase()) || !value) continue;
            if (/^(?:view|detail|read|show)$/i.test(value)) continue;
            if (/^[0-9]{1,18}$/.test(value) || /^[0-9a-f-]{8,64}$/i.test(value)) {
                return { key, value };
            }
        }
    } catch {
        // ignore
    }
    return null;
}

function detailIdentityFromUrl(url) {
    const known = getParamCaseInsensitive(url, DETAIL_ID_PARAM_NAMES);
    if (known) return known;

    const unknown = unknownDetailParam(url);
    if (unknown) return unknown;

    const token = pathDetailToken(url);
    if (token) return { key: "path", value: token };
    return null;
}

function detailIdFromUrl(url) {
    const identity = detailIdentityFromUrl(url);
    return identity ? identity.value : null;
}

function detailIdParamFromUrl(url) {
    const identity = detailIdentityFromUrl(url);
    return identity && identity.key !== "path" ? identity.key : null;
}

function hasPaginationSignal(url, startUrl = null) {
    try {
        const parsed = new URL(url);
        const param = getParamCaseInsensitive(url, PAGINATION_PARAM_NAMES);
        if (param) return true;
        if (/\/(?:page|paged)\/\d+\/?$/i.test(parsed.pathname)) return true;
        if (startUrl && canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return true;
    } catch {
        // ignore
    }
    return false;
}

function categoryMatches(url, constraints = {}, { allowMissing = false } = {}) {
    try {
        const { map } = lowerParamMap(url);
        for (const [key, expected] of Object.entries(constraints || {})) {
            const actual = map.get(key.toLowerCase());
            if (!actual) {
                if (allowMissing) continue;
                return false;
            }
            if (String(actual.value) !== String(expected)) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function sameHostname(url, hostname) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "") ===
            String(hostname || "").toLowerCase().replace(/^www\./, "");
    } catch {
        return false;
    }
}

function isMeaningfulContentLinkText(text) {
    const value = cleanText(text || "").replace(/\s+/g, " ").trim();
    if (value.length < 4 || value.length > 1000) return false;
    if (NAV_TEXT_RE.test(value)) return false;
    const meaningfulChars = (value.match(/[\p{L}\p{N}]/gu) || []).length;
    return meaningfulChars >= 4;
}

function isGenericSiblingDetailUrl(url, context = {}, linkText = "") {
    if (!isMeaningfulContentLinkText(linkText) || !isHttpUrl(url) || isAssetLikeUrl(url)) return false;
    try {
        const startUrl = context.startUrl;
        if (!startUrl) return false;
        const start = new URL(startUrl);
        const parsed = new URL(url);
        if (!sameHostname(url, context.hostname || start.hostname)) return false;
        if (canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return false;
        const constraints = context.categoryConstraints || categoryConstraintsFromUrl(startUrl);
        if (!categoryMatches(url, constraints, { allowMissing: true })) return false;
        if (hasPaginationSignal(url, startUrl)) return false;
        if (ROUTE_NOISE_RE.test(parsed.pathname)) return false;

        const startDir = start.pathname.endsWith("/")
            ? start.pathname
            : `${path.posix.dirname(start.pathname)}/`;
        const candidateDir = parsed.pathname.endsWith("/")
            ? parsed.pathname
            : `${path.posix.dirname(parsed.pathname)}/`;
        const sameDirectory = candidateDir.toLowerCase() === startDir.toLowerCase();
        const nestedUnderStart = parsed.pathname.toLowerCase().startsWith(
            start.pathname.replace(/\/+$/, "").toLowerCase() + "/",
        );
        if (!sameDirectory && !nestedUnderStart) return false;

        // Arbitrary legacy PHP routes often use an unknown numeric/UUID parameter.
        if (unknownDetailParam(url)) return true;
        if (DETAIL_FILE_RE.test(parsed.pathname)) return true;

        const basename = path.posix.basename(parsed.pathname).toLowerCase();
        const startBase = path.posix.basename(start.pathname).replace(/\.[^.]+$/, "").toLowerCase();
        if (new RegExp(`(?:^|[-_])${startBase}(?:[-_].*)?\.(?:php|html?|aspx?)$`, "i").test(basename)) {
            return true;
        }
        if (/\d{2,}/.test(basename) && /\.(?:php|html?|aspx?)$/i.test(basename)) return true;
        return false;
    } catch {
        return false;
    }
}


function matchesAdapterPattern(url, patterns = []) {
    return (patterns || []).some((pattern) => {
        try {
            if (pattern instanceof RegExp) {
                pattern.lastIndex = 0;
                return pattern.test(String(url || ""));
            }
            return new RegExp(String(pattern), "i").test(String(url || ""));
        } catch {
            return false;
        }
    });
}

function isLikelyDetailUrl(url, context = {}) {
    if (!isHttpUrl(url) || isAssetLikeUrl(url)) return false;
    try {
        const parsed = new URL(url);
        const startUrl = context.startUrl || null;
        const hostname = context.hostname || (startUrl ? new URL(startUrl).hostname : parsed.hostname);
        if (!sameHostname(url, hostname)) return false;
        if (startUrl && canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return false;
        if (ROUTE_NOISE_RE.test(parsed.pathname)) return false;

        const adapterProfile = context.adapterProfile || {};
        if (matchesAdapterPattern(url, adapterProfile.detailUrlPatterns)) return true;

        const constraints = context.categoryConstraints || (startUrl ? categoryConstraintsFromUrl(startUrl) : {});
        if (!categoryMatches(url, constraints, { allowMissing: true })) return false;

        const knownId = getParamCaseInsensitive(url, DETAIL_ID_PARAM_NAMES);
        if (knownId) return true;

        const action = getParamCaseInsensitive(url, ["action", "mode", "do", "page", "route"]);
        if (action && /^(?:detail|view|read|show|article)$/i.test(action.value)) return true;

        if (/\/(?:page|paged)\/\d+\/?$/i.test(parsed.pathname)) return false;
        if (DETAIL_PATH_RE.test(parsed.pathname) || DETAIL_FILE_RE.test(parsed.pathname)) return true;

        if (startUrl) {
            const start = new URL(startUrl);
            const startPath = start.pathname.replace(/\/+$/, "/");
            const candidatePath = parsed.pathname.replace(/\/+$/, "/");
            if (candidatePath !== startPath && candidatePath.startsWith(startPath)) {
                const token = pathDetailToken(url);
                if (token && !/^(?:page|paged)$/i.test(token)) return true;
            }

            if (candidatePath === startPath && unknownDetailParam(url)) return true;
        }

        return false;
    } catch {
        return false;
    }
}

function isLikelyListingUrl(url, context = {}) {
    if (!isHttpUrl(url) || isAssetLikeUrl(url)) return false;
    try {
        const startUrl = context.startUrl;
        if (!startUrl) return false;
        const start = new URL(startUrl);
        const parsed = new URL(url);
        const hostname = context.hostname || start.hostname;
        if (!sameHostname(url, hostname)) return false;
        if (isLikelyDetailUrl(url, context)) return false;

        const adapterProfile = context.adapterProfile || {};
        if (matchesAdapterPattern(url, adapterProfile.listingUrlPatterns) && hasPaginationSignal(url, startUrl)) {
            return true;
        }

        const constraints = context.categoryConstraints || categoryConstraintsFromUrl(startUrl);
        if (!categoryMatches(url, constraints, { allowMissing: true })) return false;

        if (canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return true;

        const startDir = start.pathname.endsWith("/")
            ? start.pathname
            : `${path.posix.dirname(start.pathname)}/`;
        const samePath = parsed.pathname.toLowerCase() === start.pathname.toLowerCase();
        const sameDirectory = parsed.pathname.toLowerCase().startsWith(startDir.toLowerCase());
        return (samePath || sameDirectory) && hasPaginationSignal(url, startUrl);
    } catch {
        return false;
    }
}

function resolveUrl(raw, baseUrl) {
    const value = htmlDecode(String(raw || "").trim())
        .replace(/^['"]|['"]$/g, "")
        .replace(/&amp;/gi, "&");
    if (!value || /^(?:javascript:|mailto:|tel:|#)/i.test(value)) return null;
    try {
        const url = new URL(value, baseUrl);
        return isHttpUrl(url.toString()) ? url.toString() : null;
    } catch {
        return null;
    }
}

function extractUrlsFromJavascript(js, baseUrl) {
    const source = htmlDecode(String(js || ""));
    const out = [];
    const seen = new Set();
    const add = (raw) => {
        const href = resolveUrl(raw, baseUrl);
        if (!href) return;
        const key = canonicalizeUrl(href);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(href);
    };

    const patterns = [
        /(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/gi,
        /(?:window\.)?open\s*\(\s*['"]([^'"]+)['"]/gi,
        /location\.(?:assign|replace)\s*\(\s*['"]([^'"]+)['"]/gi,
        /(?:MM_openBrWindow|popup|openPopup|openWin|showNews|viewNews)\s*\(\s*['"]([^'"]+)['"]/gi,
        /['"]((?:\.{0,2}\/|\/)?[^'"]*(?:news|detail|view|read|article|post)[^'"]*\.php\?[^'"]+)['"]/gi,
        /['"]((?:\.{0,2}\/|\/)[^'"]+\?(?:[^'"]*&)?(?:news_?id|newsid|id|nid|detail_?id|item_?id)=[^'"]+)['"]/gi,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) add(match[1]);
    }
    return out;
}

function extractSurroundingContextHtml(html, startIndex, endIndex) {
    const source = String(html || "");
    const lower = source.toLowerCase();
    const start = Math.max(0, Number(startIndex) || 0);
    const end = Math.max(start, Number(endIndex) || start);
    const tags = ["tr", "li", "article", "section", "p", "div", "td"];

    for (const tag of tags) {
        const openToken = `<${tag}`;
        const closeToken = `</${tag}>`;
        const open = lower.lastIndexOf(openToken, start);
        const previousClose = lower.lastIndexOf(closeToken, start);
        if (open < 0 || open < previousClose) continue;
        const close = lower.indexOf(closeToken, end);
        if (close < 0) continue;
        const contextEnd = close + closeToken.length;
        if (contextEnd - open <= 8000) return source.slice(open, contextEnd);
    }

    // หน้าเว็บเก่าบางแห่งไม่มีโครงสร้าง HTML สมบูรณ์ จึงเก็บข้อความรอบลิงก์เป็น fallback
    const left = Math.max(
        lower.lastIndexOf("</tr>", start),
        lower.lastIndexOf("<br", start),
        lower.lastIndexOf("\n", start),
        start - 1200,
    );
    const nextTr = lower.indexOf("</tr>", end);
    const nextBr = lower.indexOf("<br", end);
    const nextLine = lower.indexOf("\n", end);
    const rights = [nextTr, nextBr, nextLine, end + 1200].filter((value) => value >= end);
    const right = Math.min(...rights);
    return source.slice(Math.max(0, left), Math.min(source.length, right));
}

function extractNavigationLinks(html, baseUrl) {
    const found = new Map();
    const add = (rawUrl, text = "", via = "href", contextText = "", sourceIndex = Number.MAX_SAFE_INTEGER) => {
        const href = resolveUrl(rawUrl, baseUrl);
        if (!href) return;
        const key = canonicalizeUrl(href);
        const cleanedText = cleanText(text);
        const rawContextHtml = String(contextText || "");
        const cleanedContextText = cleanText(rawContextHtml);
        const normalizedSourceIndex = Number.isFinite(Number(sourceIndex))
            ? Number(sourceIndex)
            : Number.MAX_SAFE_INTEGER;
        const current = found.get(key);
        if (current) {
            current.sourceIndex = Math.min(
                Number.isFinite(Number(current.sourceIndex)) ? Number(current.sourceIndex) : Number.MAX_SAFE_INTEGER,
                normalizedSourceIndex,
            );
            const currentText = String(current.text || "");
            const preferShortRecoveredText =
                cleanedText.length >= 4 &&
                /(?:href-loose|table-row)/i.test(via) &&
                currentText.length > cleanedText.length * 1.5;
            if (
                cleanedText.length > currentText.length ||
                (!currentText && cleanedText) ||
                preferShortRecoveredText
            ) {
                current.text = cleanedText;
            }
            if (cleanedContextText.length > String(current.contextText || "").length) {
                current.contextText = cleanedContextText;
                current.contextHtml = rawContextHtml;
            }
            if (!current.via.includes(via)) current.via += `+${via}`;
            return;
        }
        found.set(key, {
            href,
            text: cleanedText,
            contextText: cleanedContextText,
            contextHtml: rawContextHtml,
            via,
            sourceIndex: normalizedSourceIndex,
        });
    };

    let match;
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    while ((match = anchorRe.exec(html)) !== null) {
        const attrs = match[1];
        const hrefMatch = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
        if (hrefMatch) {
            const rawHref = hrefMatch[1] || hrefMatch[2] || hrefMatch[3];
            const contextHtml = extractSurroundingContextHtml(
                html,
                match.index,
                match.index + match[0].length,
            );
            if (/^javascript:/i.test(rawHref)) {
                for (const href of extractUrlsFromJavascript(rawHref, baseUrl)) {
                    add(href, match[2], "href-javascript", contextHtml, match.index);
                }
            } else {
                add(rawHref, match[2], "href", contextHtml, match.index);
            }
        }
    }

    // เว็บเก่าบางแห่งมี <a href> ที่ปิดแท็กไม่สมบูรณ์ โดยเฉพาะรายการแรกของตาราง
    // จึงอ่านเฉพาะ start tag เพิ่มอีกครั้ง และใช้ข้อความทั้งแถวเป็น context/title fallback
    const looseAnchorRe = /<a\b([^>]*)>/gi;
    while ((match = looseAnchorRe.exec(html)) !== null) {
        const attrs = match[1] || "";
        const hrefMatch = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
        if (!hrefMatch) continue;
        const rawHref = hrefMatch[1] || hrefMatch[2] || hrefMatch[3];
        const contextHtml = extractSurroundingContextHtml(
            html,
            match.index,
            match.index + match[0].length,
        );
        const textStart = match.index + match[0].length;
        const boundaries = ["</a>", "</td>", "</tr>", "<br"]
            .map((token) => html.toLowerCase().indexOf(token, textStart))
            .filter((index) => index >= textStart);
        const textEnd = boundaries.length
            ? Math.min(...boundaries)
            : Math.min(html.length, textStart + 1000);
        const directText = cleanText(html.slice(textStart, textEnd));
        const rowText = directText || cleanText(contextHtml);
        if (/^javascript:/i.test(rawHref)) {
            for (const href of extractUrlsFromJavascript(rawHref, baseUrl)) {
                add(href, rowText, "href-loose-javascript", contextHtml, match.index);
            }
        } else {
            add(rawHref, rowText, "href-loose", contextHtml, match.index);
        }
    }

    // สแกนทีละ <tr> เพื่อไม่ให้รายการแรกหายเมื่อ HTML ในแถวนั้นผิดรูป
    const tableRowRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
    while ((match = tableRowRe.exec(html)) !== null) {
        const rowHtml = match[0];
        const rowText = cleanText(rowHtml);
        const rowAnchorRe = /<a\b([^>]*)>/gi;
        let rowAnchor;
        while ((rowAnchor = rowAnchorRe.exec(rowHtml)) !== null) {
            const hrefMatch = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(rowAnchor[1] || "");
            if (!hrefMatch) continue;
            const rawHref = hrefMatch[1] || hrefMatch[2] || hrefMatch[3];
            const absoluteIndex = match.index + rowAnchor.index;
            if (/^javascript:/i.test(rawHref)) {
                for (const href of extractUrlsFromJavascript(rawHref, baseUrl)) {
                    add(href, rowText, "table-row-javascript", rowHtml, absoluteIndex);
                }
            } else {
                add(rawHref, rowText, "table-row", rowHtml, absoluteIndex);
            }
        }
    }

    const dataRe = /<[^>]+\b(data-href|data-url|data-link|data-target|data-detail-url)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
    while ((match = dataRe.exec(html)) !== null) {
        add(
            match[2] || match[3] || match[4],
            match[0],
            match[1].toLowerCase(),
            extractSurroundingContextHtml(html, match.index, match.index + match[0].length),
            match.index,
        );
    }

    const onclickRe = /<[^>]+\bonclick\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
    while ((match = onclickRe.exec(html)) !== null) {
        const js = htmlDecode(match[1] || match[2] || "");
        for (const href of extractUrlsFromJavascript(js, baseUrl)) {
            add(
                href,
                match[0],
                "onclick",
                extractSurroundingContextHtml(html, match.index, match.index + match[0].length),
                match.index,
            );
        }
    }

    // เว็บ PHP รุ่นเก่าบางแห่งฝัง URL ไว้ใน JavaScript โดยไม่มี <a href>
    for (const href of extractUrlsFromJavascript(html, baseUrl)) {
        add(href, "", "javascript-string", "", Number.MAX_SAFE_INTEGER);
    }

    // รองรับ meta refresh ที่ใช้เปลี่ยนหน้ารายการหรือหน้ารายละเอียด
    const refreshRe = /<meta\b[^>]*http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)[^>]*content\s*=\s*(?:"[^"]*url=([^";]+)"|'[^']*url=([^';]+)'|[^>]*url=([^\s>]+))[^>]*>/gi;
    while ((match = refreshRe.exec(html)) !== null) {
        add(match[1] || match[2] || match[3], "", "meta-refresh", match[0], match.index);
    }

    // รองรับ form แบบ GET ที่มี hidden input เช่น cat_id + page/pageid
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
    while ((match = formRe.exec(html)) !== null) {
        const attrs = match[1];
        const body = match[2];
        const methodMatch = /\bmethod\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
        const method = String((methodMatch && (methodMatch[1] || methodMatch[2] || methodMatch[3])) || "get").toLowerCase();
        if (method !== "get") continue;
        const actionMatch = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const action = (actionMatch && (actionMatch[1] || actionMatch[2] || actionMatch[3])) || baseUrl;
        let target;
        try {
            target = new URL(action || baseUrl, baseUrl);
        } catch {
            continue;
        }
        const inputRe = /<input\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
        let input;
        while ((input = inputRe.exec(body)) !== null) {
            const inputTag = input[0];
            const name = input[1] || input[2] || input[3];
            const valueMatch = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(inputTag);
            const value = valueMatch ? valueMatch[1] || valueMatch[2] || valueMatch[3] || "" : "";
            if (name && value) target.searchParams.set(name, htmlDecode(value));
        }
        add(target.toString(), "", "form-get", match[0], match.index);
    }

    return [...found.values()].sort((a, b) => Number(a.sourceIndex || 0) - Number(b.sourceIndex || 0));
}

function discoverPageLinks(html, pageUrl, startUrl, adapterProfile = {}) {
    const start = new URL(startUrl);
    const categoryConstraints = categoryConstraintsFromUrl(startUrl);
    const context = {
        startUrl,
        hostname: start.hostname,
        categoryConstraints,
        adapterProfile,
    };
    const detailMap = new Map();
    const listingMap = new Map();

    for (const link of extractNavigationLinks(html, pageUrl)) {
        const isDetail =
            isLikelyDetailUrl(link.href, context) ||
            isGenericSiblingDetailUrl(link.href, context, link.text);
        if (isDetail) {
            const key = canonicalizeUrl(link.href);
            const current = detailMap.get(key);
            if (!current || cleanText(link.text).length > cleanText(current.text).length) {
                detailMap.set(key, link);
            }
            continue;
        }
        if (isLikelyListingUrl(link.href, context)) {
            const withCategory = applyCategoryConstraints(link.href, categoryConstraints);
            const normalized = canonicalizeUrl(withCategory);
            listingMap.set(normalized, { ...link, href: normalized });
        }
    }

    return {
        details: [...detailMap.values()],
        listings: [...listingMap.values()],
        profile: detectParserProfile(startUrl),
    };
}

/** คีย์รวมหมวดเดียวกันที่เขียน URL ต่างกัน เช่น "?cat_id=1" กับ "?&cat_id=1&Page=2" */
function categoryDedupeKey(url) {
    try {
        const parsed = new URL(url);
        const parts = Object.entries(categoryConstraintsFromUrl(url))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`);
        return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.toLowerCase()}?${parts.join("&")}`;
    } catch {
        return String(url || "");
    }
}

/** เมนูหลายเว็บเป็นรูปภาพ จึงต้องดึงชื่อจาก alt/title ของแท็กภายในลิงก์ */
function anchorLabelMap(html, pageUrl) {
    const labels = new Map();
    const anchorRe = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRe.exec(String(html || ""))) !== null) {
        const href = resolveUrl(match[1] || match[2] || match[3], pageUrl);
        if (!href) continue;
        const inner = match[4] || "";
        const attr =
            /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(inner) ||
            /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(inner);
        const label = cleanText(attr ? attr[1] || attr[2] || "" : "").trim();
        if (!label) continue;
        const key = categoryDedupeKey(href);
        if (!labels.has(key) || label.length > labels.get(key).length) labels.set(key, label);
    }
    return labels;
}

/**
 * เมนู JavaScript รุ่นเก่า (เช่น stm_aix ของ Sothink) เก็บชื่อและลิงก์ไว้ในอาร์เรย์เดียวกัน
 * ตัวอย่าง: stm_aix("p4i0","p1i0",[0,"ข่าวประชาสัมพันธ์","","",-1,-1,0,"http://.../news.php?cat_id=1"],280,0)
 */
function javascriptMenuLabelMap(html, pageUrl) {
    const labels = new Map();
    const groupRe = /\[([^[\]]{0,800})\]/g;
    let group;
    while ((group = groupRe.exec(String(html || ""))) !== null) {
        const strings = [...group[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]);
        const urlIndex = strings.findIndex(
            (value) =>
                /^(?:https?:\/\/|\.{0,2}\/)/i.test(value) &&
                Object.keys(categoryConstraintsFromUrl(resolveUrl(value, pageUrl) || "")).length > 0,
        );
        if (urlIndex < 0) continue;

        const label = strings
            .slice(0, urlIndex)
            .map((value) => cleanText(value).trim())
            .filter((value) => value && !/^(?:https?:\/\/|\.{0,2}\/)/i.test(value) && !/^-?\d+$/.test(value))
            .pop();
        if (!label) continue;

        const href = resolveUrl(strings[urlIndex], pageUrl);
        if (!href) continue;
        const key = categoryDedupeKey(href);
        if (!labels.has(key) || label.length > labels.get(key).length) labels.set(key, label);
    }
    return labels;
}

/**
 * ดึงรายการ "หมวด" ทั้งหมดที่ปรากฏบนหน้าเว็บ (เมนู/sidebar ของเว็บหน่วยงาน)
 * นับเป็นหมวดเมื่อ URL มีพารามิเตอร์หมวด (cat_id, cid, type ฯลฯ) และไม่ใช่หน้ารายละเอียด/หน้าแบ่งหน้า
 * @returns {{ url: string, title: string }[]}
 */
function discoverCategoryLinks(html, pageUrl) {
    let host;
    try {
        host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return [];
    }

    const labels = anchorLabelMap(html, pageUrl);
    for (const [key, label] of javascriptMenuLabelMap(html, pageUrl)) {
        if (!labels.has(key) || label.length > labels.get(key).length) labels.set(key, label);
    }
    const found = new Map();
    for (const link of extractNavigationLinks(html, pageUrl)) {
        if (!isHttpUrl(link.href) || isAssetLikeUrl(link.href)) continue;
        if (!sameHostname(link.href, host)) continue;
        if (!Object.keys(categoryConstraintsFromUrl(link.href)).length) continue;
        if (detailIdFromUrl(link.href)) continue;
        if (hasPaginationSignal(link.href)) continue;

        const key = categoryDedupeKey(link.href);
        const title = (cleanText(link.text || "").replace(/\s+/g, " ").trim() || labels.get(key) || "").slice(0, 120);
        const current = found.get(key);
        if (!current || title.length > current.title.length) {
            found.set(key, { url: canonicalizeUrl(link.href), title });
        }
    }
    return [...found.values()];
}

function listingPageId(url) {
    const found = getParamCaseInsensitive(url, PAGINATION_PARAM_NAMES);
    if (found) {
        const number = Number(found.value);
        return Number.isFinite(number) ? number : found.value;
    }
    try {
        const match = /\/(?:page|paged)\/(\d+)\/?$/i.exec(new URL(url).pathname);
        return match ? Number(match[1]) : 1;
    } catch {
        return 1;
    }
}

function detectParserProfile(startUrl) {
    const parsed = new URL(startUrl);
    const constraints = categoryConstraintsFromUrl(startUrl);
    let mode = "path";
    if (Object.prototype.hasOwnProperty.call(constraints, "cat_id")) mode = "legacy-cat_id";
    else if (Object.prototype.hasOwnProperty.call(constraints, "cid")) mode = "modern-cid";
    else if (Object.keys(constraints).length) mode = "query-category";
    return {
        mode,
        adaptiveLegacyPath: /\.(?:php|aspx?)$/i.test(parsed.pathname),
        pathname: parsed.pathname,
        categoryConstraints: constraints,
        hostname: parsed.hostname,
    };
}

module.exports = {
    CATEGORY_PARAM_NAMES,
    PAGINATION_PARAM_NAMES,
    DETAIL_ID_PARAM_NAMES,
    applyCategoryConstraints,
    canonicalizeUrl,
    categoryConstraintsFromUrl,
    detailIdFromUrl,
    detailIdParamFromUrl,
    detectParserProfile,
    discoverCategoryLinks,
    discoverPageLinks,
    extractNavigationLinks,
    isGenericSiblingDetailUrl,
    isLikelyDetailUrl,
    isLikelyListingUrl,
    listingPageId,
};
