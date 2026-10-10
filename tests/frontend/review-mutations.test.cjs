"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, makeTask, makeEvent, makeOrder, json, deferred, flush } = require("./helpers.cjs");

const confirmPath = "/api/tasks/task-1/confirm";
const candidatePath = "/api/tasks/task-1/candidate";
const reopenPath = "/api/tasks/task-1/reopen";

function rejectedFixture(overrides = {}) {
    return makeTask({ status: "rejected", review_history: [{ id: "audit-reject", kind: "rejected", actor: null, reason: "Synthetic original rejection", task_version: 1, from_status: "review_required", to_status: "rejected", created_at: "2026-10-09T00:00:00Z" }], ...overrides });
}

async function rejectedReady(t) {
    const app = setup(t, { tasks: [rejectedFixture()] });
    await app.login(); await app.select();
    await app.click("edit-rejected-button");
    return app;
}

test("queue selection is explicit, excludes unavailable tasks and edits only the frozen chosen sequence", async (t) => {
    const tasks = [makeTask(), rejectedFixture({ id: "task-2" }), makeTask({ id: "task-3" }),
        makeTask({ id: "task-confirmed", status: "confirmed" }),
        rejectedFixture({ id: "task-no-candidate", candidate: null }),
        rejectedFixture({ id: "task-expired", sources: [{ id: "source-expired", expired: true }] })];
    const app = setup(t, { tasks });
    await app.login(); await app.click("nav-review");
    const checkbox = (id) => app.document.querySelector(`.task-select[data-task-id="${id}"]`);
    assert.equal(checkbox("task-confirmed").disabled, true);
    assert.equal(checkbox("task-no-candidate").disabled, true);
    assert.equal(checkbox("task-expired").disabled, true);
    checkbox("task-1").click(); await flush();
    checkbox("task-3").click(); await flush();
    assert.match(app.id("queue-selection-count").textContent, /已选 2 个.*当前页/);
    assert.equal(app.id("queue-select-all").indeterminate, true);
    assert.equal(app.document.querySelectorAll("#task-list tr.selected").length, 2);
    await app.click("queue-edit-selected");
    assert.match(app.id("detail-position").textContent, /选中 1 \/ 2/);
    app.reviewer(); app.fill(app.field("客户"), "Synthetic first chosen correction");
    await app.click("save-candidate-button");
    assert.equal(app.server.tasks[1].version, 1);
    assert.equal(app.server.tasks[2].version, 1);
    await app.click("next-task");
    assert.match(app.id("task-meta").textContent, /task-3/);
    assert.match(app.id("detail-position").textContent, /选中 2 \/ 2/);
    assert.equal(app.id("next-task").disabled, true);
    assert.equal(app.calls("/api/tasks/task-2/candidate").length, 0);
});

test("manual refresh, search, filter and pagination clear current-page checkbox scope", async (t) => {
    const tasks = Array.from({ length: 51 }, (_, index) => makeTask({ id: `task-page-${index + 1}` }));
    const app = setup(t, { tasks });
    await app.login(); await app.click("nav-review");
    await app.click("queue-select-all");
    assert.match(app.id("queue-selection-count").textContent, /已选 50 个/);
    await app.click("queue-next-page");
    assert.match(app.id("queue-selection-count").textContent, /已选 0 个/);
    assert.equal(app.id("queue-select-all").checked, false);
    await app.click("queue-select-all");
    assert.match(app.id("queue-selection-count").textContent, /已选 1 个/);
    await app.click("refresh-button");
    assert.match(app.id("queue-selection-count").textContent, /已选 0 个/);
    await app.click("queue-select-all");
    app.fill(app.id("queue-search"), "task-page-51");
    assert.match(app.id("queue-selection-count").textContent, /已选 0 个/);
    assert.equal(app.id("queue-select-all").disabled, true);
    await app.runTimers(250);
    await app.click("queue-select-all");
    app.fill(app.id("queue-filter"), "review_required"); await flush();
    assert.match(app.id("queue-selection-count").textContent, /已选 0 个/);
    assert.equal(app.id("queue-edit-selected").disabled, true);
});

