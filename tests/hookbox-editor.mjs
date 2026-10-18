import { mkdir } from "node:fs/promises";
import path from "node:path";
const output = process.env.HOOKBOX_BROWSER_OUTPUT_DIR || "work/browser";
await mkdir(output, { recursive: true });
import { chromium } from "playwright";
import { defaultTheme } from "../shared/hookbox/contract.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
let draft = defaultTheme("Gasthaus Steinbock"),
  revision = 0,
  published = 0;
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/hookbox/**", async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname.split("/").at(-1);
  let body = {};
  if (path === "editor")
    body = {
      hotel: {
        draft,
        revision,
        mapping: [
          { room: "101", hook: 1 },
          { room: "102", hook: 25 },
        ],
      },
      versions: [],
      devices: [{ id: "panel", name: "CrowPanel MOCK" }],
    };
  else if (path === "draft") {
    const b = req.postDataJSON();
    draft = b.theme;
    revision++;
    body = { draft, revision, mapping: b.mapping };
  } else if (path === "assets") {
    const b = req.postDataJSON();
    body = {
      id: createHash("sha256")
        .update(Buffer.from(b.data, "base64"))
        .digest("hex"),
      width: b.width,
      height: b.height,
      kind: b.kind,
    };
  } else if (path === "publish") {
    published++;
    revision++;
    body = { version: "test-v1" };
  }
  await route.fulfill({ json: body });
});
await page.goto(
  (process.env.HOOKBOX_TEST_ORIGIN || "http://127.0.0.1:4321") +
    "/tests/hookbox-editor.html",
);
await page.getByLabel("Nombre del hotel").waitFor();
await page.evaluate(() => document.fonts.ready);
await page.getByLabel("Nombre del hotel").fill("Hotel Prueba");
await page
  .getByRole("button", { name: "Guardar borrador", exact: true })
  .click();
await page.getByText("Borrador guardado", { exact: true }).waitFor();
assert.equal(draft.hotelName, "Hotel Prueba");
const canvas = page.locator("canvas");
await page.getByRole("button", { name: "form", exact: true }).click();
async function tap(x, y) {
  const r = await canvas.boundingBox();
  await page.mouse.click(r.x + (x * r.width) / 800, r.y + (y * r.height) / 480);
}
await tap(40, 280);
await tap(120, 280);
await tap(550, 220);
await page.getByRole("button", { name: "verify", exact: true }).waitFor();
await page.getByRole("button", { name: "home", exact: true }).click();
await tap(625, 446); // fr
assert.equal(
  await page.getByLabel("Idioma de vista previa").inputValue(),
  "fr",
);
await page
  .getByRole("button", { name: "Publicar diseño", exact: true })
  .click();
await page
  .getByText("Diseño publicado; esperando confirmación de los dispositivos")
  .waitFor();
assert.equal(published, 1);
await page
  .getByRole("button", { name: "Cargar tema piloto Steinbock", exact: true })
  .click();
await page
  .getByText(
    "Tema piloto cargado como borrador; revisa y publica cuando esté listo",
    { exact: true },
  )
  .waitFor();
await page.waitForTimeout(200);
await page.screenshot({
  path: path.join(output, "editor-hookbox.png"),
  fullPage: true,
});
await canvas.screenshot({ path: path.join(output, "pantalla-steinbock.png") });
assert.deepEqual(errors, []);
console.log(
  "EDITOR_BROWSER_PASS: editing, save, publication, touch form, keyboard, language, canvas render",
);
await browser.close();
