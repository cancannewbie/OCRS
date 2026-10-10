"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, makeTask, makeEvent, makeOrder, json, deferred, flush } = require("./helpers.cjs");

async function review(t, overrides = {}) {
    const app = setup(t, { tasks: [makeTask(overrides), makeTask({ id: "task-2", sources: [], candidate: { schema_version: "1", events: [makeEvent({ customer: "Synthetic Customer Beta" })], warnings: [], missing_reasons: [] } })] });
    await app.login();
    await app.select();
    app.reviewer();
    return app;
}

function key(app, node, options) {
    const event = new app.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
    node.dispatchEvent(event);
    return event;
}

for (const control of ["input", "select", "textarea", "contenteditable"]) {
    test(`Alt navigation preserves the current task while editing ${control}`, async (t) => {
        const app = await review(t);
        let target = control === "input" ? app.field("客户") : control === "select" ? app.field("币种") : app.document.createElement(control === "textarea" ? "textarea" : "div");
        if (control === "contenteditable") {
            target.setAttribute("contenteditable", "true");
            target.append(app.document.createElement("span"));
        }
        if (["textarea", "contenteditable"].includes(control)) app.id("editor-content").append(target);
        target.focus();
        if (control === "contenteditable") target = target.firstElementChild;
        const position = app.id("detail-position").textContent;
        const event = key(app, target, { key: "ArrowDown", altKey: true });
        await flush();
        assert.equal(event.defaultPrevented, false, "Editing controls retain their native shortcut");
        assert.equal(app.id("detail-position").textContent, position);
        assert.match(app.id("task-meta").textContent, /task-1/);
    });
}

for (const options of [{ key: "ArrowDown", altKey: true }, { key: "Escape" }, { key: "/" }]) {
    test(`IME composition does not activate the ${options.key} workbench shortcut`, async (t) => {
        const app = await review(t);
        const position = app.id("detail-position").textContent;
        const event = key(app, app.id("back-to-queue"), { ...options, isComposing: true });
        await flush();
        assert.equal(event.defaultPrevented, false);
        assert.equal(app.id("queue-panel").hidden, true);
        assert.equal(app.id("detail-position").textContent, position);
    });
}

test("a handled key and browser modifier shortcuts do not trigger workbench navigation", async (t) => {
    const app = await review(t);
    const target = app.id("back-to-queue");
    const position = app.id("detail-position").textContent;
    target.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    key(app, target, { key: "ArrowDown", altKey: true });
    await flush();
    assert.equal(app.id("detail-position").textContent, position);
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
        const event = key(app, target, { key: "/", [modifier]: true });
        assert.equal(event.defaultPrevented, false);
        assert.equal(app.id("queue-panel").hidden, true);
    }
});

test("unmodified workbench shortcuts still navigate tasks and focus queue search", async (t) => {
    const app = await review(t);
    assert.equal(key(app, app.id("back-to-queue"), { key: "ArrowDown", altKey: true }).defaultPrevented, true);
    await flush();
    assert.match(app.id("task-meta").textContent, /task-2/);
    assert.equal(key(app, app.id("back-to-queue"), { key: "/" }).defaultPrevented, true);
    assert.equal(app.id("queue-panel").hidden, false);
    assert.equal(app.document.activeElement, app.id("queue-search"));
});

test("login exposes busy text then restores its SVG after a failed request and retry", async (t) => {
    const app = setup(t);
    const pending = deferred();
    app.on("/api/status", () => pending.promise);
    app.fill(app.id("access-token"), "synthetic-dom-access-token");
    app.dispatch(app.id("login-form"), "submit");
    await flush();
    assert.equal(app.id("login-button").getAttribute("aria-busy"), "true");
    assert.match(app.id("login-button").textContent, /正在验证/);
    pending.resolve(json({ error: { code: "UNAUTHORIZED" } }, 401));
    await flush();
    assert.equal(app.id("login-button").getAttribute("aria-busy"), "false");
    assert.equal(app.id("login-button").disabled, false);
    assert.ok(app.id("login-button").querySelector("svg.ui-icon"));
    await app.login();
    assert.ok(app.id("login-button").querySelector("svg.ui-icon"));
});

