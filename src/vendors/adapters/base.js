const { scrapeNewsCategory } = require("../../scrapers/news-scraper");
const { scrapeActivityPictures } = require("../../scrapers/activity");

function createAdapter({ id, name, profile = {}, prepareConfig }) {
    return {
        id,
        name,
        profile,
        prepareConfig(config, detection) {
            // Vendor detection มีหน้าที่เลือก Parser/Adapter เท่านั้น
            // ห้ามนำ suggestedConfig มาเติม URL เพราะ URL ทุกหมวดต้องมาจากผู้ใช้
            const merged = {
                ...config,
                autoFillSections: false,
                siteUrl: config.siteUrl || "",
                procurementUrl: config.procurementUrl || "",
                publicRelationsUrl: config.publicRelationsUrl || "",
                activityUrl: config.activityUrl || "",
                otherTopics: Array.isArray(config.otherTopics) ? config.otherTopics : [],
            };
            return typeof prepareConfig === "function" ? prepareConfig(merged, detection) : merged;
        },
        scrapeNews(sectionKey, args) {
            return scrapeNewsCategory({
                ...args,
                adapterProfile: { ...profile.news, vendorId: id, vendorName: name, sectionKey },
            });
        },
        scrapeActivity(args) {
            return scrapeActivityPictures({
                ...args,
                adapterProfile: { ...profile.activity, vendorId: id, vendorName: name },
            });
        },
    };
}

module.exports = { createAdapter };
