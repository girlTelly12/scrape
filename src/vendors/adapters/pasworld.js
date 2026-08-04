const { createAdapter } = require("./base");

module.exports = createAdapter({
    id: "pasworld",
    name: "PASWorld Communication",
    profile: {
        news: {
            detailUrlPatterns: [
                /\/(?:news_detail|detail_news|detail|view)\.php/i,
                /[?&](?:news_id|newsid|n_id|id)=\d+/i,
            ],
            listingUrlPatterns: [/\/news\.php/i],
            preferredDetailIdParams: ["news_id", "newsid", "n_id", "id"],
        },
        activity: {
            detailUrlPatterns: [/\/(?:album|albums|photo)\/(?:view|detail)\.php/i, /[?&](?:album_id|salb_id|id)=\d+/i],
            listingUrlPatterns: [/\/(?:album|albums|photo)\/index\.php/i],
            preferredActivityIdParams: ["album_id", "salb_id", "id"],
        },
    },
});
