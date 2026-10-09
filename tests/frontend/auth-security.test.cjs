"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, makeTask, makeEvent, makeOrder, json, image, deferred, flush, TOKEN, TOKEN_KEY, ORIGIN } = require("./helpers.cjs");

test("login validates the token, uses session storage only, and logout clears protected state", async (t) => {
    const app = setup(t, { orders: [makeOrder()] });
    assert.equal(app.id("workspace").hidden, true);
    assert.equal(app.requests.length, 0);
    await app.login("synthetic-invalid-token");
    assert.equal(app.id("login-screen").hidden, false);
    assert.match(app.id("login-error").textContent, /UNAUTHORIZED/);
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), null);
    await app.login();
    assert.equal(app.id("workspace").hidden, false);
    assert.equal(app.id("demo-banner").hidden, false);
    assert.equal(app.id("dashboard-view").hidden, false);
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), TOKEN);
    assert.equal(app.window.localStorage.length, 0);
    assert.equal(app.id("access-token").value, "");
    await app.select();
    assert.ok(app.document.querySelector("#source-list img"));
    await app.click("logout-button");
    assert.equal(app.id("login-screen").hidden, false);
    assert.equal(app.id("workspace").hidden, true);
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), null);
    for (const name of ["task-list", "source-list", "editor-content", "orders-content", "selected-files"])
        assert.equal(app.id(name).textContent, "", `Logout retained #${name}`);
    assert.ok(app.created.every(({ url }) => app.revoked.includes(url)));
});

test("a stored session token is revalidated and concurrent login submissions coalesce", async (t) => {
    const app = setup(t, { storedToken: TOKEN });
    await flush();
    assert.equal(app.id("workspace").hidden, false);
    await app.click("logout-button");
    const pending = deferred();
    app.on("/api/status", () => pending.promise);
    app.fill(app.id("access-token"), TOKEN);
    const previousRequests = app.calls("/api/status").length;
    app.dispatch(app.id("login-form"), "submit");
    app.dispatch(app.id("login-form"), "submit");
    await flush();
    assert.equal(app.calls("/api/status").length, previousRequests + 1);
    assert.equal(app.id("login-button").disabled, true);
    pending.resolve(json(app.server.status));
    await flush();
    assert.equal(app.id("workspace").hidden, false);
});

test("401 invalidation forcibly clears drafts, dialogs, images, and session token", async (t) => {
    const app = setup(t);
    await app.login();
    await app.select();
    app.fill(app.field("客户"), "Unsaved synthetic edit");
    app.window.confirm = () => false;
    await app.click("open-upload");
    app.files();
    app.server.unauthorized = true;
    await app.click("refresh-button");
    assert.equal(app.id("login-screen").hidden, false);
    assert.equal(app.id("workspace").hidden, true);
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), null);
    assert.equal(app.id("upload-dialog").open, false);
    assert.equal(app.id("editor-content").textContent, "");
    assert.equal(app.id("source-list").textContent, "");
    assert.ok(app.created.every(({ url }) => app.revoked.includes(url)));
});

test("user may cancel logout with an unsaved draft without losing changes", async (t) => {
    const app = setup(t);
    await app.login();
    await app.select();
    app.fill(app.field("客户"), "Synthetic unsaved customer");
    let confirmations = 0;
    app.window.confirm = () => { confirmations += 1; return false; };
    await app.click("logout-button");
    assert.equal(confirmations, 1);
    assert.equal(app.id("workspace").hidden, false);
    assert.equal(app.field("客户").value, "Synthetic unsaved customer");
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), TOKEN);
    const beforeUnload = new app.window.Event("beforeunload", { cancelable: true });
    app.window.dispatchEvent(beforeUnload);
    assert.equal(beforeUnload.defaultPrevented, true);
});

test("late response bodies cannot restore a logged-out session or overwrite a new one", async (t) => {
    const app = setup(t);
    const body = deferred();
    app.on("/api/status", () => ({ ok: true, status: 200, json: () => body.promise }));
    app.fill(app.id("access-token"), TOKEN);
    app.dispatch(app.id("login-form"), "submit");
    await flush();
    await app.click("logout-button");
    await app.login();
    app.server.status.provider = "synthetic-current-provider";
    await app.click("refresh-button");
    body.resolve({ ...app.server.status, provider: "demo" });
    await flush();
    assert.equal(app.id("workspace").hidden, false);
    assert.equal(app.id("demo-banner").hidden, true);
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), TOKEN);
    await app.click("logout-button");
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), null);
});

test("a stale unauthorized response cannot log out the replacement session", async (t) => {
    const app = setup(t);
    await app.login();
    const body = deferred();
    app.on("/api/tasks", () => ({ ok: false, status: 401, json: () => body.promise }));
    app.id("refresh-button").click();
    await flush();
    await app.click("logout-button");
    await app.login();
    body.resolve({ error: { code: "UNAUTHORIZED" } });
    await flush();
    assert.equal(app.id("workspace").hidden, false);
    assert.equal(app.window.sessionStorage.getItem(TOKEN_KEY), TOKEN);
});

