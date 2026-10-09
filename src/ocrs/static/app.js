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
        image_invalid: "图片无法解码，请上传有效的 PNG、JPEG 或 WebP。",
        image_too_large: "图片超过本机允许大小，请缩小文件后重试。",
        image_type_unsupported: "不支持的图片类型，请使用 PNG、JPEG 或 WebP。",
        image_too_many_pixels: "图片像素过多，请缩小分辨率后重试。",
        image_animated: "不支持动态图，请上传静态截图。",
        RETRY_EXHAUSTED: "已达到识别重试上限，请检查运行配置。",
        PROVIDER_NOT_CONFIGURED: "真实模型尚未配置，请检查本机配置。",
        TRANSMISSION_NOT_ALLOWED: "尚未明确允许向外部模型发送资料。",
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
        view: "dashboard",
        reviewDetail: false,
        taskCache: new Map(),
        attentionTasks: [],
        taskPage: { total: 0, limit: 50, offset: 0, has_more: false },
        queryGeneration: 0,
        detailGeneration: 0,
        historyGeneration: 0,
        refreshPending: false,
        searchTimer: null,
        config: null,
        configLoading: false,
        confirmTarget: null,
        zoom: 100,
        dialogFocus: new Map(),
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
                if (epoch !== state.epoch) throw makeError("SESSION_CHANGED");
                if (response.status === 401 && state.token)
                    logout("访问令牌已失效，请重新验证。");
                throw makeError(
                    code,
                    response.status,
                    result.error?.details || result.details,
                );
            }
            const result = blob
                ? await response.blob()
                : response.status === 204 ? null : await response.json();
            if (epoch !== state.epoch) throw makeError("SESSION_CHANGED");
            return result;
        } catch (error) {
            if (epoch !== state.epoch) throw makeError("SESSION_CHANGED");
            if (controller.signal.aborted) throw makeError("REQUEST_TIMEOUT");
            if (typeof error.code === "string") throw error;
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

    function openDialog(id, focusId = null) {
        const dialog = byId(id);
        // Keep a safe focus destination when an in-flight action disables every control.
        dialog.setAttribute("tabindex", "-1");
        if (!dialog.open) {
            state.dialogFocus.set(id, document.activeElement);
            dialog.showModal();
        }
        if (focusId) byId(focusId).focus();
    }

    function closeDialog(id) {
        if (byId(id).open) byId(id).close();
    }

    function trapDialogFocus(event) {
        // Let native file pickers, Escape and IME composition keep their own behavior.
        if (
            event.key !== "Tab" ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        ) return;
        const dialogs = Array.from(document.querySelectorAll("dialog[open]"));
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return;
        const selector = [
            "a[href]", "button", "input", "select", "textarea", "summary",
            "[tabindex]", '[contenteditable="true"]',
        ].join(",");
        const controls = Array.from(dialog.querySelectorAll(selector)).filter(
            (node) => {
                if (
                    node.tabIndex < 0 ||
                    node.matches(":disabled") ||
                    node.closest("[hidden], [inert]") ||
                    node.getClientRects().length === 0
                ) return false;
                const visibility = getComputedStyle(node).visibility;
                return visibility !== "hidden" && visibility !== "collapse";
            },
        );
        // Native dialogs can send Tab to browser chrome at the final control.
        // Only take over at the boundary; ordinary controls retain native tab order.
        const active = document.activeElement;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) {
            event.preventDefault();
            dialog.focus();
        } else if (!dialog.contains(active) || !controls.includes(active)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function hasUnsavedWork() {
        return Array.from(state.drafts.values()).some((draft) => draft.dirty);
    }

    function manualLogout() {
        if ((hasUnsavedWork() || state.operations.size) && !window.confirm(
            "退出会清除当前页面的未提交修改。正在提交的操作可能已在本地服务完成，重新进入后请核对状态。确定退出吗？",
        )) return;
        logout();
    }

    function logout(message = "") {
        state.epoch += 1;
        state.token = "";
        saveToken("");
        for (const controller of state.controllers) controller.abort();
        state.controllers.clear();
        clearTimeout(state.timer);
        clearTimeout(state.searchTimer);
        revokeImages();
        state.tasks = [];
        state.orders = [];
        state.attentionTasks = [];
        state.status = null;
        state.config = null;
        state.configLoading = false;
        state.selectedId = null;
        state.taskCache.clear();
        state.taskPage = { total: 0, limit: 50, offset: 0, has_more: false };
        state.queryGeneration += 1;
        state.detailGeneration += 1;
        state.historyGeneration += 1;
        state.drafts.clear();
        state.operations.clear();
        state.duplicate = null;
        state.confirmTarget = null;
        state.rejectTarget = null;
        state.refreshPromise = null;
        state.refreshPending = false;
        state.lastRenderKey = null;
        state.lastQueueKey = null;
        state.lastOrdersKey = null;
        state.view = "dashboard";
        state.reviewDetail = false;
        for (const dialog of document.querySelectorAll("dialog")) closeDialog(dialog.id);
        state.dialogFocus.clear();
        for (const id of ["task-list", "source-list", "editor-content", "orders-content", "selected-files", "dashboard-tasks", "settings-config", "order-history-content", "confirm-summary", "task-alerts", "task-action-footer", "task-meta", "source-summary", "duplicate-detail", "inbox-error-list", "notice-text"])
            byId(id).replaceChildren();
        for (const id of ["upload-form", "review-form", "reject-form"]) byId(id).reset();
        for (const id of ["upload-files", "source-label", "upload-submit", "close-upload", "cancel-upload", "confirm-submit", "confirm-cancel", "reject-submit", "reject-cancel", "duplicate-cancel"]) byId(id).disabled = false;
        byId("upload-submit").textContent = "上传并识别";
        byId("duplicate-confirm").disabled = true;
        byId("queue-search").value = "";
        byId("queue-filter").value = "all";
        byId("order-search").value = "";
        byId("order-filter").value = "all";
        byId("workspace").hidden = true;
        byId("login-screen").hidden = false;
        byId("access-token").value = "";
        byId("login-error").textContent = message;
        byId("login-error").hidden = !message;
        byId("notice").hidden = true;
        byId("load-error").hidden = true;
        byId("login-button").disabled = false;
        byId("login-button").textContent = "进入工作台 →";
        byId("access-token").focus();
    }

    async function login(token) {
        if (state.operations.has("login")) return;
        state.operations.add("login");
        const epoch = state.epoch;
        byId("login-button").disabled = true;
        byId("login-button").textContent = "正在验证…";
        byId("login-error").hidden = true;
        try {
            const status = await request("/api/status", { token });
            if (epoch !== state.epoch) return;
            state.token = token;
            saveToken(token);
            state.status = status;
            byId("access-token").value = "";
            byId("login-screen").hidden = true;
            byId("workspace").hidden = false;
            switchView("dashboard");
            renderStatus();
            await refresh();
            if (epoch !== state.epoch) return;
            schedulePoll();
        } catch (error) {
            if (epoch !== state.epoch) return;
            saveToken("");
            reportError(error, byId("login-error"));
        } finally {
            if (epoch !== state.epoch) return;
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

    function taskQuery() {
        const query = new URLSearchParams({ limit: String(state.taskPage.limit), offset: String(state.taskPage.offset) });
        const filter = byId("queue-filter").value;
        const search = byId("queue-search").value.trim();
        if (filter !== "all") query.set("status", filter);
        if (search) query.set("q", search);
        return `/api/tasks?${query}`;
    }

    async function refresh(silent = false) {
        if (!state.token) return;
        if (state.refreshPromise) {
            state.refreshPending = true;
            return state.refreshPromise;
        }
        const epoch = state.epoch;
        const generation = state.queryGeneration;
        const selectedId = state.selectedId;
        const run = async () => {
            if (!silent) byId("refresh-button").disabled = true;
            byId("task-list").setAttribute("aria-busy", "true");
            try {
                const [status, taskData, orderData, selected, attention] = await Promise.all([
                    request("/api/status"),
                    request(taskQuery()),
                    request("/api/orders"),
                    selectedId ? request(`/api/tasks/${encodeURIComponent(selectedId)}`).catch((error) => {
                        if (error.code === "TASK_NOT_FOUND") return null;
                        throw error;
                    }) : null,
                    state.view === "dashboard" ? request("/api/tasks?limit=5&offset=0&status=review_required") : null,
                ]);
                if (epoch !== state.epoch) return;
                state.status = status;
                state.orders = Array.isArray(orderData.orders) ? orderData.orders : [];
                if (generation === state.queryGeneration) {
                    state.tasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
                    state.taskPage.total = taskData.total ?? state.tasks.length;
                    state.taskPage.has_more = taskData.has_more ?? false;
                    for (const task of state.tasks) state.taskCache.set(task.id, task);
                }
                if (selected && selectedId === state.selectedId) state.taskCache.set(selected.id, selected);
                if (attention) {
                    state.attentionTasks = Array.isArray(attention.tasks) ? attention.tasks : [];
                    for (const task of state.attentionTasks) state.taskCache.set(task.id, task);
                }
                byId("connection-status").classList.remove("offline");
                byId("connection-status").title = "本地服务连接正常";
                byId("connection-status").querySelector("span").textContent = "本地服务已连接";
                byId("last-sync").textContent = `同步于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}`;
                byId("load-error").hidden = true;
                renderStatus();
                renderQueue();
                renderOrders();
                renderDashboard();
                if (state.selectedId && state.reviewDetail) {
                    const task = selectedTask();
                    if (task) renderSelectedTask(task);
                } else renderEmpty();
            } catch (error) {
                if (epoch !== state.epoch) return;
                byId("connection-status").classList.add("offline");
                byId("connection-status").title = "同步失败，保留当前编辑";
                byId("connection-status").querySelector("span").textContent = "同步中断";
                byId("load-error").hidden = false;
                if (!silent) reportError(error);
            } finally {
                if (epoch === state.epoch) {
                    byId("refresh-button").disabled = false;
                    byId("task-list").setAttribute("aria-busy", "false");
                }
            }
        };
        const promise = run();
        state.refreshPromise = promise;
        try { await promise; }
        finally {
            if (state.refreshPromise === promise) {
                state.refreshPromise = null;
                if (state.refreshPending && epoch === state.epoch) {
                    state.refreshPending = false;
                    void refresh(true);
                }
            }
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
        byId("upload-mode-note").hidden = provider !== "demo";
        byId("confirm-demo-note").hidden = provider !== "demo";
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
        const confirmed = state.orders.filter((order) => ["confirmed", "active"].includes(order.status)).length;
        const cancelled = state.orders.filter((order) => ["cancelled", "canceled"].includes(order.status)).length;
        byId("export-scope").textContent = `当前正式订单 ${state.orders.length} 笔 · 有效 ${confirmed} 笔 · 已撤单 ${cancelled} 笔`;
        const metadata = exportState.metadata || {};
        const parts = [];
        if (exportState.created_at) parts.push(`最近生成：${localDate(exportState.created_at)}`);
        if (Number.isInteger(metadata.order_count)) parts.push(`${metadata.order_count} 笔订单`);
        if (Number.isInteger(metadata.row_count)) parts.push(`${metadata.row_count} 行明细`);
        byId("export-meta").textContent = parts.join(" · ");
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
        return state.taskCache.get(state.selectedId) || state.tasks.find((task) => task.id === state.selectedId);
    }

    function renderQueue() {
        const list = byId("task-list");
        const key = JSON.stringify([state.tasks, state.taskPage, state.selectedId]);
        if (key === state.lastQueueKey) return;
        state.lastQueueKey = key;
        const focusId = document.activeElement?.dataset?.taskId;
        list.replaceChildren();
        byId("queue-count").textContent = `${state.taskPage.total} 个任务`;
        if (!state.tasks.length) {
            list.append(element("p", "empty-queue", byId("queue-search").value || byId("queue-filter").value !== "all" ? "没有匹配的任务。试试其他关键词或状态。" : "暂无任务，导入截图后会出现在这里。"));
        } else {
            const table = element("table", "queue-table");
            table.setAttribute("aria-label", "截图识别任务列表");
            const head = element("thead");
            const headings = element("tr");
            for (const title of ["任务 / 客户", "来源", "候选动作", "处理状态", "导入时间"]) {
                const th = element("th", "", title); th.scope = "col"; headings.append(th);
            }
            head.append(headings); table.append(head);
            const body = element("tbody");
            for (const task of state.tasks) {
                const row = element("tr");
                const titleCell = element("td");
                const title = task.candidate?.events?.[0]?.customer || task.sources?.[0]?.filename || "截图识别任务";
                const button = element("button", `task-card${task.id === state.selectedId ? " active" : ""}`, title);
                button.type = "button"; button.dataset.taskId = task.id;
                button.setAttribute("aria-label", `审核任务：${title}，${labelStatus(task.status)}`);
                button.addEventListener("click", () => selectTask(task.id));
                titleCell.append(button, element("small", "", `#${shortId(task.id)} · v${task.version}`));
                const source = element("td", "", task.sources?.[0]?.source_label || task.sources?.[0]?.filename || "手动导入");
                source.append(element("small", "", `${task.sources?.length || 0} 张截图`));
                const types = Array.from(new Set((task.candidate?.events || []).map((event) => actionLabel(event.action))));
                const actions = element("td", "action-types", types.join(" / ") || "等待候选");
                const status = element("td"); status.append(badge(task.status));
                row.append(titleCell, source, actions, status, element("td", "", localDate(task.created_at)));
                body.append(row);
            }
            table.append(body); list.append(table);
        }
        const pagination = element("div", "pagination");
        const page = Math.floor(state.taskPage.offset / state.taskPage.limit) + 1;
        const pages = Math.max(1, Math.ceil(state.taskPage.total / state.taskPage.limit));
        const previous = actionButton("上一页", "secondary small", () => changePage(-1));
        const next = actionButton("下一页", "secondary small", () => changePage(1));
        previous.id = "queue-previous-page"; next.id = "queue-next-page";
        previous.disabled = state.taskPage.offset === 0;
        next.disabled = !state.taskPage.has_more;
        pagination.append(element("span", "", `第 ${page} / ${pages} 页 · 每页 ${state.taskPage.limit} 条`), previous, next);
        list.append(pagination);
        if (focusId) Array.from(list.querySelectorAll("[data-task-id]")).find((button) => button.dataset.taskId === focusId)?.focus();
        updateTaskNavigation();
    }

    function changePage(direction) {
        state.taskPage.offset = Math.max(0, state.taskPage.offset + direction * state.taskPage.limit);
        state.queryGeneration += 1;
        void refresh();
    }

    function queryChanged() {
        state.taskPage.offset = 0;
        state.queryGeneration += 1;
        void refresh();
    }

    async function selectTask(id) {
        state.detailGeneration += 1;
        const generation = state.detailGeneration;
        const epoch = state.epoch;
        if (state.selectedId !== id) {
            state.selectedId = id;
            state.lastRenderKey = null;
            state.zoom = 100;
        }
        state.reviewDetail = true;
        switchView("review");
        byId("queue-panel").hidden = true;
        byId("empty-review").hidden = true;
        byId("task-workspace").hidden = false;
        renderQueue();
        const cached = selectedTask();
        if (cached) renderSelectedTask(cached);
        else {
            byId("editor-content").replaceChildren(element("p", "task-description", "正在读取任务详情…"));
            byId("review-form").hidden = true;
            revokeImages();
            byId("source-list").replaceChildren();
            try {
                const task = await request(`/api/tasks/${encodeURIComponent(id)}`);
                if (epoch !== state.epoch || generation !== state.detailGeneration) return;
                state.taskCache.set(task.id, task);
                renderSelectedTask(task);
            } catch (error) {
                if (epoch !== state.epoch || generation !== state.detailGeneration) return;
                reportError(error);
                byId("editor-content").replaceChildren(element("p", "task-description", "任务读取失败，请返回队列后重试。"));
            }
        }
        if (epoch === state.epoch && generation === state.detailGeneration) {
            updateTaskNavigation();
            byId("back-to-queue").focus();
        }
    }

    function updateTaskNavigation() {
        const index = state.tasks.findIndex((task) => task.id === state.selectedId);
        byId("previous-task").disabled = index <= 0;
        byId("next-task").disabled = index < 0 || index >= state.tasks.length - 1;
        byId("detail-position").textContent = index >= 0 ? `本页 ${index + 1} / ${state.tasks.length}` : "当前任务";
    }

    function navigateTask(direction) {
        const index = state.tasks.findIndex((task) => task.id === state.selectedId);
        const task = state.tasks[index + direction];
        if (index >= 0 && task) void selectTask(task.id);
    }

    function showQueue() {
        state.reviewDetail = false;
        state.detailGeneration += 1;
        byId("queue-panel").hidden = false;
        byId("task-workspace").hidden = true;
        renderEmpty();
        const taskButton = Array.from(byId("task-list").querySelectorAll(".task-card")).find((button) => button.dataset.taskId === state.selectedId);
        (taskButton || byId("queue-search")).focus();
    }

    function renderEmpty() {
        if (state.reviewDetail) return;
        byId("queue-panel").hidden = false;
        byId("empty-review").hidden = !!state.taskPage.total || byId("queue-filter").value !== "all" || !!byId("queue-search").value;
        byId("task-workspace").hidden = true;
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
        byId("queue-panel").hidden = true;
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
        applyZoom();
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
                placeholder.textContent = error.code === "EVIDENCE_EXPIRED" ? "原图已按保留期限清理，无法预览。" : "原图读取失败，请使用刷新按钮重试。";
                placeholder.append(actionButton("重新读取", "secondary small", () => renderSources(task)));
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
        input.dataset.field = key;
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
        const comparison = element("div", "target-comparison");
        const updateComparison = () => renderTargetComparison(comparison, event, draft, task, editable);
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
                    onChange: updateComparison,
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
        if (["amend", "cancel"].includes(event.action)) {
            fields.append(comparison);
            updateComparison();
        }
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

    function renderTargetComparison(container, event, draft, task, editable) {
        container.replaceChildren();
        const order = state.orders.find((entry) => entry.id === event.target_order_id);
        if (!order) {
            container.append(element("p", "field-help", "选择有效的目标订单后，这里显示原单与版本信息。不要根据截图猜测订单关联。"));
            return;
        }
        const header = element("div", "target-heading");
        header.append(element("strong", "", `原单：${displayValue(order.customer)}`), badge(order.status));
        container.append(header, element("p", "field-help", `完整 ID：${order.id} · 当前版本 v${order.version} · ${displayValue(order.currency)}`));
        if (editable) {
            const useVersion = actionButton(`带入当前版本 v${order.version}`, "secondary small", () => {
                event.expected_order_version = order.version;
                markDirty(draft);
                renderEditor(task, draft);
            });
            useVersion.dataset.action = "use-order-version";
            container.append(useVersion);
        }
        const snapshot = element("details", "target-snapshot");
        snapshot.open = true;
        snapshot.append(element("summary", "", event.action === "cancel" ? "撤单影响：保留历史，将原单标记为已撤单" : "原单明细对照（修改会完整替换明细）"));
        const list = element("ul");
        for (const line of order.items || []) list.append(element("li", "", `${displayValue(line.name)} / ${displayValue(line.sku)} · ${displayValue(line.quantity)} ${displayValue(line.unit)} × ${displayValue(line.unit_price)} · 明细 ${displayValue(line.line_id)}`));
        snapshot.append(list);
        if (event.action === "amend") snapshot.append(element("p", "field-help", "下方编辑的是本次提交的完整新明细；需要保留的原明细必须在其中，并沿用原明细 ID。此处不会自动覆盖候选。"));
        container.append(snapshot);
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
        byId("confirm-button").textContent = busy ? "正在提交…" : "核对并提交";
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

    function openConfirm() {
        const task = selectedTask();
        if (!task || task.status !== "review_required" || state.operations.has(`task:${task.id}`)) return;
        const draft = draftFor(task);
        const validation = validateDraft(draft);
        if (validation) { notice(validation, "warning"); return; }
        if (draft.version !== task.version) { notice("任务已有新版本，请重新载入后核对。", "warning"); return; }
        state.confirmTarget = {
            taskId: task.id,
            body: { expected_version: draft.version, actor: draft.actor.trim(), reason: draft.reason.trim(), events: clone(draft.events), acknowledge_duplicates: false },
        };
        const summary = byId("confirm-summary");
        summary.replaceChildren();
        for (const [index, event] of draft.events.entries()) {
            const row = element("div", "confirm-event");
            row.append(element("strong", "", `${index + 1}. ${actionLabel(event.action)} · ${displayValue(event.customer)}`));
            row.append(element("p", "", event.action === "create" ? `${event.items?.length || 0} 项商品 · ${displayValue(event.currency)}` : `目标 ${event.target_order_id} · 当前版本 v${event.expected_order_version} · 原因：${event.reason}`));
            summary.append(row);
        }
        const audit = element("div", "confirm-event");
        audit.append(element("strong", "", `审核人：${draft.actor}`), element("p", "", `审核说明：${draft.reason}`));
        summary.append(audit);
        byId("confirm-error").hidden = true;
        const hasCancellation = draft.events.some((event) => event.action === "cancel");
        byId("confirm-submit").className = `button ${hasCancellation ? "danger" : "primary"}`;
        byId("confirm-submit").textContent = hasCancellation ? "确认撤单并保存" : "确认保存";
        byId("confirm-submit").disabled = false;
        byId("confirm-cancel").disabled = false;
        openDialog("confirm-dialog", "confirm-cancel");
    }

    async function confirmTask(acknowledgeDuplicates = false, frozen = state.confirmTarget) {
        const target = frozen;
        const task = target ? state.taskCache.get(target.taskId) : selectedTask();
        if (!task || !target || state.operations.has(`task:${task.id}`)) return;
        const draft = draftFor(task);
        if (target.body.expected_version !== task.version) {
            closeDialog("confirm-dialog"); closeDialog("duplicate-dialog");
            notice("任务已有新版本，请重新载入后核对。", "warning"); return;
        }
        const body = clone(target.body);
        body.acknowledge_duplicates = acknowledgeDuplicates;
        delete body.idempotency_key;
        const fingerprint = JSON.stringify(body);
        if (!draft.request || draft.request.fingerprint !== fingerprint) draft.request = { fingerprint, key: uniqueKey() };
        body.idempotency_key = draft.request.key;
        const epoch = state.epoch;
        state.operations.add(`task:${task.id}`);
        setTaskBusy(task.id, true);
        byId("confirm-submit").disabled = true;
        byId("confirm-cancel").disabled = true;
        byId("duplicate-confirm").disabled = true;
        byId("duplicate-cancel").disabled = true;
        try {
            const result = await request(`/api/tasks/${encodeURIComponent(task.id)}/confirm`, { method: "POST", body });
            if (epoch !== state.epoch) return;
            closeDialog("confirm-dialog"); closeDialog("duplicate-dialog");
            state.confirmTarget = null; state.duplicate = null;
            state.drafts.delete(task.id); state.lastRenderKey = null;
            notice(`审核已保存，记录 ${result.orders?.length || draft.events.length} 条订单变更。`);
            await refresh();
        } catch (error) {
            if (epoch !== state.epoch) return;
            if (error.code === "DUPLICATE_WARNING") {
                closeDialog("confirm-dialog");
                state.duplicate = { taskId: task.id, body: clone(body) };
                const ids = Array.isArray(error.details?.order_ids) ? error.details.order_ids.map(String) : [];
                byId("duplicate-detail").textContent = ids.length ? `相关订单 ID：${ids.join("、")}` : "请在正式订单中核对是否已经入账。";
                byId("duplicate-checkbox").checked = false;
                byId("duplicate-confirm").disabled = true;
                openDialog("duplicate-dialog", "duplicate-cancel");
            } else {
                reportError(error, byId("confirm-dialog").open ? byId("confirm-error") : null);
                if (["VERSION_CONFLICT", "REQUEST_TIMEOUT", "NETWORK_ERROR"].includes(error.code)) await refresh();
            }
        } finally {
            if (epoch !== state.epoch) return;
            state.operations.delete(`task:${task.id}`);
            setTaskBusy(task.id, false);
            byId("confirm-submit").disabled = false;
            byId("confirm-cancel").disabled = false;
            byId("duplicate-cancel").disabled = false;
            byId("duplicate-confirm").disabled = !byId("duplicate-checkbox").checked;
        }
    }

    function openReject(task = selectedTask()) {
        if (!task || state.operations.has(`task:${task.id}`)) return;
        state.rejectTarget = { id: task.id, version: draftFor(task).version };
        byId("reject-form").reset();
        byId("reject-error").hidden = true;
        openDialog("reject-dialog", "reject-reason");
    }

    async function rejectTask(event) {
        event.preventDefault();
        const target = state.rejectTarget;
        if (!target || state.operations.has(`task:${target.id}`)) return;
        const reason = byId("reject-reason").value.trim();
        if (!reason) return;
        const epoch = state.epoch;
        state.operations.add(`task:${target.id}`);
        byId("reject-cancel").disabled = true;
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
            if (epoch !== state.epoch) return;
            closeDialog("reject-dialog");
            state.rejectTarget = null;
            state.drafts.delete(target.id);
            state.lastRenderKey = null;
            notice("任务已驳回，未生成正式订单。");
            await refresh();
        } catch (error) {
            if (epoch !== state.epoch) return;
            reportError(error, byId("reject-error"));
        } finally {
            if (epoch !== state.epoch) return;
            state.operations.delete(`task:${target.id}`);
            byId("reject-cancel").disabled = false;
            byId("reject-submit").disabled = false;
            setTaskBusy(target.id, false);
        }
    }

    async function retryTask(task) {
        if (state.operations.has(`task:${task.id}`)) return;
        const epoch = state.epoch;
        state.operations.add(`task:${task.id}`);
        setTaskBusy(task.id, true);
        try {
            await request(`/api/tasks/${encodeURIComponent(task.id)}/retry`, {
                method: "POST",
                body: { expected_version: task.version },
            });
            if (epoch !== state.epoch) return;
            state.drafts.delete(task.id);
            state.lastRenderKey = null;
            notice("已重新加入识别队列。");
            await refresh();
        } catch (error) {
            if (epoch !== state.epoch) return;
            reportError(error);
        } finally {
            if (epoch !== state.epoch) return;
            state.operations.delete(`task:${task.id}`);
            setTaskBusy(task.id, false);
        }
    }

    function openUpload() {
        byId("upload-error").hidden = true;
        openDialog("upload-dialog", "upload-files");
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
        const maxFiles = state.config?.max_upload_files || 8;
        const maxBytes = state.config?.max_upload_bytes || 10485760;
        if (files.length > maxFiles) { reportError(makeError("UPLOAD_COUNT"), byId("upload-error")); return; }
        if (files.some((file) => file.size > maxBytes)) { reportError(makeError("UPLOAD_TOO_LARGE"), byId("upload-error")); return; }
        if (files.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type))) { reportError(makeError("INVALID_FILE_TYPE"), byId("upload-error")); return; }
        const epoch = state.epoch;
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
            if (epoch !== state.epoch) return;
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
            if (epoch !== state.epoch) return;
            const first = result.tasks?.[0];
            if (first && typeof first === "object" && !state.taskCache.has(first.id)) state.taskCache.set(first.id, first);
            if (first) await selectTask(typeof first === "string" ? first : first.id);
        } catch (error) {
            if (epoch !== state.epoch) return;
            reportError(error, byId("upload-error"));
            if (["REQUEST_TIMEOUT", "NETWORK_ERROR"].includes(error.code)) {
                byId("upload-error").textContent = `上传结果未知，图片可能已被接收。请先刷新核对任务队列；如需重试，保留相同图片和来源标签以复用原记录。（${safeCode(error.code)}）`;
                await refresh();
            }
        } finally {
            if (epoch !== state.epoch) return;
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
        const titles = { dashboard: "工作台", review: "审核队列", orders: "正式订单", exports: "导出中心", settings: "运行配置" };
        if (!Object.hasOwn(titles, view)) return;
        state.view = view;
        for (const name of Object.keys(titles)) {
            byId(`${name}-view`).hidden = view !== name;
            byId(`nav-${name}`).classList.toggle("active", view === name);
            if (view === name) byId(`nav-${name}`).setAttribute("aria-current", "page");
            else byId(`nav-${name}`).removeAttribute("aria-current");
        }
        byId("page-title").textContent = titles[view];
        document.title = `${titles[view]} · OCRS`;
        if (view === "settings") void loadConfig();
        if (view === "dashboard") renderDashboard();
    }

    function displayValue(value) {
        return value === null || value === undefined || value === ""
            ? "—"
            : String(value);
    }

    function renderOrders() {
        const search = byId("order-search").value.trim().toLocaleLowerCase();
        const filter = byId("order-filter").value;
        const orders = state.orders.filter((order) => {
            const matchStatus = filter === "all" || (filter === "confirmed" ? ["confirmed", "active"].includes(order.status) : ["cancelled", "canceled"].includes(order.status));
            const values = [order.id, order.customer, order.external_id, ...(order.items || []).flatMap((item) => [item.sku, item.name])];
            return matchStatus && (!search || values.some((value) => String(value || "").toLocaleLowerCase().includes(search)));
        });
        const key = JSON.stringify([orders, search, filter]);
        if (key === state.lastOrdersKey) return;
        state.lastOrdersKey = key;
        const content = byId("orders-content");
        content.replaceChildren();
        byId("order-count").textContent = `${orders.length} / ${state.orders.length} 笔订单`;
        if (!orders.length) {
            const empty = element("div", "orders-empty");
            empty.append(
                element("strong", "", state.orders.length ? "没有匹配的正式订单" : "还没有正式订单"),
                element("p", "", state.orders.length ? "试试其他关键词或状态。" : "在审核队列核对并确认后，订单会出现在这里。"),
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
        for (const order of orders) {
            const row = element("tr");
            const id = element("td", "order-id");
            const open = actionButton(shortId(order.id), "order-open", () => openOrderHistory(order));
            open.dataset.orderId = order.id;
            open.title = `查看 ${order.id} 的详情与历史`;
            id.append(open);
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
        const epoch = state.epoch;
        state.operations.add("export");
        byId("export-button").disabled = true;
        try {
            await request("/api/export", { method: "POST", body: {} });
            if (epoch !== state.epoch) return;
            notice("已请求重新生成 Excel，导出状态会自动更新。");
            await refresh();
        } catch (error) {
            if (epoch !== state.epoch) return;
            reportError(error);
        } finally {
            if (epoch !== state.epoch) return;
            state.operations.delete("export");
            renderStatus();
        }
    }

    async function downloadExport() {
        if (state.operations.has("download")) return;
        const epoch = state.epoch;
        state.operations.add("download");
        byId("download-button").disabled = true;
        try {
            const blob = await request("/api/export/download", { blob: true });
            if (epoch !== state.epoch) return;
            const url = URL.createObjectURL(blob);
            const link = element("a");
            link.href = url;
            link.download = "OCRS-orders.xlsx";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (error) {
            if (epoch !== state.epoch) return;
            reportError(error);
        } finally {
            if (epoch !== state.epoch) return;
            state.operations.delete("download");
            renderStatus();
        }
    }

    function actionLabel(action) {
        return { create: "新增订单", amend: "修改订单", cancel: "撤销订单" }[action] || "未知动作";
    }

    function applyZoom() {
        byId("source-list").style.setProperty("--image-scale", `${state.zoom}%`);
        byId("zoom-value").textContent = state.zoom === 100 ? "适合宽度" : `${state.zoom}%`;
        byId("zoom-out").disabled = state.zoom <= 50;
        byId("zoom-in").disabled = state.zoom >= 300;
    }

    function renderDashboard() {
        const content = byId("dashboard-tasks");
        const focusedTask = document.activeElement?.dataset?.dashboardTaskId;
        content.replaceChildren();
        const tasks = state.attentionTasks;
        if (!tasks.length) {
            const empty = element("div", "dashboard-empty");
            empty.append(element("strong", "", "当前没有待审核任务"), element("p", "", state.tasks.length ? "可查看处理中的任务、失败任务或已确认记录。" : "先导入一张完全虚构的截图，体验审核流程。"), actionButton("打开审核队列", "secondary small", () => { switchView("review"); showQueue(); }));
            content.append(empty);
            return;
        }
        for (const task of tasks) {
            const button = element("button", "dashboard-task");
            button.type = "button";
            button.dataset.dashboardTaskId = task.id;
            const body = element("span", "task-body");
            body.append(element("strong", "", task.candidate?.events?.[0]?.customer || task.sources?.[0]?.filename || "待审核任务"), element("small", "", `#${shortId(task.id)} · ${localDate(task.created_at)}`));
            button.append(badge(task.status), body, element("span", "", "→"));
            button.addEventListener("click", () => selectTask(task.id));
            content.append(button);
        }
        if (focusedTask) Array.from(content.querySelectorAll("button")).find((button) => button.dataset.dashboardTaskId === focusedTask)?.focus();
    }

    async function loadConfig(force = false) {
        if (!state.token || state.configLoading) return;
        if (state.config && !force) { renderConfig(); return; }
        const epoch = state.epoch;
        state.configLoading = true;
        byId("settings-config").replaceChildren(element("div", "panel config-loading", "正在读取安全配置摘要…"));
        try {
            const config = await request("/api/config");
            if (epoch !== state.epoch) return;
            state.config = config;
            renderConfig();
        } catch (error) {
            if (epoch !== state.epoch) return;
            const panel = element("div", "panel config-loading");
            panel.append(element("p", "form-error", errorText(error)), actionButton("重新读取配置", "secondary small", () => loadConfig(true)));
            byId("settings-config").replaceChildren(panel);
        } finally {
            if (epoch === state.epoch) state.configLoading = false;
        }
    }

    function configPanel(title, rows, note) {
        const panel = element("section", "panel");
        const heading = element("div", "panel-heading");
        heading.append(element("h2", "", title), element("span", "badge neutral", "配置摘要"));
        const list = element("dl", "config-list");
        for (const [name, value] of rows) {
            const row = element("div", "config-row");
            row.append(element("dt", "", name), element("dd", "", displayValue(value)));
            list.append(row);
        }
        panel.append(heading, list);
        if (note) panel.append(element("p", "config-note", note));
        return panel;
    }

    function renderConfig() {
        const config = state.config;
        if (!config) return;
        const panel = byId("settings-config");
        panel.replaceChildren();
        const yesNo = (value) => value === true ? "已配置" : value === false ? "未配置" : "未知";
        const mode = config.provider === "demo" ? "demo · 不执行 OCR" : config.provider === "openai-compatible" ? "外部兼容接口" : displayValue(config.provider);
        panel.append(configPanel("识别与传输", [
            ["识别适配器", mode],
            ["模型配置", yesNo(config.model_configured)],
            ["允许外部传输", config.external_transmission_enabled === true ? "已显式启用" : "未启用"],
            ["连接 / 识别验证", "未在此页面执行验证"],
        ], "配置存在不代表服务连接、识别准确率或授权范围已验证。demo 不识别图片内容。"));
        panel.append(configPanel("导入与证据", [
            ["文件夹导入", config.inbox_enabled === true ? "已启用 · 仅处理已保存图片" : "未启用 · 手动上传"],
            ["单次文件上限", Number.isInteger(config.max_upload_files) ? `${config.max_upload_files} 张` : "未知"],
            ["单张文件上限", Number.isInteger(config.max_upload_bytes) ? `${config.max_upload_bytes} 字节` : "未知"],
            ["图片保留窗口", Number.isInteger(config.evidence_days) ? `${config.evidence_days} 天 · 不自动清理` : "未知"],
        ], "图片清理会同时删除对应候选及候选历史。正式订单与业务事件没有自动到期删除功能。"));
        panel.append(configPanel("订单与商品", [
            ["已配置 SKU", Array.isArray(config.sku_catalog) ? config.sku_catalog.join("、") : "未知"],
            ["支持币种", Array.isArray(config.supported_currencies) ? config.supported_currencies.join(" / ") : "未知"],
            ["金额处理", "精确十进制字符串"],
            ["入账方式", "逐次人工审核确认"],
        ], "商品目录配置不代表库存或价格已核验。税费、运费、折扣和会计结算未建模。"));
        panel.append(configPanel("本地运行", [
            ["应用版本", config.version],
            ["配置摘要版本", config.schema_version],
            ["部署模式", config.deployment_mode === "single-user-local" ? "单人 / 单机 / 单写者" : "未知"],
            ["备份恢复", config.backup_mode === "offline-cli" ? "停机后通过本机命令执行" : "未知"],
        ], "本页不显示密钥、完整服务地址或数据路径，也不修改配置。运维步骤见项目 docs/OPERATIONS.md。"));
    }

    async function openOrderHistory(order) {
        const epoch = state.epoch;
        state.historyGeneration += 1;
        const generation = state.historyGeneration;
        const content = byId("order-history-content");
        content.replaceChildren(element("p", "muted", "正在读取订单版本历史…"));
        openDialog("order-history-dialog", "history-close");
        try {
            const result = await request(`/api/orders/${encodeURIComponent(order.id)}/history`);
            if (epoch !== state.epoch || generation !== state.historyGeneration || !byId("order-history-dialog").open) return;
            content.replaceChildren();
            const intro = element("div", "history-intro");
            intro.append(element("strong", "", displayValue(order.customer)), badge(order.status), element("p", "", `完整订单 ID：${order.id}`), element("p", "", `当前版本 v${order.version} · 外部编号：${displayValue(order.external_id)} · ${displayValue(order.currency)}`), element("p", "", "如需改单或撤单，请导入相应证据，在新的候选审核中明确选择此订单和当前版本。"));
            content.append(intro);
            const list = element("ol", "history-list");
            for (const record of Array.isArray(result.events) ? result.events : []) {
                const item = element("li", "history-event");
                const heading = element("div", "heading-line");
                heading.append(element("strong", "", `v${record.version} · ${actionLabel(record.action)}`), element("span", "tiny muted", localDate(record.created_at)));
                item.append(heading, element("p", "", `操作者：${displayValue(record.actor)} · 原因：${displayValue(record.reason)}`));
                const snapshot = record.payload || {};
                const details = element("details");
                details.append(element("summary", "", "查看当时订单快照"));
                details.append(element("p", "", `客户：${displayValue(snapshot.customer)} · ${displayValue(snapshot.currency)} · ${labelStatus(snapshot.status)}`));
                const lines = element("ul");
                for (const line of snapshot.items || []) lines.append(element("li", "", `${displayValue(line.name)} / ${displayValue(line.sku)} · ${displayValue(line.quantity)} ${displayValue(line.unit)} × ${displayValue(line.unit_price)} · 明细 ID ${displayValue(line.line_id)}`));
                details.append(lines); item.append(details); list.append(item);
            }
            if (!list.childElementCount) content.append(element("p", "muted", "暂无可显示的版本事件。"));
            content.append(list);
        } catch (error) {
            if (epoch !== state.epoch || generation !== state.historyGeneration) return;
            content.replaceChildren(element("p", "form-error", errorText(error)), actionButton("重新读取", "secondary", () => openOrderHistory(order)));
        }
    }

    byId("login-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const token = byId("access-token").value.trim();
        if (token) void login(token);
    });
    byId("logout-button").addEventListener("click", manualLogout);
    byId("logout-mobile").addEventListener("click", manualLogout);
    byId("refresh-button").addEventListener("click", () => {
        if (state.view === "settings") void loadConfig(true);
        void refresh();
        const task = selectedTask();
        if (task && state.reviewDetail) void renderSources(task);
    });
    byId("notice-close").addEventListener("click", () => { byId("notice").hidden = true; });
    byId("queue-filter").addEventListener("change", queryChanged);
    byId("queue-search").addEventListener("input", () => {
        state.queryGeneration += 1;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(queryChanged, 250);
    });
    byId("order-search").addEventListener("input", renderOrders);
    byId("order-filter").addEventListener("change", renderOrders);
    document.querySelector(".sidebar .brand").addEventListener("click", (event) => { event.preventDefault(); switchView("dashboard"); void refresh(true); });
    for (const view of ["dashboard", "review", "orders", "exports", "settings"]) byId(`nav-${view}`).addEventListener("click", () => {
        switchView(view);
        if (view === "review") showQueue();
        if (view === "dashboard") void refresh(true);
    });
    byId("orders-export").addEventListener("click", () => switchView("exports"));
    byId("dashboard-review").addEventListener("click", () => { switchView("review"); showQueue(); });
    for (const [id, filter] of [["stat-review", "review_required"], ["stat-processing", "processing"], ["stat-failed", "failed"], ["stat-confirmed", "confirmed"]]) byId(id).addEventListener("click", () => {
        byId("queue-filter").value = filter;
        byId("queue-search").value = "";
        switchView("review"); showQueue(); queryChanged();
    });
    byId("back-to-queue").addEventListener("click", showQueue);
    byId("previous-task").addEventListener("click", () => navigateTask(-1));
    byId("next-task").addEventListener("click", () => navigateTask(1));
    byId("zoom-in").addEventListener("click", () => { state.zoom = Math.min(300, state.zoom + 25); applyZoom(); });
    byId("zoom-out").addEventListener("click", () => { state.zoom = Math.max(50, state.zoom - 25); applyZoom(); });
    byId("zoom-fit").addEventListener("click", () => { state.zoom = 100; applyZoom(); });
    byId("review-form").addEventListener("submit", (event) => { event.preventDefault(); openConfirm(); });
    byId("confirm-submit").addEventListener("click", () => confirmTask());
    byId("confirm-cancel").addEventListener("click", () => closeDialog("confirm-dialog"));
    for (const [id, field] of [["review-actor", "actor"], ["review-reason", "reason"]]) byId(id).addEventListener("input", () => {
        const task = selectedTask();
        if (task) { const draft = draftFor(task); draft[field] = byId(id).value; markDirty(draft); }
    });
    byId("reload-task").addEventListener("click", () => {
        const task = selectedTask();
        if (!task || state.operations.has(`task:${task.id}`)) return;
        if (state.drafts.get(task.id)?.dirty && !window.confirm("重新载入会清除这条任务尚未提交的修改。继续吗？")) return;
        state.drafts.delete(task.id); state.lastRenderKey = null;
        renderSelectedTask(task, true);
    });
    byId("reject-button").addEventListener("click", () => openReject());
    byId("reject-form").addEventListener("submit", rejectTask);
    byId("reject-cancel").addEventListener("click", () => closeDialog("reject-dialog"));
    byId("duplicate-checkbox").addEventListener("change", () => { byId("duplicate-confirm").disabled = !byId("duplicate-checkbox").checked; });
    byId("duplicate-cancel").addEventListener("click", () => closeDialog("duplicate-dialog"));
    byId("duplicate-confirm").addEventListener("click", () => { if (byId("duplicate-checkbox").checked && state.duplicate) void confirmTask(true, state.duplicate); });
    for (const id of ["open-upload", "review-upload", "empty-upload"]) byId(id).addEventListener("click", openUpload);
    for (const id of ["close-upload", "cancel-upload"]) byId(id).addEventListener("click", () => closeDialog("upload-dialog"));
    byId("upload-files").addEventListener("change", showFiles);
    byId("upload-form").addEventListener("submit", upload);
    const drop = byId("file-drop");
    for (const name of ["dragenter", "dragover"]) drop.addEventListener(name, (event) => {
        event.preventDefault(); if (!state.operations.has("upload")) drop.classList.add("dragover");
    });
    for (const name of ["dragleave", "drop"]) drop.addEventListener(name, () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", (event) => {
        event.preventDefault();
        if (state.operations.has("upload")) return;
        if (event.dataTransfer?.files) { byId("upload-files").files = event.dataTransfer.files; showFiles(); }
    });
    for (const dialog of document.querySelectorAll("dialog")) {
        dialog.addEventListener("cancel", (event) => {
            const taskId = dialog.id === "reject-dialog" ? state.rejectTarget?.id : dialog.id === "duplicate-dialog" ? state.duplicate?.taskId : state.confirmTarget?.taskId;
            if ((dialog.id === "upload-dialog" && state.operations.has("upload")) || (taskId && state.operations.has(`task:${taskId}`))) event.preventDefault();
        });
        dialog.addEventListener("close", () => {
            const target = state.dialogFocus.get(dialog.id);
            state.dialogFocus.delete(dialog.id);
            if (dialog.id === "confirm-dialog") state.confirmTarget = null;
            if (dialog.id === "reject-dialog") state.rejectTarget = null;
            if (dialog.id === "duplicate-dialog") state.duplicate = null;
            if (dialog.id === "order-history-dialog") state.historyGeneration += 1;
            if (target?.isConnected && !target.disabled && !document.querySelector("dialog[open]") && state.token) target.focus();
        });
    }
    for (const id of ["history-close", "history-done"]) byId(id).addEventListener("click", () => closeDialog("order-history-dialog"));
    byId("export-button").addEventListener("click", exportOrders);
    byId("download-button").addEventListener("click", downloadExport);
    document.addEventListener("keydown", trapDialogFocus, true);
    document.addEventListener("keydown", (event) => {
        if (document.querySelector("dialog[open]") || !state.token) return;
        const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName);
        if (state.view === "review" && state.reviewDetail && event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault(); navigateTask(event.key === "ArrowUp" ? -1 : 1);
        } else if (state.view === "review" && state.reviewDetail && event.key === "Escape" && !editing) {
            event.preventDefault(); showQueue();
        } else if (event.key === "/" && !editing && ["review", "orders"].includes(state.view)) {
            event.preventDefault();
            if (state.view === "review") showQueue();
            byId(state.view === "review" ? "queue-search" : "order-search").focus();
        }
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.token) void refresh(true); });
    window.addEventListener("beforeunload", (event) => {
        if (hasUnsavedWork() || state.operations.has("upload") || Array.from(state.operations).some((key) => key.startsWith("task:"))) {
            event.preventDefault(); event.returnValue = "";
        }
    });
    const stored = readToken();
    if (stored) void login(stored);
})();
