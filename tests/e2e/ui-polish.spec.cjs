"use strict";

const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test: base, expect } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "../..");
// Public invented credential, valid only for the disposable loopback service.
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
        // No business response is mocked. Fail closed on remote fonts or assets.
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
        expect(errors, "UI polish must preserve exception-free browser behavior").toEqual([]);
        expect(externalRequests, "UI assets must stay on the isolated local service").toEqual([]);
        expect(credentialURLs, "The local credential must never appear in a URL").toEqual([]);
    },
});

async function readJSON(request, route) {
    const response = await request.get(route, { headers: AUTH });
    expect(response.ok(), route).toBeTruthy();
    return response.json();
}

async function resetDemo(request) {
    const saved = await readJSON(request, "/api/model-settings");
    const response = await request.put("/api/model-settings", { headers: AUTH, data: {
        expected_revision: saved.revision, provider: "demo", model: "", base_url: "",
        allow_external: false, api_key_action: "delete",
    } });
    expect(response.ok()).toBeTruthy();
}

async function login(page) {
    await page.goto("/");
    await page.locator("#access-token").fill(TOKEN);
    await page.locator("#login-button").click();
    await expect(page.locator("#dashboard-view")).toBeVisible();
}

async function noPageOverflow(page) {
    const widths = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        root: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
    }));
    // Evidence and table scrollers can be wider; the document itself must fit.
    expect(widths.root, JSON.stringify(widths)).toBeLessThanOrEqual(widths.viewport + 1);
    expect(widths.body, JSON.stringify(widths)).toBeLessThanOrEqual(widths.viewport + 1);
}

