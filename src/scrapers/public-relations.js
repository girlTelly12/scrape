const path = require("path");
const { scrapeNewsCategory } = require("./news-scraper");

async function scrapePublicRelations({ startUrl, outDir, logger, shouldStop, onAuditRecord, adapterProfile }) {
    const outputDir = outDir || path.join(__dirname, "..", "..", "nongtalay-pr-downloads");
    return scrapeNewsCategory({
        startUrl,
        sectionKey: "publicRelations",
        sectionLabel: "ประชาสัมพันธ์",
        outDir: outputDir,
        logger,
        shouldStop,
        onAuditRecord,
        adapterProfile,
    });
}

module.exports = {
    scrapePublicRelations,
};
