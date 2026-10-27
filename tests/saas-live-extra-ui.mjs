import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const s = JSON.parse(
    await readFile(new URL("../../private-saas-qa.json", import.meta.url)),
  ),
  origin = "http://127.0.0.1:4321",
  output = path.resolve(process.env.SAAS_SCREENSHOTS || "../saas-visual-audit"),
  hotel = "/t/" + s.tenants[0].slug;
const browser = await chromium.launch({ headless: true }),
  errors = [],
  results = [];
await mkdir(output, { recursive: true });
async function context(role) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  if (role) {
    const cookie = s.users[role].cookie,
      i = cookie.indexOf("=");
    await ctx.addCookies([
      { name: cookie.slice(0, i), value: cookie.slice(i + 1), url: origin },
    ]);
  }
  await ctx.addInitScript(() =>
    localStorage.setItem("hotelapp.deviceOnboardingComplete", "true"),
  );
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  return { ctx, page };
}
async function capture(page, name) {
  assert.equal(
    await page.getByText("Failed to fetch", { exact: true }).count(),
    0,
    name + " must not conceal a failed data load",
  );
  for (const [size, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(150);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      name + " overflow",
    );
    await page.screenshot({
      path: path.join(output, "extra-" + name + "-" + size + ".png"),
      fullPage: true,
    });
  }
  results.push(name);
}
const publicContext = await context(),
  publicPage = publicContext.page;
await publicPage.goto(origin);
await publicPage
  .getByRole("button", { name: "Sign in", exact: true })
  .waitFor();
await capture(publicPage, "login");
await publicPage.goto(origin + "/public/" + s.tenants[0].slug + "/checkout");
await publicPage
  .locator(".public-checkout-page,.public-checkout-shell")
  .first()
  .waitFor();
await capture(publicPage, "public-checkout");
await publicPage.goto(origin + "/checkout/" + s.keys.a.identifier);
await publicPage.getByText(/101/).first().waitFor();
await capture(publicPage, "public-qr-confirmation");
await publicContext.ctx.close();
const owner = await context("owner"),
  p = owner.page;
await p.goto(origin + hotel + "/checkout");
await p.getByRole("button", { name: "Checkout Today", exact: true }).click();
await p.getByRole("dialog").waitFor();
assert.equal(
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "102", exact: true })
    .isDisabled(),
  true,
);
await capture(p, "expected-departures");
await p.getByRole("button", { name: "Close", exact: true }).click();
await p.locator(".checkout-management>summary").click();
await p
  .locator(".checkout-management")
  .getByRole("button", { name: "Settings", exact: true })
  .click();
await capture(p, "rooms-qr-settings");
await p.goto(origin + hotel + "/checkout");
const pending = p
  .locator(".workflow-column")
  .first()
  .locator(".workflow-room")
  .filter({ has: p.getByText("104", { exact: true }) });
await pending
  .getByRole("button", { name: "Mark as checked out", exact: true })
  .click();
const cleaning = p
  .locator(".workflow-column")
  .nth(1)
  .locator(".workflow-room")
  .filter({ has: p.getByText("104", { exact: true }) });
await cleaning
  .getByRole("button", { name: "Bed completed", exact: false })
  .click();
await cleaning
  .getByRole("button", { name: "Cleaning completed", exact: false })
  .click();
await cleaning
  .getByRole("button", { name: "Confirm cleaning", exact: true })
  .click();
const ready = p
  .locator(".workflow-column")
  .nth(2)
  .locator(".workflow-room")
  .filter({ has: p.getByText("104", { exact: true }) });
