import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const state = JSON.parse(
    await readFile(new URL("../../private-saas-qa.json", import.meta.url)),
  ),
  origin = "http://127.0.0.1:4321",
  output = path.resolve(process.env.SAAS_SCREENSHOTS || "../saas-visual-audit");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true }),
  results = [];
const hotel = "/t/" + state.tenants[0].slug;
const common = [
  ["home", hotel],
  ["checkout", hotel + "/checkout"],
  ["parking", hotel + "/parking"],
  ["general", hotel + "/settings/general"],
  ["staff-users", hotel + "/settings/users"],
  ["display-list", hotel + "/settings/display"],
  ["display-detail", hotel + "/devices/" + state.devices.a],
  ["editor", hotel + "/devices/" + state.devices.a + "/screen"],
  ["payments", hotel + "/settings/payments"],
  ["integrations", hotel + "/settings/integrations"],
  ["profile", hotel + "/profile"],
];
for (const role of ["owner", "manager", "staff", "superadmin"]) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
    }),
    cookie = state.users[role].cookie,
    i = cookie.indexOf("=");
  await context.addCookies([
    {
      name: cookie.slice(0, i),
      value: cookie.slice(i + 1),
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.addInitScript(() =>
    localStorage.setItem("hotelapp.deviceOnboardingComplete", "true"),
  );
  const page = await context.newPage(),
    errors = [],
    serverErrors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 500)
      serverErrors.push({ url: r.url(), status: r.status() });
  });
  const pages =
    role === "staff"
      ? common.filter(([name]) =>
          ["home", "checkout", "parking", "profile"].includes(name),
        )
      : role === "manager"
        ? common.filter(([name]) =>
            ["home", "general", "staff-users", "editor", "payments"].includes(
              name,
            ),
          )
        : role === "superadmin"
          ? [
              ["admin", "/admin"],
              ["devices", "/admin/devices"],
              ["technical", hotel + "/admin/integrations"],
              ["profile", hotel + "/profile"],
            ]
          : common;
  for (const [name, url] of pages) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin + url);
    await page.locator(".platform-main").waitFor();
    await page.waitForTimeout(450);
    assert.equal(
      await page
        .locator("body")
        .getByText(/Support Mode/i)
        .count(),
      0,
    );
    if (role !== "superadmin") {
      assert.equal(await page.locator(".tenant-picker select").count(), 0);
      assert.equal(
        await page.locator('.mobile-topbar select[aria-label="Hotel"]').count(),
        0,
      );
      assert.equal(
        await page
          .locator(".sidebar-nav")
          .getByRole("button", { name: "Superadmin", exact: true })
          .count(),
        0,
      );
    }
    if (name === "staff-users") {
      await page.getByRole("navigation", { name: "Hotel settings" }).waitFor();
      assert.equal(await page.locator(".invite-disclosure[open]").count(), 0);
      assert.equal(
        await page.getByText("Telegram", { exact: true }).count(),
        0,
      );
    }
    if (name === "checkout") {
      await page.getByRole("heading", { name: /Pending checkout/ }).waitFor();
      assert.equal(await page.locator(".workflow-column").count(), 3);
      if (role === "staff")
        assert.equal(await page.locator(".checkout-management").count(), 0);
    }
    if (name === "editor" && role !== "superadmin") {
      assert.equal(
        await page
          .getByText("Technical settings and room mapping", { exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.getByText("JSON diagnostics", { exact: true }).count(),
        0,
      );
    }
    if (name === "payments") {
      await page.getByText("Not connected", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Connect Stripe", exact: true })
          .isDisabled(),
        true,
      );
    }
    await page.screenshot({
      path: path.join(output, role + "-" + name + "-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (overflow) {
      await page.screenshot({
        path: path.join(output, role + "-" + name + "-OVERFLOW.png"),
        fullPage: true,
      });
      throw Error(role + " " + name + " mobile horizontal overflow");
    }
    await page.screenshot({
      path: path.join(output, role + "-" + name + "-mobile.png"),
      fullPage: true,
    });
    results.push({ role, page: name, desktop: true, mobile: true });
  }
  if (role === "staff") {
    await page.goto(origin + hotel + "/settings");
    await page
      .getByRole("heading", { name: "Access restricted", exact: true })
      .waitFor();
    await page.goto(origin + hotel + "/admin");
    await page
      .getByRole("heading", { name: "Access restricted", exact: true })
      .waitFor();
  }
  if (role === "owner") {
    await page.goto(origin + hotel + "/profile");
    await page.locator(".profile-settings select").selectOption("de");
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("lang"), "de");
    await page.locator(".profile-settings select").selectOption("en");
    await page.goto(origin + hotel + "/checkout");
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
  }
  assert.deepEqual(errors, [], "Browser runtime errors for " + role);
  assert.deepEqual(serverErrors, [], "Unexpected server errors for " + role);
  await context.close();
}
await writeFile(
  path.join(output, "audit.json"),
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
  "REAL_ROLE_UI_AUDIT_PASS",
  results.length,
  "views",
  results.length * 2,
  "desktop/mobile screenshots",
);
await browser.close();
