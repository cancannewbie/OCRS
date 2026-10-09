"use strict";

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test: base, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const TOKEN = "synthetic-playwright-only-token-not-a-secret";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const ITEM_NAME = "=SYNTHETIC_CHANGE()";

const test = base.extend({
    page: async ({ page, baseURL }, use) => {
        const pageErrors = [];
        const externalRequests = [];
        const credentialURLs = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("request", (request) => {
            if (request.url().includes(TOKEN)) credentialURLs.push(request.url());
        });
        // All business responses come from the real disposable FastAPI service.
        // This guard only blocks accidental external traffic; it never fulfills requests.
        await page.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== new URL(baseURL).origin) {
                externalRequests.push(url.origin);
                await route.abort("blockedbyclient");
                return;
            }
            await route.continue();
        });
        await use(page);
        expect(pageErrors, "Order changes must not raise browser application exceptions").toEqual([]);
        expect(externalRequests, "Acceptance must remain on the local demo service").toEqual([]);
        expect(credentialURLs, "The access token must never enter request URLs").toEqual([]);
    },
});

function python(script, ...arguments_) {
    execFileSync("uv", ["run", "--locked", "python", script, ...arguments_], {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 30_000,
    });
}

function sample(testInfo) {
    const run = `${testInfo.project.name}-${randomUUID()}`;
    const image = testInfo.outputPath("synthetic-order-change.png");
    python("tests/e2e/fixture.py", "image", image);
    return {
        image,
        sourceLabel: `synthetic-changes-${run}`,
        customer: `SYNTHETIC Change Customer ${run}`,
        externalId: `000042-${run}`,
    };
}

async function readJSON(request, route) {
    const response = await request.get(route, { headers: AUTH });
    expect(response.ok(), `Read ${route}`).toBeTruthy();
    return response.json();
}

async function customerOrders(request, customer) {
    const result = await readJSON(request, "/api/orders");
    return result.orders.filter((order) => order.customer === customer);
}

async function oneOrder(request, customer) {
    const matches = await customerOrders(request, customer);
    expect(matches).toHaveLength(1);
    return matches[0];
}

async function history(request, orderId) {
    return (await readJSON(request, `/api/orders/${orderId}/history`)).events;
}

function trackConfirmations(page) {
    const requests = [];
    page.on("request", (request) => {
        const match = new URL(request.url()).pathname.match(/^\/api\/tasks\/([^/]+)\/confirm$/);
        if (match && request.method() === "POST")
            requests.push({ taskId: match[1], body: request.postDataJSON() });
    });
    return requests;
}