async function capture(page, testInfo, name) {
    await noPageOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const screenshot = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

async function mobileTargets(page, selectors) {
    if (page.viewportSize().width > 720) return;
    for (const selector of selectors) {
        const control = page.locator(selector).first();
        await expect(control, selector).toBeVisible();
        const box = await control.evaluate((node) => {
            // A native checkbox can keep a compact glyph inside a larger label.
            // Measure the associated clickable target rather than the glyph.
            const label = node.matches('input[type="checkbox"]')
                ? node.closest("label") || [...document.querySelectorAll("label")].find((item) => item.htmlFor === node.id && node.id)
                : null;
            const bounds = (label || node).getBoundingClientRect();
            return { width: bounds.width, height: bounds.height };
        });
        expect(box.width, `${selector} touch width`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${selector} touch height`).toBeGreaterThanOrEqual(44);
    }
}

async function inputBoundaries(page, selectors) {
    await page.mouse.move(0, 0);
    for (const selector of selectors) {
        const control = page.locator(selector).first();
        await expect(control, selector).toBeVisible();
        await expect(control, `${selector} is an actionable input boundary`).toBeEnabled();
        await control.evaluate((node) => node.blur());
        const boundary = await control.evaluate((node) => {
            // Canvas resolves the browser's actual CSS colors, including oklch,
            // to sRGB. Composite translucent backgrounds from the page inward.
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            const rgba = (color) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
                return [r / 255, g / 255, b / 255, alpha / 255];
            };
            const over = (front, back) => front.slice(0, 3).map((c, i) =>
                c * front[3] + back[i] * (1 - front[3]),
            );
            const luminance = (color) => {
                const linear = color.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
                return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
            };
            const ratio = (left, right) => {
                const [a, b] = [luminance(left), luminance(right)].sort((x, y) => y - x);
                return (a + 0.05) / (b + 0.05);
            };
            const ancestors = [];
            for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.unshift(parent);
            let outside = [1, 1, 1];
            for (const parent of ancestors) outside = over(rgba(getComputedStyle(parent).backgroundColor), outside);
            const style = getComputedStyle(node);
            const inside = over(rgba(style.backgroundColor), outside);
            const border = over(rgba(style.borderTopColor), outside);
            return {
                focused: node === document.activeElement,
                color: style.borderTopColor, background: style.backgroundColor,
                width: parseFloat(style.borderTopWidth), style: style.borderTopStyle,
                insideContrast: ratio(border, inside), outsideContrast: ratio(border, outside),
            };
        });
        expect(boundary.focused, `${selector} must be checked in its default state`).toBe(false);
        expect(boundary.width, selector).toBeGreaterThanOrEqual(1);
        expect(boundary.style, selector).not.toBe("none");
        expect(boundary.insideContrast, `${selector}: ${JSON.stringify(boundary)}`).toBeGreaterThanOrEqual(3);
        expect(boundary.outsideContrast, `${selector}: ${JSON.stringify(boundary)}`).toBeGreaterThanOrEqual(3);
    }
}

async function tabTo(page, locator) {
    for (let index = 0; index < 100; index += 1) {
        if (await locator.evaluate((node) => node === document.activeElement)) return;
        await page.keyboard.press("Tab");
    }
    throw new Error(`Not reachable by native Tab: ${await locator.getAttribute("id")}`);
}

async function focusRing(page, locator) {
    await tabTo(page, locator);
    const ring = await locator.evaluate((node) => {
        const style = getComputedStyle(node);
        return { visible: node.matches(":focus-visible"), width: parseFloat(style.outlineWidth),
            style: style.outlineStyle, offset: parseFloat(style.outlineOffset) };
    });
    expect(ring.visible, "Keyboard focus must have a distinct visual cue").toBe(true);
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.style).not.toBe("none");
    expect(ring.offset).toBeGreaterThanOrEqual(2);
}

async function dialogKeyboard(page, dialog, trigger) {
    await expect(dialog).toBeVisible();
    const containment = await dialog.evaluate((node) => getComputedStyle(node).overscrollBehaviorY);
    expect(containment, "Scrolling an overlay must not move the document behind it").toBe("contain");
    // Traverse both directions past the control count, rather than forcing focus.
    for (const key of ["Tab", "Shift+Tab"]) {
        for (let index = 0; index < 12; index += 1) {
            await page.keyboard.press(key);
            expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        }
    }
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
}

async function scale(locator) {
    return locator.evaluate((node) => {
        const style = getComputedStyle(node);
        const independent = style.scale === "none" ? 1 : parseFloat(style.scale);
        return independent * (style.transform === "none" ? 1 : new DOMMatrixReadOnly(style.transform).a);
    });
}

async function press(page, locator, expectedScale) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
        await expect.poll(() => scale(locator)).toBeCloseTo(expectedScale, 3);
    } finally {
        // Release away from the target so this style check does not invoke its action.
        await page.mouse.move(0, 0);
        await page.mouse.up();
    }
}

async function openMotion(page) {
    return page.locator("#open-upload").evaluate(async (button) => {
        button.click();
        await new Promise(requestAnimationFrame);
        const dialog = document.getElementById("upload-dialog");
        return dialog.getAnimations().map((animation) => ({
            property: animation.transitionProperty,
            duration: animation.effect.getTiming().duration,
            frames: animation.effect.getKeyframes(),
        }));
    });
}

test.beforeEach(async ({ request }) => { await resetDemo(request); });
test.afterEach(async ({ request }) => { await resetDemo(request); });

test("local SVG navigation stays immediate, accessible, and usable at each viewport", async ({ page }, testInfo) => {
    await page.goto("/");
    await inputBoundaries(page, ["#access-token"]);
    await login(page);
    const icons = await page.locator("svg.ui-icon").evaluateAll((nodes) => nodes.map((node) => ({
        viewBox: node.getAttribute("viewBox"), hidden: node.getAttribute("aria-hidden"),
        focusable: node.getAttribute("focusable"), stroke: node.getAttribute("stroke"),
        external: !!node.querySelector("image, use"),
        shapes: [...node.querySelectorAll("path, line, polyline, polygon, circle, rect, ellipse")]
            .map((shape) => ({ color: getComputedStyle(shape).stroke, inherited: getComputedStyle(node).color,
                fill: getComputedStyle(shape).fill, effect: getComputedStyle(shape).vectorEffect })),
    })));
    expect(icons.length, "Controls should use the local shared icon vocabulary").toBeGreaterThan(5);
    for (const icon of icons) {
        expect(icon.viewBox).toBe("0 0 20 20");
        expect(icon.hidden).toBe("true");
        expect(icon.focusable).toBe("false");
        expect(icon.stroke).toBe("currentColor");
        expect(icon.external).toBe(false);
        expect(icon.shapes.length).toBeGreaterThan(0);
        for (const shape of icon.shapes) {
            // Active icons add a currentColor fill cue to the same outline SVG.
            if (shape.color === "none") expect(shape.fill).toBe(shape.inherited);
            else expect(shape.color).toBe(shape.inherited);
            expect(shape.effect).toBe("non-scaling-stroke");
        }
    }
    await mobileTargets(page, ["#open-upload", "#refresh-button", "#nav-dashboard", "#nav-review"]);
    await capture(page, testInfo, "polish-dashboard");
    for (const view of ["results", "api", "review", "orders", "exports", "settings", "dashboard"]) {
        const snapshot = await page.locator(`#nav-${view}`).evaluate((node, name) => {
            node.click();
            return { current: node.getAttribute("aria-current"),
                currents: document.querySelectorAll('.nav-tab[aria-current="page"]').length,
                visible: !document.getElementById(`${name}-view`).hidden,
                transition: getComputedStyle(node).transitionProperty,
                duration: getComputedStyle(node).transitionDuration };
        }, view);
        // Observe inside the same event turn: a tab switch must not await motion.
        expect(snapshot.current, view).toBe("page");
        expect(snapshot.currents, view).toBe(1);
        expect(snapshot.visible, view).toBe(true);
        const transitionProperties = snapshot.transition.split(",").map((value) => value.trim());
        const transitionDurations = snapshot.duration.split(",").map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000));
        // The browser defaults to property "all" with duration 0 when there is
        // no transition. Only actual animated properties need this restriction.
        for (let index = 0; index < transitionProperties.length; index += 1) {
            const duration = transitionDurations[index % transitionDurations.length];
            if (!duration) continue;
            expect(transitionProperties[index], view).not.toBe("all");
            expect(["opacity", "background-color"], view).toContain(transitionProperties[index]);
            expect(duration, view).toBeLessThanOrEqual(150);
        }
        if (view === "review") {
            await inputBoundaries(page, ["#queue-search", "#queue-filter"]);
            await mobileTargets(page, ["#review-upload", "#queue-search", "#queue-filter"]);
        } else if (view === "orders") {
            await inputBoundaries(page, ["#order-search", "#order-filter"]);
        } else if (view === "exports") {
            await mobileTargets(page, ["#export-button", "#download-button"]);
        } else if (view === "settings") {
            await expect(page.locator("#model-provider")).toBeEnabled();
            // Demo intentionally disables credential controls. Contrast applies
            // to the enabled supplier boundary, not to inactive key management.
            await inputBoundaries(page, ["#model-provider"]);
            await mobileTargets(page, ["#model-provider", "#model-save", "#model-reset"]);
            await expect(page.locator("#model-api-key")).toHaveValue("");
        }
        await capture(page, testInfo, `polish-${view}`);
    }
    await focusRing(page, page.locator("#open-upload"));
    await page.keyboard.press("Enter");
    await inputBoundaries(page, ["#source-label"]);
    await mobileTargets(page, ["#close-upload", "#cancel-upload", "#upload-submit", "#source-label"]);
    await capture(page, testInfo, "polish-import-keyboard");
    await dialogKeyboard(page, page.locator("#upload-dialog"), page.locator("#open-upload"));
});

