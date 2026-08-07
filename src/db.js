const fs = require("fs");
const { AONANG_DATABASE_NAME } = require("./scrapers/aonang");
const { createDatabaseSql, createDbConnection, getDbProfile, tableOptionsSql } = require("./db-profile");

async function ensureColumn(conn, tableName, columnName, columnSql) {
    const [rows] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (rows.length) return;
    await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnSql}`);
}

async function dropColumnIfExists(conn, tableName, columnName) {
    const [rows] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (!rows.length) return;
    await conn.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
}

function normalizeYear(year) {
    const value = Number(year);
    if (!Number.isFinite(value)) return null;
    return value > 2400 ? value - 543 : value;
}

function pad2(value) {
    return String(value).padStart(2, "0");
}

function toSqlDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    }

    const text = String(value)
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return null;

    let match = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
    if (match) {
        const year = normalizeYear(match[1]);
        return year ? `${year}-${pad2(match[2])}-${pad2(match[3])}` : null;
    }

    match = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/.exec(text);
    if (match) {
        let year = Number(match[3]);
        if (year < 100) year += 2000;
        year = normalizeYear(year);
        return year ? `${year}-${pad2(match[2])}-${pad2(match[1])}` : null;
    }

    const thaiMonths = {
        มกราคม: 1,
        "ม.ค.": 1,
        มค: 1,
        กุมภาพันธ์: 2,
        "ก.พ.": 2,
        กพ: 2,
        มีนาคม: 3,
        "มี.ค.": 3,
        มีค: 3,
        เมษายน: 4,
        "เม.ย.": 4,
        เมย: 4,
        พฤษภาคม: 5,
        "พ.ค.": 5,
        พค: 5,
        มิถุนายน: 6,
        "มิ.ย.": 6,
        มิย: 6,
        กรกฎาคม: 7,
        "ก.ค.": 7,
        กค: 7,
        สิงหาคม: 8,
        "ส.ค.": 8,
        สค: 8,
        กันยายน: 9,
        "ก.ย.": 9,
        กย: 9,
        ตุลาคม: 10,
        "ต.ค.": 10,
        ตค: 10,
        พฤศจิกายน: 11,
        "พ.ย.": 11,
        พย: 11,
        ธันวาคม: 12,
        "ธ.ค.": 12,
        ธค: 12,
    };
    match = /(\d{1,2})\s*([ก-๙.]+)\s*(\d{2,4})/.exec(text);
    if (match) {
        const monthKey = match[2].replace(/\s+/g, "");
        const month = thaiMonths[monthKey] || thaiMonths[monthKey.replace(/\./g, "")];
        const year = normalizeYear(match[3]);
        return month && year ? `${year}-${pad2(month)}-${pad2(match[1])}` : null;
    }

    return null;
}

function toSqlDateTime(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())} ${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
    }

    const text = String(value)
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return null;

    const iso = /(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(text);
    if (iso) {
        const year = normalizeYear(iso[1]);
        if (!year) return null;
        return `${year}-${pad2(iso[2])}-${pad2(iso[3])} ${pad2(iso[4] || 0)}:${pad2(iso[5] || 0)}:${pad2(iso[6] || 0)}`;
    }

    const date = toSqlDate(text);
    if (!date) return null;
    const time = /(?:เวลา\s*)?(\d{1,2})[:.]([0-5]\d)(?::([0-5]\d))?\s*(?:น\.?|นาฬิกา)?/i.exec(text);
    return `${date} ${pad2(time ? time[1] : 0)}:${pad2(time ? time[2] : 0)}:${pad2(time && time[3] ? time[3] : 0)}`;
}

function urlPath(value) {
    try {
        const parsed = new URL(String(value || ""));
        return `${parsed.pathname}${parsed.search}`.slice(0, 1024);
    } catch {
        return null;
    }
}

async function normalizeDateColumn(conn, tableName, columnName) {
    const [columns] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\` LIKE ?`, [columnName]);
    if (!columns.length) return;
    if (/^date\b/i.test(columns[0].Type)) return;

    const tempColumn = `${columnName}_date_tmp`;
    await dropColumnIfExists(conn, tableName, tempColumn);
    await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${tempColumn}\` DATE NULL`);

    const [rows] = await conn.query(`SELECT id, \`${columnName}\` AS raw_date FROM \`${tableName}\``);
    for (const row of rows) {
        await conn.execute(`UPDATE \`${tableName}\` SET \`${tempColumn}\` = ? WHERE id = ?`, [
            toSqlDate(row.raw_date),
            row.id,
        ]);
    }

    await conn.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
    await conn.query(`ALTER TABLE \`${tableName}\` CHANGE COLUMN \`${tempColumn}\` \`${columnName}\` DATE NULL`);
}

function getDbConfig(databaseName) {
    return getDbProfile(databaseName);
}

async function listScrapeDatabases() {
    const config = getDbConfig();
    const conn = await createDbConnection(config, { includeDatabase: false });
    try {
        if (config.databaseMode === "fixed") {
            const [rows] = await conn.query(
                "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
                [config.database],
            );
            const existing = rows.map((row) => row.SCHEMA_NAME);
            return existing.length || !config.createDatabase ? existing : [config.database];
        }
        const [rows] = await conn.query(
            "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE LEFT(SCHEMA_NAME, 7) = 'scrape_' ORDER BY SCHEMA_NAME",
        );
        return rows.map((row) => row.SCHEMA_NAME);
    } finally {
        await conn.end();
    }
}

