const { cleanText, fetchHtml, sleep } = require("./common");
const { isHttpUrl } = require("./utils");

/** คำ/ชื่อเว็บที่บ่งบอกว่าเป็น "ชื่อเว็บไซต์" ไม่ใช่ชื่อหมวด */
function isSiteNameish(text, url) {
    const lower = String(text || "").toLowerCase();
    if (/^(?:หน้าแรก|หน้าหลัก|home|index|menu|เมนู)$/i.test(lower)) return true;
    if (/(?:อบต\.|เทศบาล|องค์การบริหารส่วนตำบล|องค์การบริหารส่วนจังหวัด|องค์การบริหารส่วนท้องถิ่น|www\.|\.go\.th)/i.test(lower)) {
        return true;
    }
    try {
        const host = new URL(url).hostname.replace(/^www\./i, "");
        const words = host.split(".").filter((part) => part.length >= 4);
        if (words.some((word) => lower.includes(word.toLowerCase()))) return true;
    } catch {
        // ignore malformed URL
    }
    return false;
}

/** h1/h2 แรกในหน้า — เว็บราชการส่วนใหญ่ใส่ชื่อหมวดไว้ที่หัวเนื้อหา */
function firstHeading(html, url) {
    const re = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
    const candidates = [];
    let match;
    while ((match = re.exec(String(html || ""))) !== null) {
        const text = cleanText(match[2]).replace(/\s+/g, " ").trim();
        if (!text || text.length < 3 || text.length > 200) continue;
        candidates.push(text);
    }
    return candidates.find((text) => !isSiteNameish(text, url)) || candidates[0] || "";
}

/** breadcrumb อันสุดท้าย — เช่น หน้าแรก » ข่าวประชาสัมพันธ์ */
function breadcrumbLast(html) {
    const source = String(html || "");
    const containerRe =
        /<(?:nav|div|ul|ol)\b[^>]*(?:class|id)=["'][^"']*(?:breadcrumb|bread-crumb|crumbs|bread_crumb|path)[^"']*["'][^>]*>([\s\S]*?)<\/(?:nav|div|ul|ol)>/i;
    const container = containerRe.exec(source);
    // เฉพาะเมื่อเจอ container breadcrumb จริง — ห้ามสแกนทั้งหน้าเพราะจะได้ข้อความเนื้อหา
    if (!container) return "";
    const scope = container[1];

    const links = [];
    const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkRe.exec(scope)) !== null) {
        const text = cleanText(linkMatch[1]).replace(/\s+/g, " ").trim();
        if (text) links.push(text);
    }
    for (let index = links.length - 1; index >= 0; index -= 1) {
        if (!/^(?:หน้าแรก|หน้าหลัก|home|index)$/i.test(links[index])) return links[index];
    }

    // breadcrumb แบบข้อความล้วน (คั่นด้วย » › >)
    const parts = cleanText(scope)
        .split(/\s*(?:»|›|>)\s*/)
        .map((part) => part.trim())
        .filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (!/^(?:หน้าแรก|หน้าหลัก|home|index)$/i.test(parts[index])) return parts[index];
    }
    return "";
}

/** <title> ตัดส่วนที่เป็นชื่อเว็บ/คำต่อท้ายออก แล้วเอาส่วนแรกที่ดูเป็นชื่อหมวด */
function titleTag(html, url) {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
    if (!match) return "";
    let title = cleanText(match[1]).replace(/\s+/g, " ").trim();

    // แยกเฉพาะตัวคั่นที่แทบไม่เจอในชื่อหมวดจริง (| » > · ::) — ขีด/ทวิภาคในภาษาไทย
    // มักเป็นส่วนหนึ่งของชื่อ เช่น "ข่าวจัดซื้อ - จัดจ้าง" จึงไม่แยกตรงนั้น
    const parts = title
        .split(/\s*(?:[|»>·]|::)\s*/)
        .map((part) => part.trim())
        .filter(Boolean);
    title = parts.find((part) => part.length >= 3 && !isSiteNameish(part, url)) || "";
    if (!title) return "";

    // ต่อท้ายอาจมีชื่อเว็บแบบ " - อบต.หงษ์เจริญ" หรือ ": เทศบาลตำบล..." ให้ตัดทิ้ง
    title = title
        .replace(/\s*[-:]\s*[^-:]{2,}$/, (suffix) =>
            isSiteNameish(suffix.replace(/^[-:]\s*/, ""), url) ? "" : suffix,
        )
        .trim();
    return title;
}

function ogTitle(html) {
    const source = String(html || "");
    const match =
        /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(source) ||
        /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(source);
    return match ? cleanText(match[1]).trim() : "";
}

/** ชื่อสำรองจาก path ของ URL เช่น /datacenter1/information.php -> information */
function fallbackFromUrl(pageUrl) {
    try {
        const pathname = new URL(pageUrl).pathname;
        const last = pathname.split("/").filter(Boolean).pop() || "";
        const name = decodeURIComponent(last)
            .replace(/\.[a-z0-9]+$/i, "")
            .replace(/[-_]+/g, " ")
            .trim();
        if (name && !/^(?:index|default|main|home)$/i.test(name)) return name.slice(0, 120);
    } catch {
        // ignore malformed URL
    }
    return "";
}

/**
 * ดึงชื่อหมวดจาก HTML ของหน้ารายการข่าว/ประกาศ
 * ลำดับ: h1/h2 -> breadcrumb -> <title> -> og:title -> path ของ URL
 * @returns {string} ชื่อที่พบ (อาจเป็น "" ถ้าหาไม่ได้)
 */
function extractPageTitle(html, pageUrl = "") {
    const candidates = [
        firstHeading(html, pageUrl),
        breadcrumbLast(html),
        titleTag(html, pageUrl),
        ogTitle(html),
        fallbackFromUrl(pageUrl),
    ];
    const found = candidates.find(
        (text) => text && text.length >= 3 && text.length <= 200 && !isSiteNameish(text, pageUrl),
    );
    return found ? found.slice(0, 120) : "";
}

/**
 * ดึงชื่อหมวดของ URL หลายรายการพร้อมกัน (จำกัด concurrency)
 * @returns {Promise<{url: string, title: string, ok: boolean, error?: string}[]>}
 */
async function resolvePageTitles(urls, logger, options = {}) {
    const shouldStop = options.shouldStop || (() => false);
    const concurrency = Math.max(1, Math.min(10, Number(options.concurrency || 4)));
    const delayMs = Math.max(0, Number(options.delayMs || 400));
    const fetchPage = options.fetchHtml || fetchHtml;
    const unique = [...new Set(urls.filter(isHttpUrl))];
    const results = [];
    let cursor = 0;

    const worker = async () => {
        while (cursor < unique.length) {
            const url = unique[cursor];
            cursor += 1;
            try {
                if (shouldStop()) throw new Error("JOB_STOPPED_BY_USER");
                const html = await fetchPage(url, logger, { shouldStop });
                const title = extractPageTitle(html, url);
                results.push({ url, title, ok: Boolean(title) });
            } catch (error) {
                if (String(error && error.message) === "JOB_STOPPED_BY_USER") throw error;
                results.push({ url, title: "", ok: false, error: String(error && error.message || error) });
            }
            if (delayMs > 0) await sleep(delayMs);
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, unique.length) }, worker);
    await Promise.all(workers);
    return results;
}

module.exports = {
    extractPageTitle,
    isSiteNameish,
    resolvePageTitles,
};
