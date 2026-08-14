const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const browserSource = fs.readFileSync(path.join(root, "src", "browser-client.js"), "utf8");

// helper กันรอค้างไม่มีที่สิ้นสุด ต้องมีและใช้กับทุกจุดที่รอ network response
assert.match(browserSource, /function settleWithTimeout\(promise, timeoutMs\)/);
assert.match(browserSource, /Promise\.race\(\[promise, timeoutPromise\]\)/);

// warmRefererAssetCache: รอ response ที่ค้างบนหน้า referer ต้องมีเพดานเวลา
// (เดิมรอ Promise.allSettled จนครบทุก response -> ค้างกับ widget นอกเว็บที่โหลดไม่จบ)
const warmSection = browserSource.slice(
    browserSource.indexOf("async function warmRefererAssetCache"),
    browserSource.indexOf("async function getRefererAssetCache"),
);
assert.match(warmSection, /BROWSER_ASSET_SETTLE_TIMEOUT_MS/);
assert.match(warmSection, /settleWithTimeout\(Promise\.allSettled\(\[\.\.\.pending\]\), settleTimeoutMs\)/);
assert.match(warmSection, /settleWithTimeout\(Promise\.allSettled\(\[\.\.\.cdpPending\]\), settleTimeoutMs\)/);

// download stream (Chrome download) ต้องมีเพดานเวลา — เดิม for await จนจบไม่มี timeout
const downloadSection = browserSource.slice(
    browserSource.indexOf("const stream = await download.createReadStream()"),
    browserSource.indexOf("const capturedRaw = await capturedResponseResult"),
);
assert.match(downloadSection, /BROWSER_DOWNLOAD_STREAM_TIMEOUT_MS/);
assert.match(downloadSection, /Promise\.race\(\[/);
assert.match(downloadSection, /streamTimedOut/);
assert.match(downloadSection, /assertNotStopped\(requestOptions\.shouldStop\)/);

// raw request ผ่าน CDP ต้องมี timeout สั้นเฉพาะตัว — เดิมใช้ BROWSER_TIMEOUT_MS (90s)
// ซ้อนกับ timeout ของ page.goto ทำให้ fallback chain ค้างได้หลายนาทีต่อ URL
const rawRequestSection = browserSource.slice(
    browserSource.indexOf("async function browserContextRawRequest"),
    browserSource.indexOf("async function capturedResponseResult"),
);
assert.match(rawRequestSection, /BROWSER_RAW_TIMEOUT_MS/);
assert.match(rawRequestSection, /htmlWrapperHosts\.add/);

// downloadWithBrowser ต้องมีเพดานเวลารวม (deadline) ครอบทั้ง fallback chain
// และแปลง STOP_ERROR ที่เกิดจาก deadline เป็น error ของไฟล์เดียว (ไม่หยุดงาน)
const downloadWrapperSection = browserSource.slice(
    browserSource.indexOf("async function downloadWithBrowser("),
    browserSource.indexOf("async function downloadWithBrowserInner"),
);
assert.match(downloadWrapperSection, /DOWNLOAD_TOTAL_TIMEOUT_MS/);
assert.match(downloadWrapperSection, /deadlinePassed/);
assert.match(downloadWrapperSection, /DOWNLOAD_TIMEOUT_EXCEEDED/);
assert.match(downloadWrapperSection, /shouldStop: \(\) => userShouldStop\(\) \|\| deadlinePassed\(\)/);

// host ที่ยืนยันว่าตอบ HTML ต้องลัดขั้นตอนแพง ๆ: ข้ามอุ่น session ผ่าน referer
// (คนละ origin), จำกัดเวลารอเปิดหน้า URL ไฟล์, และข้ามการขอ raw รอบสอง
const innerDownloadSection = browserSource.slice(
    browserSource.indexOf("async function downloadWithBrowserInner"),
    browserSource.indexOf("async function captureRenderedPageSnapshot"),
);
assert.match(innerDownloadSection, /confirmedHtmlWrapper/);
assert.match(innerDownloadSection, /ข้ามการอุ่น session ผ่านหน้าอ้างอิง/);
assert.match(innerDownloadSection, /ข้ามการขอ response ซ้ำรอบสอง/);
assert.match(innerDownloadSection, /BROWSER_HTML_RETRY_TIMEOUT_MS/);

console.log("browser-timeout-guards contract tests passed");
