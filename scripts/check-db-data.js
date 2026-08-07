// ตรวจว่าข้อมูลเข้า MySQL แล้วหรือยัง และครบเทียบกับไฟล์ที่โหลดไว้ไหม
// ใช้: node scripts/check-db-data.js [ชื่อฐาน]   (ไม่ใส่ = ตรวจทุกฐาน scrape_*)
const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "..");

function loadEnvFile() {
    const envPath = path.join(projectRoot, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        if (!(key in process.env)) process.env[key] = trimmed.slice(idx + 1).trim();
    }
}

// Windows จำกัด path ที่ 260 ตัวอักษร โฟลเดอร์ชื่อประกาศไทยยาวเกินได้ง่าย
function longPath(p) {
    const resolved = path.resolve(p);
    return process.platform === "win32" && !resolved.startsWith("\\\\?\\")
        ? `\\\\?\\${resolved}`
        : resolved;
}

function existsLong(p) {
    try {
        return fs.existsSync(longPath(p));
    } catch {
        return false;
    }
}

function countDirs(dir) {
    try {
        return fs.readdirSync(longPath(dir), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
        return null;
    }
}

const SECTION_TO_FOLDER = {
    procurement_files: "procurement_files",
    public_relations_files: "public_relations_files",
    activity_pictures_file: "activity_pictures_file",
};

function pct(part, total) {
    if (!total) return "-";
    return `${Math.round((part / total) * 100)}%`;
}

async function main() {
    loadEnvFile();
    const mysql = require("mysql2/promise");
    const wanted = String(process.argv[2] || "").trim();

    const cfg = {
        host: process.env.MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || "root",
        password: process.env.MYSQL_PASSWORD || "",
        connectTimeout: Math.max(1000, Number(process.env.MYSQL_CONNECT_TIMEOUT_MS || 4000)),
    };

    console.log(`DATABASE_MODE = ${process.env.DATABASE_MODE || "auto"}`);
    console.log(`MySQL         = ${cfg.user}@${cfg.host}:${cfg.port}\n`);

    let conn;
    try {
        conn = await mysql.createConnection(cfg);
    } catch (error) {
        console.log(`ต่อ MySQL ไม่ได้: ${error.code || error.message}`);
        console.log("เปิด MySQL ใน XAMPP ก่อน แล้วรันคำสั่งนี้ใหม่");
        process.exitCode = 1;
        return;
    }

    const [schemas] = await conn.query(
        "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE LEFT(SCHEMA_NAME,7)='scrape_' ORDER BY SCHEMA_NAME",
    );
    let names = schemas.map((r) => r.SCHEMA_NAME);
    if (wanted) names = names.filter((n) => n === wanted);

    if (!names.length) {
        console.log(wanted ? `ไม่พบฐาน ${wanted}` : "ยังไม่มีฐาน scrape_* สักตัว");
        console.log("");
        console.log("ฐานข้อมูลถูกสร้างตอน 'เริ่มดึงข้อมูล' เท่านั้น — การรีสตาร์ท server ไม่ได้สร้างให้");
        console.log("ถ้าเพิ่ง DROP ไป ต้องกดเริ่มงาน scrape ใหม่ ระบบจะ CREATE DATABASE ให้เอง");
        await conn.end();
        return;
    }

    for (const db of names) {
        console.log(`${"=".repeat(64)}\nฐาน: ${db}\n${"=".repeat(64)}`);
        const c = await mysql.createConnection({ ...cfg, database: db });

        const [tables] = await c.query(
            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME",
            [db],
        );

        const counts = new Map();
        let grandTotal = 0;
        for (const t of tables) {
            const [[r]] = await c.query(`SELECT COUNT(*) n FROM \`${t.TABLE_NAME}\``);
            counts.set(t.TABLE_NAME, r.n);
            grandTotal += r.n;
        }

        console.log(`ตารางทั้งหมด ${tables.length} | แถวรวม ${grandTotal}\n`);
        console.log("  " + "ตาราง".padEnd(38) + "แถว".padStart(8));
        console.log("  " + "-".repeat(46));
        for (const [name, n] of counts) {
            if (n === 0) continue;
            console.log("  " + name.padEnd(38) + String(n).padStart(8));
        }
        const empty = [...counts.entries()].filter(([, n]) => n === 0).map(([k]) => k);
        if (empty.length) console.log(`\n  ตารางที่ยังว่าง (${empty.length}): ${empty.join(", ")}`);

        // เทียบกับไฟล์บนดิสก์
        const outDir = path.join(projectRoot, "downloads", db);
        console.log(`\n  --- เทียบกับไฟล์ใน downloads/${db} ---`);
        if (!existsLong(outDir)) {
            console.log("  ยังไม่มีโฟลเดอร์ดาวน์โหลดของฐานนี้");
        } else {
            for (const [table, folder] of Object.entries(SECTION_TO_FOLDER)) {
                const rows = counts.get(table);
                if (rows === undefined) continue;
                const dirs = countDirs(path.join(outDir, folder));
                if (dirs === null) continue;
                console.log(`  ${folder.padEnd(26)} โฟลเดอร์ประกาศ ${String(dirs).padStart(5)} | แถวใน DB ${String(rows).padStart(6)}`);
            }

            // ตรวจว่า local_path ที่บันทึกไว้ยังมีไฟล์จริงไหม
            for (const table of ["procurement_files", "public_relations_files"]) {
                if (!counts.get(table)) continue;
                const [rows] = await c.query(
                    `SELECT local_path FROM \`${table}\` WHERE local_path IS NOT NULL AND local_path <> '' LIMIT 500`,
                );
                if (!rows.length) continue;
                const missing = rows.filter((r) => !existsLong(r.local_path)).length;
                console.log(
                    `  ${table}: ตรวจ local_path ${rows.length} รายการ — ไฟล์หาย ${missing} (${pct(rows.length - missing, rows.length)} ยังอยู่ครบ)`,
                );
            }

            // PDF ที่เก็บลง LONGBLOB
            for (const table of ["procurement_files", "public_relations_files"]) {
                if (!counts.get(table)) continue;
                const [[r]] = await c.query(
                    `SELECT SUM(pdf_stored_in_db=1) stored, SUM(pdf_data IS NOT NULL) hasData,
                            ROUND(SUM(LENGTH(pdf_data))/1024/1024,1) mb FROM \`${table}\``,
                );
                console.log(`  ${table}: PDF ใน DB ${r.stored || 0} รายการ รวม ${r.mb || 0} MB`);
            }
        }

        // เทียบกับรายงานตรวจไฟล์ล่าสุด
        const auditPath = path.join(outDir, "reports", "file-audit-latest.json");
        if (existsLong(auditPath)) {
            try {
                const report = JSON.parse(fs.readFileSync(longPath(auditPath), "utf8"));
                const auditRows = counts.get("file_download_audit") || 0;
                const inFile = (report.files || []).length;
                console.log(`\n  --- เทียบกับ file-audit-latest.json (runId ${report.runId}) ---`);
                console.log(`  รายการในรายงาน ${inFile} | แถวใน file_download_audit ${auditRows}`);
                const s = report.summary || {};
                console.log(`  โหลดสำเร็จ ${s.downloaded || 0} | 404 ${s.notFound || 0} | ล้มเหลว ${s.failed || 0}`);
                if (auditRows === 0 && inFile > 0) {
                    console.log("  >> รายงานมีข้อมูลแต่ DB ว่าง แปลว่างานรอบนั้นรันตอน MySQL ยังไม่พร้อม");
                } else if (auditRows < inFile) {
                    console.log(`  >> DB มีน้อยกว่ารายงาน ${inFile - auditRows} รายการ (อาจเป็นข้อมูลจากคนละ run)`);
                }
            } catch (error) {
                console.log(`  อ่านรายงานไม่ได้: ${error.message}`);
            }
        }

        console.log("");
        await c.end();
    }

    await conn.end();
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
