const assert = require("assert");
const {
    formatDatabaseError,
    getDatabaseMode,
    isConnectionError,
} = require("../src/db-availability");

const originalMode = process.env.DATABASE_MODE;

process.env.DATABASE_MODE = "auto";
assert.strictEqual(getDatabaseMode(), "auto");
process.env.DATABASE_MODE = "required";
assert.strictEqual(getDatabaseMode(), "required");
process.env.DATABASE_MODE = "disabled";
assert.strictEqual(getDatabaseMode(), "disabled");
process.env.DATABASE_MODE = "unknown";
assert.strictEqual(getDatabaseMode(), "auto");

assert.strictEqual(isConnectionError({ code: "ECONNREFUSED" }), true);
assert.strictEqual(isConnectionError({ message: "connect ETIMEDOUT 127.0.0.1" }), true);
assert.strictEqual(isConnectionError({ code: "ER_ACCESS_DENIED_ERROR" }), false);

const message = formatDatabaseError(
    { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:3306" },
    { host: "127.0.0.1", port: 3306 },
);
assert.match(message, /เปิด MySQL ใน XAMPP/);
assert.match(message, /127\.0\.0\.1:3306/);

if (originalMode === undefined) delete process.env.DATABASE_MODE;
else process.env.DATABASE_MODE = originalMode;

console.log("database availability tests passed");