test("synthetic rejected review retains efficient selection, edit, and keyboard dialog behavior", async ({ page, request }, testInfo) => {
    const label = `synthetic-polish-${testInfo.project.name}-${randomUUID()}`;
    const image = testInfo.outputPath("synthetic-polish-evidence.png");
    execFileSync("uv", ["run", "--locked", "python", "tests/e2e/fixture.py", "image", image], {
        cwd: ROOT, stdio: "pipe", timeout: 30_000,
    });
    const uploaded = await request.post("/api/uploads", { headers: AUTH, multipart: {
        files: { name: "synthetic-polish-evidence.png", mimeType: "image/png", buffer: readFileSync(image) },
        source_label: label,
    } });
    expect(uploaded.ok()).toBeTruthy();
    const id = (await uploaded.json()).tasks[0].id;
    await expect.poll(async () => (await readJSON(request, `/api/tasks/${id}`)).status).toBe("review_required");
    const original = await readJSON(request, `/api/tasks/${id}`);
    const rejected = await request.post(`/api/tasks/${id}/reject`, { headers: AUTH, data: {
        expected_version: original.version, reason: "Synthetic evidence requires a fictional review correction.",
    } });
    expect(rejected.ok()).toBeTruthy();
    const before = await readJSON(request, `/api/tasks/${id}`);
    await login(page);
    await page.locator("#nav-review").click();
    const loaded = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/tasks" && url.searchParams.get("q") === label
            && url.searchParams.get("status") === "rejected";
    });
    await page.locator("#queue-filter").selectOption("rejected");
    await page.locator("#queue-search").fill(label);
    expect((await loaded).ok()).toBeTruthy();
    await expect(page.locator("#task-list")).toHaveAttribute("aria-busy", "false");
    const select = page.locator(`.task-select[data-task-id="${id}"]`);
    await mobileTargets(page, ["#queue-select-all", `.task-select[data-task-id="${id}"]`, `.task-edit[data-task-id="${id}"]`]);
    await select.check();
    await expect(page.locator("#queue-selection-count")).toContainText("1");
    await capture(page, testInfo, "polish-review-selection");
    await page.locator(`.task-edit[data-task-id="${id}"]`).click();
    await expect(page.locator("#task-workspace")).toBeVisible();
    await expect(page.locator("#editor-content").getByLabel(/^客户/)).toBeEditable();
    await inputBoundaries(page, ["#review-actor", "#review-reason"]);
    await mobileTargets(page, ["#back-to-queue", "#zoom-in", "#zoom-out", "#zoom-fit", "#reopen-button"]);
    await capture(page, testInfo, "polish-review-detail");
    await focusRing(page, page.locator("#reopen-button"));
    await page.keyboard.press("Enter");
    await inputBoundaries(page, ["#reopen-actor", "#reopen-reason"]);
    await mobileTargets(page, ["#reopen-actor", "#reopen-reason", "#reopen-cancel", "#reopen-submit"]);
    await capture(page, testInfo, "polish-resubmission-dialog");
    await dialogKeyboard(page, page.locator("#reopen-dialog"), page.locator("#reopen-button"));
    expect(await readJSON(request, `/api/tasks/${id}`), "Cancelling visual checks must preserve business facts").toEqual(before);
});