test("upload busy state clears on logout and stale responses cannot clear a new upload", async (t) => {
    const app = setup(t);
    await app.login(); await app.click("open-upload"); app.files();
    const old = deferred();
    app.on("/api/uploads", () => ({ ok: true, status: 200, json: () => old.promise }));
    app.dispatch(app.id("upload-form"), "submit"); await flush();
    assert.equal(app.id("upload-form").getAttribute("aria-busy"), "true");
    assert.equal(app.id("upload-submit").getAttribute("aria-busy"), "true");
    await app.click("logout-button");
    assert.equal(app.document.querySelector('[aria-busy="true"]'), null);
    await app.login(); await app.click("open-upload"); app.files(["synthetic-new-session.png"]);
    const current = deferred();
    app.on("/api/uploads", () => current.promise);
    app.dispatch(app.id("upload-form"), "submit"); await flush();
    old.resolve({ tasks: [], duplicates: [] }); await flush();
    assert.equal(app.id("upload-submit").getAttribute("aria-busy"), "true");
    assert.equal(app.id("upload-submit").disabled, true);
    current.resolve(json({ tasks: [], duplicates: [] })); await flush();
    assert.equal(app.id("upload-submit").getAttribute("aria-busy"), "false");
    assert.equal(app.id("upload-form").getAttribute("aria-busy"), "false");
    assert.match(app.id("upload-submit").textContent, /运行离线演示/);
});

test("failed candidate saves clear busy feedback while retaining the editable correction", async (t) => {
    const app = await review(t);
    app.fill(app.field("客户"), "Synthetic corrected customer");
    const pending = deferred();
    app.on("/api/tasks/task-1/candidate", () => pending.promise, { method: "PUT" });
    app.id("save-candidate-button").click(); await flush();
    assert.equal(app.id("review-form").getAttribute("aria-busy"), "true");
    assert.equal(app.id("save-candidate-button").getAttribute("aria-busy"), "true");
    assert.equal(app.field("客户").disabled, true);
    pending.resolve(json({ error: { code: "REQUEST_FAILED" } }, 500)); await flush();
    assert.equal(app.id("review-form").getAttribute("aria-busy"), "false");
    assert.equal(app.id("save-candidate-button").getAttribute("aria-busy"), "false");
    assert.equal(app.id("save-candidate-button").disabled, false);
    assert.equal(app.field("客户").value, "Synthetic corrected customer");
});

test("confirmation busy feedback clears on failure without unlocking a repeated in-flight request", async (t) => {
    const app = await review(t);
    await app.submit("review-form");
    const pending = deferred();
    app.on("/api/tasks/task-1/confirm", () => pending.promise);
    app.id("confirm-submit").click(); app.id("confirm-submit").click(); await flush();
    assert.equal(app.calls("/api/tasks/task-1/confirm").length, 1);
    assert.equal(app.id("confirm-dialog").getAttribute("aria-busy"), "true");
    assert.equal(app.id("confirm-submit").getAttribute("aria-busy"), "true");
    assert.match(app.id("confirm-submit").textContent, /正在提交/);
    pending.resolve(json({ error: { code: "REQUEST_FAILED" } }, 500)); await flush();
    assert.equal(app.id("confirm-dialog").getAttribute("aria-busy"), "false");
    assert.equal(app.id("confirm-submit").getAttribute("aria-busy"), "false");
    assert.equal(app.id("confirm-submit").disabled, false);
    assert.equal(app.id("confirm-dialog").open, true);
});

test("successful reopen restores keyboard focus when its disabled trigger is replaced", async (t) => {
    const app = setup(t, { tasks: [makeTask({ status: "rejected" })] });
    await app.login(); await app.select();
    const trigger = app.id("reopen-button"); trigger.focus();
    await app.click("reopen-button");
    app.fill(app.id("reopen-actor"), "Synthetic reviewer");
    app.fill(app.id("reopen-reason"), "Synthetic corrected evidence");
    const pending = deferred(); app.on("/api/tasks/task-1/reopen", () => pending.promise);
    app.dispatch(app.id("reopen-form"), "submit"); await flush();
    assert.equal(app.id("reopen-dialog").getAttribute("aria-busy"), "true");
    app.server.tasks[0].status = "review_required"; app.server.tasks[0].version += 1;
    pending.resolve(json({ id: "task-1", status: "review_required", version: 2 })); await flush();
    assert.equal(app.id("reopen-dialog").getAttribute("aria-busy"), "false");
    assert.equal(trigger.isConnected, false);
    assert.equal(app.document.activeElement, app.id("back-to-queue"));
});

