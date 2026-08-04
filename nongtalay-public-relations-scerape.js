// Scraper for "ข่าวประชาสัมพันธ์" on nongtalay.go.th.
//
// What this script does:
//   1. Visit http://www.nongtalay.go.th/news.php?cat_id=1 and pageid=2..35.
//   2. Visit every detail.php?id=... link found in those listing pages.
//   3. If pagination returns duplicate content, scan detail IDs and keep only
//      pages whose breadcrumb says cat_id=1.
//   4. Use the detail page title as a folder name.
//   5. Extract detail text and published date from each detail page.
//   6. Download every document link and news/photo image into that title folder,
//      preserving the original server file name.
//   7. Create nongtalay-pr-downloads/nongtalay_pr_import.sql for phpMyAdmin.
//   7. Optionally import the SQL into MySQL automatically when MYSQL_USER is set.
//
// Run with:  node nongtalay-public-relations-scerape.js
//
// Optional MySQL import:
//   set MYSQL_HOST=127.0.0.1
//   set MYSQL_PORT=3306
//   set MYSQL_USER=root
//   set MYSQL_PASSWORD=your_password
//   node nongtalay-public-relations-scerape.js
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const BASE_URL = "http://www.nongtalay.go.th/";
const CATEGORY_ID = 1;
const CATEGORY_NAME = "ข่าวประชาสัมพันธ์";
const EXPECTED_TOTAL = 691;
const FIRST_PAGE = `${BASE_URL}news.php?cat_id=${CATEGORY_ID}`;
const LAST_PAGE_ID = 35;
const LIST_PAGES = [
    FIRST_PAGE,
    ...Array.from({ length: LAST_PAGE_ID - 1 }, (_, i) => `${BASE_URL}news.php?pageid=${i + 2}&cat_id=${CATEGORY_ID}`),
];
const OUT_DIR = path.join(__dirname, "nongtalay-pr-downloads");
const SQL_FILE = path.join(OUT_DIR, "nongtalay_pr_import.sql");
const DB_NAME = process.env.MYSQL_DATABASE || "nongtalay_scerape";
const TABLE_NAME = "public_relations_files";
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
const SCAN_MAX_DETAIL_ID = Number(process.env.SCAN_MAX_DETAIL_ID || 0);
const UA = "Mozilla/5.0 (compatible; simple-node-scraper)";

function fetch(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith("https:") ? https : http;
        const req = client.get(
            url,
            {
                headers: {
                    "User-Agent": UA,
                    Accept: "*/*",
                    "Accept-Language": "th,en-US;q=0.8,en;q=0.7",
                },
            },
            (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (redirects <= 0) return reject(new Error("too many redirects"));
                    res.resume();
                    const next = new URL(res.headers.location, url).toString();
                    return resolve(fetch(next, redirects - 1));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
                }

                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers }));
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    });
}

function htmlDecode(value) {
    const named = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
    };
    return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
        if (entity[0] === "#") {
            const isHex = entity[1].toLowerCase() === "x";
            const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        }
        return named[entity.toLowerCase()] || _;
    });
}

function decodeBuffer(buffer, headers = {}) {
    const contentType = headers["content-type"] || "";
    const sample = buffer.slice(0, 4096).toString("latin1");
    const charsetMatch = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(`${contentType}\n${sample}`);
    const rawCharset = (charsetMatch && charsetMatch[1] ? charsetMatch[1] : "utf-8").toLowerCase();
    const charset = ["tis-620", "tis620", "windows-874", "cp874"].includes(rawCharset) ? "windows-874" : rawCharset;

    try {
        return new TextDecoder(charset).decode(buffer);
    } catch {
        return buffer.toString("utf8");
    }
}

function extractHrefs(html, baseUrl) {
    const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            out.add(new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString());
        } catch {
            // Skip invalid href values.
        }
    }
    return [...out];
}

function extractLinks(html, baseUrl) {
    const re = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
    const out = [];
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            out.push({
                href: new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString(),
                text: cleanText(m[4]),
            });
        } catch {
            // Skip invalid href values.
        }
    }
    return out;
}

function extractSrcs(html, baseUrl) {
    const re = /src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            out.add(new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString());
        } catch {
            // Skip invalid src values.
        }
    }
    return [...out];
}