await ready.waitFor();
await capture(p, "completed-cleaning");
await ready.getByRole("button", { name: "Undo checkout", exact: true }).click();
await pending.waitFor();
await p.goto(origin + hotel + "/settings/users");
await p.locator(".invite-disclosure>summary").click();
await capture(p, "compact-invitation-form");
const response = await p.request.post(origin + "/api/tenant/invitations", {
  headers: { "X-Tenant-Id": s.tenants[0].id, origin },
  data: { email: "visual-" + Date.now() + "@example.test", role: "staff" },
});
assert.equal(response.status(), 201);
const invite = await response.json();
const invitation = await context();
await invitation.page.goto(origin + new URL(invite.inviteUrl).pathname);
await invitation.page
  .getByRole("button", { name: "Accept invitation", exact: true })
  .waitFor();
await capture(invitation.page, "accept-invitation");
await p.request.delete(origin + "/api/tenant/invitations/" + invite.id, {
  headers: { "X-Tenant-Id": s.tenants[0].id, origin },
});
await invitation.page.reload();
await invitation.page
  .getByText("This invitation is revoked.", { exact: true })
  .waitFor();
await capture(invitation.page, "revoked-invitation");
await invitation.ctx.close();
await p.goto(origin + hotel + "/devices/" + s.devices.a + "/screen");
await p.getByRole("button", { name: "Edit", exact: true }).click();
for (const name of [
  "Content",
  "Colors",
  "Typography",
  "Layout",
  "Screens",
  "QR & branding",
]) {
  const button = p.getByRole("tab", { name, exact: true });
  await button.click();
  await capture(p, "display-" + name.toLowerCase().replace(/[^a-z]+/g, "-"));
}
await owner.ctx.close();
const admin = await context("superadmin"),
  a = admin.page;
await a.goto(origin + "/admin");
await a.locator(".hotel-admin-row").first().locator(":scope > summary").click();
await capture(a, "superadmin-hotel-management");
await a.goto(origin + "/admin/devices");
await a.getByRole("button", { name: "Firmware releases", exact: true }).click();
await capture(a, "superadmin-firmware-releases");
await a.getByRole("button", { name: "Devices", exact: true }).click();
await a
  .locator("tr")
  .filter({ has: a.getByText("Reception display", { exact: true }) })
  .getByRole("button", { name: "Details", exact: true })
  .click();
await a.getByRole("navigation", { name: "Device sections" }).waitFor();
for (const name of ["Summary", "Diagnostics", "History", "Firmware / OTA"]) {
  await a.getByRole("button", { name, exact: true }).click();
  await capture(
    a,
    "superadmin-device-" + name.toLowerCase().replace(/[^a-z]+/g, "-"),
  );
}
await a.locator(".device-back").click();
await a
  .locator("tr")
  .filter({ has: a.getByText("CheckoutBox QA", { exact: true }) })
  .getByRole("button", { name: "Details", exact: true })
  .click();
await a.getByRole("button", { name: "Keys and controls", exact: true }).click();
await a.getByText("No configuration published", { exact: true }).waitFor();
assert.equal(
  await a.locator(".config-sync.synced").count(),
  0,
  "An unpublished configuration must never appear verified",
);
for (const name of ["Llaves RFID", "Trampilla", "Consola", "Configuración"]) {
  await a.getByRole("button", { name, exact: true }).click();
  await capture(
    a,
    "superadmin-checkoutbox-" +
      {
        "Llaves RFID": "rfid",
        Trampilla: "trap",
        Consola: "console",
        Configuración: "configuration",
      }[name],
  );
}
await a.getByRole("button", { name: "Llaves RFID", exact: true }).click();
await a.getByRole("button", { name: "Añadir llave", exact: true }).click();
await capture(a, "superadmin-checkoutbox-key-form");
await admin.ctx.close();
assert.deepEqual(errors, []);
await writeFile(
  path.join(output, "extra-audit.json"),
  JSON.stringify(
    {
      passed: true,
      views: results.length,
      screenshots: results.length * 2,
      results,
    },
    null,
    2,
  ),
);
console.log(
  "REAL_EXTRA_UI_AUDIT_PASS",
  results.length,
  "views",
  results.length * 2,
  "screenshots; checkout completed and reversed through UI",
);
await browser.close();
