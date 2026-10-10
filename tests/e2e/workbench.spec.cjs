"use strict";

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test: base, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
const TOKEN = "synthetic-playwright-only-token-not-a-secret";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const ITEM_NAME = "=SYNTHETIC_ITEM()";

const test = base.extend({
    page: async ({ page, baseURL }, use) => {
        const pageErrors = [];
        const externalRequests = [];
        const credentialURLs = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("request", (request) => {
            if (request.url().includes(TOKEN)) credentialURLs.push(request.url());
        });
        // Exercise real loopback HTTP, but fail closed if any frontend code
        // attempts an external font, image, telemetry call, or model request.
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
        expect(pageErrors, "The real browser must not encounter application exceptions").toEqual([]);
        expect(externalRequests, "Acceptance must remain on the local test server").toEqual([]);
        expect(credentialURLs, "The access token must never appear in request URLs").toEqual([]);
    },
});

function fixture(...arguments_) {
    execFileSync("uv", ["run", "--locked", "python", "tests/e2e/fixture.py", ...arguments_], {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 30_000,
    });
}

async function orders(request) {
    const response = await request.get("/api/orders", { headers: AUTH });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).orders;
}

async function tabTo(page, locator) {
    await expect(locator).toBeVisible();
    // Deliberately traverse native Tab order; locator.focus() would hide
    // inaccessible controls and regressions in keyboard reachability.
    for (let index = 0; index < 80; index += 1) {
        if (await locator.evaluate((node) => node === document.activeElement)) return;
        await page.keyboard.press("Tab");
    }
    throw new Error(`Control is not reachable by Tab: ${await locator.getAttribute("id")}`);
}

async function keyboardActivate(page, locator) {
    await tabTo(page, locator);
    await page.keyboard.press("Enter");
}

async function noPageOverflow(page) {
    const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        root: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
    }));
    // A local evidence/table scroller may be wider; the page itself must fit.
    expect(dimensions.root, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function capture(page, testInfo, name) {
    await noPageOverflow(page);
    const screenshot = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function upload(page, image, sourceLabel) {
    const dialog = page.locator("#upload-dialog");
    await expect(dialog).toBeVisible();
    await page.locator("#upload-files").setInputFiles(image);
    await page.locator("#source-label").fill(sourceLabel);
    const responsePromise = page.waitForResponse((response) =>
        response.url().endsWith("/api/uploads") && response.request().method() === "POST",
    );
    await page.locator("#upload-submit").click();
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.duplicates).toEqual([]);
    expect(result.tasks).toHaveLength(1);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("#review-view")).toBeVisible();
    await expect(page.locator("#review-form")).toBeVisible();
    await expect(page.locator("#task-status")).toHaveText("待审核");
    const sourceImage = page.locator("#source-list img").first();
    await expect(sourceImage).toBeVisible();
    await expect.poll(() => sourceImage.evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);
    return result.tasks[0].id;
}

