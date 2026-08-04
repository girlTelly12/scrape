function normalizedHostname(hostname) {
    return String(hostname || "")
        .trim()
        .toLowerCase()
        .replace(/^www\./, "");
}

function sameSiteIgnoringWww(leftUrl, rightUrl) {
    try {
        const left = new URL(leftUrl);
        const right = new URL(rightUrl);
        return normalizedHostname(left.hostname) === normalizedHostname(right.hostname);
    } catch {
        return false;
    }
}

function alignUrlOriginToReferer(targetUrl, refererUrl) {
    if (!targetUrl || !refererUrl) return targetUrl;
    try {
        const target = new URL(targetUrl);
        const referer = new URL(refererUrl);
        if (!sameSiteIgnoringWww(target.toString(), referer.toString())) return target.toString();

        // รักษา pathname/search/hash ของไฟล์ แต่ใช้ protocol/host/port เดียวกับหน้าที่ Browser เปิดจริง
        target.protocol = referer.protocol;
        target.host = referer.host;
        return target.toString();
    } catch {
        return targetUrl;
    }
}

function isDifferentOrigin(leftUrl, rightUrl) {
    try {
        return new URL(leftUrl).origin !== new URL(rightUrl).origin;
    } catch {
        return false;
    }
}

module.exports = {
    alignUrlOriginToReferer,
    isDifferentOrigin,
    normalizedHostname,
    sameSiteIgnoringWww,
};
