const DEFAULT_SKIPPED_HOSTS = ["info.go.th"];

function splitSetting(value) {
    return String(value || "")
        .split(/[\r\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeHostname(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/:\d+$/, "")
        .replace(/^www\./, "")
        .replace(/^\.+|\.+$/g, "");
}

function configuredSkippedHosts() {
    const configured = splitSetting(
        process.env.SCRAPER_SKIP_HOSTS || process.env.SCRAPER_IGNORED_HOSTS,
    );
    const useDefaults = !["0", "false", "no", "off"].includes(
        String(process.env.SCRAPER_USE_DEFAULT_SKIP_HOSTS || "true").trim().toLowerCase(),
    );
    return new Set(
        [...(useDefaults ? DEFAULT_SKIPPED_HOSTS : []), ...configured]
            .map(normalizeHostname)
            .filter(Boolean),
    );
}

function configuredSkippedUrlFragments() {
    return splitSetting(
        process.env.SCRAPER_SKIP_URL_CONTAINS || process.env.SCRAPER_IGNORED_URL_PATTERNS,
    ).map((value) => value.toLowerCase());
}

function hostMatches(hostname, blockedHost) {
    const host = normalizeHostname(hostname);
    const blocked = normalizeHostname(blockedHost);
    if (!host || !blocked) return false;
    return host === blocked || host.endsWith(`.${blocked}`);
}

function getUrlSkipReason(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || ""));
    } catch {
        return null;
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
        return `ข้าม protocol ที่ไม่รองรับ: ${parsed.protocol}`;
    }

    const hostname = normalizeHostname(parsed.hostname);
    for (const blockedHost of configuredSkippedHosts()) {
        if (hostMatches(hostname, blockedHost)) {
            return `โดเมน ${blockedHost} อยู่ในรายการห้ามเปิด`;
        }
    }

    const normalizedUrl = parsed.toString().toLowerCase();
    for (const fragment of configuredSkippedUrlFragments()) {
        if (fragment && normalizedUrl.includes(fragment)) {
            return `URL ตรงกับข้อความที่กำหนดให้ข้าม: ${fragment}`;
        }
    }

    return null;
}

function shouldSkipUrl(rawUrl) {
    return Boolean(getUrlSkipReason(rawUrl));
}

function createSkippedUrlError(rawUrl, reason = getUrlSkipReason(rawUrl)) {
    const error = new Error(`URL_SKIPPED_BY_POLICY: ${reason || "URL ถูกตั้งค่าให้ข้าม"} — ${rawUrl}`);
    error.code = "URL_SKIPPED_BY_POLICY";
    error.url = rawUrl;
    error.skipReason = reason || "URL ถูกตั้งค่าให้ข้าม";
    return error;
}

module.exports = {
    DEFAULT_SKIPPED_HOSTS,
    configuredSkippedHosts,
    configuredSkippedUrlFragments,
    createSkippedUrlError,
    getUrlSkipReason,
    normalizeHostname,
    shouldSkipUrl,
};
