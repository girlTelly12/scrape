// Helpers กลางที่ใช้หลายไฟล์ — ห้าม require ไฟล์อื่นในโปรเจกต์ (กัน circular dependency)

function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

module.exports = { isHttpUrl, toBoolean };