test("press feedback respects motion preferences and forced colors preserve surface edges", async ({ page }, testInfo) => {
    await login(page);
    const upload = page.locator("#open-upload");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await press(page, upload, 1);
    const reduced = await openMotion(page);
    expect(reduced.some((animation) => animation.property === "opacity" && animation.duration > 0),
        "Reduced motion should cross-fade an overlay instead of removing its feedback").toBe(true);
    for (const animation of reduced) {
        expect(animation.duration).toBeLessThanOrEqual(300);
        for (const frame of animation.frames) {
            for (const property of ["scale", "translate", "transform", "filter"])
                expect(frame).not.toHaveProperty(property);
        }
    }
    await expect.poll(() => page.locator("#upload-dialog").evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
    expect(await page.locator("#upload-dialog").evaluate((node) => getComputedStyle(node, "::backdrop").backdropFilter)).toBe("none");
    await page.keyboard.press("Escape");
    await expect(page.locator("#upload-dialog")).not.toBeVisible();

    await page.emulateMedia({ reducedMotion: "no-preference" });
    const timing = await upload.evaluate((node) => {
        const style = getComputedStyle(node);
        const properties = style.transitionProperty.split(",").map((value) => value.trim());
        const index = properties.indexOf("scale");
        const durations = style.transitionDuration.split(",").map((value) => parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000));
        const easings = style.transitionTimingFunction.split(/,(?![^()]*\))/).map((value) => value.trim());
        return { properties, duration: durations[index % durations.length], easing: easings[index % easings.length] };
    });
    expect(timing.properties).toContain("scale");
    expect(timing.properties).not.toContain("all");
    expect(timing.duration).toBe(150);
    expect(timing.easing).toBe("ease-out");
    await press(page, upload, 0.96);
    await press(page, page.locator("#nav-review"), 1);
    await press(page, page.locator("#refresh-button"), 1);
    await page.locator("#nav-settings").click();
    await expect(page.locator("#model-provider")).toBeEnabled();
    await expect(page.locator("#model-test")).toBeDisabled();
    await press(page, page.locator("#model-test"), 1);
    await page.locator("#nav-dashboard").click();

    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    for (const selector of ["#dashboard-view .panel", "#stat-review"]) {
        const surface = page.locator(selector).first();
        const edge = await surface.evaluate((node) => {
            const style = getComputedStyle(node);
            return { width: parseFloat(style.borderTopWidth), style: style.borderTopStyle,
                color: style.borderTopColor, background: style.backgroundColor, shadow: style.boxShadow };
        });
        expect(edge.shadow, selector).toBe("none");
        expect(edge.width, selector).toBeGreaterThanOrEqual(1);
        expect(edge.style, selector).not.toBe("none");
        expect(edge.color, selector).not.toBe("rgba(0, 0, 0, 0)");
        expect(edge.color, selector).not.toBe(edge.background);
    }
    await capture(page, testInfo, "polish-forced-colors");
});
