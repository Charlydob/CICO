import { chromium } from "playwright";
import assert from "node:assert/strict";
import { defaultTheme } from "../shared/hookbox/contract.mjs";
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  base = "/t/test-hotel/devices";
let platform = false;
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
      isPlatformAdmin: platform,
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
  else if (
    path === "/api/hookbox/diagnostics" ||
    path === "/api/admin/devices" ||
    path === "/api/admin/firmware-releases" ||
    path === "/api/admin/tenants"
  )
    body = [];
  await route.fulfill({ json: body });
});
await page.goto("http://127.0.0.1:4321" + base);
await page.getByRole("heading", { name: "Panel recepción" }).waitFor();
assert.equal(
  await page.getByRole("button", { name: "Administración global" }).count(),
  0,
);
await page.getByRole("link", { name: "View device" }).click();
await page
  .getByRole("link", { name: "Customize display", exact: true })
  .click();
await page.getByLabel("Hotel name").waitFor({ state: "attached" });
assert.equal(
  await page.getByLabel("Hotel name").inputValue(),
  "Test Hotel",
);
assert.equal(
  await page.getByLabel("Display configuration").isDisabled(),
  true,
);
assert.equal(new URL(page.url()).pathname, base + "/" + id + "/screen");
await page.getByRole("link", { name: "Back to device" }).click();
await page
  .getByRole("link", { name: "Customize display", exact: true })
  .waitFor();
await page.setViewportSize({ width: 390, height: 844 });
assert.equal(await page.locator('.bottom-nav button').filter({hasText:/Operations/i}).count(),0);
await page.locator('.bottom-nav button').filter({hasText:'Settings'}).click();
await page.waitForURL('**/settings');
assert.equal(await page.locator('.bottom-nav button.active').count(),1);
assert.equal(await page.locator('.bottom-nav button').first().getAttribute('class'),'');
platform = true;
await page.goto("http://127.0.0.1:4321/admin/devices");
await page.getByRole("navigation", { name: "Admin", exact: true }).waitFor();
assert.equal(
  await page
    .locator(".mobile-topbar")
    .getByText(/Support Mode/i)
    .count(),
  0,
);
assert.equal(
  await page
    .locator(".mobile-topbar-actions")
    .getByRole("button", { name: /Devices|Dispositivos/ })
    .count(),
  0,
);
assert.equal(
  await page
    .locator(".sidebar-nav")
    .getByRole("button", { name: "Devices / Firmware", exact: true })
    .count(),
  0,
);
assert.deepEqual(errors, []);
console.log("TENANT_ADMIN_DEVICE_DETAIL_EDITOR_PASS");
await browser.close();
