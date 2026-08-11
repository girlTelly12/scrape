const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scrapeNewsCategory } = require("../src/scrapers/news-scraper");

// test นี้ตั้งใจให้รันกับ HTTP server ท้องถิ่นเท่านั้น ต้องบังคับโหมด HTTP
// ไม่งั้นถ้าเครื่องตั้ง BROWSER_MODE=cdp ไว้ ทุกการดาวน์โหลดจะเปิด CDP connection
// ไป Chrome:9222 แล้วไม่มีการปิด ทำให้ process ค้างหลัง assert ผ่านหมดแล้ว
process.env.BROWSER_MODE = "http";

async function main() {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");

        if (url.pathname === "/fileupload/news/talingchan.pdf") {
            res.writeHead(200, { "content-type": "application/pdf" });
            res.end(pdf);
            return;
        }

        if (url.pathname === "/news_detail.php" && url.searchParams.get("news_id") === "912") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`
              <html><head><title>ประกาศทดสอบ - อบต.ตลิ่งชัน</title></head><body>
                <table><tr><td class="news_detail">
                  <div class="news-title">ประกาศทดสอบ</div>
                  <div>รายละเอียดข่าวประชาสัมพันธ์สำหรับทดสอบระบบตลิ่งชัน</div>
                  <iframe src="/fileupload/news/talingchan.pdf"></iframe>
                  <div>วันที่ลงข่าว : 14 กรกฎาคม 2569</div>
                </td></tr></table>
              </body></html>
            `);
            return;
        }

        if (url.pathname === "/news.php" && url.searchParams.get("pagenum") === "2") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<div>ไม่มีข่าวเพิ่ม</div>");
            return;
        }

        if (url.pathname === "/news.php") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`
              <a href="javascript:MM_openBrWindow('news_detail.php?news_id=912','','scrollbars=yes')">
                ประกาศทดสอบ
              </a>
              <a href="news.php?cat_id=1&pagenum=2">2</a>
            `);
            return;
        }

        res.writeHead(404).end("not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-talingchan-"));
    try {
        const result = await scrapeNewsCategory({
            startUrl: `http://127.0.0.1:${port}/news.php?cat_id=1`,
            outDir,
            logger: () => {},
            delayMsPerDownload: 0,
            delayMsPerListing: 0,
        });
        assert.strictEqual(result.detailCount, 1);
        assert.strictEqual(result.fileCount, 1);
        assert.strictEqual(result.fileAuditSummary.downloaded, 1);
        assert(result.rows[0].detailText.includes("รายละเอียดข่าวประชาสัมพันธ์"));
        assert.strictEqual(result.rows[0].fileMimeType, "application/pdf");
        assert.strictEqual(result.rows[0].pdfStoredInDb, true);
    } finally {
        // HTTP client ส่ง Connection: keep-alive ทำให้ server.close() รอ socket ค้างไม่มีวันจบ
        // ต้องตัด connection ทิ้งก่อน เช่นเดียวกับ activity-parser-integration.test.js
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        // global agent เก็บ keep-alive socket ไว้ใน pool โดยไม่มี idle timeout
        // ต้อง destroy ทิ้ง ไม่งั้น process ไม่ยอม exit หลัง assert ผ่านหมดแล้ว
        http.globalAgent.destroy();
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log("talingchan legacy integration tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