test("synthetic evidence becomes a reviewed order and a verified Excel download", async ({ page, request }, testInfo) => {
    const run = `${testInfo.project.name}-${randomUUID().slice(0, 8)}`;
    const sourceLabel = `synthetic-e2e-${run}`;
    const customer = `SYNTHETIC Customer ${run}`;
    const externalId = `000042-${run}`;
    const image = testInfo.outputPath("synthetic-order.png");
    const confirmationRequests = [];
    page.on("request", (request_) => {
        if (/\/api\/tasks\/[^/]+\/confirm$/.test(new URL(request_.url()).pathname))
            confirmationRequests.push(request_);
    });
    fixture("image", image);
    const initialOrders = await orders(request);

    await test.step("login is protected and opens the demo dashboard", async () => {
        expect((await request.get("/api/orders")).status()).toBe(401);
        await page.goto("/");
        await expect(page.locator("#login-screen")).toBeVisible();
        await expect(page.locator("#workspace")).not.toBeVisible();
        await capture(page, testInfo, "01-login");
        await tabTo(page, page.locator("#access-token"));
        await page.locator("#access-token").fill("synthetic-invalid-token");
        await page.keyboard.press("Enter");
        await expect(page.locator("#login-error")).toBeVisible();
        await expect(page.locator("#workspace")).not.toBeVisible();
        await page.locator("#access-token").fill(TOKEN);
        await page.keyboard.press("Enter");
        await expect(page.locator("#dashboard-view")).toBeVisible();
        await expect(page.locator("#nav-dashboard")).toHaveAttribute("aria-current", "page");
        await expect(page.locator("#demo-banner")).toBeVisible();
        await expect(page.locator("#demo-banner")).toContainText("不执行 OCR");
        await capture(page, testInfo, "02-dashboard");
    });

    await test.step("upload dialog is keyboard reachable, traps focus, and restores it on Escape", async () => {
        await keyboardActivate(page, page.locator("#open-upload"));
        await expect(page.locator("#upload-dialog")).toBeVisible();
        for (let index = 0; index < 12; index += 1) {
            await page.keyboard.press("Tab");
            expect(await page.locator("#upload-dialog").evaluate((node) => node.contains(document.activeElement))).toBe(true);
        }
        await capture(page, testInfo, "03-upload-dialog");
        await page.keyboard.press("Escape");
        await expect(page.locator("#upload-dialog")).not.toBeVisible();
        await expect(page.locator("#open-upload")).toBeFocused();
        await page.keyboard.press("Enter");
    });

    let primaryTask;
    let pendingTask;
    let savedOrderId;
    await test.step("upload real synthetic pixels and retain an edited draft across task navigation", async () => {
        primaryTask = await upload(page, image, `${sourceLabel}-primary`);
        const editor = page.locator("#editor-content");
        await expect(editor.getByLabel(/^客户/)).toHaveValue("DEMO ONLY — fictional customer");
        await editor.getByLabel(/^客户/).fill(customer);
        await editor.getByLabel(/^外部订单编号/).fill(externalId);
        await editor.getByLabel(/^商品名称/).fill(ITEM_NAME);
        await editor.getByLabel(/^SKU/).fill("DEMO-001");
        await editor.getByLabel(/^数量/).fill("2.5");
        await editor.getByLabel(/^单位/).fill("box");
        await editor.getByLabel(/^单价/).fill("12.40");
        await page.locator("#review-actor").fill("Synthetic browser reviewer");
        await page.locator("#review-reason").fill("Verified invented evidence for offline acceptance.");
        await expect(page.locator("#draft-state")).toContainText("未提交");
        await page.locator("#back-to-queue").click();
        await expect(page.locator("#task-workspace")).not.toBeVisible();
        await page.locator("#review-upload").click();
        pendingTask = await upload(page, image, `${sourceLabel}-pending`);
        expect(pendingTask).not.toBe(primaryTask);
        await page.locator("#next-task").click();
        await expect(editor.getByLabel(/^客户/)).toHaveValue(customer);
        await expect(page.locator("#review-actor")).toHaveValue("Synthetic browser reviewer");
        await page.locator("#previous-task").click();
        await expect(editor.getByLabel(/^客户/)).toHaveValue("DEMO ONLY — fictional customer");
        await page.locator("#next-task").click();
        await expect(editor.getByLabel(/^客户/)).toHaveValue(customer);
        await page.locator("#back-to-queue").click();
        await page.locator("#queue-filter").selectOption("review_required");
        await page.locator("#queue-search").fill(sourceLabel);
        await expect(page.locator("#task-list .task-card")).toHaveCount(2);
        await capture(page, testInfo, "04-review-queue");
        await page.locator("#queue-search").fill(`${sourceLabel}-missing`);
        await expect(page.locator("#task-list .task-card")).toHaveCount(0);
        await page.locator("#queue-search").fill(`${sourceLabel}-primary`);
        const row = page.locator(`#task-list .task-card[data-task-id="${primaryTask}"]`);
        await expect(row).toBeVisible();
        await keyboardActivate(page, row);
        await expect(page.locator("#task-workspace")).toBeVisible();
        await expect(editor.getByLabel(/^客户/)).toHaveValue(customer);
        await page.locator("#zoom-in").click();
        await expect(page.locator("#zoom-value")).toContainText("%");
        await noPageOverflow(page);
        await page.locator("#zoom-out").click();
        await page.locator("#zoom-fit").click();
        await expect(page.locator("#zoom-value")).toHaveText("适合宽度");
        await capture(page, testInfo, "05-review-detail");
    });

    await test.step("review requires a separate human confirmation and cancellation does not save", async () => {
        await keyboardActivate(page, page.locator("#confirm-button"));
        await expect(page.locator("#confirm-dialog")).toBeVisible();
        await expect(page.locator("#confirm-summary")).toContainText(customer);
        expect(confirmationRequests).toHaveLength(0);
        await capture(page, testInfo, "06-confirm-dialog");
        await page.keyboard.press("Escape");
        await expect(page.locator("#confirm-dialog")).not.toBeVisible();
        await expect(page.locator("#confirm-button")).toBeFocused();
        expect(await orders(request)).toHaveLength(initialOrders.length);
        await page.keyboard.press("Enter");
        await expect(page.locator("#confirm-dialog")).toBeVisible();
        await page.locator("#confirm-cancel").click();
        await expect(page.locator("#confirm-button")).toBeFocused();
        expect(confirmationRequests).toHaveLength(0);
        expect(await orders(request)).toHaveLength(initialOrders.length);
        await page.keyboard.press("Enter");
        const responsePromise = page.waitForResponse((response) =>
            response.url().endsWith(`/api/tasks/${primaryTask}/confirm`),
        );
        await page.locator("#confirm-submit").click();
        expect((await responsePromise).status()).toBe(200);
        await expect(page.locator("#confirm-dialog")).not.toBeVisible();
        await expect(page.locator("#task-status")).toHaveText("已确认");
        expect(confirmationRequests).toHaveLength(1);
        const savedOrders = await orders(request);
        expect(savedOrders).toHaveLength(initialOrders.length + 1);
        const saved = savedOrders.filter((order) => order.customer === customer);
        expect(saved).toHaveLength(1);
        savedOrderId = saved[0].id;
        expect(saved[0]).toMatchObject({ status: "confirmed", version: 1, external_id: externalId });
        expect(saved[0].items[0]).toMatchObject({ name: ITEM_NAME, quantity: "2.5", unit_price: "12.40" });
        const pending = await request.get(`/api/tasks/${pendingTask}`, { headers: AUTH });
        expect(pending.ok()).toBeTruthy();
        expect((await pending.json()).status).toBe("review_required");
    });

    await test.step("formal order search and status filtering show the saved values", async () => {
        await keyboardActivate(page, page.locator("#nav-orders"));
        await expect(page.locator("#orders-view")).toBeVisible();
        await page.locator("#order-search").fill(customer);
        await page.locator("#order-filter").selectOption({ label: "有效订单" });
        await expect(page.locator("#orders-content")).toContainText(customer);
        await expect(page.locator("#orders-content")).toContainText(externalId);
        await expect(page.locator("#orders-content")).toContainText("12.40");
        await expect(page.locator("#order-count")).toContainText("1");
        await capture(page, testInfo, "07-formal-orders");
        await page.locator("#order-filter").selectOption("cancelled");
        await expect(page.locator("#orders-content")).not.toContainText(customer);
        await page.locator("#order-filter").selectOption("all");
        await expect(page.locator("#orders-content")).toContainText(customer);
        const historyButton = page.locator(`#orders-content [data-order-id="${savedOrderId}"]`);
        await keyboardActivate(page, historyButton);
        await expect(page.locator("#order-history-dialog")).toBeVisible();
        await expect(page.locator("#order-history-content")).toContainText("Synthetic browser reviewer");
        await expect(page.locator("#order-history-content")).toContainText("Verified invented evidence for offline acceptance.");
        await capture(page, testInfo, "08-order-history");
        await page.keyboard.press("Escape");
        await expect(page.locator("#order-history-dialog")).not.toBeVisible();
        await expect(historyButton).toBeFocused();
    });

    await test.step("Excel download contains confirmed records with exact decimals and safe text", async () => {
        await keyboardActivate(page, page.locator("#nav-exports"));
        await expect(page.locator("#exports-view")).toBeVisible();
        const exportResponse = page.waitForResponse((response) =>
            response.url().endsWith("/api/export") && response.request().method() === "POST",
        );
        await page.locator("#export-button").click();
        expect((await exportResponse).ok()).toBeTruthy();
        await expect(page.locator("#download-button")).toBeEnabled();
        await capture(page, testInfo, "09-export-center");
        const downloadPromise = page.waitForEvent("download");
        await page.locator("#download-button").click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
        const workbook = testInfo.outputPath("confirmed-orders.xlsx");
        await download.saveAs(workbook);
        expect(await download.failure()).toBeNull();
        expect(readFileSync(workbook).subarray(0, 2).toString()).toBe("PK");
        fixture("verify-export", workbook, customer, externalId, ITEM_NAME);
        await testInfo.attach("verified-synthetic-workbook", {
            path: workbook,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
    });

    await test.step("editable settings and diagnostics are accurate and logout clears the local session", async () => {
        await keyboardActivate(page, page.locator("#nav-settings"));
        await expect(page.locator("#settings-view")).toBeVisible();
        await expect(page.locator("#settings-config")).toContainText(/demo/i);
        await expect(page.locator("#settings-config")).toContainText("DEMO-001");
        await expect(page.locator("#model-provider")).toBeEnabled();
        await expect(page.locator("#model-api-key")).toHaveValue("");
        await expect(page.locator("#model-settings-state")).toContainText("Demo");
        await expect(page.locator("body")).not.toContainText(TOKEN);
        await capture(page, testInfo, "10-runtime-settings");
        await keyboardActivate(page, page.locator("#logout-button:visible, #logout-mobile:visible"));
        await expect(page.locator("#login-screen")).toBeVisible();
        await expect(page.locator("#workspace")).not.toBeVisible();
        expect(await page.evaluate(() => sessionStorage.getItem("ocrs_access_token"))).toBeNull();
        await page.reload();
        await expect(page.locator("#login-screen")).toBeVisible();
        await expect(page.locator("#workspace")).not.toBeVisible();
        expect((await request.get("/api/orders")).status()).toBe(401);
    });
});
