const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getVendorAdapter } = require("../src/vendors/registry");

const config = {
  siteUrl: "https://hanpho.go.th/index.php",
  procurementUrl: "https://hanpho.go.th/custom/procurement.php",
  publicRelationsUrl: "https://hanpho.go.th/custom/news.php",
  activityUrl: "https://hanpho.go.th/custom/gallery.php",
  otherTopics: [{ title: "แผน", url: "https://hanpho.go.th/custom/plan.php" }],
  autoFillSections: true,
};
const detection = {
  suggestedConfig: {
    siteUrl: "https://www.dinudom.go.th/",
    procurementUrl: "https://www.dinudom.go.th/datacenter/procedure.php",
    publicRelationsUrl: "https://www.dinudom.go.th/datacenter/information.php",
    activityUrl: "https://www.dinudom.go.th/album/index.php",
    otherTopics: [{ title: "ผิดเว็บไซต์", url: "https://www.dinudom.go.th/datacenter/plan.php" }],
  },
};

const prepared = getVendorAdapter("cjworld").prepareConfig(config, detection);
assert.equal(prepared.autoFillSections, false);
assert.equal(prepared.siteUrl, config.siteUrl);
assert.equal(prepared.procurementUrl, config.procurementUrl);
assert.equal(prepared.publicRelationsUrl, config.publicRelationsUrl);
assert.equal(prepared.activityUrl, config.activityUrl);
assert.deepEqual(prepared.otherTopics, config.otherTopics);

const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
assert(!appJs.includes("data.suggestedConfig.procurementUrl"));
assert(appJs.includes("autoFillSections: false"));

console.log("manual section URL policy tests passed");
