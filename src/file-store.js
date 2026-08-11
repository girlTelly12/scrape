const fs = require("fs");
const path = require("path");
const { normalizeAssetUrl } = require("./file-audit");

function boolEnv(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

/**
 * index ถาวรต่อเว็บไซต์ (downloads/<site>/file-index.json) ใช้ข้ามไฟล์ซ้ำ
 *
 * - byUrl: normalized URL (ทั้ง URL ที่ขอและ final URL หลัง redirect) -> record
 *          ข้ามไฟล์ที่เคยดาวน์โหลดด้วยลิงก์เดิม โดยไม่ต้องดาวน์โหลดซ้ำ (ประหยัด bandwidth)
 * - bySha256: digest -> record
 *          ข้ามไฟล์ที่มีเนื้อหาเดียวกันแม้ URL ต่างกัน (เว็บราชการมักฝากไฟล์เดียวกันหลาย path)
 *
 * ตัวเลือก env:
 *   SKIP_EXISTING_FILES=false  ปิดการข้ามไฟล์ซ้ำทั้งหมด (ดาวน์โหลดใหม่ทุกครั้ง)
 *   FORCE_REFRESH=true         ข้ามเฉพาะ URL index (ยังข้ามเนื้อหาซ้ำด้วย SHA-256)
 *                              ใช้เมื่ออยากอัปเดตไฟล์ที่อาจเปลี่ยนเนื้อหาบน server
 */
function createFileStore(options = {}) {
    const indexPath = String(options.indexPath || "");
    const logger = options.logger || (() => {});
    const skipExisting = boolEnv("SKIP_EXISTING_FILES", options.skipExisting !== false);
    const forceRefresh = boolEnv("FORCE_REFRESH", false);

    // record = { url, finalUrl, localPath, sha256, fileSize, mimeType, addedAt }
    const byUrl = new Map();
    const bySha256 = new Map();
    // URL ที่กำลังถูกดาวน์โหลดอยู่ (กันดาวน์โหลดซ้ำเมื่อทำงานขนาน SCRAPE_CONCURRENCY>1)
    const inFlightDownloads = new Map();
    let dirty = false;
    let registrationsSinceSave = 0;

    function load() {
        if (!indexPath) return;
        let parsed = null;
        try {
            parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        } catch {
            // ยังไม่มี index หรือไฟล์เสีย -> เริ่มใหม่ทั้ง index
            return;
        }
        for (const entry of parsed.records || []) {
            if (!entry || !entry.url || !entry.localPath) continue;
            if (!fs.existsSync(entry.localPath)) continue; // ไฟล์บนดิสก์หาย -> ข้าม entry
            const record = {
                url: String(entry.url),
                finalUrl: entry.finalUrl ? String(entry.finalUrl) : "",
                localPath: String(entry.localPath),
                sha256: entry.sha256 ? String(entry.sha256) : "",
                fileSize: entry.fileSize == null ? null : Number(entry.fileSize),
                mimeType: entry.mimeType ? String(entry.mimeType) : "",
                addedAt: entry.addedAt ? String(entry.addedAt) : "",
            };
            byUrl.set(normalizeAssetUrl(record.url), record);
            if (record.finalUrl && record.finalUrl !== record.url) {
                byUrl.set(normalizeAssetUrl(record.finalUrl), record);
            }
            if (record.sha256) bySha256.set(record.sha256, record);
        }
        if (byUrl.size && logger) {
            logger(`โหลด index ไฟล์เดิม: ${byUrl.size} รายการ จาก ${indexPath}`);
        }
    }

    /** ลบ record ที่ไฟล์บนดิสก์หายไปแล้วออกจาก index (กันการอ้าง path ตาย) */
    function prune(record) {
        if (!record) return false;
        if (fs.existsSync(record.localPath)) return true;
        for (const [key, value] of byUrl) {
            if (value === record) byUrl.delete(key);
        }
        if (record.sha256 && bySha256.get(record.sha256) === record) {
            bySha256.delete(record.sha256);
        }
        return false;
    }

    function find(url, finalUrl = "") {
        if (!skipExisting || forceRefresh) return null;
        let record = byUrl.get(normalizeAssetUrl(url)) || null;
        if (!record && finalUrl && finalUrl !== url) {
            record = byUrl.get(normalizeAssetUrl(finalUrl)) || null;
        }
        return prune(record) ? record : null;
    }

    function findByDigest(digest) {
        if (!skipExisting || !digest) return null;
        const record = bySha256.get(String(digest)) || null;
        return prune(record) ? record : null;
    }

    function register(values = {}) {
        if (!values.url || !values.localPath) return null;
        const record = {
            url: String(values.url),
            finalUrl: values.finalUrl && values.finalUrl !== values.url ? String(values.finalUrl) : "",
            localPath: String(values.localPath),
            sha256: values.sha256 ? String(values.sha256) : "",
            fileSize: values.fileSize == null ? null : Number(values.fileSize),
            mimeType: values.mimeType ? String(values.mimeType) : "",
            addedAt: values.addedAt || new Date().toISOString(),
        };
        byUrl.set(normalizeAssetUrl(record.url), record);
        if (record.finalUrl) byUrl.set(normalizeAssetUrl(record.finalUrl), record);
        if (record.sha256) bySha256.set(record.sha256, record);
        dirty = true;
        registrationsSinceSave += 1;
        // บันทึกเป็นระยะเพื่อไม่ให้ข้อมูลหายถ้างานถูกหยุดกลางคัน
        if (registrationsSinceSave >= 100) save();
        return record;
    }

    /**
     * ดาวน์โหลด URL เดียวกันเพียงครั้งเดียวแม้หลาย worker เรียกพร้อมกัน:
     * worker แรกเป็นคนดาวน์โหลดจริง ส่วน worker ที่เหลือรอผลเดียวกัน
     * (ประหยัด bandwidth และกันไฟล์ซ้ำบนดิสก์เมื่อ SCRAPE_CONCURRENCY>1)
     *
     * @param {string} url          URL ที่ขอ (ใช้ normalizeAssetUrl เป็นคีย์)
     * @param {Function} downloadFn async function ที่ดาวน์โหลดจริง คืนค่า result
     * @returns {Promise} result ของ downloadFn (ทุก worker ได้ผลเดียวกัน)
     */
    function claimDownload(url, downloadFn) {
        const key = normalizeAssetUrl(url);
        if (!skipExisting) return Promise.resolve().then(downloadFn);
        let promise = inFlightDownloads.get(key);
        if (!promise) {
            promise = Promise.resolve().then(downloadFn);
            inFlightDownloads.set(key, promise);
            // ถ้า worker แรกดาวน์โหลดล้ม (เช่น timeout ชั่วคราว) worker ที่รออยู่จะได้
            // ผลล้มเดียวกัน ไม่เปิดการดาวน์โหลดซ้ำ — ตั้งใจให้เป็นแบบนี้เพื่อลด request ซ้ำ
            const cleanup = () => {
                if (inFlightDownloads.get(key) === promise) inFlightDownloads.delete(key);
            };
            promise.then(cleanup, cleanup);
        }
        return promise;
    }

    function save() {
        if (!indexPath || !dirty) return;
        dirty = false;
        registrationsSinceSave = 0;
        const uniqueRecords = [...new Set(byUrl.values())];
        const payload = {
            version: 1,
            updatedAt: new Date().toISOString(),
            records: uniqueRecords,
        };
        try {
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            const tmpPath = `${indexPath}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
            fs.renameSync(tmpPath, indexPath);
        } catch (error) {
            logger(`บันทึก index ไฟล์ซ้ำไม่สำเร็จ: ${error.message}`);
        }
    }

    load();
    return {
        find,
        findByDigest,
        claimDownload,
        register,
        save,
        get skipExisting() {
            return skipExisting;
        },
        get forceRefresh() {
            return forceRefresh;
        },
        get size() {
            return byUrl.size;
        },
    };
}

module.exports = {
    createFileStore,
};
