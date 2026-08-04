function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function normalizeIdentifier(value, fallback) {
    const text = String(value || fallback || "").trim();
    if (!text || !/^[A-Za-z0-9_$-]+$/.test(text)) {
        throw new Error(`ชื่อฐานข้อมูลไม่ถูกต้อง: ${text || "(ว่าง)"}`);
    }
    return text;
}

function normalizeCharset(value, fallback) {
    const text = String(value || fallback || "utf8mb4").trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(text)) throw new Error(`charset ไม่ถูกต้อง: ${text}`);
    return text;
}

function normalizeCollation(value, fallback) {
    const text = String(value || fallback || "utf8mb4_unicode_ci").trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(text)) throw new Error(`collation ไม่ถูกต้อง: ${text}`);
    return text;
}

function connectionCharsetFor(tableCharset, configured) {
    if (configured) return String(configured).trim().toUpperCase();
    return tableCharset === "tis620" ? "TIS620_THAI_CI" : "UTF8MB4_UNICODE_CI";
}

function getDbProfile(requestedDatabaseName) {
    const modeRaw = String(process.env.MYSQL_DATABASE_MODE || "per_site").trim().toLowerCase();
    const databaseMode = modeRaw === "fixed" ? "fixed" : "per_site";
    const fixedName = String(process.env.MYSQL_DATABASE || "").trim();
    const requested = String(requestedDatabaseName || "").trim();
    const database = normalizeIdentifier(
        databaseMode === "fixed" && fixedName ? fixedName : requested || fixedName || "scraper_default",
        "scraper_default",
    );

    const databaseCharset = normalizeCharset(process.env.MYSQL_DATABASE_CHARSET, "tis620");
    const databaseCollation = normalizeCollation(
        process.env.MYSQL_DATABASE_COLLATION,
        databaseCharset === "tis620" ? "tis620_thai_ci" : "utf8mb4_unicode_ci",
    );
    const tableCharset = normalizeCharset(process.env.MYSQL_TABLE_CHARSET, "utf8mb4");
    const tableCollation = normalizeCollation(
        process.env.MYSQL_TABLE_COLLATION,
        tableCharset === "tis620" ? "tis620_thai_ci" : "utf8mb4_unicode_ci",
    );

    return {
        host: process.env.MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || "root",
        password: process.env.MYSQL_PASSWORD || "",
        database,
        databaseMode,
        createDatabase: toBoolean(process.env.MYSQL_CREATE_DATABASE, true),
        databaseCharset,
        databaseCollation,
        tableCharset,
        tableCollation,
        charset: connectionCharsetFor(tableCharset, process.env.MYSQL_CONNECTION_CHARSET),
        legacyTis620Sanitize: toBoolean(
            process.env.MYSQL_TIS620_SANITIZE,
            tableCharset === "tis620",
        ),
    };
}

function tableOptionsSql(profile) {
    return `CHARACTER SET ${profile.tableCharset} COLLATE ${profile.tableCollation}`;
}

function createDatabaseSql(profile) {
    return `CREATE DATABASE IF NOT EXISTS \`${profile.database}\` CHARACTER SET ${profile.databaseCharset} COLLATE ${profile.databaseCollation}`;
}

function sanitizeTis620String(value) {
    return String(value)
        .normalize("NFC")
        .replace(/[^\x09\x0A\x0D\x20-\x7E\u0E01-\u0E5B]/g, "");
}

function sanitizeParams(value, enabled) {
    if (!enabled) return value;
    if (Buffer.isBuffer(value) || value instanceof Date || value === null || value === undefined) return value;
    if (typeof value === "string") return sanitizeTis620String(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeParams(item, enabled));
    if (typeof value === "object") {
        const output = {};
        for (const [key, item] of Object.entries(value)) output[key] = sanitizeParams(item, enabled);
        return output;
    }
    return value;
}

async function createDbConnection(profileOrDatabaseName, options = {}) {
    const mysql = require("mysql2/promise");
    const profile =
        profileOrDatabaseName && typeof profileOrDatabaseName === "object"
            ? profileOrDatabaseName
            : getDbProfile(profileOrDatabaseName);
    const includeDatabase = options.includeDatabase !== false;
    const conn = await mysql.createConnection({
        host: profile.host,
        port: profile.port,
        user: profile.user,
        password: profile.password,
        ...(includeDatabase ? { database: profile.database } : {}),
        charset: profile.charset,
        connectTimeout: Math.max(1000, Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 4000)),
    });

    const rawExecute = conn.execute.bind(conn);
    const rawQuery = conn.query.bind(conn);
    conn.execute = (sql, params) => rawExecute(sql, sanitizeParams(params, profile.legacyTis620Sanitize));
    conn.query = (sql, params) => rawQuery(sql, sanitizeParams(params, profile.legacyTis620Sanitize));
    return conn;
}

module.exports = {
    createDatabaseSql,
    createDbConnection,
    getDbProfile,
    sanitizeTis620String,
    tableOptionsSql,
    toBoolean,
};
