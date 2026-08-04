const assert = require("assert");
const {
    collectProbeUrls,
    createSuggestedConfig,
    detectVendorFromDocuments,
    getInputScope,
} = require("../src/vendors/detector");

function document(url, html) {
    return { requestedUrl: url, finalUrl: url, statusCode: 200, html };
}

const cjDocuments = [
    document(
        "https://www.dinudom.go.th/",
        `<html><body><iframe src="https://cjworld.co.th/introall/intro-dinudom.php"></iframe></body></html>`,
    ),
];
const cj = detectVendorFromDocuments(cjDocuments);
assert.strictEqual(cj.vendorId, "cjworld");
assert(cj.confidence >= 70, `CJ confidence too low: ${cj.confidence}`);
const cjSuggested = createSuggestedConfig({ siteUrl: "https://www.dinudom.go.th/" }, cj, cjDocuments);
assert.strictEqual(cjSuggested.procurementUrl, "https://www.dinudom.go.th/datacenter/procedure.php");
assert.strictEqual(cjSuggested.publicRelationsUrl, "https://www.dinudom.go.th/datacenter/information.php");
assert.strictEqual(cjSuggested.activityUrl, "https://www.dinudom.go.th/album/index.php");
assert(cjSuggested.otherTopics.some((topic) => topic.url.endsWith("/datacenter/statement.php")));

const pas = detectVendorFromDocuments([
    document("https://local.example.go.th/", `<footer>PASWORLD COMMUNICATION</footer><a href="news.php?cat_id=1">ข่าว</a>`),
]);
assert.strictEqual(pas.vendorId, "pasworld");

const dungbhumi = detectVendorFromDocuments([
    document(
        "https://local.example.go.th/public/default/index",
        `<footer>ผู้ดูแลระบบ บริษัท ดังภูมิ คอร์ปอเรชั่น จำกัด staff@dungbhumi.com</footer>`,
    ),
]);
assert.strictEqual(dungbhumi.vendorId, "dungbhumi");

const generic = detectVendorFromDocuments([
    document("https://unknown.example.go.th/", `<html><body><h1>เทศบาลตัวอย่าง</h1></body></html>`),
]);
assert.strictEqual(generic.vendorId, "generic");

const manual = detectVendorFromDocuments(cjDocuments, { vendorId: "pasworld" });
assert.strictEqual(manual.vendorId, "pasworld");

// Changing the primary site must never mix old category URLs from another agency.
const mixedConfig = {
    siteUrl: "https://hanpho.go.th/index.php",
    procurementUrl: "https://www.dinudom.go.th/datacenter/procedure.php",
    publicRelationsUrl: "https://www.dinudom.go.th/datacenter/information.php",
    activityUrl: "https://www.dinudom.go.th/album/index.php",
    otherTopics: [
        { title: "แผนพัฒนา", url: "https://www.dinudom.go.th/datacenter/plan_3.php" },
    ],
};
const mixedScope = getInputScope(mixedConfig);
assert.strictEqual(mixedScope.primaryHostname, "hanpho.go.th");
assert.strictEqual(mixedScope.ignoredUrls.length, 4);
const mixedProbes = collectProbeUrls(mixedConfig);
assert(mixedProbes.every((url) => /https:\/\/hanpho\.go\.th\//i.test(url)), JSON.stringify(mixedProbes));
assert(!mixedProbes.some((url) => /dinudom/i.test(url)));

const hanphoDocuments = [
    document(
        "https://hanpho.go.th/index.php",
        `<html><body><iframe src="https://cjworld.co.th/introall/intro-bg.php"></iframe></body></html>`,
    ),
];
const hanphoCj = detectVendorFromDocuments(hanphoDocuments);
assert.strictEqual(hanphoCj.vendorId, "cjworld");
const hanphoSuggested = createSuggestedConfig(mixedConfig, hanphoCj, hanphoDocuments);
assert.strictEqual(hanphoSuggested.siteUrl, "https://hanpho.go.th/index.php");
assert.strictEqual(hanphoSuggested.procurementUrl, "https://hanpho.go.th/datacenter/procedure.php");
assert.strictEqual(hanphoSuggested.publicRelationsUrl, "https://hanpho.go.th/datacenter/information.php");
assert.strictEqual(hanphoSuggested.activityUrl, "https://hanpho.go.th/album/index.php");
assert(hanphoSuggested.otherTopics.every((topic) => /hanpho\.go\.th/i.test(topic.url)));
assert(!JSON.stringify(hanphoSuggested).includes("dinudom"));

console.log("vendor detection tests passed");
