"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, makeTask, makeEvent, makeOrder, json, deferred, flush } = require("./helpers.cjs");

test("closing and reopening an upload dialog keeps chosen files and source label", async (t) => {
    const app = setup(t, { tasks: [] });
    await app.login();
    await app.click("open-upload");
    const files = app.files(["synthetic-one.png", "synthetic-two.png"]);
    app.fill(app.id("source-label"), "synthetic-batch-one");
    await app.click("close-upload");
    assert.equal(app.id("upload-dialog").open, false);
    await app.click("open-upload");
    assert.equal(app.id("source-label").value, "synthetic-batch-one");
    assert.equal(app.id("upload-files").files[0], files[0]);
    assert.match(app.id("selected-files").textContent, /synthetic-one.png/);
    assert.equal(app.calls("/api/uploads").length, 0);
    await app.submit("upload-form");
    assert.equal(app.calls("/api/uploads").length, 1);
    const form = app.calls("/api/uploads")[0].options.body;
    assert.equal(form.get("source_label"), "synthetic-batch-one");
    assert.deepEqual(form.getAll("files").map((file) => file.name), ["synthetic-one.png", "synthetic-two.png"]);
    assert.equal(app.calls("/api/uploads")[0].options.headers["Content-Type"], undefined);
    assert.equal(app.id("upload-dialog").open, false);
});

test("in-flight uploads are single-flight and cannot dismiss or change their source", async (t) => {
    const app = setup(t);
    await app.login();
    await app.click("open-upload");
    app.files();
    const pending = deferred();
    app.on("/api/uploads", () => pending.promise);
    app.dispatch(app.id("upload-form"), "submit");
    app.dispatch(app.id("upload-form"), "submit");
    await flush();
    assert.equal(app.calls("/api/uploads").length, 1);
    for (const name of ["upload-submit", "upload-files", "source-label", "close-upload", "cancel-upload"])
        assert.equal(app.id(name).disabled, true, `#${name} was not locked during upload`);
    const cancel = new app.window.Event("cancel", { cancelable: true });
    app.id("upload-dialog").dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    app.id("close-upload").click();
    assert.equal(app.id("upload-dialog").open, true);
    pending.resolve(json({ tasks: app.server.tasks, duplicates: ["task-1"] }));
    await flush();
    assert.equal(app.id("upload-dialog").open, false);
    assert.match(app.id("notice").textContent, /未重复导入/);
    for (const name of ["upload-submit", "upload-files", "source-label", "close-upload", "cancel-upload"])
        assert.equal(app.id(name).disabled, false);
});

test("an unknown upload result keeps the draft and explains safe same-source retry", async (t) => {
    const app = setup(t);
    await app.login();
    await app.click("open-upload");
    const files = app.files();
    app.fill(app.id("source-label"), "synthetic-stable-source");
    app.on("/api/uploads", () => { throw new TypeError("Synthetic lost response"); });
    await app.submit("upload-form");
    assert.equal(app.id("upload-dialog").open, true);
    assert.equal(app.id("upload-error").hidden, false);
    assert.match(app.id("upload-error").textContent, /结果|可能已|核对/);
    assert.equal(app.id("source-label").value, "synthetic-stable-source");
    assert.equal(app.id("upload-files").files[0], files[0]);
    await app.click("close-upload");
    await app.click("open-upload");
    assert.equal(app.id("source-label").value, "synthetic-stable-source");
    app.on("/api/uploads", () => json({ tasks: app.server.tasks, duplicates: ["task-1"] }));
    await app.submit("upload-form");
    const attempts = app.calls("/api/uploads");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].options.body.get("source_label"), attempts[1].options.body.get("source_label"));
    assert.equal(attempts[0].options.body.get("files").name, attempts[1].options.body.get("files").name);
    assert.match(app.id("notice").textContent, /未重复导入/);
});

test("late upload responses cannot close, clear or unlock a new session's pending upload", async (t) => {
    const app = setup(t);
    await app.login();
    await app.click("open-upload");
    app.files(["synthetic-old-upload.png"]);
    const oldBody = deferred();
    app.on("/api/uploads", () => ({ ok: true, status: 200, json: () => oldBody.promise }));
    app.dispatch(app.id("upload-form"), "submit");
    await flush();
    await app.click("logout-button");
    await app.login();
    await app.click("open-upload");
    app.files(["synthetic-new-upload.png"]);
    app.fill(app.id("source-label"), "synthetic-new-source");
    const current = deferred();
    app.on("/api/uploads", () => current.promise);
    app.dispatch(app.id("upload-form"), "submit");
    await flush();
    oldBody.resolve({ tasks: [], duplicates: [] });
    await flush();
    assert.equal(app.id("upload-dialog").open, true);
    assert.equal(app.id("source-label").value, "synthetic-new-source");
    assert.equal(app.id("upload-submit").disabled, true);
    app.dispatch(app.id("upload-form"), "submit");
    assert.equal(app.calls("/api/uploads").length, 2);
    current.resolve(json({ tasks: app.server.tasks, duplicates: [] }));
    await flush();
    assert.equal(app.id("upload-dialog").open, false);
});

