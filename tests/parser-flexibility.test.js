const assert = require("assert");
const {
    detailIdFromUrl,
    detectParserProfile,
    discoverPageLinks,
    isLikelyDetailUrl,
    isLikelyListingUrl,
} = require("../src/scrapers/url-parser");

function hrefs(items) {
    return items.map((item) => item.href).sort();
}

// รูปแบบเก่า: cat_id + detail.php?id=...
{
    const startUrl = "https://old.go.th/news.php?cat_id=1";
    const html = `
      <a href="detail.php?id=101">ข่าวเก่า 101</a>
      <a href="news.php?cat_id=1&page=2">ถัดไป</a>
      <a href="news.php?cat_id=2&page=2">หมวดอื่น</a>
    `;
    const result = discoverPageLinks(html, startUrl, startUrl);
    assert.strictEqual(result.profile.mode, "legacy-cat_id");
    assert.strictEqual(result.details.length, 1);
    assert.strictEqual(detailIdFromUrl(result.details[0].href), "101");
    assert.strictEqual(result.listings.length, 1);
    assert(result.listings[0].href.includes("cat_id=1"));
}

// รูปแบบนาบอน: pathname + news_id + pageid
{
    const startUrl = "https://www.naboncity.go.th/datacenter/information.php";
    const html = `
      <a href="detail.php?news_id=4381">ข่าวนาบอน</a>
      <a href="information.php?pageid=2">2</a>
    `;
    const result = discoverPageLinks(html, startUrl, startUrl);
    assert.strictEqual(result.profile.mode, "path");
    assert.strictEqual(result.details.length, 1);
    assert.strictEqual(detailIdFromUrl(result.details[0].href), "4381");
    assert.strictEqual(result.listings.length, 1);
}

// รูปแบบบ้านนา: /news/?cid=2 + id/nid + page และลิงก์ onclick/data-href
{
    const startUrl = "https://www.baanna.go.th/news/?cid=2";
    const html = `
      <a href="?cid=2&id=701">ข่าวประชาสัมพันธ์ 701</a>
      <div onclick="window.location.href='/news/?cid=2&nid=702'">ข่าว 702</div>
      <div data-href="/news/view/703">ข่าว 703</div>
      <a href="?cid=2&page=2">หน้าถัดไป</a>
      <a href="?cid=3&id=999">ข่าวคนละหมวด</a>
    `;
    const result = discoverPageLinks(html, startUrl, startUrl);
    assert.strictEqual(result.profile.mode, "modern-cid");
    assert.strictEqual(result.details.length, 3);
    assert(hrefs(result.details).some((url) => url.includes("id=701")));
    assert(hrefs(result.details).some((url) => url.includes("nid=702")));
    assert(hrefs(result.details).some((url) => url.includes("/news/view/703")));
    assert.strictEqual(result.listings.length, 1);
    assert(result.listings[0].href.includes("cid=2"));
}

// pagination แบบ path ต้องไม่ถูกนับเป็น detail
{
    const startUrl = "https://example.go.th/news/?cid=2";
    const pageUrl = "https://example.go.th/news/page/2/?cid=2";
    assert.strictEqual(isLikelyDetailUrl(pageUrl, { startUrl }), false);
    assert.strictEqual(isLikelyListingUrl(pageUrl, { startUrl }), true);
}

// detail แบบ path slug
{
    const startUrl = "https://example.go.th/news/?cid=2";
    const detailUrl = "https://example.go.th/news/view/public-relations-123";
    assert.strictEqual(isLikelyDetailUrl(detailUrl, { startUrl }), true);
    assert.strictEqual(detailIdFromUrl(detailUrl), "public-relations-123");
}

// รูปแบบ PHP รุ่นเก่าแบบตลิ่งชัน: news.php?cat_id=1, JavaScript popup และ pagenum
{
    const startUrl = "https://www.talingchanlocal.go.th/news.php?cat_id=1";
    const html = `
      <a href="javascript:MM_openBrWindow('news_detail.php?news_id=912','','scrollbars=yes')">
        ข่าวประชาสัมพันธ์ 912
      </a>
      <tr onclick="window.open('detail_news.php?id=913&cat_id=1')">
        <td>ข่าวประชาสัมพันธ์ 913</td>
      </tr>
      <a href="news.php?cat_id=1&pagenum=2">หน้าถัดไป</a>
      <a href="news.php?cat_id=2&pagenum=2">หมวดอื่น</a>
    `;
    const result = discoverPageLinks(html, startUrl, startUrl);
    assert.strictEqual(result.profile.mode, "legacy-cat_id");
    assert.strictEqual(result.details.length, 2);
    assert(hrefs(result.details).some((url) => url.includes("news_id=912")));
    assert(hrefs(result.details).some((url) => url.includes("id=913")));
    assert.strictEqual(result.listings.length, 1);
    assert(result.listings[0].href.includes("pagenum=2"));
}

console.log("parser flexibility tests passed");
