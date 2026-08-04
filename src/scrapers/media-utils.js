const path = require("path");
const { cleanText, htmlDecode } = require("../common");
const { normalizeAssetUrl } = require("../file-audit");

const DIRECT_IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp|tiff?|svg)(?:$|[?#])/i;
const DIRECT_VIDEO_EXT_RE = /\.(?:mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8)(?:$|[?#])/i;
const DIRECT_AUDIO_EXT_RE = /\.(?:mp3|m4a|aac|wav|ogg|oga|flac|wma)(?:$|[?#])/i;
const DIRECT_DOCUMENT_EXT_RE = /\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z)(?:$|[?#])/i;

function resolveHttpUrl(raw, baseUrl) {
    const value = htmlDecode(String(raw || "").trim())
        .replace(/^['"]|['"]$/g, "")
        .replace(/\\\//g, "/")
        .replace(/&amp;/gi, "&");
    if (!value || /^(?:javascript:|mailto:|tel:|#|data:|blob:)/i.test(value)) return null;
    try {
        const url = new URL(value, baseUrl);
        return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
    } catch {
        return null;
    }
}

function providerFromUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
        if (host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) return "youtube";
        if (host === "vimeo.com" || host.endsWith("player.vimeo.com")) return "vimeo";
        if (host.endsWith("facebook.com") || host.endsWith("fb.watch")) return "facebook";
        if (host.endsWith("tiktok.com")) return "tiktok";
        if (host.endsWith("dailymotion.com") || host === "dai.ly") return "dailymotion";
        return null;
    } catch {
        return null;
    }
}

function classifyMediaUrl(url, hint = "") {
    const target = String(url || "").toLowerCase();
    const context = String(hint || "").toLowerCase();
    const combined = `${target} ${context}`;
    const provider = providerFromUrl(url);
    if (provider) return { mediaType: "video_embed", provider, downloadable: false };
    if (DIRECT_VIDEO_EXT_RE.test(target) || /\bvideo\//i.test(combined) || /(?:video|movie|clip|stream)/i.test(context)) {
        return { mediaType: "video", provider: null, downloadable: !/\.m3u8(?:$|[?#])/i.test(target) };
    }
    if (DIRECT_AUDIO_EXT_RE.test(target) || /\baudio\//i.test(combined)) {
        return { mediaType: "audio", provider: null, downloadable: true };
    }
    if (DIRECT_IMAGE_EXT_RE.test(target) || /\bimage\//i.test(combined)) {
        return { mediaType: "image", provider: null, downloadable: true };
    }
    if (DIRECT_DOCUMENT_EXT_RE.test(target) || /\bapplication\/(?:pdf|msword|zip)|spreadsheet|wordprocessingml/i.test(combined)) {
        return { mediaType: "document", provider: null, downloadable: true };
    }
    return { mediaType: "link", provider: null, downloadable: false };
}

function isMediaNoise(url, context = "") {
    const value = `${url || ""} ${context || ""}`.toLowerCase();
    return /(?:favicon|logo|icon|sprite|spacer|loading|spinner|captcha|analytics|pixel|tracking|social[-_]?icon|bootstrap|jquery)/i.test(value);
}

function extractMediaCandidates(html, baseUrl, options = {}) {
    const includeDocuments = options.includeDocuments !== false;
    const includeImages = options.includeImages !== false;
    const includeVideo = options.includeVideo !== false;
    const includeAudio = options.includeAudio !== false;
    const includeEmbeds = options.includeEmbeds !== false;
    const candidates = new Map();

    const add = (raw, via, context = "", linkText = "") => {
        const url = resolveHttpUrl(raw, baseUrl);
        if (!url || isMediaNoise(url, context)) return;
        const classification = classifyMediaUrl(url, `${via} ${context}`);
        if (classification.mediaType === "image" && !includeImages) return;
        if (classification.mediaType === "video" && !includeVideo) return;
        if (classification.mediaType === "audio" && !includeAudio) return;
        if (classification.mediaType === "document" && !includeDocuments) return;
        if (classification.mediaType === "video_embed" && !includeEmbeds) return;
        if (classification.mediaType === "link") return;

        const key = normalizeAssetUrl(url);
        const current = candidates.get(key);
        const next = {
            url,
            normalizedUrl: key,
            mediaType: classification.mediaType,
            provider: classification.provider,
            downloadable: classification.downloadable,
            discoveredVia: via,
            linkText: cleanText(linkText || context).slice(0, 1000),
        };
        if (!current) {
            candidates.set(key, next);
            return;
        }
        const vias = new Set(String(current.discoveredVia || "").split("+").filter(Boolean));
        vias.add(via);
        current.discoveredVia = [...vias].join("+");
        if (!current.linkText && next.linkText) current.linkText = next.linkText;
    };

    let match;
    const pairedTagRe = /<(a|video|audio|iframe|object)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    while ((match = pairedTagRe.exec(String(html || ""))) !== null) {
        const tag = match[1].toLowerCase();
        const attrs = match[2];
        const body = match[3];
        const context = `${tag} ${attrs}`;
        const names = tag === "object"
            ? ["data", "src", "data-src", "data-url"]
            : ["href", "src", "poster", "data-src", "data-url", "data-file", "data-video"];
        for (const name of names) {
            const attrRe = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "i");
            const attr = attrRe.exec(attrs);
            if (attr) add(attr[1] || attr[2] || attr[3], `${tag}-${name}`, context, body);
        }
    }

    const standaloneTagRe = /<(source|embed|img|iframe|video|audio|object)\b([^>]*)>/gi;
    while ((match = standaloneTagRe.exec(String(html || ""))) !== null) {
        const tag = match[1].toLowerCase();
        const attrs = match[2];
        const context = `${tag} ${attrs}`;
        for (const name of ["src", "href", "data", "poster", "data-src", "data-url", "data-file", "data-video", "data-original"]) {
            const attrRe = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, "i");
            const attr = attrRe.exec(attrs);
            if (attr) add(attr[1] || attr[2] || attr[3], `${tag}-${name}`, context);
        }
        const srcset = /\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
        if (srcset) {
            for (const item of String(srcset[1] || srcset[2]).split(",")) {
                const raw = item.trim().split(/\s+/)[0];
                if (raw) add(raw, `${tag}-srcset`, context);
            }
        }
    }

    const dataAttrRe = /\b(data-video|data-video-url|data-media|data-media-url|data-file|data-src|data-url|data-href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    while ((match = dataAttrRe.exec(String(html || ""))) !== null) {
        add(match[2] || match[3] || match[4], match[1].toLowerCase(), match[0]);
    }

    const cssUrlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
    while ((match = cssUrlRe.exec(String(html || ""))) !== null) add(match[2], "css-url", match[0]);

    const quotedMediaRe = /["']((?:https?:\/\/|\.{0,2}\/|\/)[^"']+\.(?:jpe?g|png|gif|webp|bmp|tiff?|svg|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac|pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z)(?:\?[^"']*)?)["']/gi;
    while ((match = quotedMediaRe.exec(String(html || ""))) !== null) add(match[1], "javascript-string", match[0]);

    const embedRe = /["']((?:https?:)?\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/(?:embed|watch)|youtu\.be\/|player\.vimeo\.com\/video\/|vimeo\.com\/|facebook\.com\/plugins\/video|fb\.watch\/|www\.tiktok\.com\/embed)[^"']*)["']/gi;
    while ((match = embedRe.exec(String(html || ""))) !== null) add(match[1], "embedded-player", match[0]);

    return [...candidates.values()];
}

function mediaFileName(url, fallback = "media") {
    try {
        const parsed = new URL(url);
        const raw = decodeURIComponent(path.basename(parsed.pathname || ""));
        return raw || fallback;
    } catch {
        return fallback;
    }
}

module.exports = {
    DIRECT_AUDIO_EXT_RE,
    DIRECT_DOCUMENT_EXT_RE,
    DIRECT_IMAGE_EXT_RE,
    DIRECT_VIDEO_EXT_RE,
    classifyMediaUrl,
    extractMediaCandidates,
    mediaFileName,
    providerFromUrl,
    resolveHttpUrl,
};