function confirmationResponse(page, taskId) {
    return page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/tasks/${taskId}/confirm`
        && response.request().method() === "POST",
    );
}

async function login(page) {
    await page.goto("/");
    await page.locator("#access-token").fill(TOKEN);
    await page.locator("#login-button").click();
    await expect(page.locator("#dashboard-view")).toBeVisible();
    await expect(page.locator("#demo-banner")).toContainText("不执行 OCR");
}

async function upload(page, data, suffix) {
    await page.locator("#nav-review").click();
    await page.locator("#review-upload").click();
    await expect(page.locator("#upload-dialog")).toBeVisible();
    await page.locator("#upload-files").setInputFiles(data.image);
    await page.locator("#source-label").fill(`${data.sourceLabel}-${suffix}`);
    const responsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/uploads"
        && response.request().method() === "POST",
    );
    await page.locator("#upload-submit").click();
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.duplicates).toEqual([]);
    expect(result.tasks).toHaveLength(1);
    await expect(page.locator("#upload-dialog")).not.toBeVisible();
    await expect(page.locator("#task-workspace")).toBeVisible();
    await expect(page.locator("#task-status")).toHaveText("待审核");
    await expect(page.locator("#review-form")).toBeVisible();
    const sourceImage = page.locator("#source-list img").first();
    await expect(sourceImage).toBeVisible();
    await expect.poll(() => sourceImage.evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);
    return result.tasks[0].id;
}

async function fillOrder(page, data, quantity = "2.5", lineId = "") {
    const editor = page.locator("#editor-content");
    await editor.getByLabel(/^客户/).fill(data.customer);
    await editor.getByLabel(/^外部订单编号/).fill(data.externalId);
    await editor.getByLabel(/^币种/).fill("CNY");
    await editor.getByLabel(/^商品名称/).fill(ITEM_NAME);
    await editor.getByLabel(/^SKU/).fill("DEMO-001");
    await editor.getByLabel(/^数量/).fill(quantity);
    await editor.getByLabel(/^单位/).fill("box");
    await editor.getByLabel(/^单价/).fill("12.40");
    await editor.getByLabel(/^明细 ID/).fill(lineId);
}

async function reviewer(page, actor, reason) {
    await page.locator("#review-actor").fill(actor);
    await page.locator("#review-reason").fill(reason);
}

async function chooseTarget(page, action, order, reason) {
    const editor = page.locator("#editor-content");
    await editor.getByLabel(/^事件类型/).selectOption(action);
    await editor.getByLabel(/^目标订单 ID/).fill(order.id);
    // Selecting an ID must not silently infer optimistic-lock consent.
    await expect(editor.getByLabel(/^目标订单当前版本/)).toHaveValue("");
    await expect(editor.locator(".target-comparison")).toContainText(order.customer);
    await expect(editor.locator(".target-snapshot")).toContainText(order.items[0].line_id);
    await editor.getByRole("button", { name: `带入当前版本 v${order.version}`, exact: true }).click();
    await expect(editor.getByLabel(/^目标订单当前版本/)).toHaveValue(String(order.version));
    await editor.getByLabel(/^改单 \/ 撤单原因/).fill(reason);
}

async function confirm(page, taskId) {
    await page.locator("#confirm-button").click();
    await expect(page.locator("#confirm-dialog")).toBeVisible();
    const responsePromise = confirmationResponse(page, taskId);
    await page.locator("#confirm-submit").click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(page.locator("#confirm-dialog")).not.toBeVisible();
    await expect(page.locator("#task-status")).toHaveText("已确认");
    return response.json();
}

async function createOrder(page, request, data) {
    const taskId = await upload(page, data, "create");
    await fillOrder(page, data);
    await reviewer(page, "Synthetic create reviewer", "Verified invented new-order evidence.");
    expect(await customerOrders(request, data.customer)).toEqual([]);
    const result = await confirm(page, taskId);
    const order = await oneOrder(request, data.customer);
    expect(result.orders).toEqual([order.id]);
    expect(order).toMatchObject({ version: 1, status: "confirmed", external_id: data.externalId, currency: "CNY" });
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ name: ITEM_NAME, quantity: "2.5", unit_price: "12.40", unit: "box" });
    expect(order.items[0].line_id).toEqual(expect.any(String));
    return { taskId, order };
}

async function openHistory(page, data, orderId, version, eventCount) {
    await page.locator("#nav-orders").click();
    await page.locator("#order-filter").selectOption("all");
    await page.locator("#order-search").fill(data.customer);
    await expect(page.locator("#orders-content tbody tr")).toHaveCount(1);
    await expect(page.locator("#orders-content")).toContainText(`版本 ${version}`);
    await page.locator(`#orders-content [data-order-id="${orderId}"]`).click();
    await expect(page.locator("#order-history-dialog")).toBeVisible();
    await expect(page.locator("#order-history-content .history-event")).toHaveCount(eventCount);
    await expect(page.locator("#order-history-content .history-intro")).toContainText(orderId);
    await expect(page.locator("#order-history-content .history-intro")).toContainText(`当前版本 v${version}`);
}