test("old checkbox events and controls during pending queries cannot restore stale selection", async (t) => {
    const app = setup(t, { tasks: [makeTask()] });
    await app.login(); await app.click("nav-review");
    const oldCheckbox = app.document.querySelector(".task-select");
    const oldSelectAll = app.id("queue-select-all");
    oldCheckbox.click(); await flush();
    const result = deferred();
    app.on("/api/tasks", () => result.promise);
    app.fill(app.id("queue-filter"), "review_required"); await flush();
    assert.equal(app.id("queue-select-all").disabled, true);
    assert.equal(app.document.querySelector(".task-edit").disabled, true);
    oldCheckbox.checked = true; app.dispatch(oldCheckbox, "change");
    oldSelectAll.checked = true; app.dispatch(oldSelectAll, "change");
    assert.match(app.id("queue-selection-count").textContent, /已选 0 个/);
    result.resolve(json({ tasks: app.server.tasks, total: 1, limit: 50, offset: 0, has_more: false }));
    await flush();
    assert.equal(app.id("queue-select-all").disabled, false);
    assert.equal(app.id("queue-select-all").checked, false);
    assert.equal(app.document.querySelector(".task-select").checked, false);
});

test("a reopened rejected task leaving its filter does not break the remaining selected-task navigation", async (t) => {
    const app = setup(t, { tasks: [rejectedFixture(), rejectedFixture({ id: "task-2" })] });
    await app.login(); await app.click("nav-review");
    app.fill(app.id("queue-filter"), "rejected"); await flush();
    await app.click("queue-select-all"); await app.click("queue-edit-selected");
    await app.click("reopen-button");
    app.fill(app.id("reopen-actor"), "Synthetic reviewer");
    app.fill(app.id("reopen-reason"), "Synthetic selected resubmission");
    await app.submit("reopen-form");
    assert.equal(app.server.tasks[0].status, "review_required");
    assert.equal(app.id("next-task").disabled, false);
    assert.match(app.id("detail-position").textContent, /选中 1 \/ 2/);
    await app.click("next-task");
    assert.match(app.id("task-meta").textContent, /task-2/);
    assert.equal(app.field("客户").disabled, false);
    assert.match(app.id("detail-position").textContent, /选中 2 \/ 2/);
});

test("a delayed post-save detail cannot replace a newer authoritative task already refreshed", async (t) => {
    const app = await rejectedReady(t);
    app.reviewer(); app.fill(app.field("客户"), "Synthetic submitted correction");
    const stale = deferred();
    app.on("/api/tasks/task-1", () => stale.promise);
    app.id("save-candidate-button").click(); await flush();
    assert.equal(app.server.tasks[0].version, 2);
    const older = structuredClone(app.server.tasks[0]);
    app.server.tasks[0].version = 3;
    app.server.tasks[0].candidate.events[0].customer = "Synthetic newer authoritative correction";
    await app.runTimers(4000);
    stale.resolve(json(older)); await flush();
    assert.match(app.id("task-meta").textContent, /v3/);
    assert.equal(app.field("客户").value, "Synthetic newer authoritative correction");
});

test("rejected corrections save independently before explicit resubmission and preserve model evidence and audit", async (t) => {
    const app = await rejectedReady(t);
    const original = structuredClone(app.server.tasks[0].candidate);
    const attempts = app.server.tasks[0].attempts;
    app.reviewer();
    app.fill(app.field("客户"), "Synthetic corrected customer");
    app.fill(app.field("数量"), "3.125");
    assert.equal(app.id("confirm-button").hidden, true);
    assert.equal(app.id("reopen-button").disabled, true);
    await app.click("save-candidate-button");
    assert.equal(app.calls(candidatePath).length, 1);
    const savedBody = JSON.parse(app.calls(candidatePath)[0].options.body);
    assert.equal(savedBody.expected_version, 1);
    assert.equal(savedBody.candidate.events[0].items[0].quantity, "3.125");
    assert.deepEqual(savedBody.candidate.events[0].evidence, original.events[0].evidence);
    assert.deepEqual(app.server.tasks[0].model_candidate, original);
    assert.equal(app.server.tasks[0].status, "rejected");
    assert.equal(app.server.tasks[0].version, 2);
    assert.equal(app.id("reopen-button").disabled, false);
    assert.match(app.id("task-review-history").textContent, /Synthetic original rejection/);
    assert.match(app.id("task-review-history").textContent, /Synthetic verification/);
    await app.click("reopen-button");
    assert.equal(app.calls(reopenPath).length, 0);
    assert.match(app.id("reopen-scope").textContent, /task-1.*v2/);
    app.fill(app.id("reopen-reason"), "Synthetic resubmission reason");
    await app.submit("reopen-form");
    const reopenedBody = JSON.parse(app.calls(reopenPath)[0].options.body);
    assert.equal(reopenedBody.expected_version, 2);
    assert.equal(reopenedBody.reason, "Synthetic resubmission reason");
    assert.equal(app.server.tasks[0].status, "review_required");
    assert.equal(app.server.tasks[0].attempts, attempts);
    assert.equal(app.calls("/api/tasks/task-1/retry").length, 0);
    assert.equal(app.calls(confirmPath).length, 0);
    assert.equal(app.calls("/api/export").length, 0);
    assert.deepEqual(app.server.orders, []);
    assert.match(app.id("task-review-history").textContent, /Synthetic original rejection/);
    assert.match(app.id("task-review-history").textContent, /Synthetic resubmission reason/);
});

