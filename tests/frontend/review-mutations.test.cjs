"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, makeTask, makeEvent, json, deferred, flush } = require("./helpers.cjs");

const confirmPath = "/api/tasks/task-1/confirm";

async function ready(t, options) {
    const app = setup(t, options);
    await app.login();
    await app.select();
    app.reviewer();
    return app;
}

test("manual confirmation requires valid fields and a separate review dialog", async (t) => {
    const app = await ready(t);
    app.fill(app.field("客户"), "");
    await app.submit("review-form");
    assert.equal(app.calls(confirmPath).length, 0);
    assert.equal(app.id("confirm-dialog").open, false);
    assert.match(app.id("notice").textContent, /客户|必填/);
    app.fill(app.field("客户"), "Synthetic verified customer");
    app.fill(app.field("数量"), "3.125");
    app.fill(app.field("单价"), "0.10");
    await app.submit("review-form");
    assert.equal(app.id("confirm-dialog").open, true);
    assert.equal(app.calls(confirmPath).length, 0);
    assert.match(app.id("confirm-summary").textContent, /Synthetic reviewer/);
    await app.click("confirm-cancel");
    assert.equal(app.id("confirm-dialog").open, false);
    assert.equal(app.field("客户").value, "Synthetic verified customer");
    await app.confirm();
    assert.equal(app.calls(confirmPath).length, 1);
    const body = JSON.parse(app.calls(confirmPath)[0].options.body);
    assert.equal(body.expected_version, 1);
    assert.equal(body.actor, "Synthetic reviewer");
    assert.equal(body.reason, "Synthetic verification");
    assert.equal(body.events[0].items[0].quantity, "3.125");
    assert.equal(body.events[0].items[0].unit_price, "0.10");
    assert.equal(body.events[0].occurred_at, null);
    assert.equal(body.events[0].external_id, null);
    assert.equal(body.acknowledge_duplicates, false);
    assert.ok(body.idempotency_key);
    assert.equal(app.server.tasks[0].status, "confirmed");
    assert.equal(app.server.orders.length, 1);
});

test("confirmation locks repeated submissions until the request resolves", async (t) => {
    const app = await ready(t);
    const pending = deferred();
    app.on(confirmPath, () => pending.promise);
    await app.submit("review-form");
    app.id("confirm-submit").click();
    app.id("confirm-submit").click();
    app.dispatch(app.id("review-form"), "submit");
    await flush();
    assert.equal(app.calls(confirmPath).length, 1);
    assert.equal(app.id("confirm-submit").disabled, true);
    assert.equal(app.id("confirm-button").disabled, true);
    pending.resolve(json({ orders: ["synthetic-order-1"] }));
    await flush();
    assert.equal(app.id("confirm-dialog").open, false);
});

test("unknown confirmation outcome retains its idempotency key until payload changes", async (t) => {
    const app = await ready(t);
    app.on(confirmPath, () => { throw new TypeError("Synthetic network interruption"); }, { once: false });
    await app.confirm();
    assert.match(app.id("confirm-error").textContent, /NETWORK_ERROR|结果|核对/);
    assert.equal(app.field("客户").value, "Synthetic Customer Alpha");
    await app.click("confirm-submit");
    const first = JSON.parse(app.calls(confirmPath)[0].options.body);
    const retried = JSON.parse(app.calls(confirmPath)[1].options.body);
    assert.equal(retried.idempotency_key, first.idempotency_key);
    assert.deepEqual(retried, first);
    await app.click("confirm-cancel");
    app.fill(app.field("数量"), "4.125");
    await app.confirm();
    const changed = JSON.parse(app.calls(confirmPath)[2].options.body);
    assert.notEqual(changed.idempotency_key, first.idempotency_key);
    assert.equal(changed.events[0].items[0].quantity, "4.125");
});

test("duplicate warning needs explicit acknowledgment and cannot double-confirm", async (t) => {
    const app = await ready(t);
    app.on(confirmPath, () => json({ error: { code: "DUPLICATE_WARNING", details: { order_ids: ["synthetic-existing-order"] } } }, 409));
    await app.confirm();
    assert.equal(app.id("duplicate-dialog").open, true);
    assert.equal(app.id("duplicate-confirm").disabled, true);
    assert.match(app.id("duplicate-detail").textContent, /synthetic-existing-order/);
    app.id("duplicate-confirm").click();
    await flush();
    assert.equal(app.calls(confirmPath).length, 1);
    app.id("duplicate-checkbox").checked = true;
    app.dispatch(app.id("duplicate-checkbox"), "change");
    const pending = deferred();
    app.on(confirmPath, () => pending.promise);
    app.id("duplicate-confirm").click();
    app.id("duplicate-confirm").click();
    await flush();
    assert.equal(app.calls(confirmPath).length, 2);
    const first = JSON.parse(app.calls(confirmPath)[0].options.body);
    const acknowledged = JSON.parse(app.calls(confirmPath)[1].options.body);
    assert.equal(first.acknowledge_duplicates, false);
    assert.equal(acknowledged.acknowledge_duplicates, true);
    assert.notEqual(acknowledged.idempotency_key, first.idempotency_key);
    pending.resolve(json({ orders: ["synthetic-confirmed-order"] }));
    await flush();
    assert.equal(app.id("duplicate-dialog").open, false);
});

