import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const s = JSON.parse(
    await readFile(new URL("../../private-saas-qa.json", import.meta.url)),
  ),
  base = "http://127.0.0.1:3001",
  origin = "http://127.0.0.1:4321",
  a = s.tenants[0].id,
  b = s.tenants[1].id;
let assertions = 0;
async function api(
  role,
  path,
  method = "GET",
  body,
  tenant = s.users[role].hotel,
  extra = {},
) {
  const r = await fetch(base + path, {
    method,
    headers: {
      cookie: s.users[role].cookie,
      "X-Tenant-Id": tenant,
      origin,
      "content-type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await r.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  return { status: r.status, body: payload };
}
async function status(
  role,
  path,
  expected,
  method = "GET",
  body,
  tenant,
  extra,
) {
  const r = await api(role, path, method, body, tenant, extra);
  assert.equal(
    r.status,
    expected,
    role + " " + method + " " + path + " " + JSON.stringify(r.body),
  );
  assertions++;
  return r.body;
}
for (const role of ["owner", "manager", "staff"]) {
  const auth = await status(role, "/api/auth/session", 200);
  assert.equal(auth.isPlatformAdmin, false);
  assert.deepEqual(
    auth.tenants.map((t) => t.id),
    [a],
  );
  await status(role, "/api/admin/tenants", 403);
  await status(role, "/api/admin/devices", 403);
  await status(
    role,
    "/api/admin/tenants/" + a + "/modules/checkout",
    403,
    "PATCH",
    { enabled: false },
  );
  await status(role, "/api/checkout/overview", 403, "GET", undefined, b);
  await status(role, "/api/settings/frigate", 403, "POST", {
    baseUrl: "https://untrusted.test",
  });
  await status(
    role,
    "/api/integrations/telegram/pairing-code",
    403,
    "POST",
    {},
  );
  const health = await status(role, "/api/status", 200);
  assert.deepEqual(Object.keys(health), ["backendOnline"]);
  const forbidden = await status(
    role,
    "/api/auth/session",
    403,
    "GET",
    undefined,
    b,
  );
  assert.equal(JSON.stringify(forbidden).includes(s.tenants[1].name), false);
}
await status("superadmin", "/api/admin/tenants", 200);
await status("staff", "/api/settings/integrations", 403);
await status("staff", "/api/tenant/users", 403);
await status("staff", "/api/hookbox/editor", 403);
await status("staff", "/api/checkout/keys", 403);
await status("staff", "/api/checkout/keys/" + s.keys.a.id + "/qr", 403);
const settings = await status("owner", "/api/settings/integrations", 200);
assert.equal(JSON.stringify(settings).includes("baseUrl"), false);
assert.equal(JSON.stringify(settings).includes("secretKeyMasked"), false);
await status("owner", "/api/tenant/profile", 403, "PATCH", {
  modules: { checkout: true },
  name: "Hacked",
});
await status(
  "owner",
  "/api/tenant/profile",
  403,
  "PATCH",
  { name: "No origin" },
  a,
  { origin: "https://untrusted.test" },
);
const users = await status("owner", "/api/tenant/users", 200),
  members = users.members || users.users || users;
const self = members.find((m) => m.userId === s.users.owner.id);
assert.ok(self);
await status("owner", "/api/tenant/memberships/" + self.id, 400, "PATCH", {
  role: "platform_admin",
});
await status("owner", "/api/tenant/memberships/" + self.id, 403, "PATCH", {
  role: "staff",
});
await status("staff", "/api/checkout/manual", 403, "POST", {
  roomId: s.rooms["101"],
});
await status("owner", "/api/checkout/rooms/" + s.rooms["201"], 404, "PATCH", {
  name: "Hacked",
});
await status("owner", "/api/checkout/keys/" + s.keys.b.id, 404, "PATCH", {
  label: "Hacked",
});
assert.equal(
  (
    await fetch(base + "/api/evidence/snapshots/" + s.evidence.a, {
      headers: { cookie: s.users.owner.cookie, "X-Tenant-Id": a },
    })
  ).status,
  200,
);
assert.equal(
  (
    await fetch(base + "/api/evidence/snapshots/" + s.evidence.b, {
      headers: { cookie: s.users.owner.cookie, "X-Tenant-Id": a },
    })
  ).status,
  404,
);
const detections = await status("owner", "/api/parking/detections", 200);
assert.ok(detections.every((d) => d.tenantId === a));
assert.equal(JSON.stringify(detections).includes("PRIVATEB201"), false);
assert.equal(
  JSON.stringify(detections).includes("privateInfrastructure"),
  false,
);
await status("other", "/api/parking/detections", 403);
const devices = await status("owner", "/api/hookbox/devices", 200);
assert.deepEqual(
  devices.map((d) => d.id),
  [s.devices.a],
);
assert.equal("hardwareModel" in devices[0], false);
assert.equal("currentFirmwareVersion" in devices[0], false);
await status("owner", "/api/hookbox/devices/" + s.devices.b, 404);
await status("owner", "/api/hookbox/editor?deviceId=" + s.devices.b, 404);
await status("owner", "/api/hookbox/diagnostics", 403);
await status("owner", "/api/hookbox/inherit", 403, "POST", {
  deviceId: s.devices.a,
});
const e = await status(
  "owner",
  "/api/hookbox/editor?deviceId=" + s.devices.a,
  200,
);
assert.deepEqual(e.hotel.mapping, []);
assert.equal(e.versions[0].manifest.roomMapping, undefined);
await status("owner", "/api/hookbox/draft", 200, "POST", {
  deviceId: s.devices.a,
  revision: e.hotel.revision,
  theme: e.hotel.draft,
  mapping: [{ room: "201", hook: 25 }],
});
const internal = await status(
  "superadmin",
  "/api/hookbox/editor?deviceId=" + s.devices.a,
  200,
);
assert.deepEqual(internal.hotel.mapping, [{ room: "101", hook: 7 }]);
await status("owner", "/api/hookbox/publish", 200, "POST", {
  deviceId: s.devices.a,
  revision: internal.hotel.revision,
});
const payment = await status("owner", "/api/tenant/payments", 200);
assert.equal(payment.connected, false);
assert.equal(payment.connectAvailable, false);
await status("staff", "/api/tenant/payments", 403);
await status("owner", "/api/tenant/payments", 503, "POST", {
  action: "connect",
});
await status("owner", "/api/checkout/rooms/" + s.rooms["101"], 409, "PATCH", {
  status: "ready",
});
await status("owner", "/api/checkout/rooms/" + s.rooms["102"], 409, "PATCH", {
  status: "occupied",
});
const before = await status("owner", "/api/checkout/overview", 200);
await status("owner", "/api/checkout/today", 200, "PUT", {
  roomIds: [s.rooms["101"], s.rooms["104"]],
});
const planned = await status("owner", "/api/checkout/overview", 200);
assert.equal(
  planned.rooms.find((r) => r.id === s.rooms["104"]).status,
  "unknown",
);
assert.equal(planned.events.length, before.events.length);
const checkout = await status("owner", "/api/checkout/manual", 201, "POST", {
    roomId: s.rooms["104"],
  }),
  eventId = checkout.event.id;
const action = (role, name, confirmed = false) =>
  status(role, "/api/housekeeping/action", 200, "POST", {
    eventId,
    action: name,
    confirmed,
  });
await action("staff", "bed_done");
await action("staff", "undo_bed");
await action("staff", "cleaning_done");
await action("staff", "undo_cleaning");
await status("staff", "/api/housekeeping/action", 409, "POST", {
  eventId,
  action: "complete",
});
await action("staff", "bed_done");
await action("staff", "cleaning_done");
const completed = await Promise.all([
  action("staff", "complete"),
  action("staff", "complete"),
]);
assert.equal(completed.filter((r) => r.duplicate).length, 1);
await status("staff", "/api/housekeeping/action", 403, "POST", {
  eventId,
  action: "reopen",
  confirmed: true,
});
await action("manager", "reopen", true);
await action("staff", "undo_cleaning");
await action("staff", "cleaning_done");
await action("staff", "complete");
await status("staff", "/api/housekeeping/action", 403, "POST", {
  eventId,
  action: "undo_checkout",
  confirmed: true,
});
await status("owner", "/api/housekeeping/action", 409, "POST", {
  eventId,
  action: "undo_checkout",
});
await action("owner", "undo_checkout", true);
const second = await status("owner", "/api/checkout/manual", 201, "POST", {
  roomId: s.rooms["104"],
});
assert.notEqual(second.event.id, eventId);
await status("owner", "/api/housekeeping/action", 200, "POST", {
  eventId: second.event.id,
  action: "undo_checkout",
  confirmed: true,
});
const final = await status("owner", "/api/checkout/overview", 200);
assert.equal(
  final.rooms.find((r) => r.id === s.rooms["104"]).status,
  "unknown",
);
assert.ok(
  final.events.some((e) => e.id === eventId && e.status === "reversed"),
);
await status("owner", "/api/tenant/profile", 400, "PATCH", {
  basicInfo: { timezone: "Mars/Base" },
});
await status("owner", "/api/tenant/profile", 400, "PATCH", {
  basicInfo: { contactEmail: "not-an-email" },
});
await status(
  "owner",
  "/api/tenant/profile",
  403,
  "PATCH",
  { name: "Missing origin" },
  a,
  { origin: "" },
);
await status("manager", "/api/tenant/memberships/" + self.id, 403, "DELETE");
await status("manager", "/api/tenant/invitations", 403, "POST", {
  email: "qa-grant@example.test",
  role: "tenant_admin",
});
await status("staff", "/api/tenant/invitations", 403, "POST", {
  email: "qa-staff@example.test",
  role: "staff",
});
const invitation = await status(
  "owner",
  "/api/tenant/invitations",
  201,
  "POST",
  { email: "qa-" + Date.now() + "@example.test", role: "staff", tenantId: b },
);
assert.equal(invitation.tenantId, a);
assert.equal(invitation.delivery.status, "not_configured");
assert.equal("tokenHash" in invitation, false);
assert.equal("encryptedToken" in invitation, false);
const copied = await status(
  "owner",
  "/api/tenant/invitations/" + invitation.id,
  200,
);
assert.equal(copied.inviteUrl, invitation.inviteUrl);
await status("other", "/api/tenant/invitations/" + invitation.id, 404);
const token = new URL(invitation.inviteUrl).pathname.split("/").at(-1);
await status("owner", "/api/invitations/" + token, 403, "POST", {
  email: "wrong@example.test",
  password: "Local-QA-password-only-123",
});
await status(
  "owner",
  "/api/tenant/invitations/" + invitation.id,
  200,
  "DELETE",
);
await status("owner", "/api/invitations/" + token, 400, "POST", {
  email: invitation.email,
  password: "Local-QA-password-only-123",
});
await status("owner", "/api/tenant/invitations/" + invitation.id, 400);
await writeFile(
  new URL("../../saas-api-evidence.json", import.meta.url),
  JSON.stringify(
    {
      passed: true,
      assertions,
      roles: ["superadmin", "owner", "manager", "staff"],
      hotelIsolation: true,
      reversibleCheckout: true,
      technicalMappingProtected: true,
    },
    null,
    2,
  ),
);
console.log("REAL_HTTP_MULTIHOTEL_SECURITY_AND_REVERSIBILITY_PASS", assertions);
