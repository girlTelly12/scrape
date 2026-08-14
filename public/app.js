(function initApp() {
    const form = document.getElementById("start-form");
    const startButton = document.getElementById("start-btn");
    const stopButton = document.getElementById("stop-btn");
    const logOutput = document.getElementById("log-output");
    const otherTopicsList = document.getElementById("other-topics-list");
    const addOtherTopicButton = document.getElementById("add-other-topic-btn");
    const detectVendorButton = document.getElementById("detect-vendor-btn");
    const vendorResult = document.getElementById("vendor-result");
    const vendorMode = document.getElementById("vendorMode");
    const vendorSelect = document.getElementById("vendorId");
    const siteUrlElement = document.getElementById("siteUrl");
    const auditStatusFilter = document.getElementById("audit-status-filter");
    const auditSearch = document.getElementById("audit-search");
    const auditRefreshButton = document.getElementById("audit-refresh-btn");
    const auditTableBody = document.getElementById("audit-table-body");
    const auditResultNote = document.getElementById("audit-result-note");
    const auditSummaryElements = {
        total: document.getElementById("audit-total"),
        downloadable: document.getElementById("audit-downloadable"),
        notFound: document.getElementById("audit-404"),
        forbidden: document.getElementById("audit-403"),
        failed: document.getElementById("audit-failed"),
        skipped: document.getElementById("audit-skipped"),
        duplicate: document.getElementById("audit-duplicate"),
    };
    let nextLogIndex = 0;
    let nextOtherTopicId = 1;
    let lastSiteHostname = "";
    let statusRefreshInFlight = false;
    let logsRefreshInFlight = false;
    let auditRefreshInFlight = false;

    // ---- องค์ประกอบใหม่: health check, แจ้งเตือน, แถบเครื่องมือ log ----
    const notifyToggle = document.getElementById("notify-toggle");
    const logPauseBtn = document.getElementById("log-pause-btn");
    const logFilter = document.getElementById("log-filter");
    const logCopyBtn = document.getElementById("log-copy-btn");
    const healthSection = document.getElementById("health-section");
    const healthGrid = document.getElementById("health-grid");
    const healthRefreshBtn = document.getElementById("health-refresh-btn");

    let healthRefreshInFlight = false;
    let lastRunningState = null;
    let notifyEnabled = true;
    try {
        notifyEnabled = localStorage.getItem("scraper-notify") !== "off";
    } catch {
        notifyEnabled = true;
    }
    let logPaused = false;
    let logFilterText = "";
    const logEntries = [];
    const MAX_LOG_LINES = 1500;

    async function fetchJson(url, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });
            const text = await response.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                throw new Error(`Server ตอบกลับไม่ใช่ JSON (${response.status})`);
            }
            if (!response.ok) throw new Error(data.message || "request failed");
            return data;
        } catch (error) {
            if (error && error.name === "AbortError") {
                throw new Error(`คำขอใช้เวลานานเกิน ${Math.round(timeoutMs / 1000)} วินาที`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * ตารางที่ชื่อถูกย่อ — ซ่อนไว้เมื่อไม่มีรายการ
     * อ่านจาก status ระดับบน ไม่ใช่ lastResult จึงเห็นได้ตั้งแต่ระหว่างรันและตอนงานล้ม
     */
    function renderTruncatedTopics(topics) {
        const section = document.getElementById("truncated-section");
        const body = document.getElementById("truncated-table-body");
        if (!section || !body) return;

        if (!topics.length) {
            section.hidden = true;
            body.textContent = "";
            return;
        }

        body.textContent = "";
        for (const topic of topics) {
            const row = document.createElement("tr");

            const nameCell = document.createElement("td");
            const code = document.createElement("code");
            code.textContent = topic.tableName;
            nameCell.appendChild(code);

            const fullCell = document.createElement("td");
            fullCell.textContent = topic.fullTitle || "-";

            const copyCell = document.createElement("td");
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "คัดลอก";
            button.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(topic.tableName);
                    button.textContent = "คัดลอกแล้ว";
                } catch {
                    button.textContent = "คัดลอกไม่ได้";
                }
                setTimeout(() => {
                    button.textContent = "คัดลอก";
                }, 1500);
            });
            copyCell.appendChild(button);

            row.append(nameCell, fullCell, copyCell);
            body.appendChild(row);
        }
        section.hidden = false;
    }

    /** อัปเดตคิวส่วนงานและปุ่มเริ่ม/หยุด — ข้อมูลสถานะหลักเหลือที่คิวส่วนงาน + log */
    function renderStatus(status) {
        const queue = Array.isArray(status.sectionQueue) ? status.sectionQueue : [];
        renderTruncatedTopics(status.truncatedTopics || []);
        renderSectionQueue(queue);
        if (startButton) startButton.disabled = Boolean(status.running);
        if (stopButton) stopButton.disabled = !status.running || status.stopRequested;
    }

    const SECTION_STATE_LABELS = {
        pending: "รอ",
        running: "กำลังทำ",
        done: "เสร็จแล้ว",
        failed: "ล้มเหลว",
        stopped: "หยุด",
    };

    function renderSectionQueue(queue) {
        const container = document.getElementById("section-queue");
        const list = document.getElementById("section-queue-list");
        const summary = document.getElementById("section-queue-summary");
        if (!container || !list) return;
        if (!Array.isArray(queue) || !queue.length) {
            container.hidden = true;
            return;
        }
        container.hidden = false;

        const doneCount = queue.filter((item) => item.state === "done").length;
        const runningItem = queue.find((item) => item.state === "running");
        if (summary) {
            summary.textContent =
                `— เสร็จแล้ว ${doneCount}/${queue.length}` +
                (runningItem ? ` | กำลังทำ: ${runningItem.label}` : "");
        }

        list.textContent = "";
        for (const item of queue) {
            const li = document.createElement("li");
            li.className = `section-queue-item ${item.state || "pending"}`;

            const dot = document.createElement("span");
            dot.className = "state-dot";

            const label = document.createElement("span");
            const stateText = SECTION_STATE_LABELS[item.state] || "";
            label.textContent = stateText ? `${item.label} (${stateText})` : item.label;

            li.appendChild(dot);
            li.appendChild(label);
            list.appendChild(li);
        }
    }

    /** แยกระดับ log จากข้อความ เพื่อระบายสี: error / warn / info */
    function classifyLogLevel(message) {
        const text = String(message || "");
        if (
            /(เกิดข้อผิดพลาด|ไม่สำเร็จ|ล้มเหลว|ผิดพลาด|HTTP\s+[45]\d\d|หมดเวลา|timeout|ECONNREFUSED|ENOTFOUND|Cannot|fail|error)/i.test(
                text,
            )
        ) {
            return "error";
        }
        if (/(ข้าม|เตือน|warning|หน่วง|พยายาม|ยังไม่พร้อม|ลอง)/i.test(text)) return "warn";
        return "info";
    }

    function applyLogFilter() {
        if (!logOutput) return;
        const keyword = logFilterText.trim().toLowerCase();
        for (const div of logOutput.children) {
            div.style.display = !keyword || div.textContent.toLowerCase().includes(keyword) ? "" : "none";
        }
    }

    function appendLogs(logs) {
        if (!logOutput || !logs.length) return;
        const fragment = document.createDocumentFragment();
        for (const log of logs) {
            logEntries.push(log);
            const div = document.createElement("div");
            div.className = `log-line ${classifyLogLevel(log.message)}`;
            div.textContent = `[${log.time}] ${log.message}`;
            fragment.appendChild(div);
        }
        logOutput.appendChild(fragment);
        while (logOutput.childElementCount > MAX_LOG_LINES) logOutput.removeChild(logOutput.firstChild);
        applyLogFilter();
        if (!logPaused) logOutput.scrollTop = logOutput.scrollHeight;
    }

    function copyLogs() {
        const text = logEntries.map((log) => `[${log.time}] ${log.message}`).join("\n");
        const showCopied = () => {
            if (logCopyBtn) logCopyBtn.textContent = "📋 คัดลอกแล้ว";
            setTimeout(() => {
                if (logCopyBtn) logCopyBtn.textContent = "📋 คัดลอกทั้งหมด";
            }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(showCopied).catch(() => {
                if (logCopyBtn) logCopyBtn.textContent = "คัดลอกไม่ได้";
            });
        } else {
            if (logCopyBtn) logCopyBtn.textContent = "คัดลอกไม่ได้";
        }
    }

    // ---- แจ้งเตือนเบราว์เซอร์ + เสียงเมื่อสถานะเปลี่ยน (C2) ----

    function playBeep(success = true) {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.value = success ? 880 : 330;
            const duration = success ? 0.6 : 0.9;
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.start();
            osc.stop(ctx.currentTime + duration);
            osc.onended = () => ctx.close().catch(() => {});
        } catch {
            // เบราว์เซอร์ไม่รองรับเสียง — ข้าม
        }
    }

    function ensureNotificationPermission() {
        if (!("Notification" in window)) return false;
        if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
        return Notification.permission === "granted";
    }

    /** ส่ง Notification + เสียงเมื่อสถานะ running เปลี่ยน (เริ่ม / จบ / หยุด / ล้มเหลว) */
    function maybeNotifyStatus(status) {
        if (!notifyEnabled) {
            lastRunningState = Boolean(status.running);
            return;
        }
        const running = Boolean(status.running);
        const previous = lastRunningState;
        lastRunningState = running;
        if (previous === null || previous === running) return;

        const summary = status.fileAuditSummary || {};
        let title;
        let ok = true;
        if (running) {
            title = "เริ่มงานแล้ว";
        } else if (status.currentStep === "stopped") {
            title = "หยุดงานแล้ว";
        } else if (status.currentStep === "failed" || status.lastError) {
            title = "งานล้มเหลว";
            ok = false;
        } else {
            title = "งานเสร็จสมบูรณ์";
        }
        const body =
            `เว็บไซต์: ${status.websiteName || "-"}\n` +
            `ไฟล์ที่ได้: ${summary.downloadable || 0} | ล้มเหลว: ${summary.failed || 0} | ซ้ำ: ${summary.duplicateReferences || 0}` +
            (status.lastError ? `\nข้อผิดพลาด: ${status.lastError}` : "");

        if (ensureNotificationPermission()) {
            try {
                new Notification(title, { body });
            } catch {
                // บางเบราว์เซอร์ require service worker — ข้ามไป
            }
        }
        playBeep(ok);
    }

    // ---- แผงตรวจสุขภาพระบบ (B1) ----

    const HEALTH_LEVEL_LABELS = { ok: "พร้อม", warn: "ควรตรวจ", error: "มีปัญหา" };

    function renderHealth(data) {
        if (!healthGrid || !healthSection) return;
        const items = Array.isArray(data.items) ? data.items : [];
        healthSection.hidden = false;
        healthGrid.textContent = "";
        if (!items.length) {
            const div = document.createElement("div");
            div.className = "muted";
            div.textContent = "ไม่มีข้อมูลการตรวจสอบ";
            healthGrid.appendChild(div);
            return;
        }
        for (const item of items) {
            const card = document.createElement("div");
            card.className = `health-card ${item.level || "ok"}`;

            const title = document.createElement("div");
            title.className = "health-title";
            const dot = document.createElement("span");
            dot.className = "health-dot";
            const name = document.createElement("span");
            name.textContent = `${item.label} — ${HEALTH_LEVEL_LABELS[item.level] || item.level}`;
            title.append(dot, name);
            card.appendChild(title);

            const msg = document.createElement("div");
            msg.className = "health-msg";
            msg.textContent = item.message || "";
            card.appendChild(msg);

            if (item.hint) {
                const hint = document.createElement("div");
                hint.className = "health-hint";
                hint.textContent = `💡 ${item.hint}`;
                card.appendChild(hint);
            }
            healthGrid.appendChild(card);
        }
    }

    async function refreshHealth() {
        if (healthRefreshInFlight) return;
        healthRefreshInFlight = true;
        try {
            const data = await fetchJson("/api/health", {}, 8000);
            renderHealth(data);
        } catch (error) {
            if (healthSection) healthSection.hidden = false;
            if (healthGrid) {
                healthGrid.textContent = "";
                const div = document.createElement("div");
                div.className = "health-card error";
                div.textContent = `ตรวจสุขภาพระบบไม่สำเร็จ: ${error.message}`;
                healthGrid.appendChild(div);
            }
        } finally {
            healthRefreshInFlight = false;
        }
    }

    async function refreshStatus() {
        if (statusRefreshInFlight) return;
        statusRefreshInFlight = true;
        try {
            const status = await fetchJson("/api/status", {}, 6000);
            renderStatus(status);
            maybeNotifyStatus(status);
        } catch (error) {
            appendLogs([
                {
                    time: new Date().toISOString(),
                    message: `โหลดสถานะไม่สำเร็จ: ${error.message}`,
                },
            ]);
        } finally {
            statusRefreshInFlight = false;
        }
    }

    async function refreshLogs() {
        if (!logOutput || logsRefreshInFlight) return;
        logsRefreshInFlight = true;
        try {
            const data = await fetchJson(`/api/logs?since=${nextLogIndex}`, {}, 6000);
            if (data.logs.length) {
                appendLogs(data.logs);
                nextLogIndex = data.logs[data.logs.length - 1].index + 1;
            }
        } catch (error) {
            appendLogs([{ time: new Date().toISOString(), message: `โหลด log ไม่สำเร็จ: ${error.message}` }]);
        } finally {
            logsRefreshInFlight = false;
        }
    }

    const auditStatusLabels = {
        downloaded: "ดาวน์โหลดสำเร็จ",
        already_exists: "มีไฟล์แล้ว",
        not_found: "404 / ไม่พบ",
        forbidden: "403 / ถูกปฏิเสธ",
        unauthorized: "401 / ต้องเข้าสู่ระบบ",
        rate_limited: "429 / ถูกจำกัด",
        server_error: "Server error",
        timeout: "หมดเวลา",
        network_error: "เครือข่ายผิดพลาด",
        invalid_content: "ไม่ใช่ไฟล์",
        empty_file: "ไฟล์ว่าง",
        skipped_external: "ข้ามต่างเว็บไซต์",
        referenced_embed: "เก็บลิงก์วิดีโอ",
        referenced_stream: "เก็บลิงก์สตรีม",
        failed: "ผิดพลาด",
        duplicate: "ลิงก์ซ้ำ",
    };

    function setText(element, value) {
        if (element) element.textContent = String(value ?? 0);
    }

    function renderAuditSummary(summary = {}) {
        setText(auditSummaryElements.total, summary.uniqueFiles || 0);
        setText(auditSummaryElements.downloadable, summary.downloadable || 0);
        setText(auditSummaryElements.notFound, summary.notFound || 0);
        setText(auditSummaryElements.forbidden, summary.forbidden || 0);
        setText(auditSummaryElements.failed, summary.failed || 0);
        setText(auditSummaryElements.skipped, summary.skippedExternal || 0);
        setText(auditSummaryElements.duplicate, summary.duplicateReferences || 0);
    }

    function createCell(text, className = "") {
        const td = document.createElement("td");
        if (className) td.className = className;
        td.textContent = text == null || text === "" ? "-" : String(text);
        return td;
    }

    /** ถอดรหัส URL (%-encoded ไทย) เพื่อให้อ่านง่ายขึ้น แต่ลิงก์ยังเปิดได้จริง */
    function decodeUrlForDisplay(value) {
        if (!value) return value;
        try {
            return decodeURIComponent(String(value));
        } catch {
            return String(value);
        }
    }

    /**
     * ย่อข้อความสาเหตุให้สั้น ไม่ซ้ำ URL เดิมทั้งบรรทัด
     * เช่น "HTTP 400 on https://... (Browser)" → "HTTP 400 (ผ่าน Browser)"
     */
    function shortenReason(message) {
        const text = String(message || "").trim();
        if (!text) return "";

        const httpMatch = /^HTTP\s+(\d{3})/i.exec(text);
        if (httpMatch) {
            const viaBrowser = /\(Browser\)/.test(text) ? " (ผ่าน Browser)" : "";
            return `HTTP ${httpMatch[1]}${viaBrowser}`;
        }
        if (/^ข้าม(?:รูป|ไฟล์)ซ้ำ\s*:/i.test(text)) {
            return "ข้ามไฟล์ซ้ำ (มีไฟล์เดิมอยู่แล้ว)";
        }
        if (/^ข้าม URL โดยไม่เปิดตามนโยบาย/i.test(text)) {
            return "ข้าม URL ตามนโยบาย";
        }
        if (/^ข้ามไฟล์ต่างเว็บไซต์/i.test(text) || /^ข้ามลิงก์ต่างเว็บไซต์/i.test(text)) {
            return "ข้ามไฟล์ต่างเว็บไซต์";
        }
        return text;
    }

    /** สร้าง cell ที่ตัดข้อความเหลือ 1-2 บรรทัด กดคลิกขยายดูเต็ม (เก็บเต็มไว้ใน tooltip) */
    function createTruncCell(text, className = "", clampLines = 1) {
        const td = document.createElement("td");
        const value = text == null || text === "" ? "-" : String(text);
        const span = document.createElement("span");
        span.className = `trunc-cell clamp-${clampLines}`;
        span.textContent = value;
        span.title = value === "-" ? "" : value;
        if (value !== "-" && value.length > (clampLines === 1 ? 32 : 70)) {
            span.classList.add("trunc-toggle");
            span.addEventListener("click", (event) => {
                event.stopPropagation();
                span.classList.toggle("expanded");
            });
        }
        if (className) td.className = className;
        td.appendChild(span);
        return td;
    }

    function renderAuditRows(rows = []) {
        if (!auditTableBody) return;
        auditTableBody.textContent = "";
        if (!rows.length) {
            const tr = document.createElement("tr");
            const td = createCell("ไม่พบข้อมูลตามตัวกรอง");
            td.colSpan = 7;
            tr.appendChild(td);
            auditTableBody.appendChild(tr);
            return;
        }

        rows.forEach((row) => {
            const tr = document.createElement("tr");

            const statusCell = document.createElement("td");
            const badge = document.createElement("span");
            // แถวที่ URL ซ้ำกับแถวก่อนหน้า จะถูกนับเป็น "ลิงก์ซ้ำ" ใน summary
            // แสดงป้ายให้ตรงกัน แทนที่จะเป็นป้ายเขียว "มีไฟล์แล้ว" ที่ดูเหมือนสำเร็จ
            const isDuplicate = Boolean(row.isDuplicateReference);
            badge.className = `status-badge ${isDuplicate ? "status-duplicate" : `status-${row.status || "failed"}`}`;
            badge.textContent = isDuplicate
                ? "ลิงก์ซ้ำ"
                : auditStatusLabels[row.status] || row.status || "-";
            if (isDuplicate && row.duplicateOfUrl) {
                badge.title = `ซ้ำกับ: ${row.duplicateOfUrl}`;
            }
            statusCell.appendChild(badge);
            tr.appendChild(statusCell);

            tr.appendChild(createCell(row.httpStatus));
            tr.appendChild(createCell(row.sectionLabel || row.sectionKey));
            tr.appendChild(createTruncCell(row.fileName || "ไม่ทราบชื่อ"));
            tr.appendChild(createTruncCell(row.title, "audit-title-cell", 2));

            const urlCell = document.createElement("td");
            const link = document.createElement("a");
            link.className = "audit-url trunc-cell clamp-1";
            link.href = row.fileUrl || "#";
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = decodeUrlForDisplay(row.fileUrl) || "-";
            link.title = row.fileUrl || "";
            urlCell.appendChild(link);
            tr.appendChild(urlCell);

            const reason = shortenReason(row.errorMessage);
            tr.appendChild(createTruncCell(reason, "", 1));
            auditTableBody.appendChild(tr);
        });
    }

    async function refreshFileAudit() {
        if (auditRefreshInFlight) return;
        auditRefreshInFlight = true;
        try {
            const params = new URLSearchParams({ limit: "1000" });
            const status = String(auditStatusFilter?.value || "all");
            const search = String(auditSearch?.value || "").trim();
            if (status !== "all") params.set("status", status);
            if (search) params.set("search", search);
            const data = await fetchJson(`/api/file-audit?${params.toString()}`);
            renderAuditSummary(data.summary || {});
            renderAuditRows(data.rows || []);
            if (auditResultNote) {
                const failed = data.summary?.failed || 0;
                const duplicates = data.summary?.duplicateReferences || 0;
                auditResultNote.textContent =
                    `แสดง ${data.rows?.length || 0} จาก ${data.totalMatched || 0} รายการอ้างอิง — ` +
                    `ไฟล์ไม่ซ้ำ ${data.summary?.uniqueFiles || 0} ไฟล์ ` +
                    `(ดาวน์โหลดได้ ${data.summary?.downloadable || 0}, ` +
                    `ล้มเหลว ${failed}, ลิงก์ซ้ำ ${duplicates})`;
            }
        } catch (error) {
            if (auditResultNote) auditResultNote.textContent = `โหลดรายงานไฟล์ไม่สำเร็จ: ${error.message}`;
        } finally {
            auditRefreshInFlight = false;
        }
    }

    function updateOtherTopicRowNumbers() {
        if (!otherTopicsList) return;
        const rows = [...otherTopicsList.querySelectorAll(".other-topic-row")];
        rows.forEach((row, index) => {
            const title = row.querySelector(".other-topic-row-title");
            if (title) title.textContent = `หัวข้อเพิ่มเติม ${index + 1}`;
        });
    }

    function createOtherTopicRow(values = {}) {
        if (!otherTopicsList) return;

        const rowId = nextOtherTopicId++;
        const row = document.createElement("div");
        row.className = "other-topic-row";
        row.dataset.topicId = String(rowId);
        row.innerHTML = `
            <div class="other-topic-row-header">
                <div class="other-topic-row-title">หัวข้อเพิ่มเติม</div>
                <button type="button" class="remove-topic-btn" aria-label="ลบหัวข้อนี้">ลบ</button>
            </div>
            <div class="other-topic-grid">
                <div class="field">
                    <label for="otherTopicTitle-${rowId}">ชื่อหัวข้อ → ชื่อตาราง</label>
                    <input
                        id="otherTopicTitle-${rowId}"
                        class="other-topic-title"
                        type="text"
                        placeholder="เช่น ผลการจัดซื้อ หรือ procurement_results"
                    />
                </div>
                <div class="field">
                    <label for="otherTopicUrl-${rowId}">ลิงก์หมวด</label>
                    <input
                        id="otherTopicUrl-${rowId}"
                        class="other-topic-url"
                        type="url"
                        placeholder="https://..."
                    />
                </div>
            </div>
        `;

        row.querySelector(".other-topic-title").value = String(values.title || "");
        row.querySelector(".other-topic-url").value = String(values.url || "");
        row.querySelector(".remove-topic-btn").addEventListener("click", () => {
            row.remove();
            updateOtherTopicRowNumbers();
        });

        otherTopicsList.appendChild(row);
        updateOtherTopicRowNumbers();
    }

    /** เพิ่มหลายหัวข้อในครั้งเดียว โดยใช้แถวว่างที่มีอยู่ก่อน และไม่ใส่ลิงก์ซ้ำ */
    function appendOtherTopics(items = []) {
        if (!otherTopicsList) return 0;
        const existing = collectOtherTopics();
        const seen = new Set(existing.map((topic) => topic.url).filter(Boolean));

        // ลบแถวที่ยังว่างทั้งคู่ทิ้ง เพื่อไม่ให้เหลือช่องเปล่าคั่นกลาง
        [...otherTopicsList.querySelectorAll(".other-topic-row")].forEach((row) => {
            const title = String(row.querySelector(".other-topic-title")?.value || "").trim();
            const url = String(row.querySelector(".other-topic-url")?.value || "").trim();
            if (!title && !url) row.remove();
        });

        let added = 0;
        items.forEach((item) => {
            const url = String(item.url || "").trim();
            if (!url || seen.has(url)) return;
            seen.add(url);
            createOtherTopicRow({ title: String(item.title || "").trim(), url });
            added += 1;
        });

        if (!otherTopicsList.querySelector(".other-topic-row")) createOtherTopicRow();
        updateOtherTopicRowNumbers();
        return added;
    }

    function collectOtherTopics() {
        if (!otherTopicsList) return [];
        return [...otherTopicsList.querySelectorAll(".other-topic-row")]
            .map((row) => ({
                title: String(row.querySelector(".other-topic-title")?.value || "").trim(),
                url: String(row.querySelector(".other-topic-url")?.value || "").trim(),
            }))
            .filter((topic) => topic.title || topic.url);
    }

    function setOtherTopics(topics = []) {
        if (!otherTopicsList) return;
        otherTopicsList.textContent = "";
        const rows = Array.isArray(topics) && topics.length ? topics : [{}];
        rows.forEach((topic) => createOtherTopicRow(topic));
    }

    function setFieldValue(id, value, overwrite = true) {
        const element = document.getElementById(id);
        if (!element || value == null || value === "") return;
        if (overwrite || !String(element.value || "").trim()) element.value = value;
    }

    function canonicalHostname(raw) {
        try {
            return new URL(String(raw || "").trim()).hostname.toLowerCase().replace(/^www\./i, "").replace(/\.$/, "");
        } catch {
            return "";
        }
    }

    function clearSectionFieldsForNewWebsite() {
        for (const id of ["procurementUrl", "publicRelationsUrl", "activityUrl"]) {
            const element = document.getElementById(id);
            if (element) element.value = "";
        }
        setOtherTopics([{}]);
        if (vendorResult) {
            vendorResult.className = "vendor-result";
            vendorResult.textContent = "เปลี่ยนเว็บไซต์หลักแล้ว ระบบล้างลิงก์หมวดของเว็บไซต์เดิมให้แล้ว";
        }
    }

    function handleSiteUrlChanged() {
        const currentHostname = canonicalHostname(valueOf("siteUrl"));
        const changedWebsite = Boolean(lastSiteHostname && currentHostname && currentHostname !== lastSiteHostname);
        if (changedWebsite) clearSectionFieldsForNewWebsite();
        if (currentHostname) lastSiteHostname = currentHostname;
        deriveNameFromSiteUrl(changedWebsite);
    }

    function deriveNameFromSiteUrl(overwrite = false) {
        const raw = valueOf("siteUrl");
        if (!raw) return;
        try {
            const hostname = new URL(raw).hostname.replace(/^www\./i, "");
            setFieldValue("websiteName", hostname.split(".")[0], overwrite);
        } catch {
            // server validates URL
        }
    }

    function renderVendorDetection(data) {
        if (!vendorResult) return;
        const evidence = (data.evidence || []).slice(0, 8).map((item) => `• ${item.label}${item.value ? `: ${item.value}` : ""}`);
        const probes = (data.probes || []).map((probe) => `• HTTP ${probe.statusCode || "-"} ${probe.finalUrl || probe.requestedUrl}`);
        const ignored = (data.scope?.ignoredUrls || []).map((url) => `• ${url}`);
        vendorResult.className = "vendor-result success";
        vendorResult.textContent = [
            `เว็บไซต์ที่ตรวจ: ${data.scope?.primaryHostname || "-"}`,
            `ตรวจพบ: ${data.vendorName || "ไม่ทราบ"}`,
            `Adapter: ${data.vendorId || "generic"}`,
            `ความมั่นใจ: ${data.confidence ?? 0}% (score ${data.score ?? 0})`,
            evidence.length ? "หลักฐาน:" : "",
            ...evidence,
            ignored.length ? "ข้ามลิงก์เก่าที่เป็นคนละเว็บไซต์:" : "",
            ...ignored,
            probes.length ? "หน้าที่ตรวจ:" : "",
            ...probes.slice(0, 8),
        ].filter(Boolean).join("\n");
    }

    async function loadVendorAdapters() {
        try {
            const data = await fetchJson("/api/vendors");
            if (!vendorSelect) return;
            vendorSelect.textContent = "";
            (data.vendors || []).forEach((vendor) => {
                const option = document.createElement("option");
                option.value = vendor.id;
                option.textContent = `${vendor.name} (${vendor.id})`;
                vendorSelect.appendChild(option);
            });
        } catch (error) {
            if (vendorResult) vendorResult.textContent = `โหลดรายการ Adapter ไม่สำเร็จ: ${error.message}`;
        }
    }

    async function detectVendor() {
        if (!detectVendorButton) return;
        const payload = {
            siteUrl: valueOf("siteUrl"),
            procurementUrl: valueOf("procurementUrl"),
            publicRelationsUrl: valueOf("publicRelationsUrl"),
            activityUrl: valueOf("activityUrl"),
            otherTopics: collectOtherTopics(),
            vendorMode: valueOf("vendorMode") || "auto",
            vendorId: valueOf("vendorId"),
        };
        try {
            detectVendorButton.disabled = true;
            if (vendorResult) {
                vendorResult.className = "vendor-result";
                vendorResult.textContent = "กำลังเปิดหน้าเว็บไซต์และตรวจลายนิ้วมือของผู้พัฒนา...";
            }
            const data = await fetchJson("/api/vendor/detect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            renderVendorDetection(data);
            if (vendorSelect && data.vendorId) vendorSelect.value = data.vendorId;
            // ตรวจเฉพาะบริษัทและเลือก Adapter เท่านั้น
            // URL หมวดทุกช่องเป็นข้อมูลที่ผู้ใช้กรอกเอง จึงห้ามเขียนทับหรือเติมอัตโนมัติ
        } catch (error) {
            if (vendorResult) {
                vendorResult.className = "vendor-result error";
                vendorResult.textContent = `ตรวจบริษัทไม่สำเร็จ: ${error.message}`;
            }
        } finally {
            detectVendorButton.disabled = false;
        }
    }

    function valueOf(id) {
        return String(document.getElementById(id)?.value || "").trim();
    }

    const discoverButton = document.getElementById("discover-topics-btn");
    const discoverPanel = document.getElementById("discover-panel");
    const discoverList = document.getElementById("discover-list");
    const discoverCount = document.getElementById("discover-count");
    const discoverFilter = document.getElementById("discover-filter");
    const bulkButton = document.getElementById("bulk-topics-btn");
    const bulkPanel = document.getElementById("bulk-panel");
    const bulkInput = document.getElementById("bulk-input");
    let discoveredTopics = [];

    function renderDiscovered() {
        if (!discoverList) return;
        const keyword = String(discoverFilter?.value || "").trim().toLowerCase();
        discoverList.textContent = "";
        let shown = 0;

        discoveredTopics.forEach((topic, index) => {
            const haystack = `${topic.title} ${topic.url}`.toLowerCase();
            if (keyword && !haystack.includes(keyword)) return;
            shown += 1;

            const row = document.createElement("label");
            row.className = "discover-item";

            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = topic.checked !== false;
            box.addEventListener("change", () => {
                discoveredTopics[index].checked = box.checked;
            });

            const text = document.createElement("span");
            const name = document.createElement("strong");
            name.textContent = topic.title || "(ไม่มีชื่อ — ระบบจะตั้งชื่อตารางให้อัตโนมัติ)";
            const url = document.createElement("span");
            url.className = "discover-url";
            url.textContent = topic.url;
            text.appendChild(name);
            text.appendChild(url);

            row.appendChild(box);
            row.appendChild(text);
            discoverList.appendChild(row);
        });

        if (discoverCount) {
            const picked = discoveredTopics.filter((topic) => topic.checked !== false).length;
            discoverCount.textContent =
                `พบ ${discoveredTopics.length} หมวด | เลือกไว้ ${picked}` +
                (keyword ? ` | แสดง ${shown}` : "");
        }
    }

    async function discoverTopics() {
        if (!discoverButton) return;
        const pageUrl = valueOf("siteUrl") || valueOf("procurementUrl") || valueOf("publicRelationsUrl");
        if (!pageUrl) {
            alert("กรุณากรอกช่อง “เว็บไซต์หลัก” ก่อน แล้วกดค้นหาหมวดอีกครั้ง");
            return;
        }

        const originalText = discoverButton.textContent;
        try {
            discoverButton.disabled = true;
            discoverButton.textContent = "กำลังค้นหา...";
            const data = await fetchJson(
                "/api/topics/discover",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ pageUrl }),
                },
                120000,
            );
            discoveredTopics = (data.topics || []).map((topic) => ({ ...topic, checked: true }));
            if (!discoveredTopics.length) {
                alert("ไม่พบหมวดข่าวจากเมนูของเว็บไซต์นี้ ลองใช้ปุ่ม “วางหลายบรรทัด” แทน");
                return;
            }
            if (discoverPanel) discoverPanel.hidden = false;
            if (bulkPanel) bulkPanel.hidden = true;
            if (discoverFilter) discoverFilter.value = "";
            renderDiscovered();
        } catch (error) {
            alert(`ค้นหาหมวดไม่สำเร็จ: ${error.message}`);
        } finally {
            discoverButton.disabled = false;
            discoverButton.textContent = originalText;
        }
    }

    function parseBulkInput(text) {
        return String(text || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const match = /^(.*?)[,|\t]\s*(https?:\/\/\S+)$/i.exec(line);
                if (match) return { title: match[1].trim(), url: match[2].trim() };
                if (/^https?:\/\/\S+$/i.test(line)) return { title: "", url: line };
                return null;
            })
            .filter(Boolean);
    }

    if (discoverButton) discoverButton.addEventListener("click", discoverTopics);
    if (discoverFilter) discoverFilter.addEventListener("input", renderDiscovered);
    document.getElementById("discover-all")?.addEventListener("click", () => {
        discoveredTopics.forEach((topic) => (topic.checked = true));
        renderDiscovered();
    });
    document.getElementById("discover-none")?.addEventListener("click", () => {
        discoveredTopics.forEach((topic) => (topic.checked = false));
        renderDiscovered();
    });
    document.getElementById("discover-close")?.addEventListener("click", () => {
        if (discoverPanel) discoverPanel.hidden = true;
    });
    document.getElementById("discover-apply")?.addEventListener("click", () => {
        const picked = discoveredTopics.filter((topic) => topic.checked !== false);
        const added = appendOtherTopics(picked);
        if (discoverPanel) discoverPanel.hidden = true;
        alert(`เพิ่มแล้ว ${added} หัวข้อ${picked.length - added > 0 ? ` (ข้าม ${picked.length - added} รายการที่ซ้ำ)` : ""}`);
    });

    if (bulkButton) {
        bulkButton.addEventListener("click", () => {
            if (!bulkPanel) return;
            bulkPanel.hidden = !bulkPanel.hidden;
            if (discoverPanel) discoverPanel.hidden = true;
            if (!bulkPanel.hidden) bulkInput?.focus();
        });
    }
    document.getElementById("bulk-close")?.addEventListener("click", () => {
        if (bulkPanel) bulkPanel.hidden = true;
    });
    document.getElementById("bulk-apply")?.addEventListener("click", () => {
        const items = parseBulkInput(bulkInput?.value);
        if (!items.length) {
            alert("ไม่พบลิงก์ที่ใช้ได้ กรุณาวางทีละบรรทัด และให้ลิงก์ขึ้นต้นด้วย http:// หรือ https://");
            return;
        }
        const added = appendOtherTopics(items);
        if (bulkInput) bulkInput.value = "";
        if (bulkPanel) bulkPanel.hidden = true;
        alert(`เพิ่มแล้ว ${added} หัวข้อ${items.length - added > 0 ? ` (ข้าม ${items.length - added} รายการที่ซ้ำ)` : ""}`);
    });

    if (addOtherTopicButton) {
        addOtherTopicButton.addEventListener("click", () => {
            createOtherTopicRow();
            const newestInput = otherTopicsList?.lastElementChild?.querySelector(".other-topic-title");
            newestInput?.focus();
        });
    }

    if (auditRefreshButton) auditRefreshButton.addEventListener("click", refreshFileAudit);
    if (auditStatusFilter) auditStatusFilter.addEventListener("change", refreshFileAudit);
    if (auditSearch) {
        let searchTimer = null;
        auditSearch.addEventListener("input", () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(refreshFileAudit, 350);
        });
    }

    if (vendorMode) {
        vendorMode.addEventListener("change", () => {
            if (vendorSelect) vendorSelect.disabled = vendorMode.value !== "manual";
        });
    }
    if (detectVendorButton) detectVendorButton.addEventListener("click", detectVendor);
    if (siteUrlElement) {
        lastSiteHostname = canonicalHostname(siteUrlElement.value);
        siteUrlElement.addEventListener("change", handleSiteUrlChanged);
        siteUrlElement.addEventListener("blur", handleSiteUrlChanged);
    }

    // แสดงช่องแรกให้พร้อมกรอก โดยผู้ใช้สามารถลบหรือเพิ่มได้ตามต้องการ
    createOtherTopicRow();

    if (form) {
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const payload = {
                websiteName: valueOf("websiteName"),
                siteUrl: valueOf("siteUrl"),
                vendorMode: valueOf("vendorMode") || "auto",
                vendorId: valueOf("vendorId"),
                autoFillSections: false,
                fullSiteMigration: Boolean(document.getElementById("fullSiteMigration")?.checked),
                migrationMaxPages: Number(valueOf("migrationMaxPages") || 1000),
                migrationMaxAssets: Number(valueOf("migrationMaxAssets") || 10000),
                migrationMaxDepth: Number(valueOf("migrationMaxDepth") || 12),
                migrationMaxFileMb: Number(valueOf("migrationMaxFileMb") || 500),
                migrationDelayMs: Number(valueOf("migrationDelayMs") || 700),
                includeExternalAssets: Boolean(document.getElementById("includeExternalAssets")?.checked),
                resumeMigration: Boolean(document.getElementById("resumeMigration")?.checked),
                procurementUrl: valueOf("procurementUrl"),
                publicRelationsUrl: valueOf("publicRelationsUrl"),
                activityUrl: valueOf("activityUrl"),
                otherTopics: collectOtherTopics(),
                lineNotifyToken: valueOf("lineNotifyToken"),
                lineMessage: valueOf("lineMessage"),
            };

            const originalButtonText = startButton.textContent;
            try {
                startButton.disabled = true;
                startButton.textContent = "กำลังส่งงานให้ Server...";
                if (logOutput) {
                    logOutput.textContent = "";
                    logEntries.length = 0;
                    nextLogIndex = 0;
                }
                await fetchJson(
                    "/api/start",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    },
                    12000,
                );
                appendLogs([
                    {
                        time: new Date().toISOString(),
                        message: "Server รับงานแล้ว งานจะทำเบื้องหลังและหน้าเว็บจะติดตามสถานะต่อ",
                    },
                ]);
            } catch (error) {
                // บางครั้ง response เริ่มงานถูก Browser ตัด แต่ Server รับงานไปแล้ว
                // ตรวจสถานะก่อนแจ้งว่าล้มเหลว เพื่อไม่ให้ผู้ใช้ต้องปิดแท็บเอง
                let running = false;
                try {
                    const status = await fetchJson("/api/status", {}, 5000);
                    running = Boolean(status.running);
                    renderStatus(status);
                } catch {
                    running = false;
                }
                if (running) {
                    appendLogs([
                        {
                            time: new Date().toISOString(),
                            message: "การตอบกลับเริ่มงานช้า แต่ Server เริ่มงานแล้ว ระบบติดตามต่อโดยอัตโนมัติ",
                        },
                    ]);
                } else {
                    alert(`เริ่มงานไม่สำเร็จ: ${error.message}`);
                }
            } finally {
                startButton.textContent = originalButtonText;
                await refreshStatus();
                await refreshLogs();
            }
        });
    }

    if (stopButton) {
        stopButton.addEventListener("click", async () => {
            try {
                stopButton.disabled = true;
                await fetchJson("/api/stop", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                });
            } catch (error) {
                alert(`หยุดงานไม่สำเร็จ: ${error.message}`);
            } finally {
                await refreshStatus();
            }
        });
    }

    // ปุ่ม/ตัวกรองใหม่
    if (healthRefreshBtn) healthRefreshBtn.addEventListener("click", refreshHealth);
    if (notifyToggle) {
        notifyToggle.checked = notifyEnabled;
        notifyToggle.addEventListener("change", () => {
            notifyEnabled = notifyToggle.checked;
            try {
                localStorage.setItem("scraper-notify", notifyEnabled ? "on" : "off");
            } catch {
                // localStorage ใช้ไม่ได้ — ข้าม
            }
        });
    }
    if (logPauseBtn) {
        logPauseBtn.addEventListener("click", () => {
            logPaused = !logPaused;
            logPauseBtn.textContent = logPaused ? "▶ เลื่อนอัตโนมัติ" : "⏸ หยุดเลื่อนอัตโนมัติ";
            if (!logPaused && logOutput) logOutput.scrollTop = logOutput.scrollHeight;
        });
    }
    if (logFilter) {
        logFilter.addEventListener("input", () => {
            logFilterText = logFilter.value;
            applyLogFilter();
        });
    }
    if (logCopyBtn) logCopyBtn.addEventListener("click", copyLogs);

    loadVendorAdapters();
    refreshStatus();
    refreshLogs();
    refreshFileAudit();
    refreshHealth();
    setInterval(refreshStatus, 3000);
    setInterval(refreshLogs, 2000);
    setInterval(refreshFileAudit, 5000);
    setInterval(refreshHealth, 30000);
})();
