// Scraper for "ประกาศจัดซื้อจัดจ้าง" on nongtalay.go.th.
//
// What this script does:
//   1. Visit http://www.nongtalay.go.th/news.php?cat_id=13 and pageid=2..42.
//   2. Visit every detail.php?id=... link found in those listing pages.
//   3. Use the detail page title as a folder name.
//   4. Extract detail text and published date from each detail page.
//   5. Download every document link and news/photo image into that title folder,
//      preserving the original server file name.
//   6. Create nongtalay-downloads/nongtalay_import.sql for phpMyAdmin import.
//   7. Optionally import the SQL into MySQL automatically when MYSQL_USER is set.
//
// Run with:  node nongtalay-scerape.js
//
// Optional MySQL import:
//   set MYSQL_HOST=127.0.0.1
//   set MYSQL_PORT=3306
//   set MYSQL_USER=root
//   set MYSQL_PASSWORD=your_password
//   node nongtalay-scerape.js
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const BASE_URL = 'http://www.nongtalay.go.th/';
const CATEGORY_ID = 13;
const FIRST_PAGE = `${BASE_URL}news.php?cat_id=${CATEGORY_ID}`;
const LAST_PAGE_ID = 42;
const LIST_PAGES = [
  FIRST_PAGE,
  ...Array.from({ length: LAST_PAGE_ID - 1 }, (_, i) => `${BASE_URL}news.php?pageid=${i + 2}&cat_id=${CATEGORY_ID}`),
];
const OUT_DIR = path.join(__dirname, 'nongtalay-downloads');
const SQL_FILE = path.join(OUT_DIR, 'nongtalay_import.sql');
const DB_NAME = process.env.MYSQL_DATABASE || 'nongtalay_scerape';
const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 8);
const SCAN_MAX_DETAIL_ID = Number(process.env.SCAN_MAX_DETAIL_ID || 0);
const UA = 'Mozilla/5.0 (compatible; simple-node-scraper)';

// ---------------------------------------------------------------------------
// fetch(url): downloads a URL and resolves to { buffer, headers }.
// Built on top of http.get because:
//   - we need to follow 3xx redirects manually;
//   - we want raw bytes (Buffer), not text — important for binary files (PDFs, etc.);
//   - we want a hard timeout so a slow server cannot freeze the script.
// ---------------------------------------------------------------------------
function fetch(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'th,en-US;q=0.8,en;q=0.7',
      },
    }, (res) => {
      // 3xx = redirect. Re-call fetch on the new URL. The "redirects" counter
      // prevents infinite redirect loops.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects <= 0) return reject(new Error('too many redirects'));
        res.resume(); // discard the redirect body to free the socket
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetch(next, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      }
      // The body arrives in chunks (pieces of bytes). Collect them all
      // and concatenate at the end into a single Buffer.
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    // Kill the request if the server doesn't answer within 30s.
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

function htmlDecode(value) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1].toLowerCase() === 'x';
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return named[entity.toLowerCase()] || _;
  });
}

function decodeBuffer(buffer, headers = {}) {
  const contentType = headers['content-type'] || '';
  const sample = buffer.slice(0, 4096).toString('latin1');
  const charsetMatch = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(`${contentType}\n${sample}`);
  const rawCharset = (charsetMatch && charsetMatch[1] ? charsetMatch[1] : 'utf-8').toLowerCase();
  const charset = ['tis-620', 'tis620', 'windows-874', 'cp874'].includes(rawCharset)
    ? 'windows-874'
    : rawCharset;

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

// ---------------------------------------------------------------------------
// extractHrefs(html, baseUrl):
//   Returns every absolute URL found in href="..." attributes of the HTML.
//   We use a regex (not a real HTML parser) because it's enough for this
//   simple use-case and avoids pulling in external dependencies.
//   "baseUrl" is needed to turn relative links (e.g. "news.php?cat_id=13")
//   into absolute ones ("http://www.nongtalay.go.th/news.php?cat_id=13").
// ---------------------------------------------------------------------------
function extractHrefs(html, baseUrl) {
  const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const out = new Set(); // Set deduplicates automatically
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.add(new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString());
    } catch {
      // Some hrefs are not valid URLs (e.g. "javascript:..."): skip them.
    }
  }
  return [...out];
}

function extractLinks(html, baseUrl) {
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push({
        href: new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString(),
        text: cleanText(m[4]),
      });
    } catch {
      // Skip invalid href values.
    }
  }
  return out;
}

function extractSrcs(html, baseUrl) {
  const re = /src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.add(new URL(htmlDecode(m[1] || m[2] || m[3]), baseUrl).toString());
    } catch {
      // Skip invalid src values.
    }
  }
  return [...out];
}

