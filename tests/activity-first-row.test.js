const assert = require("assert");
const { discoverActivityPageLinks } = require("../src/scrapers/activity-url-parser");

const startUrl = "https://www.naphopattana.go.th/album/index.php";

// จำลอง HTML เว็บเก่าที่ลิงก์รายการแรกปิด </a> ไม่สมบูรณ์
const malformedFirstRowHtml = `
<table>
  <tr>
    <td>1</td>
    <td><a href="activities.php?salb_id=241">กิจกรรมวันเด็ก 2569</td>
    <td>21</td><td>0</td>
  </tr>
  <tr>
    <td>2</td>
    <td><a href="activities.php?salb_id=240">สวัสดีปีใหม่ 2569</a></td>
    <td>21</td><td>0</td>
  </tr>
</table>`;

const result = discoverActivityPageLinks(
  malformedFirstRowHtml,
  startUrl,
  startUrl,
  {},
);

assert.strictEqual(result.details.length, 2, "ต้องพบกิจกรรมทั้ง 2 รายการ");
assert.strictEqual(result.details[0].activityId, "241", "ต้องเก็บรายการแรกก่อน");
assert.strictEqual(result.details[0].title, "กิจกรรมวันเด็ก 2569");
assert.strictEqual(result.details[1].activityId, "240");
assert.strictEqual(result.details[1].title, "สวัสดีปีใหม่ 2569");

console.log("activity first-row/order tests passed");
