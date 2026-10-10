"use strict";

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test: base, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
// Public invented credential for the disposable loopback service only.
const TOKEN = "synthetic-playwright-only-token-not-a-secret";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const test = base.extend({
    page: async ({ page, baseURL }, use) => {
        const errors = [];
        const externalRequests = [];
        const credentialURLs = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
            if (request.url().includes(TOKEN)) credentialURLs.push(request.url());
        });
        // Business HTTP responses stay real; only accidental external traffic is blocked.
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
        expect(errors, "Review edits must not raise browser application exceptions").toEqual([]);
        expect(externalRequests, "The browser must stay on the isolated loopback service").toEqual([]);
        expect(credentialURLs, "The local credential must never appear in a URL").toEqual([]);
    },
});

async function readJSON(request, route) {
    const response = await request.get(route, { headers: AUTH });
    expect(response.ok(), `Read ${route}`).toBeTruthy();
    return response.json();
}

async function task(request, id) {
    return readJSON(request, `/api/tasks/${id}`);
}

async function resetDemo(request) {
    const settings = await readJSON(request, "/api/model-settings");
    const response = await request.put("/api/model-settings", { headers: AUTH, data: {
        expected_revision: settings.revision, provider: "demo", model: "", base_url: "",
        allow_external: false, api_key_action: "delete",
    } });
    expect(response.ok()).toBeTruthy();
}

function sample(testInfo) {
    const label = `synthetic-review-${testInfo.project.name}-${randomUUID()}`;
    const image = testInfo.outputPath("synthetic-review-evidence.png");
    execFileSync("uv", ["run", "--locked", "python", "tests/e2e/fixture.py", "image", image], {
        cwd: ROOT, stdio: "pipe", timeout: 30_000,
    });
    return { label, image, buffer: readFileSync(image) };
}

async function upload(request, data, suffix = "primary") {
    const response = await request.post("/api/uploads", { headers: AUTH, multipart: {
        files: { name: "synthetic-review-evidence.png", mimeType: "image/png", buffer: data.buffer },
        source_label: `${data.label}-${suffix}`,
    } });
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.duplicates).toEqual([]);
    expect(result.tasks).toHaveLength(1);
    return result.tasks[0].id;
}

async function ready(request, id) {
    await expect.poll(async () => (await task(request, id)).status).toBe("review_required");
    return task(request, id);
}

async function login(page) {
    await page.goto("/");
    await page.locator("#access-token").fill(TOKEN);
    await page.locator("#login-button").click();
    await expect(page.locator("#dashboard-view")).toBeVisible();
}

async function queue(page, label, status = "all") {
    await page.locator("#nav-review").click();
    // Search is debounced: aria-busy can still be false for the previous query.
    // Wait for this exact real server query before interacting with its rows.
    const loaded = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/tasks" && url.searchParams.get("q") === label
            && (url.searchParams.get("status") || "all") === status;
    });
    await page.locator("#queue-filter").selectOption(status);
    await page.locator("#queue-search").fill(label);
    expect((await loaded).ok()).toBeTruthy();
    await expect(page.locator("#task-list")).toHaveAttribute("aria-busy", "false");
}