async function capture(page, testInfo, name) {
    const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        root: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
    }));
    expect(dimensions.root, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
    const screenshot = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

test("UI amendments and cancellation preserve one order, stable lines, version history, and exact Excel values", async ({ page, request }, testInfo) => {
    const data = sample(testInfo);
    const confirmations = trackConfirmations(page);
    const amendReason = "Synthetic customer changed the quantity to 3.125 boxes.";
    const cancelReason = "Synthetic customer withdrew this invented order.";
    await login(page);
    const { taskId: createTask, order: original } = await createOrder(page, request, data);
    const lineId = original.items[0].line_id;
    let amended;
    let amendTask;
    let cancelTask;

    await test.step("a new evidence source explicitly amends the selected order and retained line", async () => {
        amendTask = await upload(page, data, "amend");
        expect(amendTask).not.toBe(createTask);
        const source = await readJSON(request, `/api/tasks/${createTask}`);
        const amendment = await readJSON(request, `/api/tasks/${amendTask}`);
        expect(amendment.sources[0].id).not.toBe(source.sources[0].id);
        await chooseTarget(page, "amend", original, amendReason);
        await fillOrder(page, data, "3.125", lineId);
        await reviewer(page, "Synthetic amendment reviewer", "Verified invented amendment evidence.");
        await capture(page, testInfo, "01-amendment-review");
        expect(await oneOrder(request, data.customer)).toEqual(original);
        const result = await confirm(page, amendTask);
        expect(result.orders).toEqual([original.id]);
        amended = await oneOrder(request, data.customer);
        expect(amended).toMatchObject({ id: original.id, version: 2, status: "confirmed", external_id: data.externalId });
        expect(amended.items).toEqual([{ ...original.items[0], quantity: "3.125" }]);
        expect(confirmations.at(-1)).toMatchObject({
            taskId: amendTask,
            body: { acknowledge_duplicates: false, events: [{ action: "amend", target_order_id: original.id, expected_order_version: 1, reason: amendReason, items: [{ line_id: lineId, quantity: "3.125", unit_price: "12.40" }] }] },
        });
        const events = await history(request, original.id);
        expect(events).toHaveLength(2);
        expect(events.map((event) => [event.version, event.action, event.task_id])).toEqual([[1, "create", createTask], [2, "amend", amendTask]]);
        expect(events[0].payload.items[0]).toMatchObject({ line_id: lineId, quantity: "2.5" });
        expect(events[1]).toMatchObject({ actor: "Synthetic amendment reviewer", reason: amendReason, payload: { id: original.id, version: 2, items: [{ line_id: lineId, quantity: "3.125", unit_price: "12.40" }] } });
        await openHistory(page, data, original.id, 2, 2);
        await expect(page.locator("#order-history-content")).toContainText(amendReason);
        await expect(page.locator("#order-history-content")).toContainText("v2 · 修改订单");
        await page.locator("#history-done").click();
    });

    await test.step("cancelling the review dialog writes nothing; explicit cancellation records v3", async () => {
        cancelTask = await upload(page, data, "cancel");
        expect(new Set([createTask, amendTask, cancelTask]).size).toBe(3);
        await chooseTarget(page, "cancel", amended, cancelReason);
        // A cancellation does not need invented replacement customer or price fields.
        await page.locator("#editor-content").getByLabel(/^客户/).fill("");
        await expect(page.locator("#editor-content .item-card")).toHaveCount(0);
        await reviewer(page, "Synthetic cancellation reviewer", "Verified invented withdrawal evidence.");
        await page.locator("#confirm-button").click();
        await expect(page.locator("#confirm-summary")).toContainText(original.id);
        await expect(page.locator("#confirm-summary")).toContainText("当前版本 v2");
        await expect(page.locator("#confirm-summary")).toContainText(cancelReason);
        await expect(page.locator("#confirm-submit")).toHaveText("确认撤单并保存");
        const beforeCancel = confirmations.length;
        await page.locator("#confirm-cancel").click();
        await expect(page.locator("#confirm-dialog")).not.toBeVisible();
        expect(confirmations).toHaveLength(beforeCancel);
        expect(await oneOrder(request, data.customer)).toEqual(amended);
        expect(await history(request, original.id)).toHaveLength(2);
        const result = await confirm(page, cancelTask);
        expect(result.orders).toEqual([original.id]);
        const cancelled = await oneOrder(request, data.customer);
        expect(cancelled).toMatchObject({ id: original.id, status: "cancelled", version: 3, customer: data.customer, external_id: data.externalId, currency: "CNY" });
        expect(cancelled.items).toEqual(amended.items);
        expect(confirmations).toHaveLength(3);
        expect(confirmations.at(-1)).toMatchObject({ taskId: cancelTask, body: { events: [{ action: "cancel", target_order_id: original.id, expected_order_version: 2, reason: cancelReason }] } });
        const events = await history(request, original.id);
        expect(events.map((event) => [event.version, event.action, event.task_id])).toEqual([[1, "create", createTask], [2, "amend", amendTask], [3, "cancel", cancelTask]]);
        expect(events[2]).toMatchObject({ actor: "Synthetic cancellation reviewer", reason: cancelReason, payload: { id: original.id, status: "cancelled", version: 3 } });
        expect(events[2].payload.items).toEqual(amended.items);
        await openHistory(page, data, original.id, 3, 3);
        const historyContent = page.locator("#order-history-content");
        await expect(historyContent).toContainText("v3 · 撤销订单");
        await expect(historyContent).toContainText(cancelReason);
        await expect(historyContent).toContainText("Synthetic cancellation reviewer");
        await historyContent.locator(".history-event").last().locator("summary").click();
        await expect(historyContent.locator(".history-event").last()).toContainText(lineId);
        await expect(historyContent.locator(".history-event").last()).toContainText("3.125 box × 12.40");
        await capture(page, testInfo, "02-cancelled-order-history");
        await page.locator("#history-done").click();
        await page.locator("#order-filter").selectOption("confirmed");
        await expect(page.locator("#orders-content tbody tr")).toHaveCount(0);
        await page.locator("#order-filter").selectOption("cancelled");
        await expect(page.locator("#orders-content tbody tr")).toHaveCount(1);
    });

    await test.step("the actual downloaded Excel snapshot has one cancelled order and one retained line", async () => {
        await page.locator("#nav-exports").click();
        const responsePromise = page.waitForResponse((response) =>
            new URL(response.url()).pathname === "/api/export" && response.request().method() === "POST",
        );
        await page.locator("#export-button").click();
        expect((await responsePromise).ok()).toBeTruthy();
        await expect(page.locator("#download-button")).toBeEnabled();
        const downloadPromise = page.waitForEvent("download");
        await page.locator("#download-button").click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
        const workbook = testInfo.outputPath("cancelled-order.xlsx");
        await download.saveAs(workbook);
        expect(await download.failure()).toBeNull();
        expect(readFileSync(workbook).subarray(0, 2).toString()).toBe("PK");
        python("tests/e2e/verify_order_change_export.py", workbook, original.id, lineId, data.customer, data.externalId, ITEM_NAME);
        await testInfo.attach("verified-cancelled-order-workbook", { path: workbook, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    });
});

test("a real duplicate warning rolls back until explicitly acknowledged and dismissing it preserves the draft", async ({ page, request }, testInfo) => {
    const data = sample(testInfo);
    const confirmations = trackConfirmations(page);
    await login(page);
    const { order: original } = await createOrder(page, request, data);
    const originalHistory = await history(request, original.id);
    const duplicateTask = await upload(page, data, "possible-duplicate");
    await fillOrder(page, data);
    await reviewer(page, "Synthetic duplicate reviewer", "A separate invented order requires deliberate review.");
    const pending = await readJSON(request, `/api/tasks/${duplicateTask}`);

    async function triggerWarning() {
        await page.locator("#confirm-button").click();
        await expect(page.locator("#confirm-dialog")).toBeVisible();
        const responsePromise = confirmationResponse(page, duplicateTask);
        await page.locator("#confirm-submit").click();
        const response = await responsePromise;
        expect(response.status()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "DUPLICATE_WARNING", details: { order_ids: [original.id] } } });
        await expect(page.locator("#confirm-dialog")).not.toBeVisible();
        await expect(page.locator("#duplicate-dialog")).toBeVisible();
        await expect(page.locator("#duplicate-detail")).toContainText(original.id);
        await expect(page.locator("#duplicate-checkbox")).not.toBeChecked();
        await expect(page.locator("#duplicate-confirm")).toBeDisabled();
        expect(await oneOrder(request, data.customer)).toEqual(original);
        expect(await history(request, original.id)).toEqual(originalHistory);
        expect(await readJSON(request, `/api/tasks/${duplicateTask}`)).toEqual(pending);
    }

    await test.step("the unacknowledged warning and its cancellation cannot write an order", async () => {
        await triggerWarning();
        await capture(page, testInfo, "03-duplicate-warning");
        await page.locator("#duplicate-checkbox").check();
        await expect(page.locator("#duplicate-confirm")).toBeEnabled();
        await page.locator("#duplicate-checkbox").uncheck();
        await expect(page.locator("#duplicate-confirm")).toBeDisabled();
        await page.locator("#duplicate-checkbox").check();
        const count = confirmations.length;
        await page.locator("#duplicate-cancel").click();
        await expect(page.locator("#duplicate-dialog")).not.toBeVisible();
        expect(confirmations).toHaveLength(count);
        expect(await oneOrder(request, data.customer)).toEqual(original);
        expect(await readJSON(request, `/api/tasks/${duplicateTask}`)).toEqual(pending);
        await expect(page.locator("#draft-state")).toContainText("未提交");
        await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue(data.customer);
        await expect(page.locator("#editor-content").getByLabel(/^单价/)).toHaveValue("12.40");
    });

    await test.step("reopening resets consent and only an explicit acknowledgment saves the separate order", async () => {
        await triggerWarning();
        await page.locator("#duplicate-checkbox").check();
        const responsePromise = confirmationResponse(page, duplicateTask);
        await page.locator("#duplicate-confirm").click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        const result = await response.json();
        await expect(page.locator("#duplicate-dialog")).not.toBeVisible();
        await expect(page.locator("#task-status")).toHaveText("已确认");
        const submitted = confirmations.filter((entry) => entry.taskId === duplicateTask);
        expect(submitted.map((entry) => entry.body.acknowledge_duplicates)).toEqual([false, false, true]);
        expect(submitted[0].body.idempotency_key).toBe(submitted[1].body.idempotency_key);
        expect(submitted[2].body.idempotency_key).not.toBe(submitted[1].body.idempotency_key);
        const matches = await customerOrders(request, data.customer);
        expect(matches).toHaveLength(2);
        expect(matches.find((order) => order.id === original.id)).toEqual(original);
        const duplicate = matches.find((order) => order.id !== original.id);
        expect(result.orders).toEqual([duplicate.id]);
        expect(duplicate).toMatchObject({ version: 1, status: "confirmed", external_id: data.externalId });
        expect(duplicate.items).toHaveLength(1);
        expect(duplicate.items[0].line_id).not.toBe(original.items[0].line_id);
        expect(await history(request, original.id)).toEqual(originalHistory);
        expect(await history(request, duplicate.id)).toHaveLength(1);
    });
});

test("a real version conflict preserves the draft until the reviewer explicitly adopts the latest order version", async ({ page, request }, testInfo) => {
    const data = sample(testInfo);
    const confirmations = trackConfirmations(page);
    await login(page);
    const { order: original } = await createOrder(page, request, data);
    const staleTask = await upload(page, data, "stale-amendment");
    const reason = "Synthetic browser draft still proposes 3.125 boxes.";
    await chooseTarget(page, "amend", original, reason);
    await fillOrder(page, data, "3.125", original.items[0].line_id);
    await reviewer(page, "Synthetic stale reviewer", "Keep this unsubmitted draft after a conflict.");
    const pending = await readJSON(request, `/api/tasks/${staleTask}`);
    let current;
    let currentHistory;

    await test.step("a second client legitimately imports and confirms different evidence through the API", async () => {
        // The only API business mutation in this test models another reviewer.
        // It uses normal authenticated upload/confirmation, never database edits.
        const uploadResponse = await request.post("/api/uploads", {
            headers: AUTH,
            multipart: {
                source_label: `${data.sourceLabel}-second-client`,
                files: { name: "synthetic-second-client.png", mimeType: "image/png", buffer: readFileSync(data.image) },
            },
        });
        expect(uploadResponse.ok()).toBeTruthy();
        const uploaded = await uploadResponse.json();
        expect(uploaded.duplicates).toEqual([]);
        expect(uploaded.tasks).toHaveLength(1);
        const secondTaskId = uploaded.tasks[0].id;
        expect(secondTaskId).not.toBe(staleTask);
        await expect.poll(async () => (await readJSON(request, `/api/tasks/${secondTaskId}`)).status).toBe("review_required");
        const secondTask = await readJSON(request, `/api/tasks/${secondTaskId}`);
        const secondResponse = await request.post(`/api/tasks/${secondTaskId}/confirm`, {
            headers: AUTH,
            data: {
                expected_version: secondTask.version,
                idempotency_key: randomUUID(),
                actor: "Synthetic second client",
                reason: "Second reviewer verified separate invented evidence.",
                acknowledge_duplicates: false,
                events: [{
                    ...secondTask.candidate.events[0],
                    action: "amend",
                    target_order_id: original.id,
                    expected_order_version: 1,
                    customer: data.customer,
                    external_id: data.externalId,
                    currency: "CNY",
                    reason: "Synthetic second client confirmed 7.125 boxes first.",
                    items: [{ ...original.items[0], quantity: "7.125" }],
                }],
            },
        });
        expect(secondResponse.status()).toBe(200);
        expect(await secondResponse.json()).toEqual({ orders: [original.id] });
        current = await oneOrder(request, data.customer);
        expect(current).toMatchObject({ id: original.id, status: "confirmed", version: 2 });
        expect(current.items).toEqual([{ ...original.items[0], quantity: "7.125" }]);
        currentHistory = await history(request, original.id);
        expect(currentHistory).toHaveLength(2);
        expect(currentHistory[1]).toMatchObject({ task_id: secondTaskId, actor: "Synthetic second client", version: 2, action: "amend" });
    });

    await test.step("the browser submits its actual stale version and sees a real 409", async () => {
        const editor = page.locator("#editor-content");
        await expect(editor.getByLabel(/^目标订单当前版本/)).toHaveValue("1");
        await expect(editor.getByLabel(/^数量/)).toHaveValue("3.125");
        await page.locator("#confirm-button").click();
        await expect(page.locator("#confirm-summary")).toContainText("当前版本 v1");
        const responsePromise = confirmationResponse(page, staleTask);
        await page.locator("#confirm-submit").click();
        const response = await responsePromise;
        expect(response.status()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
        await expect(page.locator("#confirm-error")).toBeVisible();
        await expect(page.locator("#confirm-error")).toContainText("记录已被更新");
        await expect(page.locator("#confirm-cancel")).toBeEnabled();
        expect(await oneOrder(request, data.customer)).toEqual(current);
        expect(await history(request, original.id)).toEqual(currentHistory);
        expect(await readJSON(request, `/api/tasks/${staleTask}`)).toEqual(pending);
        await capture(page, testInfo, "04-version-conflict");
        await page.locator("#confirm-cancel").click();
        await expect(page.locator("#confirm-dialog")).not.toBeVisible();
        await expect(page.locator("#task-status")).toHaveText("待审核");
        await expect(page.locator("#draft-state")).toContainText("未提交");
        await expect(editor.getByLabel(/^目标订单 ID/)).toHaveValue(original.id);
        await expect(editor.getByLabel(/^目标订单当前版本/)).toHaveValue("1");
        await expect(editor.getByLabel(/^明细 ID/)).toHaveValue(original.items[0].line_id);
        await expect(editor.getByLabel(/^数量/)).toHaveValue("3.125");
        await expect(editor.getByLabel(/^单价/)).toHaveValue("12.40");
        await expect(editor.getByLabel(/^改单 \/ 撤单原因/)).toHaveValue(reason);
        await expect(page.locator("#review-actor")).toHaveValue("Synthetic stale reviewer");
        await expect(page.locator("#review-reason")).toHaveValue("Keep this unsubmitted draft after a conflict.");
        // Stay on the same task: navigating away could redraw the editor and
        // hide a stale comparison caused by an unchanged task version.
        await expect(editor.locator(".target-comparison")).toContainText("当前版本 v2");
        await expect(editor.locator(".target-version-status")).toContainText("版本不一致");
        const staleRequests = confirmations.filter((entry) => entry.taskId === staleTask);
        expect(staleRequests).toHaveLength(1);
        expect(staleRequests[0].body.events[0]).toMatchObject({ action: "amend", target_order_id: original.id, expected_order_version: 1, items: [{ line_id: original.items[0].line_id, quantity: "3.125", unit_price: "12.40" }] });
        expect(await oneOrder(request, data.customer)).toEqual(current);
        expect(await history(request, original.id)).toEqual(currentHistory);
        expect(await readJSON(request, `/api/tasks/${staleTask}`)).toEqual(pending);
    });

    await test.step("only explicitly adopting the latest order version allows the retained draft to save", async () => {
        const editor = page.locator("#editor-content");
        await expect(editor.locator(".target-comparison")).toContainText("当前版本 v2");
        await expect(editor.locator(".target-version-status")).toContainText("版本不一致");
        await expect(editor.getByLabel(/^目标订单当前版本/)).toHaveValue("1");
        await editor.getByRole("button", { name: "带入当前版本 v2", exact: true }).click();
        await expect(editor.getByLabel(/^目标订单当前版本/)).toHaveValue("2");
        await expect(editor.getByLabel(/^数量/)).toHaveValue("3.125");
        await expect(editor.getByLabel(/^单价/)).toHaveValue("12.40");
        await expect(editor.getByLabel(/^明细 ID/)).toHaveValue(original.items[0].line_id);
        await expect(editor.getByLabel(/^改单 \/ 撤单原因/)).toHaveValue(reason);
        const result = await confirm(page, staleTask);
        expect(result.orders).toEqual([original.id]);
        const saved = await oneOrder(request, data.customer);
        expect(saved).toMatchObject({ id: original.id, status: "confirmed", version: 3 });
        expect(saved.items).toEqual([{ ...original.items[0], quantity: "3.125" }]);
        const events = await history(request, original.id);
        expect(events).toHaveLength(3);
        expect(events.slice(0, 2)).toEqual(currentHistory);
        expect(events[2]).toMatchObject({ task_id: staleTask, actor: "Synthetic stale reviewer", reason, version: 3, action: "amend" });
        const submitted = confirmations.filter((entry) => entry.taskId === staleTask);
        expect(submitted.map((entry) => entry.body.events[0].expected_order_version)).toEqual([1, 2]);
        expect(submitted[1].body.idempotency_key).not.toBe(submitted[0].body.idempotency_key);
        expect(await readJSON(request, `/api/tasks/${staleTask}`)).toMatchObject({ status: "confirmed", version: pending.version + 1 });
        await openHistory(page, data, original.id, 3, 3);
        await expect(page.locator("#order-history-content")).toContainText("Synthetic second client");
        await expect(page.locator("#order-history-content .history-event").last()).toContainText(reason);
        await page.locator("#history-done").click();
    });
});
