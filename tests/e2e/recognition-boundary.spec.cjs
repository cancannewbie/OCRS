
"use strict";

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { test, expect } = require("@playwright/test");
const TOKEN = "synthetic-playwright-only-token-not-a-secret";
const AUTH = { Authorization: "Bearer " + TOKEN };
test.use({ trace: "off", screenshot: "off", video: "off" });

async function read(request, route) {
    const response = await request.get(route, { headers: AUTH });
    expect(response.ok()).toBeTruthy();
    return response.json();
}
async function configure(request, provider) {
    const saved = await read(request, "/api/model-settings");
    const response = await request.put("/api/model-settings", { headers: AUTH, data: {
        expected_revision: saved.revision, provider,
        model: provider === "demo" ? "" : "synthetic-unmapped-model",
        base_url: provider === "demo" ? "" : "https://models.example.com/v1",
        api_key_action: provider === "demo" ? "delete" : "replace",
        api_key: provider === "demo" ? null : "synthetic-boundary-placeholder",
        allow_external: provider !== "demo",
    } });
    expect(response.ok()).toBeTruthy();
}
async function capture(page, testInfo, name) {
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
    const path = testInfo.outputPath(name + ".png");
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
}
async function tabTo(page, target) {
    for (let count = 0; count < 80; count += 1) {
        if (await target.evaluate(node => node === document.activeElement)) return;
        await page.keyboard.press("Tab");
    }
    throw new Error("Keyboard could not reach target " + await target.getAttribute("id"));
}

test.afterEach(async ({ request }) => { await configure(request, "demo"); });

test("source-independent results keep unmapped and missing values before optional review, with keyboard API access", async ({ page, request, baseURL }, testInfo) => {
    await configure(request, "openai-compatible");
    await page.route("**/*", async route => {
        expect(new URL(route.request().url()).origin).toBe(new URL(baseURL).origin);
        await route.continue();
    });
    const label = "synthetic-boundary-" + randomUUID();
    const path = testInfo.outputPath("synthetic-boundary.png");
    execFileSync("uv", ["run", "--locked", "python", "tests/e2e/fixture.py", "image", path]);
    const before = (await read(request, "/api/orders")).orders.length;
    await page.goto("/");
    await page.locator("#access-token").fill(TOKEN);
    await page.locator("#login-button").click();
    await expect(page.locator("#nav-dashboard")).toContainText("上传识别");
    await expect(page.locator("#inbox-banner")).not.toBeVisible();
    await capture(page, testInfo, "recognition-upload-home");
    await tabTo(page, page.locator("#open-upload"));
    await page.keyboard.press("Enter");
    await expect(page.locator("#upload-dialog")).toBeVisible();
    await page.locator("#upload-files").setInputFiles(path);
    await page.locator("#source-label").fill(label);
    await capture(page, testInfo, "recognition-upload-dialog");
    page.once("dialog", async dialog => {
        expect(dialog.message()).toContain("https://models.example.com/v1");
        expect(dialog.message()).toContain("本次选定的 1 张完整截图");
        await dialog.accept();
    });
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/recognitions" && response.request().method() === "POST");
    await tabTo(page, page.locator("#upload-submit"));
    await page.keyboard.press("Enter");
    const accepted = await responsePromise;
    expect(accepted.status()).toBe(202);
    const id = (await accepted.json()).task_id;
    await expect(page.locator("#results-view")).toBeVisible();
    await expect(page.locator("#result-detail")).toContainText("SYNTHETIC-UNMAPPED");
    await expect(page.locator("#result-detail")).toContainText("未知 / 未提供（null）");
    await expect(page.locator("#result-detail")).toContainText("未经人工核实");
    await expect(page.locator("#result-detail")).toContainText("原文证据");
    await expect(page.locator("#review-view")).not.toBeVisible();
    const originalImage = page.locator("#result-detail img").first();
    await expect.poll(() => originalImage.evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true);
    await expect(page.locator("#result-detail").getByRole("link", { name: "查看原图" })).toHaveAttribute("href", /^blob:/);
    expect((await read(request, "/api/orders")).orders.length).toBe(before);
    const raw = await read(request, "/api/recognitions/" + id + "/result");
    expect(raw.verified).toBe(false);
    expect(raw.result.events[0].items[0]).toMatchObject({ sku: "SYNTHETIC-UNMAPPED", quantity: null, unit_price: null });
    await expect(page.locator("#result-detail")).toBeFocused();
    await tabTo(page, page.locator("#result-detail summary"));
    await page.keyboard.press("Enter");
    await expect(page.locator("#result-detail details")).toHaveAttribute("open", "");
    await capture(page, testInfo, "recognition-raw-result");

    const task = await read(request, "/api/tasks/" + id);
    const correction = structuredClone(task.candidate);
    correction.events[0].customer = "SYNTHETIC Optional Correction";
    const saved = await request.put("/api/tasks/" + id + "/candidate", { headers: AUTH, data: {
        expected_version: task.version, idempotency_key: "synthetic-correction-" + randomUUID(),
        candidate: correction, actor: "Synthetic optional reviewer", reason: "Synthetic correction only; raw model values remain original.",
    } });
    expect(saved.ok()).toBeTruthy();
    expect((await read(request, "/api/recognitions/" + id + "/result")).result).toEqual(raw.result);
    await page.locator("#refresh-button").click();
    await expect(page.locator("#result-detail")).not.toContainText("SYNTHETIC Optional Correction");
    await tabTo(page, page.locator("#result-review"));
    await page.keyboard.press("Enter");
    await expect(page.locator("#review-view")).toBeVisible();
    await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue("SYNTHETIC Optional Correction");
    expect((await read(request, "/api/orders")).orders.length).toBe(before);

    await tabTo(page, page.locator("#nav-api"));
    await page.keyboard.press("Enter");
    await expect(page.locator("#api-view")).toBeVisible();
    await expect(page.locator("#api-view")).toContainText("file=@synthetic.png");
    await expect(page.locator("#api-view")).toContainText("requests.post");
    await capture(page, testInfo, "recognition-api-guide");
    await tabTo(page, page.locator("#api-schema"));
    await page.keyboard.press("Enter");
    await expect(page.locator("#api-schema-content")).toContainText('"/api/recognitions"');
    await expect(page.locator("#api-schema-content")).toBeFocused();
    await capture(page, testInfo, "recognition-api-schema");
});
