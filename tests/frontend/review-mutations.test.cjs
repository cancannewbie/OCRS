"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, makeTask, makeEvent, makeOrder, json, deferred, flush } = require("./helpers.cjs");

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


function orderChangeFixtures(action = "amend") {
    const line = { ...makeEvent().items[0], line_id: "synthetic-line-original" };
    const order = makeOrder({ id: "synthetic-order-original", status: "confirmed", items: [line] });
    const event = makeEvent({
        action,
        target_order_id: order.id,
        expected_order_version: 1,
        reason: "Synthetic order change",
        items: [{ ...line }],
    });
    const task = makeTask({ candidate: { schema_version: "1", events: [event], warnings: [], missing_reasons: [] } });
    return { tasks: [task], orders: [order] };
}

function comparison(app) {
    const node = app.document.querySelector(".target-comparison");
    assert.ok(node, "Missing target order comparison");
    return node;
}

function useOrderVersion(app) {
    const button = comparison(app).querySelector('[data-action="use-order-version"]');
    assert.ok(button, "Missing explicit order version action");
    return button;
}

test("order-only refresh updates comparisons and suggestions without replacing dirty inputs", async (t) => {
    const fixtures = orderChangeFixtures();
    fixtures.tasks.push(makeTask({ id: "task-2", sources: [] }));
    const app = await ready(t, fixtures);
    app.fill(app.field("客户"), "Synthetic local customer");
    app.fill(app.field("数量"), "7.125");
    const customer = app.field("客户");
    const version = app.field("目标订单当前版本");
    customer.focus();
    customer.setSelectionRange(4, 9);
    Object.assign(app.server.orders[0], { version: 2, customer: "Synthetic remote customer" });
    app.server.orders[0].items[0].quantity = "9.25";
    await app.click("refresh-button");
    assert.equal(app.server.tasks[0].version, 1);
    assert.match(comparison(app).textContent, /Synthetic remote customer/);
    assert.match(comparison(app).textContent, /9\.25/);
    assert.match(comparison(app).textContent, /当前版本 v2/);
    assert.match(comparison(app).textContent, /本次提交版本 v1/);
    assert.match(comparison(app).textContent, /版本不一致/);
    assert.equal(app.id("order-suggestions").options[0].label, "Synthetic remote customer · v2 · 已确认");
    assert.equal(app.field("客户"), customer);
    assert.equal(app.field("目标订单当前版本"), version);
    assert.equal(app.document.activeElement, customer);
    assert.equal(customer.selectionStart, 4);
    assert.equal(customer.selectionEnd, 9);
    assert.equal(customer.value, "Synthetic local customer");
    assert.equal(version.value, "1");
    assert.equal(app.field("数量").value, "7.125");
    assert.equal(app.field("明细 ID（已有明细保留）").value, "synthetic-line-original");
    assert.equal(app.calls(confirmPath).length, 0);
    await app.select("task-2");
    await app.select("task-1");
    assert.match(comparison(app).textContent, /Synthetic remote customer/);
    assert.equal(app.field("客户").value, "Synthetic local customer");
    assert.equal(app.field("目标订单当前版本").value, "1");
    assert.equal(app.field("数量").value, "7.125");
    assert.equal(app.id("review-actor").value, "Synthetic reviewer");
    assert.equal(app.id("review-reason").value, "Synthetic verification");
});