test("navigation exposes one section at a time and queue search combines with status filtering", async (t) => {
    const beta = makeTask({ id: "task-2", status: "failed", candidate: { schema_version: "1", events: [makeEvent({ customer: "Synthetic Customer Beta" })], warnings: [], missing_reasons: [] }, sources: [{ id: "source-beta", filename: "synthetic-beta.png", source_label: "synthetic-beta-source", url: "/api/sources/source-beta" }] });
    const app = setup(t, { tasks: [makeTask(), beta] });
    await app.login();
    for (const view of ["dashboard", "review", "orders", "exports", "settings"]) {
        await app.click(`nav-${view}`);
        for (const other of ["dashboard", "review", "orders", "exports", "settings"])
            assert.equal(app.id(`${other}-view`).hidden, view !== other);
        assert.equal(app.id(`nav-${view}`).getAttribute("aria-current"), "page");
    }
    await app.click("nav-review");
    app.fill(app.id("queue-filter"), "all");
    await flush();
    app.fill(app.id("queue-search"), "beta");
    await app.runTimers(250);
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 1);
    assert.match(app.id("task-list").textContent, /Beta/);
    app.fill(app.id("queue-filter"), "review_required");
    await flush();
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 0);
    app.fill(app.id("queue-search"), "");
    await app.runTimers(250);
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 1);
    app.fill(app.id("queue-filter"), "all");
    await flush();
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 2);
});

test("previous/next review and image zoom controls keep task and source state consistent", async (t) => {
    const beta = makeTask({ id: "task-2", candidate: { schema_version: "1", events: [makeEvent({ customer: "Synthetic Customer Beta" })], warnings: [], missing_reasons: [] }, sources: [{ id: "source-2", filename: "synthetic-beta.png", url: "/api/sources/source-2" }] });
    const app = setup(t, { tasks: [makeTask(), beta] });
    await app.login();
    await app.select();
    assert.equal(app.id("previous-task").disabled, true);
    assert.equal(app.id("next-task").disabled, false);
    const initial = app.id("zoom-value").textContent;
    await app.click("zoom-in");
    assert.notEqual(app.id("zoom-value").textContent, initial);
    await app.click("zoom-out");
    assert.equal(app.id("zoom-value").textContent, initial);
    await app.click("zoom-in");
    await app.click("zoom-fit");
    assert.equal(app.id("zoom-value").textContent, initial);
    await app.click("next-task");
    assert.equal(app.field("客户").value, "Synthetic Customer Beta");
    assert.equal(app.id("next-task").disabled, true);
    assert.equal(app.id("previous-task").disabled, false);
    assert.match(app.document.querySelector("#source-list img").alt, /synthetic-beta/);
    await app.click("previous-task");
    assert.equal(app.field("客户").value, "Synthetic Customer Alpha");
    await app.click("back-to-queue");
    assert.equal(app.id("task-workspace").hidden, true);
    assert.equal(app.id("queue-panel").hidden, false);
});

test("orders search and status filters do not mutate confirmed business records", async (t) => {
    const orders = [makeOrder(), makeOrder({ id: "order-2", customer: "Synthetic Customer Beta", status: "cancelled" })];
    const app = setup(t, { orders });
    await app.login();
    await app.click("nav-orders");
    const before = structuredClone(app.server.orders);
    app.fill(app.id("order-search"), "beta");
    assert.match(app.id("orders-content").textContent, /Beta/);
    assert.doesNotMatch(app.id("orders-content").textContent, /Alpha/);
    app.fill(app.id("order-filter"), "confirmed");
    assert.doesNotMatch(app.id("orders-content").textContent, /Beta/);
    app.fill(app.id("order-search"), "");
    assert.match(app.id("orders-content").textContent, /Alpha/);
    app.fill(app.id("order-filter"), "cancelled");
    assert.match(app.id("orders-content").textContent, /Beta/);
    assert.deepEqual(app.server.orders, before);
    assert.equal(app.requests.filter((request) => request.method !== "GET").length, 0);
});

