const fs = require("fs");
const path = require("path");

function parsePhpConnection(content) {
    const read = (name) => {
        const match = new RegExp(`\\$${name}\\s*=\\s*["']([^"']*)["']\\s*;`, "i").exec(content);
        if (!match) throw new Error(`ไม่พบตัวแปร $${name} ในไฟล์ PHP`);
        return match[1];
    };
    const charsetMatch = /SET\s+NAMES\s+([a-z0-9_]+)/i.exec(content);
    return {
        host: read("hostname_conndb"),
        database: read("database_conndb"),
        user: read("username_conndb"),
        password: read("password_conndb"),
        charset: charsetMatch ? charsetMatch[1].toLowerCase() : "utf8mb4",
    };
}

function parseEnv(content) {
    const lines = content ? content.replace(/^\uFEFF/, "").split(/\r?\n/) : [];
    const values = new Map();
    for (const line of lines) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (match) values.set(match[1], match[2]);
    }
    return { lines, values };
}

function setEnv(parsed, key, value) {
    const rendered = `${key}=${String(value ?? "")}`;
    const index = parsed.lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (index >= 0) parsed.lines[index] = rendered;
    else parsed.lines.push(rendered);
    parsed.values.set(key, String(value ?? ""));
}

function main() {
    const sourcePath = process.argv[2];
    const mode = String(process.argv[3] || "same-server").toLowerCase();
    if (!sourcePath) {
        throw new Error("วิธีใช้: node scripts/import-php-db-config.js <conndb.php> [same-server|local-xampp]");
    }
    if (!fs.existsSync(sourcePath)) throw new Error(`ไม่พบไฟล์: ${sourcePath}`);

    const php = parsePhpConnection(fs.readFileSync(sourcePath, "utf8"));
    const root = path.resolve(__dirname, "..");
    const envPath = path.join(root, ".env");
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const parsed = parseEnv(existing);

    if (existing) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(path.join(root, `.env.backup-${stamp}`), existing, "utf8");
    }

    const isLocal = mode === "local-xampp";
    const dbCharset = php.charset === "tis620" ? "tis620" : "utf8mb4";
    const collation = dbCharset === "tis620" ? "tis620_thai_ci" : "utf8mb4_unicode_ci";
    const connectionCharset = dbCharset === "tis620" ? "TIS620_THAI_CI" : "UTF8MB4_UNICODE_CI";

    setEnv(parsed, "DATABASE_MODE", "required");
    setEnv(parsed, "MYSQL_HOST", isLocal ? "127.0.0.1" : php.host);
    setEnv(parsed, "MYSQL_PORT", "3306");
    setEnv(parsed, "MYSQL_USER", isLocal ? parsed.values.get("MYSQL_USER") || "root" : php.user);
    setEnv(parsed, "MYSQL_PASSWORD", isLocal ? parsed.values.get("MYSQL_PASSWORD") || "" : php.password);
    setEnv(parsed, "MYSQL_DATABASE_MODE", "fixed");
    setEnv(parsed, "MYSQL_DATABASE", php.database);
    setEnv(parsed, "MYSQL_CREATE_DATABASE", isLocal ? "true" : "false");
    setEnv(parsed, "MYSQL_DATABASE_CHARSET", dbCharset);
    setEnv(parsed, "MYSQL_DATABASE_COLLATION", collation);
    setEnv(parsed, "MYSQL_TABLE_CHARSET", dbCharset);
    setEnv(parsed, "MYSQL_TABLE_COLLATION", collation);
    setEnv(parsed, "MYSQL_CONNECTION_CHARSET", connectionCharset);
    setEnv(parsed, "MYSQL_TIS620_SANITIZE", dbCharset === "tis620" ? "true" : "false");

    fs.writeFileSync(envPath, `${parsed.lines.filter((line, i, arr) => i < arr.length - 1 || line !== "").join("\r\n")}\r\n`, "utf8");
    console.log(`อัปเดต .env สำเร็จ: ${envPath}`);
    console.log(`โหมด: ${isLocal ? "Local XAMPP" : "Same server/hosting"}`);
    console.log(`ฐานข้อมูล: ${php.database}`);
    console.log(`charset: ${dbCharset}`);
    console.log("รหัสผ่านถูกบันทึกใน .env แต่ไม่แสดงบนหน้าจอ");
}

try {
    main();
} catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
}