function param(url, name) {
    try {
        return new URL(url).searchParams.get(name);
    } catch {
        return null;
    }
}

function safeName(s) {
    return (
        htmlDecode(String(s || ""))
            .replace(/<[^>]+>/g, " ")
            .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180) || "file"
    );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(html) {
    return htmlDecode(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isUsefulTitle(text) {
    if (!text || text.length < 5) return false;
    const lower = text.toLowerCase();
    return !["nongtalay.go.th", "องค์การบริหารส่วนตำบลหนองทะเล", "หน้าหลัก", "เมนู", "search", "login"].some((noise) =>
        lower.includes(noise.toLowerCase()),
    );
}

function extractDetailTitle(html, detailUrl) {
    const candidates = [];
    const patterns = [
        /<span[^>]+class\s*=\s*["'][^"']*title3[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
        /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi,
        /<[^>]+class\s*=\s*["'][^"']*(?:topic|subject|head|news)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
        /<strong[^>]*>([\s\S]*?)<\/strong>/gi,
        /<title[^>]*>([\s\S]*?)<\/title>/gi,
    ];

    for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
            const text = cleanText(m[1])
                .replace(/\s*[-|:]\s*องค์การบริหารส่วนตำบลหนองทะเล.*$/i, "")
                .trim();
            if (isUsefulTitle(text)) candidates.push(text);
        }
    }

    const title = candidates.find((text) => /[ก-๙]/.test(text)) || candidates[0];
    return title || `detail-${param(detailUrl, "id") || Date.now()}`;
}

function extractDetailContentHtml(html) {
    const titleMatch = /<span[^>]+class\s*=\s*["'][^"']*title3[^"']*["'][^>]*>[\s\S]*?<\/span>/i.exec(html);
    const detailArea = titleMatch ? html.slice(titleMatch.index + titleMatch[0].length) : html;
    const re = /<td\b[^>]*class\s*=\s*(?:"[^"]*\bstyles1\b[^"]*"|'[^']*\bstyles1\b[^']*')[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = re.exec(detailArea)) !== null) {
        const text = cleanText(m[1]);
        if (text && text !== "&nbsp;") return m[1].trim();
    }
    return "";
}

function normalizeHtmlFragment(html) {
    return String(html || "")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function extractPublishedText(html) {
    const m =
        /ประกาศเมื่อ\s*<span[^>]+class\s*=\s*(?:"[^"]*\bnews-s\b[^"]*"|'[^']*\bnews-s\b[^']*')[^>]*>([\s\S]*?)<\/span>/i.exec(
            html,
        );
    return m ? cleanText(m[1]) : "";
}

function normalizedUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return url;
    }
}

function isNongtalayUrl(url) {
    try {
        return new URL(url).hostname === "www.nongtalay.go.th";
    } catch {
        return false;
    }
}

function listingPageId(url) {
    const pageId = param(url, "pageid") || param(url, "Page");
    return pageId ? Number(pageId) : 1;
}

function extractNestedCategoryLinks(detailHtml, detailUrl) {
    return extractLinks(detailHtml, detailUrl)
        .filter((link) => {
            const catId = param(link.href, "cat_id");
            return isNongtalayUrl(link.href) && link.href.includes("news.php") && catId && Number(catId) !== CATEGORY_ID;
        })
        .map((link) => ({
            href: normalizedUrl(link.href),
            text: link.text,
            catId: param(link.href, "cat_id"),
        }))
        .filter((link, index, all) => all.findIndex((item) => item.href === link.href) === index);
}

function isTargetCategoryDetail(html) {
    const categoryRe = new RegExp(
        `<a\\b[^>]*href\\s*=\\s*["']?news\\.php\\?cat_id=${CATEGORY_ID}["']?[^>]*class\\s*=\\s*["'][^"']*styles5[^"']*["'][^>]*>`,
        "i",
    );
    return categoryRe.test(html);
}

function extractTotalCount(html) {
    const text = cleanText(html);
    const m = /ข้อมูลทั้งหมด\s*([0-9,]+)\s*รายการ/.exec(text);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
}

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function fileNameFromHeadersOrUrl(headers, fileUrl) {
    const cd = headers["content-disposition"];
    if (cd) {
        const utfMatch = /filename\*\s*=\s*UTF-8''([^;\n]+)/i.exec(cd);
        const plainMatch = /filename\s*=\s*"?([^";\n]+)"?/i.exec(cd);
        const rawName = utfMatch ? utfMatch[1] : plainMatch && plainMatch[1];
        if (rawName) {
            try {
                return safeName(decodeURIComponent(rawName));
            } catch {
                return safeName(rawName);
            }
        }
    }

    const url = new URL(fileUrl);
    const fromPath = path.basename(url.pathname);
    if (fromPath && fromPath !== "/" && fromPath !== ".") {
        try {
            return safeName(decodeURIComponent(fromPath));
        } catch {
            return safeName(fromPath);
        }
    }

    const id = url.searchParams.get("id") || url.searchParams.get("file") || Date.now();
    return `file-${safeName(id)}`;
}