test("server-controlled text remains text in queue, review, warnings, evidence, filenames and orders", async (t) => {
    const attack = '<img src=x onerror="window.syntheticXss=1">';
    const event = makeEvent({ customer: attack, warnings: [attack], missing_reasons: [attack], evidence: [{ source_id: "source-1", field: "customer", text: attack }] });
    const task = makeTask({ candidate: { schema_version: "1", events: [event], warnings: [attack], missing_reasons: [] } });
    task.sources[0].filename = attack;
    const app = setup(t, { tasks: [task], orders: [makeOrder({ customer: attack })] });
    await app.login();
    await app.select();
    assert.equal(app.field("客户").value, attack);
    assert.match(app.id("task-list").textContent, /<img/);
    assert.match(app.id("editor-content").textContent, /<img/);
    assert.match(app.id("source-list").textContent, /<img/);
    await app.click("nav-orders");
    assert.match(app.id("orders-content").textContent, /<img/);
    assert.equal(app.document.querySelectorAll("[onerror], [onclick], script[src='x']").length, 0);
    assert.equal(app.window.syntheticXss, undefined);
});

test("untrusted error messages and codes do not echo backend secrets or HTML", async (t) => {
    const app = setup(t);
    app.on("/api/status", () => json({ error: { code: "<img onerror=secret>", message: "synthetic-secret-must-not-appear", details: { secret: "synthetic-private-detail" } } }, 500));
    await app.login();
    assert.match(app.id("login-error").textContent, /REQUEST_FAILED/);
    assert.doesNotMatch(app.document.body.textContent, /synthetic-secret|synthetic-private-detail|onerror=secret/);
});

test("source URLs cannot send bearer credentials to another origin, credentials URL, scheme or non-API path", async (t) => {
    const invalidUrls = [
        "https://attacker.example/api/steal",
        "//attacker.example/api/steal",
        `${ORIGIN}/app.js`,
        "http://synthetic-user:synthetic-pass@127.0.0.1:8000/api/sources/steal",
        "javascript:alert(1)",
        "data:image/png;base64,AA==",
    ];
    const task = makeTask({ sources: invalidUrls.map((url, index) => ({ id: `unsafe-${index}`, filename: "synthetic.png", url })) });
    const app = setup(t, { tasks: [task] });
    await app.login();
    await app.select();
    assert.equal(app.document.querySelectorAll("#source-list img").length, 0);
    assert.equal(app.requests.filter((entry) => invalidUrls.includes(entry.url.href)).length, 0);
    for (const request of app.requests) {
        assert.equal(request.url.origin, ORIGIN);
        assert.equal(request.options.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(request.options.redirect, "error");
    }
});

test("images are authenticated blobs, invalid MIME is rejected, and stale image responses are discarded", async (t) => {
    const second = makeTask({ id: "task-2", candidate: { schema_version: "1", events: [makeEvent({ customer: "Synthetic Customer Beta" })], warnings: [], missing_reasons: [] }, sources: [{ id: "source-2", filename: "synthetic-beta.png", url: "/api/sources/source-2" }] });
    const app = setup(t, { tasks: [makeTask(), second] });
    const lateImage = deferred();
    app.on("/api/sources/source-1", () => lateImage.promise);
    await app.login();
    await app.select("task-1");
    await app.select("task-2");
    lateImage.resolve(image());
    await flush();
    const images = [...app.document.querySelectorAll("#source-list img")];
    assert.equal(images.length, 1);
    assert.match(images[0].alt, /synthetic-beta/);
    assert.ok(images[0].src.startsWith(`blob:${ORIGIN}`));
    const link = app.document.querySelector("#source-list a");
    assert.equal(link.target, "_blank");
    assert.match(link.rel, /noopener/);
    assert.match(link.rel, /noreferrer/);
    app.on("/api/sources/source-1", () => image("text/html"));
    await app.select("task-1");
    assert.equal(app.document.querySelectorAll("#source-list img").length, 0);
    assert.match(app.id("source-list").textContent, /失败|无法/);
});

test("a delayed download blob cannot create a file or unlock a newer session's download", async (t) => {
    const app = setup(t, { orders: [makeOrder()] });
    app.server.exportStatus = "completed";
    await app.login();
    await app.click("nav-exports");
    const oldBody = deferred();
    app.on("/api/export/download", () => ({ ok: true, status: 200, blob: () => oldBody.promise }));
    app.id("download-button").click();
    await flush();
    await app.click("logout-button");
    await app.login();
    await app.click("nav-exports");
    const current = deferred();
    app.on("/api/export/download", () => current.promise);
    app.id("download-button").click();
    await flush();
    oldBody.resolve(new Blob(["synthetic old file"], { type: "application/octet-stream" }));
    await flush();
    assert.equal(app.downloads.length, 0);
    assert.equal(app.id("download-button").disabled, true);
    app.id("download-button").click();
    assert.equal(app.calls("/api/export/download").length, 2);
    current.resolve(new Response(new Uint8Array([0x50, 0x4b]), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }));
    await flush();
    assert.equal(app.downloads.length, 1);
    assert.match(app.downloads[0].href, /^blob:/);
});
