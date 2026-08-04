const assert = require("assert");
const {
    chooseBestActivityTitle,
    discoverActivityPageLinks,
    looksLikeSiteBoilerplateTitle,
    safeActivityFolderName,
} = require("../src/scrapers/activity-url-parser");
const { extractActivityDetails } = require("../src/scrapers/activity");

const startUrl = "https://www.naphopattana.go.th/album/index.php";
const detailUrl = "https://www.naphopattana.go.th/album/view.php?album_id=222";
const siteTitle = "เทศบาลตำบลนาโพธิ์พัฒนา อำเภอสวี จังหวัดชุมพร__ WWW.NAPHOPATTANA.GO.TH";
const activityTitle = "โครงการฝึกอบรมอาชีพเสริมให้แก่ประชาชน ประจำปี 2569";

assert.strictEqual(looksLikeSiteBoilerplateTitle(siteTitle, startUrl), true);
const selected = chooseBestActivityTitle([
    { value: siteTitle, weight: 200 },
    { value: activityTitle, weight: 100 },
], { pageUrl: detailUrl });
assert.strictEqual(selected.value, activityTitle);
assert(safeActivityFolderName(selected.value, "222").startsWith("222_โครงการฝึกอบรมอาชีพ"));

const listingHtml = `
<table><tr>
  <td><a href="view.php?album_id=222"><img src="thumb.jpg" alt="${siteTitle}"></a></td>
  <td class="album-title"><a href="view.php?album_id=222">${activityTitle}</a></td>
  <td>[อ่าน 10 คน] เมื่อ 3 ส.ค. 2569</td>
</tr></table>`;
const discovered = discoverActivityPageLinks(listingHtml, startUrl, startUrl, {
    detailUrlPatterns: [/view\.php\?album_id=/i],
});
assert.strictEqual(discovered.details.length, 1);
assert.strictEqual(discovered.details[0].title, activityTitle);

const detailHtml = `
<html><head><title>${siteTitle}</title></head><body>
<h2 class="album-title">${activityTitle}</h2>
<div class="detail">รายละเอียดกิจกรรมทดสอบสำหรับประชาชนในพื้นที่</div>
</body></html>`;
const details = extractActivityDetails(detailHtml, detailUrl, siteTitle);
assert.strictEqual(details.title, activityTitle);

console.log("activity title selection tests passed");
