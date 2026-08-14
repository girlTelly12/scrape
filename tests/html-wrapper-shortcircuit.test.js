const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scrapeNewsCategory } = require("../src/scrapers/news-scraper");
const { createFileStore } = require("../src/file-store");

// ต้องบังคับโหมด HTTP เหมือน file-dedupe.test.js — ไม่งั้นถ้าเครื่องตั้ง BROWSER_MODE=cdp
// ไว้ ทุกการดาวน์โหลดจะเปิด CDP connection ไป Chrome:9222 แล้ว process ค้าง
process.env.BROWSER_MODE = "http";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const HTML_PAGE = Buffer.from("<html><body>directory listing</body></html>");

async function main() {
    let dirRequests = 0; // requests ถึง /files/ (directory listing)
    let pdfRequests = 0; // requests ถึงไฟล์จริง doc.pdf
    let endpointRequests = 0; // requests ถึง /dl.php?id=1 (ตอบ HTML แทนไฟล์)
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname === "/files/") {
            dirRequests += 1;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(HTML_PAGE);
            return;
        }
        if (url.pathname === "/files/doc.pdf") {
            pdfRequests += 1;
            res.writeHead(200, { "content-type": "application/pdf" });
            res.end(PDF);
            return;
        }
        if (url.pathname === "/dl.php") {
            endpointRequests += 1;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(HTML_PAGE);
            return;
        }
        if (url.pathname === "/news/" && url.searchParams.get("id")) {
            const id = url.searchParams.get("id");
            const body =
                id === "1"
                    ? '<a href="/files/">ดาวน์โหลด</a><a href="/files/doc.pdf">ดาวน์โหลด</a>'
                    : '<a href="/dl.php?id=1">ดาวน์โหลด</a>';
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(
                `<html><head><title>ข่าว ${id}</title></head><body><article>รายละเอียด ${id} ${body}</article></body></html>`,
            );
            return;
        }
        if (url.pathname === "/news/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(
                `<table><tr><td><a href="?cid=1&id=1">ข่าว 1</a></td></tr><tr><td><a href="?cid=1&id=2">ข่าว 2</a></td></tr><tr><td><a href="?cid=1&id=3">ข่าว 3</a></td></tr></table>`,
            );
            return;
        }
        res.writeHead(404).end("not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-html-wrapper-"));
    const outDir = path.join(tmpRoot, "out", "procurement_files");
    const indexPath = path.join(tmpRoot, "out", "file-index.json");

    try {
        // ข่าว 1: มีลิงก์ directory (/files/) + ไฟล์จริง (/files/doc.pdf)
        // ข่าว 2+3: มีลิงก์ /dl.php?id=1 ที่ตอบ HTML แทนไฟล์ — occurrence แรกดาวน์โหลดแล้ว
        //           เจอ HTML (invalid_content) occurrence ที่สองต้องข้ามผ่าน failure cache
        const store = createFileStore({ indexPath, logger: () => {} });
        const run = await scrapeNewsCategory({
            startUrl: `http://127.0.0.1:${port}/news/?cid=1`,
            outDir,
            sectionKey: "procurement",
            sectionLabel: "จัดซื้อจัดจ้าง",
            logger: () => {},
            fileStore: store,
            delayMsPerDownload: 0,
            delayMsPerListing: 0,
        });
        store.save();

        assert.strictEqual(dirRequests, 0, "ลิงก์ directory (/files/) ต้องถูกกรองตั้งแต่ candidate ไม่มีการขอเซิร์ฟเวอร์");
        assert.strictEqual(pdfRequests, 1, "ไฟล์จริง doc.pdf ต้องดาวน์โหลด 1 ครั้ง");
        assert.strictEqual(endpointRequests, 1, "URL ที่ตอบ HTML ต้องถูกขอเพียงครั้งเดียว (รอบสองข้ามผ่าน failure cache)");
        assert.strictEqual(run.fileCount, 1, "มีไฟล์ที่บันทึกสำเร็จแค่ 1 (doc.pdf)");
        assert.strictEqual(run.fileAuditSummary.invalidContent, 1, "invalid_content 1 รายการ unique (ข่าว 2 กับ 3 เป็น URL เดียวกัน)");
        assert.strictEqual(run.fileAuditSummary.totalReferences, 3, "audit 3 รายการ (doc.pdf + /dl.php?id=1 อีก 2 ครั้ง)");
        assert.strictEqual(run.fileAuditSummary.downloaded, 1, "ดาวน์โหลดสำเร็จแค่ doc.pdf");
    } finally {
        server.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    console.log("html-wrapper short-circuit tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
