const assert = require("node:assert/strict");
const {
  canonicalUrl,
  classifyAsset,
  isPublicPageUrl,
  ASSET_EXT_RE,
} = require("../src/scrapers/site-migration");

assert.equal(
  canonicalUrl("https://www.example.go.th/page.php?utm_source=x&id=10#top"),
  "https://www.example.go.th/page.php?id=10",
);
assert.equal(classifyAsset("https://example.go.th/files/report.PDF"), "documents");
assert.equal(classifyAsset("https://cdn.example.com/photo.webp"), "images");
assert.equal(classifyAsset("https://cdn.example.com/app.js"), "scripts");
assert.equal(classifyAsset("https://cdn.example.com/font.woff2"), "fonts");
assert.equal(isPublicPageUrl("https://example.go.th/news.php?id=10"), true);
assert.equal(isPublicPageUrl("https://example.go.th/admin/login.php"), false);
assert.equal(isPublicPageUrl("https://example.go.th/files/report.pdf"), false);
assert.equal(ASSET_EXT_RE.test("https://example.go.th/file.xlsx?download=1"), true);

console.log("full site migration tests passed");
