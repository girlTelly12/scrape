const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "db.js"), "utf8");
for (const table of ["activity_details", "activity_media_files"]) {
    assert(source.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing table ${table}`);
}
for (const column of [
    "listing_path",
    "detail_path",
    "section_key",
    "section_label",
    "folder_path",
    "record_text_path",
    "detail_text_path",
    "announced_text",
    "announced_at",
    "media_type",
    "media_provider",
    "embed_url",
    "file_sha256",
    "pdf_data",
    "pdf_stored_in_db",
]) {
    assert(source.includes(column), `missing database field ${column}`);
}

function assertInsertContract(tableName, expectedPlaceholders) {
    const marker = `INSERT INTO ${tableName}`;
    const start = source.indexOf(marker);
    assert(start >= 0, `missing insert for ${tableName}`);
    const chunk = source.slice(start, start + 1600);
    const values = /VALUES\s*\(([^)]+)\)/s.exec(chunk);
    assert(values, `missing VALUES for ${tableName}`);
    const count = (values[1].match(/\?/g) || []).length;
    assert.strictEqual(count, expectedPlaceholders, `${tableName} placeholder count`);
}

assertInsertContract("activity_details", 15);
assertInsertContract("activity_media_files", 18);
const newsInsertStart = source.indexOf("async function insertNewsRows");
assert(newsInsertStart >= 0, "missing insertNewsRows");
const newsInsertChunk = source.slice(newsInsertStart, newsInsertStart + 2400);
const newsValues = /VALUES\s*\(([^)]+)\)/s.exec(newsInsertChunk);
assert(newsValues, "missing VALUES for news rows");
assert.strictEqual((newsValues[1].match(/\?/g) || []).length, 30, "news row placeholder count");
assert(source.includes("PDF_DB_MAX_MB"), "PDF size limit must be enforced");
assert(source.includes("fs.readFileSync(row.localPath)"), "PDF bytes must be loaded for LONGBLOB insert");

console.log("database schema contract tests passed");
