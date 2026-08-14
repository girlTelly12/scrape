const { cleanText, extractLinks, fetchHtmlResult } = require("../common");
const { isHttpUrl } = require("../utils");
const { VENDOR_DEFINITIONS } = require("./definitions");

function normalizeRootUrl(value) {
    if (!isHttpUrl(value)) return "";
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.pathname = "/";
    parsed.search = "";
    return parsed.toString();
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function canonicalHostname(value) {
    try {
        return new URL(String(value || "").trim())
            .hostname
            .toLowerCase()
            .replace(/\.$/, "")
            .replace(/^www\./i, "");
    } catch {
        return "";
    }
}

function isSameWebsiteUrl(value, primaryUrl) {
    if (!isHttpUrl(value) || !isHttpUrl(primaryUrl)) return false;
    return canonicalHostname(value) === canonicalHostname(primaryUrl);
}

function getConfiguredUrls(config = {}) {
    return [
        config.siteUrl,
        config.procurementUrl,
        config.publicRelationsUrl,
        config.activityUrl,
        ...(Array.isArray(config.otherTopics) ? config.otherTopics.map((topic) => topic && topic.url) : []),
    ].filter(isHttpUrl);
}

function getPrimarySiteUrl(config = {}) {
    if (isHttpUrl(config.siteUrl)) return String(config.siteUrl).trim();
    return getConfiguredUrls(config)[0] || "";
}

function getInputScope(config = {}) {
    const primaryUrl = getPrimarySiteUrl(config);
    const configuredUrls = getConfiguredUrls(config);
    const acceptedUrls = primaryUrl
        ? configuredUrls.filter((url) => isSameWebsiteUrl(url, primaryUrl))
        : configuredUrls;
    const ignoredUrls = primaryUrl
        ? configuredUrls.filter((url) => !isSameWebsiteUrl(url, primaryUrl))
        : [];
    return {
        primaryUrl,
        primaryHostname: canonicalHostname(primaryUrl),
        acceptedUrls: unique(acceptedUrls),
        ignoredUrls: unique(ignoredUrls),
    };
}

function collectProbeUrls(config = {}) {
    const scope = getInputScope(config);
    const sourceUrls = scope.acceptedUrls;
    const roots = sourceUrls.map(normalizeRootUrl);
    return unique([...roots, ...sourceUrls]).slice(
        0,
        Math.max(1, Number(process.env.VENDOR_DETECTION_PROBE_LIMIT || 8)),
    );
}

function collectDocumentUrls(document) {
    const urls = [document.requestedUrl, document.finalUrl];
    const html = String(document.html || "");
    const attrRe = /\b(?:href|src|data-src|data-url|action)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    let match;
    while ((match = attrRe.exec(html)) !== null) {
        const raw = match[1] || match[2] || match[3];
        try {
            urls.push(new URL(raw, document.finalUrl || document.requestedUrl).toString());
        } catch {
            // ignore malformed URL
        }
    }
    return unique(urls);
}

function hostnameOf(value) {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return "";
    }
}

function matchRuleOnText(rule, text) {
    rule.re.lastIndex = 0;
    return rule.re.test(text);
}

function matchRuleOnUrl(rule, url) {
    rule.re.lastIndex = 0;
    return rule.re.test(url) || rule.re.test(hostnameOf(url));
}