test("saving incomplete corrections keeps null fields and requires audit but no order confirmation validation", async (t) => {
    const app = await rejectedReady(t);
    app.fill(app.field("客户"), "");
    app.fill(app.field("数量"), "");
    await app.click("save-candidate-button");
    assert.equal(app.calls(candidatePath).length, 0);
    assert.match(app.id("notice-text").textContent, /审核人.*修订原因/);
    app.reviewer();
    await app.click("save-candidate-button");
    assert.equal(app.calls(candidatePath).length, 1);
    const body = JSON.parse(app.calls(candidatePath)[0].options.body);
    assert.equal(body.candidate.events[0].customer, null);
    assert.equal(body.candidate.events[0].items[0].quantity, null);
    assert.equal(app.server.tasks[0].status, "rejected");
});

test("cancel edit and cancel resubmission write nothing and restore the last persisted correction", async (t) => {
    const app = await rejectedReady(t);
    app.reviewer(); app.fill(app.field("客户"), "Synthetic persisted correction");
    await app.click("save-candidate-button");
    app.fill(app.field("客户"), "Synthetic abandoned correction");
    app.window.confirm = () => false;
    await app.click("cancel-edit-button");
    assert.equal(app.field("客户").value, "Synthetic abandoned correction");
    app.window.confirm = () => true;
    await app.click("cancel-edit-button");
    assert.equal(app.field("客户").value, "Synthetic persisted correction");
    assert.equal(app.field("客户").disabled, true);
    await app.click("reopen-button");
    app.fill(app.id("reopen-actor"), "Synthetic reviewer");
    app.fill(app.id("reopen-reason"), "Synthetic cancelled resubmission");
    await app.click("reopen-cancel");
    assert.equal(app.calls(candidatePath).length, 1);
    assert.equal(app.calls(reopenPath).length, 0);
    assert.equal(app.server.tasks[0].status, "rejected");
});

test("candidate save and resubmission are single-flight and freeze audit fields while pending", async (t) => {
    const app = await rejectedReady(t);
    app.reviewer();
    const saved = deferred();
    app.on(candidatePath, () => saved.promise);
    app.id("save-candidate-button").click();
    app.id("save-candidate-button").click();
    await flush();
    assert.equal(app.calls(candidatePath).length, 1);
    assert.equal(app.field("客户").disabled, true);
    Object.assign(app.server.tasks[0], { version: 2 });
    saved.resolve(json({ id: "task-1", status: "rejected", version: 2 }));
    await flush();
    await app.click("reopen-button");
    const reopened = deferred();
    app.on(reopenPath, () => reopened.promise);
    app.submit("reopen-form"); app.submit("reopen-form");
    await flush();
    assert.equal(app.calls(reopenPath).length, 1);
    assert.equal(app.id("reopen-actor").disabled, true);
    assert.equal(app.id("reopen-reason").disabled, true);
    assert.equal(app.dispatch(app.id("reopen-dialog"), "cancel"), false);
    Object.assign(app.server.tasks[0], { status: "review_required", version: 3 });
    reopened.resolve(json({ id: "task-1", status: "review_required", version: 3 }));
    await flush();
    assert.equal(app.id("reopen-dialog").open, false);
    assert.equal(app.calls(confirmPath).length, 0);
});

