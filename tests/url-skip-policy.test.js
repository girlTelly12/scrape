const assert = require("assert");
const {
    getUrlSkipReason,
    shouldSkipUrl,
} = require("../src/url-skip-policy");

const oldHosts = process.env.SCRAPER_SKIP_HOSTS;
const oldContains = process.env.SCRAPER_SKIP_URL_CONTAINS;
const oldDefaults = process.env.SCRAPER_USE_DEFAULT_SKIP_HOSTS;

try {
    delete process.env.SCRAPER_SKIP_HOSTS;
    delete process.env.SCRAPER_SKIP_URL_CONTAINS;
    process.env.SCRAPER_USE_DEFAULT_SKIP_HOSTS = "true";

    assert.strictEqual(
        shouldSkipUrl("https://info.go.th/service-point/94e56a14-534a-4dcd-b4bd-034b36dea487/procedures"),
        true,
    );
    assert.strictEqual(shouldSkipUrl("https://www.info.go.th/anything"), true);
    assert.strictEqual(shouldSkipUrl("https://sub.info.go.th/anything"), true);
    assert.strictEqual(shouldSkipUrl("https://www.nathamnuae.go.th/detail.php?id=3626"), false);
    assert.match(getUrlSkipReason("https://info.go.th/test"), /ห้ามเปิด/);

    // Google Drive/Docs viewer — ดาวน์โหลดไฟล์ดิบตรงไม่ได้ (ตอบ HTML viewer เสมอ)
    assert.strictEqual(
        shouldSkipUrl("https://drive.google.com/file/d/119_bi_c3cUlfCuZbxgxkoZNqS72Q7U_l/preview"),
        true,
    );
    assert.strictEqual(shouldSkipUrl("https://drive.google.com/file/d/abc123/view"), true);
    assert.strictEqual(shouldSkipUrl("https://docs.google.com/file/d/xyz/preview"), true);
    assert.match(getUrlSkipReason("https://drive.google.com/file/d/abc/preview"), /Google Drive viewer/);
    // รูปแบบที่ตอบไฟล์ดิบจริงต้องไม่ถูกข้าม
    assert.strictEqual(shouldSkipUrl("https://drive.google.com/uc?export=download&id=abc123"), false);
    assert.strictEqual(shouldSkipUrl("https://drive.usercontent.google.com/download?id=abc123"), false);

    process.env.SCRAPER_USE_DEFAULT_SKIP_HOSTS = "false";
    process.env.SCRAPER_SKIP_HOSTS = "example.go.th";
    assert.strictEqual(shouldSkipUrl("https://info.go.th/test"), false);
    assert.strictEqual(shouldSkipUrl("https://www.example.go.th/test"), true);

    process.env.SCRAPER_SKIP_URL_CONTAINS = "/private-preview/";
    assert.strictEqual(shouldSkipUrl("https://other.go.th/private-preview/123"), true);

    console.log("url skip policy tests passed");
} finally {
    if (oldHosts === undefined) delete process.env.SCRAPER_SKIP_HOSTS;
    else process.env.SCRAPER_SKIP_HOSTS = oldHosts;
    if (oldContains === undefined) delete process.env.SCRAPER_SKIP_URL_CONTAINS;
    else process.env.SCRAPER_SKIP_URL_CONTAINS = oldContains;
    if (oldDefaults === undefined) delete process.env.SCRAPER_USE_DEFAULT_SKIP_HOSTS;
    else process.env.SCRAPER_USE_DEFAULT_SKIP_HOSTS = oldDefaults;
}