test("model loading, saving and synthetic test expose distinct busy text and restore controls", async (t) => {
    const app = setup(t); await app.login();
    const loading = deferred(); app.on("/api/model-settings", () => loading.promise);
    await app.click("nav-settings");
    assert.equal(app.id("model-settings-form").getAttribute("aria-busy"), "true");
    assert.match(app.id("model-reset").textContent, /正在读取/);
    loading.resolve(json(app.server.modelSettings)); await flush();
    assert.equal(app.id("model-settings-form").getAttribute("aria-busy"), "false");
    const saving = deferred(); app.on("/api/model-settings", () => saving.promise, { method: "PUT" });
    app.dispatch(app.id("model-settings-form"), "submit"); await flush();
    assert.equal(app.id("model-save").getAttribute("aria-busy"), "true");
    assert.match(app.id("model-save").textContent, /正在保存/);
    saving.resolve(json({ error: { code: "MODEL_SETTINGS_CONFLICT" } }, 409)); await flush();
    assert.equal(app.id("model-save").getAttribute("aria-busy"), "false");
    assert.equal(app.id("model-save").disabled, false);
    app.server.modelSettings = { ...app.server.modelSettings, revision: 1, provider: "openai-compatible", model: "synthetic-vision-model", base_url: "https://models.example.com/v1", api_key_configured: true, allow_external: true, status: "configured" };
    await app.click("model-reset"); await app.click("model-test");
    const testing = deferred(); app.on("/api/model-settings/test", () => testing.promise);
    app.id("model-test-confirm").click(); await flush();
    assert.equal(app.id("model-test-dialog").getAttribute("aria-busy"), "true");
    assert.match(app.id("model-test-confirm").textContent, /正在测试/);
    testing.resolve(json({ error: { code: "REQUEST_FAILED" } }, 500)); await flush();
    assert.equal(app.id("model-test-dialog").getAttribute("aria-busy"), "false");
    assert.equal(app.id("model-test-confirm").getAttribute("aria-busy"), "false");
    assert.equal(app.id("model-test-confirm").disabled, false);
});

test("refresh, export and download restore their idle labels and SVGs after completion", async (t) => {
    const app = setup(t, { orders: [makeOrder()] }); await app.login();
    const refreshIcon = app.id("refresh-button").querySelector("svg");
    const refresh = deferred(); app.on("/api/status", () => refresh.promise);
    app.id("refresh-button").click(); await flush();
    assert.equal(app.id("refresh-button").getAttribute("aria-busy"), "true");
    refresh.resolve(json(app.server.status)); await flush();
    assert.equal(app.id("refresh-button").getAttribute("aria-busy"), "false");
    assert.equal(app.id("refresh-button").querySelector("svg"), refreshIcon);
    await app.click("nav-exports");
    const exportText = app.id("export-button").textContent;
    const exporting = deferred(); app.on("/api/export", () => exporting.promise);
    app.id("export-button").click(); await flush();
    assert.equal(app.id("export-button").getAttribute("aria-busy"), "true");
    assert.match(app.id("export-button").textContent, /正在生成/);
    app.server.exportStatus = "completed"; exporting.resolve(json({ status: "completed" })); await flush();
    assert.equal(app.id("export-button").getAttribute("aria-busy"), "false");
    assert.equal(app.id("export-button").textContent, exportText);
    const downloadIcon = app.id("download-button").querySelector("svg");
    const downloading = deferred(); app.on("/api/export/download", () => downloading.promise);
    app.id("download-button").click(); await flush();
    assert.equal(app.id("download-button").getAttribute("aria-busy"), "true");
    assert.match(app.id("download-button").textContent, /正在下载/);
    downloading.resolve(new Response(new Uint8Array([0x50, 0x4b]))); await flush();
    assert.equal(app.id("download-button").getAttribute("aria-busy"), "false");
    assert.equal(app.id("download-button").querySelector("svg"), downloadIcon);
    assert.equal(app.downloads.length, 1);
    const table = app.document.querySelector(".orders-table-wrap");
    assert.equal(table.tabIndex, 0);
    assert.ok(table.getAttribute("aria-label"));
});

