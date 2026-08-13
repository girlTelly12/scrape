const {
    deriveOtherTopicTableNameFromUrl,
    ensureDynamicNewsTable,
    getDbConfig,
    initDatabase,
    insertActivityRows,
    insertActivityDetailRows,
    insertActivityMediaRows,
    insertFileAuditRows,
    insertAonangBidWinnerRows,
    insertAonangCouncilRows,
    insertAonangReferencePriceRows,
    insertNewsRows,
    insertProcurementRows,
    insertPublicRelationsRows,
    insertSiteVendorProfile,
    insertMigrationPageRows,
    insertMigrationAssetRows,
    parseCustomTopicTableName,
    recordTopicRegistry,
} = require("./db");
const { sendLineNotify } = require("./line-notify");
const { getVendorAdapter, resolveVendorAdapter } = require("./vendors/registry");
const { scrapeNewsCategory } = require("./scrapers/news-scraper");
const { scrapeWholePublicSite } = require("./scrapers/site-migration");
const { AONANG_DATABASE_NAME, AONANG_NEWS_SECTIONS } = require("./scrapers/aonang");
const { sleepWithStop } = require("./common");
const { getDatabaseMode, prepareDatabase } = require("./db-availability");
const { createFileStore } = require("./file-store");
const fs = require("fs");
const path = require("path");
const {
    createAuditRecord,
    flagDuplicateReferences,
    summarizeFileAudit,
    toCsv,
    writeAuditReports,
} = require("./file-audit");

const AONANG_INSERT_BY_KEY = {
    bidWinner: insertAonangBidWinnerRows,
    referencePrice: insertAonangReferencePriceRows,
    council: insertAonangCouncilRows,
};

function isScrapeAonangWebsiteName(websiteName) {
    const raw = String(websiteName || "").trim();
    if (raw === "อ่าวนาง") return true;
    const t = raw.toLowerCase().replace(/^scrape_/, "");
    return t === "aonang";
}

function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

const DEFAULT_STEP_DELAY_MS = 20 * 1000;
const MAX_STEP_DELAY_MS = 10 * 60 * 1000;
const STOP_ERROR = "JOB_STOPPED_BY_USER";

/**
 * เวลาหน่วงระหว่างแต่ละส่วนงาน ปรับได้ด้วย SECTION_DELAY_MS
 * ทุกส่วนมี delay ต่อ request อยู่แล้ว ค่านี้จึงเป็นเพียงช่วงพักก่อนเปลี่ยนส่วน
 * ตั้ง 0 เพื่อไม่หน่วงเลย
 */
function getStepDelayMs() {
    const text = String(process.env.SECTION_DELAY_MS ?? "").trim();
    // ค่าว่างถือว่ายังไม่ได้ตั้ง เพื่อไม่ให้กลายเป็น "ไม่หน่วงเลย" โดยไม่ตั้งใจ
    if (!text) return DEFAULT_STEP_DELAY_MS;
    const raw = Number(text);
    if (!Number.isFinite(raw)) return DEFAULT_STEP_DELAY_MS;
    return Math.max(0, Math.min(MAX_STEP_DELAY_MS, Math.floor(raw)));
}

function formatDelayText(ms) {
    if (ms >= 60000) return `${Math.round((ms / 60000) * 10) / 10} นาที`;
    return `${Math.round(ms / 1000)} วินาที`;
}

class JobRunner {
    constructor() {
        this.resetState();
    }

    resetState() {
        this.running = false;
        this.startedAt = null;
        this.finishedAt = null;
        this.currentStep = "idle";
        this.lastError = null;
        this.lastResult = null;
        this.websiteName = null;
        this.databaseName = null;
        this.outputName = null;
        this.logs = [];
        this.logIndex = 0;
        this.stopRequested = false;
        this.runId = null;
        this.vendorId = null;
        this.vendorName = null;
        this.vendorConfidence = null;
        this.vendorEvidence = [];
        this.vendorDetection = null;
        this.fileAuditRows = [];
        this.fileAuditReport = null;
        // เก็บระดับ instance ไม่ใช่ใน lastResult เพราะต้องให้เห็นระหว่างงานรันและตอนงานล้มด้วย
        this.truncatedTopics = [];
        // คิวส่วนงาน (หมวด) ใช้แสดงใน UI ว่าเหลืออีกกี่หมวด ตัวไหนกำลังทำอยู่
        // แต่ละรายการ: { key, label, state: "pending" | "running" | "done" | "failed" | "stopped" }
        this.sectionQueue = [];
        this.databaseEnabled = null;
        this.databaseMode = getDatabaseMode();
        this.databaseError = null;
    }