test("explicit version adoption changes only the expected version and retains input nodes", async (t) => {
    const fixtures = orderChangeFixtures();
    fixtures.tasks[0].candidate.events[0].expected_order_version = null;
    const app = await ready(t, fixtures);
    app.fill(app.field("客户"), "Synthetic manually reviewed customer");
    const customer = app.field("客户");
    const version = app.field("目标订单当前版本");
    const lineId = app.field("明细 ID（已有明细保留）");
    customer.focus();
    customer.setSelectionRange(3, 8);
    app.server.orders[0].version = 3;
    await app.click("refresh-button");
    assert.equal(version.value, "");
    assert.match(useOrderVersion(app).textContent, /v3/);
    useOrderVersion(app).click();
    await flush();
    assert.equal(app.field("客户"), customer);
    assert.equal(app.document.activeElement, customer);
    assert.equal(customer.selectionStart, 3);
    assert.equal(customer.selectionEnd, 8);
    assert.equal(app.field("目标订单当前版本"), version);
    assert.equal(version.value, "3");
    assert.equal(version.parentElement.querySelector(".field-null").hidden, true);
    assert.equal(app.field("明细 ID（已有明细保留）"), lineId);
    assert.equal(lineId.value, "synthetic-line-original");
    assert.equal(customer.value, "Synthetic manually reviewed customer");
    assert.equal(app.calls(confirmPath).length, 0);
    app.fill(version, "1");
    assert.match(comparison(app).textContent, /本次提交版本 v1/);
    assert.match(comparison(app).textContent, /版本不一致/);
    app.server.orders[0].version = 4;
    await app.click("refresh-button");
    assert.equal(version.value, "1");
    useOrderVersion(app).click();
    await flush();
    assert.equal(version.value, "4");
    assert.match(comparison(app).textContent, /本次提交版本 v4/);
    assert.doesNotMatch(comparison(app).textContent, /版本不一致/);
    assert.equal(app.calls(confirmPath).length, 0);
});

test("order version conflict keeps the draft and recovers only after explicit version review and resubmission", async (t) => {
    const app = await ready(t, orderChangeFixtures());
    app.fill(app.field("客户"), "Synthetic conflict draft");
    app.fill(app.field("数量"), "7.125");
    const customer = app.field("客户");
    const version = app.field("目标订单当前版本");
    app.on(confirmPath, () => {
        Object.assign(app.server.orders[0], { version: 2, customer: "Synthetic concurrently amended customer" });
        return json({ error: { code: "VERSION_CONFLICT" } }, 409);
    });
    await app.confirm();
    assert.equal(app.calls(confirmPath).length, 1);
    assert.equal(app.id("confirm-dialog").open, true);
    assert.match(app.id("confirm-error").textContent, /VERSION_CONFLICT/);
    assert.equal(app.server.tasks[0].status, "review_required");
    assert.equal(app.server.tasks[0].version, 1);
    assert.equal(app.field("客户"), customer);
    assert.equal(customer.value, "Synthetic conflict draft");
    assert.equal(version.value, "1");
    assert.match(comparison(app).textContent, /Synthetic concurrently amended customer/);
    assert.match(comparison(app).textContent, /本次提交版本 v1/);
    assert.match(comparison(app).textContent, /当前版本 v2/);
    assert.match(comparison(app).textContent, /版本不一致/);
    await app.click("confirm-cancel");
    assert.equal(app.field("数量").value, "7.125");
    assert.equal(app.field("明细 ID（已有明细保留）").value, "synthetic-line-original");
    useOrderVersion(app).click();
    await flush();
    assert.equal(app.field("客户"), customer);
    assert.equal(app.field("目标订单当前版本"), version);
    assert.equal(version.value, "2");
    assert.equal(app.calls(confirmPath).length, 1);
    app.on(confirmPath, ({ options }) => {
        const body = JSON.parse(options.body);
        assert.equal(body.events[0].expected_order_version, app.server.orders[0].version);
        Object.assign(app.server.orders[0], body.events[0], { version: 3 });
        Object.assign(app.server.tasks[0], { status: "confirmed", version: 2 });
        return json({ orders: [app.server.orders[0].id] });
    });
    await app.confirm();
    assert.equal(app.calls(confirmPath).length, 2);
    const [first, second] = app.calls(confirmPath).map((call) => JSON.parse(call.options.body));
    assert.equal(first.events[0].expected_order_version, 1);
    assert.equal(second.events[0].expected_order_version, 2);
    assert.notEqual(first.idempotency_key, second.idempotency_key);
    assert.deepEqual(second.events[0], { ...first.events[0], expected_order_version: 2 });
    assert.equal(app.server.orders.length, 1);
    assert.equal(app.server.orders[0].version, 3);
    assert.equal(app.id("confirm-dialog").open, false);
});

