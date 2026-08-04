const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractMediaCandidates } = require("../src/scrapers/media-utils");
const {
    extractActivityDetails,
    writeActivityDetailText,
} = require("../src/scrapers/activity");

{
    const baseUrl = "https://local.go.th/activity/detail.php?id=1";
    const html = `
      <video controls><source src="/uploads/activity.mp4" type="video/mp4"></video>
      <audio src="/media/sound.mp3"></audio>
      <iframe src="https://www.youtube.com/embed/abc123"></iframe>
      <a href="/documents/report.pdf">ดาวน์โหลดรายงาน PDF</a>
      <script>const stream = "/streams/live.m3u8";</script>
    `;
    const rows = extractMediaCandidates(html, baseUrl);
    const byType = new Map(rows.map((row) => [row.mediaType, row]));
    assert(byType.has("video"));
    assert(byType.has("audio"));
    assert(byType.has("video_embed"));
    assert(byType.has("document"));
    assert(rows.some((row) => row.url.endsWith(".m3u8") && row.downloadable === false));
    assert.strictEqual(byType.get("video_embed").provider, "youtube");
}

{
    const html = `
      <html><head><meta property="og:title" content="กิจกรรมทดสอบ"></head><body>
        <main>
          <h1>กิจกรรมทดสอบ</h1>
          <div>วันที่ลงข่าว : 1 สิงหาคม 2569 เวลา 09:30 น.</div>
          <div class="detail">องค์การบริหารส่วนตำบลจัดกิจกรรมทดสอบเพื่อประชาชนในพื้นที่</div>
        </main>
      </body></html>
    `;
    const details = extractActivityDetails(
        html,
        "https://local.go.th/album/detail.php?album_id=100",
        "กิจกรรมทดสอบ",
    );
    assert(details.detailText.includes("กิจกรรมทดสอบเพื่อประชาชน"));
    assert(details.announcedText.includes("1 สิงหาคม 2569"));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-text-"));
    try {
        const filePath = writeActivityDetailText(
            dir,
            details,
            {
                albumId: "100",
                listingUrl: "https://local.go.th/album/index.php",
            },
            "https://local.go.th/album/detail.php?album_id=100",
        );
        const text = fs.readFileSync(filePath, "utf8");
        assert.strictEqual(path.basename(filePath), "รายละเอียดกิจกรรม.txt");
        assert(text.includes("วันที่/เวลาประกาศ:"));
        assert(text.includes("09:30"));
        assert(text.includes("รายละเอียดกิจกรรม"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log("media and activity text tests passed");