test("polling and navigation preserve draft values and active input nodes", async (t) => {
    const second = makeTask({ id: "task-2", candidate: { schema_version: "1", events: [makeEvent({ customer: "Synthetic Customer Beta" })], warnings: [], missing_reasons: [] }, sources: [] });
    const app = await ready(t, { tasks: [makeTask(), second] });
    app.fill(app.field("客户"), "Synthetic unsaved edit");
    app.fill(app.field("数量"), "3.125");
    const originalInput = app.field("客户");
    originalInput.focus();
    await app.click("refresh-button");
    assert.equal(app.field("客户"), originalInput);
    assert.equal(app.document.activeElement, originalInput);
    assert.equal(app.field("客户").value, "Synthetic unsaved edit");
    await app.click("nav-orders");
    await app.select("task-2");
    await app.select("task-1");
    assert.equal(app.field("客户").value, "Synthetic unsaved edit");
    assert.equal(app.field("数量").value, "3.125");
    assert.equal(app.id("review-actor").value, "Synthetic reviewer");
    assert.equal(app.id("review-reason").value, "Synthetic verification");
    assert.match(app.id("draft-state").textContent, /未提交/);
});

test("remote versions preserve dirty drafts and block confirmation until explicit reload", async (t) => {
    const app = await ready(t);
    app.fill(app.field("客户"), "Synthetic local draft");
    const input = app.field("客户");
    app.server.tasks[0].version = 2;
    app.server.tasks[0].candidate.events[0].customer = "Synthetic remote edit";
    await app.click("refresh-button");
    assert.equal(app.field("客户"), input);
    assert.equal(input.value, "Synthetic local draft");
    assert.equal(app.id("version-warning").hidden, false);
    assert.equal(app.id("confirm-button").disabled, true);
    await app.submit("review-form");
    assert.equal(app.calls(confirmPath).length, 0);
    app.window.confirm = () => false;
    await app.click("reload-task");
    assert.equal(app.field("客户").value, "Synthetic local draft");
    app.window.confirm = () => true;
    await app.click("reload-task");
    assert.equal(app.field("客户").value, "Synthetic remote edit");
    assert.equal(app.id("version-warning").hidden, true);
});

test("add/remove events and switching amend back to create clear invalid target metadata", async (t) => {
    const app = await ready(t);
    const add = [...app.document.querySelectorAll("#editor-content button")].find((button) => button.textContent.includes("添加订单事件"));
    assert.ok(add);
    add.click();
    await flush();
    assert.equal(app.document.querySelectorAll(".event-card").length, 2);
    const second = app.document.querySelectorAll(".event-card")[1];
    assert.equal(second.querySelector("input").value, "");
    second.querySelector(".event-heading button").click();
    await flush();
    assert.equal(app.document.querySelectorAll(".event-card").length, 1);
    app.fill(app.field("事件类型"), "amend");
    app.fill(app.field("目标订单 ID"), "synthetic-order-original");
    app.fill(app.field("目标订单当前版本"), "2");
    app.fill(app.field("改单 / 撤单原因"), "Synthetic amendment reason");
    app.fill(app.field("事件类型"), "create");
    await app.confirm();
    const body = JSON.parse(app.calls(confirmPath)[0].options.body);
    assert.equal(body.events[0].action, "create");
    assert.equal(body.events[0].target_order_id, null);
    assert.equal(body.events[0].expected_order_version, null);
});

test("failed recognition can retry and rejecting a candidate records a reason without creating orders", async (t) => {
    const app = setup(t, { tasks: [makeTask({ status: "failed", error_code: "provider_auth" })] });
    await app.login();
    await app.select();
    assert.match(app.id("editor-content").textContent, /provider_auth/);
    const retry = [...app.id("task-action-footer").querySelectorAll("button")].find((button) => button.textContent.includes("重新识别"));
    assert.ok(retry);
    retry.click();
    await flush();
    assert.equal(app.calls("/api/tasks/task-1/retry").length, 1);
    assert.deepEqual(JSON.parse(app.calls("/api/tasks/task-1/retry")[0].options.body), { expected_version: 1 });
    assert.equal(app.server.tasks[0].status, "review_required");
    await app.click("reject-button");
    await app.submit("reject-form");
    assert.equal(app.calls("/api/tasks/task-1/reject").length, 0);
    app.fill(app.id("reject-reason"), "Synthetic rejected evidence");
    await app.submit("reject-form");
    const request = JSON.parse(app.calls("/api/tasks/task-1/reject")[0].options.body);
    assert.equal(request.reason, "Synthetic rejected evidence");
    assert.equal(request.expected_version, 2);
    assert.equal(app.server.tasks[0].status, "rejected");
    assert.equal(app.server.orders.length, 0);
});

test("an old confirmation body cannot erase a replacement session's draft", async (t) => {
    const app = await ready(t);
    const pendingBody = deferred();
    app.on(confirmPath, () => ({ ok: true, status: 200, json: () => pendingBody.promise }));
    await app.submit("review-form");
    app.id("confirm-submit").click();
    await flush();
    await app.click("logout-button");
    await app.login();
    await app.select();
    app.reviewer();
    app.fill(app.field("客户"), "Synthetic replacement-session draft");
    pendingBody.resolve({ orders: ["synthetic-old-session-order"] });
    await flush();
    assert.equal(app.field("客户").value, "Synthetic replacement-session draft");
    assert.match(app.id("draft-state").textContent, /未提交/);
    assert.doesNotMatch(app.id("notice-text").textContent, /审核已保存|已确认入账/);
});