for (const action of ["amend", "cancel"]) {
    test(`${action} shows cancelled targets after conflict and does not re-enable version adoption`, async (t) => {
        const app = await ready(t, orderChangeFixtures(action));
        const version = app.field("目标订单当前版本");
        app.on(confirmPath, () => {
            Object.assign(app.server.orders[0], { version: 2, status: "cancelled" });
            return json({ error: { code: "VERSION_CONFLICT" } }, 409);
        }, { once: false });
        await app.confirm();
        assert.match(comparison(app).textContent, /目标订单已撤单/);
        assert.match(comparison(app).textContent, /不能再次修改或撤销/);
        assert.equal(useOrderVersion(app).disabled, true);
        assert.equal(version.value, "1");
        assert.equal(app.field("目标订单当前版本"), version);
        assert.equal(app.calls(confirmPath).length, 1);
        await app.click("confirm-cancel");
        useOrderVersion(app).click();
        await flush();
        assert.equal(version.value, "1");
        app.fill(version, "2");
        await app.confirm();
        assert.equal(app.calls(confirmPath).length, 2);
        assert.equal(app.server.tasks[0].status, "review_required");
        assert.equal(app.server.orders[0].status, "cancelled");
        assert.equal(useOrderVersion(app).disabled, true);
        assert.match(app.id("confirm-error").textContent, /VERSION_CONFLICT/);
    });
}

test("a delayed close event cannot discard a freshly reopened confirmation", async (t) => {
    const app = await ready(t);
    const delayedClose = [];
    app.window.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        delayedClose.push(() => app.dispatch(this, "close"));
    };
    const dialog = app.id("confirm-dialog");
    await app.submit("review-form");
    await app.click("confirm-cancel");
    assert.equal(dialog.open, false);
    app.fill(app.field("客户"), "Synthetic reopened confirmation");
    await app.submit("review-form");
    assert.equal(dialog.open, true);
    assert.equal(app.document.activeElement, app.id("confirm-cancel"));
    delayedClose.shift()();
    await flush();
    assert.equal(app.document.activeElement, app.id("confirm-cancel"));
    await app.click("confirm-submit");
    assert.equal(app.calls(confirmPath).length, 1);
    assert.equal(JSON.parse(app.calls(confirmPath)[0].options.body).events[0].customer, "Synthetic reopened confirmation");
    assert.equal(app.server.tasks[0].status, "confirmed");
});

test("an earlier dialog's delayed close preserves a different dialog's target and focus", async (t) => {
    const app = await ready(t);
    const delayedClose = [];
    app.window.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        delayedClose.push(() => app.dispatch(this, "close"));
    };
    await app.submit("review-form");
    await app.click("confirm-cancel");
    await app.click("reject-button");
    app.fill(app.id("reject-reason"), "Synthetic rejection after cancelled confirmation");
    assert.equal(app.document.activeElement, app.id("reject-reason"));
    delayedClose.shift()();
    await flush();
    assert.equal(app.id("reject-dialog").open, true);
    assert.equal(app.document.activeElement, app.id("reject-reason"));
    await app.submit("reject-form");
    const calls = app.calls("/api/tasks/task-1/reject");
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].options.body).reason, "Synthetic rejection after cancelled confirmation");
    assert.equal(app.calls(confirmPath).length, 0);
});

test("old-session close events preserve a reopened dialog's new focus destination and payload", async (t) => {
    const app = await ready(t);
    const delayedClose = [];
    app.window.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        delayedClose.push(() => app.dispatch(this, "close"));
    };
    app.id("review-actor").focus();
    await app.submit("review-form");
    await app.click("logout-button");
    assert.equal(app.id("confirm-dialog").open, false);
    await app.login();
    await app.select();
    app.reviewer();
    app.fill(app.field("客户"), "Synthetic replacement-session confirmation");
    app.id("confirm-button").focus();
    await app.submit("review-form");
    delayedClose.shift()();
    await flush();
    assert.equal(app.id("confirm-dialog").open, true);
    assert.equal(app.document.activeElement, app.id("confirm-cancel"));
    await app.click("confirm-cancel");
    delayedClose.shift()();
    await flush();
    assert.equal(app.document.activeElement, app.id("confirm-button"));
    await app.confirm();
    assert.equal(app.calls(confirmPath).length, 1);
    assert.equal(JSON.parse(app.calls(confirmPath)[0].options.body).events[0].customer, "Synthetic replacement-session confirmation");
});
