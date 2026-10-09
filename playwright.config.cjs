"use strict";

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./tests/e2e",
    testMatch: "**/*.spec.cjs",
    fullyParallel: false,
    // A single temporary SQLite service owns its writer lock for the whole run.
    workers: 1,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    timeout: 120_000,
    expect: { timeout: 15_000 },
    outputDir: "test-results",
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: "http://127.0.0.1:8765",
        browserName: "chromium",
        locale: "zh-CN",
        timezoneId: "UTC",
        colorScheme: "light",
        reducedMotion: "reduce",
        acceptDownloads: true,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        actionTimeout: 15_000,
        navigationTimeout: 30_000,
    },
    projects: [
        { name: "chromium-390", use: { viewport: { width: 390, height: 844 } } },
        { name: "chromium-1366", use: { viewport: { width: 1366, height: 900 } } },
        { name: "chromium-1440", use: { viewport: { width: 1440, height: 1000 } } },
    ],
    webServer: {
        command: "uv run --locked python tests/e2e/serve.py",
        url: "http://127.0.0.1:8765",
        // Never attach acceptance tests to an existing user's OCRS instance.
        reuseExistingServer: false,
        timeout: 60_000,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
    },
});
