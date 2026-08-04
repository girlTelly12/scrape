const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    cleanAnnouncementTitle,
    extractListingAnnouncementMetadata,
    extractPublishedRaw,
    writeAnnouncementTextFile,
} = require("../src/scrapers/announcement-metadata");
const { extractNavigationLinks } = require("../src/scrapers/url-parser");

const rowText =
    "แบบฟอร์มขออนุมัติเบิกจ่ายน้ำมันเชื้อเพลิงขององค์การบริหารส่วนตำบลนาท่ามเหนือ " +
    "💾 [อ่าน 10 คน] เมื่อ 11 มิ.ย. 2569";

const meta = extractListingAnnouncementMetadata(rowText, rowText);
assert.strictEqual(
    meta.title,
    "แบบฟอร์มขออนุมัติเบิกจ่ายน้ำมันเชื้อเพลิงขององค์การบริหารส่วนตำบลนาท่ามเหนือ",
);
assert.strictEqual(meta.publishedRaw, "11 มิ.ย. 2569");
assert.strictEqual(extractPublishedRaw("ประกาศเมื่อวันที่ 5 กรกฎาคม 2568 เวลา 09:30 น."), "5 กรกฎาคม 2568 เวลา 09:30 น.");
assert.strictEqual(cleanAnnouncementTitle("เรื่อง: ทดสอบประกาศ [อ่าน 5 คน] เมื่อ 1/8/2569"), "ทดสอบประกาศ");

const html = `<table><tr><td><a href="detail.php?id=3626">${rowText}</a></td></tr></table>`;
const links = extractNavigationLinks(html, "https://example.go.th/news.php?cat_id=1");
assert.strictEqual(links.length, 1);
assert(links[0].contextText.includes("11 มิ.ย. 2569"), "listing context should include the date beside the link");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "announcement-text-"));
try {
    const output = writeAnnouncementTextFile(tmp, {
        sectionLabel: "จัดซื้อจัดจ้าง",
        title: meta.title,
        publishedRaw: meta.publishedRaw,
        listingUrl: "https://example.go.th/news.php?cat_id=1",
        detailUrl: "https://example.go.th/detail.php?id=3626",
        detailText: "รายละเอียดทดสอบ",
        scrapedAt: "2026-08-03T06:00:00.000Z",
    });
    const buffer = fs.readFileSync(output);
    assert.strictEqual(buffer[0], 0xef, "TXT should contain UTF-8 BOM");
    const text = buffer.toString("utf8");
    assert(text.includes("หัวข้อหลัก: จัดซื้อจัดจ้าง"));
    assert(text.includes(`เรื่อง: ${meta.title}`));
    assert(text.includes("ประกาศเมื่อ: 11 มิ.ย. 2569"));
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("announcement metadata tests passed");