const RESERVED_TOPIC_TABLE_NAMES_LOWER = new Set([
    "procurement_files",
    "public_relations_files",
    "activity_pictures_file",
    "activity_details",
    "activity_media_files",
    "file_download_audit",
    "site_vendor_profile",
    "migration_pages",
    "migration_assets",
    "aonang_bid_winner_files",
    "aonang_reference_price_files",
    "aonang_council_files",
]);

// MySQL เก็บแต่ละตารางเป็นไฟล์ และเข้ารหัสอักขระนอก [0-9A-Za-z$_] ในชื่อไฟล์เป็น @XXXX (5 ตัวอักษร)
// ภาษาไทย 1 ตัว จึงกินชื่อไฟล์ 5 ตัว — ทดสอบบน MariaDB 10.4/Windows แล้วพังที่ 220 ผ่านที่ 215
// เกินลิมิตจะได้ errno 38 "Filename too long" ตอน CREATE TABLE ไม่ใช่ตอนตรวจชื่อ
const TABLE_FILE_NAME_MAX = 215;

function encodedTableFileNameLength(name) {
    let total = 0;
    for (const ch of name) total += /[0-9A-Za-z$_]/.test(ch) ? 1 : 5;
    return total;
}

/**
 * แปลงชื่อหัวข้อที่ผู้ใช้พิมพ์เป็นชื่อตาราง MySQL (รองรับไทย/อังกฤษ)
 * ต้องเก็บ \p{M} ไว้ด้วย เพราะสระบน/ล่างและวรรณยุกต์ไทย (ิ ี ั ุ ่ ้ ็) เป็น Mark ไม่ใช่ Letter
 * ถ้าตัดทิ้ง "รายงานการประชุม" จะกลายเป็น "รายงานการประช_ม"
 * @returns {{ ok: true, tableName: string } | { ok: false, message: string }}
 */