function isDocumentUrl(url) {
    return url.includes("news/doc_download") || /\.(?:pdf|doc|docx|xls|xlsx|zip|rar)(?:[?#]|$)/i.test(url);
}

function isContentImageUrl(url) {
    try {
        const parsed = new URL(url);
        const fileName = path.basename(parsed.pathname).toLowerCase();
        return (
            fileName !== "download.gif"
            && /^\/news\//i.test(parsed.pathname)
            && /\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(url)
        );
    } catch {
        return false;
    }
}

function fileTypeFromUrl(url) {
    return isContentImageUrl(url) ? "image" : "document";
}

function sqlString(value) {
    if (value === null || value === undefined) return "NULL";
    return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function sqlIdentifier(value) {
    return `\`${String(value).replace(/`/g, "``")}\``;
}

function writeSql(rows) {
    const table = sqlIdentifier(TABLE_NAME);
    const lines = [
        `CREATE DATABASE IF NOT EXISTS ${sqlIdentifier(DB_NAME)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        `USE ${sqlIdentifier(DB_NAME)};`,
        "SET NAMES utf8mb4;",
        "SET CHARACTER SET utf8mb4;",
        "",
        `DROP TABLE IF EXISTS ${table};`,
        `CREATE TABLE ${table} (`,
        "  id INT AUTO_INCREMENT PRIMARY KEY,",
        "  page_id INT NULL,",
        "  listing_url TEXT NOT NULL,",
        "  detail_id VARCHAR(64) NULL,",
        "  detail_url TEXT NOT NULL,",
        "  title TEXT NOT NULL,",
        "  detail_text LONGTEXT NOT NULL,",
        "  detail_html LONGTEXT NULL,",
        "  published_text TEXT NULL,",
        "  folder_path TEXT NOT NULL,",
        "  file_type VARCHAR(32) NULL,",
        "  file_name VARCHAR(255) NULL,",
        "  file_url TEXT NULL,",
        "  local_path TEXT NULL,",
        "  file_size BIGINT NULL,",
        "  downloaded_at DATETIME NOT NULL",
        ") CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
        "",
    ];

    for (const row of rows) {
        lines.push(
            [
                `INSERT INTO ${table}`,
                "(page_id, listing_url, detail_id, detail_url, title, detail_text, detail_html, published_text, folder_path, file_type, file_name, file_url, local_path, file_size, downloaded_at)",
                "VALUES",
                `(${[
                    row.pageId === null || row.pageId === undefined ? "NULL" : Number(row.pageId),
                    sqlString(row.listingUrl),
                    sqlString(row.detailId),
                    sqlString(row.detailUrl),
                    sqlString(row.title),
                    sqlString(row.detailText),
                    sqlString(row.detailHtml),
                    sqlString(row.publishedText),
                    sqlString(row.folderPath),
                    sqlString(row.fileType),
                    sqlString(row.fileName),
                    sqlString(row.fileUrl),
                    sqlString(row.localPath),
                    row.fileSize === null || row.fileSize === undefined ? "NULL" : row.fileSize,
                    sqlString(row.downloadedAt),
                ].join(", ")});`,
            ].join(" "),
        );
    }

    fs.writeFileSync(SQL_FILE, `${lines.join("\n")}\n`, "utf8");
}

function importSqlIfConfigured() {
    if (!process.env.MYSQL_USER) {
        console.log(`SQL ready for phpMyAdmin import -> ${SQL_FILE}`);
        console.log("Set MYSQL_USER/MYSQL_PASSWORD if you want this script to import via mysql CLI automatically.");
        return;
    }

    const args = [
        "--default-character-set=utf8mb4",
        "-h",
        process.env.MYSQL_HOST || "127.0.0.1",
        "-P",
        process.env.MYSQL_PORT || "3306",
        "-u",
        process.env.MYSQL_USER,
    ];
    if (process.env.MYSQL_PASSWORD) args.push(`-p${process.env.MYSQL_PASSWORD}`);

    const result = spawnSync("mysql", args, {
        input: fs.readFileSync(SQL_FILE),
        stdio: ["pipe", "inherit", "inherit"],
    });

    if (result.error) {
        console.error(`MySQL import skipped: ${result.error.message}`);
        console.error(`You can import this file manually in phpMyAdmin: ${SQL_FILE}`);
        return;
    }
    if (result.status !== 0) {
        console.error(`MySQL import failed with exit code ${result.status}`);
        console.error(`You can import this file manually in phpMyAdmin: ${SQL_FILE}`);
        return;
    }
    console.log(`Imported SQL into MySQL database "${DB_NAME}" table "${TABLE_NAME}"`);
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const detailMap = new Map();
    const detailQueue = [];
    const queuedDetailUrls = new Set();
    const listingQueue = [];
    const queuedListingUrls = new Set();
    const visitedListingUrls = new Set();
    let expectedTotal = EXPECTED_TOTAL;
    let maxSeenDetailId = 0;

    function enqueueDetail(detailUrl, source) {
        const normalized = normalizedUrl(detailUrl);
        maxSeenDetailId = Math.max(maxSeenDetailId, Number(param(normalized, "id")) || 0);
        if (!detailMap.has(normalized)) {
            detailMap.set(normalized, source);
        } else {
            detailMap.set(normalized, {
                ...detailMap.get(normalized),
                ...source,
            });
        }
        if (!queuedDetailUrls.has(normalized)) {
            queuedDetailUrls.add(normalized);
            detailQueue.push(normalized);
        }
    }

    function enqueueListing(listingUrl) {
        const normalized = normalizedUrl(listingUrl);
        if (!isNongtalayUrl(normalized) || queuedListingUrls.has(normalized) || visitedListingUrls.has(normalized)) return;
        queuedListingUrls.add(normalized);
        listingQueue.push(normalized);
    }

    async function visitListingPage(newsUrl, nestedFrom = null) {
        if (visitedListingUrls.has(newsUrl)) return;
        visitedListingUrls.add(newsUrl);
        try {
            console.log(nestedFrom ? "[visit nested news]" : "[visit news]  ", newsUrl);
            const response = await fetch(newsUrl);
            const html = decodeBuffer(response.buffer, response.headers);
            expectedTotal = Math.max(expectedTotal, extractTotalCount(html));
            const pageId = listingPageId(newsUrl);
            const details = extractLinks(html, newsUrl).filter(
                (link) => link.href.includes("detail.php?") && param(link.href, "id"),
            );

            for (const detail of details) {
                enqueueDetail(detail.href, {
                    listingUrl: newsUrl,
                    pageId,
                    title: isUsefulTitle(detail.text) ? detail.text : "",
                    parentCategoryUrl: nestedFrom,
                });
            }

            const sameCategoryPages = extractHrefs(html, newsUrl).filter((href) => {
                if (!isNongtalayUrl(href)) return false;
                if (!href.includes("news.php")) return false;
                return param(href, "cat_id") === param(newsUrl, "cat_id") && listingPageId(href) !== pageId;
            });
            for (const listing of sameCategoryPages) enqueueListing(listing);
            await sleep(150);
        } catch (e) {
            console.error("  [news fail]", newsUrl, "-", e.message);
        }
    }

    for (const newsUrl of LIST_PAGES) {
        await visitListingPage(newsUrl);
    }
    console.log(`  -> ${detailMap.size} detail.php? links found`);

    if (expectedTotal && detailMap.size < expectedTotal) {
        const scanMax = SCAN_MAX_DETAIL_ID || maxSeenDetailId || 3000;
        console.log(
            `  -> listing pagination returned ${detailMap.size}/${expectedTotal}; scanning detail IDs 1..${scanMax}`,
        );
        const ids = Array.from({ length: scanMax }, (_, i) => i + 1);
        let scanned = 0;
        let matched = 0;

        await mapLimit(ids, SCAN_CONCURRENCY, async (id) => {
            const detailUrl = `${BASE_URL}detail.php?id=${id}`;
            try {
                const response = await fetch(detailUrl);
                const html = decodeBuffer(response.buffer, response.headers);
                scanned++;
                if (scanned % 100 === 0) {
                    console.log(`  [scan] ${scanned}/${scanMax} checked, ${matched} ${CATEGORY_NAME} details found`);
                }
                if (!isTargetCategoryDetail(html)) return;
                matched++;
                enqueueDetail(detailUrl, {
                    listingUrl: `${BASE_URL}news.php?cat_id=${CATEGORY_ID}`,
                    pageId: null,
                    title: extractDetailTitle(html, detailUrl),
                });
            } catch (e) {
                scanned++;
                if (scanned % 100 === 0) {
                    console.log(`  [scan] ${scanned}/${scanMax} checked, ${matched} ${CATEGORY_NAME} details found`);
                }
            }
        });

        console.log(`  -> ${detailMap.size} ${CATEGORY_NAME} detail.php? links found after scan`);
    }

    let dlCount = 0;
    const rows = [];
    for (let detailIndex = 0; detailIndex < detailQueue.length; detailIndex++) {
        const detailUrl = detailQueue[detailIndex];
        const source = detailMap.get(detailUrl);
        try {
            console.log("[visit detail]", detailUrl);
            const response = await fetch(detailUrl);
            const html = decodeBuffer(response.buffer, response.headers);
            const title = source.title || extractDetailTitle(html, detailUrl);
            const detailHtml = normalizeHtmlFragment(extractDetailContentHtml(html));
            const detailText = cleanText(detailHtml);
            const publishedText = extractPublishedText(html);
            const folderPath = path.join(OUT_DIR, safeName(title));
            fs.mkdirSync(folderPath, { recursive: true });

            const nestedCategories = extractNestedCategoryLinks(detailHtml, detailUrl);
            for (const nested of nestedCategories) {
                enqueueListing(nested.href);
                console.log(`  [nested category] ${nested.href} (${nested.text || nested.catId})`);
            }
            while (listingQueue.length) {
                const nestedListingUrl = listingQueue.shift();
                await visitListingPage(nestedListingUrl, detailUrl);
            }

            const detailId = param(detailUrl, "id") || "detail";
            const assets = [
                ...extractHrefs(html, detailUrl).filter((u) => isDocumentUrl(u) || isContentImageUrl(u)),
                ...extractSrcs(html, detailUrl).filter(isContentImageUrl),
            ].filter((url, index, all) => all.indexOf(url) === index);
            let savedFiles = 0;

            for (const doc of assets) {
                try {
                    const { buffer, headers } = await fetch(doc);
                    const fileName = fileNameFromHeadersOrUrl(headers, doc);
                    const target = path.join(folderPath, fileName);
                    fs.writeFileSync(target, buffer);
                    dlCount++;
                    savedFiles++;
                    rows.push({
                        pageId: source.pageId,
                        listingUrl: source.listingUrl,
                        detailId,
                        detailUrl,
                        title,
                        detailText,
                        detailHtml,
                        publishedText,
                        folderPath,
                        fileType: fileTypeFromUrl(doc),
                        fileName,
                        fileUrl: doc,
                        localPath: target,
                        fileSize: buffer.length,
                        downloadedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
                    });
                    console.log(`  saved -> ${target} (${buffer.length} bytes)`);
                    await sleep(150);
                } catch (e) {
                    console.error("  [asset fail]", doc, "-", e.message);
                }
            }

            if (!savedFiles) {
                rows.push({
                    pageId: source.pageId,
                    listingUrl: source.listingUrl,
                    detailId,
                    detailUrl,
                    title,
                    detailText,
                    detailHtml,
                    publishedText,
                    folderPath,
                    fileType: null,
                    fileName: null,
                    fileUrl: null,
                    localPath: null,
                    fileSize: null,
                    downloadedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
                });
            }
        } catch (e) {
            console.error("  [detail fail]", detailUrl, "-", e.message);
        }
    }

    writeSql(rows);
    importSqlIfConfigured();
    console.log(`Done. ${dlCount} files saved in ${OUT_DIR}`);
})().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
});
