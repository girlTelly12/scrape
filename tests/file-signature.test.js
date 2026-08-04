const assert = require("assert");
const {
    detectFileSignature,
    detectedContentType,
    ensureFileNameExtension,
    looksLikeHtml,
} = require("../src/file-audit");

const wrongPdfHeaders = { "content-type": "text/html; charset=UTF-8" };
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "ascii");
assert.strictEqual(looksLikeHtml(pdf, wrongPdfHeaders), false);
assert.strictEqual(detectFileSignature(pdf).kind, "pdf");
assert.strictEqual(detectedContentType(pdf, wrongPdfHeaders), "application/pdf");
assert.strictEqual(ensureFileNameExtension("download", wrongPdfHeaders, pdf), "download.pdf");

const html = Buffer.from("<!doctype html><html><body>Access denied</body></html>");
assert.strictEqual(looksLikeHtml(html, wrongPdfHeaders), true);

const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
assert.strictEqual(looksLikeHtml(docx, wrongPdfHeaders), false);
assert.strictEqual(detectFileSignature(docx).kind, "zip");

const legacyOffice = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
assert.strictEqual(looksLikeHtml(legacyOffice, wrongPdfHeaders), false);

console.log("file-signature tests passed");

const { shouldRetryExpectedFileWithBrowser } = require("../src/common");
assert.strictEqual(
    shouldRetryExpectedFileWithBrowser(
        { buffer: html, headers: wrongPdfHeaders },
        { expectFile: true },
    ),
    true,
);
assert.strictEqual(
    shouldRetryExpectedFileWithBrowser(
        { buffer: pdf, headers: wrongPdfHeaders },
        { expectFile: true },
    ),
    false,
);
