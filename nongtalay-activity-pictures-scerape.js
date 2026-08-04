// Scraper for "ภาพกิจกรรม" on nongtalay.go.th.
//
// What this script does:
//   1. Visit http://www.nongtalay.go.th/albums/index.php and Page=2..132.
//   2. Visit every albums/activities.php?salb_id=... page.
//   3. Use the activity title as a folder name.
//   4. Download real activity images into that title folder, preserving the
//      original server file name.
//   5. Save activity title/date/detail text together with each image row.
//   6. Create nongtalay-activity-downloads/nongtalay_activity_import.sql.
//   7. Optionally import the SQL into MySQL table Activity_pictures_file.
//
// Run with:  node nongtalay-activity-pictures-scerape.js
//
// Optional MySQL import:
//   set MYSQL_HOST=127.0.0.1
//   set MYSQL_PORT=3306
//   set MYSQL_USER=root
//   set MYSQL_PASSWORD=your_password
//   node nongtalay-activity-pictures-scerape.js
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const BASE_URL = 'http://www.nongtalay.go.th/';
const ALBUM_BASE_URL = `${BASE_URL}albums/`;
const FIRST_PAGE = `${ALBUM_BASE_URL}index.php`;
const LAST_PAGE = 132;
const LIST_PAGES = [
  FIRST_PAGE,
  ...Array.from({ length: LAST_PAGE - 1 }, (_, i) => `${ALBUM_BASE_URL}index.php?Page=${i + 2}#top_page`),
];
const OUT_DIR = path.join(__dirname, 'nongtalay-activity-downloads');
const SQL_FILE = path.join(OUT_DIR, 'nongtalay_activity_import.sql');
const DB_NAME = process.env.MYSQL_DATABASE || 'nongtalay_scerape';
const TABLE_NAME = 'Activity_pictures_file';
const UA = 'Mozilla/5.0 (compatible; simple-node-scraper)';

