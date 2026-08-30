import { expect, test } from "@playwright/test";

test("workspace boots, switches desktops, and recovers its layout panel", async ({page}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");

  await expect(page.locator("h1")).toContainText("KEY//TUNE LAB");
  await expect(page.locator("#mappingPresetSelect option")).toHaveCount(3);
  await expect(page.locator("#externalPanelToggles button[data-panel]")).toHaveCount(11);

  await page.locator('[data-desktop-switch="desktop2"]').click();
  await expect(page.locator("#layoutPanel")).not.toHaveClass(/desktop-inactive/);

  await page.locator('#layoutPanelToggles button[data-panel="layoutPanel"]').click();
  await expect(page.locator("#layoutPanel")).toHaveClass(/collapsed/);
  await page.locator("#panelVisibilityButton").click();
  await page.locator('#externalPanelToggles button[data-panel="layoutPanel"]').click();
  await expect(page.locator("#layoutPanel")).not.toHaveClass(/collapsed/);

  const project = await page.evaluate(() => JSON.parse(window.KEY_TUNE_PROJECT.exportJson()));
  expect(project.version).toBe(1);
  expect(project.layout.active_desktop).toBe("desktop2");
  expect(pageErrors).toEqual([]);
});

test("backend exposes versioned state and open preset libraries", async ({request}) => {
  const response = await request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  const state = await response.json();

  expect(state.schema_version).toBe(9);
  expect(state.timbres.some((item) => item.id === "sqrt2")).toBeTruthy();
  expect(state.input_surfaces.some((item) => item.id === "piano_88")).toBeTruthy();
  expect(state.mapping_presets.some((item) => item.id === "hex-harmonic")).toBeTruthy();
});
