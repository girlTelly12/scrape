const assert = require("assert");
const { extractPageTitle, isSiteNameish, resolvePageTitles } = require("../src/page-title");

// h1/h2 ต้องชนะ title tag ที่เป็นชื่อเว็บ
{
    const html = `
        <html><head>
            <title>องค์การบริหารส่วนตำบลหงษ์เจริญ : อำเภอท่าแซะ จังหวัดชุมพร:: WWW.HONGCHAROEN.GO.TH</title>
        </head><body>
            <h1>ข่าวประชาสัมพันธ์</h1>
            <a href="information.php">ข่าวประชาสัมพันธ์</a>
        </body></html>`;
    assert.strictEqual(extractPageTitle(html, "https://www.hongcharoen.go.th/datacenter1/information.php"), "ข่าวประชาสัมพันธ์");
}

// breadcrumb อันสุดท้าย
{
    const html = `
        <html><head><title>อบต.หงษ์เจริญ</title></head><body>
        <nav class="breadcrumb">
            <a href="/">หน้าแรก</a> »
            <a href="/datacenter1/">ศูนย์ข้อมูลข่าวสาร</a> »
            <a href="/datacenter1/information.php">ข่าวประชาสัมพันธ์</a>
        </nav>
        </body></html>`;
    assert.strictEqual(extractPageTitle(html, "https://www.hongcharoen.go.th/datacenter1/information.php"), "ข่าวประชาสัมพันธ์");
}

// breadcrumb แบบข้อความล้วน (คั่นด้วย »)
{
    const html = `<html><body><div class="path">หน้าแรก » ข่าวจัดซื้อ - จัดจ้าง</div></body></html>`;
    assert.strictEqual(
        extractPageTitle(html, "https://www.hongcharoen.go.th/datacenter1/procedure.php"),
        "ข่าวจัดซื้อ - จัดจ้าง",
    );
}

// title tag ตัดส่วนชื่อเว็บออก
{
    const html = `<html><head><title>ข่าวจัดซื้อ - จัดจ้าง | อบต.หงษ์เจริญ</title></head><body></body></html>`;
    const title = extractPageTitle(html, "https://www.hongcharoen.go.th/datacenter1/procedure.php");
    assert.strictEqual(title, "ข่าวจัดซื้อ - จัดจ้าง");
}

// og:title
{
    const html = `<html><head><meta property="og:title" content="แผนพัฒนาท้องถิ่น" /></head><body></body></html>`;
    assert.strictEqual(extractPageTitle(html, "https://www.hongcharoen.go.th/datacenter1/plan1.php"), "แผนพัฒนาท้องถิ่น");
}

// fallback จาก path เมื่อหาไม่เจอ
{
    assert.strictEqual(
        extractPageTitle("<html><body>เนื้อหา</body></html>", "https://www.hongcharoen.go.th/datacenter1/information.php"),
        "information",
    );
}

// isSiteNameish รู้จักชื่อเว็บ
{
    assert(isSiteNameish("อบต.หงษ์เจริญ", "https://www.hongcharoen.go.th/"));
    assert(isSiteNameish("องค์การบริหารส่วนตำบลหงษ์เจริญ", "https://www.hongcharoen.go.th/"));
    assert(isSiteNameish("หน้าแรก", "https://www.hongcharoen.go.th/"));
    assert(!isSiteNameish("ข่าวประชาสัมพันธ์", "https://www.hongcharoen.go.th/"));
}

// resolvePageTitles เรียก fetchHtml ตามจำนวน URL และคืนผลลัพธ์ครบ
// + จัดการ fetch ล้มเหลวโดยไม่ทำรายการอื่นพัง
async function runResolveTests() {
    let fetched = [];
    const fakeFetch = async (url) => {
        fetched.push(url);
        return `<html><head><title>หมวด ${new URL(url).pathname.split("/").pop()}</title></head><body></body></html>`;
    };
    const urls = [
        "https://www.hongcharoen.go.th/datacenter1/information.php",
        "https://www.hongcharoen.go.th/datacenter1/procedure.php",
        "not-a-url",
    ];
    const results = await resolvePageTitles(urls, null, { fetchHtml: fakeFetch, delayMs: 0, concurrency: 2 });
    assert.strictEqual(fetched.length, 2, "ต้อง fetch เฉพาะ URL ที่ใช้ได้");
    assert.strictEqual(results.length, 2, "URL ที่ไม่ถูกต้องต้องถูกกรองทิ้ง");
    assert(results.every((row) => row.ok && row.title), JSON.stringify(results));
    assert(results.some((row) => row.url.includes("information.php")));

    const failingFetch = async (url) => {
        if (url.includes("information")) throw new Error("HTTP 403 on page (test)");
        return `<html><head><title>หมวดจัดซื้อ</title></head><body></body></html>`;
    };
    const mixed = await resolvePageTitles(
        [
            "https://www.hongcharoen.go.th/datacenter1/information.php",
            "https://www.hongcharoen.go.th/datacenter1/procedure.php",
        ],
        null,
        { fetchHtml: failingFetch, delayMs: 0 },
    );
    const failed = mixed.find((row) => row.url.includes("information"));
    const ok = mixed.find((row) => row.url.includes("procedure"));
    assert.strictEqual(failed.ok, false);
    assert(failed.error && /403/.test(failed.error));
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.title, "หมวดจัดซื้อ");
}

runResolveTests().then(() => console.log("page title tests passed"));