test("rejection busy feedback clears after failure without losing the reason", async (t) => {
    const app = await review(t);
    await app.click("reject-button");
    app.fill(app.id("reject-reason"), "Synthetic rejection reason");
    const pending = deferred(); app.on("/api/tasks/task-1/reject", () => pending.promise);
    app.dispatch(app.id("reject-form"), "submit"); await flush();
    assert.equal(app.id("reject-dialog").getAttribute("aria-busy"), "true");
    assert.equal(app.id("reject-submit").getAttribute("aria-busy"), "true");
    assert.match(app.id("reject-submit").textContent, /正在驳回/);
    pending.resolve(json({ error: { code: "REQUEST_FAILED" } }, 500)); await flush();
    assert.equal(app.id("reject-dialog").getAttribute("aria-busy"), "false");
    assert.equal(app.id("reject-submit").getAttribute("aria-busy"), "false");
    assert.equal(app.id("reject-reason").value, "Synthetic rejection reason");
    assert.equal(app.id("reject-dialog").open, true);
});

test("a disconnected dialog opener returns focus to the current main section", async (t) => {
    const app = setup(t); await app.login();
    app.id("open-upload").focus();
    await app.click("open-upload");
    app.id("open-upload").remove();
    await app.click("close-upload");
    assert.equal(app.document.activeElement, app.id("main-content"));
});

test("dynamic SVGs preserve dashboard, original-image and formal-order accessible text", async (t) => {
    const app = setup(t); await app.login();
    const dashboard = app.document.querySelector(".dashboard-task");
    assert.match(dashboard.textContent, /Synthetic Customer Alpha/);
    assert.ok(dashboard.querySelector("svg.ui-icon.icon-directional"));
    await app.select();
    const source = app.document.querySelector("#source-list a");
    assert.equal(source.textContent, "查看原图");
    assert.equal(source.target, "_blank");
    assert.match(source.rel, /noopener/);
    assert.match(source.rel, /noreferrer/);
    assert.ok(source.querySelector("svg.ui-icon"));
    app.server.tasks[0].status = "confirmed"; app.server.tasks[0].version += 1;
    await app.click("refresh-button");
    const action = app.document.querySelector("#task-action-footer button");
    assert.equal(action.textContent, "查看正式订单");
    assert.ok(action.querySelector("svg.ui-icon.icon-directional"));
    for (const svg of [dashboard.querySelector("svg"), source.querySelector("svg"), action.querySelector("svg")]) {
        assert.equal(svg.getAttribute("aria-hidden"), "true");
        assert.equal(svg.getAttribute("focusable"), "false");
        assert.equal(svg.getAttribute("stroke"), "currentColor");
        assert.equal(svg.querySelector("path").getAttribute("vector-effect"), "non-scaling-stroke");
    }
});

test("checkbox label targets preserve eligible selection and ignore unavailable rows", async (t) => {
    const app = setup(t, { tasks: [makeTask(), makeTask({ id: "task-2", status: "confirmed" })] });
    await app.login(); await app.click("nav-review");
    app.document.querySelector('.task-select[data-task-id="task-1"]').closest("label.selection-target").click();
    await flush();
    assert.equal(app.document.querySelector('.task-select[data-task-id="task-1"]').checked, true);
    assert.match(app.id("queue-selection-count").textContent, /已选 1 个/);
    app.document.querySelector('.task-select[data-task-id="task-2"]').closest("label.selection-target").click();
    await flush();
    assert.match(app.id("queue-selection-count").textContent, /已选 1 个/);
    assert.equal(app.document.querySelector('.task-select[data-task-id="task-2"]').checked, false);
    app.id("queue-select-all").closest("label.selection-target").click(); await flush();
    assert.match(app.id("queue-selection-count").textContent, /已选 0 个/);
});
