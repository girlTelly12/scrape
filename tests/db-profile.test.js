const assert = require("assert");
const {
    getDbProfile,
    sanitizeTis620String,
    tableOptionsSql,
} = require("../src/db-profile");

const original = { ...process.env };
try {
    process.env.MYSQL_DATABASE_MODE = "fixed";
    process.env.MYSQL_DATABASE = "nabonct_cjworld";
    process.env.MYSQL_DATABASE_CHARSET = "tis620";
    process.env.MYSQL_DATABASE_COLLATION = "tis620_thai_ci";
    process.env.MYSQL_TABLE_CHARSET = "tis620";
    process.env.MYSQL_TABLE_COLLATION = "tis620_thai_ci";
    process.env.MYSQL_CONNECTION_CHARSET = "TIS620_THAI_CI";
    process.env.MYSQL_TIS620_SANITIZE = "true";

    const profile = getDbProfile("scrape_other_site");
    assert.equal(profile.database, "nabonct_cjworld");
    assert.equal(profile.databaseMode, "fixed");
    assert.equal(profile.charset, "TIS620_THAI_CI");
    assert.equal(tableOptionsSql(profile), "CHARACTER SET tis620 COLLATE tis620_thai_ci");
    assert.equal(sanitizeTis620String("หัวข้อ ✅ test"), "หัวข้อ  test");

    process.env.MYSQL_DATABASE_MODE = "per_site";
    process.env.MYSQL_TABLE_CHARSET = "utf8mb4";
    process.env.MYSQL_TABLE_COLLATION = "utf8mb4_unicode_ci";
    process.env.MYSQL_CONNECTION_CHARSET = "UTF8MB4_UNICODE_CI";
    const perSite = getDbProfile("scrape_demo");
    assert.equal(perSite.database, "scrape_demo");
    assert.equal(perSite.databaseMode, "per_site");

    console.log("database profile tests passed");
} finally {
    process.env = original;
}
