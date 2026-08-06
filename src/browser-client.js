const fs = require("fs");
const path = require("path");
const { looksLikeHtml } = require("./file-audit");
const { alignUrlOriginToReferer, isDifferentOrigin } = require("./url-origin");

let browserStatePromise = null;
let browserNoticeShown = false;
const refererAssetCache = new Map();
const STOP_ERROR = "JOB_STOPPED_BY_USER";

function createHttpError(statusCode, url) {
    const status = Number(statusCode) || 0;
    const error = new Error(`HTTP ${status || "UNKNOWN"} on ${url} (Browser)`);
    error.statusCode = status || null;
    error.url = url;
    error.code = status ? `HTTP_${status}` : "HTTP_UNKNOWN";
    return error;
}

function assertNotStopped(shouldStop) {
    if (typeof shouldStop === "function" && shouldStop()) {
        throw new Error(STOP_ERROR);
    }
}

async function waitWithStop(page, totalMs, shouldStop, stepMs = 500) {
    let elapsed = 0;
    while (elapsed < totalMs) {
        assertNotStopped(shouldStop);
        const chunk = Math.min(stepMs, totalMs - elapsed);
        await page.waitForTimeout(chunk);
        elapsed += chunk;
    }
}

function boolEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === "") return fallback;
    return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function firstExisting(paths) {
    return paths.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function findBrowserExecutable() {
    if (process.env.BROWSER_EXECUTABLE_PATH) {
        return process.env.BROWSER_EXECUTABLE_PATH;
    }

    if (process.platform === "win32") {
        return firstExisting([
            path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]);
    }

    if (process.platform === "darwin") {
        return firstExisting([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]);
    }

    return firstExisting([
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
    ]);
}

function logOnce(logger, message) {
    if (browserNoticeShown) return;
    browserNoticeShown = true;
    if (logger) logger(message);
}

async function createBrowserState(logger) {
    let chromium;
    try {
        ({ chromium } = require("playwright-core"));
    } catch (error) {
        throw new Error(
            "ไม่พบ playwright-core กรุณารัน npm.cmd install ก่อนเริ่มระบบ",
            { cause: error },
        );
    }

    const mode = String(process.env.BROWSER_MODE || "auto").trim().toLowerCase();
    const cdpUrl = process.env.BROWSER_CDP_URL || "http://127.0.0.1:9222";

    if (mode !== "launch") {
        try {
            const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 2500 });
            const context = browser.contexts()[0];
            if (!context) throw new Error("Chrome ไม่มี default browser context");
            logOnce(logger, `เชื่อมต่อ Chrome ที่เปิดไว้แล้วผ่าน ${cdpUrl}`);
            return { context, browser, connectionType: "cdp" };
        } catch (error) {
            if (mode === "cdp") {
                throw new Error(
                    `เชื่อมต่อ Chrome ไม่สำเร็จที่ ${cdpUrl} กรุณาเปิด Chrome ด้วย --remote-debugging-port=9222`,
                    { cause: error },
                );
            }
        }
    }

    const executablePath = findBrowserExecutable();
    if (!executablePath) {
        throw new Error(
            "ไม่พบ Google Chrome, Microsoft Edge หรือ Chromium กรุณาติดตั้ง Browser หรือกำหนด BROWSER_EXECUTABLE_PATH ใน .env",
        );
    }

    const profileDir = path.resolve(
        process.env.BROWSER_PROFILE_DIR || path.join(__dirname, "..", ".browser-profile"),
    );
    fs.mkdirSync(profileDir, { recursive: true });

    const headless = boolEnv("BROWSER_HEADLESS", false);
    const context = await chromium.launchPersistentContext(profileDir, {
        executablePath,
        headless,
        acceptDownloads: true,
        locale: "th-TH",
        viewport: headless ? { width: 1440, height: 1000 } : null,
        args: [
            ...(process.platform === "linux" ? ["--no-sandbox"] : []),
            ...(!headless ? ["--start-maximized"] : []),
        ],
    });

    logOnce(
        logger,
        `เปิด Browser จริงสำหรับเว็บไซต์ที่บล็อก HTTP request (${headless ? "headless" : "แสดงหน้าต่าง"})`,
    );
    return { context, browser: null, connectionType: "persistent" };
}

async function getBrowserState(logger) {
    if (!browserStatePromise) {
        browserStatePromise = createBrowserState(logger).catch((error) => {
            browserStatePromise = null;
            throw error;
        });
    }
    return browserStatePromise;
}


function browserNumberEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(min, Math.min(max, raw));
}

async function stopPageLoading(page) {
    if (!page || page.isClosed()) return;
    let cdp = null;
    try {
        if (page.context() && typeof page.context().newCDPSession === "function") {
            cdp = await page.context().newCDPSession(page);
            await cdp.send("Page.stopLoading");
            return;
        }
    } catch {
        // ใช้ window.stop() ต่อ หาก CDP ใช้ไม่ได้
    } finally {
        if (cdp) await cdp.detach().catch(() => {});
    }
    await page.evaluate(() => window.stop()).catch(() => {});
}

function installWorkerPageGuards(page, logger) {
    const onDialog = async (dialog) => {
        if (logger) {
            logger(`ปิดกล่องข้อความที่ขัดขวางการโหลดอัตโนมัติ: ${dialog.type()}`);
        }
        await dialog.dismiss().catch(() => {});
    };
    const onPopup = async (popup) => {
        if (logger) logger("ปิดแท็บ Popup ที่เว็บไซต์เปิดขึ้นมาอัตโนมัติ");
        await popup.close({ runBeforeUnload: false }).catch(() => {});
    };
    page.on("dialog", onDialog);
    page.on("popup", onPopup);
    page.once("close", () => {
        page.off("dialog", onDialog);
        page.off("popup", onPopup);
    });
    return page;
}

async function createWorkerPage(context, logger) {
    const page = await context.newPage();
    return installWorkerPageGuards(page, logger);
}

/**
 * สระแท็บสำหรับหน้า HTML — ใช้ซ้ำแทนการเปิด/ปิดแท็บใหม่ทุกหน้า
 * การสร้างแท็บใหม่ทำให้ Chrome ดันหน้าต่างขึ้นมาแย่งโฟกัสจากงานที่ผู้ใช้ทำอยู่
 * ตั้ง BROWSER_PAGE_POOL_MAX=0 เพื่อกลับไปใช้พฤติกรรมเดิม
 */
const htmlPagePools = new WeakMap();

function htmlPoolLimit() {
    const raw = Number(process.env.BROWSER_PAGE_POOL_MAX);
    if (!Number.isFinite(raw)) return 4;
    return Math.max(0, Math.min(16, Math.floor(raw)));
}

function getHtmlPool(context) {
    if (!htmlPagePools.has(context)) htmlPagePools.set(context, []);
    return htmlPagePools.get(context);
}

async function acquireHtmlPage(context, logger) {
    if (htmlPoolLimit() > 0) {
        const pool = getHtmlPool(context);
        while (pool.length) {
            const page = pool.pop();
            if (page && !page.isClosed()) return page;
        }
    }
    return createWorkerPage(context, logger);
}

async function releaseHtmlPage(context, page, logger) {
    if (!page || page.isClosed()) return;
    const limit = htmlPoolLimit();
    const pool = getHtmlPool(context);
    if (limit <= 0 || pool.length >= limit) {
        await closeWorkerPage(page, logger);
        return;
    }
    try {
        // ล้าง Referer ของงานก่อนหน้า ไม่ให้ติดไปกับหน้าถัดไป
        await page.setExtraHTTPHeaders({});
        pool.push(page);
    } catch {
        await closeWorkerPage(page, logger);
    }
}

