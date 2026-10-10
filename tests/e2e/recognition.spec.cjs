"use strict";

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { test, expect } = require("@playwright/test");
const TOKEN = "synthetic-playwright-only-token-not-a-secret";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const API = "/api/model-settings";
// Synthetic credentials still follow the no-credential-artifact convention.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function settings(request) {
    const response = await request.get(API, { headers: AUTH });
    expect(response.ok()).toBeTruthy();
    return response.json();
}
async function reset(request) {
    const current = await settings(request);
    const response = await request.put(API, { headers: AUTH, data: {
        expected_revision: current.revision, provider: "demo", model: "", base_url: "",
        api_key_action: "delete", allow_external: false,
    } });
    expect(response.ok()).toBeTruthy();
}
async function configure(page, model = "synthetic-vision-model", allowExternal = false) {
    await page.locator("#nav-settings").click();
    await expect(page.locator("#model-provider")).toBeEnabled();
    await page.locator("#model-provider").selectOption("openai-compatible");
    await page.locator("#model-name").fill(model);
    await page.locator("#model-base-url").fill("https://models.example.com/v1");
    await page.locator("#model-key-action").selectOption("replace");
    await page.locator("#model-api-key").fill("synthetic-e2e-placeholder-key");
    await page.locator("#model-allow-external").setChecked(allowExternal);
    const saved = page.waitForResponse((r) => r.url().endsWith(API) && r.request().method() === "PUT");
    await page.locator("#model-save").click();
    expect((await saved).ok()).toBeTruthy();
    await expect(page.locator("#model-api-key")).toHaveValue("");
    await page.locator("#nav-dashboard").click();
}
async function prepare(page, image, label) {
    await page.locator("#open-upload").click();
    await page.locator("#upload-files").setInputFiles(image);
    await page.locator("#source-label").fill(label);
}
async function submit(page, enable = false) {
    page.once("dialog", async (dialog) => {
        expect(dialog.message()).toContain("https://models.example.com/v1");
        expect(dialog.message()).toContain("截图");
        expect(dialog.message()).toContain("费用");
        if (enable) expect(dialog.message()).toMatch(/开启.*外部.*调用/);
        await dialog.accept();
    });
    const response = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST");
    await page.locator("#upload-submit").click();
    const uploaded = await response;
    expect(uploaded.ok()).toBeTruthy();
    return uploaded.json();
}
async function captureSynthetic(page, testInfo, name) {
    await expect(page.locator("#model-api-key")).toHaveValue("");
    const width = await page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
    }));
    expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
    const screenshot = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function task(request, id) {
    const response = await request.get(`/api/tasks/${id}`, { headers: AUTH });
    expect(response.ok()).toBeTruthy();
    return response.json();
}
async function orderCount(request) {
    return (await (await request.get("/api/orders", { headers: AUTH })).json()).orders.length;
}
function fixture(testInfo) {
    const image = testInfo.outputPath("synthetic-recognition.png");
    execFileSync("uv", ["run", "--locked", "python", "tests/e2e/fixture.py", "image", image]);
    return image;
}

test.beforeEach(async ({ page, request, baseURL }) => {
    await reset(request);
    await page.route("**/*", async (route) => {
        expect(new URL(route.request().url()).origin).toBe(new URL(baseURL).origin);
        await route.continue();
    });
    await page.goto("/");
    await page.locator("#access-token").fill(TOKEN);
    await page.locator("#login-form button[type=submit]").click();
    await expect(page.locator("#dashboard-view")).toBeVisible();
});
test.afterEach(async ({ request }) => { await reset(request); });