test("unknown saved outcome replays a frozen body and key even after refresh sees the committed version", async (t) => {
    const app = await rejectedReady(t);
    app.reviewer(); app.fill(app.field("客户"), "Synthetic uncertain save");
    app.on(candidatePath, ({ options }) => {
        const body = JSON.parse(options.body);
        Object.assign(app.server.tasks[0], { candidate: body.candidate, version: 2 });
        throw new TypeError("Synthetic response loss");
    });
    await app.click("save-candidate-button");
    assert.equal(app.id("version-warning").hidden, false);
    assert.equal(app.id("save-candidate-button").disabled, false);
    assert.equal(app.field("客户").value, "Synthetic uncertain save");
    app.on(candidatePath, () => json({ id: "task-1", status: "rejected", version: 2 }));
    await app.click("save-candidate-button");
    const bodies = app.calls(candidatePath).map((call) => JSON.parse(call.options.body));
    assert.deepEqual(bodies[1], bodies[0]);
    assert.equal(app.id("version-warning").hidden, true);
    assert.equal(app.server.tasks[0].version, 2);
});

test("unknown resubmission outcome replays its original key after the server has restored review", async (t) => {
    const app = await rejectedReady(t);
    await app.click("reopen-button");
    app.fill(app.id("reopen-actor"), "Synthetic reviewer");
    app.fill(app.id("reopen-reason"), "Synthetic uncertain reopen");
    app.on(reopenPath, () => {
        Object.assign(app.server.tasks[0], { status: "review_required", version: 2 });
        throw new TypeError("Synthetic response loss");
    });
    await app.submit("reopen-form");
    assert.equal(app.id("reopen-dialog").open, true);
    assert.match(app.id("reopen-error").textContent, /结果未知/);
    app.on(reopenPath, () => json({ id: "task-1", status: "review_required", version: 2 }));
    await app.submit("reopen-form");
    const bodies = app.calls(reopenPath).map((call) => JSON.parse(call.options.body));
    assert.deepEqual(bodies[1], bodies[0]);
    assert.equal(app.id("reopen-dialog").open, false);
    assert.equal(app.calls(confirmPath).length, 0);
});

test("version and illegal-state conflicts preserve corrections until explicit reload", async (t) => {
    const app = await rejectedReady(t);
    app.reviewer(); app.fill(app.field("客户"), "Synthetic stale correction");
    app.on(candidatePath, () => {
        app.server.tasks[0].version = 2;
        app.server.tasks[0].candidate.events[0].customer = "Synthetic concurrent correction";
        return json({ error: { code: "VERSION_CONFLICT" } }, 409);
    });
    await app.click("save-candidate-button");
    assert.equal(app.field("客户").value, "Synthetic stale correction");
    assert.equal(app.id("save-candidate-button").disabled, true);
    app.window.confirm = () => false;
    await app.click("reload-task");
    assert.equal(app.field("客户").value, "Synthetic stale correction");
    app.window.confirm = () => true;
    await app.click("reload-task");
    assert.equal(app.field("客户").value, "Synthetic concurrent correction");
    assert.equal(app.field("客户").disabled, false);
    await app.click("reopen-button");
    app.fill(app.id("reopen-actor"), "Synthetic reviewer");
    app.fill(app.id("reopen-reason"), "Synthetic state conflict");
    app.on(reopenPath, () => {
        app.server.tasks[0].status = "confirmed";
        app.server.tasks[0].version = 3;
        return json({ error: { code: "STATE_CONFLICT" } }, 409);
    });
    await app.submit("reopen-form");
    assert.match(app.id("reopen-error").textContent, /STATE_CONFLICT/);
    await app.submit("reopen-form");
    assert.equal(app.calls(reopenPath).length, 1);
});

test("polling preserves opened original evidence history and logout clears all sensitive review DOM", async (t) => {
    const fixture = rejectedFixture({ model_candidate: { schema_version: "1", events: [makeEvent({ customer: "Synthetic original evidence value" })] } });
    const app = setup(t, { tasks: [fixture] });
    await app.login(); await app.select();
    const snapshot = app.id("task-review-history").querySelector(".candidate-snapshot");
    snapshot.open = true;
    const history = app.id("task-review-history").firstChild;
    await app.runTimers(4000);
    assert.equal(app.id("task-review-history").firstChild, history);
    assert.equal(snapshot.open, true);
    await app.click("reopen-button");
    app.fill(app.id("reopen-reason"), "Synthetic private reopening reason");
    await app.click("logout-button");
    assert.equal(app.id("task-review-history").textContent, "");
    assert.equal(app.id("task-review-history").hidden, true);
    assert.equal(app.id("reopen-scope").textContent, "");
    assert.equal(app.id("reopen-reason").value, "");
    await app.login(); await app.select();
    app.server.unauthorized = true;
    await app.click("refresh-button");
    assert.equal(app.id("task-review-history").textContent, "");
});

