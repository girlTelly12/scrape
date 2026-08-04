const { createAdapter } = require("./base");

module.exports = createAdapter({
    id: "cjworld",
    name: "CJ World Communication",
    profile: {
        news: {
            detailUrlPatterns: [
                /\/datacenter\/(?:detail|data|view|show)(?:_[a-z0-9]+)?\.php/i,
                /[?&](?:news_id|id|record|rec_id|rid)=\d+/i,
            ],
            listingUrlPatterns: [/\/datacenter\/[a-z0-9_]+\.php/i],
            preferredDetailIdParams: ["news_id", "id", "record", "rec_id", "rid"],
        },
        activity: {
            detailUrlPatterns: [/\/album\/(?:view|detail)\.php/i, /[?&]album_id=\d+/i],
            listingUrlPatterns: [/\/album\/index\.php/i],
            preferredActivityIdParams: ["album_id", "id"],
        },
    },
});