async function closeWorkerPage(page, logger) {
    if (!page || page.isClosed()) return;
    const closeTimeoutMs = browserNumberEnv("BROWSER_TAB_CLOSE_TIMEOUT_MS", 2500, {
        min: 250,
        max: 15000,
    });
    let timer = null;
    const closePromise = page.close({ runBeforeUnload: false }).catch(() => {});
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(resolve, closeTimeoutMs);
    });
    await Promise.race([closePromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    if (!page.isClosed()) {
        // ห้ามการปิดแท็บของ Chrome มาบล็อกลูปดึงข้อมูล
        page.close({ runBeforeUnload: false }).catch(() => {});
        if (logger) logger("แท็บ Worker ปิดช้า ระบบปล่อยปิดเบื้องหลังและทำรายการถัดไป");
    }
}

/**
 * เปิดหน้า HTML แบบไม่รอทรัพยากรทุกไฟล์จนเสร็จ
 * เว็บราชการรุ่นเก่าหลายแห่งมี iframe/counter/รูปภายนอกที่โหลดไม่จบ ทำให้
 * waitUntil=domcontentloaded ค้างจนผู้ใช้ต้องปิดแท็บเอง ฟังก์ชันนี้รอเพียง commit,
 * ให้ DOM สร้างตัวตามเวลาที่กำหนด แล้วสั่งหยุด resource ที่ยังค้างเพื่อทำงานต่อ
 */
async function gotoHtmlPageNonBlocking(page, url, logger, options = {}) {
    assertNotStopped(options.shouldStop);
    const commitTimeout = browserNumberEnv("BROWSER_HTML_COMMIT_TIMEOUT_MS", 20000, {
        min: 3000,
        max: 120000,
    });
    const domTimeout = browserNumberEnv("BROWSER_DOM_READY_TIMEOUT_MS", 7000, {
        min: 500,
        max: 60000,
    });

    let response = null;
    try {
        response = await page.goto(url, {
            waitUntil: "commit",
            timeout: commitTimeout,
            referer: options.referer || undefined,
        });
    } catch (error) {
        const currentUrl = page.isClosed() ? "" : page.url();
        const committed = currentUrl && currentUrl !== "about:blank";
        if (!committed) throw error;
        if (logger) {
            logger(`หน้าเว็บตอบกลับแล้วแต่โหลดต่อไม่จบ จึงหยุดโหลดส่วนเกินและทำงานต่อ: ${currentUrl}`);
        }
    }

    assertNotStopped(options.shouldStop);
    let domReady = true;
    try {
        await page.waitForFunction(
            () => Boolean(document.documentElement && (document.body || document.readyState !== "loading")),
            null,
            { timeout: domTimeout },
        );
    } catch {
        domReady = false;
    }

    const status = response ? response.status() : 0;
    const settleMs = browserNumberEnv("BROWSER_PAGE_SETTLE_MS", 1200, {
        min: 0,
        max: 15000,
    });
    // ให้ CSS/รูปหลัก/JavaScript ที่จำเป็นมีเวลาทำงานเล็กน้อย แต่ไม่รอ widget ภายนอกเป็นนาที
    if (status !== 403 && settleMs > 0) {
        await waitWithStop(page, settleMs, options.shouldStop, 250).catch(() => {});
    }

    // หน้า 403 อาจเป็น Challenge จึงปล่อยให้ navigateWithRetry จัดการก่อน
    if (status !== 403) {
        await stopPageLoading(page);
    }
    if (!domReady && logger) {
        logger(`DOM ใช้เวลานานเกิน ${domTimeout} ms ระบบใช้ HTML ที่โหลดได้แล้วและทำงานต่อ`);
    }
    return response;
}

async function reloadHtmlPageNonBlocking(page, logger, options = {}) {
    assertNotStopped(options.shouldStop);
    const commitTimeout = browserNumberEnv("BROWSER_HTML_COMMIT_TIMEOUT_MS", 20000, {
        min: 3000,
        max: 120000,
    });
    const domTimeout = browserNumberEnv("BROWSER_DOM_READY_TIMEOUT_MS", 7000, {
        min: 500,
        max: 60000,
    });
    let response = null;
    try {
        response = await page.reload({ waitUntil: "commit", timeout: commitTimeout });
    } catch (error) {
        const currentUrl = page.isClosed() ? "" : page.url();
        if (!currentUrl || currentUrl === "about:blank") throw error;
    }
    await page
        .waitForFunction(
            () => Boolean(document.documentElement && (document.body || document.readyState !== "loading")),
            null,
            { timeout: domTimeout },
        )
        .catch(() => {});
    const status = response ? response.status() : 0;
    const settleMs = browserNumberEnv("BROWSER_PAGE_SETTLE_MS", 1200, { min: 0, max: 15000 });
    if (status !== 403 && settleMs > 0) {
        await waitWithStop(page, settleMs, options.shouldStop, 250).catch(() => {});
        await stopPageLoading(page);
    }
    return response;
}

function headersToObject(headers) {
    if (!headers) return {};
    return Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]),
    );
}

async function navigateWithRetry(page, url, logger, options) {
    assertNotStopped(options.shouldStop);
    const waitUntil = options.isHtml ? "domcontentloaded" : "commit";
    let response = options.isHtml
        ? await gotoHtmlPageNonBlocking(page, url, logger, options)
        : await page.goto(url, {
              waitUntil,
              timeout: Number(process.env.BROWSER_TIMEOUT_MS || 90000),
              referer: options.referer || undefined,
          });

    assertNotStopped(options.shouldStop);
    let status = response ? response.status() : 0;
    if (status !== 403) return response;

    if (logger) {
        logger(
            "Browser ยังได้รับ HTTP 403 หากมีหน้าตรวจสอบปรากฏขึ้น ให้ดำเนินการในหน้าต่าง Chrome ระบบจะลองใหม่อัตโนมัติ",
        );
    }

    const retrySeconds = Math.max(10, Number(process.env.BROWSER_CHALLENGE_WAIT_SECONDS || 90));
    const retries = Math.ceil(retrySeconds / 5);
    for (let i = 0; i < retries; i += 1) {
        await waitWithStop(page, 5000, options.shouldStop);
        assertNotStopped(options.shouldStop);
        response = options.isHtml
            ? await reloadHtmlPageNonBlocking(page, logger, options)
            : await page.reload({
                  waitUntil,
                  timeout: Number(process.env.BROWSER_TIMEOUT_MS || 90000),
              });
        assertNotStopped(options.shouldStop);
        status = response ? response.status() : 0;
        if (status !== 403) return response;
    }

    return response;
}

function comparableUrl(value) {
    try {
        const parsed = new URL(value);
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return String(value || "");
    }
}

function sameAssetTarget(candidateUrl, targetUrl) {
    if (comparableUrl(candidateUrl) === comparableUrl(targetUrl)) return true;
    try {
        const candidate = new URL(candidateUrl);
        const target = new URL(targetUrl);
        return candidate.pathname === target.pathname && candidate.search === target.search;
    } catch {
        return false;
    }
}

// User agent ของ Chrome เป็นค่าคงที่ตลอดอายุ context จึงอ่านครั้งเดียวแล้วเก็บไว้
// เดิมอ่านใหม่ทุกไฟล์ ทำให้ต้องเปิด/ปิดแท็บเปล่าหลายร้อยครั้งต่อหนึ่งงาน
const contextUserAgents = new WeakMap();

function getContextUserAgent(context, logger) {
    if (!contextUserAgents.has(context)) {
        const promise = (async () => {
            let page = null;
            try {
                page = await createWorkerPage(context, logger);
                const value = await page.evaluate(() => navigator.userAgent);
                if (value) return String(value);
            } catch {
                // ใช้ค่าสำรองด้านล่าง
            } finally {
                if (page) await closeWorkerPage(page, logger).catch(() => {});
            }
            return "Mozilla/5.0";
        })();
        contextUserAgents.set(context, promise);
    }
    return contextUserAgents.get(context);
}

async function browserContextRawRequest(context, url, logger, requestOptions = {}) {
    if (!context.request || typeof context.request.get !== "function") return null;
    assertNotStopped(requestOptions.shouldStop);

    const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 90000);
    const userAgent = await getContextUserAgent(context, logger);
    const headers = {
        Accept: "application/pdf,application/octet-stream,application/zip,image/*,*/*;q=0.8",
        "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
        "User-Agent": userAgent,
    };
    if (requestOptions.referer) headers.Referer = requestOptions.referer;

    let response;
    try {
        response = await context.request.get(url, {
            headers,
            timeout,
            failOnStatusCode: false,
            maxRedirects: 10,
        });
    } catch (error) {
        if (String(error && error.message) === STOP_ERROR) throw error;
        return null;
    }

    assertNotStopped(requestOptions.shouldStop);
    const status = response.status();
    if (status === 403) return null;
    if (status < 200 || status >= 300) throw createHttpError(status, url);

    const buffer = await response.body();
    const result = {
        buffer,
        headers: headersToObject(response.headers()),
        statusCode: status,
        finalUrl: response.url(),
    };

    // หาก API request ได้ HTML wrapper ให้ไปจับ network response จากการเปิดผ่านหน้า Chrome ต่อ
    if (requestOptions.expectFile && looksLikeHtml(result.buffer, result.headers)) {
        if (logger) {
            logger(`Chrome request ยังตอบเป็น HTML wrapper กำลังจับ response ไฟล์ดิบ: ${url}`);
        }
        return null;
    }

    return result;
}

