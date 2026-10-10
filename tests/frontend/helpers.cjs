"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "../..");
const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "synthetic-dom-access-token";
const TOKEN_KEY = "ocrs_access_token";
const copy = (value) => structuredClone(value);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
});
const image = (mime = "image/png") => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "Content-Type": mime },
});
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function makeEvent(overrides = {}) {
    return {
        action: "create",
        target_order_id: null,
        expected_order_version: null,
        customer: "Synthetic Customer Alpha",
        external_id: null,
        currency: "CNY",
        occurred_at: null,
        reason: null,
        items: [{
            line_id: null,
            sku: "DEMO-001",
            name: "Synthetic Item",
            quantity: "2.5",
            unit: "box",
            unit_price: "12.50",
        }],
        evidence: [{ source_id: "source-1", field: "customer", text: "Synthetic Customer Alpha" }],
        warnings: ["Synthetic warning"],
        missing_reasons: ["Business date is unknown"],
        ...overrides,
    };
}

function makeTask(overrides = {}) {
    return {
        id: "task-1",
        status: "review_required",
        version: 1,
        attempts: 1,
        provider: "demo",
        created_at: "2026-10-09T00:00:00Z",
        sources: [{ id: "source-1", filename: "synthetic-alpha.png", source_label: "synthetic-manual", mime: "image/png", url: "/api/sources/source-1" }],
        candidate: { schema_version: "1", events: [makeEvent()], warnings: [], missing_reasons: [] },
        ...overrides,
    };
}

function makeOrder(overrides = {}) {
    return { ...makeEvent(), id: "order-1", status: "active", version: 1, ...overrides };
}

async function flush() {
    // Yield only to queued work, never to a real polling or network timer.
    for (let index = 0; index < 8; index += 1)
        await new Promise((resolve) => setImmediate(resolve));
}

