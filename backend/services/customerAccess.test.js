import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeCustomerRoute,
  authorizeEvidence,
  customerIntegrationSettings,
} from "./customerAccess.js";
import { requireTenant } from "./tenantService.js";
const owner = {
    isPlatformAdmin: false,
    activeTenantId: "a",
    memberships: [{ tenantId: "a", role: "tenant_admin" }],
  },
  staff = { ...owner, memberships: [{ tenantId: "a", role: "staff" }] },
  superadmin = { ...owner, isPlatformAdmin: true };
test("customer roles cannot reach technical or global endpoints", () => {
  for (const path of [
    "/api/admin/tenants",
    "/api/admin/devices",
    "/api/settings/frigate",
    "/api/settings/json-feed/test",
    "/api/reservations/debug",
    "/api/plates/ABC/release",
    "/api/test-checkin",
    "/api/integrations/telegram/pairing-code",
    "/api/settings/stripe",
  ]) {
    for (const session of [owner, staff])
      assert.throws(() => authorizeCustomerRoute(session, "POST", path), {
        statusCode: 403,
      });
    assert.doesNotThrow(() => authorizeCustomerRoute(superadmin, "POST", path));
  }
  assert.throws(
    () => authorizeCustomerRoute(staff, "GET", "/api/settings/integrations"),
    { statusCode: 403 },
  );
  assert.throws(() => requireTenant({ ...owner, activeTenantId: "b" }), {
    statusCode: 403,
  });
});
test("evidence must belong to authenticated hotel", async () => {
  const db = {
    listTenantRecords: async (collection, tenant) =>
      tenant === "a"
        ? [{ localSnapshotPath: "/data/a.jpg" }]
        : [{ localSnapshotPath: "/data/b.jpg" }],
  };
  await authorizeEvidence(db, owner, "snapshot", "a.jpg");
  await assert.rejects(authorizeEvidence(db, owner, "snapshot", "b.jpg"), {
    statusCode: 404,
  });
});
test("customer integration status never includes infrastructure or credentials", () => {
  const value = customerIntegrationSettings({
    stripe: { connected: true, mode: "test", secretKeyMasked: "secret" },
    dashboard: {},
    frigate: { baseUrl: "http://internal" },
    reservations: { jsonFeed: { url: "secret-url" } },
    notifications: { token: "secret" },
  });
  const raw = JSON.stringify(value);
  assert.equal(raw.includes("secret"), false);
  assert.equal(raw.includes("internal"), false);
  assert.equal(value.stripe.mode, "test");
});