    log(message) {
        const entry = {
            index: this.logIndex++,
            time: new Date().toISOString(),
            message,
        };
        this.logs.push(entry);
        if (this.logs.length > 3000) this.logs = this.logs.slice(-2000);
    }

    getStatus() {
        return {
            running: this.running,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            currentStep: this.currentStep,
            lastError: this.lastError,
            lastResult: this.lastResult,
            websiteName: this.websiteName,
            databaseName: this.databaseName,
            outputName: this.outputName,
            databaseEnabled: this.databaseEnabled,
            databaseMode: this.databaseMode,
            databaseError: this.databaseError,
            stopRequested: this.stopRequested,
            runId: this.runId,
            vendorId: this.vendorId,
            vendorName: this.vendorName,
            vendorConfidence: this.vendorConfidence,
            vendorEvidence: this.vendorEvidence,
            fileAuditSummary: summarizeFileAudit(this.fileAuditRows),
            fileAuditRowsCount: this.fileAuditRows.length,
            fileAuditReportAvailable: Boolean(this.fileAuditReport),
            truncatedTopics: this.truncatedTopics,
            sectionQueue: this.sectionQueue,
        };
    }

    getLogs(since = 0) {
        return this.logs.filter((log) => log.index >= since);
    }

    addFileAuditRecord(record, metadata = {}) {
        const enriched = createAuditRecord({
            ...record,
            runId: this.runId,
            sectionKey: metadata.sectionKey || record.sectionKey,
            sectionLabel: metadata.sectionLabel || record.sectionLabel,
            tableName: metadata.tableName || record.tableName,
        });
        this.fileAuditRows.push(enriched);
        return enriched;
    }

    getFileAudit(options = {}) {
        const status = String(options.status || "").trim();
        const search = String(options.search || "").trim().toLowerCase();
        const offset = Math.max(0, Number(options.offset) || 0);
        const limit = Math.max(1, Math.min(5000, Number(options.limit) || 500));
        // ระบุแถวที่เป็นลิงก์ซ้ำไว้ล่วงหน้า ให้ตารางแสดงป้ายตรงกับตัวเลข summary
        let rows = flagDuplicateReferences(this.fileAuditRows);
        if (status && status !== "all") {
            rows = rows.filter((row) => {
                if (status === "duplicate") return row.isDuplicateReference;
                // กรองตามสถานะจริงเท่านั้น — แถวซ้ำถูกนับรวมอยู่ใน "ลิงก์ซ้ำ" แล้ว
                // ไม่ให้ปะปนมากับการกรองสถานะอื่น เพื่อให้ตารางตรงกับการ์ด summary
                return !row.isDuplicateReference && row.status === status;
            });
        }
        if (search) {
            rows = rows.filter((row) =>
                [row.fileName, row.fileUrl, row.title, row.detailUrl, row.errorMessage]
                    .filter(Boolean)
                    .some((value) => String(value).toLowerCase().includes(search)),
            );
        }
        return {
            runId: this.runId,
            summary: summarizeFileAudit(this.fileAuditRows),
            totalMatched: rows.length,
            offset,
            limit,
            rows: rows.slice(offset, offset + limit),
            reportAvailable: Boolean(this.fileAuditReport),
        };
    }

    getFileAuditCsv() {
        return toCsv(this.fileAuditRows);
    }

    getFileAuditJson() {
        return JSON.stringify(
            {
                runId: this.runId,
                generatedAt: new Date().toISOString(),
                summary: summarizeFileAudit(this.fileAuditRows),
                files: this.fileAuditRows,
            },
            null,
            2,
        );
    }