function parseCustomTopicTableName(raw) {
    const s = String(raw || "")
        .trim()
        .replace(/\s+/g, "_");
    const cleaned = s
        .replace(/[^\p{L}\p{M}\p{N}_]+/gu, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    if (!cleaned) {
        return { ok: false, message: "ชื่อหัวข้อว่างหรือมีแต่สัญลักษณ์ที่ใช้เป็นชื่อตารางไม่ได้" };
    }
    if (cleaned.length > 64) {
        return { ok: false, message: "ชื่อหัวข้อยาวเกินไป (หลังจัดรูปแบบสูงสุด 64 ตัวอักษร)" };
    }
    if (encodedTableFileNameLength(cleaned) > TABLE_FILE_NAME_MAX) {
        return {
            ok: false,
            message:
                `ชื่อหัวข้อยาวเกินที่ MySQL สร้างไฟล์ตารางได้ (ตอนนี้ ${cleaned.length} ตัวอักษร) — ` +
                `ภาษาไทยใช้ได้ไม่เกิน ${Math.floor(TABLE_FILE_NAME_MAX / 5)} ตัวอักษร กรุณาย่อชื่อให้สั้นลง`,
        };
    }
    if (RESERVED_TOPIC_TABLE_NAMES_LOWER.has(cleaned.toLowerCase())) {
        return { ok: false, message: "ชื่อหัวข้อชนกับตารางระบบ กรุณาใช้ชื่ออื่น" };
    }
    return { ok: true, tableName: cleaned };
}

/**
 * เมื่อกรอกแค่ลิงก์อื่นๆ ไม่มีชื่อหัวข้อ — สร้างชื่อตารางจากโฮสต์ + cat_id (หรือ path)
 * @returns {{ ok: true, tableName: string } | { ok: false, message: string }}
 */
function deriveOtherTopicTableNameFromUrl(urlStr) {
    try {
        const u = new URL(String(urlStr).trim());
        const host = u.hostname.replace(/^www\./i, "").split(".").filter(Boolean)[0] || "site";
        const hostSlug = host
            .replace(/[^\p{L}\p{M}\p{N}]+/gu, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "") || "site";
        const cat =
            u.searchParams.get("cat_id") || u.searchParams.get("cat") || u.searchParams.get("id") || "";
        const pathParts = u.pathname.split("/").filter(Boolean);
        const pathLast = pathParts.length ? pathParts[pathParts.length - 1] : "";
        const pathSlug = String(pathLast)
            .replace(/\.[a-z0-9]+$/i, "")
            .replace(/[^\p{L}\p{M}\p{N}]+/gu, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "");
        let raw;
        if (cat) raw = `${hostSlug}_cat_${cat}`;
        else if (pathSlug && pathSlug.length <= 40) raw = `${hostSlug}_${pathSlug}`;
        else raw = `${hostSlug}_page`;
        return parseCustomTopicTableName(raw.length > 56 ? raw.slice(0, 56) : raw);
    } catch {
        return { ok: false, message: 'ลิงก์ "อื่นๆ" ไม่ถูกต้อง' };
    }
}

async function syncNewsFileTableLikeProcurement(conn, tableName) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${tableName}\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_id INT NULL,
        detail_id VARCHAR(64) NULL,
        listing_url LONGTEXT NULL,
        listing_path VARCHAR(1024) NULL,
        detail_url LONGTEXT NULL,
        detail_path VARCHAR(1024) NULL,
        section_key VARCHAR(120) NULL,
        section_label VARCHAR(255) NULL,
        folder_path LONGTEXT NULL,
        record_text_path LONGTEXT NULL,
        title TEXT NOT NULL,
        detail_html LONGTEXT NULL,
        detail_text LONGTEXT NULL,
        published_text DATE NULL,
        published_raw TEXT NULL,
        published_at DATETIME NULL,
        media_type VARCHAR(32) NULL,
        media_provider VARCHAR(80) NULL,
        embed_url LONGTEXT NULL,
        is_downloaded TINYINT(1) NOT NULL DEFAULT 0,
        file_type VARCHAR(32) NULL,
        file_name VARCHAR(255) NULL,
        file_url LONGTEXT NULL,
        local_path LONGTEXT NULL,
        file_size BIGINT NULL,
        file_mime_type VARCHAR(255) NULL,
        file_sha256 CHAR(64) NULL,
        pdf_data LONGBLOB NULL,
        pdf_stored_in_db TINYINT(1) NOT NULL DEFAULT 0,
        downloaded_at DATETIME NULL
      ) ${tableOptionsSql(getDbConfig())}
    `);
    await ensureColumn(conn, tableName, "page_id", "`page_id` INT NULL");
    await ensureColumn(conn, tableName, "detail_id", "`detail_id` VARCHAR(64) NULL");
    await ensureColumn(conn, tableName, "listing_url", "`listing_url` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "listing_path", "`listing_path` VARCHAR(1024) NULL");
    await ensureColumn(conn, tableName, "detail_url", "`detail_url` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "detail_path", "`detail_path` VARCHAR(1024) NULL");
    await ensureColumn(conn, tableName, "section_key", "`section_key` VARCHAR(120) NULL");
    await ensureColumn(conn, tableName, "section_label", "`section_label` VARCHAR(255) NULL");
    await ensureColumn(conn, tableName, "folder_path", "`folder_path` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "record_text_path", "`record_text_path` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "title", "`title` TEXT NOT NULL");
    await ensureColumn(conn, tableName, "detail_html", "`detail_html` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "detail_text", "`detail_text` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "published_text", "`published_text` DATE NULL");
    await ensureColumn(conn, tableName, "published_raw", "`published_raw` TEXT NULL");
    await ensureColumn(conn, tableName, "published_at", "`published_at` DATETIME NULL");
    await ensureColumn(conn, tableName, "media_type", "`media_type` VARCHAR(32) NULL");
    await ensureColumn(conn, tableName, "media_provider", "`media_provider` VARCHAR(80) NULL");
    await ensureColumn(conn, tableName, "embed_url", "`embed_url` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "is_downloaded", "`is_downloaded` TINYINT(1) NOT NULL DEFAULT 0");
    await ensureColumn(conn, tableName, "file_type", "`file_type` VARCHAR(32) NULL");
    await ensureColumn(conn, tableName, "file_name", "`file_name` VARCHAR(255) NULL");
    await ensureColumn(conn, tableName, "file_url", "`file_url` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "local_path", "`local_path` LONGTEXT NULL");
    await ensureColumn(conn, tableName, "file_size", "`file_size` BIGINT NULL");
    await ensureColumn(conn, tableName, "file_mime_type", "`file_mime_type` VARCHAR(255) NULL");
    await ensureColumn(conn, tableName, "file_sha256", "`file_sha256` CHAR(64) NULL");
    await ensureColumn(conn, tableName, "pdf_data", "`pdf_data` LONGBLOB NULL");
    await ensureColumn(
        conn,
        tableName,
        "pdf_stored_in_db",
        "`pdf_stored_in_db` TINYINT(1) NOT NULL DEFAULT 0",
    );
    await ensureColumn(conn, tableName, "downloaded_at", "`downloaded_at` DATETIME NULL");
    await normalizeDateColumn(conn, tableName, "published_text");
}

async function syncSiteVendorProfileTable(conn) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS site_vendor_profile (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        run_id VARCHAR(80) NOT NULL,
        website_name VARCHAR(255) NULL,
        site_url LONGTEXT NULL,
        vendor_id VARCHAR(80) NOT NULL,
        vendor_name VARCHAR(255) NOT NULL,
        adapter_id VARCHAR(80) NOT NULL,
        confidence INT NULL,
        score INT NULL,
        evidence_json LONGTEXT NULL,
        probes_json LONGTEXT NULL,
        suggested_config_json LONGTEXT NULL,
        detected_at DATETIME NOT NULL,
        INDEX idx_vendor_profile_run (run_id),
        INDEX idx_vendor_profile_vendor (vendor_id),
        INDEX idx_vendor_profile_detected (detected_at)
      ) ${tableOptionsSql(getDbConfig())}
    `);
}


