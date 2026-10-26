import { chromium } from "playwright";
import assert from "node:assert/strict";
import { defaultTheme } from "../shared/hookbox/contract.mjs";
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  base = "/t/test-hotel/devices";
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const device = {
  id,
  deviceId: "panel-test",
  name: "Panel recepción",
  hardwareModel: "CROWPANEL_7_V3",
  currentFirmwareVersion: "2.7.0",
  lastSeenAt: new Date().toISOString(),
  uiDesiredVersion: null,
  uiAppliedVersion: null,
};
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  let body = {};
  if (path === "/api/auth/session")
    body = {
      user: { id: "user", email: "admin@test.local" },
      tenants: [
        { id: tenant, name: "Test Hotel", slug: "test-hotel", active: true },
      ],
      memberships: [{ tenantId: tenant, userId: "user", role: "tenant_admin" }],
      activeTenantId: tenant,
      isPlatformAdmin: false,
      modules: [],
      modulesByTenant: { [tenant]: {} },
    };
  else if (path === "/api/hookbox/devices") body = [device];
  else if (path === "/api/hookbox/devices/" + id) body = device;
  else if (path === "/api/hookbox/editor")
    body = {
      hotel: { draft: defaultTheme("Test Hotel"), revision: 0, mapping: [] },
      devices: [device],
      versions: [],
    };
  else if (path === "/api/hookbox/diagnostics") body = [];
  await route.fulfill({ json: body });
});
await page.goto("http://127.0.0.1:4321" + base);
await page.getByRole("heading", { name: "Panel recepción" }).waitFor();
assert.equal(
  await page.getByRole("button", { name: "Administración global" }).count(),
  0,
);
await page.getByRole("link", { name: "Ver dispositivo" }).click();
await page
  .getByRole("link", { name: "Personalizar pantalla", exact: true })
  .click();
await page.getByLabel("Nombre del hotel").waitFor();
assert.equal(
  await page.getByLabel("Nombre del hotel").inputValue(),
  "Test Hotel",
);
assert.equal(
  await page.getByLabel("Configuración de pantalla").isDisabled(),
  true,
);
assert.equal(new URL(page.url()).pathname, base + "/" + id + "/screen");
await page.getByRole("link", { name: "Volver al dispositivo" }).click();
await page
  .getByRole("link", { name: "Personalizar pantalla", exact: true })
  .waitFor();
assert.deepEqual(errors, []);
console.log("TENANT_ADMIN_DEVICE_DETAIL_EDITOR_PASS");
await browser.close();