test("settings display authenticated read-only diagnostics without claiming a provider connection test", async (t) => {
    const app = setup(t);
    await app.login();
    await app.click("nav-settings");
    assert.ok(app.calls("/api/config").length > 0);
    assert.equal(app.id("settings-view").hidden, false);
    assert.ok(app.id("settings-config").textContent.trim().length > 0);
    assert.equal(app.id("settings-config").querySelectorAll("input, textarea, select").length, 0);
    assert.doesNotMatch(app.id("settings-config").textContent, /连接测试通过|连接已验证|API.*验证通过/);
    assert.equal(app.requests.filter((request) => request.path === "/api/config" && request.method !== "GET").length, 0);
    assert.doesNotMatch(app.id("settings-config").textContent, /synthetic-dom-access-token/);
});

test("export locks repeated generation, enables download only when ready, and uses protected blobs", async (t) => {
    const app = setup(t, { orders: [makeOrder()] });
    await app.login();
    await app.click("nav-exports");
    assert.equal(app.id("download-button").disabled, true);
    const pending = deferred();
    app.on("/api/export", () => pending.promise);
    app.id("export-button").click();
    app.id("export-button").click();
    await flush();
    assert.equal(app.calls("/api/export").length, 1);
    assert.equal(app.id("export-button").disabled, true);
    app.server.exportStatus = "completed";
    pending.resolve(json({ status: "completed" }));
    await flush();
    assert.equal(app.id("download-button").disabled, false);
    await app.click("download-button");
    assert.equal(app.calls("/api/export/download").length, 1);
    assert.equal(app.downloads.length, 1);
    assert.match(app.downloads[0].href, /^blob:/);
    assert.match(app.downloads[0].download, /\.xlsx$/);
    assert.ok(app.calls("/api/export/download")[0].options.headers.Authorization);
});

test("upload timeouts abort the request, retain the source, and keep the outcome explicitly unknown", async (t) => {
    const app = setup(t);
    await app.login();
    await app.click("open-upload");
    app.files();
    app.fill(app.id("source-label"), "synthetic-timeout-source");
    app.on("/api/uploads", ({ options }) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new app.window.DOMException("Synthetic abort", "AbortError")), { once: true });
    }));
    app.dispatch(app.id("upload-form"), "submit");
    await flush();
    await app.runTimers(60000);
    assert.equal(app.calls("/api/uploads")[0].options.signal.aborted, true);
    assert.equal(app.id("upload-dialog").open, true);
    assert.equal(app.id("source-label").value, "synthetic-timeout-source");
    assert.equal(app.id("upload-submit").disabled, false);
    assert.match(app.id("upload-error").textContent, /结果|可能已|核对/);
    assert.match(app.id("upload-error").textContent, /REQUEST_TIMEOUT/);
});

test("server pagination shows true totals and a new search resets the page offset", async (t) => {
    const tasks = Array.from({ length: 60 }, (_, index) => makeTask({
        id: `task-page-${index + 1}`,
        sources: [{ id: `source-page-${index + 1}`, filename: `synthetic-${index + 1}.png`, source_label: index === 59 ? "synthetic-last-source" : "synthetic-page-source", url: `/api/sources/source-page-${index + 1}` }],
    }));
    const app = setup(t, { tasks });
    await app.login();
    await app.click("nav-review");
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 50);
    assert.match(app.id("queue-count").textContent, /60/);
    assert.equal(app.id("queue-previous-page").disabled, true);
    assert.equal(app.id("queue-next-page").disabled, false);
    await app.click("queue-next-page");
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 10);
    assert.equal(app.id("queue-next-page").disabled, true);
    assert.equal(app.id("queue-previous-page").disabled, false);
    assert.equal(app.calls("/api/tasks").at(-1).url.searchParams.get("offset"), "50");
    app.fill(app.id("queue-search"), "synthetic-last-source");
    await app.runTimers(250);
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 1);
    assert.equal(app.document.querySelector("#task-list .task-card").dataset.taskId, "task-page-60");
    assert.equal(app.calls("/api/tasks").at(-1).url.searchParams.get("offset"), "0");
    assert.equal(app.id("queue-previous-page").disabled, true);
    assert.equal(app.id("queue-next-page").disabled, true);
});

test("a delayed older search cannot publish results over a newer query", async (t) => {
    const app = setup(t, { tasks: [] });
    await app.login();
    await app.click("nav-review");
    const alpha = makeTask({ sources: [{ id: "source-alpha", filename: "synthetic-alpha.png", url: "/api/sources/source-alpha" }] });
    const beta = makeTask({ id: "task-2", candidate: { schema_version: "1", events: [makeEvent({ customer: "Synthetic Customer Beta" })], warnings: [], missing_reasons: [] }, sources: [{ id: "source-beta", filename: "synthetic-beta.png", url: "/api/sources/source-beta" }] });
    app.server.tasks = [alpha, beta];
    const oldResult = deferred();
    const newResult = deferred();
    app.on("/api/tasks", () => oldResult.promise);
    app.fill(app.id("queue-search"), "alpha");
    await app.runTimers(250);
    app.on("/api/tasks", () => newResult.promise);
    app.fill(app.id("queue-search"), "beta");
    await app.runTimers(250);
    oldResult.resolve(json({ tasks: [alpha], total: 1, limit: 50, offset: 0, has_more: false }));
    await flush();
    assert.equal(app.id("queue-search").value, "beta");
    assert.doesNotMatch(app.id("task-list").textContent, /Synthetic Customer Alpha/);
    newResult.resolve(json({ tasks: [beta], total: 1, limit: 50, offset: 0, has_more: false }));
    await flush();
    assert.equal(app.document.querySelectorAll("#task-list .task-card").length, 1);
    assert.match(app.id("task-list").textContent, /Synthetic Customer Beta/);
    assert.doesNotMatch(app.id("task-list").textContent, /Synthetic Customer Alpha/);
});

