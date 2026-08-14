const fs = require("fs");
const path = require("path");
const express = require("express");
const { JobRunner, isScrapeAonangWebsiteName, toDatabaseName } = require("./src/job-runner");
const {
    deriveOtherTopicTableNameFromUrl,
    getDbConfig,
    normalizeAllScrapeDatabases,
    parseCustomTopicTableName,
} = require("./src/db");
const { AONANG_DATABASE_NAME } = require("./src/scrapers/aonang");
const { getDatabaseMode, probeDatabase } = require("./src/db-availability");
const { findBrowserExecutable } = require("./src/browser-client");

/** ชื่อฐานที่งานจะใช้จริง — ต้องรู้ก่อน เพราะลิมิตความยาวชื่อตารางขึ้นกับความยาวชื่อฐาน */
function resolveDatabaseName(websiteName, siteUrl) {
    const name = String(websiteName || "").trim() || deriveWebsiteNameFromUrl(String(siteUrl || "").trim());
    const outputName = isScrapeAonangWebsiteName(name) ? AONANG_DATABASE_NAME : toDatabaseName(name);
    return getDbConfig(outputName).database;
}
const { detectWebsiteVendor } = require("./src/vendors/detector");
const { listVendorAdapters } = require("./src/vendors/registry");
const { fetchHtml } = require("./src/common");
const { discoverCategoryLinks } = require("./src/scrapers/url-parser");

function loadEnvFile() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (!(key in process.env)) process.env[key] = value;
    }
}