function setup(t, options = {}) {
    const errors = [];
    const console = new VirtualConsole();
    console.on("jsdomError", (error) => errors.push(error));
    const dom = new JSDOM(readFileSync(path.join(ROOT, "src/ocrs/static/index.html"), "utf8"), {
        url: ORIGIN,
        runScripts: "outside-only",
        pretendToBeVisual: true,
        virtualConsole: console,
    });
    const { window } = dom;
    const { document } = window;
    const requests = [];
    const hooks = [];
    const unexpectedRoutes = [];
    const revoked = [];
    const created = [];
    const timers = new Map();
    let nextTimer = 0;
    let nextBlob = 0;
    const server = {
        token: TOKEN,
        tasks: copy(options.tasks ?? [makeTask()]),
        orders: copy(options.orders ?? []),
        exportStatus: "none",
        unauthorized: false,
        config: {
            provider: "demo",
            version: "0.2.1",
            schema_version: 1,
            recognition_mode: "demo",
            model_configured: false,
            inbox_enabled: true,
            sku_catalog: ["DEMO-001"],
            supported_currencies: ["CNY", "USD", "EUR", "GBP", "JPY"],
            external_transmission_enabled: false,
            evidence_days: 30,
            max_upload_bytes: 10485760,
            max_upload_files: 8,
            deployment_mode: "single-user-local",
            backup_mode: "offline-cli",
        },
        modelSettings: { revision: 0, provider: "demo", model: "", base_url: "", api_key_configured: false, allow_external: false, status: "demo", test_status: "not_tested" },
        status: {
            provider: "demo",
            inbox_enabled: true,
            inbox: { imported: 1, pending: 1, skipped: 0, errors: [{ filename: "synthetic-invalid.png", code: "image_invalid" }] },
            sku_catalog: ["DEMO-001"],
        },
    };

    window.setTimeout = (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, { callback, delay });
        return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    window.URL.createObjectURL = (blob) => {
        const url = `blob:${ORIGIN}/synthetic-${++nextBlob}`;
        created.push({ url, blob });
        return url;
    };
    window.URL.revokeObjectURL = (url) => revoked.push(url);
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new window.Event("close"));
    };
    window.confirm = () => true;
    // Download clicks are recorded without asking jsdom to perform browser navigation.
    const downloads = [];
    window.HTMLAnchorElement.prototype.click = function () {
        downloads.push({ href: this.href, download: this.download, target: this.target, rel: this.rel });
    };
    window.fetch = async (url, fetchOptions = {}) => {
        const parsed = new URL(String(url));
        const entry = { url: parsed, path: parsed.pathname, method: fetchOptions.method || "GET", options: fetchOptions };
        requests.push(entry);
        // Failing here exposes a security regression instead of silently mocking it away.
        assert.equal(parsed.origin, ORIGIN, "A bearer request escaped the local origin");
        assert.ok(parsed.pathname.startsWith("/api/"), "A bearer request escaped /api/");
        assert.equal(parsed.username, "");
        assert.equal(parsed.password, "");
        assert.equal(fetchOptions.redirect, "error", "Authenticated requests must reject redirects");
        assert.equal(fetchOptions.cache, "no-store");
        assert.equal(fetchOptions.credentials, "same-origin");
        assert.ok(!parsed.href.includes(server.token), "The token must never enter a URL");
        const hookIndex = hooks.findIndex((hook) => hook.path === entry.path && (!hook.method || hook.method === entry.method));
        if (hookIndex !== -1) {
            const hook = hooks[hookIndex];
            if (hook.once) hooks.splice(hookIndex, 1);
            return hook.handler(entry);
        }
        if (server.unauthorized || fetchOptions.headers.Authorization !== `Bearer ${server.token}`)
            return json({ error: { code: "UNAUTHORIZED" } }, 401);
        if (entry.path === "/api/status")
            return json({ ...copy(server.status), counts: Object.fromEntries(
                ["received", "recognizing", "review_required", "confirmed", "failed", "rejected"].map((status) => [status, server.tasks.filter((task) => task.status === status).length]),
            ), export: { status: server.exportStatus } });
        if (entry.path === "/api/tasks") {
            const status = parsed.searchParams.get("status");
            const query = (parsed.searchParams.get("q") || "").toLowerCase();
            const limit = Number(parsed.searchParams.get("limit") || 100);
            const offset = Number(parsed.searchParams.get("offset") || 0);
            const filtered = server.tasks.filter((task) => (
                !status || (status === "processing"
                    ? ["received", "queued", "recognizing", "processing"].includes(task.status)
                    : task.status === status)
            ) && [task.id, ...(task.sources || []).flatMap((source) => [source.filename, source.source_label])]
                .some((value) => String(value || "").toLowerCase().includes(query)));
            return json({ tasks: copy(filtered.slice(offset, offset + limit)), total: filtered.length, limit, offset, has_more: offset + limit < filtered.length });
        }
        if (/^\/api\/tasks\/[^/]+$/.test(entry.path)) {
            const task = server.tasks.find((item) => item.id === decodeURIComponent(entry.path.split("/").at(-1)));
            return task ? json(copy(task)) : json({ error: { code: "TASK_NOT_FOUND" } }, 404);
        }
        if (entry.path === "/api/orders") return json({ orders: copy(server.orders) });
        if (entry.path === "/api/model-settings") {
            if (entry.method === "PUT") {
                const body = JSON.parse(fetchOptions.body);
                const key = body.api_key_action === "replace" || (body.api_key_action === "keep" && server.modelSettings.api_key_configured);
                server.modelSettings = { revision: server.modelSettings.revision + 1, provider: body.provider, model: body.model, base_url: body.base_url, api_key_configured: key, allow_external: body.allow_external, status: body.provider === "demo" ? "demo" : key ? "configured" : "not_configured", test_status: "not_tested", timeout_seconds: body.timeout_seconds, total_timeout_seconds: body.total_timeout_seconds, max_output_tokens: body.max_output_tokens, max_requests: body.max_requests };
            }
            return json(copy(server.modelSettings));
        }
        if (entry.path === "/api/model-settings/test") {
            server.modelSettings.test_status = "passed";
            return json(copy(server.modelSettings));
        }
        if (entry.path === "/api/config") return json(copy(server.config));
        if (/^\/api\/sources\//.test(entry.path)) return image();
        if (/^\/api\/orders\/[^/]+\/history$/.test(entry.path))
            return json({ events: [{ id: "event-1", action: "create", actor: "Synthetic reviewer", reason: "Synthetic verification", created_at: "2026-10-09T00:00:00Z", version: 1 }] });
        if (entry.path === "/api/uploads") return json({ tasks: copy(server.tasks), duplicates: [] });
        const taskRoute = entry.path.match(/^\/api\/tasks\/([^/]+)\/(confirm|retry|reject)$/);
        if (taskRoute) {
            const task = server.tasks.find((item) => item.id === decodeURIComponent(taskRoute[1]));
            assert.ok(task, "Mutation targeted a fixture task that does not exist");
            const body = JSON.parse(fetchOptions.body);
            if (taskRoute[2] === "confirm") {
                task.status = "confirmed";
                task.version += 1;
                server.orders.push(makeOrder({ ...body.events[0], id: `order-${server.orders.length + 1}` }));
                return json({ orders: [server.orders.at(-1).id] });
            }
            task.status = taskRoute[2] === "reject" ? "rejected" : "review_required";
            task.version += 1;
            return json(copy(task));
        }
        if (entry.path === "/api/export") {
            server.exportStatus = "completed";
            return json({ status: "completed" });
        }
        if (entry.path === "/api/export/download")
            return new Response(new Uint8Array([0x50, 0x4b]), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
        unexpectedRoutes.push(`${entry.method} ${entry.path}`);
        throw new Error(`Unmocked request: ${entry.method} ${entry.path}`);
    };

    const id = (name) => {
        const node = document.getElementById(name);
        assert.ok(node, `Missing DOM contract #${name}`);
        return node;
    };
    const dispatch = (node, event) => node.dispatchEvent(new window.Event(event, { bubbles: true, cancelable: true }));
    const fill = (node, value) => {
        node.value = value;
        dispatch(node, node.tagName === "SELECT" ? "change" : "input");
    };
    const click = async (name) => { id(name).click(); await flush(); };
    const submit = async (name) => { dispatch(id(name), "submit"); await flush(); };
    const field = (text) => {
        const label = [...document.querySelectorAll("#editor-content label")].find((label) => label.firstChild?.textContent === text);
        assert.ok(label, `Missing review field ${text}`);
        return label.querySelector("input, select, textarea");
    };
    const on = (route, handler, { once = true, method } = {}) => hooks.push({ path: route, handler, once, method });
    const calls = (route) => requests.filter((entry) => entry.path === route);
    const login = async (token = TOKEN) => {
        fill(id("access-token"), token);
        await submit("login-form");
    };
    const select = async (taskId = "task-1") => {
        await click("nav-review");
        const task = server.tasks.find((task) => task.id === taskId);
        const buttons = [...document.querySelectorAll("#task-list .task-card")];
        const target = buttons.find((node) => node.dataset.taskId === taskId)
            || buttons.find((node) => node.textContent.includes(task?.candidate?.events?.[0]?.customer || task?.sources?.[0]?.filename));
        assert.ok(target, `Missing task row ${taskId}`);
        target.click();
        await flush();
    };
    const reviewer = () => {
        fill(id("review-actor"), "Synthetic reviewer");
        fill(id("review-reason"), "Synthetic verification");
    };
    const confirm = async () => {
        await submit("review-form");
        assert.equal(id("confirm-dialog").open, true);
        await click("confirm-submit");
    };
    const files = (names = ["synthetic-upload.png"]) => {
        const value = names.map((name) => new window.File(["synthetic image content"], name, { type: "image/png" }));
        Object.defineProperty(id("upload-files"), "files", { value, configurable: true });
        dispatch(id("upload-files"), "change");
        return value;
    };
    const runTimers = async (delay) => {
        for (const [timerId, timer] of [...timers.entries()]) {
            if (timer.delay === delay) {
                timers.delete(timerId);
                timer.callback();
            }
        }
        await flush();
    };
    t.after(() => {
        dom.window.close();
        assert.deepEqual(errors.map((error) => error.message), [], "Unexpected jsdom application exception");
        assert.deepEqual(unexpectedRoutes, [], "Application requested a route missing from the fixture contract");
        for (const request of requests) {
            assert.equal(request.url.origin, ORIGIN, "A bearer request escaped the local origin");
            assert.ok(request.path.startsWith("/api/"), "A bearer request escaped /api/");
            assert.equal(request.url.username, "");
            assert.equal(request.url.password, "");
            assert.equal(request.options.redirect, "error");
            assert.equal(request.options.cache, "no-store");
            assert.equal(request.options.credentials, "same-origin");
            assert.ok(!request.url.href.includes(TOKEN), "Token leaked into URL");
        }
    });
    if (options.storedToken) window.sessionStorage.setItem(TOKEN_KEY, options.storedToken);
    window.eval(readFileSync(path.join(ROOT, "src/ocrs/static/app.js"), "utf8"));
    return { window, document, server, requests, revoked, created, downloads, timers, runTimers, id, dispatch, fill, click, submit, field, on, calls, login, select, reviewer, confirm, files };
}

module.exports = { setup, makeTask, makeEvent, makeOrder, json, image, deferred, flush, TOKEN, TOKEN_KEY, ORIGIN };
