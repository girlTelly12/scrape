const assert = require("assert");
const http = require("http");
const {
    alignUrlOriginToReferer,
    isDifferentOrigin,
    sameSiteIgnoringWww,
} = require("../src/url-origin");
const { fetchHtmlResult } = require("../src/common");

// test นี้ตั้งใจให้รันกับ HTTP server ท้องถิ่นเท่านั้น ต้องบังคับโหมด HTTP
// ไม่งั้นถ้าเครื่องตั้ง BROWSER_MODE=cdp ไว้ ทุกการดาวน์โหลดจะเปิด CDP connection
// ไป Chrome:9222 แล้วไม่มีการปิด ทำให้ process ค้างหลัง assert ผ่านหมดแล้ว
process.env.BROWSER_MODE = "http";

async function main() {
    assert.strictEqual(
        sameSiteIgnoringWww(
            "https://www.baanna.go.th/gallery/detail/22807/tmp/picture.png",
            "https://baanna.go.th/gallery/detail/22807/data.html",
        ),
        true,
    );
    assert.strictEqual(
        alignUrlOriginToReferer(
            "https://www.baanna.go.th/gallery/detail/22807/tmp/picture.png",
            "https://baanna.go.th/gallery/detail/22807/data.html",
        ),
        "https://baanna.go.th/gallery/detail/22807/tmp/picture.png",
    );
    assert.strictEqual(
        alignUrlOriginToReferer(
            "https://files.example.org/photo.png",
            "https://baanna.go.th/gallery/detail/22807/data.html",
        ),
        "https://files.example.org/photo.png",
    );
    assert.strictEqual(
        isDifferentOrigin("https://www.baanna.go.th/a", "https://baanna.go.th/a"),
        true,
    );

    const server = http.createServer((req, res) => {
        if (req.url === "/start") {
            res.writeHead(302, { location: "/final" });
            res.end();
            return;
        }
        if (req.url === "/final") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<html><body>redirect-ok</body></html>");
            return;
        }
        res.writeHead(404).end("not found");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
        const result = await fetchHtmlResult(`http://127.0.0.1:${port}/start`, () => {});
        assert.strictEqual(result.finalUrl, `http://127.0.0.1:${port}/final`);
        assert(result.html.includes("redirect-ok"));
    } finally {
        // HTTP client ส่ง Connection: keep-alive ทำให้ server.close() รอ socket ค้างไม่มีวันจบ
        // ต้องตัด connection ทิ้งก่อน เช่นเดียวกับ activity-parser-integration.test.js
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        // global agent เก็บ keep-alive socket ไว้ใน pool โดยไม่มี idle timeout
        // ต้อง destroy ทิ้ง ไม่งั้น process ไม่ยอม exit หลัง assert ผ่านหมดแล้ว
        http.globalAgent.destroy();
    }

    console.log("canonical origin tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