function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function deriveWebsiteNameFromUrl(value) {
    try {
        const hostname = new URL(value).hostname.replace(/^www\./i, "");
        return hostname.split(".")[0].replace(/[^a-z0-9_-]+/gi, "_") || "website";
    } catch {
        return "";
    }
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

/**
 * แปลงข้อมูลหัวข้อเพิ่มเติมจากหน้าเว็บเป็นรายการที่พร้อมส่งให้ JobRunner
 * รองรับทั้งรูปแบบใหม่ otherTopics[] และรูปแบบเดิม otherTopicTitle/otherTopicUrl
 */
function normalizeOtherTopics(body, databaseName) {
    const rawTopics = Array.isArray(body.otherTopics)
        ? body.otherTopics.slice(0, 50)
        : [];

    // รองรับ Client รุ่นเดิมที่ส่งได้เพียงหัวข้อเดียว
    if (!rawTopics.length && (body.otherTopicTitle || body.otherTopicUrl)) {
        rawTopics.push({
            title: body.otherTopicTitle,
            url: body.otherTopicUrl,
        });
    }

    const normalized = [];
    const usedTableNames = new Set();

    rawTopics.forEach((rawTopic, index) => {
        const rowNumber = index + 1;
        const topic = rawTopic && typeof rawTopic === "object" ? rawTopic : {};
        let title = String(topic.title || topic.tableName || "").trim();
        const url = String(topic.url || "").trim();

        // แถวที่ไม่ได้กรอกอะไรเลยไม่ถือเป็นข้อผิดพลาด
        if (!title && !url) return;

        if (title && !url) {
            throw new Error(`หัวข้อเพิ่มเติมลำดับ ${rowNumber}: มีชื่อหัวข้อแล้วต้องกรอกลิงก์ด้วย`);
        }
        if (!isHttpUrl(url)) {
            throw new Error(`หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://`);
        }

        if (!title) {
            const derived = deriveOtherTopicTableNameFromUrl(url);
            if (!derived.ok) {
                throw new Error(`หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ${derived.message}`);
            }
            title = derived.tableName;
        }

        const parsed = parseCustomTopicTableName(title, { databaseName });
        if (!parsed.ok) {
            throw new Error(`หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ${parsed.message}`);
        }

        const duplicateKey = parsed.tableName.toLowerCase();
        if (usedTableNames.has(duplicateKey)) {
            throw new Error(
                `หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ชื่อตาราง "${parsed.tableName}" ซ้ำกับหัวข้อก่อนหน้า`,
            );
        }
        usedTableNames.add(duplicateKey);

        normalized.push({
            // ส่งชื่อที่ผู้ใช้พิมพ์ต่อไปด้วย ไม่งั้น topic_registry เก็บได้แค่ชื่อที่แปลงแล้ว
            title,
            tableName: parsed.tableName,
            url,
        });
    });

    return normalized;
}

loadEnvFile();

// มาตรฐาน schema: normalize ทุกฐาน scrape_* เมื่อ MySQL พร้อมใช้งาน
if (String(process.env.DATABASE_MODE || "auto").trim().toLowerCase() !== "disabled") {
    normalizeAllScrapeDatabases((msg) => console.log(`[schema] ${msg}`))
        .then((dbs) => console.log(`[schema] normalized databases: ${dbs.join(", ") || "(none)"}`))
        .catch((error) => {
            console.warn(`[schema] MySQL ยังไม่พร้อม: ${error.message}`);
            console.warn("[schema] Server ยังเปิดได้ และงานจะทำต่อแบบเก็บไฟล์อย่างเดียวเมื่อ DATABASE_MODE=auto");
        });
}

// ---- ตรวจสุขภาพระบบ สำหรับหน้าเว็บ (B1) ----

function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

async function checkMysqlHealth() {
    const mode = getDatabaseMode();
    if (mode === "disabled") {
        return {
            key: "mysql",
            label: "MySQL",
            ok: true,
            level: "ok",
            message: "ปิดใช้งานตาม DATABASE_MODE=disabled — งานจะเก็บไฟล์อย่างเดียว",
        };
    }
    try {
        const result = await withTimeout(
            probeDatabase("scraper_health"),
            5000,
            "ตรวจ MySQL ใช้เวลานานเกินไป",
        );
        return {
            key: "mysql",
            label: "MySQL",
            ok: true,
            level: "ok",
            message: `เชื่อมต่อได้ (${result.config.host}:${result.config.port})`,
        };
    } catch (error) {
        const required = mode === "required";
        return {
            key: "mysql",
            label: "MySQL",
            ok: false,
            level: required ? "error" : "warn",
            message: required
                ? `เชื่อมต่อ MySQL ไม่ได้ (โหมด required) — ระบบจะไม่เริ่มงาน: ${error.message}`
                : `เชื่อมต่อ MySQL ไม่ได้ — งานจะยังทำต่อแบบเก็บไฟล์อย่างเดียว: ${error.message}`,
            hint: "เปิด MySQL ใน XAMPP (หรือรัน start.bat) แล้วกดตรวจอีกครั้ง",
        };
    }
}

async function checkBrowserHealth() {
    const mode = String(process.env.BROWSER_MODE || "auto").trim().toLowerCase();
    const cdpUrl = (process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222").replace(/\/+$/, "");
    const executable = findBrowserExecutable();

    let cdpOk = false;
    if (mode !== "launch") {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2500);
            const response = await fetch(`${cdpUrl}/json/version`, { signal: controller.signal });
            clearTimeout(timer);
            cdpOk = response.ok;
        } catch {
            cdpOk = false;
        }
    }

    const modeLabels = { auto: "auto (ลอง CDP ก่อน แล้วเปิดเอง)", cdp: "cdp (ใช้ Chrome ที่เปิดไว้)", launch: "launch (เปิด Chrome เอง)" };
    if (mode === "cdp" && !cdpOk) {
        return {
            key: "browser",
            label: "Chrome",
            ok: false,
            level: "error",
            message: `เชื่อมต่อ Chrome ที่ ${cdpUrl} ไม่ได้ (โหมด ${mode})`,
            hint: "เปิด Chrome ด้วย --remote-debugging-port=9222 หรือรัน start.bat",
        };
    }
    if (!cdpOk && !executable) {
        return {
            key: "browser",
            label: "Chrome",
            ok: false,
            level: "warn",
            message: "ไม่พบ Chrome/CDP และไม่พบ Google Chrome, Edge หรือ Chromium ในเครื่อง",
            hint: "ติดตั้ง Chrome หรือกำหนด BROWSER_EXECUTABLE_PATH ใน .env — งานจะยังทำได้เฉพาะส่วนที่ตอบ HTTP ปกติ",
        };
    }
    const detail = cdpOk
        ? `เชื่อมต่อ CDP ได้ที่ ${cdpUrl}`
        : `ยังไม่เปิด CDP — ระบบจะเปิด Chrome เอง (${executable}) เมื่อจำเป็น`;
    return {
        key: "browser",
        label: "Chrome",
        ok: true,
        level: "ok",
        message: `${detail} (โหมด ${modeLabels[mode] || mode})`,
    };
}

