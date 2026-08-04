const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dbSource = fs.readFileSync(path.join(root, "src", "db.js"), "utf8");
const newsSource = fs.readFileSync(
    path.join(root, "src", "scrapers", "news-scraper.js"),
    "utf8",
);
const activitySource = fs.readFileSync(
    path.join(root, "src", "scrapers", "activity.js"),
    "utf8",
);
const browserClient = require(path.join(root, "src", "browser-client.js"));

for (const column of [
    "detail_text",
    "file_mime_type",
    "file_sha256",
    "pdf_data",
    "pdf_stored_in_db",
]) {
    assert(dbSource.includes(column), `missing database column: ${column}`);
}
assert(newsSource.includes("pdfStorageForBuffer"), "PDF storage metadata helper missing");
assert(newsSource.includes("STORE_PDF_IN_DB"), "STORE_PDF_IN_DB setting missing");
assert(
    typeof browserClient.captureRenderedImagesFromPage === "function",
    "captureRenderedImagesFromPage must be exported",
);
assert(
    activitySource.includes("captureRenderedImagesFromPage"),
    "activity scraper must use rendered page capture",
);

console.log("storage and rendered capture tests passed");