function fetch(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    let settled = false;
    let req;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      fn(value);
    };
    const totalTimer = setTimeout(() => {
      if (req) req.destroy(new Error('timeout'));
    }, 30000);
    req = client.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'th,en-US;q=0.8,en;q=0.7',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects <= 0) return finish(reject, new Error('too many redirects'));
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return finish(resolve, fetch(next, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error(`HTTP ${res.statusCode} on ${url}`));
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, { buffer: Buffer.concat(chunks), headers: res.headers }));
      res.on('error', (error) => finish(reject, error));
    });
    req.on('error', (error) => finish(reject, error));
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
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
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
  const charset = (charsetMatch && charsetMatch[1] ? charsetMatch[1] : 'utf-8').toLowerCase();

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function cleanText(html) {
  return htmlDecode(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attrValue(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs || '');
  return m ? htmlDecode(m[1] || m[2] || m[3] || '') : '';
}

function safeName(s) {
  return htmlDecode(String(s || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'file';
}

function param(url, name) {
  try { return new URL(url).searchParams.get(name); } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractActivityLinks(html, baseUrl) {
  const re = /<a\b([^>]*href\s*=\s*(?:"[^"]*activities\.php\?salb_id=[^"]*"|'[^']*activities\.php\?salb_id=[^']*'|[^\s>]*activities\.php\?salb_id=[^\s>]*)[^>]*)>([\s\S]*?)<\/a>/gi;
  const out = new Map();
  let m;

  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const rawHref = attrValue(attrs, 'href');
    try {
      const href = new URL(rawHref, baseUrl).toString();
      const albumId = param(href, 'salb_id');
      if (!albumId) continue;

      const textTitle = cleanText(m[2]);
      const attrTitle = attrValue(attrs, 'title');
      const title = textTitle || attrTitle || `activity-${albumId}`;
      const current = out.get(href);
      if (!current || current.title.length < title.length) {
        out.set(href, { href, albumId, title });
      }
    } catch {
      // Skip malformed URLs.
    }
  }

  return [...out.values()];
}

function extractActivityDetails(html, activityUrl, fallbackTitle) {
  const titlePatterns = [
    /<b>\s*อัลบั้มภาพ\s*"([\s\S]*?)"\s*<\/b>/i,
    /<a\b[^>]*href\s*=\s*["'][^"']*activities\.php\?salb_id=[^"']*["'][^>]*class\s*=\s*["'][^"']*linktextblack[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ];
  const title = titlePatterns
    .map((pattern) => {
      const m = pattern.exec(html);
      return m ? cleanText(m[1]).replace(/^อัลบั้มภาพ\s*/i, '').trim() : '';
    })
    .find((value) => value && /[ก-๙]/.test(value))
    || fallbackTitle
    || `activity-${param(activityUrl, 'salb_id') || Date.now()}`;

  const dateMatch = /ประกาศเมื่อวันที่\s*([^)<]+)/i.exec(cleanText(html));
  const announcedDate = dateMatch ? dateMatch[1].trim() : '';

  const moreMarker = /<div\b[^>]*id\s*=\s*["']svDivAlbumsMoreC["'][^>]*>[\s\S]*?<\/div>/i.exec(html);
  const contentStart = moreMarker ? moreMarker.index + moreMarker[0].length : -1;
  const attachStart = contentStart >= 0 ? html.indexOf('<!--attach files', contentStart) : -1;
  const iframeStart = contentStart >= 0 ? html.indexOf('<iframe', contentStart) : -1;
  const contentEnd = [attachStart, iframeStart]
    .filter((index) => index > contentStart)
    .sort((a, b) => a - b)[0];
  const detailHtml = contentStart >= 0 && contentEnd
    ? html.slice(contentStart, contentEnd)
    : '';
  const description = cleanText(detailHtml)
    .trim()
    .slice(0, 5000);

  return { title, announcedDate, description };
}

function extractImageUrls(html, activityUrl, albumId) {
  const rawUrls = [];
  const attrRe = /(?:src|href)\s*=\s*(?:"([^"]+\.(?:jpg|jpeg|png|gif|webp))"|'([^']+\.(?:jpg|jpeg|png|gif|webp))'|([^\s>]+\.(?:jpg|jpeg|png|gif|webp)))/gi;
  const slideRe = /slides\d*\[\d+\]\s*=\s*\[\s*"([^"]+\.(?:jpg|jpeg|png|gif|webp))"/gi;
  let m;

  while ((m = attrRe.exec(html)) !== null) rawUrls.push(m[1] || m[2] || m[3]);
  while ((m = slideRe.exec(html)) !== null) rawUrls.push(m[1]);

  const marker = `/photoThumbnail/albums/a${albumId}_a/`;
  const out = new Set();
  for (const raw of rawUrls) {
    try {
      const url = new URL(htmlDecode(raw), activityUrl).toString();
      if (!url.includes(marker)) continue;
      if (url.includes('/thumb/')) continue;
      out.add(url);
    } catch {
      // Skip malformed image URLs.
    }
  }
  return [...out];
}

function fileNameFromUrl(fileUrl) {
  const fromPath = path.basename(new URL(fileUrl).pathname);
  try {
    return safeName(decodeURIComponent(fromPath));
  } catch {
    return safeName(fromPath);
  }
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function sqlIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function writeSql(rows) {
  const table = sqlIdentifier(TABLE_NAME);
  const lines = [
    `CREATE DATABASE IF NOT EXISTS ${sqlIdentifier(DB_NAME)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `USE ${sqlIdentifier(DB_NAME)};`,
    'SET NAMES utf8mb4;',
    'SET CHARACTER SET utf8mb4;',
    '',
    `DROP TABLE IF EXISTS ${table};`,
    `CREATE TABLE ${table} (`,
    '  id INT AUTO_INCREMENT PRIMARY KEY,',
    '  page_no INT NULL,',
    '  album_id VARCHAR(64) NOT NULL,',
    '  listing_url TEXT NOT NULL,',
    '  activity_url TEXT NOT NULL,',
    '  title TEXT NOT NULL,',
    '  description TEXT NULL,',
    '  announced_date VARCHAR(255) NULL,',
    '  folder_path TEXT NOT NULL,',
    '  image_index INT NOT NULL,',
    '  image_name VARCHAR(255) NOT NULL,',
    '  image_url TEXT NOT NULL,',
    '  local_path TEXT NOT NULL,',
    '  file_size BIGINT NOT NULL,',
    '  downloaded_at DATETIME NOT NULL',
    ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    '',
  ];

  for (const row of rows) {
    lines.push([
      `INSERT INTO ${table}`,
      '(page_no, album_id, listing_url, activity_url, title, description, announced_date, folder_path, image_index, image_name, image_url, local_path, file_size, downloaded_at)',
      'VALUES',
      `(${[
        row.pageNo === null || row.pageNo === undefined ? 'NULL' : Number(row.pageNo),
        sqlString(row.albumId),
        sqlString(row.listingUrl),
        sqlString(row.activityUrl),
        sqlString(row.title),
        sqlString(row.description),
        sqlString(row.announcedDate),
        sqlString(row.folderPath),
        row.imageIndex,
        sqlString(row.imageName),
        sqlString(row.imageUrl),
        sqlString(row.localPath),
        row.fileSize,
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
  console.log(`Imported SQL into MySQL database "${DB_NAME}" table "${TABLE_NAME}"`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const activityMap = new Map();
  for (const listUrl of LIST_PAGES) {
    try {
      console.log('[visit albums]', listUrl);
      const response = await fetch(listUrl);
      const html = decodeBuffer(response.buffer, response.headers);
      const pageNo = param(listUrl, 'Page') ? Number(param(listUrl, 'Page')) : 1;
      const activities = extractActivityLinks(html, listUrl);

      for (const activity of activities) {
        const current = activityMap.get(activity.href);
        if (!current || current.title.length < activity.title.length) {
          activityMap.set(activity.href, {
            ...activity,
            listingUrl: listUrl,
            pageNo,
          });
        }
      }
      await sleep(100);
    } catch (e) {
      console.error('  [albums fail]', listUrl, '-', e.message);
    }
  }
  console.log(`  -> ${activityMap.size} activity pages found`);

  let imageCount = 0;
  const rows = [];
  for (const [activityUrl, source] of activityMap) {
    try {
      console.log('[visit activity]', activityUrl);
      const response = await fetch(activityUrl);
      const html = decodeBuffer(response.buffer, response.headers);
      const details = extractActivityDetails(html, activityUrl, source.title);
      const imageUrls = extractImageUrls(html, activityUrl, source.albumId);
      const folderPath = path.join(OUT_DIR, safeName(details.title));
      fs.mkdirSync(folderPath, { recursive: true });

      let imageIndex = 0;
      for (const imageUrl of imageUrls) {
        try {
          imageIndex++;
          const imageName = fileNameFromUrl(imageUrl);
          const target = path.join(folderPath, imageName);
          let fileSize;
          let downloaded = false;
          if (fs.existsSync(target)) {
            fileSize = fs.statSync(target).size;
          } else {
            const { buffer } = await fetch(imageUrl);
            fs.writeFileSync(target, buffer);
            fileSize = buffer.length;
            downloaded = true;
          }
          imageCount++;
          rows.push({
            pageNo: source.pageNo,
            albumId: source.albumId,
            listingUrl: source.listingUrl,
            activityUrl,
            title: details.title,
            description: details.description,
            announcedDate: details.announcedDate,
            folderPath,
            imageIndex,
            imageName,
            imageUrl,
            localPath: target,
            fileSize,
            downloadedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          });
          if (imageCount % 100 === 0) {
            console.log(`  saved ${imageCount} images so far`);
          }
          if (downloaded) await sleep(20);
        } catch (e) {
          console.error('  [image fail]', imageUrl, '-', e.message);
        }
      }
    } catch (e) {
      console.error('  [activity fail]', activityUrl, '-', e.message);
    }
  }

  writeSql(rows);
  importSqlIfConfigured();
  console.log(`Done. ${imageCount} images saved in ${OUT_DIR}`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
