const assert = require("assert");
const http = require("http");
const {
    alignUrlOriginToReferer,
    isDifferentOrigin,
    sameSiteIgnoringWww,
} = require("../src/url-origin");
const { fetchHtmlResult } = require("../src/common");

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
        await new Promise((resolve) => server.close(resolve));
    }

    console.log("canonical origin tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
