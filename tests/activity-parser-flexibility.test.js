const assert = require("assert");
const {
    activityIdFromUrl,
    detectActivityParserProfile,
    discoverActivityPageLinks,
    ensureImageExtension,
    extractGalleryImageUrls,
    isLikelyActivityDetailUrl,
    isLikelyActivityListingUrl,
    listingPageNo,
    safeActivityFolderName,
} = require("../src/scrapers/activity-url-parser");

function hrefs(items) {
    return items.map((item) => item.href).sort();
}

{
    const startUrl = "https://example.go.th/album/index.php";
    const html = `
        <a href="/album/view.php?album_id=10">กิจกรรมหนึ่ง</a>
        <a href="/activities.php?salb_id=20">กิจกรรมสอง</a>
        <a href="/album/index.php?pageid=2">2</a>
    `;
    const result = discoverActivityPageLinks(html, startUrl, startUrl);
    assert.deepStrictEqual(
        result.details.map((item) => item.activityId).sort(),
        ["10", "20"],
    );
    assert.deepStrictEqual(hrefs(result.listings), ["https://example.go.th/album/index.php?pageid=2"]);
    assert.strictEqual(result.profile.mode, "legacy-album");
}

{
    const startUrl = "https://www.baanna.go.th/gallery";
    const html = `
        <a href="/gallery/123">โครงการปลูกต้นไม้</a>
        <div data-href="/gallery/view/456">กิจกรรมกีฬา</div>
        <button onclick="window.location.href='/gallery/detail?id=789'">เปิด</button>
        <a href="/gallery?page=2">หน้าถัดไป</a>
        <a href="/gallery/page/3">3</a>
        <a href="/gallery/images/banner.jpg">banner</a>
    `;
    const result = discoverActivityPageLinks(html, startUrl, startUrl);
    assert.deepStrictEqual(
        result.details.map((item) => item.activityId).sort(),
        ["123", "456", "789"],
    );
    assert.deepStrictEqual(hrefs(result.listings), [
        "https://www.baanna.go.th/gallery/page/3",
        "https://www.baanna.go.th/gallery?page=2",
    ]);
    assert.strictEqual(result.profile.mode, "modern-gallery");
}

{
    const startUrl = "https://www.baanna.go.th/gallery";
    const context = { startUrl, hostname: "www.baanna.go.th" };
    assert.strictEqual(isLikelyActivityDetailUrl("https://www.baanna.go.th/gallery/abc-123", context), true);
    assert.strictEqual(isLikelyActivityDetailUrl("https://www.baanna.go.th/gallery?page=2", context), false);
    assert.strictEqual(isLikelyActivityListingUrl("https://www.baanna.go.th/gallery?page=2", context), true);
    assert.strictEqual(activityIdFromUrl("https://www.baanna.go.th/gallery/view/99", startUrl), "99");
    assert.strictEqual(listingPageNo("https://www.baanna.go.th/gallery/page/7"), 7);
}


{
    const startUrl = "https://www.baanna.go.th/gallery";
    const html = `
        <a href="/gallery/detail/22807/data.html">กิจกรรมตัวอย่าง 22807</a>
        <a href="/gallery/detail/21129/data.html">กิจกรรมตัวอย่าง 21129</a>
    `;
    const result = discoverActivityPageLinks(html, startUrl, startUrl);
    assert.deepStrictEqual(
        result.details.map((item) => item.activityId).sort(),
        ["21129", "22807"],
    );
    assert.strictEqual(
        isLikelyActivityDetailUrl(
            "https://www.baanna.go.th/gallery/detail/22807/data.html",
            { startUrl, hostname: "www.baanna.go.th" },
        ),
        true,
    );
    assert.strictEqual(
        activityIdFromUrl(
            "https://www.baanna.go.th/gallery/detail/21129/data.html",
            startUrl,
        ),
        "21129",
    );
}

{
    const activityUrl = "https://www.baanna.go.th/gallery/123";
    const html = `
        <img src="/images/logo.png">
        <a class="glightbox" data-gallery="activity" href="/storage/gallery/123/full-01.jpg">
            <img src="/storage/gallery/123/thumb/thumb-01.jpg">
        </a>
        <img data-src="/uploads/gallery/123/photo-02.png" class="gallery-image">
        <script>const photos=["/media/photos/123/photo-03.webp"];</script>
    `;
    const images = extractGalleryImageUrls(html, activityUrl, "123");
    assert(images.includes("https://www.baanna.go.th/storage/gallery/123/full-01.jpg"));
    assert(images.includes("https://www.baanna.go.th/uploads/gallery/123/photo-02.png"));
    assert(images.includes("https://www.baanna.go.th/media/photos/123/photo-03.webp"));
    assert(!images.includes("https://www.baanna.go.th/images/logo.png"));
}

{
    assert.strictEqual(ensureImageExtension("download", "image/png"), "download.png");
    assert.strictEqual(ensureImageExtension("photo.jpg", "image/jpeg"), "photo.jpg");
    const folder = safeActivityFolderName("หัวข้อกิจกรรมที่ยาวมาก ".repeat(20), "123");
    assert(folder.startsWith("123_"));
    assert(folder.length <= 130);
}

{
    assert.strictEqual(detectActivityParserProfile("https://example.go.th/albums/index.php").mode, "legacy-album");
    assert.strictEqual(detectActivityParserProfile("https://example.go.th/gallery").mode, "modern-gallery");
}

console.log("activity parser flexibility tests passed");