function mockDialogLayout(app, dialogId) {
    // jsdom has no layout. Supply rectangles only for testing explicit focus
    // boundaries; real visibility and native Tab traversal remain E2E checks.
    for (const node of app.id(dialogId).querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]")) {
        node.getClientRects = () => [{ width: 100, height: 30 }];
    }
}

function keydown(app, node, options = {}) {
    const event = new app.window.KeyboardEvent("keydown", {
        key: "Tab", bubbles: true, cancelable: true, ...options,
    });
    node.dispatchEvent(event);
    return event;
}

const dialogCases = [
    {
        name: "upload", dialog: "upload-dialog", first: "close-upload", last: "upload-submit",
        open: (app) => app.click("open-upload"),
    },
    {
        name: "confirmation", dialog: "confirm-dialog", first: "confirm-cancel", last: "confirm-submit",
        open: async (app) => { await app.select(); app.reviewer(); await app.submit("review-form"); },
    },
    {
        name: "rejection", dialog: "reject-dialog", first: "reject-reason", last: "reject-submit",
        open: async (app) => { await app.select(); await app.click("reject-button"); },
    },
    {
        name: "duplicate warning", dialog: "duplicate-dialog", first: "duplicate-checkbox", last: "duplicate-cancel",
        open: async (app) => {
            await app.select();
            app.reviewer();
            app.on("/api/tasks/task-1/confirm", () => json({ error: { code: "DUPLICATE_WARNING", details: { order_ids: ["synthetic-existing-order"] } } }, 409));
            await app.confirm();
        },
    },
    {
        name: "order history", dialog: "order-history-dialog", first: "history-close", last: "history-done",
        open: async (app) => {
            await app.click("nav-orders");
            app.document.querySelector("#orders-content .order-open").click();
            await flush();
        },
    },
];

for (const scenario of dialogCases) {
    test(`${scenario.name} dialog keeps Tab and Shift+Tab inside its enabled first/last controls`, async (t) => {
        const app = setup(t, { orders: [makeOrder()] });
        await app.login();
        await scenario.open(app);
        mockDialogLayout(app, scenario.dialog);
        assert.equal(app.id(scenario.dialog).open, true);
        const first = app.id(scenario.first);
        const last = app.id(scenario.last);
        last.focus();
        assert.equal(app.document.activeElement, last);
        assert.equal(keydown(app, last).defaultPrevented, true);
        assert.equal(app.document.activeElement, first);
        assert.equal(keydown(app, first, { shiftKey: true }).defaultPrevented, true);
        assert.equal(app.document.activeElement, last);
        // Recover focus if a programmatic action or browser transition put it outside.
        app.id("refresh-button").focus();
        assert.equal(keydown(app, app.id("refresh-button")).defaultPrevented, true);
        assert.equal(app.document.activeElement, first);
        app.id("refresh-button").focus();
        assert.equal(keydown(app, app.id("refresh-button"), { shiftKey: true }).defaultPrevented, true);
        assert.equal(app.document.activeElement, last);
        if (scenario.name === "duplicate warning") {
            assert.equal(app.id("duplicate-confirm").disabled, true);
            app.id("duplicate-checkbox").checked = true;
            app.dispatch(app.id("duplicate-checkbox"), "change");
            app.id("duplicate-confirm").focus();
            assert.equal(keydown(app, app.id("duplicate-confirm")).defaultPrevented, true);
            assert.equal(app.document.activeElement, first);
            assert.equal(keydown(app, first, { shiftKey: true }).defaultPrevented, true);
            assert.equal(app.document.activeElement, app.id("duplicate-confirm"));
        }
    });
}

