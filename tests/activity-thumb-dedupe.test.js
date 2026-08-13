const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scrapeActivityPictures } = require("../src/scrapers/activity");
const { createFileStore } = require("../src/file-store");
const { closeBrowserConnection } = require("../src/browser-client");

// บังคับโหมด HTTP — เทสต์นี้ใช้ HTTP server ท้องถิ่นเท่านั้น ไม่แตะ Chrome/CDP
process.env.BROWSER_MODE = "http";

// รูป thumb กับไฟล์เต็มต้องมีเนื้อหาต่างกัน (SHA-256 ต่างกัน) จำลองเว็บ PASWorld
// ที่แสดงรูปเดียวกัน 2 URL: t_xxx (thumb เล็ก) และ xxx (ไฟล์เต็ม)
const fullA = Buffer.from("full-image-A-bytes-20180319-1111");
const fullB = Buffer.from("full-image-B-bytes-20180319-2222");
const thumbA = Buffer.from("thumb-A-small");
const thumbB = Buffer.from("thumb-B-small");
const thumbC = Buffer.from("thumb-C-small");

async function main() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const send = (buffer) => {
            res.writeHead(200, { "content-type": "image/jpeg" });
            res.end(buffer);
        };

        // ไฟล์เต็ม (photoThumbnail/albums/a9001_a/...)
        if (url.pathname === "/photoThumbnail/albums/a9001_a/1_resize_A_20180319.jpg") return send(fullA);
        if (url.pathname === "/photoThumbnail/albums/a9001_a/2_resize_B_20180319.jpg") return send(fullB);
        // thumb (อยู่ใต้ /thumb/ และชื่อขึ้นต้น t_)
        if (url.pathname === "/photoThumbnail/albums/a9001_a/thumb/t_1_resize_A_20180319.jpg") return send(thumbA);
        if (url.pathname === "/photoThumbnail/albums/a9001_a/thumb/t_2_resize_B_20180319.jpg") return send(thumbB);
        // รูปที่ 3 มีแค่ thumb ไม่มีไฟล์เต็มในหน้า
        if (url.pathname === "/photoThumbnail/albums/a9001_a/thumb/t_3_resize_C_20180319.jpg") return send(thumbC);

        if (url.pathname === "/gallery/detail/9001/data.html") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`
                <html><head><title>กิจกรรม 9001</title></head><body>
                    <h1>กิจกรรม 9001</h1>
                    <div class="detail">รายละเอียดกิจกรรมอัลบั้มทดสอบ thumb/full</div>
                    <a class="glightbox" href="/photoThumbnail/albums/a9001_a/1_resize_A_20180319.jpg">
                        <img src="/photoThumbnail/albums/a9001_a/thumb/t_1_resize_A_20180319.jpg">
                    </a>
                    <a class="glightbox" href="/photoThumbnail/albums/a9001_a/2_resize_B_20180319.jpg">
                        <img src="/photoThumbnail/albums/a9001_a/thumb/t_2_resize_B_20180319.jpg">
                    </a>
                    <img src="/photoThumbnail/albums/a9001_a/thumb/t_3_resize_C_20180319.jpg">
                </body></html>
            `);
            return;
        }

        if (url.pathname === "/gallery" || url.pathname === "/gallery/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<a href="/gallery/detail/9001/data.html">กิจกรรม 9001</a>`);
            return;
        }

        res.writeHead(404).end("not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-activity-thumb-"));
    const indexPath = path.join(outDir, "file-index.json");

    try {
        const fileStore = createFileStore({ indexPath, logger: () => {} });
        const result = await scrapeActivityPictures({
            startUrl: `http://127.0.0.1:${port}/gallery`,
            outDir,
            logger: () => {},
            fileStore,
        });
        fileStore.save();

        assert.strictEqual(result.activityCount, 1, "ควรเจอ 1 อัลบั้ม");
        assert(result.imageCount >= 5, "อ้างอิงรูปควรมีครบ 5 รายการ (full A, t_1, full B, t_2, t_3)");

        // โฟลเดอร์อัลบั้ม
        const albumDir = fs
            .readdirSync(outDir)
            .find((name) => fs.statSync(path.join(outDir, name)).isDirectory());
        assert(albumDir, "ควรมีโฟลเดอร์อัลบั้ม");
        const savedFiles = fs.readdirSync(path.join(outDir, albumDir));
        const images = savedFiles.filter((f) => /\.jpg$/i.test(f));

        // ไฟล์บนดิสก์ต้องมี 3 ไฟล์เท่านั้น: full A, full B, thumb C
        // (t_1, t_2 ต้องไม่ถูกเขียนลงดิสก์ เพราะซ้ำกับไฟล์เต็ม)
        assert.strictEqual(images.length, 3, `ควรเหลือ 3 ไฟล์ แต่เจอ: ${images.join(", ")}`);
        assert(images.includes("1_resize_A_20180319.jpg"), "ควรเก็บไฟล์เต็มรูปที่ 1");
        assert(images.includes("2_resize_B_20180319.jpg"), "ควรเก็บไฟล์เต็มรูปที่ 2");
        assert(images.includes("t_3_resize_C_20180319.jpg"), "รูปที่ไม่มีไฟล์เต็ม ควรเก็บ thumb ไว้ (ไม่ให้รูปหาย)");
        assert(
            !images.some((f) => f.startsWith("t_1_") || f.startsWith("t_2_")),
            "thumb ที่มีคู่ไฟล์เต็มต้องไม่ถูกบันทึกเป็นไฟล์แยก",
        );

        // index ต้องจด URL thumb ชี้ไปไฟล์เต็ม (รอบถัดไปข้ามได้ทันที)
        const t1Rec = fileStore.find("http://127.0.0.1:" + port + "/photoThumbnail/albums/a9001_a/thumb/t_1_resize_A_20180319.jpg");
        assert(t1Rec, "index ควรมี record ของ thumb t_1");
        assert(
            path.basename(t1Rec.localPath).startsWith("1_resize_A"),
            `thumb t_1 ควรชี้ไปไฟล์เต็ม แต่ชี้ไป: ${path.basename(t1Rec.localPath)}`,
        );
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await closeBrowserConnection();
        fs.rmSync(outDir, { recursive: true, force: true });
    }

    console.log("activity thumb/full dedupe tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
