"use strict";

(() => {
    const byId = (id) => document.getElementById(id);
    const TOKEN_KEY = "ocrs_access_token";
    const STATUS_LABELS = {
        received: "等待识别",
        queued: "等待识别",
        recognizing: "识别中",
        processing: "识别中",
        review_required: "待审核",
        confirmed: "已确认",
        rejected: "已驳回",
        failed: "识别失败",
        active: "有效",
        cancelled: "已撤单",
        canceled: "已撤单",
    };
    const ERROR_MESSAGES = {
        UNAUTHORIZED: "访问令牌无效或已失效，请重新验证。",
        AUTHENTICATION_REQUIRED: "请先验证访问令牌。",
        INVALID_TOKEN: "访问令牌无效或已失效，请重新验证。",
        VERSION_CONFLICT: "记录已被更新。请重新载入并核对最新版本。",
        DUPLICATE_WARNING: "检测到可能重复的订单，请再次核对。",
        VALIDATION_ERROR:
            "字段未通过校验。请检查必填项、数量、金额与时间格式。",
        INVALID_REQUEST: "请求未通过校验，请检查输入内容。",
        TASK_NOT_REVIEWABLE: "当前任务状态不支持审核，请刷新查看。",
        TASK_NOT_RETRYABLE: "当前任务状态不支持重新识别，请刷新查看。",
        TASK_NOT_FOUND: "找不到这条任务，请刷新列表。",
        ORDER_NOT_FOUND: "找不到目标订单，请核对正式订单的内部编号。",
        EXPORT_NOT_READY: "导出文件尚未就绪，请稍后重试。",
        EXPORT_FAILED: "Excel 生成失败。订单记录已保留，可重新生成。",
        IMAGE_TOO_LARGE: "图片超过允许大小，请缩小后重试。",
        INVALID_IMAGE: "图片无法读取，请上传有效的 PNG、JPEG 或 WebP。",
        SOURCE_INVALID: "来源标签或文件名无效，请缩短内容后重试。",
        UPLOAD_COUNT: "每次可导入 1 至 8 张截图。",
        LINE_ID_INVALID: "明细 ID 不属于目标订单或重复，请核对正式订单。",
        EVIDENCE_EXPIRED: "原图已按保留期限清理，无法继续预览。",
        UPLOAD_TOO_LARGE: "上传文件超过允许大小，请缩小图片或减少数量。",
        INVALID_FILE_TYPE: "不支持该文件类型，请使用 PNG、JPEG 或 WebP。",
        IDEMPOTENCY_CONFLICT: "重复请求内容存在差异，请刷新核对任务状态。",
        NETWORK_ERROR: "无法连接本地服务，请检查服务是否仍在运行。",
        REQUEST_TIMEOUT: "请求超时，结果可能已处理。请刷新核对后再试。",
    };
    const state = {
        token: "",
        epoch: 0,
        tasks: [],
        orders: [],
        status: null,
        selectedId: null,
        drafts: new Map(),
        operations: new Set(),
        controllers: new Set(),
        blobs: new Set(),
        imageGeneration: 0,
        refreshPromise: null,
        timer: null,
        view: "review",
        duplicate: null,
        rejectTarget: null,
        lastRenderKey: null,
        lastQueueKey: null,
        lastOrdersKey: null,
    };

    function element(tag, className, content) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (content !== undefined && content !== null)
            node.textContent = String(content);
        return node;
    }

    function readToken() {
        try {
            return sessionStorage.getItem(TOKEN_KEY) || "";
        } catch {
            return "";
        }
    }

    function saveToken(token) {
        try {
            if (token) sessionStorage.setItem(TOKEN_KEY, token);
            else sessionStorage.removeItem(TOKEN_KEY);
        } catch {
            /* Private browser sessions may disable storage; in-memory auth still works. */
        }
    }

    function safeCode(value, fallback = "REQUEST_FAILED") {
        return typeof value === "string" &&
            /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
            ? value
            : fallback;
    }

    function makeError(code, status = 0, details = null) {
        const error = new Error(
            ERROR_MESSAGES[code] || "操作未完成，请核对内容或稍后重试。",
        );
        error.code = code;
        error.status = status;
        error.details = details;
        return error;
    }

    function errorText(error) {
        return `${ERROR_MESSAGES[error.code] || "操作未完成，请核对内容或稍后重试。"}（${safeCode(error.code)}）`;
    }

    async function request(
        path,
        { method = "GET", body, blob = false, token = state.token } = {},
    ) {
        // Never send the local bearer token to a URL supplied by model or screenshot content.
        const url = new URL(path, location.origin);
        if (
            url.origin !== location.origin ||
            !url.pathname.startsWith("/api/") ||
            url.username ||
            url.password
        ) {
            throw makeError("INVALID_REQUEST");
        }
        const epoch = state.epoch;
        const controller = new AbortController();
        state.controllers.add(controller);
        const timeout = setTimeout(() => controller.abort("timeout"), 60000);
        const headers = { Authorization: `Bearer ${token}` };
        let payload = body;
        if (body !== undefined && !(body instanceof FormData)) {
            headers["Content-Type"] = "application/json";
            payload = JSON.stringify(body);
        }
        try {
            const response = await fetch(url, {
                method,
                headers,
                body: payload,
                signal: controller.signal,
                cache: "no-store",
                credentials: "same-origin",
                redirect: "error",
            });
            if (epoch !== state.epoch) throw makeError("SESSION_CHANGED");
            if (!response.ok) {
                let result = {};
                try {
                    result = await response.json();
                } catch {
                    /* Only known error codes are displayed. */
                }
                const code = safeCode(
                    result.error?.code || result.code,
                    response.status === 401 ? "UNAUTHORIZED" : "REQUEST_FAILED",
                );
                if (response.status === 401 && state.token)
                    logout("访问令牌已失效，请重新验证。");
                throw makeError(
                    code,
                    response.status,
                    result.error?.details || result.details,
                );
            }
            if (blob) return await response.blob();
            if (response.status === 204) return null;
            return await response.json();
        } catch (error) {
            if (error.code) throw error;
            if (epoch !== state.epoch) throw makeError("SESSION_CHANGED");
            if (controller.signal.aborted) throw makeError("REQUEST_TIMEOUT");
            throw makeError("NETWORK_ERROR");
        } finally {
            clearTimeout(timeout);
            state.controllers.delete(controller);
        }
    }

    function notice(message, tone = "success") {
        byId("notice-text").textContent = message;
        byId("notice").className = `notice ${tone}`;
        byId("notice").hidden = false;
    }

    function reportError(error, target = null) {
        if (error.code === "SESSION_CHANGED" || (!state.token && !target))
            return;
        if (target) {
            target.textContent = errorText(error);
            target.hidden = false;
        } else notice(errorText(error), "error");
    }

    function revokeImages() {
        state.imageGeneration += 1;
        for (const url of state.blobs) URL.revokeObjectURL(url);
        state.blobs.clear();
    }

    function closeDialog(id) {
        if (byId(id).open) byId(id).close();
    }

    function logout(message = "") {
        state.epoch += 1;
        state.token = "";
        saveToken("");
        for (const controller of state.controllers) controller.abort();
        state.controllers.clear();
        clearTimeout(state.timer);
        revokeImages();
        state.tasks = [];
        state.orders = [];
        state.status = null;
        state.selectedId = null;
        state.drafts.clear();
        state.operations.clear();
        state.duplicate = null;
        state.rejectTarget = null;
        state.refreshPromise = null;
        state.lastRenderKey = null;
        state.lastQueueKey = null;
        state.lastOrdersKey = null;
        state.view = "review";
        for (const id of ["upload-dialog", "duplicate-dialog", "reject-dialog"])
            closeDialog(id);
        for (const id of [
            "task-list",
            "source-list",
            "editor-content",
            "orders-content",
            "selected-files",
        ])
            byId(id).replaceChildren();
        byId("upload-form").reset();
        byId("review-form").reset();
        byId("reject-form").reset();
        byId("workspace").hidden = true;
        byId("login-screen").hidden = false;
        byId("access-token").value = "";
        byId("login-error").textContent = message;
        byId("login-error").hidden = !message;
        byId("notice").hidden = true;
        byId("login-button").disabled = false;
        byId("access-token").focus();
    }

    async function login(token) {
        if (state.operations.has("login")) return;
        state.operations.add("login");
        byId("login-button").disabled = true;
        byId("login-button").textContent = "正在验证…";
        byId("login-error").hidden = true;
        try {
            const status = await request("/api/status", { token });
            state.token = token;
            saveToken(token);
            state.status = status;
            byId("access-token").value = "";
            byId("login-screen").hidden = true;
            byId("workspace").hidden = false;
            switchView("review");
            renderStatus();
            await refresh();
            schedulePoll();
        } catch (error) {
            saveToken("");
            reportError(error, byId("login-error"));
        } finally {
            state.operations.delete("login");
            byId("login-button").disabled = false;
            byId("login-button").textContent = "进入工作台 →";
        }
    }

    function schedulePoll() {
        clearTimeout(state.timer);
        if (!state.token) return;
        state.timer = setTimeout(async () => {
            if (!document.hidden && state.token) await refresh(true);
            schedulePoll();
        }, 4000);
    }

    async function refresh(silent = false) {
        if (!state.token) return;
        if (state.refreshPromise) return state.refreshPromise;
        const epoch = state.epoch;
        const run = async () => {
            try {
                const [status, taskData, orderData] = await Promise.all([
                    request("/api/status"),
                    request("/api/tasks"),
                    request("/api/orders"),
                ]);
                if (epoch !== state.epoch) return;
                state.status = status;
                state.tasks = Array.isArray(taskData.tasks)
                    ? taskData.tasks
                    : [];
                state.orders = Array.isArray(orderData.orders)
                    ? orderData.orders
                    : [];
                byId("connection-status").classList.remove("offline");
                byId("connection-status").title = "本地服务连接正常";
                renderStatus();
                renderQueue();
                renderOrders();
                if (!state.selectedId && state.tasks.length) {
                    selectTask(
                        (
                            state.tasks.find(
                                (task) => task.status === "review_required",
                            ) || state.tasks[0]
                        ).id,
                    );
                } else if (state.selectedId) {
                    const task = selectedTask();
                    if (task) renderSelectedTask(task);
                    else {
                        state.selectedId = null;
                        state.lastRenderKey = null;
                        renderEmpty();
                    }
                } else renderEmpty();
            } catch (error) {
                if (epoch !== state.epoch) return;
                byId("connection-status").classList.add("offline");
                byId("connection-status").title = "连接中断，保留当前编辑";
                if (!silent) reportError(error);
            }
        };
        const promise = run();
        state.refreshPromise = promise;
        try {
            await promise;
        } finally {
            if (state.refreshPromise === promise) state.refreshPromise = null;
        }
    }

    function isProcessing(status) {
        return ["received", "queued", "recognizing", "processing"].includes(
            status,
        );
    }

    function renderStatus() {
        const status = state.status || {};
        const provider =
            typeof status.provider === "string"
                ? status.provider
                : status.provider?.name;
        byId("demo-banner").hidden = provider !== "demo";
        const count = (predicate) => state.tasks.filter(predicate).length;
        const counts = status.counts || {};
        const review =
            counts.review_required ??
            count((task) => task.status === "review_required");
        byId("count-review").textContent = review;
        byId("nav-review-count").textContent = review;
        byId("count-processing").textContent = Object.keys(counts).length
            ? ["received", "queued", "recognizing", "processing"].reduce(
                  (sum, key) => sum + (counts[key] || 0),
                  0,
              )
            : count((task) => isProcessing(task.status));
        byId("count-failed").textContent =
            counts.failed ?? count((task) => task.status === "failed");
        byId("count-confirmed").textContent =
            counts.confirmed ?? count((task) => task.status === "confirmed");
        byId("inbox-note").textContent = status.inbox_enabled
            ? "文件夹导入已启用：仅处理指定文件夹中已保存的截图，不读取微信聊天。"
            : "仅处理手动导入的截图，不读取微信聊天。";
        byId("inbox-banner").hidden = !status.inbox_enabled;
        const inbox = status.inbox;
        byId("inbox-summary").textContent = inbox
            ? `上次扫描：导入 ${inbox.imported || 0} 张，等待 ${inbox.pending || 0} 张，已处理 ${inbox.skipped || 0} 张。${inbox.updated_at ? `更新于 ${localDate(inbox.updated_at)}` : ""}`
            : "等待扫描已保存的截图；不会读取微信聊天。";
        const inboxErrors = Array.isArray(inbox?.errors) ? inbox.errors : [];
        byId("inbox-errors").hidden = !inboxErrors.length;
        byId("inbox-error-list").replaceChildren();
        for (const error of inboxErrors)
            byId("inbox-error-list").append(
                element(
                    "li",
                    "",
                    `${error.filename || "未命名文件"} · ${safeCode(error.code)}`,
                ),
            );
        const exportState = status.export || {};
        const descriptions = {
            none: "尚未生成 Excel，可点击重新生成",
            idle: "暂无待生成的导出",
            pending: "等待生成 Excel",
            writing: "正在生成 Excel…",
            processing: "正在生成 Excel…",
            running: "正在生成 Excel…",
            ready: "Excel 已就绪",
            succeeded: "Excel 已生成",
            success: "Excel 已生成",
            completed: "Excel 已生成",
            failed: "Excel 生成失败，可重新生成",
        };
        byId("export-status").textContent =
            descriptions[exportState.status] || "导出状态待更新";
        if (exportState.error_code)
            byId("export-status").textContent +=
                `（${safeCode(exportState.error_code)}）`;
        byId("export-status").parentElement.classList.toggle(
            "error",
            exportState.status === "failed",
        );
        byId("download-button").disabled =
            state.operations.has("download") ||
            !["ready", "succeeded", "success", "completed"].includes(
                exportState.status,
            );
        byId("export-button").disabled = state.operations.has("export");
    }

    function shortId(id) {
        return String(id || "").slice(0, 10);
    }
    function labelStatus(status) {
        return STATUS_LABELS[status] || "状态待更新";
    }
    function badge(status) {
        return element(
            "span",
            `badge ${Object.hasOwn(STATUS_LABELS, status) ? status : ""}`,
            labelStatus(status),
        );
    }
    function localDate(value) {
        if (!value) return "时间未知";
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? "时间未知"
            : new Intl.DateTimeFormat("zh-CN", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
              }).format(date);
    }
    function selectedTask() {
        return state.tasks.find((task) => task.id === state.selectedId);
    }

    function renderQueue() {
        const list = byId("task-list");
        const filter = byId("queue-filter").value;
        const tasks = state.tasks.filter(
            (task) =>
                filter === "all" ||
                (filter === "processing"
                    ? isProcessing(task.status)
                    : task.status === filter),
        );
        const key = JSON.stringify([
            filter,
            state.selectedId,
            tasks.map((task) => [task.id, task.version, task.status]),
        ]);
        if (key === state.lastQueueKey) return;
        state.lastQueueKey = key;
        list.replaceChildren();
        byId("queue-count").textContent = `${tasks.length} 个任务`;
        if (!tasks.length)
            list.append(
                element(
                    "p",
                    "empty-queue",
                    state.tasks.length
                        ? "这个分类下暂无任务"
                        : "还没有导入截图",
                ),
            );
        for (const task of tasks) {
            const button = element(
                "button",
                `task-card${task.id === state.selectedId ? " active" : ""}`,
            );
            button.type = "button";
            button.setAttribute(
                "aria-pressed",
                String(task.id === state.selectedId),
            );
            const top = element("div", "task-card-top");
            const title =
                task.candidate?.events?.[0]?.customer ||
                task.sources?.[0]?.filename ||
                "截图识别任务";
            top.append(element("span", "task-card-title", title));
            const bottom = element("div", "task-card-bottom");
            bottom.append(
                badge(task.status),
                element("time", "", localDate(task.created_at)),
            );
            button.append(
                top,
                element(
                    "div",
                    "task-card-id",
                    `#${shortId(task.id)} · ${task.sources?.length || 0} 张截图`,
                ),
                bottom,
            );
            button.addEventListener("click", () => selectTask(task.id));
            list.append(button);
        }
    }

    function selectTask(id) {
        if (state.selectedId !== id) {
            state.selectedId = id;
            state.lastRenderKey = null;
        }
        renderQueue();
        const task = selectedTask();
        if (task) renderSelectedTask(task);
    }

    function renderEmpty() {
        byId("empty-review").hidden = false;
        byId("task-workspace").hidden = true;
        revokeImages();
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }
    function draftFor(task) {
        let draft = state.drafts.get(task.id);
        if (!draft || (!draft.dirty && draft.version !== task.version)) {
            draft = {
                version: task.version,
                events: clone(task.candidate?.events || []),
                dirty: false,
                actor: "",
                reason: "",
                request: null,
            };
            state.drafts.set(task.id, draft);
        }
        return draft;
    }

    function markDirty(draft) {
        draft.dirty = true;
        draft.request = null;
        byId("draft-state").textContent = "有未提交修改";
        byId("draft-state").classList.add("changed");
    }

    function renderSelectedTask(task, force = false) {
        byId("empty-review").hidden = true;
        byId("task-workspace").hidden = false;
        const draft = draftFor(task);
        const conflict = draft.version !== task.version;
        byId("version-warning").hidden = !conflict;
        byId("confirm-button").disabled =
            conflict || state.operations.has(`task:${task.id}`);
        const renderKey = `${task.id}:${task.version}:${task.status}`;
        // Polling updates metadata and conflicts, but never replaces unsaved controls.
        if (!force && state.lastRenderKey === renderKey) return;
        if (
            !force &&
            state.lastRenderKey?.startsWith(`${task.id}:`) &&
            draft.dirty &&
            conflict
        )
            return;
        state.lastRenderKey = renderKey;
        const statusBadge = byId("task-status");
        statusBadge.className = `badge ${Object.hasOwn(STATUS_LABELS, task.status) ? task.status : ""}`;
        statusBadge.textContent = labelStatus(task.status);
        byId("task-meta").textContent =
            `#${shortId(task.id)} · v${task.version} · ${localDate(task.created_at)}`;
        byId("source-summary").textContent =
            `${task.sources?.length || 0} 张截图 · 仅供核对`;
        byId("draft-state").textContent = draft.dirty
            ? "有未提交修改"
            : "待核对";
        byId("draft-state").classList.toggle("changed", draft.dirty);
        renderSources(task);
        renderTaskWarnings(task);
        renderEditor(task, draft);
    }

    async function renderSources(task) {
        revokeImages();
        const generation = state.imageGeneration;
        const epoch = state.epoch;
        const list = byId("source-list");
        list.replaceChildren();
        for (const [index, source] of (task.sources || []).entries()) {
            const card = element("figure", "source-card");
            const caption = element("figcaption", "source-caption");
            caption.append(
                element(
                    "span",
                    "",
                    `${index + 1}. ${source.filename || "原始截图"}`,
                ),
            );
            const placeholder = element(
                "div",
                "source-placeholder",
                "正在读取受保护的原图…",
            );
            card.append(caption, placeholder);
            list.append(card);
            try {
                const blob = await request(source.url, { blob: true });
                if (
                    generation !== state.imageGeneration ||
                    epoch !== state.epoch
                )
                    return;
                if (!/^image\/(png|jpeg|webp)$/.test(blob.type))
                    throw makeError("INVALID_IMAGE");
                const url = URL.createObjectURL(blob);
                state.blobs.add(url);
                const image = element("img");
                image.alt = `原始截图 ${index + 1}：${source.filename || "未命名"}`;
                image.src = url;
                image.loading = "lazy";
                const link = element("a", "", "查看原图 ↗");
                link.href = url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                caption.append(link);
                placeholder.replaceWith(image);
            } catch (error) {
                if (
                    generation !== state.imageGeneration ||
                    epoch !== state.epoch
                )
                    return;
                placeholder.textContent = "原图读取失败，请刷新后重试。";
            }
        }
        if (!task.sources?.length)
            list.append(
                element("div", "source-placeholder", "未找到可供核对的原图"),
            );
    }

    function humanText(value) {
        if (typeof value === "string") return value;
        if (value === null || value === undefined) return "未知";
        return JSON.stringify(value);
    }

    function appendWarnings(container, warnings, missing) {
        const rows = [];
        if (Array.isArray(warnings))
            for (const warning of warnings) rows.push(humanText(warning));
        if (Array.isArray(missing)) {
            for (const reason of missing) rows.push(humanText(reason));
        } else if (missing && typeof missing === "object") {
            for (const [field, reason] of Object.entries(missing))
                rows.push(`${field}：${humanText(reason)}`);
        }
        if (!rows.length) return;
        const box = element("div", "alert-list");
        box.append(element("strong", "", "需要核对"));
        const list = element("ul");
        for (const row of rows) list.append(element("li", "", row));
        box.append(list);
        container.append(box);
    }

    function renderTaskWarnings(task) {
        const container = byId("task-alerts");
        container.replaceChildren();
        appendWarnings(
            container,
            task.candidate?.warnings,
            task.candidate?.missing_reasons,
        );
    }

    function field(labelText, object, key, draft, options = {}) {
        const label = element("label", options.className || "", labelText);
        if (object[key] === null || object[key] === undefined)
            label.append(element("span", "field-null", "未识别"));
        let input;
        if (options.choices) {
            input = element("select");
            for (const [value, title] of options.choices) {
                const option = element("option", "", title);
                option.value = value;
                input.append(option);
            }
        } else {
            input = element("input");
            input.type = "text";
            input.maxLength = options.maxLength || 250;
            input.autocomplete = "off";
            if (options.decimal) input.inputMode = "decimal";
            input.placeholder = options.placeholder || "未识别，保留为空";
            if (options.required) input.setAttribute("aria-required", "true");
            if (options.list) input.setAttribute("list", options.list);
        }
        input.value =
            object[key] === null || object[key] === undefined
                ? ""
                : String(object[key]);
        if (options.disabled) input.disabled = true;
        input.addEventListener(options.choices ? "change" : "input", () => {
            const value = input.value.trim();
            // Quantities and prices stay decimal strings. Only integer versions become numbers.
            object[key] = options.integer
                ? value === ""
                    ? null
                    : /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
                      ? Number(value)
                      : value
                : value === ""
                  ? null
                  : value;
            markDirty(draft);
            const marker = label.querySelector(".field-null");
            if (marker) marker.hidden = object[key] !== null;
            if (options.onChange) options.onChange();
        });
        label.append(input);
        return label;
    }

    function newEvent() {
        return {
            action: "create",
            target_order_id: null,
            expected_order_version: null,
            customer: null,
            external_id: null,
            currency: null,
            occurred_at: null,
            reason: null,
            items: [newItem()],
            evidence: [],
            warnings: [],
            missing_reasons: [],
        };
    }

    function newItem() {
        return {
            line_id: null,
            sku: null,
            name: null,
            quantity: null,
            unit: null,
            unit_price: null,
        };
    }

    function actionButton(text, className, callback) {
        const button = element("button", `button ${className}`, text);
        button.type = "button";
        button.addEventListener("click", callback);
        return button;
    }

    function renderEditor(task, draft) {
        const content = byId("editor-content");
        const actions = byId("task-action-footer");
        content.replaceChildren();
        actions.replaceChildren();
        const editable = task.status === "review_required";
        byId("review-form").hidden = !editable;
        byId("review-actor").value = draft.actor;
        byId("review-reason").value = draft.reason;
        if (!editable) {
            const description = element("div", "task-description");
            if (isProcessing(task.status)) {
                description.append(
                    element("div", "pending-icon"),
                    element("strong", "", "正在准备识别候选"),
                    element(
                        "p",
                        "",
                        "结果会自动出现在这里。识别完成后仍需人工核对，不会自动入账。",
                    ),
                );
            } else if (task.status === "failed") {
                description.append(
                    element("strong", "", "这次识别未完成"),
                    element(
                        "p",
                        "",
                        "原始截图已保留。你可以重试识别，或填写原因后驳回任务。",
                    ),
                );
                if (task.error_code)
                    description.append(
                        element("p", "error-code", safeCode(task.error_code)),
                    );
                actions.append(
                    actionButton("重新识别", "primary", () => retryTask(task)),
                    actionButton("驳回任务", "danger-quiet", () =>
                        openReject(task),
                    ),
                );
            } else if (task.status === "confirmed") {
                description.append(
                    element("strong", "", "这条任务已完成确认"),
                    element(
                        "p",
                        "",
                        "正式订单已保存。后续改单或撤单需通过新的审核事件记录，不会覆盖原始审核历史。",
                    ),
                );
                actions.append(
                    actionButton("查看正式订单 →", "secondary", () =>
                        switchView("orders"),
                    ),
                );
            } else if (task.status === "rejected") {
                description.append(
                    element("strong", "", "这条任务已驳回"),
                    element(
                        "p",
                        "",
                        "本任务不生成正式订单，原始任务记录仍保留。",
                    ),
                );
            }
            content.append(description);
            if (!task.candidate?.events?.length) return;
        }
        const orderList = element("datalist");
        orderList.id = "order-suggestions";
        for (const order of state.orders) {
            const option = element("option");
            option.value = order.id;
            option.label = `${displayValue(order.customer)} · v${order.version} · ${labelStatus(order.status)}`;
            orderList.append(option);
        }
        content.append(orderList);
        const catalogue = state.status?.sku_catalog;
        if (Array.isArray(catalogue)) {
            const datalist = element("datalist");
            datalist.id = "sku-suggestions";
            for (const entry of catalogue) {
                const sku = typeof entry === "string" ? entry : entry?.sku;
                if (!sku) continue;
                const option = element("option");
                option.value = sku;
                if (typeof entry === "object" && entry.name)
                    option.label = entry.name;
                datalist.append(option);
            }
            content.append(datalist);
        }
        if (!draft.events.length)
            content.append(
                element(
                    "p",
                    "task-description",
                    "没有可审核的事件。可手动添加订单并逐项核对原图。",
                ),
            );
        draft.events.forEach((event, index) =>
            content.append(renderEvent(event, index, draft, task, editable)),
        );
        if (editable)
            content.append(
                actionButton("＋ 添加订单事件", "secondary add-event", () => {
                    if (draft.events.length >= 20) {
                        notice("每次审核最多 20 条订单事件。", "warning");
                        return;
                    }
                    draft.events.push(newEvent());
                    markDirty(draft);
                    renderEditor(task, draft);
                }),
            );
        setTaskBusy(task.id, state.operations.has(`task:${task.id}`));
    }

    function renderEvent(event, index, draft, task, editable) {
        const card = element("section", "event-card");
        const heading = element("div", "event-heading");
        heading.append(
            element("h3", "", `订单事件 ${String(index + 1).padStart(2, "0")}`),
        );
        if (editable)
            heading.append(
                actionButton("移除", "subtle small", () => {
                    draft.events.splice(index, 1);
                    markDirty(draft);
                    renderEditor(task, draft);
                }),
            );
        card.append(heading);
        appendWarnings(card, event.warnings, event.missing_reasons);
        const fields = element("div", "event-fields");
        const grid = element("div", "form-grid");
        const opts = { disabled: !editable };
        grid.append(
            field("事件类型", event, "action", draft, {
                ...opts,
                choices: [
                    ["create", "新增订单"],
                    ["amend", "修改订单"],
                    ["cancel", "撤销订单"],
                ],
                onChange: () => {
                    if (event.action === "create") {
                        event.target_order_id = null;
                        event.expected_order_version = null;
                    }
                    renderEditor(task, draft);
                },
            }),
        );
        grid.append(
            field("客户", event, "customer", draft, {
                ...opts,
                required: event.action !== "cancel",
            }),
        );
        if (event.action === "amend" || event.action === "cancel") {
            grid.append(
                field("目标订单 ID", event, "target_order_id", draft, {
                    ...opts,
                    placeholder: "正式订单中的完整内部 ID",
                    required: true,
                    list: "order-suggestions",
                }),
            );
            grid.append(
                field(
                    "目标订单当前版本",
                    event,
                    "expected_order_version",
                    draft,
                    {
                        ...opts,
                        integer: true,
                        placeholder: "例如：1",
                        required: true,
                    },
                ),
            );
            grid.append(
                field("改单 / 撤单原因", event, "reason", draft, {
                    ...opts,
                    className: "span-all",
                    maxLength: 1000,
                    required: true,
                }),
            );
        }
        grid.append(field("外部订单编号", event, "external_id", draft, opts));
        grid.append(
            field("币种", event, "currency", draft, {
                ...opts,
                maxLength: 3,
                placeholder: "例如：CNY（需核实）",
                required: event.action !== "cancel",
            }),
        );
        grid.append(
            field("业务时间（含时区）", event, "occurred_at", draft, {
                ...opts,
                className: "span-all",
                placeholder: "例如：2026-10-09T09:00:00+08:00；未知留空",
            }),
        );
        fields.append(grid);
        if (event.action === "amend")
            fields.append(
                element(
                    "p",
                    "field-help",
                    "修改会完整替换原订单的商品明细。请列出所有要保留的商品，并保留其原明细 ID。",
                ),
            );
        if (event.action !== "cancel") {
            const heading = element("div", "items-heading");
            heading.append(element("h3", "", "商品明细"));
            if (editable)
                heading.append(
                    actionButton("＋ 添加商品", "subtle small", () => {
                        if (!Array.isArray(event.items)) event.items = [];
                        if (event.items.length >= 100) {
                            notice("每笔订单最多 100 项商品。", "warning");
                            return;
                        }
                        event.items.push(newItem());
                        markDirty(draft);
                        renderEditor(task, draft);
                    }),
                );
            fields.append(heading);
            for (const [itemIndex, item] of (event.items || []).entries()) {
                const row = element("section", "item-card");
                const itemTop = element("div", "item-top");
                itemTop.append(element("span", "", `商品 ${itemIndex + 1}`));
                if (editable)
                    itemTop.append(
                        actionButton("移除", "subtle small", () => {
                            event.items.splice(itemIndex, 1);
                            markDirty(draft);
                            renderEditor(task, draft);
                        }),
                    );
                const itemFields = element("div", "item-fields");
                itemFields.append(
                    field("商品名称", item, "name", draft, {
                        ...opts,
                        className: "wide",
                        required: true,
                    }),
                );
                itemFields.append(
                    field("SKU", item, "sku", draft, {
                        ...opts,
                        required: true,
                        list: "sku-suggestions",
                    }),
                );
                itemFields.append(
                    field("数量", item, "quantity", draft, {
                        ...opts,
                        decimal: true,
                        required: true,
                    }),
                );
                itemFields.append(
                    field("单位", item, "unit", draft, {
                        ...opts,
                        required: true,
                    }),
                );
                itemFields.append(
                    field("单价", item, "unit_price", draft, {
                        ...opts,
                        decimal: true,
                        required: true,
                    }),
                );
                itemFields.append(
                    field("明细 ID（已有明细保留）", item, "line_id", draft, {
                        ...opts,
                        className: "wide",
                        placeholder: "新增明细可留空",
                    }),
                );
                row.append(itemTop, itemFields);
                fields.append(row);
            }
        } else
            fields.append(
                element(
                    "p",
                    "field-help",
                    "撤单会保留订单历史并更新状态。请核对目标订单 ID、当前版本及原因。",
                ),
            );
        card.append(fields);
        const evidence = element("details", "evidence-detail");
        evidence.append(
            element(
                "summary",
                "",
                `识别证据 · ${(event.evidence || []).length} 条`,
            ),
        );
        for (const record of event.evidence || []) {
            const entry = element("div", "evidence-entry");
            entry.append(
                element(
                    "code",
                    "",
                    `${record.field || "字段未知"} · 来源 ${shortId(record.source_id)}`,
                ),
            );
            entry.append(
                element(
                    "p",
                    "",
                    record.text === null
                        ? "无文本证据，请核对原图。"
                        : record.text || "无证据片段",
                ),
            );
            evidence.append(entry);
        }
        if (!event.evidence?.length)
            evidence.append(
                element(
                    "p",
                    "field-help",
                    "暂无字段证据。请直接核对原图，未知字段保持为空。",
                ),
            );
        card.append(evidence);
        return card;
    }

    function setTaskBusy(taskId, busy) {
        if (state.selectedId !== taskId) return;
        for (const node of byId("editor-content").querySelectorAll(
            "input, select, button",
        ))
            node.disabled =
                busy || selectedTask()?.status !== "review_required";
        for (const node of byId("review-form").querySelectorAll(
            "input, button",
        ))
            node.disabled = busy;
        for (const node of byId("task-action-footer").querySelectorAll(
            "button",
        ))
            node.disabled = busy;
        const task = selectedTask();
        const draft = state.drafts.get(taskId);
        byId("confirm-button").disabled =
            busy || (!!task && !!draft && draft.version !== task.version);
        byId("confirm-button").textContent = busy ? "正在提交…" : "确认入账 ✓";
    }

    function validateDraft(draft) {
        if (!draft.events.length) return "至少添加一条订单事件。";
        if (!draft.actor.trim() || !draft.reason.trim())
            return "请填写审核人和审核说明。";
        for (const [index, event] of draft.events.entries()) {
            const prefix = `事件 ${index + 1}：`;
            if (!["create", "amend", "cancel"].includes(event.action))
                return `${prefix}请选择事件类型。`;
            if (
                event.action !== "create" &&
                (!event.target_order_id ||
                    !Number.isInteger(event.expected_order_version) ||
                    event.expected_order_version < 1 ||
                    !event.reason?.trim())
            )
                return `${prefix}请填写目标订单 ID、正整数版本和改单 / 撤单原因。`;
            if (
                event.occurred_at &&
                !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.occurred_at)
            )
                return `${prefix}业务时间必须包含日期、时间与时区；未知请留空。`;
            if (event.action === "cancel") continue;
            if (
                !event.customer?.trim() ||
                !/^[A-Z]{3}$/.test(event.currency || "")
            )
                return `${prefix}请核对客户及三位大写币种代码。`;
            if (!event.items?.length) return `${prefix}至少添加一项商品。`;
            for (const [itemIndex, item] of event.items.entries()) {
                const catalogue = state.status?.sku_catalog;
                if (
                    Array.isArray(catalogue) &&
                    !catalogue.some(
                        (entry) =>
                            (typeof entry === "string" ? entry : entry.sku) ===
                            item.sku,
                    )
                )
                    return `${prefix}商品 ${itemIndex + 1} 的 SKU 不在本机已配置的商品目录中。`;
                if (
                    !item.sku?.trim() ||
                    !item.name?.trim() ||
                    !item.unit?.trim()
                )
                    return `${prefix}商品 ${itemIndex + 1} 的名称、SKU 和单位不能为空。`;
                // Validate decimal syntax without binary floating-point arithmetic.
                if (
                    !/^\d+(?:\.\d+)?$/.test(item.quantity || "") ||
                    !/[1-9]/.test(item.quantity)
                )
                    return `${prefix}商品 ${itemIndex + 1} 的数量应为大于零的十进制数。`;
                if (!/^\d+(?:\.\d+)?$/.test(item.unit_price ?? ""))
                    return `${prefix}商品 ${itemIndex + 1} 的单价应为非负十进制数。`;
            }
        }
        return null;
    }

    function uniqueKey() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
    }

    async function confirmTask(acknowledgeDuplicates = false, frozen = null) {
        const task = frozen
            ? state.tasks.find((item) => item.id === frozen.taskId)
            : selectedTask();
        if (!task || state.operations.has(`task:${task.id}`)) return;
        const draft = draftFor(task);
        const validation = validateDraft(draft);
        if (validation) {
            closeDialog("duplicate-dialog");
            notice(validation, "warning");
            return;
        }
        if (draft.version !== task.version) {
            closeDialog("duplicate-dialog");
            notice("任务已有新版本，请重新载入后核对。", "warning");
            return;
        }
        const body = frozen
            ? clone(frozen.body)
            : {
                  expected_version: draft.version,
                  actor: draft.actor.trim(),
                  reason: draft.reason.trim(),
                  events: clone(draft.events),
                  acknowledge_duplicates: false,
              };
        body.acknowledge_duplicates = acknowledgeDuplicates;
        delete body.idempotency_key;
        const fingerprint = JSON.stringify(body);
        if (!draft.request || draft.request.fingerprint !== fingerprint)
            draft.request = { fingerprint, key: uniqueKey() };
        body.idempotency_key = draft.request.key;
        state.operations.add(`task:${task.id}`);
        setTaskBusy(task.id, true);
        byId("duplicate-confirm").disabled = true;
        try {
            const result = await request(
                `/api/tasks/${encodeURIComponent(task.id)}/confirm`,
                { method: "POST", body },
            );
            closeDialog("duplicate-dialog");
            state.duplicate = null;
            state.drafts.delete(task.id);
            state.lastRenderKey = null;
            notice(
                `已确认入账，保存 ${result.orders?.length || draft.events.length} 条订单记录。`,
            );
            await refresh();
        } catch (error) {
            if (error.code === "DUPLICATE_WARNING") {
                state.duplicate = { taskId: task.id, body: clone(body) };
                const ids = Array.isArray(error.details?.order_ids)
                    ? error.details.order_ids.map(String)
                    : [];
                byId("duplicate-detail").textContent = ids.length
                    ? `相关订单 ID：${ids.join("、")}`
                    : "请在正式订单中核对是否已经入账。";
                byId("duplicate-checkbox").checked = false;
                byId("duplicate-confirm").disabled = true;
                if (!byId("duplicate-dialog").open)
                    byId("duplicate-dialog").showModal();
            } else {
                closeDialog("duplicate-dialog");
                state.duplicate = null;
                reportError(error);
                if (error.code === "VERSION_CONFLICT") await refresh();
            }
        } finally {
            state.operations.delete(`task:${task.id}`);
            setTaskBusy(task.id, false);
        }
    }

    function openReject(task = selectedTask()) {
        if (!task || state.operations.has(`task:${task.id}`)) return;
        state.rejectTarget = { id: task.id, version: draftFor(task).version };
        byId("reject-form").reset();
        byId("reject-error").hidden = true;
        byId("reject-dialog").showModal();
    }

    async function rejectTask(event) {
        event.preventDefault();
        const target = state.rejectTarget;
        if (!target || state.operations.has(`task:${target.id}`)) return;
        const reason = byId("reject-reason").value.trim();
        if (!reason) return;
        state.operations.add(`task:${target.id}`);
        byId("reject-submit").disabled = true;
        setTaskBusy(target.id, true);
        try {
            await request(
                `/api/tasks/${encodeURIComponent(target.id)}/reject`,
                {
                    method: "POST",
                    body: { expected_version: target.version, reason },
                },
            );
            closeDialog("reject-dialog");
            state.rejectTarget = null;
            state.drafts.delete(target.id);
            state.lastRenderKey = null;
            notice("任务已驳回，未生成正式订单。");
            await refresh();
        } catch (error) {
            reportError(error, byId("reject-error"));
        } finally {
            state.operations.delete(`task:${target.id}`);
            byId("reject-submit").disabled = false;
            setTaskBusy(target.id, false);
        }
    }

    async function retryTask(task) {
        if (state.operations.has(`task:${task.id}`)) return;
        state.operations.add(`task:${task.id}`);
        setTaskBusy(task.id, true);
        try {
            await request(`/api/tasks/${encodeURIComponent(task.id)}/retry`, {
                method: "POST",
                body: {},
            });
            state.drafts.delete(task.id);
            state.lastRenderKey = null;
            notice("已重新加入识别队列。");
            await refresh();
        } catch (error) {
            reportError(error);
        } finally {
            state.operations.delete(`task:${task.id}`);
            setTaskBusy(task.id, false);
        }
    }

    function openUpload() {
        byId("upload-error").hidden = true;
        byId("upload-dialog").showModal();
    }

    function showFiles() {
        byId("selected-files").replaceChildren();
        for (const file of byId("upload-files").files)
            byId("selected-files").append(
                element(
                    "div",
                    "",
                    `${file.name} · ${Math.ceil(file.size / 1024)} KB`,
                ),
            );
    }

    async function upload(event) {
        event.preventDefault();
        if (state.operations.has("upload")) return;
        const files = Array.from(byId("upload-files").files);
        if (!files.length) return;
        const body = new FormData();
        for (const file of files) body.append("files", file);
        body.append(
            "source_label",
            byId("source-label").value.trim() || "manual",
        );
        state.operations.add("upload");
        byId("upload-submit").disabled = true;
        byId("upload-submit").textContent = "正在上传…";
        byId("upload-error").hidden = true;
        for (const id of [
            "upload-files",
            "source-label",
            "cancel-upload",
            "close-upload",
        ])
            byId(id).disabled = true;
        try {
            const result = await request("/api/uploads", {
                method: "POST",
                body,
            });
            closeDialog("upload-dialog");
            byId("upload-form").reset();
            showFiles();
            const count = result.tasks?.length || 0;
            const duplicateCount = result.duplicates?.length || 0;
            notice(
                `已接收 ${count} 张截图${duplicateCount ? `，其中 ${duplicateCount} 张已存在，未重复导入` : ""}。`,
            );
            switchView("review");
            await refresh();
            const first = result.tasks?.[0];
            if (first) selectTask(typeof first === "string" ? first : first.id);
        } catch (error) {
            reportError(error, byId("upload-error"));
        } finally {
            state.operations.delete("upload");
            byId("upload-submit").disabled = false;
            byId("upload-submit").textContent = "上传并识别";
            for (const id of [
                "upload-files",
                "source-label",
                "cancel-upload",
                "close-upload",
            ])
                byId(id).disabled = false;
        }
    }

    function switchView(view) {
        state.view = view;
        byId("review-view").hidden = view !== "review";
        byId("orders-view").hidden = view !== "orders";
        for (const name of ["review", "orders"]) {
            byId(`nav-${name}`).classList.toggle("active", view === name);
            if (view === name)
                byId(`nav-${name}`).setAttribute("aria-current", "page");
            else byId(`nav-${name}`).removeAttribute("aria-current");
        }
    }

    function displayValue(value) {
        return value === null || value === undefined || value === ""
            ? "—"
            : String(value);
    }

    function renderOrders() {
        const key = JSON.stringify(state.orders);
        if (key === state.lastOrdersKey) return;
        state.lastOrdersKey = key;
        const content = byId("orders-content");
        content.replaceChildren();
        byId("order-count").textContent = `${state.orders.length} 笔订单`;
        if (!state.orders.length) {
            const empty = element("div", "orders-empty");
            empty.append(
                element("strong", "", "还没有正式订单"),
                element("p", "", "在审核队列核对并确认后，订单会出现在这里。"),
            );
            content.append(empty);
            return;
        }
        const table = element("table", "orders-table");
        const head = element("thead");
        const headings = element("tr");
        for (const title of [
            "订单 / 版本",
            "客户 / 外部编号",
            "商品明细",
            "数量 / 单价",
            "状态 / 币种",
        ])
            headings.append(element("th", "", title));
        head.append(headings);
        table.append(head);
        const body = element("tbody");
        for (const order of state.orders) {
            const row = element("tr");
            const id = element("td", "order-id", order.id);
            id.append(element("small", "", `版本 ${order.version}`));
            const customer = element("td", "", displayValue(order.customer));
            customer.append(
                element(
                    "small",
                    "",
                    `外部编号：${displayValue(order.external_id)}`,
                ),
            );
            const items = element("td");
            const values = element("td");
            for (const item of order.items || []) {
                const label = element("p", "", displayValue(item.name));
                label.append(
                    element(
                        "small",
                        "",
                        `SKU ${displayValue(item.sku)} · 明细 ${displayValue(item.line_id)}`,
                    ),
                );
                items.append(label);
                const value = element(
                    "p",
                    "",
                    `${displayValue(item.quantity)} ${displayValue(item.unit)} × ${displayValue(item.unit_price)}`,
                );
                value.append(element("small", "", "数量 × 单价"));
                values.append(value);
            }
            const status = element("td");
            status.append(
                badge(order.status),
                element("small", "", displayValue(order.currency)),
            );
            row.append(id, customer, items, values, status);
            body.append(row);
        }
        table.append(body);
        const wrapper = element("div", "orders-table-wrap");
        wrapper.append(table);
        content.append(wrapper);
    }

    async function exportOrders() {
        if (state.operations.has("export")) return;
        state.operations.add("export");
        byId("export-button").disabled = true;
        try {
            await request("/api/export", { method: "POST", body: {} });
            notice("已请求重新生成 Excel，导出状态会自动更新。");
            await refresh();
        } catch (error) {
            reportError(error);
        } finally {
            state.operations.delete("export");
            renderStatus();
        }
    }

    async function downloadExport() {
        if (state.operations.has("download")) return;
        state.operations.add("download");
        byId("download-button").disabled = true;
        try {
            const blob = await request("/api/export/download", { blob: true });
            const url = URL.createObjectURL(blob);
            const link = element("a");
            link.href = url;
            link.download = "OCRS-orders.xlsx";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (error) {
            reportError(error);
        } finally {
            state.operations.delete("download");
            renderStatus();
        }
    }

    byId("login-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const token = byId("access-token").value.trim();
        if (token) login(token);
    });
    byId("logout-button").addEventListener("click", () => logout());
    byId("refresh-button").addEventListener("click", () => refresh());
    byId("notice-close").addEventListener("click", () => {
        byId("notice").hidden = true;
    });
    byId("queue-filter").addEventListener("change", renderQueue);
    document
        .querySelector(".topbar .brand")
        .addEventListener("click", (event) => {
            event.preventDefault();
            switchView("review");
        });
    byId("nav-review").addEventListener("click", () => switchView("review"));
    byId("nav-orders").addEventListener("click", () => switchView("orders"));
    byId("review-form").addEventListener("submit", (event) => {
        event.preventDefault();
        confirmTask();
    });
    byId("review-actor").addEventListener("input", () => {
        const task = selectedTask();
        if (task) {
            const draft = draftFor(task);
            draft.actor = byId("review-actor").value;
            markDirty(draft);
        }
    });
    byId("review-reason").addEventListener("input", () => {
        const task = selectedTask();
        if (task) {
            const draft = draftFor(task);
            draft.reason = byId("review-reason").value;
            markDirty(draft);
        }
    });
    byId("reload-task").addEventListener("click", async () => {
        const task = selectedTask();
        if (!task || state.operations.has(`task:${task.id}`)) return;
        if (
            state.drafts.get(task.id)?.dirty &&
            !window.confirm("重新载入会清除这条任务尚未提交的修改。继续吗？")
        )
            return;
        state.drafts.delete(task.id);
        state.lastRenderKey = null;
        renderSelectedTask(task, true);
    });
    byId("reject-button").addEventListener("click", () => openReject());
    byId("reject-form").addEventListener("submit", rejectTask);
    byId("reject-cancel").addEventListener("click", () => {
        closeDialog("reject-dialog");
        state.rejectTarget = null;
    });
    byId("duplicate-checkbox").addEventListener("change", () => {
        byId("duplicate-confirm").disabled =
            !byId("duplicate-checkbox").checked;
    });
    byId("duplicate-cancel").addEventListener("click", () => {
        closeDialog("duplicate-dialog");
        state.duplicate = null;
    });
    byId("duplicate-confirm").addEventListener("click", () => {
        if (byId("duplicate-checkbox").checked && state.duplicate)
            confirmTask(true, state.duplicate);
    });
    byId("open-upload").addEventListener("click", openUpload);
    byId("empty-upload").addEventListener("click", openUpload);
    byId("close-upload").addEventListener("click", () =>
        closeDialog("upload-dialog"),
    );
    byId("cancel-upload").addEventListener("click", () =>
        closeDialog("upload-dialog"),
    );
    byId("upload-dialog").addEventListener("cancel", (event) => {
        if (state.operations.has("upload")) event.preventDefault();
    });
    byId("upload-files").addEventListener("change", showFiles);
    byId("upload-form").addEventListener("submit", upload);
    const drop = byId("file-drop");
    for (const name of ["dragenter", "dragover"])
        drop.addEventListener(name, (event) => {
            event.preventDefault();
            if (!state.operations.has("upload")) drop.classList.add("dragover");
        });
    for (const name of ["dragleave", "drop"])
        drop.addEventListener(name, () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", (event) => {
        event.preventDefault();
        if (state.operations.has("upload")) return;
        if (event.dataTransfer?.files) {
            byId("upload-files").files = event.dataTransfer.files;
            showFiles();
        }
    });
    byId("export-button").addEventListener("click", exportOrders);
    byId("download-button").addEventListener("click", downloadExport);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && state.token) refresh(true);
    });
    window.addEventListener("beforeunload", (event) => {
        if (Array.from(state.drafts.values()).some((draft) => draft.dirty)) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
    const stored = readToken();
    if (stored) login(stored);
})();
