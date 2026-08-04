const assert = require("assert");
const { getVendorAdapter, listVendorAdapters } = require("../src/vendors/registry");
const { discoverPageLinks } = require("../src/scrapers/url-parser");
const { discoverActivityPageLinks } = require("../src/scrapers/activity-url-parser");

const adapters = listVendorAdapters();
for (const id of ["cjworld", "pasworld", "dungbhumi", "generic"]) {
    assert(adapters.some((adapter) => adapter.id === id), `missing ${id}`);
}

const cj = getVendorAdapter("cjworld");
assert.strictEqual(cj.id, "cjworld");
assert(cj.profile.news.detailUrlPatterns.length > 0);
assert(cj.profile.activity.detailUrlPatterns.length > 0);

const newsHtml = `<a href="data_record.php?record=55">ประกาศทดสอบสำหรับประชาชน</a>`;
const newsResult = discoverPageLinks(
    newsHtml,
    "https://example.go.th/datacenter/procedure.php",
    "https://example.go.th/datacenter/procedure.php",
    {
        detailUrlPatterns: [/\/datacenter\/data_record\.php\?record=\d+/i],
    },
);
assert.strictEqual(newsResult.details.length, 1);

const activityHtml = `<a href="custom_album.php?album_key=ABC123">ภาพกิจกรรมทดสอบ</a>`;
const activityResult = discoverActivityPageLinks(
    activityHtml,
    "https://example.go.th/album/index.php",
    "https://example.go.th/album/index.php",
    {
        detailUrlPatterns: [/custom_album\.php\?album_key=/i],
    },
);
assert.strictEqual(activityResult.details.length, 1);

console.log("vendor adapter registry tests passed");
