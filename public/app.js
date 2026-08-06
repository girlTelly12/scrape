(function initApp() {
    const statusBox = document.getElementById("status-box");
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

    function renderStatus(status) {
        const lines = [
            `website: ${status.websiteName || "-"}`,
            `database: ${status.databaseName || "-"}`,
            `vendor: ${status.vendorName || "-"}`,
            `adapter: ${status.vendorId || "-"}`,
            `vendor confidence: ${status.vendorConfidence == null ? "-" : `${status.vendorConfidence}%`}`,
            `running: ${status.running ? "yes" : "no"}`,
            `step: ${status.currentStep || "-"}`,
            `startedAt: ${status.startedAt || "-"}`,
            `finishedAt: ${status.finishedAt || "-"}`,
            `error: ${status.lastError || "-"}`,
            `files: ${status.fileAuditSummary?.uniqueFiles || 0}`,
            `downloadable: ${status.fileAuditSummary?.downloadable || 0}`,
            `404: ${status.fileAuditSummary?.notFound || 0}`,
            `403: ${status.fileAuditSummary?.forbidden || 0}`,
        ];
        if (status.lastResult) lines.push(`result: ${JSON.stringify(status.lastResult)}`);
        statusBox.textContent = `สถานะ:\n${lines.join("\n")}`;
        if (startButton) startButton.disabled = status.running;
        if (stopButton) stopButton.disabled = !status.running || status.stopRequested;
    }

    function appendLogs(logs) {
        if (!logOutput || !logs.length) return;
        const chunk = logs.map((log) => `[${log.time}] ${log.message}`).join("\n");
        logOutput.textContent += `${chunk}\n`;
        logOutput.scrollTop = logOutput.scrollHeight;
    }

    async function refreshStatus() {
        if (statusRefreshInFlight) return;
        statusRefreshInFlight = true;
        try {
            const status = await fetchJson("/api/status", {}, 6000);
            renderStatus(status);
        } catch (error) {
            statusBox.textContent = `สถานะ: โหลดไม่สำเร็จ - ${error.message}`;
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
            badge.className = `status-badge status-${row.status || "failed"}`;
            badge.textContent = auditStatusLabels[row.status] || row.status || "-";
            statusCell.appendChild(badge);
            tr.appendChild(statusCell);

            tr.appendChild(createCell(row.httpStatus));
            tr.appendChild(createCell(row.sectionLabel || row.sectionKey));
            tr.appendChild(createCell(row.fileName || "ไม่ทราบชื่อ"));
            tr.appendChild(createCell(row.title, "audit-title-cell"));

            const urlCell = document.createElement("td");
            const link = document.createElement("a");
            link.className = "audit-url";
            link.href = row.fileUrl || "#";
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = row.fileUrl || "-";
            urlCell.appendChild(link);
            tr.appendChild(urlCell);

            tr.appendChild(createCell(row.errorMessage || "-"));
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
                auditResultNote.textContent =
                    `แสดง ${data.rows?.length || 0} จาก ${data.totalMatched || 0} รายการอ้างอิง ` +
                    `(ไฟล์ไม่ซ้ำทั้งหมด ${data.summary?.uniqueFiles || 0} ไฟล์)`;
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

    loadVendorAdapters();
    refreshStatus();
    refreshLogs();
    refreshFileAudit();
    setInterval(refreshStatus, 3000);
    setInterval(refreshLogs, 2000);
    setInterval(refreshFileAudit, 5000);
})();
