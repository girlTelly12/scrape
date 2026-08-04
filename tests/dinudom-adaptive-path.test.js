const assert = require("assert");
const {
    detailIdFromUrl,
    discoverPageLinks,
    isLikelyListingUrl,
} = require("../src/scrapers/url-parser");
const {
    discoverActivityPageLinks,
    isGenericActivitySiblingDetailUrl,
} = require("../src/scrapers/activity-url-parser");

const dinudomTopics = [
    "procedure.php",
    "information.php",
    "statement.php",
    "plan_3.php",
    "rank.php",
    "plan_y.php",
    "rule.php",
    "borihan.php",
    "finance.php",
    "plan_m.php",
    "plan_t0.php",
    "result.php",
];

for (const route of dinudomTopics) {
    const startUrl = `https://www.dinudom.go.th/datacenter/${route}`;
    const base = route.replace(/\.php$/i, "");
    const html = `
      <a href="${base}_data.php?record=501">ประกาศทดสอบของหมวด ${base}</a>
      <a href="${route}?pageid=2">หน้าถัดไป</a>
      <a href="/index.php">หน้าแรก</a>
    `;
    const result = discoverPageLinks(html, startUrl, startUrl);
    assert.strictEqual(result.details.length, 1, `${route} must find one detail`);
    assert.strictEqual(detailIdFromUrl(result.details[0].href), "501");
    assert.strictEqual(result.listings.length, 1, `${route} must find pagination`);
    assert.strictEqual(isLikelyListingUrl(result.listings[0].href, { startUrl }), true);
}

{
    const startUrl = "https://www.dinudom.go.th/datacenter/statement.php";
    const html = `
      <a href="statement_view.php?rid=AB12-CD34-EF56">ข้อบัญญัติงบประมาณรายจ่าย ประจำปี</a>
      <a href="contact.php?id=999">ติดต่อเรา</a>
      <a href="statement.php?page=3">3</a>
    `;
    const result = discoverPageLinks(html, startUrl, startUrl);
    assert.strictEqual(result.details.length, 1);
    assert(result.details[0].href.includes("statement_view.php"));
}

{
    const startUrl = "https://www.dinudom.go.th/album/index.php";
    const html = `
      <a href="data.php?record=9001">กิจกรรมประชุมประชาคมหมู่บ้าน</a>
      <a href="album_detail.php?album=9002">กิจกรรมปลูกต้นไม้</a>
      <a href="index.php?pageid=2">หน้าถัดไป</a>
      <a href="../contact.php?id=1">ติดต่อหน่วยงาน</a>
    `;
    const result = discoverActivityPageLinks(html, startUrl, startUrl);
    assert.deepStrictEqual(
        result.details.map((row) => row.activityId).sort(),
        ["9001", "9002"],
    );
    assert.strictEqual(result.listings.length, 1);
    assert.strictEqual(
        isGenericActivitySiblingDetailUrl(
            "https://www.dinudom.go.th/album/data.php?record=9001",
            { startUrl, hostname: "www.dinudom.go.th" },
            "กิจกรรมประชุมประชาคมหมู่บ้าน",
        ),
        true,
    );
}

console.log("dinudom adaptive path tests passed");