    async startJob(config) {
        if (this.running) throw new Error("มีงานกำลังทำอยู่แล้ว");

        this.resetState();
        this.running = true;
        this.stopRequested = false;
        this.runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
        this.startedAt = new Date().toISOString();
        this.currentStep = "initializing";
        this.websiteName = config.websiteName;
        this.outputName = isScrapeAonangWebsiteName(config.websiteName)
            ? AONANG_DATABASE_NAME
            : toDatabaseName(config.websiteName);
        this.databaseName = getDbConfig(this.outputName).database;
        this.log(`เริ่มงานดึงข้อมูลสำหรับเว็บไซต์: ${this.websiteName}`);
        this.log(`ฐานข้อมูลปลายทาง: ${this.databaseName}`);
        if (this.outputName !== this.databaseName) {
            this.log(`โฟลเดอร์ไฟล์แยกตามเว็บไซต์: ${this.outputName}`);
        }

        const logger = (message) => this.log(message);
        const shouldStop = () => this.stopRequested;
        const baseOutputDir = path.join(__dirname, "..", "downloads", this.outputName);
        const auditCallback = (sectionKey, sectionLabel, tableName = null) => (record) =>
            this.addFileAuditRecord(record, { sectionKey, sectionLabel, tableName });
        const assertNotStopped = () => {
            if (shouldStop()) throw new Error(STOP_ERROR);
        };

        // index ข้ามไฟล์ซ้ำต่อเว็บไซต์ (URL + SHA-256) ใช้ร่วมกันทุก section
        const fileStore = createFileStore({
            indexPath: path.join(baseOutputDir, "file-index.json"),
            logger,
        });
        this.log(
            `ข้ามไฟล์ซ้ำ: ${fileStore.skipExisting ? "เปิด" : "ปิด"} (SKIP_EXISTING_FILES)` +
                (fileStore.forceRefresh
                    ? " — FORCE_REFRESH=true: ดาวน์โหลดใหม่ทุกไฟล์ แต่ยังข้ามไฟล์เนื้อหาซ้ำด้วย SHA-256"
                    : ""),
        );

        let effectiveConfig = { ...config };
        let vendorAdapter = getVendorAdapter("generic");

        try {
            if (!isScrapeAonangWebsiteName(config.websiteName)) {
                this.currentStep = "detect-vendor";
                const resolved = await resolveVendorAdapter(config, {
                    logger,
                    shouldStop,
                    vendorId: config.vendorMode === "manual" ? config.vendorId : "",
                });
                vendorAdapter = resolved.adapter;
                effectiveConfig = resolved.config;
                this.vendorDetection = resolved.detection;
                this.vendorId = resolved.detection.vendorId;
                this.vendorName = resolved.detection.vendorName;
                this.vendorConfidence = resolved.detection.confidence;
                this.vendorEvidence = resolved.detection.evidence || [];
                this.log(
                    `ตรวจพบผู้พัฒนา: ${this.vendorName} ` +
                        `(adapter=${this.vendorId}, confidence=${this.vendorConfidence}%)`,
                );
                for (const evidence of this.vendorEvidence.slice(0, 8)) {
                    this.log(`หลักฐาน Vendor: ${evidence.label}${evidence.value ? ` — ${evidence.value}` : ""}`);
                }
                this.log(`เลือกโปรแกรมดึงข้อมูลเฉพาะค่าย: ${vendorAdapter.name}`);
                fs.mkdirSync(baseOutputDir, { recursive: true });
                fs.writeFileSync(
                    path.join(baseOutputDir, "vendor-detection.json"),
                    JSON.stringify(
                        {
                            runId: this.runId,
                            websiteName: this.websiteName,
                            vendorId: this.vendorId,
                            vendorName: this.vendorName,
                            confidence: this.vendorConfidence,
                            adapterId: vendorAdapter.id,
                            evidence: this.vendorEvidence,
                            probes: resolved.detection.probes || [],
                            suggestedConfig: resolved.detection.suggestedConfig || {},
                            detectedAt: new Date().toISOString(),
                        },
                        null,
                        2,
                    ),
                    "utf8",
                );
            } else {
                this.vendorId = "aonang-special";
                this.vendorName = "Aonang Special Adapter";
                this.vendorConfidence = 100;
            }

            this.currentStep = "prepare-database";
            const databaseState = await prepareDatabase(this.databaseName, logger);
            this.databaseMode = databaseState.mode;
            this.databaseEnabled = databaseState.enabled;
            this.databaseError = databaseState.message || null;

            if (this.databaseEnabled) {
                try {
                    await initDatabase(this.databaseName, logger);
                    this.log(`MySQL พร้อมใช้งาน: ${this.databaseName}`);
                } catch (error) {
                    if (this.databaseMode === "required") throw error;
                    this.databaseEnabled = false;
                    this.databaseError = error.message;
                    this.log(`MySQL เริ่มต้นฐานข้อมูลไม่สำเร็จ: ${error.message}`);
                    this.log("เปลี่ยนเป็นโหมดเก็บไฟล์อย่างเดียว งานดึงข้อมูลจะทำต่อโดยไม่หยุด");
                }
            } else {
                this.log(databaseState.message || "MySQL ไม่พร้อมใช้งาน");
                this.log("ทำงานต่อแบบเก็บไฟล์อย่างเดียว ข้อมูล HTML/TXT/PDF/รูป/วิดีโอจะยังถูกบันทึกใน downloads");
            }

            if (this.databaseEnabled && this.vendorDetection) {
                try {
                    await insertSiteVendorProfile(this.databaseName, {
                        runId: this.runId,
                        websiteName: this.websiteName,
                        siteUrl: effectiveConfig.siteUrl || effectiveConfig.procurementUrl || effectiveConfig.publicRelationsUrl || effectiveConfig.activityUrl || null,
                        vendorId: this.vendorId,
                        vendorName: this.vendorName,
                        adapterId: vendorAdapter.id,
                        confidence: this.vendorConfidence,
                        score: this.vendorDetection.score,
                        evidence: this.vendorEvidence,
                        probes: this.vendorDetection.probes || [],
                        suggestedConfig: this.vendorDetection.suggestedConfig || {},
                    });
                } catch (error) {
                    if (this.databaseMode === "required") throw error;
                    this.databaseEnabled = false;
                    this.databaseError = error.message;
                    this.log(`MySQL หลุดระหว่างบันทึกข้อมูล Vendor: ${error.message}`);
                    this.log("เปลี่ยนเป็นโหมดเก็บไฟล์อย่างเดียวและทำงานต่อ");
                }
            }
            assertNotStopped();

            const rawOtherTopics = Array.isArray(effectiveConfig.otherTopics)
                ? effectiveConfig.otherTopics
                : effectiveConfig.otherTopicTitle || effectiveConfig.otherTopicUrl
                  ? [{ title: effectiveConfig.otherTopicTitle, url: effectiveConfig.otherTopicUrl }]
                  : [];
            const customOtherTopics = [];
            const usedTableNames = new Set();

            for (let index = 0; index < rawOtherTopics.length; index += 1) {
                const rawTopic = rawOtherTopics[index] || {};
                const rowNumber = index + 1;
                const otherTopicUrl = String(rawTopic.url || "").trim();
                let otherTopicTitle = String(rawTopic.title || rawTopic.tableName || "").trim();
                // เก็บชื่อดิบไว้ลง topic_registry ก่อนที่ parseCustomTopicTableName จะตัด/แทนอักขระ
                const rawOtherTopicTitle = otherTopicTitle;

                if (!otherTopicTitle && !otherTopicUrl) continue;
                if (otherTopicTitle && !otherTopicUrl) {
                    throw new Error(`หัวข้อเพิ่มเติมลำดับ ${rowNumber}: มีชื่อหัวข้อแล้วต้องกรอกลิงก์ด้วย`);
                }
                if (!isHttpUrl(otherTopicUrl)) {
                    throw new Error(
                        `หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ลิงก์ต้องขึ้นต้นด้วย http:// หรือ https://`,
                    );
                }
                if (!otherTopicTitle) {
                    const derived = deriveOtherTopicTableNameFromUrl(otherTopicUrl);
                    if (!derived.ok) {
                        throw new Error(`หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ${derived.message}`);
                    }
                    otherTopicTitle = derived.tableName;
                }

                const parsedTopic = parseCustomTopicTableName(otherTopicTitle, {
                    databaseName: this.databaseName,
                });
                if (!parsedTopic.ok) {
                    throw new Error(`หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ${parsedTopic.message}`);
                }

                const duplicateKey = parsedTopic.tableName.toLowerCase();
                if (usedTableNames.has(duplicateKey)) {
                    throw new Error(
                        `หัวข้อเพิ่มเติมลำดับ ${rowNumber}: ชื่อตาราง "${parsedTopic.tableName}" ซ้ำกับหัวข้อก่อนหน้า`,
                    );
                }
                usedTableNames.add(duplicateKey);

                if (parsedTopic.truncated) {
                    this.log(
                        `หัวข้อลำดับ ${rowNumber}: ชื่อยาวเกินที่ MySQL สร้างไฟล์ตารางได้ ` +
                            `จึงย่อเป็น "${parsedTopic.tableName}" — ชื่อเต็มถูกเก็บไว้ใน topic_registry.full_title`,
                    );
                    this.truncatedTopics.push({
                        tableName: parsedTopic.tableName,
                        fullTitle: parsedTopic.cleanedTitle,
                    });
                }

                if (this.databaseEnabled) {
                    try {
                        await ensureDynamicNewsTable(this.databaseName, parsedTopic.tableName, logger);
                    } catch (error) {
                        if (this.databaseMode === "required") throw error;
                        this.databaseEnabled = false;
                        this.databaseError = error.message;
                        this.log(`MySQL สร้างตารางหัวข้อเพิ่มเติมไม่สำเร็จ: ${error.message}`);
                        this.log("เปลี่ยนเป็นโหมดเก็บไฟล์อย่างเดียวและทำงานต่อ");
                    }
                }
                assertNotStopped();
                customOtherTopics.push({
                    tableName: parsedTopic.tableName,
                    url: otherTopicUrl,
                    fullTitle: rawOtherTopicTitle || otherTopicTitle,
                    nameTruncated: Boolean(parsedTopic.truncated),
                });
            }

            const buildOtherSection = (topic, index) => {
                const outDir = path.join(baseOutputDir, "other_topic_files", topic.tableName);
                return {
                    key: `otherCustom_${index + 1}_${topic.tableName}`,
                    label: `อื่นๆ (${topic.tableName})`,
                    step: `scrape-other-custom-${index + 1}`,
                    url: topic.url,
                    tableNames: [topic.tableName],
                    fullTitle: topic.fullTitle,
                    nameTruncated: topic.nameTruncated,
                    run: () =>
                        vendorAdapter.scrapeNews("other", {
                            startUrl: topic.url,
                            sectionKey: `otherCustom_${index + 1}_${topic.tableName}`,
                            sectionLabel: `อื่นๆ (${topic.tableName})`,
                            outDir,
                            logger,
                            shouldStop,
                            fileStore,
                            onAuditRecord: auditCallback(
                                `otherCustom_${index + 1}_${topic.tableName}`,
                                `อื่นๆ (${topic.tableName})`,
                                topic.tableName,
                            ),
                        }),
                    save: (data) => insertNewsRows(this.databaseName, topic.tableName, data.rows),
                    summarize: (data) => ({
                        tableName: topic.tableName,
                        detailCount: data.detailCount,
                        fileCount: data.fileCount,
                        rowCount: data.rows.length,
                        detailsWithoutFiles: data.detailsWithoutFiles || 0,
                        fileAuditSummary: data.fileAuditSummary,
                    }),
                    logDone: (data) =>
                        `อื่นๆ (${topic.tableName}) เสร็จแล้ว: detail=${data.detailCount}, ` +
                        `files=${data.fileCount}, total=${data.fileAuditSummary?.uniqueFiles || 0}, ` +
                        `404=${data.fileAuditSummary?.notFound || 0}`,
                };
            };

            const otherSections = customOtherTopics.map(buildOtherSection);

            const migrationSection = effectiveConfig.fullSiteMigration && effectiveConfig.siteUrl
                ? {
                      key: "fullSiteMigration",
                      label: "สำรวจและย้ายข้อมูลสาธารณะทั้งเว็บไซต์",
                      tableNames: ["migration_pages", "migration_assets"],
                      step: "scrape-full-site-migration",
                      url: effectiveConfig.siteUrl,
                      run: () =>
                          scrapeWholePublicSite({
                              startUrl: effectiveConfig.siteUrl,
                              outDir: path.join(baseOutputDir, "full_site_migration"),
                              logger,
                              shouldStop,
                              runId: this.runId,
                              maxPages: effectiveConfig.migrationMaxPages,
                              maxAssets: effectiveConfig.migrationMaxAssets,
                              maxDepth: effectiveConfig.migrationMaxDepth,
                              maxFileMb: effectiveConfig.migrationMaxFileMb,
                              delayMs: effectiveConfig.migrationDelayMs,
                              includeExternalAssets: effectiveConfig.includeExternalAssets,
                              resume: effectiveConfig.resumeMigration,
                              fileStore,
                              onAuditRecord: auditCallback(
                                  "fullSiteMigration",
                                  "ย้ายข้อมูลทั้งเว็บไซต์",
                                  "migration_assets",
                              ),
                          }),
                      save: async (data) => {
                          await insertMigrationPageRows(this.databaseName, data.pageRows || []);
                          await insertMigrationAssetRows(this.databaseName, data.assetRows || []);
                      },
                      summarize: (data) => ({
                          ...data.summary,
                          manifestPath: data.manifestPath,
                          checkpointPath: data.checkpointPath,
                      }),
                      logDone: (data) =>
                          `สำรวจทั้งเว็บไซต์เสร็จแล้ว: pages=${data.summary?.pageCount || 0}, ` +
                          `pageFailed=${data.summary?.pageFailed || 0}, ` +
                          `assets=${data.summary?.assetCount || 0}, ` +
                          `assetFailed=${data.summary?.assetFailed || 0}`,
                  }
                : null;

            const sections = isScrapeAonangWebsiteName(config.websiteName)
                ? [
                      ...AONANG_NEWS_SECTIONS.map((s) => ({
                          key: s.key,
                          label: s.label,
                          tableNames: s.tableName ? [s.tableName] : [],
                          step: `scrape-aonang-${s.key}`,
                          url: s.url,
                          run: () =>
                              scrapeNewsCategory({
                                  startUrl: s.url,
                                  sectionKey: s.key,
                                  sectionLabel: s.label,
                                  outDir: path.join(baseOutputDir, s.outSubdir),
                                  logger,
                                  shouldStop,
                                  fileStore,
                                  onAuditRecord: auditCallback(s.key, s.label, s.tableName || null),
                              }),
                          save: (data) => AONANG_INSERT_BY_KEY[s.key](this.databaseName, data.rows),
                          summarize: (data) => ({
                              detailCount: data.detailCount,
                              fileCount: data.fileCount,
                              rowCount: data.rows.length,
                              detailsWithoutFiles: data.detailsWithoutFiles || 0,
                              fileAuditSummary: data.fileAuditSummary,
                          }),
                          logDone: (data) =>
                              `${s.label} เสร็จแล้ว: detail=${data.detailCount}, files=${data.fileCount}, ` +
                              `total=${data.fileAuditSummary?.uniqueFiles || 0}, 404=${data.fileAuditSummary?.notFound || 0}`,
                      })),
                      ...otherSections,
                  ]
                : [
                      migrationSection,
                      {
                          key: "procurement",
                          label: "จัดซื้อจัดจ้าง",
                          tableNames: ["procurement_files"],
                          step: "scrape-procurement",
                          url: effectiveConfig.procurementUrl,
                          run: () =>
                              vendorAdapter.scrapeNews("procurement", {
                                  startUrl: effectiveConfig.procurementUrl,
                                  sectionKey: "procurement",
                                  sectionLabel: "จัดซื้อจัดจ้าง",
                                  outDir: path.join(baseOutputDir, "procurement_files"),
                                  logger,
                                  shouldStop,
                                  fileStore,
                                  onAuditRecord: auditCallback("procurement", "จัดซื้อจัดจ้าง", "procurement_files"),
                              }),
                          save: (data) => insertProcurementRows(this.databaseName, data.rows),
                          summarize: (data) => ({
                              detailCount: data.detailCount,
                              fileCount: data.fileCount,
                              rowCount: data.rows.length,
                              detailsWithoutFiles: data.detailsWithoutFiles || 0,
                              fileAuditSummary: data.fileAuditSummary,
                          }),
                          logDone: (data) =>
                              `จัดซื้อจัดจ้างเสร็จแล้ว: detail=${data.detailCount}, files=${data.fileCount}, ` +
                              `total=${data.fileAuditSummary?.uniqueFiles || 0}, 404=${data.fileAuditSummary?.notFound || 0}`,
                      },
                      {
                          key: "publicRelations",
                          label: "ประชาสัมพันธ์",
                          tableNames: ["public_relations_files"],
                          step: "scrape-public-relations",
                          url: effectiveConfig.publicRelationsUrl,
                          run: () =>
                              vendorAdapter.scrapeNews("publicRelations", {
                                  startUrl: effectiveConfig.publicRelationsUrl,
                                  sectionKey: "publicRelations",
                                  sectionLabel: "ประชาสัมพันธ์",
                                  outDir: path.join(baseOutputDir, "public_relations_files"),
                                  logger,
                                  shouldStop,
                                  fileStore,
                                  onAuditRecord: auditCallback(
                                      "publicRelations",
                                      "ประชาสัมพันธ์",
                                      "public_relations_files",
                                  ),
                              }),
                          save: (data) => insertPublicRelationsRows(this.databaseName, data.rows),
                          summarize: (data) => ({
                              detailCount: data.detailCount,
                              fileCount: data.fileCount,
                              rowCount: data.rows.length,
                              detailsWithoutFiles: data.detailsWithoutFiles || 0,
                              fileAuditSummary: data.fileAuditSummary,
                          }),
                          logDone: (data) =>
                              `ประชาสัมพันธ์เสร็จแล้ว: detail=${data.detailCount}, files=${data.fileCount}, ` +
                              `total=${data.fileAuditSummary?.uniqueFiles || 0}, 404=${data.fileAuditSummary?.notFound || 0}`,
                      },
                      {
                          key: "activity",
                          label: "ภาพกิจกรรม",
                          tableNames: ["activity_pictures_file", "activity_details", "activity_media_files"],
                          step: "scrape-activity",
                          url: effectiveConfig.activityUrl,
                          run: () =>
                              vendorAdapter.scrapeActivity({
                                  startUrl: effectiveConfig.activityUrl,
                                  outDir: path.join(baseOutputDir, "activity_pictures_file"),
                                  logger,
                                  shouldStop,
                                  fileStore,
                                  onAuditRecord: auditCallback("activity", "ภาพกิจกรรม", "activity_pictures_file"),
                              }),
                          save: async (data) => {
                              await insertActivityRows(this.databaseName, data.rows);
                              await insertActivityDetailRows(this.databaseName, data.detailRows || []);
                              await insertActivityMediaRows(this.databaseName, data.mediaRows || []);
                          },
                          summarize: (data) => ({
                              activityCount: data.activityCount,
                              imageCount: data.imageCount,
                              mediaCount: data.mediaCount || 0,
                              detailRowCount: (data.detailRows || []).length,
                              rowCount: data.rows.length,
                              fileAuditSummary: data.fileAuditSummary,
                          }),
                          logDone: (data) =>
                              `ภาพกิจกรรมเสร็จแล้ว: activities=${data.activityCount}, images=${data.imageCount}, ` +
                              `media=${data.mediaCount || 0}, detailText=${(data.detailRows || []).length}, ` +
                              `404=${data.fileAuditSummary?.notFound || 0}`,
                      },
                  ]
                      .filter((section) => section && String(section.url || "").trim())
                      .concat(otherSections);

            if (!sections.length) {
                throw new Error("ไม่พบส่วนงานที่ต้องดึงข้อมูล");
            }

            this.log(`ส่วนที่เลือกดึงข้อมูล: ${sections.map((s) => s.label).join(", ")}`);

            // บันทึกแผนที่ ตาราง -> หัวข้อเต็ม + URL ไว้ก่อนเริ่มดึง
            // ถ้างานล้มกลางทางก็ยังตามได้ว่าตารางไหนมาจากลิงก์ไหน
            if (this.databaseEnabled) {
                const registryEntries = [];
                for (const section of sections) {
                    for (const tableName of section.tableNames || []) {
                        registryEntries.push({
                            tableName,
                            sectionKey: section.key,
                            fullTitle: section.fullTitle || section.label,
                            sectionLabel: section.label,
                            sourceUrl: section.url,
                            runId: this.runId,
                            nameTruncated: Boolean(section.nameTruncated),
                        });
                    }
                }
                try {
                    await recordTopicRegistry(this.databaseName, registryEntries);
                    this.log(`บันทึกแผนที่หัวข้อลง topic_registry: ${registryEntries.length} ตาราง`);
                } catch (error) {
                    if (this.databaseMode === "required") throw error;
                    this.log(`บันทึก topic_registry ไม่สำเร็จ: ${error.message}`);
                }
            }

            const stepDelayMs = getStepDelayMs();
            const stepWaitCount = Math.max(0, sections.length - 1);
            if (stepWaitCount === 0) {
                this.log("มีส่วนงานเดียว จึงไม่มีช่วงพักระหว่างส่วน");
            } else if (stepDelayMs > 0) {
                this.log(
                    `หน่วงเวลาระหว่างส่วน: ${formatDelayText(stepDelayMs)} × ${stepWaitCount} ครั้ง ` +
                        `(รวม ${formatDelayText(stepDelayMs * stepWaitCount)} — ปรับได้ที่ SECTION_DELAY_MS ใน .env)`,
                );
            } else {
                this.log("ไม่หน่วงเวลาระหว่างส่วน (SECTION_DELAY_MS=0)");
            }

            const sectionResults = {};
            this.sectionQueue = sections.map((section) => ({
                key: section.key,
                label: section.label,
                state: "pending",
            }));
            this.log(`คิวส่วนงานทั้งหมด: ${sections.length} ส่วน`);
            for (let i = 0; i < sections.length; i += 1) {
                const section = sections[i];
                const queueEntry = this.sectionQueue[i];
                this.currentStep = section.step;
                if (queueEntry) queueEntry.state = "running";
                this.log(`เริ่มดึงข้อมูล: ${section.label}`);
                const data = await section.run();
                if (this.databaseEnabled) {
                    try {
                        await section.save(data);
                    } catch (error) {
                        if (this.databaseMode === "required") throw error;
                        this.databaseEnabled = false;
                        this.databaseError = error.message;
                        this.log(`บันทึก MySQL สำหรับ ${section.label} ไม่สำเร็จ: ${error.message}`);
                        this.log("ไฟล์ที่ดาวน์โหลดไว้ไม่สูญหาย ระบบเปลี่ยนเป็นโหมดเก็บไฟล์อย่างเดียวและทำส่วนถัดไปต่อ");
                    }
                } else {
                    this.log(`ข้ามการบันทึก MySQL สำหรับ ${section.label} (โหมดเก็บไฟล์อย่างเดียว)`);
                }
                sectionResults[section.key] = section.summarize(data);
                if (queueEntry) queueEntry.state = "done";
                this.log(section.logDone(data));
                // บันทึก index ไฟล์ซ้ำเป็นระยะ (กันข้อมูลหายถ้างานถูกหยุดกลางคัน)
                fileStore.save();

                const hasNext = i < sections.length - 1;
                if (hasNext) {
                    if (stepDelayMs > 0) {
                        this.currentStep = `wait-${i + 1}`;
                        this.log(`หน่วงเวลา ${formatDelayText(stepDelayMs)} ก่อนเริ่มส่วนถัดไป`);
                        await sleepWithStop(stepDelayMs, shouldStop);
                    }
                    assertNotStopped();
                }
            }

            this.currentStep = "notify-line";
            const lineToken = effectiveConfig.lineNotifyToken || process.env.LINE_NOTIFY_TOKEN || "";
            if (lineToken) {
                const lineMsg =
                    effectiveConfig.lineMessage || `ระบบดึงข้อมูล "${this.websiteName}" ทำงานเสร็จสิ้นแล้ว`;
                await sendLineNotify(lineToken, lineMsg);
                this.log("ส่งแจ้งเตือน LINE สำเร็จ");
            } else {
                this.log("ข้ามการแจ้งเตือน LINE (ไม่พบ token)");
            }

            this.lastResult = {
                websiteName: this.websiteName,
                databaseName: this.databaseName,
                outputName: this.outputName,
                databaseEnabled: this.databaseEnabled,
                databaseMode: this.databaseMode,
                databaseError: this.databaseError,
                vendorId: this.vendorId,
                vendorName: this.vendorName,
                vendorConfidence: this.vendorConfidence,
                adapterId: vendorAdapter.id,
                selectedSections: sections.map((s) => s.key),
                truncatedTopics: this.truncatedTopics,
                fileAuditSummary: summarizeFileAudit(this.fileAuditRows),
                ...sectionResults,
            };
            this.currentStep = "done";
            if (this.truncatedTopics.length) {
                this.log(
                    `สรุป: มี ${this.truncatedTopics.length} หัวข้อที่ชื่อตารางถูกย่อ — ` +
                        "ดูชื่อเต็มได้ที่ตาราง topic_registry หรือรัน node scripts/check-db-data.js",
                );
                for (const t of this.truncatedTopics) {
                    this.log(`  ${t.tableName}  <-  ${t.fullTitle}`);
                }
            }
            this.log("งานทั้งหมดเสร็จสมบูรณ์");
        } catch (error) {
            if (error && error.message === STOP_ERROR) {
                this.lastError = null;
                this.currentStep = "stopped";
                for (const entry of this.sectionQueue) {
                    if (entry.state === "running") entry.state = "stopped";
                }
                this.log("หยุดงานตามคำสั่งผู้ใช้");
                return;
            }
            this.lastError = error.message;
            this.currentStep = "failed";
            for (const entry of this.sectionQueue) {
                if (entry.state === "running") entry.state = "failed";
            }
            this.log(`เกิดข้อผิดพลาด: ${error.message}`);
            throw error;
        } finally {
            // บันทึก index ไฟล์ซ้ำครั้งสุดท้าย (ทั้งกรณีจบปกติ/หยุด/ล้ม)
            fileStore.save();
            if (this.databaseEnabled && this.fileAuditRows.length) {
                try {
                    await insertFileAuditRows(this.databaseName, this.fileAuditRows);
                } catch (auditDbError) {
                    this.log(`บันทึกผลตรวจไฟล์ลง MySQL ไม่สำเร็จ: ${auditDbError.message}`);
                }
            }

            try {
                this.fileAuditReport = writeAuditReports(
                    baseOutputDir,
                    this.runId,
                    this.fileAuditRows,
                );
                const auditSummary = summarizeFileAudit(this.fileAuditRows);
                this.log(
                    `รายงานตรวจไฟล์: ทั้งหมด=${auditSummary.uniqueFiles}, ` +
                        `ดาวน์โหลดได้=${auditSummary.downloadable}, 404=${auditSummary.notFound}, ` +
                        `403=${auditSummary.forbidden}, ล้มเหลว=${auditSummary.failed}`,
                );
                this.log(`บันทึกรายงาน CSV: ${this.fileAuditReport.csvPath}`);
            } catch (auditReportError) {
                this.log(`สร้างไฟล์รายงานตรวจไฟล์ไม่สำเร็จ: ${auditReportError.message}`);
            }
            this.running = false;
            this.finishedAt = new Date().toISOString();
        }
    }

    stopJob() {
        if (!this.running) return { ok: false, message: "ไม่มีงานที่กำลังทำงานอยู่" };
        if (this.stopRequested) return { ok: false, message: "กำลังส่งคำสั่งหยุดอยู่แล้ว" };
        this.stopRequested = true;
        this.log("ได้รับคำสั่งหยุดงาน กำลังยุติกระบวนการ...");
        return { ok: true, message: "สั่งหยุดงานแล้ว" };
    }
}

module.exports = {
    JobRunner,
    isScrapeAonangWebsiteName,
    toDatabaseName,
};

function toDatabaseName(websiteName) {
    const fallback = "scraper_site";
    const normalized = String(websiteName || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const safe = (normalized || fallback).slice(0, 56);
    return `scrape_${safe}`;
}