async function syncMigrationTables(conn) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS migration_pages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        run_id VARCHAR(80) NULL,
        page_url LONGTEXT NOT NULL,
        final_url LONGTEXT NULL,
        title TEXT NULL,
        depth INT NULL,
        status VARCHAR(64) NOT NULL,
        http_status INT NULL,
        html_path LONGTEXT NULL,
        text_path LONGTEXT NULL,
        detail_text LONGTEXT NULL,
        discovered_from LONGTEXT NULL,
        content_sha256 CHAR(64) NULL,
        error_message TEXT NULL,
        scraped_at DATETIME NOT NULL,
        INDEX idx_migration_pages_run (run_id),
        INDEX idx_migration_pages_status (status),
        INDEX idx_migration_pages_http (http_status),
        INDEX idx_migration_pages_sha (content_sha256)
      ) ${tableOptionsSql(getDbConfig())}
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS migration_assets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        run_id VARCHAR(80) NULL,
        page_url LONGTEXT NULL,
        asset_url LONGTEXT NOT NULL,
        final_url LONGTEXT NULL,
        asset_type VARCHAR(64) NULL,
        file_name VARCHAR(500) NULL,
        local_path LONGTEXT NULL,
        mime_type VARCHAR(255) NULL,
        file_size BIGINT NULL,
        file_sha256 CHAR(64) NULL,
        status VARCHAR(64) NOT NULL,
        http_status INT NULL,
        discovered_via VARCHAR(160) NULL,
        pdf_data LONGBLOB NULL,
        pdf_stored_in_db TINYINT(1) NOT NULL DEFAULT 0,
        error_message TEXT NULL,
        downloaded_at DATETIME NULL,
        INDEX idx_migration_assets_run (run_id),
        INDEX idx_migration_assets_type (asset_type),
        INDEX idx_migration_assets_status (status),
        INDEX idx_migration_assets_http (http_status),
        INDEX idx_migration_assets_sha (file_sha256)
      ) ${tableOptionsSql(getDbConfig())}
    `);
}

async function syncFileAuditTable(conn) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS file_download_audit (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        run_id VARCHAR(80) NOT NULL,
        section_key VARCHAR(120) NULL,
        section_label VARCHAR(255) NULL,
        table_name VARCHAR(128) NULL,
        source_type VARCHAR(64) NULL,
        detail_id VARCHAR(128) NULL,
        detail_url TEXT NULL,
        title TEXT NULL,
        file_url LONGTEXT NOT NULL,
        normalized_file_url LONGTEXT NULL,
        file_name VARCHAR(500) NULL,
        file_type VARCHAR(64) NULL,
        discovered_via VARCHAR(128) NULL,
        link_text TEXT NULL,
        status VARCHAR(64) NOT NULL,
        http_status INT NULL,
        downloadable TINYINT(1) NOT NULL DEFAULT 0,
        downloaded TINYINT(1) NOT NULL DEFAULT 0,
        error_message TEXT NULL,
        local_path LONGTEXT NULL,
        file_size BIGINT NULL,
        content_type VARCHAR(255) NULL,
        final_url LONGTEXT NULL,
        duplicate_of_url LONGTEXT NULL,
        checked_at DATETIME NOT NULL,
        INDEX idx_file_audit_run (run_id),
        INDEX idx_file_audit_status (status),
        INDEX idx_file_audit_http (http_status),
        INDEX idx_file_audit_section (section_key)
      ) ${tableOptionsSql(getDbConfig())}
    `);
}

function assertQuotableTableIdentifier(tableName) {
    const t = String(tableName || "").trim();
    if (!t || t.length > 64 || !/^[\p{L}\p{M}\p{N}_]+$/u.test(t)) {
        throw new Error("ชื่อตารางไม่ถูกต้อง");
    }
    return t;
}

/** สร้าง/อัปเดต schema ตารางข่าวแบบจัดซื้อฯ สำหรับหัวข้อ "อื่นๆ" (tableName ต้องผ่าน parseCustomTopicTableName แล้ว) */
async function ensureDynamicNewsTable(databaseName, tableName, logger) {
    const parsed = parseCustomTopicTableName(tableName);
    if (!parsed.ok) throw new Error(parsed.message);
    const safe = parsed.tableName;
    const config = getDbConfig(databaseName);
    const adminConn = await createDbConnection(config, { includeDatabase: false });
    try {
        if (config.createDatabase) await adminConn.query(createDatabaseSql(config));
    } finally {
        await adminConn.end();
    }

    const conn = await createDbConnection(config);
    try {
        if (logger) logger(`Ensuring custom table: ${config.database}.\`${safe}\``);
        await syncNewsFileTableLikeProcurement(conn, safe);
    } finally {
        await conn.end();
    }
}