async function capturedResponseResult(responses, url, requestOptions = {}) {
    for (const response of [...responses].reverse()) {
        const status = response.status();
        if (status < 200 || status >= 300) continue;
        try {
            const headers = headersToObject(await response.allHeaders());
            const buffer = await response.body();
            if (requestOptions.expectFile && looksLikeHtml(buffer, headers)) continue;
            return {
                buffer,
                headers,
                statusCode: status,
                finalUrl: response.url() || url,
            };
        } catch {
            // response body บางชนิดอ่านซ้ำไม่ได้ ให้ลองรายการถัดไป
        }
    }
    return null;
}

function isLikelyAssetResponse(response) {
    try {
        const resourceType = response.request().resourceType();
        if (["image", "media", "font"].includes(resourceType)) return true;
        return /\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|jpe?g|png|gif|webp|bmp|tiff?|svg|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#]|$)/i.test(
            new URL(response.url()).pathname,
        );
    } catch {
        return false;
    }
}

function isLikelyAssetUrl(url, mimeType = "", resourceType = "") {
    try {
        if (["Image", "Media", "Font", "image", "media", "font"].includes(resourceType)) return true;
        if (/^(?:image\/|video\/|audio\/|application\/(?:pdf|zip|octet-stream|ogg|vnd\.apple\.mpegurl|x-mpegurl)|application\/vnd\.)/i.test(String(mimeType || ""))) {
            return true;
        }
        return /\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|jpe?g|png|gif|webp|bmp|tiff?|svg|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#]|$)/i.test(
            new URL(url).pathname,
        );
    } catch {
        return false;
    }
}

function assetFileName(value) {
    try {
        const pathname = decodeURIComponent(new URL(value).pathname || "");
        return pathname.split("/").filter(Boolean).pop()?.toLowerCase() || "";
    } catch {
        return "";
    }
}

function findCachedAsset(cache, targetUrl) {
    if (!cache || cache.size === 0) return null;
    const direct = cache.get(comparableUrl(targetUrl));
    if (direct) return direct;

    const targetFileName = assetFileName(targetUrl);
    for (const [candidateUrl, result] of cache.entries()) {
        if (sameAssetTarget(candidateUrl, targetUrl)) return result;
        // เว็บบางแห่ง redirect รูปไป endpoint/cache คนละ path แต่ยังใช้ชื่อไฟล์เดิม
        if (targetFileName && assetFileName(candidateUrl) === targetFileName) return result;
    }
    return null;
}

async function activateLazyAssets(page) {
    await page
        .evaluate(() => {
            const attrNames = ["data-src", "data-original", "data-lazy-src", "data-url"];
            for (const image of document.querySelectorAll("img")) {
                if (image.getAttribute("src")) continue;
                const lazyUrl = attrNames.map((name) => image.getAttribute(name)).find(Boolean);
                if (lazyUrl) image.setAttribute("src", lazyUrl);
            }
            for (const source of document.querySelectorAll("source[data-srcset]")) {
                if (!source.getAttribute("srcset")) {
                    source.setAttribute("srcset", source.getAttribute("data-srcset"));
                }
            }
        })
        .catch(() => {});
}