async function openEdit(page, id) {
    const loaded = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/tasks/${id}`
        && response.request().method() === "GET",
    );
    await page.locator(`.task-edit[data-task-id="${id}"]`).click();
    expect((await loaded).ok()).toBeTruthy();
    await expect(page.locator("#task-workspace")).toBeVisible();
    await expect(page.locator("#editor-content").getByLabel(/^客户/)).toBeEditable();
    await expect(page.locator("#task-meta")).toContainText(id.slice(0, 10));
}

async function fillCorrection(page, customer, reason) {
    const editor = page.locator("#editor-content");
    await editor.getByLabel(/^客户/).fill(customer);
    await editor.getByLabel(/^外部订单编号/).fill(`000042-${customer}`);
    await editor.getByLabel(/^数量/).fill("3.125");
    await editor.getByLabel(/^单价/).fill("12.40");
    await page.locator("#review-actor").fill("Synthetic correction reviewer");
    await page.locator("#review-reason").fill(reason);
}

function trackMutations(page) {
    const calls = [];
    page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (/^\/api\/tasks\/[^/]+\/(candidate|reopen|retry|confirm)$/.test(pathname)
            && ["POST", "PUT"].includes(request.method())) {
            calls.push({ pathname, method: request.method(), body: request.postDataJSON() });
        }
    });
    return calls;
}

async function capture(page, testInfo, name) {
    const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        root: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
    }));
    expect(dimensions.root, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport + 1);
    // A full-page capture should start at the document origin; otherwise fixed
    // controls above the viewport can appear inside the expanded screenshot.
    await page.evaluate(() => window.scrollTo(0, 0));
    const screenshot = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function doubleSubmit(page, id, action, button) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const endpoint = `/api/tasks/${id}/${action}`;
    const routePattern = `**${endpoint}`;
    // Hold the real HTTP request so both synchronous clicks exercise the UI busy lock.
    await page.route(routePattern, async (route) => { await gate; await route.continue(); });
    const sent = page.waitForRequest((request) => new URL(request.url()).pathname === endpoint);
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint);
    await page.locator(button).evaluate((node) => { node.click(); node.click(); });
    const request = await sent;
    await expect(page.locator(button)).toBeDisabled();
    release();
    const response = await responsePromise;
    await page.unroute(routePattern);
    expect(response.status()).toBe(200);
    return { receipt: await response.json(), body: request.postDataJSON() };
}

async function unchangedRecognition(before, after) {
    for (const field of ["attempts", "provider", "model_revision", "external_authorized", "sources"])
        expect(after[field], `${field} must not change during human review`).toEqual(before[field]);
    expect(after.model_candidate).toEqual(before.model_candidate);
}

test.beforeEach(async ({ request }) => { await resetDemo(request); });
test.afterEach(async ({ request }) => { await resetDemo(request); });

test("rejected evidence can be corrected, explicitly reopened once, and retains its original model and audit", async ({ page, request }, testInfo) => {
    const data = sample(testInfo);
    const id = await upload(request, data);
    const original = await ready(request, id);
    const beforeOrders = (await readJSON(request, "/api/orders")).orders;
    const beforeExport = (await readJSON(request, "/api/status")).export;
    const calls = trackMutations(page);
    const rejection = "Synthetic evidence needs a human quantity correction.";
    const correction = "Checked invented evidence; quantity is 3.125.";
    const reopening = "Synthetic correction is ready for a new human review.";
    const customer = `SYNTHETIC Corrected ${data.label}`;
    await login(page);
    await queue(page, data.label);
    await expect(page.locator("#task-list .task-card")).toHaveCount(1);
    await page.locator(`.task-card[data-task-id="${id}"]`).click();
    await page.locator("#reject-button").click();
    await page.locator("#reject-reason").fill(rejection);
    const rejectionResponse = page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${id}/reject`));
    await page.locator("#reject-submit").click();
    expect((await rejectionResponse).status()).toBe(200);
    await expect(page.locator("#task-status")).toHaveText("已驳回");
    const rejected = await task(request, id);
    expect(rejected.candidate).toEqual(original.candidate);
    expect(rejected.review_history).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "rejected", reason: rejection }),
    ]));
    await page.locator("#back-to-queue").click();
    await page.locator("#queue-filter").selectOption("rejected");
    await openEdit(page, id);

    await test.step("cancelling an edit discards only local changes and reopening requires a deliberate submission", async () => {
        await fillCorrection(page, "SYNTHETIC discarded local draft", "Synthetic discarded correction.");
        page.once("dialog", (dialog) => dialog.dismiss());
        await page.locator("#cancel-edit-button").click();
        await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue("SYNTHETIC discarded local draft");
        expect(await task(request, id)).toEqual(rejected);
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator("#cancel-edit-button").click();
        expect(await task(request, id)).toEqual(rejected);
        expect(calls).toEqual([]);
        await page.locator("#reopen-button").click();
        await expect(page.locator("#reopen-dialog")).toBeVisible();
        await page.locator("#reopen-cancel").click();
        await expect(page.locator("#reopen-dialog")).not.toBeVisible();
        expect(await task(request, id)).toEqual(rejected);
        expect(calls).toEqual([]);
    });

    await test.step("saving a correction preserves rejection and a separate duplicate-safe action starts review", async () => {
        await page.locator("#back-to-queue").click();
        await openEdit(page, id);
        await fillCorrection(page, customer, correction);
        await expect(page.locator("#reopen-button")).toBeDisabled();
        const saved = await doubleSubmit(page, id, "candidate", "#save-candidate-button");
        const corrected = await task(request, id);
        expect(corrected).toMatchObject({ status: "rejected", version: rejected.version + 1 });
        expect(corrected.candidate.events[0]).toMatchObject({ customer, items: [{ quantity: "3.125", unit_price: "12.40" }] });
        expect(corrected.candidate_revisions).toEqual(expect.arrayContaining([
            expect.objectContaining({ actor: "Synthetic correction reviewer", reason: correction, candidate: corrected.candidate }),
        ]));
        await unchangedRecognition(original, corrected);
        const replaySave = await request.put(`/api/tasks/${id}/candidate`, { headers: AUTH, data: saved.body });
        expect(replaySave.status()).toBe(200);
        expect(await replaySave.json()).toEqual(saved.receipt);
        expect(await task(request, id)).toEqual(corrected);
        await expect(page.locator("#reopen-button")).toBeEnabled();
        await page.locator("#reopen-button").click();
        await page.locator("#reopen-actor").fill("Synthetic reopening reviewer");
        await page.locator("#reopen-reason").fill(reopening);
        await capture(page, testInfo, "01-explicit-review-resubmission");
        const reopened = await doubleSubmit(page, id, "reopen", "#reopen-submit");
        await expect(page.locator("#reopen-dialog")).not.toBeVisible();
        await expect(page.locator("#task-status")).toHaveText("待审核");
        const current = await task(request, id);
        expect(current).toMatchObject({ status: "review_required", version: corrected.version + 1, candidate: corrected.candidate });
        expect(current.review_history.map((event) => event.kind)).toEqual(["rejected", "candidate_saved", "review_reopened"]);
        expect(current.review_history).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "rejected", reason: rejection }),
            expect.objectContaining({ kind: "candidate_saved", actor: "Synthetic correction reviewer", reason: correction }),
            expect.objectContaining({ kind: "review_reopened", actor: "Synthetic reopening reviewer", reason: reopening, from_status: "rejected", to_status: "review_required" }),
        ]));
        await unchangedRecognition(original, current);
        const replayReopen = await request.post(`/api/tasks/${id}/reopen`, { headers: AUTH, data: reopened.body });
        expect(replayReopen.status()).toBe(200);
        expect(await replayReopen.json()).toEqual(reopened.receipt);
        expect(await task(request, id)).toEqual(current);
        expect(calls.map((call) => call.pathname)).toEqual([`/api/tasks/${id}/candidate`, `/api/tasks/${id}/reopen`]);
        expect((await readJSON(request, "/api/orders")).orders).toEqual(beforeOrders);
        expect((await readJSON(request, "/api/status")).export).toEqual(beforeExport);
        await page.reload();
        await queue(page, data.label, "review_required");
        await page.locator(`.task-card[data-task-id="${id}"]`).click();
        await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue(customer);
        if (!(await page.locator("#task-review-history > details").evaluate((node) => node.open)))
            await page.locator("#task-review-history > details > summary").click();
        await expect(page.locator("#task-review-history").getByText(`原因：${rejection}`, { exact: true })).toBeVisible();
        await expect(page.locator("#task-review-history").getByText(`原因：${correction}`, { exact: true })).toBeVisible();
        await expect(page.locator("#task-review-history").getByText(`原因：${reopening}`, { exact: true })).toBeVisible();
        await expect(page.locator("#task-review-history")).toContainText(rejection);
        await expect(page.locator("#task-review-history")).toContainText(correction);
        await expect(page.locator("#task-review-history")).toContainText(reopening);
        await capture(page, testInfo, "02-reopened-review-history");
    });
});