async function initDatabase(databaseName, logger) {
    const config = getDbConfig(databaseName);
    const adminConn = await createDbConnection(config, { includeDatabase: false });

    try {
        if (config.createDatabase) await adminConn.query(createDatabaseSql(config));
    } finally {
        await adminConn.end();
    }

    const conn = await createDbConnection(config);
    try {
        if (logger) logger(`Connected MySQL: ${config.host}:${config.port}/${config.database}`);
        await syncSiteVendorProfileTable(conn);
        await syncFileAuditTable(conn);
        await syncMigrationTables(conn);
        await syncNewsFileTableLikeProcurement(conn, "procurement_files");

        await syncNewsFileTableLikeProcurement(conn, "public_relations_files");

        await conn.query(`
      CREATE TABLE IF NOT EXISTS activity_pictures_file (
        id INT AUTO_INCREMENT PRIMARY KEY,
        page_no INT NULL,
        album_id VARCHAR(64) NOT NULL,
        listing_url LONGTEXT NULL,
        activity_url LONGTEXT NULL,
        title TEXT NOT NULL,
        detail_html LONGTEXT NULL,
        detail_text LONGTEXT NULL,
        announced_date DATE NULL,
        folder_path LONGTEXT NULL,
        image_index INT NOT NULL,
        image_name VARCHAR(255) NOT NULL,
        image_url LONGTEXT NULL,
        local_path LONGTEXT NULL,
        file_size BIGINT NULL,
        download_source VARCHAR(120) NULL,
        downloaded_at DATETIME NULL
      ) ${tableOptionsSql(getDbConfig())}
    `);
        await ensureColumn(conn, "activity_pictures_file", "page_no", "`page_no` INT NULL");
        await ensureColumn(conn, "activity_pictures_file", "album_id", "`album_id` VARCHAR(64) NOT NULL");
        await ensureColumn(conn, "activity_pictures_file", "listing_url", "`listing_url` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "activity_url", "`activity_url` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "title", "`title` TEXT NOT NULL");
        await ensureColumn(conn, "activity_pictures_file", "detail_html", "`detail_html` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "detail_text", "`detail_text` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "announced_date", "`announced_date` DATE NULL");
        await ensureColumn(conn, "activity_pictures_file", "folder_path", "`folder_path` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "image_index", "`image_index` INT NOT NULL");
        await ensureColumn(conn, "activity_pictures_file", "image_name", "`image_name` VARCHAR(255) NOT NULL");
        await ensureColumn(conn, "activity_pictures_file", "image_url", "`image_url` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "local_path", "`local_path` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "file_size", "`file_size` BIGINT NULL");
        await ensureColumn(conn, "activity_pictures_file", "download_source", "`download_source` VARCHAR(120) NULL");
        await ensureColumn(conn, "activity_pictures_file", "downloaded_at", "`downloaded_at` DATETIME NULL");
        await ensureColumn(conn, "activity_pictures_file", "announced_text", "`announced_text` TEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "announced_at", "`announced_at` DATETIME NULL");
        await ensureColumn(conn, "activity_pictures_file", "detail_text_path", "`detail_text_path` LONGTEXT NULL");
        await ensureColumn(conn, "activity_pictures_file", "media_type", "`media_type` VARCHAR(32) NULL");
        await ensureColumn(conn, "activity_pictures_file", "media_mime_type", "`media_mime_type` VARCHAR(255) NULL");
        await ensureColumn(conn, "activity_pictures_file", "media_provider", "`media_provider` VARCHAR(80) NULL");
        await ensureColumn(conn, "activity_pictures_file", "embed_url", "`embed_url` LONGTEXT NULL");
        await normalizeDateColumn(conn, "activity_pictures_file", "announced_date");

        await conn.query(`
          CREATE TABLE IF NOT EXISTS activity_details (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            page_no INT NULL,
            album_id VARCHAR(128) NOT NULL,
            listing_url LONGTEXT NULL,
            listing_path VARCHAR(1024) NULL,
            activity_url LONGTEXT NULL,
            activity_path VARCHAR(1024) NULL,
            title TEXT NOT NULL,
            detail_html LONGTEXT NULL,
            detail_text LONGTEXT NULL,
            detail_text_path LONGTEXT NULL,
            announced_text TEXT NULL,
            announced_date DATE NULL,
            announced_at DATETIME NULL,
            folder_path LONGTEXT NULL,
            scraped_at DATETIME NOT NULL,
            INDEX idx_activity_details_album (album_id),
            INDEX idx_activity_details_date (announced_date)
          ) ${tableOptionsSql(getDbConfig())}
        `);
        for (const [columnName, columnSql] of [
            ["page_no", "`page_no` INT NULL"],
            ["album_id", "`album_id` VARCHAR(128) NOT NULL"],
            ["listing_url", "`listing_url` LONGTEXT NULL"],
            ["listing_path", "`listing_path` VARCHAR(1024) NULL"],
            ["activity_url", "`activity_url` LONGTEXT NULL"],
            ["activity_path", "`activity_path` VARCHAR(1024) NULL"],
            ["title", "`title` TEXT NOT NULL"],
            ["detail_html", "`detail_html` LONGTEXT NULL"],
            ["detail_text", "`detail_text` LONGTEXT NULL"],
            ["detail_text_path", "`detail_text_path` LONGTEXT NULL"],
            ["announced_text", "`announced_text` TEXT NULL"],
            ["announced_date", "`announced_date` DATE NULL"],
            ["announced_at", "`announced_at` DATETIME NULL"],
            ["folder_path", "`folder_path` LONGTEXT NULL"],
            ["scraped_at", "`scraped_at` DATETIME NOT NULL"],
        ]) await ensureColumn(conn, "activity_details", columnName, columnSql);

        await conn.query(`
          CREATE TABLE IF NOT EXISTS activity_media_files (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            album_id VARCHAR(128) NOT NULL,
            activity_url LONGTEXT NULL,
            title TEXT NOT NULL,
            media_index INT NOT NULL,
            media_type VARCHAR(32) NOT NULL,
            media_provider VARCHAR(80) NULL,
            media_name VARCHAR(500) NULL,
            media_url LONGTEXT NULL,
            embed_url LONGTEXT NULL,
            local_path LONGTEXT NULL,
            file_size BIGINT NULL,
            media_mime_type VARCHAR(255) NULL,
            file_sha256 CHAR(64) NULL,
            pdf_data LONGBLOB NULL,
            pdf_stored_in_db TINYINT(1) NOT NULL DEFAULT 0,
            download_source VARCHAR(120) NULL,
            is_downloaded TINYINT(1) NOT NULL DEFAULT 0,
            downloaded_at DATETIME NULL,
            INDEX idx_activity_media_album (album_id),
            INDEX idx_activity_media_type (media_type)
          ) ${tableOptionsSql(getDbConfig())}
        `);
        for (const [columnName, columnSql] of [
            ["album_id", "`album_id` VARCHAR(128) NOT NULL"],
            ["activity_url", "`activity_url` LONGTEXT NULL"],
            ["title", "`title` TEXT NOT NULL"],
            ["media_index", "`media_index` INT NOT NULL"],
            ["media_type", "`media_type` VARCHAR(32) NOT NULL"],
            ["media_provider", "`media_provider` VARCHAR(80) NULL"],
            ["media_name", "`media_name` VARCHAR(500) NULL"],
            ["media_url", "`media_url` LONGTEXT NULL"],
            ["embed_url", "`embed_url` LONGTEXT NULL"],
            ["local_path", "`local_path` LONGTEXT NULL"],
            ["file_size", "`file_size` BIGINT NULL"],
            ["media_mime_type", "`media_mime_type` VARCHAR(255) NULL"],
            ["file_sha256", "`file_sha256` CHAR(64) NULL"],
            ["pdf_data", "`pdf_data` LONGBLOB NULL"],
            ["pdf_stored_in_db", "`pdf_stored_in_db` TINYINT(1) NOT NULL DEFAULT 0"],
            ["download_source", "`download_source` VARCHAR(120) NULL"],
            ["is_downloaded", "`is_downloaded` TINYINT(1) NOT NULL DEFAULT 0"],
            ["downloaded_at", "`downloaded_at` DATETIME NULL"],
        ]) await ensureColumn(conn, "activity_media_files", columnName, columnSql);

        if (databaseName === AONANG_DATABASE_NAME) {
            for (const tableName of [
                "aonang_bid_winner_files",
                "aonang_reference_price_files",
                "aonang_council_files",
            ]) {
                await syncNewsFileTableLikeProcurement(conn, tableName);
            }
        }
    } finally {
        await conn.end();
    }
}

async function normalizeAllScrapeDatabases(logger) {
    const dbs = await listScrapeDatabases();
    for (const dbName of dbs) {
        await initDatabase(dbName, logger);
    }
    return dbs;
}

async function insertProcurementRows(databaseName, rows) {
    return insertNewsRows(databaseName, "procurement_files", rows);
}

async function insertPublicRelationsRows(databaseName, rows) {
    return insertNewsRows(databaseName, "public_relations_files", rows);
}

async function insertAonangBidWinnerRows(databaseName, rows) {
    return insertNewsRows(databaseName, "aonang_bid_winner_files", rows);
}

async function insertAonangReferencePriceRows(databaseName, rows) {
    return insertNewsRows(databaseName, "aonang_reference_price_files", rows);
}

async function insertAonangCouncilRows(databaseName, rows) {
    return insertNewsRows(databaseName, "aonang_council_files", rows);
}

async function insertNewsRows(databaseName, tableName, rows) {
    if (!rows.length) return;
    const safeTable = assertQuotableTableIdentifier(tableName);
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);

    try {
        const sql = `
      INSERT INTO \`${safeTable}\`
      (page_id, detail_id, listing_url, listing_path, detail_url, detail_path,
       section_key, section_label, folder_path, record_text_path, title,
       detail_html, detail_text, published_text, published_raw, published_at,
       media_type, media_provider, embed_url, is_downloaded, file_type, file_name,
       file_url, local_path, file_size, file_mime_type, file_sha256, pdf_data,
       pdf_stored_in_db, downloaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
        await conn.beginTransaction();
        for (const row of rows) {
            let pdfData = row.pdfData ?? null;
            let pdfStoredInDb = Boolean(row.pdfStoredInDb);
            if (
                pdfStoredInDb &&
                !pdfData &&
                row.localPath &&
                fs.existsSync(row.localPath)
            ) {
                pdfData = fs.readFileSync(row.localPath);
            }
            if (!pdfData) pdfStoredInDb = false;

            await conn.execute(sql, [
                row.pageId ?? null,
                row.detailId ?? null,
                row.listingUrl ?? null,
                row.listingPath ?? urlPath(row.listingUrl),
                row.detailUrl ?? null,
                row.detailPath ?? urlPath(row.detailUrl),
                row.sectionKey ?? null,
                row.sectionLabel ?? null,
                row.folderPath ?? null,
                row.recordTextPath ?? null,
                row.title || "",
                row.detailHtml ?? null,
                row.detailText ?? null,
                toSqlDate(row.publishedText || row.publishedRaw),
                row.publishedRaw ?? row.publishedText ?? null,
                toSqlDateTime(row.publishedAt || row.publishedRaw || row.publishedText),
                row.mediaType ?? row.fileType ?? null,
                row.mediaProvider ?? null,
                row.embedUrl ?? null,
                row.isDownloaded == null ? (row.localPath ? 1 : 0) : row.isDownloaded ? 1 : 0,
                row.fileType ?? null,
                row.fileName ?? null,
                row.fileUrl ?? null,
                row.localPath ?? null,
                row.fileSize ?? null,
                row.fileMimeType ?? null,
                row.fileSha256 ?? null,
                pdfData,
                pdfStoredInDb ? 1 : 0,
                row.downloadedAt ?? null,
            ]);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        await conn.end();
    }
}

async function insertSiteVendorProfile(databaseName, profile) {
    if (!profile) return;
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);
    try {
        await syncSiteVendorProfileTable(conn);
        await conn.execute(
            `INSERT INTO site_vendor_profile
             (run_id, website_name, site_url, vendor_id, vendor_name, adapter_id, confidence, score,
              evidence_json, probes_json, suggested_config_json, detected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                profile.runId || "manual",
                profile.websiteName || null,
                profile.siteUrl || null,
                profile.vendorId || "generic",
                profile.vendorName || "Generic / ไม่ทราบผู้พัฒนา",
                profile.adapterId || profile.vendorId || "generic",
                profile.confidence == null ? null : Number(profile.confidence),
                profile.score == null ? null : Number(profile.score),
                JSON.stringify(profile.evidence || []),
                JSON.stringify(profile.probes || []),
                JSON.stringify(profile.suggestedConfig || {}),
                new Date().toISOString().slice(0, 19).replace("T", " "),
            ],
        );
    } finally {
        await conn.end();
    }
}