async function scrollRefererPage(page, shouldStop) {
    const rounds = Math.max(2, Number(process.env.BROWSER_LAZY_SCROLL_ROUNDS || 8));
    for (let index = 0; index < rounds; index += 1) {
        assertNotStopped(shouldStop);
        await activateLazyAssets(page);
        await page
            .evaluate(() => {
                window.scrollBy(0, Math.max(window.innerHeight || 800, 800));
            })
            .catch(() => {});
        await waitWithStop(page, 250, shouldStop, 250);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await waitWithStop(page, 300, shouldStop, 300);
}

async function responseToAssetResult(response, requestOptions = {}) {
    const status = response.status();
    if (status < 200 || status >= 300) return null;
    try {
        const headers = headersToObject(await response.allHeaders());
        const buffer = await response.body();
        if (!buffer || buffer.length === 0) return null;
        if (requestOptions.expectFile && looksLikeHtml(buffer, headers)) return null;
        return {
            buffer,
            headers,
            statusCode: status,
            finalUrl: response.url(),
        };
    } catch {
        return null;
    }
}


async function extractRenderedImageFromPage(page, assetUrl, requestOptions = {}) {
    assertNotStopped(requestOptions.shouldStop);
    const timeoutMs = Math.max(5000, Number(process.env.BROWSER_IMAGE_RENDER_TIMEOUT_MS || 30000));
    const maxPixels = Math.max(
        1_000_000,
        Number(process.env.BROWSER_IMAGE_CANVAS_MAX_PIXELS || 40_000_000),
    );

    const result = await page
        .evaluate(
            async ({ targetUrl, timeoutMs, maxPixels, referrerPolicy }) => {
                const normalize = (value) => {
                    try {
                        const url = new URL(value, window.location.href);
                        url.hash = "";
                        return url.toString();
                    } catch {
                        return String(value || "");
                    }
                };
                const target = normalize(targetUrl);
                const targetObject = (() => {
                    try {
                        return new URL(target);
                    } catch {
                        return null;
                    }
                })();
                const matches = (value) => {
                    const normalized = normalize(value);
                    if (normalized === target) return true;
                    try {
                        const candidate = new URL(normalized);
                        return Boolean(
                            targetObject &&
                                candidate.pathname === targetObject.pathname &&
                                candidate.search === targetObject.search,
                        );
                    } catch {
                        return false;
                    }
                };

                let image = [...document.images].find((item) =>
                    [item.currentSrc, item.src, item.getAttribute("src"), item.dataset && item.dataset.src]
                        .filter(Boolean)
                        .some(matches),
                );
                let created = false;
                if (!image) {
                    image = document.createElement("img");
                    image.alt = "scraper-download";
                    if (referrerPolicy) image.referrerPolicy = referrerPolicy;
                    image.loading = "eager";
                    image.decoding = "sync";
                    image.style.cssText =
                        "position:fixed;left:-100000px;top:0;max-width:none;max-height:none;opacity:0.01;pointer-events:none;";
                    document.body.appendChild(image);
                    created = true;
                    image.src = targetUrl;
                } else {
                    image.loading = "eager";
                    const lazy =
                        image.getAttribute("data-src") ||
                        image.getAttribute("data-original") ||
                        image.getAttribute("data-lazy-src");
                    if ((!image.getAttribute("src") || !matches(image.currentSrc || image.src)) && lazy) {
                        image.src = lazy;
                    }
                }

                const waitForImage = async () => {
                    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return true;
                    return new Promise((resolve) => {
                        let done = false;
                        const finish = (value) => {
                            if (done) return;
                            done = true;
                            clearTimeout(timer);
                            image.removeEventListener("load", onLoad);
                            image.removeEventListener("error", onError);
                            resolve(value);
                        };
                        const onLoad = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
                        const onError = () => finish(false);
                        const timer = setTimeout(() => finish(false), timeoutMs);
                        image.addEventListener("load", onLoad, { once: true });
                        image.addEventListener("error", onError, { once: true });
                    });
                };

                let loaded = await waitForImage();
                if (!loaded && !created) {
                    const replacement = document.createElement("img");
                    replacement.alt = "scraper-download-retry";
                    if (referrerPolicy) replacement.referrerPolicy = referrerPolicy;
                    replacement.loading = "eager";
                    replacement.decoding = "sync";
                    replacement.style.cssText =
                        "position:fixed;left:-100000px;top:0;max-width:none;max-height:none;opacity:0.01;pointer-events:none;";
                    document.body.appendChild(replacement);
                    image = replacement;
                    created = true;
                    image.src = targetUrl;
                    loaded = await waitForImage();
                }
                if (!loaded) {
                    if (created) image.remove();
                    return { ok: false, reason: "image-load-failed" };
                }

                const naturalWidth = image.naturalWidth;
                const naturalHeight = image.naturalHeight;
                const pixels = naturalWidth * naturalHeight;
                let width = naturalWidth;
                let height = naturalHeight;
                if (pixels > maxPixels) {
                    const ratio = Math.sqrt(maxPixels / pixels);
                    width = Math.max(1, Math.floor(naturalWidth * ratio));
                    height = Math.max(1, Math.floor(naturalHeight * ratio));
                }

                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const context2d = canvas.getContext("2d", { alpha: true });
                if (!context2d) {
                    if (created) image.remove();
                    return { ok: false, reason: "canvas-unavailable" };
                }

                try {
                    context2d.drawImage(image, 0, 0, width, height);
                    const path = targetObject ? targetObject.pathname.toLowerCase() : "";
                    const requestedType = /\.jpe?g$/.test(path)
                        ? "image/jpeg"
                        : /\.webp$/.test(path)
                          ? "image/webp"
                          : "image/png";
                    let dataUrl = canvas.toDataURL(requestedType, 0.96);
                    let mimeType = requestedType;
                    if (!dataUrl.startsWith(`data:${requestedType}`)) {
                        dataUrl = canvas.toDataURL("image/png");
                        mimeType = "image/png";
                    }
                    if (created) image.remove();
                    return {
                        ok: true,
                        mimeType,
                        base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
                        width,
                        height,
                        naturalWidth,
                        naturalHeight,
                    };
                } catch (error) {
                    if (created) image.remove();
                    return {
                        ok: false,
                        reason: "canvas-security-error",
                        error: String(error && error.message ? error.message : error),
                    };
                }
            },
            {
                targetUrl: assetUrl,
                timeoutMs,
                maxPixels,
                referrerPolicy: requestOptions.referrerPolicy || null,
            },
        )
        .catch(() => null);

    assertNotStopped(requestOptions.shouldStop);
    if (!result || !result.ok || !result.base64) return null;
    const buffer = Buffer.from(result.base64, "base64");
    if (!buffer.length) return null;
    return {
        buffer,
        headers: {
            "content-type": result.mimeType || "image/png",
            "x-scraper-source": "rendered-image-canvas",
            "x-original-dimensions": `${result.naturalWidth || result.width}x${
                result.naturalHeight || result.height
            }`,
        },
        statusCode: 200,
        finalUrl: assetUrl,
    };
}


async function extractRenderedImageFromAllFrames(page, assetUrl, requestOptions = {}) {
    const frames = typeof page.frames === "function" ? page.frames() : [page];
    const policies = [
        undefined,
        "no-referrer",
        "origin",
        "strict-origin-when-cross-origin",
        "unsafe-url",
    ];

    for (const frame of frames) {
        for (const policy of policies) {
            assertNotStopped(requestOptions.shouldStop);
            const result = await extractRenderedImageFromPage(frame, assetUrl, {
                ...requestOptions,
                referrerPolicy: policy,
            }).catch(() => null);
            if (result) return result;
        }
    }
    return null;
}

/**
 * Playwright ต้องดันแท็บขึ้นมาหน้าสุดก่อนถ่าย screenshot ซึ่งแย่งโฟกัสจากผู้ใช้
 * ตั้ง BROWSER_ALLOW_SCREENSHOT_FALLBACK=false เพื่อปิด แลกกับการกู้รูปที่โดน hotlink block ไม่ได้
 */
function screenshotFallbackEnabled() {
    const raw = process.env.BROWSER_ALLOW_SCREENSHOT_FALLBACK;
    if (raw === undefined || raw === null || String(raw).trim() === "") return true;
    return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

async function screenshotRenderedAssetElement(page, assetUrl, requestOptions = {}) {
    if (!screenshotFallbackEnabled()) return null;
    assertNotStopped(requestOptions.shouldStop);
    const minBytes = Math.max(1000, Number(process.env.BROWSER_ELEMENT_SCREENSHOT_MIN_BYTES || 1500));
    const timeout = Math.max(5000, Number(process.env.BROWSER_IMAGE_RENDER_TIMEOUT_MS || 30000));
    const candidates = page.locator(
        "img, picture img, [style*='background-image'], [data-background], [data-bg]",
    );
    const count = Math.min(await candidates.count().catch(() => 0), 500);

    for (let index = 0; index < count; index += 1) {
        assertNotStopped(requestOptions.shouldStop);
        const candidate = candidates.nth(index);
        const meta = await candidate
            .evaluate((element, targetUrl) => {
                const normalize = (value) => {
                    try {
                        const url = new URL(value, window.location.href);
                        url.hash = "";
                        return url.toString();
                    } catch {
                        return String(value || "");
                    }
                };
                const fileName = (value) => {
                    try {
                        const path = decodeURIComponent(new URL(value, window.location.href).pathname);
                        return path.split("/").filter(Boolean).pop()?.toLowerCase() || "";
                    } catch {
                        return "";
                    }
                };
                const target = normalize(targetUrl);
                const targetName = fileName(target);
                const matches = (value) => {
                    if (!value) return false;
                    const normalized = normalize(value);
                    if (normalized === target) return true;
                    try {
                        const a = new URL(normalized);
                        const b = new URL(target);
                        if (a.pathname === b.pathname && a.search === b.search) return true;
                    } catch {
                        // ignore
                    }
                    return Boolean(targetName && fileName(normalized) === targetName);
                };

                const values = [];
                if (element instanceof HTMLImageElement) {
                    values.push(
                        element.currentSrc,
                        element.src,
                        element.getAttribute("src"),
                        element.getAttribute("data-src"),
                        element.getAttribute("data-original"),
                        element.getAttribute("data-lazy-src"),
                    );
                }
                values.push(
                    element.getAttribute("data-background"),
                    element.getAttribute("data-bg"),
                );
                const style = getComputedStyle(element).backgroundImage || "";
                for (const match of style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
                    values.push(match[1]);
                }
                const anchor = element.closest("a[href]");
                if (anchor) values.push(anchor.href, anchor.getAttribute("href"));

                const rect = element.getBoundingClientRect();
                const imageLoaded =
                    !(element instanceof HTMLImageElement) ||
                    (element.complete && element.naturalWidth > 1 && element.naturalHeight > 1);
                return {
                    matches: values.filter(Boolean).some(matches),
                    imageLoaded,
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    naturalWidth: element instanceof HTMLImageElement ? element.naturalWidth : 0,
                    naturalHeight: element instanceof HTMLImageElement ? element.naturalHeight : 0,
                };
            }, assetUrl)
            .catch(() => null);

        if (!meta || !meta.matches || !meta.imageLoaded || meta.width < 2 || meta.height < 2) continue;

        try {
            await candidate.scrollIntoViewIfNeeded({ timeout });
            const buffer = await candidate.screenshot({
                type: "png",
                animations: "disabled",
                timeout,
            });
            if (!buffer || buffer.length < minBytes) continue;
            return {
                buffer,
                headers: {
                    "content-type": "image/png",
                    "x-scraper-source": "rendered-element-screenshot",
                    "x-original-dimensions": `${meta.naturalWidth || meta.width}x${meta.naturalHeight || meta.height}`,
                    "x-scraper-note": "original-url-blocked-used-rendered-copy",
                },
                statusCode: 200,
                finalUrl: assetUrl,
            };
        } catch {
            // ลอง element ถัดไป
        }
    }
    return null;
}

async function screenshotRenderedAssetElementFromAllFrames(page, assetUrl, requestOptions = {}) {
    const frames = typeof page.frames === "function" ? page.frames() : [page];
    for (const frame of frames) {
        assertNotStopped(requestOptions.shouldStop);
        const result = await screenshotRenderedAssetElement(
            frame,
            assetUrl,
            requestOptions,
        ).catch(() => null);
        if (result) return result;
    }
    return null;
}

async function fetchAssetInsidePage(page, assetUrl, requestOptions = {}) {
    assertNotStopped(requestOptions.shouldStop);
    const maxBytes = Math.max(
        1_000_000,
        Number(process.env.BROWSER_IN_PAGE_MAX_FILE_MB || 50) * 1024 * 1024,
    );

    const result = await page
        .evaluate(
            async ({ targetUrl, maxBytes }) => {
                try {
                    const response = await fetch(targetUrl, {
                        method: "GET",
                        credentials: "include",
                        cache: "no-store",
                        redirect: "follow",
                        referrer: window.location.href,
                        referrerPolicy: "strict-origin-when-cross-origin",
                        headers: {
                            Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,application/pdf,application/octet-stream,*/*;q=0.8",
                        },
                    });
                    const buffer = await response.arrayBuffer();
                    if (buffer.byteLength > maxBytes) {
                        return {
                            ok: false,
                            status: response.status,
                            tooLarge: true,
                            byteLength: buffer.byteLength,
                        };
                    }
                    const bytes = new Uint8Array(buffer);
                    let binary = "";
                    const chunkSize = 0x8000;
                    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
                    }
                    return {
                        ok: response.ok,
                        status: response.status,
                        finalUrl: response.url,
                        headers: Object.fromEntries(response.headers.entries()),
                        base64: btoa(binary),
                    };
                } catch (error) {
                    return {
                        ok: false,
                        status: 0,
                        error: String(error && error.message ? error.message : error),
                    };
                }
            },
            { targetUrl: assetUrl, maxBytes },
        )
        .catch(() => null);

    assertNotStopped(requestOptions.shouldStop);
    if (!result || !result.ok || !result.base64) return null;
    const buffer = Buffer.from(result.base64, "base64");
    const headers = headersToObject(result.headers || {});
    if (!buffer.length) return null;
    if (requestOptions.expectFile && looksLikeHtml(buffer, headers)) return null;
    return {
        buffer,
        headers,
        statusCode: result.status || 200,
        finalUrl: result.finalUrl || assetUrl,
    };
}

async function warmRefererAssetCache(context, refererUrl, logger, requestOptions = {}) {
    const page = await createWorkerPage(context, logger);
    const cache = new Map();
    const pending = new Set();
    const cdpPending = new Set();
    const cdpRequests = new Map();
    const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 90000);
    let cdp = null;

    // Playwright response.body() อ่านไฟล์จากบางเว็บไม่ได้ โดยเฉพาะรูปที่มาจาก cache,
    // service worker หรือระบบป้องกัน hotlink จึงจับ response ดิบด้วย Chrome DevTools เพิ่มอีกชั้น
    try {
        if (context && typeof context.newCDPSession === "function") {
            cdp = await context.newCDPSession(page);
            const maxFileBytes = Math.max(
                10 * 1024 * 1024,
                Number(process.env.BROWSER_NETWORK_MAX_FILE_MB || 100) * 1024 * 1024,
            );
            await cdp.send("Network.enable", {
                maxTotalBufferSize: maxFileBytes * 3,
                maxResourceBufferSize: maxFileBytes,
                maxPostDataSize: 1024 * 1024,
            });
            await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }).catch(() => {});

            cdp.on("Network.responseReceived", (event) => {
                const response = event && event.response;
                if (!response) return;
                const status = Number(response.status) || 0;
                if (status < 200 || status >= 300) return;
                if (!isLikelyAssetUrl(response.url, response.mimeType, event.type)) return;
                cdpRequests.set(event.requestId, {
                    url: response.url,
                    status,
                    headers: headersToObject(response.headers || {}),
                });
            });

            cdp.on("Network.loadingFinished", (event) => {
                const meta = cdpRequests.get(event.requestId);
                if (!meta) return;
                cdpRequests.delete(event.requestId);
                const task = (async () => {
                    try {
                        const body = await cdp.send("Network.getResponseBody", {
                            requestId: event.requestId,
                        });
                        const buffer = body.base64Encoded
                            ? Buffer.from(body.body || "", "base64")
                            : Buffer.from(body.body || "", "utf8");
                        if (!buffer.length) return;
                        if (requestOptions.expectFile && looksLikeHtml(buffer, meta.headers)) return;
                        cache.set(comparableUrl(meta.url), {
                            buffer,
                            headers: {
                                ...meta.headers,
                                "x-scraper-source": "chrome-devtools-network",
                            },
                            statusCode: meta.status,
                            finalUrl: meta.url,
                        });
                    } catch {
                        // บาง response ถูกล้างจาก buffer ก่อนอ่าน ให้ใช้ Playwright/canvas fallback ต่อ
                    }
                })();
                cdpPending.add(task);
                task.finally(() => cdpPending.delete(task));
            });
        }
    } catch {
        cdp = null;
    }

    const onResponse = (response) => {
        if (!isLikelyAssetResponse(response)) return;
        const task = (async () => {
            const result = await responseToAssetResult(response, requestOptions);
            if (result) cache.set(comparableUrl(response.url()), result);
        })();
        pending.add(task);
        task.finally(() => pending.delete(task));
    };
    page.on("response", onResponse);

    try {
        assertNotStopped(requestOptions.shouldStop);
        const response = await gotoHtmlPageNonBlocking(page, refererUrl, logger, requestOptions);
        const status = response ? response.status() : 0;
        if (status < 200 || status >= 300) return cache;

        await scrollRefererPage(page, requestOptions.shouldStop);
        // รอรูปที่โหลดช้าหลัง scroll และให้ CDP มีเวลารับ loadingFinished
        await waitWithStop(page, 1000, requestOptions.shouldStop, 250);
        if (pending.size) await Promise.allSettled([...pending]);
        if (cdpPending.size) await Promise.allSettled([...cdpPending]);
        return cache;
    } finally {
        page.off("response", onResponse);
        if (cdp) await cdp.detach().catch(() => {});
        await closeWorkerPage(page, logger);
    }
}

/**
 * จำกัดจำนวนหน้าอ้างอิงที่เก็บ cache ไว้ (แต่ละรายการเก็บ Buffer ของทุก asset บนหน้านั้น)
 * เดิมไม่มีเพดานและไม่เคยล้าง ทำให้หน่วยความจำโตไปเรื่อย ๆ ตลอดงาน
 */
function refererCacheLimit() {
    const raw = Number(process.env.BROWSER_REFERER_CACHE_MAX);
    if (!Number.isFinite(raw)) return 8;
    return Math.max(1, Math.min(200, Math.floor(raw)));
}

function trimRefererAssetCache() {
    const limit = refererCacheLimit();
    while (refererAssetCache.size > limit) {
        const oldestKey = refererAssetCache.keys().next().value;
        if (oldestKey === undefined) break;
        refererAssetCache.delete(oldestKey);
    }
}

async function getRefererAssetCache(context, refererUrl, logger, requestOptions = {}) {
    const key = comparableUrl(refererUrl);
    if (refererAssetCache.has(key)) {
        // ใช้ล่าสุด = ย้ายไปท้ายแถว เพื่อให้รายการที่ไม่ได้ใช้ถูกเขี่ยออกก่อน
        const existing = refererAssetCache.get(key);
        refererAssetCache.delete(key);
        refererAssetCache.set(key, existing);
        return existing;
    }

    const promise = warmRefererAssetCache(context, refererUrl, logger, requestOptions).catch(
        (error) => {
            refererAssetCache.delete(key);
            throw error;
        },
    );
    refererAssetCache.set(key, promise);
    trimRefererAssetCache();
    return promise;
}

async function fetchAssetFromRefererPage(
    context,
    assetUrl,
    refererUrl,
    logger,
    requestOptions = {},
) {
    if (!refererUrl || sameAssetTarget(assetUrl, refererUrl)) return null;

    // เปิดหน้ากิจกรรมจริงหนึ่งครั้งเพื่อให้ Browser ได้ Cookie/Session และให้รูปโหลด
    // เหมือนการเปิดหน้าเว็บตามปกติ จากนั้นนำ response รูปที่โหลดสำเร็จมาใช้โดยตรง
    const cache = await getRefererAssetCache(context, refererUrl, logger, requestOptions).catch(
        () => new Map(),
    );
    const cached = findCachedAsset(cache, assetUrl);
    if (cached) {
        if (logger) logger(`ดึงไฟล์จาก response ที่หน้าอ้างอิงโหลดสำเร็จ: ${assetUrl}`);
        return cached;
    }

    // กรณีรูป lazy-load หรือไม่ได้อยู่ใน viewport ให้เปิดหน้าอ้างอิงและเรียก fetch
    // จาก JavaScript ภายใน origin เดียวกัน เพื่อให้ Browser ส่ง Cookie, Referer และ Sec-Fetch-* จริง
    const page = await createWorkerPage(context, logger);
    const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 90000);
    try {
        if (
            requestOptions.listingReferer &&
            !sameAssetTarget(requestOptions.listingReferer, refererUrl)
        ) {
            await gotoHtmlPageNonBlocking(
                page,
                requestOptions.listingReferer,
                logger,
                requestOptions,
            ).catch(() => null);
            await waitWithStop(page, 500, requestOptions.shouldStop, 250);
        }

        const response = await gotoHtmlPageNonBlocking(page, refererUrl, logger, requestOptions);
        const status = response ? response.status() : 0;
        if (status < 200 || status >= 300) return null;
        await activateLazyAssets(page);
        await scrollRefererPage(page, requestOptions.shouldStop);

        // เว็บบางแห่งยอมให้โหลดเฉพาะ request ที่มี Sec-Fetch-Dest: image เท่านั้น
        // การใช้ fetch() จะยังได้ 403 จึงอ่านรูปที่ Browser render สำเร็จผ่าน canvas ก่อน
        const renderedResult = await extractRenderedImageFromAllFrames(
            page,
            assetUrl,
            requestOptions,
        );
        if (renderedResult) {
            cache.set(comparableUrl(assetUrl), renderedResult);
            if (logger) {
                logger(`ดึงรูปจากภาพที่ Browser render สำเร็จ (แก้ hotlink 403): ${assetUrl}`);
            }
            return renderedResult;
        }

        // ถ้า canvas อ่านไม่ได้ (เช่น CORS หรือ URL ต้นฉบับถูก 403) ให้ถ่ายเฉพาะ element
        // ที่ Chrome แสดงอยู่จริง รวมถึง thumbnail ที่อยู่ใน <a href="URL ต้นฉบับ">
        const elementScreenshot = await screenshotRenderedAssetElementFromAllFrames(
            page,
            assetUrl,
            requestOptions,
        );
        if (elementScreenshot) {
            cache.set(comparableUrl(assetUrl), elementScreenshot);
            if (logger) {
                logger(
                    `URL ต้นฉบับถูกปฏิเสธ แต่บันทึกภาพที่ Chrome แสดงบนหน้าอัลบั้มสำเร็จ: ${assetUrl}`,
                );
            }
            return elementScreenshot;
        }

        const result = await fetchAssetInsidePage(page, assetUrl, requestOptions);
        if (result) {
            cache.set(comparableUrl(assetUrl), result);
            if (logger) logger(`ดึงไฟล์ผ่านหน้าอ้างอิงและ Browser session สำเร็จ: ${assetUrl}`);
        }
        return result;
    } finally {
        await closeWorkerPage(page, logger);
    }
}

function isHttpUrl(value) {
    try {
        return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

function renderedImageNoise(value) {
    return /(?:favicon|logo|icon|avatar|spinner|loading|placeholder|captcha|social|facebook|youtube|line[-_]?icon|(?:^|[\/])(?:bg[0-9_-]*|head[0-9_-]*|header[0-9_-]*|foot[0-9_-]*|footer[0-9_-]*|bt[0-9_-]*|btn[0-9_-]*|blank|close(?:label)?|name|tem(?:plate)?|vv[0-9_-]*|spacer|pixel)(?:\.(?:gif|png|jpe?g|webp|bmp))?(?:$|[?#]))/i.test(
        String(value || ""),
    );
}

function isExcludedActivityUiImage(value) {
    let pathname = "";
    let base = "";
    try {
        const parsed = new URL(String(value || ""));
        pathname = decodeURIComponent(parsed.pathname || "").toLowerCase();
        base = path.basename(pathname);
    } catch {
        pathname = String(value || "").toLowerCase();
        base = path.basename(pathname.split(/[?#]/)[0]);
    }

    if (/^(?:closelabel|close|prevlabel|nextlabel|loading|loader|spinner|blank|spacer|pixel|transparent|arrowleft|arrowright|left|right|prev|next)(?:[-_.0-9a-z]*)\.(?:gif|png|jpe?g|webp|bmp)$/i.test(base)) {
        return true;
    }
    if (/^(?:bg|head|header|foot|footer|bt|btn|button|menu|nav|name|tem|template|vv|icon|logo|banner)[-_0-9a-z]*\.(?:gif|png|jpe?g|webp|bmp)$/i.test(base)) {
        return true;
    }
    if (/(?:^|\/)(?:includes?|assets?|scripts?|js|css|styles?)(?:\/[^/]+)*\/(?:lightbox|fancybox|colorbox|prettyphoto|photoswipe)(?:\/|$)/i.test(pathname)) {
        return /(?:close|prev|next|loading|loader|blank|spacer|pixel|arrow|button|label)/i.test(base);
    }
    return false;
}

/**
 * เปิดหน้ารายละเอียดจริงใน Chrome แล้วดึงรูปที่หน้าเว็บแสดงสำเร็จ
 * วิธีนี้ไม่ยิง URL ต้นฉบับที่ถูก Hotlink Protection ซ้ำ หากหน้าเว็บใช้ thumbnail/CDN
 * จะเก็บ response ที่ Chrome โหลดได้จริง หรือ screenshot เฉพาะ element เป็น fallback
 */
async function captureRenderedImagesFromPage(pageUrl, logger, requestOptions = {}) {
    assertNotStopped(requestOptions.shouldStop);
    const { context } = await getBrowserState(logger);
    const page = await createWorkerPage(context, logger);
    const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 90000);
    const minWidth = Math.max(40, Number(process.env.BROWSER_CAPTURE_MIN_WIDTH || 100));
    const minHeight = Math.max(40, Number(process.env.BROWSER_CAPTURE_MIN_HEIGHT || 70));
    const minBytes = Math.max(500, Number(process.env.BROWSER_ELEMENT_SCREENSHOT_MIN_BYTES || 1200));
    const cache = new Map();
    const pending = new Set();

    const onResponse = (response) => {
        if (!isLikelyAssetResponse(response)) return;
        const task = (async () => {
            const result = await responseToAssetResult(response, {
                ...requestOptions,
                expectFile: true,
            });
            if (!result) return;
            const type = String(result.headers["content-type"] || "").toLowerCase();
            if (!type.startsWith("image/") && !/\.(?:jpe?g|png|gif|webp|bmp)(?:[?#]|$)/i.test(response.url())) {
                return;
            }
            cache.set(comparableUrl(response.url()), {
                ...result,
                headers: {
                    ...result.headers,
                    "x-scraper-source": "rendered-page-network",
                },
            });
        })();
        pending.add(task);
        task.finally(() => pending.delete(task));
    };
    page.on("response", onResponse);

    try {
        if (requestOptions.listingReferer && isHttpUrl(requestOptions.listingReferer)) {
            await gotoHtmlPageNonBlocking(
                page,
                requestOptions.listingReferer,
                logger,
                requestOptions,
            ).catch(() => null);
            await waitWithStop(page, 300, requestOptions.shouldStop, 150);
        }

        const response = await gotoHtmlPageNonBlocking(page, pageUrl, logger, {
            ...requestOptions,
            referer: requestOptions.listingReferer || undefined,
        });
        const status = response ? response.status() : 0;
        if (status < 200 || status >= 300) {
            throw createHttpError(status, pageUrl);
        }

        await scrollRefererPage(page, requestOptions.shouldStop);
        await waitWithStop(page, 800, requestOptions.shouldStop, 200);
        if (pending.size) await Promise.allSettled([...pending]);

        const images = [];
        const seen = new Set();
        for (const frame of page.frames()) {
            assertNotStopped(requestOptions.shouldStop);
            const locator = frame.locator("img");
            const count = Math.min(await locator.count().catch(() => 0), 1000);

            for (let index = 0; index < count; index += 1) {
                assertNotStopped(requestOptions.shouldStop);
                const image = locator.nth(index);
                const meta = await image
                    .evaluate((node) => {
                        const rect = node.getBoundingClientRect();
                        const anchor = node.closest("a[href]");
                        const style = window.getComputedStyle(node);
                        const classes = [];
                        let current = node;
                        let depth = 0;
                        while (current && depth < 5) {
                            const className = String(current.className || "").trim();
                            const id = String(current.id || "").trim();
                            const tag = String(current.tagName || "").toLowerCase();
                            classes.push([tag, id, className].filter(Boolean).join("#"));
                            current = current.parentElement;
                            depth += 1;
                        }
                        const ancestryText = classes.join(" ");
                        const galleryContainer = node.closest('[class*="gallery"], [class*="album"], [class*="photo"], [id*="gallery"], [id*="album"], [id*="photo"], a[href*=".jpg"], a[href*=".jpeg"], a[href*=".png"], a[href*=".gif"], a[href*=".webp"]');
                        const contentContainer = node.closest('main, article, [role="main"], #content, .content, .detail, .article, .post, .news-detail, .page-content, .entry-content');
                        return {
                            currentSrc: node.currentSrc || node.src || "",
                            src: node.getAttribute("src") || "",
                            lazySrc:
                                node.getAttribute("data-src") ||
                                node.getAttribute("data-original") ||
                                node.getAttribute("data-lazy-src") ||
                                "",
                            linkedOriginalUrl: anchor ? anchor.href : "",
                            alt: node.getAttribute("alt") || "",
                            className: String(node.className || ""),
                            ancestryText,
                            inGalleryContainer: Boolean(galleryContainer),
                            inContentContainer: Boolean(contentContainer),
                            width: node.naturalWidth || Math.round(rect.width) || 0,
                            height: node.naturalHeight || Math.round(rect.height) || 0,
                            visible:
                                rect.width > 0 &&
                                rect.height > 0 &&
                                style.display !== "none" &&
                                style.visibility !== "hidden" &&
                                Number(style.opacity || 1) > 0,
                        };
                    })
                    .catch(() => null);

                if (!meta || !meta.visible) continue;
                if (meta.width < minWidth || meta.height < minHeight) continue;

                const sourceUrl = [meta.currentSrc, meta.src, meta.lazySrc]
                    .map((value) => {
                        try {
                            return value ? new URL(value, frame.url() || page.url()).toString() : "";
                        } catch {
                            return "";
                        }
                    })
                    .find(Boolean);
                let linkedOriginalUrl = "";
                try {
                    linkedOriginalUrl = meta.linkedOriginalUrl
                        ? new URL(meta.linkedOriginalUrl, frame.url() || page.url()).toString()
                        : "";
                } catch {
                    linkedOriginalUrl = "";
                }

                const noiseText = `${sourceUrl} ${linkedOriginalUrl} ${meta.alt} ${meta.className} ${meta.ancestryText || ""}`;
                if (
                    (sourceUrl && isExcludedActivityUiImage(sourceUrl)) ||
                    (linkedOriginalUrl && isExcludedActivityUiImage(linkedOriginalUrl))
                ) {
                    continue;
                }
                const directPhotoLike = /(?:^|[\/])(?:[ab]_[0-9]{4,8}_[0-9]{4,8}|dsc[0-9_ -]{3,}|img[0-9_ -]{3,}|image[0-9_ -]{3,}|photo[0-9_ -]{3,}|picture[0-9_ -]{3,})(?:\.(?:jpe?g|png|gif|webp|bmp))?(?:$|[?#])/i.test(noiseText);
                const strongGallerySignal =
                    /\/(?:gallery|galleries|album|albums|photo|photos|activity|activities|tmp|uploads?|media)\//i.test(
                        noiseText,
                    ) ||
                    /(?:gallery|album|photo|lightbox|fancybox|glightbox)/i.test(noiseText) ||
                    meta.inGalleryContainer ||
                    directPhotoLike ||
                    (linkedOriginalUrl && /\.(?:jpe?g|png|gif|webp|bmp)(?:[?#]|$)/i.test(linkedOriginalUrl));
                const aspectRatio = meta.height > 0 ? meta.width / meta.height : 0;
                const veryWideLayoutAsset = aspectRatio > 2.8 || aspectRatio < 0.28;
                if (renderedImageNoise(noiseText) && !strongGallerySignal) continue;
                if (veryWideLayoutAsset && !strongGallerySignal) continue;
                if (!strongGallerySignal && !meta.inContentContainer) continue;
                if (!strongGallerySignal && meta.width * meta.height < 50000) continue;

                const key = comparableUrl(sourceUrl || linkedOriginalUrl || `${frame.url()}#img-${index}`);
                if (seen.has(key)) continue;
                seen.add(key);

                let result = sourceUrl ? findCachedAsset(cache, sourceUrl) : null;
                if (!result && linkedOriginalUrl) result = findCachedAsset(cache, linkedOriginalUrl);

                if (!result && screenshotFallbackEnabled()) {
                    const screenshot = await image
                        .screenshot({
                            type: "png",
                            animations: "disabled",
                            caret: "hide",
                            timeout: Math.min(timeout, 30000),
                        })
                        .catch(() => null);
                    if (!screenshot || screenshot.length < minBytes) continue;
                    result = {
                        buffer: screenshot,
                        headers: {
                            "content-type": "image/png",
                            "x-scraper-source": "rendered-element-screenshot",
                        },
                        statusCode: 200,
                        finalUrl: sourceUrl || linkedOriginalUrl || page.url(),
                    };
                }

                images.push({
                    url: sourceUrl || linkedOriginalUrl || page.url(),
                    linkedOriginalUrl,
                    alt: meta.alt,
                    width: meta.width,
                    height: meta.height,
                    result,
                });
            }
        }

        if (logger) {
            logger(
                `จับรูปที่ Chrome แสดงจริงได้ ${images.length} รูปจาก ${page.url()} ` +
                    `(network/screenshot fallback)`,
            );
        }
        return { finalUrl: page.url(), images };
    } finally {
        page.off("response", onResponse);
        await closeWorkerPage(page, logger);
    }
}


async function downloadWithBrowser(url, logger, requestOptions = {}) {
    assertNotStopped(requestOptions.shouldStop);

    const originalUrl = url;
    if (requestOptions.referer) {
        const alignedUrl = alignUrlOriginToReferer(url, requestOptions.referer);
        if (isDifferentOrigin(url, alignedUrl)) {
            url = alignedUrl;
            if (logger) {
                logger(`ปรับ Origin ไฟล์ให้ตรงกับหน้าที่เปิดจริง: ${originalUrl} -> ${url}`);
            }
        }
    }

    const { context } = await getBrowserState(logger);
    const isHtml = requestOptions.expectFile
        ? false
        : !/\.(?:pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|jpe?g|png|gif|webp|mp4|m4v|webm|mov|avi|wmv|mpeg|mpg|ogv|mkv|3gp|m3u8|mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#]|$)/i.test(
              new URL(url).pathname,
          );

    // เส้นทางเร็วสำหรับไฟล์: ขอผ่าน context.request ที่แชร์ Cookie กับ Chrome
    // ไม่ถูกแทนด้วยหน้า PDF Viewer และไม่ต้องเปิดแท็บเลยเมื่อสำเร็จ
    // (เดิมเปิด/ปิดแท็บทุกไฟล์ แม้เส้นทางนี้จะไม่ได้ใช้แท็บ)
    if (!isHtml) {
        const fastRaw = await browserContextRawRequest(context, url, logger, requestOptions);
        if (fastRaw) return fastRaw;
    }

    // หน้า HTML ใช้แท็บซ้ำจากสระ ลดการเปิดแท็บใหม่ที่ทำให้ Chrome แย่งโฟกัส
    const page = isHtml
        ? await acquireHtmlPage(context, logger)
        : await createWorkerPage(context, logger);
    if (requestOptions.referer) {
        await page.setExtraHTTPHeaders({ Referer: requestOptions.referer });
    }

    try {
        if (isHtml) {
            const response = await navigateWithRetry(page, url, logger, {
                isHtml: true,
                referer: requestOptions.referer,
                shouldStop: requestOptions.shouldStop,
            });
            const status = response ? response.status() : 0;
            if (status < 200 || status >= 300) {
                throw createHttpError(status, url);
            }
            await waitWithStop(page, 250, requestOptions.shouldStop);
            const html = await page.content();
            return {
                buffer: Buffer.from(html, "utf8"),
                headers: {
                    ...headersToObject(await response.allHeaders()),
                    "content-type": "text/html; charset=utf-8",
                },
                statusCode: status,
                finalUrl: response.url(),
            };
        }

        // เว็บไซต์บางแห่งป้องกัน hotlink: URL รูปตอบ 403 เมื่อเปิดตรง ๆ
        // แต่โหลดได้เมื่อ Request เกิดจากหน้ากิจกรรมจริง จึงอุ่น Session ด้วยหน้า Referer ก่อน
        if (requestOptions.referer) {
            try {
                const refererRaw = await fetchAssetFromRefererPage(
                    context,
                    url,
                    requestOptions.referer,
                    logger,
                    requestOptions,
                );
                if (refererRaw) return refererRaw;

                if (
                    requestOptions.listingReferer &&
                    !sameAssetTarget(requestOptions.listingReferer, requestOptions.referer)
                ) {
                    const listingRaw = await fetchAssetFromRefererPage(
                        context,
                        url,
                        requestOptions.listingReferer,
                        logger,
                        requestOptions,
                    );
                    if (listingRaw) return listingRaw;
                }
            } catch (error) {
                if (String(error && error.message) === STOP_ERROR) throw error;
                if (logger) {
                    logger(
                        `ลองดึงไฟล์ผ่านหน้าอ้างอิงไม่สำเร็จ จะลองเปิด URL ไฟล์โดยตรงต่อ: ${url}`,
                    );
                }
            }
        }

        assertNotStopped(requestOptions.shouldStop);
        const timeout = Number(process.env.BROWSER_TIMEOUT_MS || 90000);
        const capturedResponses = [];
        const onResponse = (response) => {
            if (sameAssetTarget(response.url(), url)) capturedResponses.push(response);
        };
        page.on("response", onResponse);

        const downloadPromise = page.waitForEvent("download", { timeout }).catch(() => null);
        let response = null;
        let navigationError = null;

        try {
            response = await page.goto(url, {
                waitUntil: "commit",
                timeout,
                referer: requestOptions.referer || undefined,
            });
        } catch (error) {
            navigationError = error;
        }

        let download = null;
        if (navigationError && /download/i.test(String(navigationError.message || navigationError))) {
            download = await downloadPromise;
        } else {
            download = await Promise.race([
                downloadPromise,
                waitWithStop(page, 1200, requestOptions.shouldStop).then(() => null),
            ]);
        }

        if (download) {
            const stream = await download.createReadStream();
            if (!stream) throw new Error(`Browser ดาวน์โหลดไฟล์ไม่สำเร็จ: ${url}`);
            const chunks = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            return {
                buffer: Buffer.concat(chunks),
                headers: {
                    "content-disposition": `attachment; filename="${download.suggestedFilename()}"`,
                },
                statusCode: 200,
                finalUrl: url,
            };
        }

        // สำคัญสำหรับ PDF แบบ inline: page.goto อาจเปลี่ยนเป็น Chrome PDF Viewer
        // จึงต้องอ่าน response ของ URL PDF ที่จับไว้จาก network แทน page.content()
        const capturedRaw = await capturedResponseResult(capturedResponses, url, requestOptions);
        if (capturedRaw) return capturedRaw;

        // หลังเปิดหน้าแล้ว Cookie/Challenge อาจพร้อมมากขึ้น ลอง raw request อีกครั้ง
        const rawAfterNavigation = await browserContextRawRequest(
            context,
            url,
            logger,
            requestOptions,
        );
        if (rawAfterNavigation) return rawAfterNavigation;

        assertNotStopped(requestOptions.shouldStop);
        if (navigationError) throw navigationError;
        const status = response ? response.status() : 0;
        if (status < 200 || status >= 300) {
            throw createHttpError(status, url);
        }

        return {
            buffer: await response.body(),
            headers: headersToObject(await response.allHeaders()),
            statusCode: status,
            finalUrl: response.url(),
        };
    } finally {
        if (isHtml) await releaseHtmlPage(context, page, logger);
        else await closeWorkerPage(page, logger);
    }
}


/**
 * เปิดหน้าสาธารณะด้วย Chrome session ที่ผู้ใช้มองเห็นและคืน DOM หลัง JavaScript ทำงาน
 * ฟังก์ชันนี้ไม่แก้ CAPTCHA/Challenge อัตโนมัติ หาก Cloudflare แสดงหน้าตรวจสอบ
 * ผู้ใช้ต้องดำเนินการใน Chrome เอง แล้วระบบจะ reload ตาม navigateWithRetry()
 */
async function captureRenderedPageSnapshot(url, logger, requestOptions = {}) {
    assertNotStopped(requestOptions.shouldStop);
    const { context } = await getBrowserState(logger);
    const page = await createWorkerPage(context, logger);
    const loadedResources = new Map();
    const failedResources = [];
    const maxResources = Math.max(500, Number(requestOptions.maxResources || 20000));

    const onResponse = (response) => {
        if (loadedResources.size >= maxResources) return;
        const responseUrl = response.url();
        if (!/^https?:/i.test(responseUrl)) return;
        const status = response.status();
        let responseHeaders = {};
        try { responseHeaders = response.headers(); } catch { responseHeaders = {}; }
        loadedResources.set(responseUrl, {
            url: responseUrl,
            statusCode: status,
            resourceType: response.request().resourceType(),
            contentType: responseHeaders["content-type"] || responseHeaders["Content-Type"] || "",
        });
        if (status >= 400 && failedResources.length < 2000) {
            failedResources.push({
                url: responseUrl,
                statusCode: status,
                resourceType: response.request().resourceType(),
            });
        }
    };
    page.on("response", onResponse);

    try {
        const response = await navigateWithRetry(page, url, logger, {
            isHtml: true,
            referer: requestOptions.referer,
            shouldStop: requestOptions.shouldStop,
        });
        const statusCode = response ? response.status() : 0;
        if (statusCode < 200 || statusCode >= 400) throw createHttpError(statusCode, url);

        await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
        await scrollRefererPage(page, requestOptions.shouldStop).catch(() => {});
        await waitWithStop(page, 500, requestOptions.shouldStop, 250);

        const dom = await page.evaluate(() => {
            const absolute = (value) => {
                try {
                    return value ? new URL(value, document.baseURI).toString() : "";
                } catch {
                    return "";
                }
            };
            const unique = (values) => [...new Set(values.filter(Boolean))];
            const links = [];
            for (const node of document.querySelectorAll(
                "a[href],area[href],[data-href],[data-url],[data-link],[onclick]",
            )) {
                const values = [
                    node.getAttribute("href"),
                    node.getAttribute("data-href"),
                    node.getAttribute("data-url"),
                    node.getAttribute("data-link"),
                ];
                const onclick = node.getAttribute("onclick") || "";
                for (const match of onclick.matchAll(/(?:location(?:\.href)?\s*=|window\.open\s*\()\s*["']([^"']+)/gi)) {
                    values.push(match[1]);
                }
                for (const value of values) {
                    const resolved = absolute(value);
                    if (resolved) links.push(resolved);
                }
            }

            const resources = [];
            const push = (value, via) => {
                const resolved = absolute(value);
                if (resolved) resources.push({ url: resolved, via });
            };
            for (const image of document.querySelectorAll("img")) {
                push(image.currentSrc, "img-currentSrc");
                push(image.src, "img-src");
                for (const name of ["data-src", "data-original", "data-lazy-src", "data-url"]) {
                    push(image.getAttribute(name), `img-${name}`);
                }
                const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
                for (const item of srcset.split(",")) push(item.trim().split(/\s+/)[0], "img-srcset");
            }
            for (const node of document.querySelectorAll(
                "source,video,audio,script,link[href],iframe,embed,object",
            )) {
                push(node.src, `${node.tagName.toLowerCase()}-src`);
                push(node.href, `${node.tagName.toLowerCase()}-href`);
                push(node.data, `${node.tagName.toLowerCase()}-data`);
                push(node.poster, `${node.tagName.toLowerCase()}-poster`);
                for (const name of ["data-src", "data-url", "data-file", "data-video"]) {
                    push(node.getAttribute && node.getAttribute(name), `${node.tagName.toLowerCase()}-${name}`);
                }
                const srcset = node.getAttribute && (node.getAttribute("srcset") || node.getAttribute("data-srcset"));
                if (srcset) for (const item of srcset.split(",")) push(item.trim().split(/\s+/)[0], `${node.tagName.toLowerCase()}-srcset`);
            }
            for (const node of document.querySelectorAll("[style*='background'],[data-background],[data-bg]")) {
                push(node.getAttribute("data-background"), "data-background");
                push(node.getAttribute("data-bg"), "data-bg");
                const style = getComputedStyle(node).backgroundImage || "";
                for (const match of style.matchAll(/url\\([\"']?([^\"')]+)[\"']?\\)/gi)) push(match[1], "background-image");
            }
            for (const entry of performance.getEntriesByType("resource")) {
                push(entry.name, `performance-${entry.initiatorType || "resource"}`);
            }

            const clone = document.body ? document.body.cloneNode(true) : null;
            if (clone) {
                for (const selector of [
                    "script", "style", "noscript", "nav", "header", "footer", "aside",
                    ".menu", ".navbar", ".breadcrumb", ".sidebar", ".cookie", ".popup",
                    "[role='navigation']", "[aria-hidden='true']",
                ]) {
                    for (const node of clone.querySelectorAll(selector)) node.remove();
                }
            }
            const detailText = (clone ? clone.innerText : document.body?.innerText || "")
                .replace(/\u00a0/g, " ")
                .replace(/[ \\t]+/g, " ")
                .replace(/\n{3,}/g, "\\n\\n")
                .trim();

            return {
                title: document.title || "",
                lang: document.documentElement.lang || "",
                links: unique(links),
                resources,
                detailText,
            };
        });

        const html = await page.content();
        return {
            requestedUrl: url,
            finalUrl: page.url() || (response && response.url()) || url,
            statusCode,
            headers: response ? headersToObject(await response.allHeaders()) : {},
            html,
            title: dom.title || "",
            lang: dom.lang || "",
            detailText: dom.detailText || "",
            links: dom.links || [],
            resources: dom.resources || [],
            loadedResources: [...loadedResources.values()],
            failedResources,
        };
    } finally {
        page.off("response", onResponse);
        await closeWorkerPage(page, logger);
    }
}

module.exports = {
    captureRenderedImagesFromPage,
    captureRenderedPageSnapshot,
    downloadWithBrowser,
};
