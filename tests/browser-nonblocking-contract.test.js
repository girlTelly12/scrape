const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const browserSource = fs.readFileSync(path.join(root, "src", "browser-client.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

assert.match(browserSource, /gotoHtmlPageNonBlocking/);
assert.match(browserSource, /waitUntil:\s*"commit"/);
assert.match(browserSource, /Page\.stopLoading/);
assert.match(browserSource, /BROWSER_DOM_READY_TIMEOUT_MS/);
assert.match(browserSource, /BROWSER_TAB_CLOSE_TIMEOUT_MS/);
assert.match(browserSource, /dialog\.dismiss/);
assert.match(browserSource, /ปิดแท็บ Popup/);
assert.match(appSource, /AbortController/);
assert.match(appSource, /Server รับงานแล้ว งานจะทำเบื้องหลัง/);
assert.match(appSource, /statusRefreshInFlight/);

console.log("browser non-blocking contract tests passed");