async function insertFileAuditRows(databaseName, rows) {
    if (!rows || !rows.length) return;
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);
    try {
        await syncFileAuditTable(conn);
        await syncMigrationTables(conn);
        const sql = `
          INSERT INTO file_download_audit
          (run_id, section_key, section_label, table_name, source_type, detail_id, detail_url,
           title, file_url, normalized_file_url, file_name, file_type, discovered_via, link_text,
           status, http_status, downloadable, downloaded, error_message, local_path, file_size,
           content_type, final_url, duplicate_of_url, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await conn.beginTransaction();
        for (const row of rows) {
            await conn.execute(sql, [
                row.runId,
                row.sectionKey,
                row.sectionLabel,
                row.tableName,
                row.sourceType,
                row.detailId,
                row.detailUrl,
                row.title,
                row.fileUrl,
                row.normalizedFileUrl,
                row.fileName,
                row.fileType,
                row.discoveredVia,
                row.linkText,
                row.status,
                row.httpStatus,
                row.downloadable ? 1 : 0,
                row.downloaded ? 1 : 0,
                row.errorMessage,
                row.localPath,
                row.fileSize,
                row.contentType,
                row.finalUrl,
                row.duplicateOfUrl,
                row.checkedAt,
            ]);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        await conn.end();
    }
}

async function insertActivityRows(databaseName, rows) {
    if (!rows.length) return;
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);
    try {
        const sql = `
      INSERT INTO activity_pictures_file
      (page_no, album_id, listing_url, activity_url, title, detail_html, detail_text,
       announced_date, announced_text, announced_at, detail_text_path, folder_path,
       image_index, image_name, image_url, local_path, file_size, download_source,
       media_type, media_mime_type, media_provider, embed_url, downloaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
        await conn.beginTransaction();
        for (const row of rows) {
            await conn.execute(sql, [
                row.pageNo ?? null,
                row.albumId,
                row.listingUrl ?? null,
                row.activityUrl ?? null,
                row.title || "",
                row.detailHtml ?? null,
                row.detailText ?? null,
                toSqlDate(row.announcedDate || row.announcedText),
                row.announcedText ?? row.announcedDate ?? null,
                toSqlDateTime(row.announcedAt || row.announcedText || row.announcedDate),
                row.detailTextPath ?? null,
                row.folderPath ?? null,
                row.imageIndex,
                row.imageName,
                row.imageUrl ?? null,
                row.localPath ?? null,
                row.fileSize ?? null,
                row.downloadSource ?? null,
                row.mediaType ?? "image",
                row.mediaMimeType ?? null,
                row.mediaProvider ?? null,
                row.embedUrl ?? null,
                row.downloadedAt ?? null,
            ]);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        await conn.end();
    }
}

async function insertActivityDetailRows(databaseName, rows) {
    if (!rows || !rows.length) return;
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);
    try {
        const sql = `
          INSERT INTO activity_details
          (page_no, album_id, listing_url, listing_path, activity_url, activity_path,
           title, detail_html, detail_text, detail_text_path, announced_text,
           announced_date, announced_at, folder_path, scraped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await conn.beginTransaction();
        for (const row of rows) {
            await conn.execute(sql, [
                row.pageNo ?? null,
                String(row.albumId || ""),
                row.listingUrl ?? null,
                row.listingPath ?? urlPath(row.listingUrl),
                row.activityUrl ?? null,
                row.activityPath ?? urlPath(row.activityUrl),
                row.title || "",
                row.detailHtml ?? null,
                row.detailText ?? null,
                row.detailTextPath ?? null,
                row.announcedText ?? row.announcedDate ?? null,
                toSqlDate(row.announcedDate || row.announcedText),
                toSqlDateTime(row.announcedAt || row.announcedText || row.announcedDate),
                row.folderPath ?? null,
                row.scrapedAt ?? new Date().toISOString().slice(0, 19).replace("T", " "),
            ]);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        await conn.end();
    }
}

async function insertActivityMediaRows(databaseName, rows) {
    if (!rows || !rows.length) return;
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);
    try {
        const sql = `
          INSERT INTO activity_media_files
          (album_id, activity_url, title, media_index, media_type, media_provider,
           media_name, media_url, embed_url, local_path, file_size, media_mime_type,
           file_sha256, pdf_data, pdf_stored_in_db, download_source, is_downloaded,
           downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await conn.beginTransaction();
        for (const row of rows) {
            let pdfData = row.pdfData ?? null;
            let pdfStoredInDb = Boolean(row.pdfStoredInDb);
            if (pdfStoredInDb && !pdfData && row.localPath && fs.existsSync(row.localPath)) {
                const maxMb = Math.max(1, Number(process.env.PDF_DB_MAX_MB || 32));
                const stat = fs.statSync(row.localPath);
                if (stat.size <= maxMb * 1024 * 1024) pdfData = fs.readFileSync(row.localPath);
            }
            if (!pdfData) pdfStoredInDb = false;

            await conn.execute(sql, [
                String(row.albumId || ""),
                row.activityUrl ?? null,
                row.title || "",
                row.mediaIndex ?? 0,
                row.mediaType || "link",
                row.mediaProvider ?? null,
                row.mediaName ?? null,
                row.mediaUrl ?? null,
                row.embedUrl ?? null,
                row.localPath ?? null,
                row.fileSize ?? null,
                row.mediaMimeType ?? null,
                row.fileSha256 ?? null,
                pdfData,
                pdfStoredInDb ? 1 : 0,
                row.downloadSource ?? null,
                row.isDownloaded ? 1 : 0,
                row.downloadedAt ?? null,
            ]);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        await conn.end();
    }
}


async function insertMigrationPageRows(databaseName, rows) {
    if (!rows || !rows.length) return;
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);
    try {
        const sql = `
          INSERT INTO migration_pages
          (run_id, page_url, final_url, title, depth, status, http_status, html_path,
           text_path, detail_text, discovered_from, content_sha256, error_message, scraped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await conn.beginTransaction();
        for (const row of rows) {
            await conn.execute(sql, [
                row.runId ?? null,
                row.pageUrl,
                row.finalUrl ?? null,
                row.title ?? null,
                row.depth ?? null,
                row.status || "failed",
                row.httpStatus ?? null,
                row.htmlPath ?? null,
                row.textPath ?? null,
                row.detailText ?? null,
                row.discoveredFrom ?? null,
                row.contentSha256 ?? null,
                row.errorMessage ?? null,
                row.scrapedAt ?? new Date().toISOString().slice(0, 19).replace("T", " "),
            ]);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        await conn.end();
    }
}

async function insertMigrationAssetRows(databaseName, rows) {
    if (!rows || !rows.length) return;
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config);
    try {
        const sql = `
          INSERT INTO migration_assets
          (run_id, page_url, asset_url, final_url, asset_type, file_name, local_path,
           mime_type, file_size, file_sha256, status, http_status, discovered_via,
           pdf_data, pdf_stored_in_db, error_message, downloaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        await conn.beginTransaction();
        for (const row of rows) {
            let pdfData = row.pdfData ?? null;
            let pdfStoredInDb = Boolean(row.pdfStoredInDb && pdfData);
            if (!pdfData) pdfStoredInDb = false;
            await conn.execute(sql, [
                row.runId ?? null,
                row.pageUrl ?? null,
                row.assetUrl,
                row.finalUrl ?? null,
                row.assetType ?? null,
                row.fileName ?? null,
                row.localPath ?? null,
                row.mimeType ?? null,
                row.fileSize ?? null,
                row.fileSha256 ?? null,
                row.status || "failed",
                row.httpStatus ?? null,
                row.discoveredVia ?? null,
                pdfData,
                pdfStoredInDb ? 1 : 0,
                row.errorMessage ?? null,
                row.downloadedAt ?? null,
            ]);
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        await conn.end();
    }
}

module.exports = {
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
    normalizeAllScrapeDatabases,
    parseCustomTopicTableName,
    deriveOtherTopicTableNameFromUrl,
};