test("dialog focus excludes hidden/disabled controls and leaves ordinary keys and interior Tab untouched", async (t) => {
    const app = setup(t);
    await app.login();
    await app.click("open-upload");
    const dialog = app.id("upload-dialog");
    for (const kind of ["hidden", "disabled", "inert", "invisible", "no-layout"]) {
        const node = app.document.createElement("button");
        node.textContent = `Synthetic ${kind} control`;
        if (kind === "hidden") node.hidden = true;
        if (kind === "disabled") node.disabled = true;
        if (kind === "inert") node.setAttribute("inert", "");
        if (kind === "invisible") node.style.visibility = "hidden";
        node.getClientRects = () => kind === "no-layout" ? [] : [{ width: 100, height: 30 }];
        dialog.prepend(node);
        dialog.append(node.cloneNode(true));
        dialog.lastChild.getClientRects = node.getClientRects;
    }
    for (const id of ["close-upload", "upload-files", "source-label", "cancel-upload", "upload-submit"])
        app.id(id).getClientRects = () => [{ width: 100, height: 30 }];
    app.id("upload-submit").focus();
    assert.equal(keydown(app, app.id("upload-submit")).defaultPrevented, true);
    assert.equal(app.document.activeElement, app.id("close-upload"));
    assert.equal(keydown(app, app.id("close-upload"), { shiftKey: true }).defaultPrevented, true);
    assert.equal(app.document.activeElement, app.id("upload-submit"));
    app.id("source-label").focus();
    assert.equal(keydown(app, app.id("source-label")).defaultPrevented, false);
    assert.equal(app.document.activeElement, app.id("source-label"));
    for (const options of [{ key: "Escape" }, { key: "Enter" }, { isComposing: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
        app.id("upload-submit").focus();
        assert.equal(keydown(app, app.id("upload-submit"), options).defaultPrevented, false);
        assert.equal(app.document.activeElement, app.id("upload-submit"));
    }
});

test("an in-flight dialog with every control disabled retains focus on the dialog itself", async (t) => {
    const app = setup(t);
    await app.login();
    await app.click("open-upload");
    app.files();
    mockDialogLayout(app, "upload-dialog");
    const pending = deferred();
    app.on("/api/uploads", () => pending.promise);
    app.dispatch(app.id("upload-form"), "submit");
    await flush();
    const dialog = app.id("upload-dialog");
    assert.equal(dialog.getAttribute("tabindex"), "-1");
    app.id("refresh-button").focus();
    assert.equal(keydown(app, app.id("refresh-button")).defaultPrevented, true);
    assert.equal(app.document.activeElement, dialog);
    assert.equal(keydown(app, dialog, { shiftKey: true }).defaultPrevented, true);
    assert.equal(app.document.activeElement, dialog);
    pending.resolve(json({ tasks: app.server.tasks, duplicates: [] }));
    await flush();
    assert.equal(dialog.open, false);
});

function configureModel(app) {
    app.fill(app.id("model-provider"), "openai-compatible");
    app.fill(app.id("model-name"), "synthetic-vision-model");
    app.fill(app.id("model-base-url"), "https://models.example.com/v1");
    app.fill(app.id("model-key-action"), "replace");
    app.fill(app.id("model-api-key"), "synthetic-test-only-api-key");
    app.id("model-allow-external").checked = true;
    app.dispatch(app.id("model-allow-external"), "change");
}

async function settings(app) { await app.login(); await app.click("nav-settings"); }
const puts = (app) => app.calls("/api/model-settings").filter((call) => call.method === "PUT");

test("model settings save writes the key once and never tests or persists browser secrets", async (t) => {
    const app = setup(t);
    await settings(app);
    assert.match(app.id("model-settings-state").textContent, /Demo/);
    configureModel(app);
    await app.submit("model-settings-form");
    assert.equal(puts(app).length, 1);
    assert.deepEqual(JSON.parse(puts(app)[0].options.body), {
        expected_revision: 0, provider: "openai-compatible", model: "synthetic-vision-model",
        base_url: "https://models.example.com/v1", allow_external: true,
        api_key_action: "replace", api_key: "synthetic-test-only-api-key",
        timeout_seconds: 15, total_timeout_seconds: 45, max_output_tokens: 4096, max_requests: 100,
    });
    assert.equal(app.id("model-api-key").type, "password");
    assert.equal(app.id("model-api-key").value, "");
    assert.equal(app.calls("/api/model-settings/test").length, 0);
    assert.match(app.id("model-settings-state").textContent, /已配置.*未验证/);
    assert.doesNotMatch(app.document.body.textContent, /synthetic-test-only-api-key/);
    assert.equal(app.window.localStorage.length, 0);
    assert.equal(app.window.sessionStorage.length, 1); // Only the local access token.
    assert.equal(JSON.stringify(app.server.modelSettings).includes("synthetic-test-only-api-key"), false);
});

test("MiniMax fixes the China endpoint and model and explains text versus OCR capability", async (t) => {
    const app = setup(t); await settings(app);
    app.fill(app.id("model-provider"), "minimax-cn");
    assert.equal(app.id("model-base-url").value, "https://api.minimax.cn/v1");
    assert.equal(app.id("model-name").value, "MiniMax-M3");
    assert.equal(app.id("model-base-url").disabled, true);
    assert.equal(app.id("model-name").disabled, true);
    assert.match(app.id("model-capability-warning").textContent, /文本模型.*不等于.*OCR/);
});

test("blank keep, explicit replace, and explicit delete have different payloads", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    await app.submit("model-settings-form");
    await app.submit("model-settings-form");
    assert.equal(JSON.parse(puts(app)[1].options.body).api_key_action, "keep");
    assert.equal(Object.hasOwn(JSON.parse(puts(app)[1].options.body), "api_key"), false);
    app.fill(app.id("model-key-action"), "delete");
    await app.submit("model-settings-form");
    assert.equal(JSON.parse(puts(app)[2].options.body).api_key_action, "delete");
    assert.match(app.id("model-settings-state").textContent, /尚未配置完整/);
    assert.equal(app.id("model-test").disabled, true);
});

test("changing a saved endpoint or provider forbids keeping its credential", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    await app.submit("model-settings-form");
    app.fill(app.id("model-base-url"), "https://other.example.com/v1");
    assert.equal(app.id("model-key-action").value, "replace");
    assert.equal(app.id("model-key-action").querySelector('[value="keep"]').disabled, true);
    assert.match(app.id("model-key-status").textContent, /不能复用/);
    await app.submit("model-settings-form");
    assert.equal(puts(app).length, 1, "A fresh credential is required before save");
    app.fill(app.id("model-provider"), "minimax-cn");
    assert.equal(app.id("model-key-action").value, "replace");
    assert.equal(app.id("model-api-key").value, "");
});

