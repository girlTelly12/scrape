const { createAdapter } = require("./base");

module.exports = createAdapter({
    id: "dungbhumi",
    name: "Dungbhumi Corporation",
    profile: {
        news: {
            detailUrlPatterns: [
                /\/public\/(?:list|rss)\/data\/(?:detail|view|index)\//i,
                /\/public\/list\/data\/index\/menu\/\d+/i,
            ],
            listingUrlPatterns: [/\/public\/(?:list|rss)\/data\//i],
            preferredDetailIdParams: ["id", "menu", "news_id"],
        },
        activity: {
            detailUrlPatterns: [/\/public\/(?:gallery|album|list)\/data\//i],
            listingUrlPatterns: [/\/public\/(?:gallery|album|list)\/data\//i],
            preferredActivityIdParams: ["id", "album_id"],
        },
    },
});
