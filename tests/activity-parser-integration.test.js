const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scrapeActivityPictures } = require("../src/scrapers/activity");

async function main() {
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
    );
    const mp4 = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from("ftypisom0000isom"),
    ]);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");

        if (/^\/storage\/gallery\/(22807|21129)\/full\.png$/.test(url.pathname)) {
            // จำลองเซิร์ฟเวอร์ที่ตั้ง Content-Type ผิด แต่ข้อมูลเป็น PNG จริง
            res.writeHead(200, { "content-type": "text/html" });
            res.end(png);
            return;
        }

        if (url.pathname === "/media/activity-22807.mp4") {
            res.writeHead(200, { "content-type": "video/mp4" });
            res.end(mp4);
            return;
        }

        if (url.pathname === "/documents/activity-22807.pdf") {
            res.writeHead(200, { "content-type": "application/pdf" });
            res.end(pdf);
            return;
        }

        if (url.pathname === "/gallery/detail/22807/data.html") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`
                <html><head><title>กิจกรรม 22807</title></head><body>
                    <h1>กิจกรรม 22807</h1>
                    <div>วันที่ลงข่าว : 1 สิงหาคม 2569 เวลา 09:30 น.</div>
                    <div class="detail">รายละเอียดกิจกรรมสำหรับประชาชนในพื้นที่</div>
                    <a class="glightbox" data-gallery="activity" href="/storage/gallery/22807/full.png">ดูภาพ</a>
                    <video controls><source src="/media/activity-22807.mp4" type="video/mp4"></video>
                    <a href="/documents/activity-22807.pdf">รายงานกิจกรรม PDF</a>
                    <iframe src="https://www.youtube.com/embed/abc123"></iframe>
                </body></html>
            `);
            return;
        }

        if (url.pathname === "/gallery/detail/21129/data.html") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`
                <html><head><title>กิจกรรม 21129</title></head><body>
                    <a class="fancybox" href="/storage/gallery/21129/full.png">ดูภาพ</a>
                </body></html>
            `);
            return;
        }

        if (url.pathname === "/gallery" && url.searchParams.get("page") === "2") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<a href="/gallery/detail/21129/data.html">กิจกรรม 21129</a>`);
            return;
        }

        if (url.pathname === "/gallery" || url.pathname === "/gallery/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`
                <a href="/gallery/detail/22807/data.html">กิจกรรม 22807</a>
                <a href="/gallery?page=2">หน้าถัดไป</a>
            `);
            return;
        }

        res.writeHead(404).end("not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-gallery-"));

    try {
        const result = await scrapeActivityPictures({
            startUrl: `http://127.0.0.1:${port}/gallery`,
            outDir,
            logger: () => {},
        });
        assert.strictEqual(result.activityCount, 2);
        assert(result.imageCount >= 2);
        assert(result.fileAuditSummary.downloaded >= 4);
        assert(result.rows.length >= 2);
        assert.strictEqual(result.detailRows.length, 2);
        assert(result.detailRows.some((row) => row.detailText.includes("รายละเอียดกิจกรรมสำหรับประชาชน")));
        const detailRow = result.detailRows.find((row) => row.albumId === "22807");
        assert(detailRow && fs.existsSync(detailRow.detailTextPath));
        const detailText = fs.readFileSync(detailRow.detailTextPath, "utf8");
        assert(detailText.includes("09:30"));
        assert(result.mediaRows.some((row) => row.mediaType === "video" && row.isDownloaded));
        assert(result.mediaRows.some((row) => row.mediaType === "video_embed" && row.mediaProvider === "youtube"));
        assert(result.mediaRows.some((row) => row.mediaType === "document" && row.pdfStoredInDb));
        for (const row of result.rows) assert(fs.existsSync(row.localPath));
        assert(result.rows.filter((row) => row.imageName.endsWith(".png")).length >= 2);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(outDir, { recursive: true, force: true });
    }

    console.log("activity parser integration tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
