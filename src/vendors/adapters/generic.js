const { createAdapter } = require("./base");

module.exports = createAdapter({
    id: "generic",
    name: "Generic Adaptive Adapter",
    profile: { news: {}, activity: {} },
});