test("failed save retains field and password only in the form and focuses safe error", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    app.on("/api/model-settings", () => json({ error: { code: "MODEL_SETTINGS_CONFLICT", message: "synthetic-do-not-display" } }, 409), { method: "PUT" });
    await app.submit("model-settings-form");
    assert.equal(app.id("model-api-key").value, "synthetic-test-only-api-key");
    assert.equal(app.id("model-name").value, "synthetic-vision-model");
    assert.equal(app.document.activeElement, app.id("model-settings-error"));
    assert.match(app.id("model-settings-error").textContent, /重新读取/);
    assert.doesNotMatch(app.document.body.textContent, /synthetic-do-not-display/);
    assert.equal(app.window.localStorage.length, 0);
    await app.click("logout-button");
    assert.equal(app.id("model-api-key").value, "");
    assert.equal(app.id("model-name").value, "");
});

test("dirty settings guard navigation and unload; cancelled departure retains password", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    app.window.confirm = () => false;
    await app.click("nav-dashboard");
    assert.equal(app.id("settings-view").hidden, false);
    assert.equal(app.id("model-api-key").value, "synthetic-test-only-api-key");
    const unload = new app.window.Event("beforeunload", { cancelable: true });
    app.window.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
    app.window.confirm = () => true;
    await app.click("nav-dashboard");
    assert.equal(app.id("settings-view").hidden, true);
    assert.equal(app.id("model-api-key").value, "");
    await app.click("nav-settings");
    assert.equal(app.id("model-provider").value, "demo");
});

test("failed settings refresh does not discard edits and repeated navigation does not reload them", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    await app.click("nav-settings");
    assert.equal(app.id("model-api-key").value, "synthetic-test-only-api-key");
    app.on("/api/model-settings", () => { throw new Error("offline"); }, { method: "GET" });
    await app.click("model-reset");
    assert.equal(app.id("model-api-key").value, "synthetic-test-only-api-key");
    assert.equal(app.id("model-provider").value, "openai-compatible");
    assert.equal(app.id("model-save").disabled, false);
});

test("test requires saved enabled configuration and separate destination and cost confirmation", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    assert.equal(app.id("model-test").disabled, true);
    await app.submit("model-settings-form");
    app.id("model-test").focus();
    await app.click("model-test");
    assert.equal(app.id("model-test-dialog").open, true);
    assert.equal(app.document.activeElement, app.id("model-test-cancel"));
    assert.match(app.id("model-test-dialog").textContent, /models.example.com/);
    assert.match(app.id("model-test-dialog").textContent, /虚构订单图片与候选 schema/);
    assert.match(app.id("model-test-dialog").textContent, /费用/);
    assert.equal(app.calls("/api/model-settings/test").length, 0);
    await app.click("model-test-cancel");
    assert.equal(app.document.activeElement, app.id("model-test"));
    assert.equal(app.calls("/api/model-settings/test").length, 0);
    await app.click("model-test"); await app.click("model-test-confirm");
    assert.equal(app.calls("/api/model-settings/test").length, 1);
    assert.deepEqual(JSON.parse(app.calls("/api/model-settings/test")[0].options.body), { expected_revision: 1, confirm_external: true });
    assert.match(app.id("model-settings-result").textContent, /测试成功/);
    app.id("model-allow-external").checked = false; app.dispatch(app.id("model-allow-external"), "change");
    await app.submit("model-settings-form");
    assert.equal(app.id("model-test").disabled, true);
    assert.doesNotMatch(app.id("model-settings-result").textContent, /测试成功/);
});

