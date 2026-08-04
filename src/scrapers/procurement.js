const path = require("path");
const { scrapeNewsCategory } = require("./news-scraper");

async function scrapeProcurement({ startUrl, outDir, logger, shouldStop, onAuditRecord, adapterProfile }) {
    const outputDir = outDir || path.join(__dirname, "..", "..", "nongtalay-downloads");
    return scrapeNewsCategory({
        startUrl,
        sectionKey: "procurement",
        sectionLabel: "จัดซื้อจัดจ้าง",
        outDir: outputDir,
        logger,
        shouldStop,
        onAuditRecord,
        adapterProfile,
    });
}

module.exports = {
    scrapeProcurement,
};
