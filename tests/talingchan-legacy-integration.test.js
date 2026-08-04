const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scrapeNewsCategory } = require("../src/scrapers/news-scraper");

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
        server.close();
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log("talingchan legacy integration tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
