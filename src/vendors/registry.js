const cjworld = require("./adapters/cjworld");
const pasworld = require("./adapters/pasworld");
const dungbhumi = require("./adapters/dungbhumi");
const generic = require("./adapters/generic");
const { detectWebsiteVendor } = require("./detector");

const ADAPTERS = new Map([cjworld, pasworld, dungbhumi, generic].map((adapter) => [adapter.id, adapter]));

function getVendorAdapter(vendorId) {
    return ADAPTERS.get(String(vendorId || "").trim().toLowerCase()) || generic;
}

function listVendorAdapters() {
    return [...ADAPTERS.values()].map((adapter) => ({ id: adapter.id, name: adapter.name }));
}

async function resolveVendorAdapter(config, options = {}) {
    const detection = await detectWebsiteVendor(config, options);
    const adapter = getVendorAdapter(detection.vendorId);
    const preparedConfig = adapter.prepareConfig(config, detection);
    return { adapter, detection, config: preparedConfig };
}

module.exports = {
    getVendorAdapter,
    listVendorAdapters,
    resolveVendorAdapter,
};