function checkEnvHealth() {
    const envPath = path.join(__dirname, ".env");
    const hasEnvFile = fs.existsSync(envPath);
    const notes = [
        hasEnvFile ? "พบไฟล์ .env แล้ว" : "ยังไม่มีไฟล์ .env — คัดลอก .env.example ไปเป็น .env แล้วตั้งค่า",
        `DATABASE_MODE=${process.env.DATABASE_MODE || "auto"}`,
        `BROWSER_MODE=${process.env.BROWSER_MODE || "auto"}`,
        `SCRAPE_CONCURRENCY=${process.env.SCRAPE_CONCURRENCY || "1"}`,
    ];
    return {
        key: "env",
        label: "การตั้งค่า",
        ok: true,
        level: hasEnvFile ? "ok" : "warn",
        message: notes.join(" | "),
        hint: hasEnvFile ? "" : "โปรแกรมยังใช้ค่า default ได้ แต่ควรตั้งค่าให้ตรงกับเครื่องของคุณ",
    };
}

function checkDiskHealth() {
    try {
        if (typeof fs.statfsSync !== "function") {
            return {
                key: "disk",
                label: "พื้นที่ดิสก์",
                ok: true,
                level: "ok",
                message: "ตรวจไม่พบข้อมูลพื้นที่ว่าง (Node เวอร์ชันนี้ไม่รองรับ)",
            };
        }
        const downloadsDir = path.join(__dirname, "downloads");
        const target = fs.existsSync(downloadsDir) ? downloadsDir : __dirname;
        const stats = fs.statfsSync(target);
        const freeGb = (stats.bavail * stats.bsize) / 1e9;
        const totalGb = (stats.blocks * stats.bsize) / 1e9;
        const level = freeGb < 1 ? "error" : freeGb < 10 ? "warn" : "ok";
        return {
            key: "disk",
            label: "พื้นที่ดิสก์",
            ok: level !== "error",
            level,
            message: `เหลือ ${freeGb.toFixed(1)} GB จาก ${totalGb.toFixed(1)} GB`,
            hint: freeGb < 1 ? "พื้นที่เกือบเต็มแล้ว ควรลบไฟล์ในโฟลเดอร์ downloads ที่ไม่ใช้" : "",
        };
    } catch (error) {
        return {
            key: "disk",
            label: "พื้นที่ดิสก์",
            ok: true,
            level: "ok",
            message: `ตรวจพื้นที่ว่างไม่สำเร็จ: ${error.message}`,
        };
    }
}

const app = express();
const jobRunner = new JobRunner();
const port = Number(process.env.APP_PORT || 3000);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
    res.json(jobRunner.getStatus());
});