test("queue selection is explicit, edits each chosen task separately, and clears at query, refresh and page boundaries", async ({ page, request }, testInfo) => {
    const data = sample(testInfo);
    const ids = [];
    // Real uploads create 51 independently deduplicated sources and a real second page.
    for (let index = 0; index < 51; index += 1) ids.push(await upload(request, data, `page-${index}`));
    await expect.poll(async () => {
        const result = await readJSON(request, `/api/tasks?limit=500&q=${encodeURIComponent(data.label)}`);
        return result.tasks.filter((entry) => entry.status === "review_required").length;
    }).toBe(51);
    const listed = await readJSON(request, `/api/tasks?limit=50&q=${encodeURIComponent(data.label)}`);
    const [first, second] = listed.tasks;
    const firstBefore = await task(request, first.id);
    const secondBefore = await task(request, second.id);
    const calls = trackMutations(page);
    await login(page);
    await queue(page, data.label, "review_required");
    await expect(page.locator(".task-select")).toHaveCount(50);
    await expect(page.locator("#queue-edit-selected")).toBeDisabled();
    await page.locator(`.task-select[data-task-id="${first.id}"]`).check();
    await page.locator(`.task-select[data-task-id="${second.id}"]`).check();
    await expect(page.locator(".task-select:checked")).toHaveCount(2);
    await expect(page.locator("#queue-selection-count")).toContainText("2");
    await expect(page.locator("#queue-edit-selected")).toBeEnabled();
    await capture(page, testInfo, "03-explicit-queue-multiple-selection");
    await page.locator("#queue-edit-selected").click();
    await expect(page.locator("#task-meta")).toContainText(first.id.slice(0, 10));
    await page.locator("#next-task").click();
    await expect(page.locator("#task-meta")).toContainText(second.id.slice(0, 10));
    await expect(page.locator("#next-task")).toBeDisabled();
    await page.locator("#previous-task").click();
    await fillCorrection(page, `SYNTHETIC one selected task ${data.label}`, "Synthetic correction applies only to this selected task.");
    const responsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${first.id}/candidate`));
    await page.locator("#save-candidate-button").click();
    expect((await responsePromise).status()).toBe(200);
    expect((await task(request, first.id)).version).toBe(firstBefore.version + 1);
    expect(await task(request, second.id)).toEqual(secondBefore);
    expect(calls.map((call) => call.pathname)).toEqual([`/api/tasks/${first.id}/candidate`]);
    await page.locator("#back-to-queue").click();

    async function chooseOne() {
        await expect(page.locator(".task-select").first()).toBeVisible();
        if (await page.locator("#queue-clear-selection").isEnabled())
            await page.locator("#queue-clear-selection").click();
        await page.locator(".task-select").first().check();
        await expect(page.locator(".task-select:checked")).toHaveCount(1);
    }
    async function nothingChosen() {
        await expect(page.locator(".task-select:checked")).toHaveCount(0);
        await expect(page.locator("#queue-edit-selected")).toBeDisabled();
        if (await page.locator("#queue-select-all").count())
            await expect(page.locator("#queue-select-all")).not.toBeChecked();
    }

    await test.step("status and search changes discard the prior selection scope", async () => {
        await chooseOne();
        await page.locator("#queue-filter").selectOption("rejected");
        await expect(page.locator("#task-list .task-card")).toHaveCount(0);
        await nothingChosen();
        await page.locator("#queue-filter").selectOption("review_required");
        await expect(page.locator(".task-select")).toHaveCount(50);
        await chooseOne();
        await page.locator("#queue-search").fill(`${data.label}-missing`);
        await expect(page.locator("#task-list .task-card")).toHaveCount(0);
        await nothingChosen();
        await page.locator("#queue-search").fill(data.label);
        await expect(page.locator(".task-select")).toHaveCount(50);
    });
    await test.step("manual refresh and browser reload cannot retain hidden selections", async () => {
        await chooseOne();
        await page.locator("#refresh-button").click();
        await nothingChosen();
        await chooseOne();
        await page.reload();
        await queue(page, data.label, "review_required");
        await expect(page.locator(".task-select")).toHaveCount(50);
        await nothingChosen();
    });
    await test.step("select all is exactly the visible page and moving pages clears that scope", async () => {
        await page.locator("#queue-select-all").check();
        await expect(page.locator(".task-select:checked")).toHaveCount(50);
        await expect(page.locator("#queue-selection-count")).toContainText("50");
        await page.locator("#queue-next-page").click();
        await expect(page.locator(".task-select")).toHaveCount(1);
        await nothingChosen();
        await page.locator(".task-select").check();
        await page.locator("#queue-previous-page").click();
        await expect(page.locator(".task-select")).toHaveCount(50);
        await nothingChosen();
        expect(calls).toHaveLength(1);
        await capture(page, testInfo, "04-queue-page-selection-boundary");
    });
});

test("selected rejected tasks remain individually reachable when reopening removes the first from the filtered queue", async ({ page, request }, testInfo) => {
    const data = sample(testInfo);
    const ids = [await upload(request, data, "chosen-first"), await upload(request, data, "chosen-second")];
    for (const id of ids) {
        const original = await ready(request, id);
        const response = await request.post(`/api/tasks/${id}/reject`, { headers: AUTH, data: {
            expected_version: original.version, reason: "Synthetic selected source requires another human review.",
        } });
        expect(response.status()).toBe(200);
    }
    const listed = await readJSON(request, `/api/tasks?status=rejected&q=${encodeURIComponent(data.label)}`);
    const [first, second] = listed.tasks;
    const secondBefore = await task(request, second.id);
    const beforeOrders = (await readJSON(request, "/api/orders")).orders;
    const calls = trackMutations(page);
    await login(page);
    await queue(page, data.label, "rejected");
    await expect(page.locator(".task-select")).toHaveCount(2);
    await page.locator("#queue-select-all").check();
    await page.locator("#queue-edit-selected").click();
    await expect(page.locator("#task-meta")).toContainText(first.id.slice(0, 10));
    await page.locator("#reopen-button").click();
    await page.locator("#reopen-actor").fill("Synthetic selected review operator");
    await page.locator("#reopen-reason").fill("Synthetic first selected source is ready for review.");
    await doubleSubmit(page, first.id, "reopen", "#reopen-submit");
    await expect(page.locator("#task-status")).toHaveText("待审核");
    const firstAfter = await task(request, first.id);
    expect(await task(request, second.id)).toEqual(secondBefore);
    await expect(page.locator("#next-task")).toBeEnabled();
    await page.locator("#next-task").click();
    await expect(page.locator("#task-meta")).toContainText(second.id.slice(0, 10));
    await expect(page.locator("#task-status")).toHaveText("已驳回");
    const customer = `SYNTHETIC second selected correction ${data.label}`;
    await fillCorrection(page, customer, "Synthetic correction applies to the second selected source only.");
    await doubleSubmit(page, second.id, "candidate", "#save-candidate-button");
    const secondAfter = await task(request, second.id);
    expect(secondAfter).toMatchObject({ status: "rejected", version: secondBefore.version + 1 });
    expect(secondAfter.candidate.events[0].customer).toBe(customer);
    expect(await task(request, first.id)).toEqual(firstAfter);
    expect(calls.map((call) => call.pathname)).toEqual([`/api/tasks/${first.id}/reopen`, `/api/tasks/${second.id}/candidate`]);
    expect((await readJSON(request, "/api/orders")).orders).toEqual(beforeOrders);
    await capture(page, testInfo, "05-selected-rejected-review-navigation");
});

test("a second client causes a real version conflict, preserves the local edit, and illegal reopening cannot write", async ({ page, request }, testInfo) => {
    const data = sample(testInfo);
    const id = await upload(request, data);
    const original = await ready(request, id);
    const rejection = await request.post(`/api/tasks/${id}/reject`, { headers: AUTH, data: {
        expected_version: original.version, reason: "Synthetic rejected source needs corrections.",
    } });
    expect(rejection.status()).toBe(200);
    const rejected = await task(request, id);
    const beforeOrders = (await readJSON(request, "/api/orders")).orders;
    const calls = trackMutations(page);
    await login(page);
    await queue(page, data.label, "rejected");
    await openEdit(page, id);
    const localCustomer = `SYNTHETIC Local Correction ${data.label}`;
    await fillCorrection(page, localCustomer, "Synthetic local reviewer correction.");
    let releaseReads;
    const readGate = new Promise((resolve) => { releaseReads = resolve; });
    const delayedReads = async (route) => {
        if (route.request().method() === "GET") {
            await readGate;
            await route.continue();
        } else await route.fallback();
    };
    // Freeze browser polling briefly, so even slow CI sends the stale version to
    // the real server instead of learning the new version just before the click.
    await page.route("**/api/tasks**", delayedReads);
    const remoteCandidate = structuredClone(rejected.candidate);
    remoteCandidate.events[0].customer = `SYNTHETIC Second Client ${data.label}`;
    const remote = await request.put(`/api/tasks/${id}/candidate`, { headers: AUTH, data: {
        expected_version: rejected.version, idempotency_key: randomUUID(),
        actor: "Synthetic second client", reason: "Synthetic concurrent correction.", candidate: remoteCandidate,
    } });
    expect(remote.status()).toBe(200);
    const latest = await task(request, id);
    // Trigger the real stale write before any manual refresh; no mocked 409 response.
    const conflictResponse = page.waitForResponse((response) => response.url().endsWith(`/api/tasks/${id}/candidate`));
    await page.locator("#save-candidate-button").click();
    const conflict = await conflictResponse;
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
    releaseReads();
    await page.unroute("**/api/tasks**", delayedReads);
    await expect(page.locator("#version-warning")).toBeVisible();
    await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue(localCustomer);
    await expect(page.locator("#review-reason")).toHaveValue("Synthetic local reviewer correction.");
    expect(await task(request, id)).toEqual(latest);
    await capture(page, testInfo, "06-concurrent-review-edit-conflict");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#reload-task").click();
    await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue(localCustomer);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#reload-task").click();
    await expect(page.locator("#editor-content").getByLabel(/^客户/)).toHaveValue(remoteCandidate.events[0].customer);
    await fillCorrection(page, localCustomer, "Synthetic reviewer reconciled the latest version.");
    const saved = await doubleSubmit(page, id, "candidate", "#save-candidate-button");
    expect(saved.body.expected_version).toBe(latest.version);
    expect(calls[1].body.idempotency_key).not.toBe(calls[0].body.idempotency_key);
    await page.locator("#reopen-button").click();
    await page.locator("#reopen-actor").fill("Synthetic conflict recovery reviewer");
    await page.locator("#reopen-reason").fill("Synthetic corrected draft reconciled with current source.");
    await doubleSubmit(page, id, "reopen", "#reopen-submit");
    await expect(page.locator("#task-status")).toHaveText("待审核");
    const current = await task(request, id);
    const invalid = await request.post(`/api/tasks/${id}/reopen`, { headers: AUTH, data: {
        expected_version: current.version, idempotency_key: randomUUID(),
        actor: "Synthetic illegal-state tester", reason: "Already in the review queue.",
    } });
    expect(invalid.status()).toBe(409);
    expect(await invalid.json()).toMatchObject({ error: { code: "STATE_CONFLICT" } });
    const differentPayload = await request.put(`/api/tasks/${id}/candidate`, { headers: AUTH, data: {
        ...saved.body, reason: "Synthetic same key with a different payload must fail.",
    } });
    expect(differentPayload.status()).toBe(409);
    expect(await differentPayload.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(await task(request, id)).toEqual(current);
    expect(current.review_history.map((event) => event.kind)).toEqual(["rejected", "candidate_saved", "candidate_saved", "review_reopened"]);
    expect(current.candidate.events[0].customer).toBe(localCustomer);
    await unchangedRecognition(original, current);
    expect((await readJSON(request, "/api/orders")).orders).toEqual(beforeOrders);
    expect(calls.filter((call) => /\/(retry|confirm)$/.test(call.pathname))).toEqual([]);
});