test("save and test are single-flight, cannot navigate mid-request, and late logout results are ignored", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    const pending = deferred();
    app.on("/api/model-settings", () => pending.promise, { method: "PUT" });
    await app.submit("model-settings-form"); await app.submit("model-settings-form");
    assert.equal(puts(app).length, 1);
    await app.click("nav-dashboard"); assert.equal(app.id("settings-view").hidden, false);
    await app.click("logout-button");
    pending.resolve(json({ ...app.server.modelSettings, provider: "openai-compatible", status: "configured" }));
    await flush();
    assert.equal(app.id("workspace").hidden, true);
    assert.equal(app.id("model-api-key").value, "");
    assert.equal(app.id("model-name").value, "");
});

test("external upload cancel sends nothing and acceptance binds destination consent to revision", async (t) => {
    const app = setup(t); await settings(app); configureModel(app); await app.submit("model-settings-form");
    await app.click("open-upload"); app.files();
    const prompts = []; app.window.confirm = (message) => { prompts.push(message); return false; };
    await app.submit("upload-form");
    assert.equal(app.calls("/api/uploads").length, 0);
    assert.match(prompts[0], /models.example.com.*synthetic-vision-model/);
    assert.match(prompts[0], /1 张完整截图/);
    app.window.confirm = () => true; await app.submit("upload-form");
    const body = app.calls("/api/uploads")[0].options.body;
    assert.equal(body.get("config_revision"), "1");
    assert.equal(body.get("confirm_external"), "true");
});

test("missing encryption key leaves settings editable and requires replace or delete recovery", async (t) => {
    const app = setup(t);
    app.server.modelSettings = { revision: 4, provider: "openai-compatible", model: "synthetic-model", base_url: "https://models.example.com/v1", api_key_configured: true, credential_status: "unavailable", allow_external: true, status: "not_configured", test_status: "not_tested" };
    await settings(app);
    assert.equal(app.id("model-provider").disabled, false);
    assert.match(app.id("model-key-status").textContent, /无法解密/);
    assert.equal(app.id("model-key-action").value, "replace");
    assert.equal(app.id("model-key-action").querySelector('[value="keep"]').disabled, true);
    assert.equal(app.id("model-test").disabled, true);
    app.fill(app.id("model-key-action"), "delete");
    await app.submit("model-settings-form");
    assert.equal(JSON.parse(puts(app)[0].options.body).api_key_action, "delete");
});

test("explicit test failure is not success, retries stay user initiated and single-flight", async (t) => {
    const app = setup(t); await settings(app); configureModel(app); await app.submit("model-settings-form");
    app.on("/api/model-settings/test", () => json({ ...app.server.modelSettings, test_status: "failed" }));
    await app.click("model-test"); await app.click("model-test-confirm");
    assert.match(app.id("model-settings-result").textContent, /测试失败/);
    assert.doesNotMatch(app.id("model-settings-result").textContent, /测试成功/);
    assert.equal(app.calls("/api/model-settings/test").length, 1);
    const pending = deferred(); app.on("/api/model-settings/test", () => pending.promise);
    await app.click("model-test"); await app.click("model-test-confirm"); await app.click("model-test-confirm");
    assert.equal(app.calls("/api/model-settings/test").length, 2);
    assert.equal(app.id("model-test-cancel").disabled, true);
    const cancel = new app.window.Event("cancel", { cancelable: true }); app.id("model-test-dialog").dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    pending.resolve(json({ error: { code: "MODEL_SETTINGS_CONFLICT" } }, 409)); await flush();
    assert.equal(app.document.activeElement, app.id("model-test-error"));
    assert.equal(app.id("model-test-confirm").disabled, false);
    assert.equal(app.id("model-test-dialog").open, true);
});

test("advanced limits are editable, transmitted as integers and retained after save", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    app.fill(app.id("model-timeout"), "30"); app.fill(app.id("model-total-timeout"), "90");
    app.fill(app.id("model-max-tokens"), "2048"); app.fill(app.id("model-max-requests"), "20");
    await app.submit("model-settings-form");
    const body = JSON.parse(puts(app)[0].options.body);
    assert.equal(body.timeout_seconds, 30); assert.equal(body.total_timeout_seconds, 90);
    assert.equal(body.max_output_tokens, 2048); assert.equal(body.max_requests, 20);
    assert.equal(app.id("model-timeout").value, "30"); assert.equal(app.id("model-max-requests").value, "20");
});

