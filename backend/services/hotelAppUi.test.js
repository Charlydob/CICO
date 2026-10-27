import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("tenant selection sends one explicit tenant context and ignores the previous URL", async () => {
  const [auth, api] = await Promise.all([
    source("src/auth/AuthContext.tsx"),
    source("src/services/backendApi.ts"),
  ]);

  assert.match(auth, /loadSession\(\{ value: nextTenantId \}\)/);
  assert.match(auth, /if \(explicitTenantId\)[\s\S]*setSelectedTenantSlug\(undefined\)/);
  assert.doesNotMatch(api, /getAuthSession[\s\S]{0,160}setSelectedTenantId/);
});

test("dashboard hides demo reservations and legacy housekeeping routes redirect home", async () => {
  const [app, layout, dashboard] = await Promise.all([
    source("src/App.tsx"),
    source("src/layouts/AppLayout.tsx"),
    source("src/modules/dashboard/DashboardPage.tsx"),
  ]);

  assert.match(app, /legacyHousekeeping[\s\S]*replaceState/);
  assert.doesNotMatch(layout, /navButton\("housekeeping"/);
  assert.doesNotMatch(layout, /route: "housekeeping" as AppRoute/);
  assert.match(dashboard, /status\.reservationSource !== "demo"/);
});

test("profile push state requires the active hotel preference and exposes a provider test", async () => {
  const profile = await source("src/modules/profile/ProfilePage.tsx");

  assert.match(profile, /pushStatus\?\.preference\?\.enabled/);
  assert.match(profile, /updatePushPreferences\(\{ enabled: false \}\)/);
  assert.match(profile, /Send test notification/);
  assert.match(profile, /This does not confirm that the notification appeared on the device/);
});
