"use strict";

const { test, expect } = require("@playwright/test");
const TOKEN = "synthetic-playwright-only-token-not-a-secret";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const API = "/api/model-settings";
// No credential entry or write request is recorded in browser artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function readSettings(request) {
    const response = await request.get(API, { headers: AUTH });
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    expect(saved).not.toHaveProperty("api_key");
    return saved;
}

async function resetDemo(request) {
    const saved = await readSettings(request);
    const response = await request.put(API, { headers: AUTH, data: {
        expected_revision: saved.revision, provider: "demo", model: "", base_url: "",
        allow_external: false, api_key_action: "delete",
    } });
    expect(response.ok()).toBeTruthy();
}

test.beforeEach(async ({ request, page, baseURL }) => {
    await resetDemo(request);
    await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== new URL(baseURL).origin) {
            await route.abort("blockedbyclient");
            throw new Error("The settings browser must stay on loopback");
        }
        await route.continue();
    });
    await page.goto("/");
    await page.locator("#access-token").fill(TOKEN);
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#nav-settings").click();
    await expect(page.locator("#model-provider")).toBeEnabled();
});
test.afterEach(async ({ request }) => { await resetDemo(request); });

async function fillModel(page) {
    await page.locator("#model-provider").selectOption("openai-compatible");
    await page.locator("#model-name").fill("synthetic-vision-model");
    await page.locator("#model-base-url").fill("https://models.example.com/v1");
    await page.locator("#model-key-action").selectOption("replace");
    // A public invented value valid only in disposable storage, never a real key.
    await page.locator("#model-api-key").fill("synthetic-e2e-placeholder-key");
    await page.locator("#model-allow-external").check();
}

async function save(page) {
    const response = page.waitForResponse((item) => item.url().endsWith(API) && item.request().method() === "PUT");
    await page.locator("#model-save").click();
    expect((await response).ok()).toBeTruthy();
    await expect(page.locator("#model-api-key")).toHaveValue("");
}

test("real settings persistence, write-only keys, explicit offline test, deletion and reload", async ({ page, request }) => {
    const calls = [];
    page.on("request", (item) => { if (new URL(item.url()).pathname === `${API}/test`) calls.push(item.method()); });
    await expect(page.locator("#model-settings-state")).toContainText("Demo");
    await page.locator("#model-provider").selectOption("minimax-cn");
    await expect(page.locator("#model-base-url")).toHaveValue("https://api.minimax.cn/v1");
    await expect(page.locator("#model-name")).toHaveValue("MiniMax-M3");
    await expect(page.locator("#model-base-url")).toBeDisabled();
    await expect(page.locator("#model-name")).toBeDisabled();
    await fillModel(page);
    await expect(page.locator("#model-test")).toBeDisabled();
    await save(page);
    expect(calls).toEqual([]);
    await expect(page.locator("#model-settings-state")).toContainText("已配置");
    expect(await readSettings(request)).toMatchObject({ provider: "openai-compatible", api_key_configured: true, test_status: "not_tested" });
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual(["ocrs_access_token"]);
    await page.reload();
    await page.locator("#nav-settings").click();
    await expect(page.locator("#model-name")).toHaveValue("synthetic-vision-model");
    await expect(page.locator("#model-key-status")).toContainText("后端已保存密钥");
    await expect(page.locator("#model-api-key")).toHaveValue("");
    await page.locator("#model-test").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#model-test-cancel")).toBeFocused();
    await expect(page.locator("#model-test-destination")).toContainText("https://models.example.com/v1");
    await expect(page.locator("#model-test-dialog")).toContainText("费用");
    for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press("Tab");
        expect(await page.locator("#model-test-dialog").evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#model-test")).toBeFocused();
    expect(calls).toEqual([]);
    await page.locator("#model-test").click();
    await page.locator("#model-test-confirm").click();
    await expect(page.locator("#model-settings-result")).toContainText("测试成功");
    expect(calls).toEqual(["POST"]);
    expect((await readSettings(request)).test_status).toBe("passed");
    await page.locator("#model-key-action").selectOption("delete");
    await save(page);
    await expect(page.locator("#model-settings-state")).toContainText("尚未配置完整");
    expect((await readSettings(request)).api_key_configured).toBe(false);
    await expect(page.locator("#model-test")).toBeDisabled();
    await expect(page.locator("body")).not.toContainText("synthetic-e2e-placeholder-key");
    const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
});

test("validation and revision conflict preserve changes; navigation cancellation and logout clear credentials", async ({ page, request }) => {
    await fillModel(page);
    await page.locator("#model-base-url").fill("http://127.0.0.1:9000/v1");
    await page.locator("#model-save").click();
    await expect(page.locator("#model-settings-error")).toBeVisible();
    await expect(page.locator("#model-settings-error")).toBeFocused();
    // Check only presence, not the entered password in assertion artifacts.
    expect(await page.locator("#model-api-key").evaluate((node) => node.value.length > 0)).toBe(true);
    await page.locator("#model-base-url").fill("https://models.example.com/v1");
    await resetDemo(request); // Simulates another settings tab publishing a revision.
    await page.locator("#model-save").click();
    await expect(page.locator("#model-settings-error")).toContainText("重新读取");
    await expect(page.locator("#model-name")).toHaveValue("synthetic-vision-model");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#nav-dashboard").click();
    await expect(page.locator("#settings-view")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#nav-dashboard").click();
    await expect(page.locator("#dashboard-view")).toBeVisible();
    await expect(page.locator("#model-api-key")).toHaveValue("");
    await page.locator("#nav-settings").click();
    await fillModel(page);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#logout-button:visible, #logout-mobile:visible").click();
    await expect(page.locator("#login-screen")).toBeVisible();
    await expect(page.locator("#model-api-key")).toHaveValue("");
    await expect(page.locator("#model-name")).toHaveValue("");
});

test("failed synthetic probe stays explicit and does not claim OCR validation", async ({ page }) => {
    await fillModel(page); await save(page);
    let probes = 0;
    await page.route("**/api/model-settings/test", async (route) => {
        probes += 1;
        const response = await page.request.get(API, { headers: AUTH });
        const current = await response.json();
        await route.fulfill({ json: { ...current, test_status: "failed", test_message: "synthetic ignored provider details" } });
    });
    await page.locator("#model-test").click();
    await page.locator("#model-test-confirm").click();
    await expect(page.locator("#model-settings-result")).toContainText("测试失败");
    await expect(page.locator("#model-settings-result")).not.toContainText("测试成功");
    await expect(page.locator("#model-test-dialog")).not.toBeVisible();
    await expect(page.locator("body")).not.toContainText("synthetic ignored provider details");
    expect(probes).toBe(1);
    await expect(page.locator("#model-test")).toBeEnabled();
});
