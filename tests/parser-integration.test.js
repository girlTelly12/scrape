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
        if (/^\/files\/a-\d+\.pdf$/.test(url.pathname)) {
            res.writeHead(200, { "content-type": "text/html" });
            res.end(pdf);
            return;
        }
        if (url.pathname === "/news/" && url.searchParams.get("id")) {
            const id = url.searchParams.get("id");
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<html><head><meta property="og:title" content="ข่าว ${id}"></head><body><article>รายละเอียด ${id}<a href="/files/a-${id}.pdf">ดาวน์โหลดเอกสาร</a></article></body></html>`);
            return;
        }
        if (url.pathname === "/news/" && url.searchParams.get("page") === "2") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<table><tr><td><a href="?cid=2&id=702">ข่าว 702</a> [อ่าน 5 คน] เมื่อ 12 มิ.ย. 2569</td></tr></table>`);
            return;
        }
        if (url.pathname === "/news/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<table><tr><td><a href="?cid=2&id=701">ข่าว 701</a> [อ่าน 10 คน] เมื่อ 11 มิ.ย. 2569</td></tr></table><a href="?page=2">หน้าถัดไป</a>`);
            return;
        }
        res.writeHead(404).end("not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-baanna-"));
    try {
        const result = await scrapeNewsCategory({
            startUrl: `http://127.0.0.1:${port}/news/?cid=2`,
            outDir,
            sectionKey: "procurement",
            sectionLabel: "จัดซื้อจัดจ้าง",
            logger: () => {},
            delayMsPerDownload: 0,
            delayMsPerListing: 0,
        });
        assert.strictEqual(result.detailCount, 2);
        assert.strictEqual(result.fileCount, 2);
        assert.strictEqual(result.fileAuditSummary.downloaded, 2);
        const row701 = result.rows.find((row) => String(row.detailId) === "701");
        assert(row701, "missing row 701");
        assert.strictEqual(row701.publishedRaw, "11 มิ.ย. 2569");
        assert.strictEqual(row701.sectionLabel, "จัดซื้อจัดจ้าง");
        assert(fs.existsSync(row701.recordTextPath), "announcement TXT was not created");
        const txt = fs.readFileSync(row701.recordTextPath, "utf8");
        assert(txt.includes("หัวข้อหลัก: จัดซื้อจัดจ้าง"));
        assert(txt.includes("เรื่อง: ข่าว 701"));
        assert(txt.includes("ประกาศเมื่อ: 11 มิ.ย. 2569"));
    } finally {
        server.close();
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log("parser integration tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
