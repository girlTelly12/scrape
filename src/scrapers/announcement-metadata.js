const fs = require("fs");
const path = require("path");
const { cleanText } = require("../common");

const THAI_MONTH_PATTERN = [
    "มกราคม", "ม\\.?\\s*ค\\.?", "มค",
    "กุมภาพันธ์", "ก\\.?\\s*พ\\.?", "กพ",
    "มีนาคม", "มี\\.?\\s*ค\\.?", "มีค",
    "เมษายน", "เม\\.?\\s*ย\\.?", "เมย",
    "พฤษภาคม", "พ\\.?\\s*ค\\.?", "พค",
    "มิถุนายน", "มิ\\.?\\s*ย\\.?", "มิย",
    "กรกฎาคม", "ก\\.?\\s*ค\\.?", "กค",
    "สิงหาคม", "ส\\.?\\s*ค\\.?", "สค",
    "กันยายน", "ก\\.?\\s*ย\\.?", "กย",
    "ตุลาคม", "ต\\.?\\s*ค\\.?", "ตค",
    "พฤศจิกายน", "พ\\.?\\s*ย\\.?", "พย",
    "ธันวาคม", "ธ\\.?\\s*ค\\.?", "ธค",
].join("|");

const DATE_VALUE_PATTERN = new RegExp(
    `(?:\\d{1,2}\\s*(?:${THAI_MONTH_PATTERN})\\s*\\d{2,4}|` +
        `\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}|` +
        `\\d{4}-\\d{1,2}-\\d{1,2})` +
        `(?:\\s*(?:เวลา\\s*)?\\d{1,2}[:.]\\d{2}(?::\\d{2})?\\s*(?:น\\.?|นาฬิกา)?)?`,
    "i",
);

function normalizeText(value) {
    return cleanText(String(value || ""))
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractPublishedRaw(value) {
    const text = normalizeText(value);
    if (!text) return "";

    const labels = [
        "ประกาศเมื่อ(?:วันที่)?",
        "ประกาศวันที่",
        "วันที่ประกาศ",
        "วันที่ลงข่าว",
        "วันที่สร้าง",
        "เผยแพร่(?:เมื่อ|วันที่)?",
        "ลงวันที่",
        "เมื่อ",
    ];

    for (const label of labels) {
        const re = new RegExp(`(?:${label})\\s*:?\\s*(${DATE_VALUE_PATTERN.source})`, "i");
        const match = re.exec(text);
        if (match && match[1]) return normalizeText(match[1]);
    }

    const fallback = DATE_VALUE_PATTERN.exec(text);
    return fallback && fallback[0] ? normalizeText(fallback[0]) : "";
}

function stripReadCount(value) {
    return String(value || "")
        .replace(/\[\s*อ่าน\s*[\d,]+\s*(?:คน|ครั้ง)?\s*\]/gi, " ")
        .replace(/\(\s*อ่าน\s*[\d,]+\s*(?:คน|ครั้ง)?\s*\)/gi, " ")
        .replace(/อ่าน\s*[\d,]+\s*(?:คน|ครั้ง)/gi, " ");
}

function cleanAnnouncementTitle(value) {
    let text = normalizeText(value);
    if (!text) return "";

    text = stripReadCount(text)
        .replace(/[💾📄📎🔗]+/gu, " ")
        .replace(/^(?:ข่าว|ประกาศ)\s*[:：-]?\s*(?=เรื่อง\s*:)/i, "")
        .replace(/^เรื่อง\s*[:：-]?\s*/i, "")
        .trim();

    const published = extractPublishedRaw(text);
    if (published) {
        const escaped = published.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text
            .replace(new RegExp(`(?:ประกาศเมื่อ(?:วันที่)?|ประกาศวันที่|วันที่ประกาศ|วันที่ลงข่าว|วันที่สร้าง|เผยแพร่(?:เมื่อ|วันที่)?|ลงวันที่|เมื่อ)\\s*:?\\s*${escaped}.*$`, "i"), " ")
            .replace(new RegExp(`${escaped}.*$`, "i"), " ");
    }

    return text
        .replace(/\s*[-–—|:]\s*$/, "")
        .replace(/^[•·▪▫►▶◆◇*-]+\s*/u, "")
        .replace(/\s+/g, " ")
        .trim();
}

function extractListingAnnouncementMetadata(contextText, anchorText = "") {
    const context = normalizeText(contextText);
    const anchor = normalizeText(anchorText);
    const publishedRaw = extractPublishedRaw(context) || extractPublishedRaw(anchor);

    let title = cleanAnnouncementTitle(anchor);
    if (!title || title.length < 4 || /^ดาวน์โหลด(?:เอกสาร)?$/i.test(title)) {
        title = cleanAnnouncementTitle(context);
    }

    return {
        title,
        publishedRaw,
        contextText: context,
    };
}

function buildAnnouncementText({
    sectionLabel,
    title,
    publishedRaw,
    listingUrl,
    detailUrl,
    detailText,
    scrapedAt,
}) {
    const lines = [
        `หัวข้อหลัก: ${normalizeText(sectionLabel) || "ข่าว/ประกาศ"}`,
        `เรื่อง: ${normalizeText(title) || "ไม่พบชื่อเรื่อง"}`,
        `ประกาศเมื่อ: ${normalizeText(publishedRaw) || "ไม่พบวันที่ประกาศ"}`,
        `ลิงก์หน้ารวม: ${String(listingUrl || "-").trim() || "-"}`,
        `ลิงก์รายละเอียด: ${String(detailUrl || "-").trim() || "-"}`,
        `เวลาที่ดึงข้อมูล: ${scrapedAt || new Date().toISOString()}`,
        "",
        "รายละเอียด:",
        normalizeText(detailText) || "ไม่พบข้อความรายละเอียดเพิ่มเติม",
        "",
    ];
    return lines.join("\r\n");
}

function writeAnnouncementTextFile(folderPath, metadata, fileName = "รายละเอียดประกาศ.txt") {
    fs.mkdirSync(folderPath, { recursive: true });
    const outputPath = path.join(folderPath, fileName);
    const content = buildAnnouncementText(metadata);
    // UTF-8 BOM ช่วยให้ Notepad/Excel รุ่นเก่าอ่านภาษาไทยได้ถูกต้อง
    fs.writeFileSync(outputPath, `\uFEFF${content}`, "utf8");
    return outputPath;
}

module.exports = {
    buildAnnouncementText,
    cleanAnnouncementTitle,
    extractListingAnnouncementMetadata,
    extractPublishedRaw,
    writeAnnouncementTextFile,
};
