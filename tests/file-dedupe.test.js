const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scrapeNewsCategory } = require("../src/scrapers/news-scraper");
const { createFileStore } = require("../src/file-store");

// test นี้ตั้งใจให้รันกับ HTTP server ท้องถิ่นเท่านั้น ต้องบังคับโหมด HTTP
// ไม่งั้นถ้าเครื่องตั้ง BROWSER_MODE=cdp ไว้ ทุกการดาวน์โหลดจะเปิด CDP connection
// ไป Chrome:9222 แล้วไม่มีการปิด ทำให้ process ค้างหลัง assert ผ่านหมดแล้ว
process.env.BROWSER_MODE = "http";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

function countPdfFiles(dir) {
    const files = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".pdf")) files.push(full);
        }
    };
    walk(dir);
    return files;
}

async function main() {
    let fileRequests = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (/^\/files\//.test(url.pathname)) {
            fileRequests += 1;
            res.writeHead(200, { "content-type": "application/pdf" });
            res.end(PDF);
            return;
        }
        if (url.pathname === "/news/" && url.searchParams.get("id")) {
            const id = url.searchParams.get("id");
            const body =
                id === "2"
                    ? '<a href="/files/doc.pdf">ดาวน์โหลด</a><a href="/files/copy.pdf">ดาวน์โหลด</a>'
                    : '<a href="/files/doc.pdf">ดาวน์โหลด</a>';
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(
                `<html><head><title>ข่าว ${id}</title></head><body><article>รายละเอียด ${id} ${body}</article></body></html>`,
            );
            return;
        }
        if (url.pathname === "/news/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(
                `<table><tr><td><a href="?cid=1&id=1">ข่าว 1</a></td></tr><tr><td><a href="?cid=1&id=2">ข่าว 2</a></td></tr></table>`,
            );
            return;
        }
        res.writeHead(404).end("not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-dedupe-"));
    const outDir = path.join(tmpRoot, "out", "procurement_files");
    const indexPath = path.join(tmpRoot, "out", "file-index.json");

    try {
        // ---- รอบแรก: ดาวน์โหลดจริง 1 ไฟล์, ข้าม 1 (URL ซ้ำ) + 1 (เนื้อหาซ้ำ SHA-256) ----
        const store1 = createFileStore({ indexPath, logger: () => {} });
        const run1 = await scrapeNewsCategory({
            startUrl: `http://127.0.0.1:${port}/news/?cid=1`,
            outDir,
            sectionKey: "procurement",
            sectionLabel: "จัดซื้อจัดจ้าง",
            logger: () => {},
            fileStore: store1,
            delayMsPerDownload: 0,
            delayMsPerListing: 0,
        });
        store1.save();

        assert.strictEqual(run1.detailCount, 2, "พบ 2 รายละเอียด");
        assert.strictEqual(run1.rows.length, 3, "ควรมี 3 แถว (2 ไฟล์ใน detail2 + 1 ใน detail1)");
        assert.strictEqual(run1.fileAuditSummary.downloaded, 1, "ดาวน์โหลดจริงแค่ 1 ไฟล์");
        assert.strictEqual(run1.fileAuditSummary.alreadyExists, 1, "copy.pdf ต้องถูกข้ามด้วย SHA-256");
        assert.strictEqual(countPdfFiles(outDir).length, 1, "บนดิสก์ต้องมี PDF แค่ 1 ไฟล์ (ไม่มี file-2.pdf)");
        assert.strictEqual(new Set(run1.rows.map((row) => row.localPath)).size, 1, "ทุกแถวต้องชี้ localPath เดียวกัน");
        assert(fs.existsSync(indexPath), "index ต้องถูกบันทึก");
        const index1 = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        assert.strictEqual(new Set(index1.records.map((record) => record.localPath)).size, 1, "index ชี้ไฟล์เดียว");

        // ---- รอบสอง: ข้ามทุกไฟล์โดยไม่ดาวน์โหลดแม้แต่ครั้งเดียว ----
        const fileRequestsBefore = fileRequests;
        const store2 = createFileStore({ indexPath, logger: () => {} });
        const run2 = await scrapeNewsCategory({
            startUrl: `http://127.0.0.1:${port}/news/?cid=1`,
            outDir,
            sectionKey: "procurement",
            sectionLabel: "จัดซื้อจัดจ้าง",
            logger: () => {},
            fileStore: store2,
            delayMsPerDownload: 0,
            delayMsPerListing: 0,
        });
        store2.save();

        assert.strictEqual(fileRequests - fileRequestsBefore, 0, "รอบสองต้องไม่ดาวน์โหลดไฟล์ซ้ำเลย");
        assert.strictEqual(run2.fileAuditSummary.downloaded, 0, "รอบสองต้องไม่มี downloaded");
        assert.strictEqual(run2.fileAuditSummary.alreadyExists, 2, "doc.pdf + copy.pdf ถูกข้ามทั้งคู่");
        assert.strictEqual(countPdfFiles(outDir).length, 1, "ไฟล์บนดิสก์ยังมีแค่ 1");
        assert.strictEqual(new Set(run2.rows.map((row) => row.localPath)).size, 1, "ชี้ไฟล์เดิมทั้งหมด");

        // ---- FORCE_REFRESH=true: ดาวน์โหลดใหม่ทุกไฟล์ แต่ยังไม่เขียนไฟล์ซ้ำบนดิสก์ ----
        process.env.FORCE_REFRESH = "true";
        const fileRequestsBefore2 = fileRequests;
        const store3 = createFileStore({ indexPath, logger: () => {} });
        const run3 = await scrapeNewsCategory({
            startUrl: `http://127.0.0.1:${port}/news/?cid=1`,
            outDir,
            sectionKey: "procurement",
            sectionLabel: "จัดซื้อจัดจ้าง",
            logger: () => {},
            fileStore: store3,
            delayMsPerDownload: 0,
            delayMsPerListing: 0,
        });
        store3.save();
        delete process.env.FORCE_REFRESH;

        assert.ok(
            fileRequests - fileRequestsBefore2 >= 2,
            "FORCE_REFRESH ต้องดาวน์โหลดใหม่ (doc.pdf + copy.pdf)",
        );
        assert.strictEqual(countPdfFiles(outDir).length, 1, "แต่ยังไม่เขียนไฟล์ซ้ำบนดิสก์ (SHA-256 dedupe ยังทำงาน)");
        assert.strictEqual(run3.fileAuditSummary.downloaded, 0, "FORCE_REFRESH ข้าม URL แต่ยัง reuse เนื้อหาเดียวกัน");
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        http.globalAgent.destroy();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
    console.log("file dedupe tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
