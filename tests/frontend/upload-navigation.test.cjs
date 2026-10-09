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