test("history exposes complete immutable field and evidence snapshots as text, with explicit legacy audit gaps", async (t) => {
    const unsafeText = '<img src="https://synthetic.invalid/pixel" onerror="window.syntheticHistoryExecuted=true">';
    const candidate = { schema_version: "1", warnings: ["Synthetic candidate warning"], missing_reasons: ["Synthetic candidate missing reason"], events: [makeEvent({
        action: "amend", customer: unsafeText, external_id: "Synthetic external order", occurred_at: "2026-10-09T01:02:03Z", target_order_id: "synthetic-target-order", expected_order_version: 7, reason: "Synthetic amendment reason",
        items: [{ line_id: "synthetic-line", sku: "DEMO-001", name: unsafeText, quantity: "1.125", unit: "Synthetic unit", unit_price: "0.10" }],
        evidence: [{ source_id: "synthetic-original-source", field: "customer", text: unsafeText }], warnings: ["Synthetic event warning"], missing_reasons: ["Synthetic event missing reason"],
    })] };
    const app = setup(t, { tasks: [rejectedFixture({ model_candidate: candidate, candidate_revisions: [{ version: 2, actor: "Synthetic editor", reason: "Synthetic revision", created_at: "2026-10-10T00:00:00Z", candidate }], review_history: [{ id: "legacy", kind: "rejected", reason: unsafeText }, { id: "new", kind: "review_reopened", actor: "Synthetic reviewer", reason: "Synthetic reopen", task_version: 3, from_status: "rejected", to_status: "review_required", created_at: "2026-10-10T00:00:00Z" }] })] });
    await app.login(); await app.select();
    const history = app.id("task-review-history");
    for (const value of ["客户订单号", "Synthetic external order", "业务时间", "2026-10-09T01:02:03Z", "目标订单 ID", "synthetic-target-order", "目标订单版本", "7", "改单 / 撤单原因", "Synthetic amendment reason", "明细 ID", "synthetic-line", "1.125", "0.10", "证据来源 ID", "synthetic-original-source", "对应字段", "customer", "证据文本", unsafeText, "Synthetic candidate warning", "Synthetic candidate missing reason", "Synthetic event warning", "Synthetic event missing reason", "旧记录 · 版本未记录", "旧记录 · 状态变化未记录", "已驳回 → 待审核"])
        assert.ok(history.textContent.includes(value), `History omitted ${value}`);
    assert.equal(history.querySelectorAll("img, script, iframe, a").length, 0);
    assert.equal(app.window.syntheticHistoryExecuted, undefined);
});

test("unavailable rejected evidence stays visibly read-only without editable or resubmission actions", async (t) => {
    const app = setup(t, { tasks: [rejectedFixture({ sources: [{ id: "source-expired", filename: "synthetic-expired.png", source_label: "Synthetic source", expired: true }], candidate: null })] });
    await app.login(); await app.select();
    assert.match(app.id("editor-content").textContent, /原始证据已清理/);
    assert.equal(app.id("edit-rejected-button").disabled, true);
    assert.equal(app.id("reopen-button").disabled, true);
    assert.equal(app.id("review-form").hidden, true);
    assert.equal(app.calls(candidatePath).length, 0);
    assert.equal(app.calls(reopenPath).length, 0);
});

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

test("rejected amendment editing can explicitly adopt the current target version without changing evidence or confirming", async (t) => {
    const fixtures = orderChangeFixtures();
    fixtures.tasks[0].status = "rejected";
    const app = setup(t, fixtures);
    await app.login(); await app.select(); await app.click("edit-rejected-button");
    app.reviewer();
    app.server.orders[0].version = 4;
    await app.click("refresh-button");
    assert.equal(useOrderVersion(app).disabled, false);
    useOrderVersion(app).click(); await flush();
    assert.equal(app.field("目标订单当前版本").value, "4");
    assert.equal(app.field("明细 ID（已有明细保留）").value, "synthetic-line-original");
    await app.click("save-candidate-button");
    const body = JSON.parse(app.calls(candidatePath)[0].options.body);
    assert.equal(body.candidate.events[0].expected_order_version, 4);
    assert.equal(app.server.tasks[0].status, "rejected");
    assert.equal(app.server.orders[0].version, 4);
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
