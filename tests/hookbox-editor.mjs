import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { defaultTheme } from "../shared/hookbox/contract.mjs";
const output = process.env.HOOKBOX_BROWSER_OUTPUT_DIR || "work/browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
let draft = defaultTheme("Hotel PIN"),
  revision = 0,
  published = 0;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/hookbox/**", async (route) => {
  const r = route.request(),
    p = new URL(r.url()).pathname.split("/").at(-1);
  let body = {};
  if (p === "editor")
    body = {
      hotel: { draft, revision, mapping: [] },
      devices: [{ id: "panel", name: "CrowPanel MOCK" }],
      versions: [],
    };
  if (p === "draft") {
    const b = r.postDataJSON();
    draft = b.theme;
    revision++;
    body = { draft, revision, mapping: b.mapping };
  }
  if (p === "publish") {
    published++;
    body = { version: "published" };
  }
  await route.fulfill({ json: body });
});
try {
  await page.goto(
    (process.env.HOOKBOX_TEST_ORIGIN || "http://127.0.0.1:4321") +
      "/tests/hookbox-editor.html",
  );
  await page
    .getByRole("heading", { name: "Pantalla PIN · 800 × 480" })
    .waitFor();
  await page.getByLabel("Nombre del hotel").fill("Hotel Prueba");
  await page.getByLabel("Campo PIN", { exact: true }).fill("PIN");
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page.getByText("Diseño guardado", { exact: true }).waitFor();
  assert.equal(draft.hotelName, "Hotel Prueba");
  const canvas = page.locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  await canvas.screenshot({ path: output + "/pin-qr-hidden.png" });
  await page.getByLabel("Mostrar QR").check();
  await page.getByLabel("URL HTTPS o texto").fill("https://example.com/pin");
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page.waitForTimeout(100);
  assert.equal(draft.qr.enabled, true);
  await canvas.scrollIntoViewIfNeeded();
  await canvas.screenshot({ path: output + "/pin-qr-visible.png" });
  await page.getByLabel("Posición horizontal").fill("32");
  await page
    .getByRole("button", { name: "Guardar borrador", exact: true })
    .click();
  await page.waitForTimeout(100);
  assert.equal(draft.qr.x, 32);
  await page
    .getByRole("button", { name: "Publicar en pantalla", exact: true })
    .click();
  await page
    .getByText("Publicado. Esperando confirmación de la pantalla.", {
      exact: true,
    })
    .waitFor();
  assert.equal(published, 1);
  await page.reload();
  await page.getByLabel("Mostrar QR").waitFor();
  assert.equal(await page.getByLabel("Mostrar QR").isChecked(), true);
  assert.equal(await page.getByLabel("Posición horizontal").inputValue(), "32");
  await page.getByLabel("Mostrar QR").uncheck();
  await page.getByLabel("Vista", { exact: true }).selectOption("home");
  await canvas.scrollIntoViewIfNeeded();
  const r = await canvas.boundingBox();
  const tap = async (x, y) =>
    page.mouse.click(r.x + (x * r.width) / 800, r.y + (y * r.height) / 480);
  for (const [x, y] of [
    [200, 150],
    [350, 150],
    [500, 150],
    [200, 220],
  ])
    await tap(x, y);
  await tap(200, 420);
  assert.equal(
    await page.getByLabel("Vista", { exact: true }).inputValue(),
    "waiting",
  );
  await page.getByLabel("Vista", { exact: true }).selectOption("error");
  await canvas.screenshot({ path: output + "/pin-error.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Vista", { exact: true }).selectOption("home");
  await canvas.scrollIntoViewIfNeeded();
  await canvas.screenshot({ path: output + "/pin-mobile.png" });
  assert.deepEqual(errors, []);
  console.log("PIN_EDITOR_BROWSER_PASS");
} finally {
  await browser.close();
}