function detectVendorFromDocuments(documents = [], options = {}) {
    const explicitVendorId = String(options.vendorId || "").trim().toLowerCase();
    const combinedText = documents
        .map((document) => `${document.html || ""}\n${cleanText(document.html || "")}`)
        .join("\n")
        .slice(0, 4_000_000);
    const allUrls = unique(documents.flatMap(collectDocumentUrls));

    const scored = VENDOR_DEFINITIONS.map((definition) => {
        let score = 0;
        const evidence = [];
        for (const rule of definition.textPatterns || []) {
            if (matchRuleOnText(rule, combinedText)) {
                score += rule.weight;
                evidence.push({ type: "text", label: rule.label, weight: rule.weight });
            }
        }
        for (const rule of definition.urlPatterns || []) {
            const matched = allUrls.find((url) => matchRuleOnUrl(rule, url));
            if (matched) {
                score += rule.weight;
                evidence.push({ type: "url", label: rule.label, value: matched, weight: rule.weight });
            }
        }
        if (explicitVendorId && explicitVendorId === definition.id) {
            score += 1000;
            evidence.unshift({ type: "manual", label: "ผู้ใช้เลือก Adapter นี้เอง", weight: 1000 });
        }
        return { definition, score, evidence };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0];
    const second = scored[1];
    const minimumScore = Number(options.minimumScore || 60);
    const isKnown = Boolean(top && top.score >= minimumScore);
    const definition = isKnown
        ? top.definition
        : {
              id: "generic",
              name: "Generic / ไม่ทราบผู้พัฒนา",
              aliases: [],
              defaultSections: { procurementUrl: "", publicRelationsUrl: "", activityUrl: "", otherTopics: [] },
          };
    const margin = top ? Math.max(0, top.score - (second ? second.score : 0)) : 0;
    const confidence = isKnown
        ? Math.max(35, Math.min(100, Math.round(45 + Math.min(35, top.score / 6) + Math.min(20, margin / 5))))
        : Math.min(34, Math.round((top ? top.score : 0) / 2));

    return {
        vendorId: definition.id,
        vendorName: definition.name,
        confidence,
        score: isKnown ? top.score : top ? top.score : 0,
        evidence: isKnown ? top.evidence : [],
        candidates: scored.map((item) => ({
            vendorId: item.definition.id,
            vendorName: item.definition.name,
            score: item.score,
        })),
        definition,
        allUrls,
    };
}

function sectionLinkScore(link, sectionKey) {
    const text = cleanText(link.text || "").toLowerCase();
    const url = String(link.href || "").toLowerCase();
    const haystack = `${text} ${url}`;
    const rules = {
        procurementUrl: [
            [/จัดซื้อ|จัดจ้าง|ประกวดราคา|ราคากลาง|ผลผู้ชนะ|procurement|procedure|e-?gp/i, 90],
            [/procedure\.php|procurement|bidding|purchase/i, 80],
        ],
        publicRelationsUrl: [
            [/ข่าวประชาสัมพันธ์|ประชาสัมพันธ์|ข่าวสาร|public\s*relations|information/i, 90],
            [/information\.php|news\.php.*cat_id=1/i, 70],
        ],
        activityUrl: [
            [/ภาพกิจกรรม|กิจกรรม|ประมวลภาพ|gallery|album|photo/i, 90],
            [/\/albums?\/index\.php|\/gallery\/?(?:$|\?)/i, 70],
        ],
    };
    let score = 0;
    for (const [re, weight] of rules[sectionKey] || []) if (re.test(haystack)) score += weight;
    if (/login|admin|contact|policy|facebook|youtube/i.test(haystack)) score -= 100;
    return score;
}

function bestSectionLinks(documents, primaryUrl = "") {
    const links = [];
    for (const document of documents) {
        try {
            links.push(...extractLinks(document.html || "", document.finalUrl || document.requestedUrl));
        } catch {
            // ignore malformed page
        }
    }
    const result = {};
    for (const sectionKey of ["procurementUrl", "publicRelationsUrl", "activityUrl"]) {
        const ranked = links
            .filter((link) => !primaryUrl || isSameWebsiteUrl(link.href, primaryUrl))
            .map((link) => ({ ...link, score: sectionLinkScore(link, sectionKey) }))
            .filter((link) => link.score > 0)
            .sort((a, b) => b.score - a.score);
        if (ranked[0]) result[sectionKey] = ranked[0].href;
    }
    return result;
}

function rootOriginFromConfig(config, documents = []) {
    const primaryUrl = getPrimarySiteUrl(config);

    // Prefer the final URL of the primary site so www/non-www redirects stay consistent.
    for (const document of documents) {
        const requested = document.requestedUrl || "";
        const finalUrl = document.finalUrl || requested;
        if (!isHttpUrl(finalUrl)) continue;
        if (primaryUrl && !isSameWebsiteUrl(requested || finalUrl, primaryUrl)) continue;
        try {
            return new URL(finalUrl).origin;
        } catch {
            // continue
        }
    }

    if (isHttpUrl(primaryUrl)) {
        try {
            return new URL(primaryUrl).origin;
        } catch {
            // continue
        }
    }
    return "";
}

function absoluteFromOrigin(origin, value) {
    if (!value || !origin) return "";
    try {
        return new URL(value, `${origin}/`).toString();
    } catch {
        return "";
    }
}

function createSuggestedConfig(config, detection, documents = []) {
    const inputScope = getInputScope(config);
    const primaryUrl = inputScope.primaryUrl;
    const discovered = bestSectionLinks(documents, primaryUrl);
    const origin = rootOriginFromConfig(config, documents);
    const defaults = detection.definition.defaultSections || {};
    const useDefaults = detection.vendorId !== "generic";

    const sameSiteConfiguredValue = (key) => {
        const value = String(config[key] || "").trim();
        if (!value) return "";
        if (!primaryUrl || isSameWebsiteUrl(value, primaryUrl)) return value;
        return "";
    };

    const choose = (key) =>
        String(
            sameSiteConfiguredValue(key) ||
                discovered[key] ||
                (useDefaults ? absoluteFromOrigin(origin, defaults[key]) : "") ||
                "",
        ).trim();

    const configuredOther = Array.isArray(config.otherTopics)
        ? config.otherTopics.filter(
              (topic) =>
                  topic &&
                  (topic.title || topic.url) &&
                  (!topic.url || !primaryUrl || isSameWebsiteUrl(topic.url, primaryUrl)),
          )
        : [];
    const defaultOther =
        useDefaults && origin
            ? (defaults.otherTopics || []).map((topic) => ({
                  title: topic.title,
                  url: absoluteFromOrigin(origin, topic.path || topic.url),
                  source: "vendor-default",
              }))
            : [];

    return {
        siteUrl: String(primaryUrl || (origin ? `${origin}/` : "")),
        procurementUrl: choose("procurementUrl"),
        publicRelationsUrl: choose("publicRelationsUrl"),
        activityUrl: choose("activityUrl"),
        otherTopics: configuredOther.length ? configuredOther : defaultOther,
    };
}

async function fetchProbeDocuments(config, logger, shouldStop = () => false) {
    const documents = [];
    for (const url of collectProbeUrls(config)) {
        if (shouldStop()) throw new Error("JOB_STOPPED_BY_USER");
        try {
            if (logger) logger(`ตรวจสอบผู้พัฒนาเว็บไซต์: ${url}`);
            const result = await fetchHtmlResult(url, logger, { shouldStop });
            documents.push({
                requestedUrl: url,
                finalUrl: result.finalUrl || url,
                statusCode: result.statusCode || 200,
                headers: result.headers || {},
                html: result.html || "",
            });
        } catch (error) {
            documents.push({
                requestedUrl: url,
                finalUrl: url,
                statusCode: error.statusCode || 0,
                html: "",
                error: error.message,
            });
            if (logger) logger(`ตรวจหน้าเพื่อหา Vendor ไม่สำเร็จ: ${url} - ${error.message}`);
        }
    }
    return documents;
}

async function detectWebsiteVendor(config = {}, options = {}) {
    const inputScope = getInputScope(config);
    if (options.logger && inputScope.ignoredUrls.length) {
        for (const url of inputScope.ignoredUrls) {
            options.logger(`ข้าม URL คนละเว็บไซต์ระหว่างตรวจ Vendor: ${url}`);
        }
    }

    const documents = options.documents || (await fetchProbeDocuments(config, options.logger, options.shouldStop));
    const detection = detectVendorFromDocuments(documents, {
        vendorId: options.vendorId || (config.vendorMode === "manual" ? config.vendorId : ""),
        minimumScore: Number(process.env.VENDOR_DETECTION_MIN_SCORE || 60),
    });
    return {
        ...detection,
        scope: {
            primaryUrl: inputScope.primaryUrl,
            primaryHostname: inputScope.primaryHostname,
            ignoredUrls: inputScope.ignoredUrls,
        },
        probes: documents.map((document) => ({
            requestedUrl: document.requestedUrl,
            finalUrl: document.finalUrl,
            statusCode: document.statusCode,
            error: document.error || null,
        })),
        suggestedConfig: createSuggestedConfig(config, detection, documents),
    };
}

module.exports = {
    canonicalHostname,
    collectProbeUrls,
    createSuggestedConfig,
    detectVendorFromDocuments,
    detectWebsiteVendor,
    getInputScope,
    getPrimarySiteUrl,
    isSameWebsiteUrl,
    normalizeRootUrl,
};
