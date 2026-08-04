/**
 * ข่าว/ประกาศเทศบาลตำบลอ่าวนาง — สามหมวดแยกตารางใน scrape_aonang
 */
const AONANG_NEWS_SECTIONS = [
    {
        key: "bidWinner",
        label: "ประกาศผู้ชนะการเสนอราคา",
        url: "https://aonang.go.th/news.php?cat_id=27",
        outSubdir: "aonang_bid_winner_files",
    },
    {
        key: "referencePrice",
        label: "ประกาศราคากลาง",
        url: "https://aonang.go.th/news.php?cat_id=28",
        outSubdir: "aonang_reference_price_files",
    },
    {
        key: "council",
        label: "กิจการสภา",
        url: "https://aonang.go.th/news.php?cat_id=4",
        outSubdir: "aonang_council_files",
    },
];

const AONANG_DATABASE_NAME = "scrape_aonang";

module.exports = {
    AONANG_DATABASE_NAME,
    AONANG_NEWS_SECTIONS,
};
