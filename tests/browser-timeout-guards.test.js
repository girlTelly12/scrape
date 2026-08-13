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

console.log("browser-timeout-guards contract tests passed");