app.get("/api/health", async (req, res) => {
    try {
        const items = await Promise.all([checkMysqlHealth(), checkBrowserHealth()]);
        items.push(checkEnvHealth(), checkDiskHealth());
        res.json({
            ok: !items.some((item) => item.level === "error"),
            checkedAt: new Date().toISOString(),
            items,
            server: {
                running: jobRunner.getStatus().running,
                port,
            },
        });
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
});

app.get("/api/vendors", (req, res) => {
    res.json({ vendors: listVendorAdapters() });
});

app.post("/api/vendor/detect", async (req, res) => {
    try {
        const body = req.body || {};
        const config = {
            siteUrl: String(body.siteUrl || "").trim(),
            procurementUrl: String(body.procurementUrl || "").trim(),
            publicRelationsUrl: String(body.publicRelationsUrl || "").trim(),
            activityUrl: String(body.activityUrl || "").trim(),
            otherTopics: normalizeOtherTopics(body, resolveDatabaseName(body.websiteName, body.siteUrl)),
            vendorMode: String(body.vendorMode || "auto").trim().toLowerCase(),
            vendorId: String(body.vendorId || "").trim().toLowerCase(),
        };
        if (![config.siteUrl, config.procurementUrl, config.publicRelationsUrl, config.activityUrl, ...config.otherTopics.map((topic) => topic.url)].some(isHttpUrl)) {
            return res.status(400).json({ ok: false, message: "กรุณากรอก URL เว็บไซต์อย่างน้อย 1 รายการ" });
        }
        const detection = await detectWebsiteVendor(config, {
            vendorId: config.vendorMode === "manual" ? config.vendorId : "",
            logger: (message) => console.log(`[vendor-detect] ${message}`),
        });
        return res.json({ ok: true, ...detection });
    } catch (error) {
        return res.status(500).json({ ok: false, message: error.message });
    }
});

/** ค้นหาหมวดข่าวทั้งหมดจากเมนูของเว็บไซต์ เพื่อไม่ต้องกรอกหัวข้อทีละรายการ */
app.post("/api/topics/discover", async (req, res) => {
    try {
        const body = req.body || {};
        const pageUrl = String(body.pageUrl || body.siteUrl || "").trim();
        if (!isHttpUrl(pageUrl)) {
            return res.status(400).json({
                ok: false,
                message: "กรุณากรอกลิงก์เว็บไซต์ที่ขึ้นต้นด้วย http:// หรือ https://",
            });
        }
        // เมนูหมวดอยู่คนละหน้าแล้วแต่เว็บ บางแห่งอยู่หน้ารายการ บางแห่งอยู่ index.php เท่านั้น
        const origin = new URL(pageUrl).origin;
        const candidates = [pageUrl, `${origin}/index.php`, `${origin}/`].filter(
            (value, index, list) => list.indexOf(value) === index,
        );

        const merged = new Map();
        const scanned = [];
        let lastError = null;
        for (const candidate of candidates) {
            try {
                const html = await fetchHtml(candidate, (message) => console.log(`[topics] ${message}`), {});
                const found = discoverCategoryLinks(html, candidate);
                scanned.push({ url: candidate, found: found.length });
                for (const topic of found) {
                    const existing = merged.get(topic.url);
                    if (!existing || (topic.title || "").length > (existing.title || "").length) {
                        merged.set(topic.url, topic);
                    }
                }
                if (merged.size >= 3) break;
            } catch (error) {
                lastError = error;
                scanned.push({ url: candidate, error: error.message });
            }
        }

        if (!merged.size && lastError) {
            return res.status(502).json({ ok: false, message: lastError.message, scanned });
        }
        return res.json({ ok: true, pageUrl, scanned, topics: [...merged.values()] });
    } catch (error) {
        return res.status(502).json({ ok: false, message: error.message });
    }
});

app.get("/api/logs", (req, res) => {
    const since = Number(req.query.since || 0);
    res.json({
        logs: jobRunner.getLogs(since),
    });
});

app.get("/api/file-audit", (req, res) => {
    try {
        res.json(
            jobRunner.getFileAudit({
                status: req.query.status,
                search: req.query.search,
                offset: req.query.offset,
                limit: req.query.limit,
            }),
        );
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
});

app.get("/api/file-audit.csv", (req, res) => {
    const runId = jobRunner.getStatus().runId || "latest";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="file-audit-${runId}.csv"`,
    );
    res.send(jobRunner.getFileAuditCsv());
});

app.get("/api/file-audit.json", (req, res) => {
    const runId = jobRunner.getStatus().runId || "latest";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="file-audit-${runId}.json"`,
    );
    res.send(jobRunner.getFileAuditJson());
});

app.post("/api/start", async (req, res) => {
    try {
        const siteUrl = String(req.body.siteUrl || "").trim();
        const websiteName = String(req.body.websiteName || "").trim() || deriveWebsiteNameFromUrl(siteUrl);
        const procurementUrl = String(req.body.procurementUrl || "").trim();
        const publicRelationsUrl = String(req.body.publicRelationsUrl || "").trim();
        const activityUrl = String(req.body.activityUrl || "").trim();
        const lineNotifyToken = String(req.body.lineNotifyToken || "").trim();
        const lineMessage = String(req.body.lineMessage || "").trim();
        const otherTopics = normalizeOtherTopics(req.body || {}, resolveDatabaseName(websiteName, siteUrl));
        const vendorMode = String(req.body.vendorMode || "auto").trim().toLowerCase();
        const vendorId = String(req.body.vendorId || "").trim().toLowerCase();
        const autoFillSections = false;
        const fullSiteMigration = toBoolean(req.body.fullSiteMigration, false);
        const migrationMaxPages = Math.max(1, Math.min(50000, Number(req.body.migrationMaxPages || process.env.MIGRATION_MAX_PAGES || 1000)));
        const migrationMaxAssets = Math.max(1, Math.min(200000, Number(req.body.migrationMaxAssets || process.env.MIGRATION_MAX_ASSETS || 10000)));
        const migrationMaxDepth = Math.max(0, Math.min(100, Number(req.body.migrationMaxDepth || process.env.MIGRATION_MAX_DEPTH || 12)));
        const migrationMaxFileMb = Math.max(1, Math.min(4096, Number(req.body.migrationMaxFileMb || process.env.MIGRATION_MAX_FILE_MB || 500)));
        const migrationDelayMs = Math.max(0, Math.min(60000, Number(req.body.migrationDelayMs || process.env.MIGRATION_REQUEST_DELAY_MS || 700)));
        const includeExternalAssets = toBoolean(req.body.includeExternalAssets, true);
        const resumeMigration = toBoolean(req.body.resumeMigration, true);

        if (fullSiteMigration && !isHttpUrl(siteUrl)) {
            return res.status(400).json({ ok: false, message: "โหมดสำรวจทั้งเว็บไซต์ต้องกรอกเว็บไซต์หลักที่ขึ้นต้นด้วย http:// หรือ https://" });
        }

        if (!websiteName) {
            return res.status(400).json({
                ok: false,
                message: "กรุณากรอกชื่อเว็บไซต์",
            });
        }

        const needsSectionUrls = !isScrapeAonangWebsiteName(websiteName);
        if (
            needsSectionUrls &&
            !fullSiteMigration &&
            !procurementUrl &&
            !publicRelationsUrl &&
            !activityUrl &&
            !otherTopics.length
        ) {
            return res.status(400).json({
                ok: false,
                message: "กรุณากรอกลิงก์อย่างน้อย 1 หมวด ระบบจะไม่เติม URL ให้อัตโนมัติ",
            });
        }

        if (jobRunner.getStatus().running) {
            return res.status(409).json({
                ok: false,
                message: "มีงานกำลังทำอยู่แล้ว",
            });
        }

        // Fire-and-forget เพื่อไม่บล็อก response ของ API
        jobRunner
            .startJob({
                websiteName,
                siteUrl,
                vendorMode,
                vendorId,
                autoFillSections,
                fullSiteMigration,
                migrationMaxPages,
                migrationMaxAssets,
                migrationMaxDepth,
                migrationMaxFileMb,
                migrationDelayMs,
                includeExternalAssets,
                resumeMigration,
                procurementUrl,
                publicRelationsUrl,
                activityUrl,
                otherTopics,
                lineNotifyToken,
                lineMessage,
            })
            .catch(() => {
                // ข้อผิดพลาดถูกบันทึกใน log/status แล้ว
            });

        const acceptedStatus = jobRunner.getStatus();
        return res.status(202).json({
            ok: true,
            message: "Server รับงานแล้วและกำลังทำงานเบื้องหลัง",
            runId: acceptedStatus.runId || null,
            running: acceptedStatus.running,
        });
    } catch (error) {
        const statusCode = /หัวข้อเพิ่มเติม|กรุณากรอก|ลิงก์/.test(error.message) ? 400 : 500;
        return res.status(statusCode).json({
            ok: false,
            message: error.message,
        });
    }
});

app.post("/api/stop", (req, res) => {
    try {
        const result = jobRunner.stopJob();
        const code = result.ok ? 200 : 409;
        return res.status(code).json(result);
    } catch (error) {
        return res.status(500).json({
            ok: false,
            message: error.message,
        });
    }
});

app.listen(port, () => {
    console.log(`Multi-website scraper UI running on http://localhost:${port}`);
});