test("disabled external calls can be explicitly enabled with this batch, without losing files", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    app.id("model-allow-external").checked = false;
    await app.submit("model-settings-form");
    await app.click("open-upload"); const files = app.files();
    app.fill(app.id("source-label"), "synthetic-current-batch");
    const prompts = [];
    app.window.confirm = (message) => { prompts.push(message); return false; };
    await app.submit("upload-form");
    assert.equal(app.calls("/api/model-settings/enable-external").length, 0);
    assert.equal(app.calls("/api/uploads").length, 0);
    assert.equal(app.id("upload-files").files[0], files[0]);
    assert.match(prompts[0], /开启此外部模型调用.*1 张完整截图.*models.example.com.*synthetic-vision-model/);
    assert.match(prompts[0], /费用.*其他图片仍须另行确认.*旧队列/);
    app.window.confirm = (message) => { prompts.push(message); return true; };
    await app.submit("upload-form");
    assert.equal(prompts.length, 2, "only one confirmation per attempt");
    assert.deepEqual(JSON.parse(app.calls("/api/model-settings/enable-external")[0].options.body), { expected_revision: 1, confirm_external: true });
    const body = app.calls("/api/uploads")[0].options.body;
    assert.equal(body.get("config_revision"), "2");
    assert.equal(body.get("confirm_external"), "true");
    assert.equal(body.get("source_label"), "synthetic-current-batch");
    assert.equal(app.id("model-api-key").value, "");
});

test("a changed destination during in-place enable sends no image and retains draft", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    app.id("model-allow-external").checked = false; await app.submit("model-settings-form");
    await app.click("open-upload"); const files = app.files();
    app.on("/api/model-settings/enable-external", () => json({ error: { code: "MODEL_SETTINGS_CONFLICT" } }, 409));
    await app.submit("upload-form");
    assert.equal(app.calls("/api/uploads").length, 0);
    assert.equal(app.id("upload-files").files[0], files[0]);
    assert.match(app.id("upload-error").textContent, /配置已被其他页面更新/);
    assert.equal(app.id("upload-submit").disabled, false);
});

test("late enable reply cannot upload files in a new login session", async (t) => {
    const app = setup(t); await settings(app); configureModel(app);
    app.id("model-allow-external").checked = false; await app.submit("model-settings-form");
    await app.click("open-upload"); app.files();
    const pending = deferred(); app.on("/api/model-settings/enable-external", () => pending.promise);
    app.dispatch(app.id("upload-form"), "submit"); await flush();
    await app.click("logout-button"); await app.login();
    pending.resolve(json({ ...app.server.modelSettings, allow_external: true, revision: 2 })); await flush();
    assert.equal(app.calls("/api/uploads").length, 0);
    assert.equal(app.id("model-api-key").value, "");
});

test("incomplete external configuration does not ask or enable and preserves selected image", async (t) => {
    const app = setup(t); await settings(app);
    app.server.modelSettings = { ...app.server.modelSettings, provider: "openai-compatible", status: "not_configured" };
    let prompts = 0; app.window.confirm = () => { prompts++; return true; };
    await app.click("open-upload"); const files = app.files(); await app.submit("upload-form");
    assert.equal(prompts, 0);
    assert.equal(app.calls("/api/model-settings/enable-external").length, 0);
    assert.equal(app.calls("/api/uploads").length, 0);
    assert.equal(app.id("upload-files").files[0], files[0]);
    assert.match(app.id("upload-error").textContent, /模型设置.*已选图片会保留/);
});

test("provider failure exposes an actionable safe explanation without raw response", async (t) => {
    const app = setup(t, { tasks: [makeTask({ status: "failed", candidate: null, error_code: "provider_http_rejected" })] });
    await app.login(); await app.select();
    assert.match(app.document.querySelector(".task-description").textContent, /供应商不接受此图片或结构化请求/);
});

test("regenerating Excel locks old ready download even across status refresh and repeated events", async (t) => {
    const app = setup(t); app.server.exportStatus = "completed"; await app.login();
    assert.equal(app.id("download-button").disabled, false);
    const pending = deferred(); app.on("/api/export", () => pending.promise);
    app.id("export-button").click(); await flush();
    assert.equal(app.id("download-button").disabled, true);
    app.dispatch(app.id("download-button"), "click");
    await app.click("refresh-button");
    assert.equal(app.id("download-button").disabled, true);
    assert.equal(app.calls("/api/export/download").length, 0);
    pending.resolve(json({ status: "completed" })); await flush();
    assert.equal(app.id("download-button").disabled, false);
    await app.click("download-button");
    assert.equal(app.calls("/api/export/download").length, 1);
});
