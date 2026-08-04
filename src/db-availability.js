const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createDbConnection, getDbProfile } = require("./db-profile");


function getDbConfig(databaseName) {
    return getDbProfile(databaseName);
}

function getDatabaseMode() {
    const value = String(process.env.DATABASE_MODE || "auto").trim().toLowerCase();
    if (["required", "auto", "disabled"].includes(value)) return value;
    return "auto";
}

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function isConnectionError(error) {
    const code = String(error?.code || "").toUpperCase();
    const message = String(error?.message || "");
    return ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "PROTOCOL_CONNECTION_LOST"].includes(code) ||
        /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|connect failed|connection lost/i.test(message);
}

function formatDatabaseError(error, config) {
    const endpoint = `${config.host}:${config.port}`;
    const code = error?.code ? ` (${error.code})` : "";
    if (isConnectionError(error)) {
        return `เชื่อมต่อ MySQL ${endpoint} ไม่ได้${code} — กรุณาเปิด MySQL ใน XAMPP หรือตรวจ MYSQL_HOST/MYSQL_PORT ในไฟล์ .env`;
    }
    if (String(error?.code || "").toUpperCase() === "ER_ACCESS_DENIED_ERROR") {
        return `MySQL ปฏิเสธชื่อผู้ใช้หรือรหัสผ่าน${code} — ตรวจ MYSQL_USER และ MYSQL_PASSWORD ในไฟล์ .env`;
    }
    return `MySQL ใช้งานไม่ได้${code}: ${error?.message || "unknown error"}`;
}

async function probeDatabase(databaseName) {
    const config = getDbConfig(databaseName);
    const conn = await createDbConnection(config, { includeDatabase: false });
    try {
        await conn.query("SELECT 1 AS ok");
        return { ok: true, config };
    } finally {
        await conn.end();
    }
}

function findXamppMysqlStartScript() {
    if (process.platform !== "win32") return null;
    const candidates = [
        process.env.XAMPP_DIR,
        "C:\\xampp",
        "D:\\xampp",
        "C:\\XAMPP",
    ]
        .filter(Boolean)
        .map((dir) => path.join(dir, "mysql_start.bat"));
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function tryStartXamppMysql(logger = () => {}) {
    if (!toBoolean(process.env.MYSQL_AUTO_START, true)) return false;
    const scriptPath = findXamppMysqlStartScript();
    if (!scriptPath) {
        logger("ไม่พบ mysql_start.bat ของ XAMPP — จะทำงานต่อแบบเก็บไฟล์อย่างเดียวถ้า MySQL ยังเชื่อมต่อไม่ได้");
        return false;
    }

    try {
        const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${scriptPath}"`], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.unref();
        logger(`พยายามเปิด MySQL อัตโนมัติผ่าน ${scriptPath}`);
        return true;
    } catch (error) {
        logger(`เปิด MySQL อัตโนมัติไม่สำเร็จ: ${error.message}`);
        return false;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareDatabase(databaseName, logger = () => {}) {
    const mode = getDatabaseMode();
    if (mode === "disabled") {
        return {
            enabled: false,
            mode,
            error: null,
            message: "ปิดการใช้งาน MySQL ตาม DATABASE_MODE=disabled",
        };
    }

    let lastError = null;
    try {
        const result = await probeDatabase(databaseName);
        return { enabled: true, mode, config: result.config, autoStarted: false };
    } catch (error) {
        lastError = error;
    }

    const autoStarted = isConnectionError(lastError) && tryStartXamppMysql(logger);
    if (autoStarted) {
        const attempts = Math.max(1, Math.min(60, Number(process.env.MYSQL_START_RETRY_COUNT || 12)));
        const delayMs = Math.max(250, Math.min(10000, Number(process.env.MYSQL_START_RETRY_DELAY_MS || 2000)));
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            logger(`รอ MySQL พร้อมใช้งาน (${attempt}/${attempts})...`);
            await sleep(delayMs);
            try {
                const result = await probeDatabase(databaseName);
                return { enabled: true, mode, config: result.config, autoStarted: true };
            } catch (error) {
                lastError = error;
            }
        }
    }

    const config = getDbConfig(databaseName);
    const message = formatDatabaseError(lastError, config);
    if (mode === "required") {
        const error = new Error(message);
        error.code = lastError?.code || "MYSQL_UNAVAILABLE";
        throw error;
    }

    return {
        enabled: false,
        mode,
        error: lastError,
        message,
        autoStarted,
    };
}

module.exports = {
    formatDatabaseError,
    getDatabaseMode,
    isConnectionError,
    prepareDatabase,
    probeDatabase,
    tryStartXamppMysql,
};
