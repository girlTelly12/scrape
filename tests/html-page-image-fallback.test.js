const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const browserSource = fs.readFileSync(path.join(root, "src", "browser-client.js"), "utf8");

// Fallback เปิดหน้า HTML แล้วหารูปจริง ต้องถูกเรียกเมื่อคาดหวังไฟล์
assert.match(browserSource, /extractImageFromHtmlPage/);
assert.match(browserSource, /og:image/);
assert.match(browserSource, /link\[rel="image_src"\]/);
assert.match(browserSource, /html-page-image-fallback/);
assert.match(browserSource, /if \(requestOptions\.expectFile\) \{/);

// ต้องแทรกใน downloadWithBrowser ก่อนคืนผล HTML ปกติ
const fallbackSection = browserSource.slice(
    browserSource.indexOf("URL ที่คาดว่าเป็นไฟล์/รูปตอบกลับเป็นหน้า HTML"),
    browserSource.indexOf("URL ที่คาดว่าเป็นไฟล์/รูปตอบกลับเป็นหน้า HTML") + 900,
);
assert.match(fallbackSection, /await extractImageFromHtmlPage\(page, url, logger, requestOptions\)/);
assert.match(fallbackSection, /if \(htmlFallback\) return htmlFallback/);

// ต้องเรียงลำดับ: og:image -> a[href] รูปเต็ม -> img ใหญ่
const extractSection = browserSource.slice(
    browserSource.indexOf("async function extractImageFromHtmlPage"),
    browserSource.indexOf("async function downloadWithBrowser"),
);
const ogIndex = extractSection.indexOf("og:image");
const anchorIndex = extractSection.indexOf('querySelectorAll("a[href]")');
const imgIndex = extractSection.indexOf("document.images");
assert.ok(ogIndex >= 0 && anchorIndex > ogIndex && imgIndex > anchorIndex, "ลำดับการค้นหารูปต้องเป็น og:image -> a[href] -> img");

// ต้องข้าม URL เอกสาร (PDF/doc) ไม่ให้ fallback ไปกู้รูปจากหน้า error
assert.ok(extractSection.includes("(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z)"), "ต้องกรอง URL เอกสารก่อน fallback");
// ต้องใช้ sameAssetTarget กันวนลูปแทนการเทียบ string ตรง ๆ
assert.match(extractSection, /sameAssetTarget\(candidate, assetUrl\)/);
// ต้องกรอง URL thumbnail/resize ออกจาก a[href] เพื่อให้ได้ภาพต้นฉบับ
assert.match(extractSection, /isThumbOrResize/);
assert.match(extractSection, /thumb\|thumbnail\|resize\|\\\/image\\\/ratio\\\//);

console.log("html-page-image-fallback contract tests passed");
