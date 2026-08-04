const path = require("path");
const { cleanText, htmlDecode } = require("../common");
const { extractNavigationLinks } = require("./url-parser");

const ACTIVITY_ID_PARAM_NAMES = [
    "salb_id",
    "album_id",
    "albumid",
    "album",
    "aid",
    "gallery_id",
    "galleryid",
    "gallery_no",
    "gid",
    "activity_id",
    "activityid",
    "act_id",
    "photo_id",
    "photoalbum_id",
    "item_id",
    "post_id",
    "record_id",
    "recordid",
    "rec_id",
    "data_id",
    "id",
    "slug",
];

const PAGINATION_PARAM_NAMES = ["pageid", "page", "paged", "p", "pg", "start", "offset"];
const TRACKING_PARAM_NAMES = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
];

const ASSET_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp|svg|pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|mp4|m4v|webm|mov|avi|mp3|m4a|wav|ogg)(?:$|[?#])/i;
const ACTIVITY_NAV_TEXT_RE = /^(?:หน้าแรก|หน้าหลัก|ย้อนกลับ|กลับ|ถัดไป|ก่อนหน้า|next|previous|home|เมนู|เข้าสู่ระบบ|ค้นหา|ทั้งหมด|ดูทั้งหมด|อ่านทั้งหมด|more|click here|[0-9]{1,4})$/i;
const ACTIVITY_ROUTE_NOISE_RE = /(?:^|\/)(?:index|home|main|contact|about|history|vision|mission|personnel|structure|login|search|sitemap|calendar|webboard|guestbook)(?:[-_.\/]|$)/i;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp)(?:$|[?#])/i;
const ACTIVITY_FILELIKE_RE = /(?:^|\/)(?:[ab]_[0-9]{4,8}_[0-9]{4,8}|dsc[0-9_ -]{3,}|img[0-9_ -]{3,}|image[0-9_ -]{3,}|photo[0-9_ -]{3,}|picture[0-9_ -]{3,})(?:\.(?:jpe?g|png|gif|webp|bmp))?(?:$|[?#])/i;
const TEMPLATE_ASSET_RE = /(?:^|\/)(?:bg[0-9_-]*|head[0-9_-]*|header[0-9_-]*|foot[0-9_-]*|footer[0-9_-]*|bt[0-9_-]*|btn[0-9_-]*|blank|close(?:label)?|name|tem(?:plate)?|vv[0-9_-]*|icon[0-9_-]*|logo[0-9_-]*|banner[0-9_-]*|spacer|pixel|loader|loading|arrow(?:left|right|up|down)?|next|prev|search|menu|nav)(?:\.(?:jpe?g|png|gif|webp|bmp))?(?:$|[?#])/i;
const RESERVED_GALLERY_SEGMENTS = new Set([
    "gallery",
    "galleries",
    "album",
    "albums",
    "activity",
    "activities",
    "photo",
    "photos",
    "view",
    "detail",
    "show",
    "index",
    "page",
    "paged",
]);

function normalizeHostname(hostname) {
    return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

function sameHostname(url, hostname) {
    try {
        return normalizeHostname(new URL(url).hostname) === normalizeHostname(hostname);
    } catch {
        return false;
    }
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

function getParamCaseInsensitive(url, names) {
    try {
        const parsed = new URL(url);
        const values = new Map();
        for (const [key, value] of parsed.searchParams.entries()) {
            const lower = key.toLowerCase();
            if (!values.has(lower)) values.set(lower, { key, value });
        }
        for (const name of names) {
            const found = values.get(String(name).toLowerCase());
            if (found && found.value !== "") return found;
        }
    } catch {
        // ignore malformed URL
    }
    return null;
}

function isAssetLikeUrl(url) {
    try {
        return ASSET_EXT_RE.test(new URL(url).pathname + new URL(url).search);
    } catch {
        return false;
    }
}

function normalizedPathname(url) {
    const pathname = new URL(url).pathname || "/";
    const normalized = pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    return normalized || "/";
}

function pathSegments(url) {
    return normalizedPathname(url)
        .split("/")
        .filter(Boolean)
        .map((value) => {
            try {
                return decodeURIComponent(value);
            } catch {
                return value;
            }
        });
}

function isUsableActivityToken(value) {
    const token = String(value || "").trim();
    if (!token) return false;
    const lower = token.toLowerCase();
    if (RESERVED_GALLERY_SEGMENTS.has(lower)) return false;
    if (/^(?:data|index|view|detail|show)(?:\.(?:php|html?|aspx?))?$/i.test(token)) return false;
    return /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,180}$/u.test(token);
}

function pathActivityToken(url, startUrl = null) {
    try {
        const segments = pathSegments(url);
        if (!segments.length) return null;

        const lower = segments.map((segment) => segment.toLowerCase());
        const last = segments[segments.length - 1];
        const lastLower = lower[lower.length - 1];

        if (startUrl) {
            const startSegments = pathSegments(startUrl);
            if (segments.length <= startSegments.length) return null;
        }

        // เว็บไซต์รุ่นใหม่บางแห่งใช้รูปแบบ:
        // /gallery/detail/22807/data.html
        // /gallery/view/activity-slug/index.html
        // ให้ใช้ segment หลัง detail/view/show เป็นรหัสกิจกรรม แทนชื่อไฟล์ data.html
        for (let index = 0; index < lower.length - 1; index += 1) {
            if (!["detail", "view", "show"].includes(lower[index])) continue;
            const candidate = segments[index + 1];
            if (isUsableActivityToken(candidate)) return candidate;
        }

        // รูปแบบ /gallery/22807/data.html หรือ /album/activity-slug/index.php
        if (/^(?:data|index|view|detail|show)\.(?:php|html?|aspx?)$/i.test(last)) {
            const parent = segments[segments.length - 2];
            if (isUsableActivityToken(parent)) return parent;
            return null;
        }

        if (/^(?:index|view|detail|show|gallery|album|activity|activities)(?:\.php)?$/i.test(last)) {
            return null;
        }
        if (/\.(?:php|html?|aspx?)$/i.test(last)) return null;
        if (RESERVED_GALLERY_SEGMENTS.has(lastLower)) return null;
        if (/^\d+$/.test(last) && lower[lower.length - 2] === "page") return null;

        if (isUsableActivityToken(last)) return last;
    } catch {
        // ignore malformed URL
    }
    return null;
}

function unknownActivityParam(url) {
    try {
        const parsed = new URL(url);
        const ignored = new Set([
            ...ACTIVITY_ID_PARAM_NAMES,
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
            "category",
            "cat",
            "cat_id",
            "cid",
        ].map((name) => name.toLowerCase()));
        for (const [key, value] of parsed.searchParams.entries()) {
            if (ignored.has(key.toLowerCase()) || !value) continue;
            if (/^[0-9]{1,18}$/.test(value) || /^[0-9a-f-]{8,128}$/i.test(value)) {
                return { key, value };
            }
        }
    } catch {
        // ignore malformed URL
    }
    return null;
}

function activityIdentityFromUrl(url, startUrl = null) {
    const known = getParamCaseInsensitive(url, ACTIVITY_ID_PARAM_NAMES);
    if (known) return known;

    const unknown = unknownActivityParam(url);
    if (unknown) return unknown;

    const token = pathActivityToken(url, startUrl);
    return token ? { key: "path", value: token } : null;
}

function isMeaningfulActivityLinkText(text) {
    const value = cleanText(text || "").replace(/\s+/g, " ").trim();
    if (value.length < 4 || value.length > 1200) return false;
    if (ACTIVITY_NAV_TEXT_RE.test(value)) return false;
    return (value.match(/[\p{L}\p{N}]/gu) || []).length >= 4;
}

function isGenericActivitySiblingDetailUrl(url, context = {}, linkText = "") {
    if (!isMeaningfulActivityLinkText(linkText) || isAssetLikeUrl(url)) return false;
    try {
        const startUrl = context.startUrl;
        if (!startUrl) return false;
        const start = new URL(startUrl);
        const parsed = new URL(url);
        if (!sameHostname(url, context.hostname || start.hostname)) return false;
        if (canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return false;
        if (hasPaginationSignal(url, startUrl)) return false;
        if (ACTIVITY_ROUTE_NOISE_RE.test(parsed.pathname)) return false;

        const startDir = start.pathname.endsWith("/")
            ? start.pathname
            : `${path.posix.dirname(start.pathname)}/`;
        const candidateDir = parsed.pathname.endsWith("/")
            ? parsed.pathname
            : `${path.posix.dirname(parsed.pathname)}/`;
        const sameDirectory = candidateDir.toLowerCase() === startDir.toLowerCase();
        const startPath = start.pathname.replace(/\/+$/, "");
        const nestedUnderStart = Boolean(startPath) && parsed.pathname.toLowerCase().startsWith(`${startPath.toLowerCase()}/`);
        if (!sameDirectory && !nestedUnderStart) return false;

        if (activityIdentityFromUrl(url, startUrl)) return true;
        if (/(?:^|\/)[^/]*(?:album|gallery|activity|photo|detail|view|show|data)[^/]*\.(?:php|html?|aspx?)(?:$|\?)/i.test(parsed.pathname)) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function activityIdFromUrl(url, startUrl = null) {
    const identity = activityIdentityFromUrl(url, startUrl);
    return identity ? identity.value : null;
}

function hasPaginationSignal(url, startUrl = null) {
    try {
        if (getParamCaseInsensitive(url, PAGINATION_PARAM_NAMES)) return true;
        if (/\/(?:page|paged)\/\d+\/?$/i.test(new URL(url).pathname)) return true;
        if (startUrl && canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return true;
    } catch {
        // ignore malformed URL
    }
    return false;
}

function isLegacyActivityDetail(url) {
    try {
        const pathname = normalizedPathname(url).toLowerCase();
        if (pathname.endsWith("/activities.php") && getParamCaseInsensitive(url, ["salb_id"])) return true;
        if (pathname.endsWith("/album/view.php") && getParamCaseInsensitive(url, ["album_id", "id"])) return true;
        if (pathname.endsWith("/albums/view.php") && getParamCaseInsensitive(url, ["album_id", "id"])) return true;
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

function isLikelyActivityDetailUrl(url, context = {}) {
    if (isAssetLikeUrl(url)) return false;
    try {
        const startUrl = context.startUrl;
        const start = startUrl ? new URL(startUrl) : null;
        const hostname = context.hostname || (start ? start.hostname : new URL(url).hostname);
        if (!sameHostname(url, hostname)) return false;
        if (startUrl && canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return false;
        const adapterProfile = context.adapterProfile || {};
        if (matchesAdapterPattern(url, adapterProfile.detailUrlPatterns)) return true;
        if (isLegacyActivityDetail(url)) return true;

        const candidatePath = normalizedPathname(url);
        const lowerPath = candidatePath.toLowerCase();
        if (/\/(?:gallery|galleries|album|albums|activity|activities)\/(?:view|detail|show)\//i.test(lowerPath)) {
            return Boolean(activityIdFromUrl(url, startUrl));
        }
        if (/\/(?:gallery|galleries|album|albums|activity|activities)\/(?:view|detail|show)(?:\.php)?$/i.test(lowerPath)) {
            return Boolean(activityIdFromUrl(url, startUrl));
        }

        if (startUrl) {
            const startPath = normalizedPathname(startUrl);
            const samePath = lowerPath === startPath.toLowerCase();
            const nestedPath = lowerPath.startsWith(`${startPath.toLowerCase()}/`);

            if (samePath && activityIdentityFromUrl(url, startUrl)) return true;
            if (nestedPath) {
                if (/\/(?:page|paged)\/\d+\/?$/i.test(lowerPath)) return false;
                return Boolean(pathActivityToken(url, startUrl));
            }
        }

        return false;
    } catch {
        return false;
    }
}

function isLikelyActivityListingUrl(url, context = {}) {
    if (isAssetLikeUrl(url)) return false;
    try {
        const startUrl = context.startUrl;
        if (!startUrl) return false;
        const start = new URL(startUrl);
        const hostname = context.hostname || start.hostname;
        if (!sameHostname(url, hostname)) return false;
        if (isLikelyActivityDetailUrl(url, context)) return false;

        const adapterProfile = context.adapterProfile || {};
        if (matchesAdapterPattern(url, adapterProfile.listingUrlPatterns) && hasPaginationSignal(url, startUrl)) {
            return true;
        }

        if (canonicalizeUrl(url) === canonicalizeUrl(startUrl)) return true;

        const candidatePath = normalizedPathname(url).toLowerCase();
        const startPath = normalizedPathname(startUrl).toLowerCase();
        const samePath = candidatePath === startPath;
        const pagePath = candidatePath.startsWith(`${startPath}/`) && /\/(?:page|paged)\/\d+\/?$/i.test(candidatePath);
        return (samePath || pagePath) && hasPaginationSignal(url, startUrl);
    } catch {
        return false;
    }
}


const ACTIVITY_TITLE_ACTION_RE = /(?:โครงการ|กิจกรรม|ประชุม|อบรม|ฝึกอบรม|ลงพื้นที่|ตรวจเยี่ยม|มอบ|เปิดงาน|แข่งขัน|รณรงค์|ประชาคม|บำเพ็ญ|ช่วยเหลือ|ต้อนรับ|ร่วมพิธี|จัดงาน|ดำเนินการ|ซ่อมแซม|ปลูก|ทำบุญ|เยี่ยม|แจก|ส่งเสริม|ป้องกัน|วันสำคัญ|งานประเพณี|ข่าวกิจกรรม|พิธี)/i;
const ACTIVITY_GENERIC_TITLE_RE = /^(?:ภาพกิจกรรม|กิจกรรม|อัลบั้ม(?:ภาพ)?|คลังภาพ|gallery|photo(?:s)?|activity|activities|รายละเอียดกิจกรรม|ดูรายละเอียด|อ่านเพิ่มเติม|more|view|show)$/i;
const ORGANIZATION_ONLY_RE = /^(?:(?:องค์การบริหารส่วนตำบล|เทศบาลตำบล|เทศบาลเมือง|เทศบาลนคร|อบต\.?|ทต\.?|สำนักงานเทศบาล)\s*[^|_]{2,180}(?:อำเภอ|เขต|จังหวัด)[^|_]{0,120})$/i;

function stripActivityTitleNoise(value) {
    return cleanText(String(value || ""))
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/^[\s:：\-–—|_]+|[\s:：\-–—|_]+$/g, "")
        .replace(/^\d{1,5}\s+(?=[ก-๙A-Za-z])/, "")
        .replace(/\s+\d{1,7}\s+\d{1,7}\s*$/, "")
        .replace(/^(?:อัลบั้มภาพ|ภาพกิจกรรม|หัวข้อกิจกรรม|ชื่อกิจกรรม|เรื่อง)\s*[:：\-]?\s*/i, "")
        .replace(/^กิจกรรม\s*[:：\-]\s*/i, "")
        .replace(/\[(?:อ่าน|เข้าชม|ผู้ชม|view|views|hits?)[^\]]*\]/gi, " ")
        .replace(/\((?:อ่าน|เข้าชม|ผู้ชม|view|views|hits?)[^)]*\)/gi, " ")
        .replace(/(?:อ่าน|เข้าชม|ผู้ชม|view|views|hits?)\s*[:：]?\s*[\d,]+\s*(?:คน|ครั้ง)?/gi, " ")
        .replace(/(?:จำนวน\s*)?[\d,]+\s*(?:รูป|ภาพ|ไฟล์)\b/gi, " ")
        .replace(/(?:ประกาศเมื่อ(?:วันที่)?|เผยแพร่เมื่อ|เมื่อ|วันที่)\s*[:：]?\s*\d{1,2}\s*(?:ม\.?ค\.?|ก\.?พ\.?|มี\.?ค\.?|เม\.?ย\.?|พ\.?ค\.?|มิ\.?ย\.?|ก\.?ค\.?|ส\.?ค\.?|ก\.?ย\.?|ต\.?ค\.?|พ\.?ย\.?|ธ\.?ค\.?|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)?\s*\d{2,4}/gi, " ")
        .replace(/\bhttps?:\/\/\S+/gi, " ")
        .replace(/\bwww\.[a-z0-9.-]+\b/gi, " ")
        .replace(/\b[a-z0-9.-]+\.go\.th\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function hostnameTokens(pageUrl) {
    try {
        const host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
        return host.split(".").filter((part) => part && !["go", "th", "com", "co", "org", "net"].includes(part));
    } catch {
        return [];
    }
}

function looksLikeSiteBoilerplateTitle(value, pageUrl = "") {
    const text = stripActivityTitleNoise(value);
    if (!text) return true;
    const lower = text.toLowerCase();
    if (/\bwww\.|\.go\.th\b|\.com\b|\.co\.th\b/i.test(String(value || ""))) return true;
    if (ACTIVITY_GENERIC_TITLE_RE.test(text)) return true;
    if (ORGANIZATION_ONLY_RE.test(text) && !ACTIVITY_TITLE_ACTION_RE.test(text)) return true;
    const tokens = hostnameTokens(pageUrl);
    if (tokens.some((token) => token.length >= 5 && lower.includes(token)) && !ACTIVITY_TITLE_ACTION_RE.test(text)) {
        return true;
    }
    if (/^(?:เทศบาล|องค์การบริหารส่วนตำบล|อบต\.?|สำนักงาน)\b/i.test(text) && /(?:จังหวัด|อำเภอ|เขต)/i.test(text) && !ACTIVITY_TITLE_ACTION_RE.test(text)) {
        return true;
    }
    return false;
}

function splitTitleCandidates(value) {
    const raw = String(value || "");
    const pieces = [raw];
    for (const piece of raw.split(/(?:__+|\s+[|｜]\s+|\s+[–—]\s+|\r?\n|\t)/)) {
        if (piece && piece !== raw) pieces.push(piece);
    }
    return pieces;
}

function scoreActivityTitle(value, { pageUrl = "", weight = 0 } = {}) {
    const text = stripActivityTitleNoise(value);
    if (!text || text.length < 4) return -10000;
    let score = Number(weight) || 0;
    const meaningful = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    score += Math.min(meaningful, 160);
    if (/[ก-๙]/.test(text)) score += 30;
    if (ACTIVITY_TITLE_ACTION_RE.test(text)) score += 55;
    if (looksLikeSiteBoilerplateTitle(value, pageUrl)) score -= 500;
    if (ACTIVITY_GENERIC_TITLE_RE.test(text)) score -= 400;
    if (/^activity[-_ ]?\d+$/i.test(text)) score -= 250;
    if (text.length > 350) score -= Math.min(180, text.length - 350);
    if (/(?:หน้าหลัก|หน้าแรก|เมนู|ติดต่อเรา|สงวนลิขสิทธิ์|copyright)/i.test(text)) score -= 120;
    return score;
}

function chooseBestActivityTitle(candidates, options = {}) {
    const items = [];
    for (const candidate of candidates || []) {
        const item = typeof candidate === "string" ? { value: candidate, weight: 0 } : candidate || {};
        for (const piece of splitTitleCandidates(item.value)) {
            const value = stripActivityTitleNoise(piece);
            const score = scoreActivityTitle(value, {
                pageUrl: options.pageUrl || "",
                weight: item.weight || 0,
            });
            if (score > -1000) items.push({ value, score });
        }
    }
    items.sort((a, b) => b.score - a.score || b.value.length - a.value.length);
    return items.length ? items[0] : { value: "", score: -10000 };
}

function extractActivityTitleCandidatesFromContext(contextHtml = "", contextText = "") {
    const candidates = [];
    const html = String(contextHtml || "");
    const add = (value, weight) => {
        if (value) candidates.push({ value, weight });
    };

    let match;
    const classTitleRe = /<([a-z0-9]+)\b[^>]*class\s*=\s*["'][^"']*(?:title|caption|subject|topic|album|activity|gallery|name)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
    while ((match = classTitleRe.exec(html)) !== null) add(match[2], 145);

    const headingRe = /<(h[1-6]|strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    while ((match = headingRe.exec(html)) !== null) add(match[2], 120);

    const imageRe = /<(?:img|input)\b([^>]*)>/gi;
    while ((match = imageRe.exec(html)) !== null) {
        const attrs = match[1];
        for (const name of ["alt", "title", "aria-label"]) {
            const attr = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "i").exec(attrs);
            if (attr) add(attr[1] || attr[2] || attr[3], 110);
        }
    }

    if (contextText) add(contextText, 35);
    if (html) add(html, 20);
    return candidates;
}

function chooseActivityListingTitle(link, activityId, startUrl) {
    const candidates = [
        { value: link.text || "", weight: 100 },
        ...extractActivityTitleCandidatesFromContext(link.contextHtml, link.contextText),
    ];
    const best = chooseBestActivityTitle(candidates, { pageUrl: startUrl });
    if (best.value) return best;
    return { value: `activity-${activityId}`, score: -500 };
}

function discoverActivityPageLinks(html, pageUrl, startUrl, adapterProfile = {}) {
    const start = new URL(startUrl);
    const context = { startUrl, hostname: start.hostname, adapterProfile };
    const detailMap = new Map();
    const listingMap = new Map();

    for (const link of extractNavigationLinks(html, pageUrl)) {
        if (
            isLikelyActivityDetailUrl(link.href, context) ||
            isGenericActivitySiblingDetailUrl(link.href, context, link.text)
        ) {
            const key = canonicalizeUrl(link.href);
            const activityId = activityIdFromUrl(link.href, startUrl) || key;
            const selectedTitle = chooseActivityListingTitle(link, activityId, startUrl);
            const title = selectedTitle.value || `activity-${activityId}`;
            const current = detailMap.get(key);
            if (
                !current ||
                Number(current.titleScore || -10000) < selectedTitle.score ||
                (Number(current.titleScore || -10000) === selectedTitle.score && current.title.length < title.length)
            ) {
                detailMap.set(key, {
                    href: link.href,
                    activityId,
                    title,
                    titleScore: selectedTitle.score,
                    via: link.via,
                    sourceIndex: Number.isFinite(Number(link.sourceIndex))
                        ? Number(link.sourceIndex)
                        : Number.MAX_SAFE_INTEGER,
                });
            }
            continue;
        }
        if (isLikelyActivityListingUrl(link.href, context)) {
            const key = canonicalizeUrl(link.href);
            listingMap.set(key, { ...link, href: key });
        }
    }

    return {
        details: [...detailMap.values()].sort(
            (a, b) => Number(a.sourceIndex || 0) - Number(b.sourceIndex || 0),
        ),
        listings: [...listingMap.values()],
        profile: detectActivityParserProfile(startUrl),
    };
}

function listingPageNo(url) {
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

function detectActivityParserProfile(startUrl) {
    const parsed = new URL(startUrl);
    const pathname = normalizedPathname(startUrl).toLowerCase();
    let mode = "generic-gallery";
    if (pathname.endsWith("/albums/index.php") || pathname.endsWith("/album/index.php")) mode = "legacy-album";
    else if (pathname.endsWith("/gallery") || pathname.includes("/gallery/")) mode = "modern-gallery";
    return {
        mode,
        pathname: parsed.pathname,
        hostname: parsed.hostname,
    };
}

function resolveUrl(raw, baseUrl) {
    const value = htmlDecode(String(raw || "").trim())
        .replace(/^['"]|['"]$/g, "")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");
    if (!value || /^(?:javascript:|mailto:|tel:|#|data:)/i.test(value)) return null;
    try {
        const parsed = new URL(value, baseUrl);
        return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
    } catch {
        return null;
    }
}


function isExcludedActivityImageUrl(url) {
    let pathname = "";
    let base = "";
    try {
        const parsed = new URL(url);
        pathname = decodeURIComponent(parsed.pathname || "").toLowerCase();
        base = path.basename(pathname);
    } catch {
        return false;
    }

    // ไฟล์ควบคุมของ lightbox/fancybox และไฟล์ตกแต่งหน้าเว็บ ไม่ใช่รูปกิจกรรม
    if (/^(?:closelabel|close|prevlabel|nextlabel|loading|loader|spinner|blank|spacer|pixel|transparent|arrowleft|arrowright|left|right|prev|next)(?:[-_.0-9a-z]*)\.(?:gif|png|jpe?g|webp|bmp)$/i.test(base)) {
        return true;
    }
    if (/^(?:bg|head|header|foot|footer|bt|btn|button|menu|nav|name|tem|template|vv|icon|logo|banner)[-_0-9a-z]*\.(?:gif|png|jpe?g|webp|bmp)$/i.test(base)) {
        return true;
    }
    if (/(?:^|\/)(?:includes?|assets?|scripts?|js|css|styles?)(?:\/[^/]+)*\/(?:lightbox|fancybox|colorbox|prettyphoto|photoswipe)(?:\/|$)/i.test(pathname)) {
        if (/(?:close|prev|next|loading|loader|blank|spacer|pixel|arrow|button|label)/i.test(base)) return true;
    }
    return false;
}

function isLikelyTemplateAsset(url, context = "") {
    let pathname = "";
    try {
        pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    } catch {
        return false;
    }
    const haystack = `${pathname} ${String(context || "").toLowerCase()}`;
    if (TEMPLATE_ASSET_RE.test(pathname)) return true;
    if (/(?:favicon|logo|logos|icon|icons|avatar|avatars|social|captcha|spinner|placeholder|no[-_]?image|default[-_]?image|facebook|youtube|line[-_]?icon|qr[-_]?code)/i.test(haystack)) {
        return true;
    }
    return false;
}

function galleryImageScore(url, context = "", via = "") {
    if (isExcludedActivityImageUrl(url)) return -999;
    let score = 0;
    let pathname = "";
    try {
        pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    } catch {
        return -999;
    }
    const haystack = `${pathname} ${String(context || "").toLowerCase()} ${String(via || "").toLowerCase()}`;
    const hasGalleryishPath = /\/(?:gallery|galleries|album|albums|photo|photos|activity|activities|media|uploads?|storage|tmp)\//i.test(pathname);
    const hasGalleryishContext = /(?:gallery|album|photo|lightbox|fancybox|glightbox|photoswipe|data-gallery)/i.test(haystack);
    const fileLikeActivityImage = ACTIVITY_FILELIKE_RE.test(pathname);
    const templateAsset = isLikelyTemplateAsset(url, context);

    if (templateAsset && !hasGalleryishPath && !hasGalleryishContext && !fileLikeActivityImage) score -= 260;
    if (hasGalleryishPath) score += 50;
    if (hasGalleryishContext) score += 45;
    if (fileLikeActivityImage) score += 65;
    if (/(?:original|large|full|zoom)/i.test(haystack)) score += 25;
    if (/(?:thumb|thumbnail|small|icon)/i.test(haystack)) score -= 15;
    if (via === "href") score += 20;
    if (IMAGE_EXT_RE.test(pathname)) score += 15;
    return score;
}

function extractGalleryImageUrls(html, activityUrl, activityId = "") {
    const candidates = new Map();
    const add = (raw, via, context = "") => {
        const url = resolveUrl(raw, activityUrl);
        if (!url) return;
        if (isExcludedActivityImageUrl(url)) return;
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return;
        }
        const pathname = parsed.pathname.toLowerCase();
        const hasImageExtension = IMAGE_EXT_RE.test(pathname + parsed.search);
        const galleryishPath = /\/(?:gallery|galleries|album|albums|photo|photos|activity|activities|media|uploads?|storage|tmp)\//i.test(pathname);
        const galleryishContext = /(?:gallery|album|photo|lightbox|fancybox|glightbox|photoswipe|data-gallery)/i.test(context);
        const fileLikeActivityImage = ACTIVITY_FILELIKE_RE.test(pathname);
        if (!hasImageExtension && !galleryishPath && !galleryishContext && !fileLikeActivityImage) return;
        if (isLikelyTemplateAsset(url, context) && !galleryishPath && !galleryishContext && !fileLikeActivityImage) return;
        if (!galleryishPath && !galleryishContext && !fileLikeActivityImage && via !== "href") return;

        const score = galleryImageScore(url, context, via);
        if (score < 25) return;
        const key = canonicalizeUrl(url);
        const current = candidates.get(key);
        if (!current || current.score < score) candidates.set(key, { url, score, via });
    };

    let match;
    const tagRe = /<(a|img|source|meta|picture|div|figure|li|button)\b([^>]*)>/gi;
    while ((match = tagRe.exec(html)) !== null) {
        const tag = match[1].toLowerCase();
        const attrs = match[2];
        const context = `${tag} ${attrs}`;
        const attrNames = tag === "a"
            ? ["href", "data-href", "data-url", "data-src", "data-original", "data-full", "data-image", "data-large"]
            : [
                  "src",
                  "href",
                  "data-src",
                  "data-original",
                  "data-original-src",
                  "data-lazy-src",
                  "data-full",
                  "data-image",
                  "data-large",
                  "data-url",
                  "data-href",
                  "content",
              ];
        for (const name of attrNames) {
            const attrRe = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "i");
            const attrMatch = attrRe.exec(attrs);
            if (attrMatch) add(attrMatch[1] || attrMatch[2] || attrMatch[3], name === "href" ? "href" : name, context);
        }

        const srcsetMatch = /\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
        if (srcsetMatch) {
            for (const item of String(srcsetMatch[1] || srcsetMatch[2]).split(",")) {
                const raw = item.trim().split(/\s+/)[0];
                if (raw) add(raw, "srcset", context);
            }
        }
    }

    const cssUrlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
    while ((match = cssUrlRe.exec(html)) !== null) add(match[2], "css-url", match[0]);

    const jsonImageRe = /["'](?:src|image|photo|full|original|large|url)["']\s*:\s*["']([^"']+)["']/gi;
    while ((match = jsonImageRe.exec(html)) !== null) add(match[1], "json", match[0]);

    const jsImageRe = /["']([^"']+\.(?:jpe?g|png|gif|webp|bmp)(?:\?[^"']*)?)["']/gi;
    while ((match = jsImageRe.exec(html)) !== null) add(match[1], "script", match[0]);

    // รูปแบบ legacy ที่มี marker เฉพาะอัลบั้ม
    if (activityId) {
        const marker = `/photoThumbnail/albums/a${activityId}_a/`.toLowerCase();
        for (const raw of [...candidates.values()]) {
            if (raw.url.toLowerCase().includes(marker) && !raw.url.toLowerCase().includes("/thumb/")) raw.score += 80;
        }
    }

    return [...candidates.values()]
        .sort((a, b) => b.score - a.score)
        .map((item) => item.url);
}

function extensionFromContentType(type) {
    const normalized = String(type || "").toLowerCase().split(";")[0].trim();
    const map = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
    };
    return map[normalized] || "";
}

function ensureImageExtension(fileName, detectedType) {
    const current = String(fileName || "image");
    if (/\.(?:jpe?g|png|gif|webp|bmp)$/i.test(current)) return current;
    const extension = extensionFromContentType(detectedType) || ".jpg";
    return `${current.replace(/[.\s]+$/g, "") || "image"}${extension}`;
}

function safeActivityFolderName(title, activityId) {
    const cleaned = String(title || "activity")
        .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, "_")
        .replace(/[.\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 90) || "activity";
    const id = String(activityId || "no-id")
        .replace(/[^\p{L}\p{N}_-]+/gu, "_")
        .slice(0, 40);
    return `${id}_${cleaned}`.slice(0, 130);
}

module.exports = {
    ACTIVITY_ID_PARAM_NAMES,
    activityIdFromUrl,
    canonicalizeUrl,
    chooseBestActivityTitle,
    detectActivityParserProfile,
    discoverActivityPageLinks,
    ensureImageExtension,
    extractGalleryImageUrls,
    isGenericActivitySiblingDetailUrl,
    isLikelyActivityDetailUrl,
    isLikelyActivityListingUrl,
    listingPageNo,
    looksLikeSiteBoilerplateTitle,
    safeActivityFolderName,
    scoreActivityTitle,
    stripActivityTitleNoise,
    isLikelyTemplateAsset,
    isExcludedActivityImageUrl,
};
