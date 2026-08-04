const https = require("https");

async function sendLineNotify(token, message) {
  if (!token) return { sent: false, reason: "missing token" };

  const body = `message=${encodeURIComponent(message)}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      "https://notify-api.line.me/api/notify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ sent: true, statusCode: res.statusCode, response: text });
            return;
          }
          reject(new Error(`LINE notify failed: HTTP ${res.statusCode} ${text}`));
        });
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  sendLineNotify,
};