// Reads a query-string parameter from a URL. Used to extract news/detail IDs
// when building the output filename. Returns null if the URL or param is missing.
function param(url, name) {
  try { return new URL(url).searchParams.get(name); } catch { return null; }
}

// Removes characters that are illegal in filenames on common file systems
// (and trims very long names) so we can write the file safely.
function safeName(s) {
  return htmlDecode(String(s || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'file';
}

// Tiny helper to pause between requests so we don't hammer the server.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(html) {
  return htmlDecode(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulTitle(text) {
  if (!text || text.length < 5) return false;
  const lower = text.toLowerCase();
  return ![
    'nongtalay.go.th',
    'องค์การบริหารส่วนตำบลหนองทะเล',
    'หน้าหลัก',
    'เมนู',
    'search',
    'login',
  ].some((noise) => lower.includes(noise.toLowerCase()));
}

function extractDetailTitle(html, detailUrl) {
  const candidates = [];
  const patterns = [
    /<span[^>]+class\s*=\s*["'][^"']*title3[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
    /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi,
    /<[^>]+class\s*=\s*["'][^"']*(?:topic|subject|head|news)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
    /<strong[^>]*>([\s\S]*?)<\/strong>/gi,
    /<title[^>]*>([\s\S]*?)<\/title>/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      const text = cleanText(m[1])
        .replace(/\s*[-|:]\s*องค์การบริหารส่วนตำบลหนองทะเล.*$/i, '')
        .trim();
      if (isUsefulTitle(text)) candidates.push(text);
    }
  }

  const title = candidates.find((text) => /[ก-๙]/.test(text)) || candidates[0];
  return title || `detail-${param(detailUrl, 'id') || Date.now()}`;
}

function extractDetailContentHtml(html) {
  const titleMatch = /<span[^>]+class\s*=\s*["'][^"']*title3[^"']*["'][^>]*>[\s\S]*?<\/span>/i.exec(html);
  const detailArea = titleMatch ? html.slice(titleMatch.index + titleMatch[0].length) : html;
  const re = /<td\b[^>]*class\s*=\s*(?:"[^"]*\bstyles1\b[^"]*"|'[^']*\bstyles1\b[^']*')[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(detailArea)) !== null) {
    const text = cleanText(m[1]);
    if (text && text !== '&nbsp;') return m[1].trim();
  }
  return '';
}

function normalizeHtmlFragment(html) {
  return String(html || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPublishedText(html) {
  const m = /ประกาศเมื่อ\s*<span[^>]+class\s*=\s*(?:"[^"]*\bnews-s\b[^"]*"|'[^']*\bnews-s\b[^']*')[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  return m ? cleanText(m[1]) : '';
}

function isProcurementDetail(html) {
  const categoryRe = /<a\b[^>]*href\s*=\s*["']?news\.php\?cat_id=13["']?[^>]*class\s*=\s*["'][^"']*styles5[^"']*["'][^>]*>/i;
  return categoryRe.test(html);
}

function extractTotalCount(html) {
  const text = cleanText(html);
  const m = /ข้อมูลทั้งหมด\s*([0-9,]+)\s*รายการ/.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function fileNameFromHeadersOrUrl(headers, fileUrl) {
  const cd = headers['content-disposition'];
  if (cd) {
    const utfMatch = /filename\*\s*=\s*UTF-8''([^;\n]+)/i.exec(cd);
    const plainMatch = /filename\s*=\s*"?([^";\n]+)"?/i.exec(cd);
    const rawName = utfMatch ? utfMatch[1] : plainMatch && plainMatch[1];
    if (rawName) {
      try {
        return safeName(decodeURIComponent(rawName));
      } catch {
        return safeName(rawName);
      }
    }
  }

  const url = new URL(fileUrl);
  const fromPath = path.basename(url.pathname);
  if (fromPath && fromPath !== '/' && fromPath !== '.') {
    try {
      return safeName(decodeURIComponent(fromPath));
    } catch {
      return safeName(fromPath);
    }
  }

  const id = url.searchParams.get('id') || url.searchParams.get('file') || Date.now();
  return `file-${safeName(id)}.pdf`;
}

function isDocumentUrl(url) {
  return (
    url.includes('news/doc_download')
    || /\.(?:pdf|doc|docx|xls|xlsx|zip|rar)(?:[?#]|$)/i.test(url)
  );
}

function isContentImageUrl(url) {
  try {
    const parsed = new URL(url);
    const fileName = path.basename(parsed.pathname).toLowerCase();
    return (
      fileName !== 'download.gif'
      && /^\/news\//i.test(parsed.pathname)
      && /\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(url)
    );
  } catch {
    return false;
  }
}

function fileTypeFromUrl(url) {
  return isContentImageUrl(url) ? 'image' : 'document';
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function sqlIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function writeSql(rows) {
  const lines = [
    `CREATE DATABASE IF NOT EXISTS ${sqlIdentifier(DB_NAME)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `USE ${sqlIdentifier(DB_NAME)};`,
    'SET NAMES utf8mb4;',
    'SET CHARACTER SET utf8mb4;',
    '',
    'DROP TABLE IF EXISTS procurement_files;',
    'CREATE TABLE procurement_files (',
    '  id INT AUTO_INCREMENT PRIMARY KEY,',
    '  page_id INT NULL,',
    '  listing_url TEXT NOT NULL,',
    '  detail_id VARCHAR(64) NULL,',
    '  detail_url TEXT NOT NULL,',
    '  title TEXT NOT NULL,',
    '  detail_text LONGTEXT NOT NULL,',
    '  detail_html LONGTEXT NULL,',
    '  published_text TEXT NULL,',
    '  folder_path TEXT NOT NULL,',
    '  file_type VARCHAR(32) NULL,',
    '  file_name VARCHAR(255) NULL,',
    '  file_url TEXT NULL,',
    '  local_path TEXT NULL,',
    '  file_size BIGINT NULL,',
    '  downloaded_at DATETIME NOT NULL',
    ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    '',
  ];

  for (const row of rows) {
    lines.push([
      'INSERT INTO procurement_files',
      '(page_id, listing_url, detail_id, detail_url, title, detail_text, detail_html, published_text, folder_path, file_type, file_name, file_url, local_path, file_size, downloaded_at)',
      'VALUES',
      `(${[
        row.pageId === null || row.pageId === undefined ? 'NULL' : Number(row.pageId),
        sqlString(row.listingUrl),
        sqlString(row.detailId),
        sqlString(row.detailUrl),
        sqlString(row.title),
        sqlString(row.detailText),
        sqlString(row.detailHtml),
        sqlString(row.publishedText),
        sqlString(row.folderPath),
        sqlString(row.fileType),
        sqlString(row.fileName),
        sqlString(row.fileUrl),
        sqlString(row.localPath),
        row.fileSize === null || row.fileSize === undefined ? 'NULL' : row.fileSize,
        sqlString(row.downloadedAt),
      ].join(', ')});`,
    ].join(' '));
  }

  fs.writeFileSync(SQL_FILE, `${lines.join('\n')}\n`, 'utf8');
}

function importSqlIfConfigured() {
  if (!process.env.MYSQL_USER) {
    console.log(`SQL ready for phpMyAdmin import -> ${SQL_FILE}`);
    console.log('Set MYSQL_USER/MYSQL_PASSWORD if you want this script to import via mysql CLI automatically.');
    return;
  }

  const args = [
    '--default-character-set=utf8mb4',
    '-h', process.env.MYSQL_HOST || '127.0.0.1',
    '-P', process.env.MYSQL_PORT || '3306',
    '-u', process.env.MYSQL_USER,
  ];
  if (process.env.MYSQL_PASSWORD) args.push(`-p${process.env.MYSQL_PASSWORD}`);

  const result = spawnSync('mysql', args, {
    input: fs.readFileSync(SQL_FILE),
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (result.error) {
    console.error(`MySQL import skipped: ${result.error.message}`);
    console.error(`You can import this file manually in phpMyAdmin: ${SQL_FILE}`);
    return;
  }
  if (result.status !== 0) {
    console.error(`MySQL import failed with exit code ${result.status}`);
    console.error(`You can import this file manually in phpMyAdmin: ${SQL_FILE}`);
    return;
  }
  console.log(`Imported SQL into MySQL database "${DB_NAME}"`);
}

// ---------------------------------------------------------------------------
// Main flow. Wrapped in an async IIFE so we can use await at the top level.
// ---------------------------------------------------------------------------
(async () => {
  // Make sure the output folder exists. recursive: true means "no error if
  // it's already there, and create parents if needed".
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- Step 1: visit all listing pages and collect detail.php?id=... links --
  const detailMap = new Map();
  let expectedTotal = 0;
  let maxSeenDetailId = 0;
  for (const newsUrl of LIST_PAGES) {
    try {
      console.log('[visit news]  ', newsUrl);
      const response = await fetch(newsUrl);
      const html = decodeBuffer(response.buffer, response.headers);
      expectedTotal = Math.max(expectedTotal, extractTotalCount(html));
      const pageId = param(newsUrl, 'pageid') ? Number(param(newsUrl, 'pageid')) : 1;
      const details = extractLinks(html, newsUrl)
        .filter((link) => link.href.includes('detail.php?') && param(link.href, 'id'));
      for (const detail of details) {
        maxSeenDetailId = Math.max(maxSeenDetailId, Number(param(detail.href, 'id')) || 0);
        if (!detailMap.has(detail.href)) {
          detailMap.set(detail.href, {
            listingUrl: newsUrl,
            pageId,
            title: isUsefulTitle(detail.text) ? detail.text : '',
          });
        }
      }
      await sleep(150); // be polite — small pause between requests
    } catch (e) {
      console.error('  [news fail]', newsUrl, '-', e.message);
    }
  }
  console.log(`  -> ${detailMap.size} detail.php? links found`);

  // Some old PHP pagination pages return the first page for every pageid when
  // requested programmatically. If that happens, scan detail IDs and keep only
  // pages whose breadcrumb says cat_id=13.
  if (expectedTotal && detailMap.size < expectedTotal) {
    const scanMax = SCAN_MAX_DETAIL_ID || maxSeenDetailId || 3000;
    console.log(`  -> listing pagination returned ${detailMap.size}/${expectedTotal}; scanning detail IDs 1..${scanMax}`);
    const ids = Array.from({ length: scanMax }, (_, i) => i + 1);
    let scanned = 0;
    let matched = 0;

    await mapLimit(ids, SCAN_CONCURRENCY, async (id) => {
      const detailUrl = `${BASE_URL}detail.php?id=${id}`;
      try {
        const response = await fetch(detailUrl);
        const html = decodeBuffer(response.buffer, response.headers);
        scanned++;
        if (scanned % 100 === 0) {
          console.log(`  [scan] ${scanned}/${scanMax} checked, ${matched} procurement details found`);
        }
        if (!isProcurementDetail(html)) return;
        matched++;
        if (!detailMap.has(detailUrl)) {
          detailMap.set(detailUrl, {
            listingUrl: `${BASE_URL}news.php?cat_id=${CATEGORY_ID}`,
            pageId: null,
            title: extractDetailTitle(html, detailUrl),
          });
        }
      } catch (e) {
        scanned++;
        if (scanned % 100 === 0) {
          console.log(`  [scan] ${scanned}/${scanMax} checked, ${matched} procurement details found`);
        }
      }
    });

    console.log(`  -> ${detailMap.size} procurement detail.php? links found after scan`);
  }

  // ---- Step 2: visit each detail page, find file links, save files ----------
  let dlCount = 0;
  const rows = [];
  for (const [detailUrl, source] of detailMap) {
    try {
      console.log('[visit detail]', detailUrl);
      const response = await fetch(detailUrl);
      const html = decodeBuffer(response.buffer, response.headers);
      const title = source.title || extractDetailTitle(html, detailUrl);
      const detailHtml = normalizeHtmlFragment(extractDetailContentHtml(html));
      const detailText = cleanText(detailHtml);
      const publishedText = extractPublishedText(html);
      const folderName = safeName(title);
      const folderPath = path.join(OUT_DIR, folderName);
      fs.mkdirSync(folderPath, { recursive: true });

      const detailId = param(detailUrl, 'id') || 'detail';
      const assets = [
        ...extractHrefs(html, detailUrl).filter((u) => isDocumentUrl(u) || isContentImageUrl(u)),
        ...extractSrcs(html, detailUrl).filter(isContentImageUrl),
      ].filter((url, index, all) => all.indexOf(url) === index);
      let savedFiles = 0;

      for (const doc of assets) {
        try {
          const { buffer, headers } = await fetch(doc);
          const fileName = fileNameFromHeadersOrUrl(headers, doc);
          const target = path.join(folderPath, fileName);
          fs.writeFileSync(target, buffer);
          dlCount++;
          savedFiles++;
          rows.push({
            pageId: source.pageId,
            listingUrl: source.listingUrl,
            detailId,
            detailUrl,
            title,
            detailText,
            detailHtml,
            publishedText,
            folderPath,
            fileType: fileTypeFromUrl(doc),
            fileName,
            fileUrl: doc,
            localPath: target,
            fileSize: buffer.length,
            downloadedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          });
          console.log(`  saved -> ${target} (${buffer.length} bytes)`);
          await sleep(150);
        } catch (e) {
          console.error('  [asset fail]', doc, '-', e.message);
        }
      }

      if (!savedFiles) {
        rows.push({
          pageId: source.pageId,
          listingUrl: source.listingUrl,
          detailId,
          detailUrl,
          title,
          detailText,
          detailHtml,
          publishedText,
          folderPath,
          fileType: null,
          fileName: null,
          fileUrl: null,
          localPath: null,
          fileSize: null,
          downloadedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
      }
    } catch (e) {
      console.error('  [detail fail]', detailUrl, '-', e.message);
    }
  }
  writeSql(rows);
  importSqlIfConfigured();
  console.log(`Done. ${dlCount} files saved in ${OUT_DIR}`);
})().catch((e) => {
  // Catch-all so any unexpected error is visible and the process exits non-zero.
  console.error('FATAL', e);
  process.exit(1);
});