test("configured image flow enables external in place, reviews evidence and exports only confirmed order", async ({ page, request }, testInfo) => {
    const image = fixture(testInfo);
    const label = `synthetic-real-flow-${randomUUID()}`;
    const before = await orderCount(request);
    await configure(page);
    const disabled = await settings(request);
    expect(disabled.allow_external).toBe(false);
    await prepare(page, image, label);
    await captureSynthetic(page, testInfo, "configured-image-upload");
    const writes = [];
    page.on("request", (r) => {
        if (r.method() === "POST" && /\/api\/(uploads|model-settings\/enable-external)$/.test(new URL(r.url()).pathname)) writes.push(r);
    });
    // Cancellation must neither persist permission nor submit the selected image.
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#upload-submit").click();
    await expect(page.locator("#upload-submit")).toBeEnabled();
    expect(writes).toHaveLength(0);
    expect((await settings(request)).allow_external).toBe(false);
    expect(await page.locator("#upload-files").evaluate((node) => node.files.length)).toBe(1);
    const uploaded = await submit(page, true);
    expect(uploaded.tasks).toHaveLength(1);
    const id = uploaded.tasks[0].id;
    expect(writes.map((r) => new URL(r.url()).pathname)).toEqual([`${API}/enable-external`, "/api/uploads"]);
    const enabled = await settings(request);
    expect(enabled.allow_external).toBe(true);
    expect(enabled.revision).toBeGreaterThan(disabled.revision);
    expect(writes[0].postDataJSON()).toMatchObject({ expected_revision: disabled.revision, confirm_external: true });
    expect(writes[1].postData()).toMatch(new RegExp(`name="config_revision"\\r\\n\\r\\n${enabled.revision}\\r\\n`));
    await expect(page.locator("#task-status")).toHaveText("待审核");
    await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue("SYNTHETIC Vision Buyer");
    await expect(page.locator("#editor-content")).not.toContainText("DEMO_SYNTHETIC");
    await page.locator(".evidence-detail summary").first().click();
    await expect(page.locator(".evidence-entry").first()).toContainText("SYNTHETIC pixels: 2.5 boxes at CNY 12.40");
    const preview = page.locator("#source-list img").first();
    await expect.poll(() => preview.evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);
    await captureSynthetic(page, testInfo, "configured-image-evidence-review");
    expect(await orderCount(request)).toBe(before);
    const recognized = await task(request, id);
    expect(recognized.candidate.events[0].items[0]).toMatchObject({ quantity: "2.5", unit_price: "12.40" });
    expect(recognized.candidate.events[0].evidence[0].source_id).toBe(recognized.sources[0].id);
    // Refresh and duplicate ingestion must retain the original candidate/task.
    await page.reload();
    await page.locator("#nav-dashboard").click();
    await prepare(page, image, label);
    const repeated = await submit(page);
    expect(repeated.duplicates).toHaveLength(1);
    expect(repeated.tasks[0].id).toBe(id);
    await expect(page.locator("#task-status")).toHaveText("待审核");
    const customer = `SYNTHETIC reviewed ${label}`;
    const externalId = `000042-${randomUUID()}`;
    const editor = page.locator("#editor-content");
    await editor.getByLabel(/^客户/).fill(customer);
    await editor.getByLabel(/^外部订单编号/).fill(externalId);
    await page.locator("#review-actor").fill("Synthetic image reviewer");
    await page.locator("#review-reason").fill("Checked synthetic evidence and candidate values.");
    await page.locator("#confirm-button").click();
    await page.locator("#confirm-cancel").click();
    expect(await orderCount(request)).toBe(before);
    await page.locator("#confirm-button").click();
    await page.locator("#confirm-submit").click();
    await expect(page.locator("#task-status")).toHaveText("已确认");
    expect(await orderCount(request)).toBe(before + 1);
    await page.locator("#nav-exports").click();
    // An older export may already be ready. Wait for this generation request,
    // not merely an enabled download control backed by that previous snapshot.
    const exportReady = page.waitForResponse((response) =>
        response.url().endsWith("/api/export") && response.request().method() === "POST",
    );
    await page.locator("#export-button").click();
    const generated = await exportReady;
    expect(generated.ok()).toBeTruthy();
    expect((await generated.json()).status).toBe("completed");
    await expect(page.locator("#download-button")).toBeEnabled();
    const downloadReady = page.waitForEvent("download");
    await page.locator("#download-button").click();
    const download = await downloadReady;
    const workbook = testInfo.outputPath("synthetic-recognition.xlsx");
    await download.saveAs(workbook);
    execFileSync("uv", ["run", "--locked", "python", "tests/e2e/fixture.py", "verify-export", workbook, customer, externalId, "SYNTHETIC Vision Box"]);
});

for (const [model, code] of [
    ["synthetic-unsupported-image", "provider_http_rejected"],
    ["synthetic-invalid-json", "provider_schema_invalid"],
    ["synthetic-timeout", "provider_timeout"],
]) {
    test(`${model} fails safely and explicit retry uses changed model configuration`, async ({ page, request }, testInfo) => {
        const image = fixture(testInfo);
        const before = await orderCount(request);
        await configure(page, model);
        await prepare(page, image, `synthetic-failure-${randomUUID()}`);
        const result = await submit(page, true);
        const id = result.tasks[0].id;
        await expect(page.locator("#task-status")).toHaveText("识别失败");
        await expect(page.locator("#editor-content")).toContainText(code);
        await expect(page.locator("#review-form")).not.toBeVisible();
        expect((await task(request, id)).candidate).toBeNull();
        expect(await orderCount(request)).toBe(before);
        const retries = [];
        page.on("request", (r) => { if (r.url().endsWith(`/api/tasks/${id}/retry`)) retries.push(r); });
        page.once("dialog", (dialog) => dialog.dismiss());
        await page.getByRole("button", { name: "重新识别", exact: true }).click();
        await expect(page.getByRole("button", { name: "重新识别", exact: true })).toBeEnabled();
        expect(retries).toHaveLength(0);
        await configure(page, "synthetic-vision-model", false);
        await page.locator("#nav-review").click();
        await page.locator(`.task-card[data-task-id="${id}"]`).click();
        page.once("dialog", async (dialog) => {
            expect(dialog.message()).toContain("synthetic-vision-model");
            expect(dialog.message()).toMatch(/开启.*外部.*调用/);
            await dialog.accept();
        });
        await page.getByRole("button", { name: "重新识别", exact: true }).click();
        await expect(page.locator("#task-status")).toHaveText("待审核");
        expect(retries).toHaveLength(1);
        expect(retries[0].postDataJSON()).toMatchObject({ confirm_external: true, config_revision: (await settings(request)).revision });
        await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue("SYNTHETIC Vision Buyer");
        expect(await orderCount(request)).toBe(before);
    });
}
