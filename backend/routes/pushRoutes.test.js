import test from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";
import { handlePushRoute } from "./pushRoutes.js";
import { setWebPushTestHooks, subscribeUserPush } from "../services/webPushService.js";

function createFakeDatabase(initial = {}) {
  const data = {
    webPushConfigs: {},
    pushSubscriptions: {},
    pushPreferences: {},
    scheduledPushes: {},
    tenants: {},
    ...initial,
  };

  return {
    data,
    async setRecord(collection, id, value) {
      data[collection] ||= {};
      data[collection][id] = { ...value, id };
      return data[collection][id];
    },
    async getRecord(collection, id) {
      return data[collection]?.[id];
    },
    async listRecords(collection) {
      return Object.values(data[collection] || {});
    },
  };
}

function browserSubscription(endpoint) {
  return {
    endpoint,
    keys: {
      p256dh: `p256dh-${endpoint}`,
      auth: `auth-${endpoint}`,
    },
  };
}

test("POST /api/push/test exposes Apple BadJwtToken provider reason", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", slug: "hotel-a", name: "Hotel A", active: true },
    },
  });
  const reset = setWebPushTestHooks({
    generateVapidKeys: () => webpush.generateVAPIDKeys(),
    sendNotification: async () => {
      const error = new Error("Apple Web Push rejected the JWT.");
      error.statusCode = 403;
      error.body = '{"reason":"BadJwtToken"}';
      throw error;
    },
  });

  try {
    await subscribeUserPush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-a"),
    });

    const result = await handlePushRoute({
      request: { method: "POST", headers: {} },
      pathname: "/api/push/test",
      body: { endpoint: "endpoint-a" },
      context: {
        database,
        session: {
          user: { id: "user-a" },
          activeTenantId: "hotel-a",
          memberships: [{tenantId:"hotel-a",userId:"user-a",role:"staff"}],
          isPlatformAdmin: false,
        },
      },
    });

    assert.equal(result.status, 403);
    assert.equal(result.payload.success, false);
    assert.equal(result.payload.httpStatus, 403);
    assert.equal(result.payload.providerReason, "BadJwtToken");
    assert.match(result.payload.error, /BadJwtToken/);
    assert.equal(result.payload.diagnostics.body, '{"reason":"BadJwtToken"}');
  } finally {
    reset();
  }
});

test("GET /api/push/test-schedule/:id returns the scheduled test status", async () => {
  const database = createFakeDatabase({
    scheduledPushes: {
      "scheduled-a": {
        id: "scheduled-a",
        userId: "user-a",
        tenantId: "hotel-a",
        status: "failed",
        sendAt: "2026-08-27T10:00:00.000Z",
        sentAt: null,
        error: "Apple Web Push rejected the JWT.",
        httpStatus: 403,
        providerReason: "BadJwtToken",
      },
    },
  });

  const result = await handlePushRoute({
    request: { method: "GET", headers: {} },
    pathname: "/api/push/test-schedule/scheduled-a",
    body: {},
    context: {
      database,
      session: {
        user: { id: "user-a" },
        activeTenantId: "hotel-a",
        memberships: [{tenantId:"hotel-a",userId:"user-a",role:"staff"}],
        isPlatformAdmin: false,
      },
    },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    id: "scheduled-a",
    status: "failed",
    sendAt: "2026-08-27T10:00:00.000Z",
    sentAt: null,
    error: "Apple Web Push rejected the JWT.",
    providerReason: "BadJwtToken",
    httpStatus: 403,
  });
});

test("GET /api/push/diagnostics is tenant-scoped and admin-only", async () => {
  const database = createFakeDatabase({
    diagnostics: {
      "checkout-push:hotel-a": {
        key: "checkout-push:hotel-a",
        value: { tenantId: "hotel-a", status: "provider_accepted", acceptedByProvider: 1 },
      },
      "checkout-push:hotel-b": {
        key: "checkout-push:hotel-b",
        value: { tenantId: "hotel-b", status: "provider_rejected", rejectedByProvider: 1 },
      },
    },
  });
  const adminSession = {
    user: { id: "admin", globalRole: "platform_admin" },
    activeTenantId: "hotel-a",
    memberships: [{tenantId:"hotel-a",userId:"user-a",role:"staff"}],
    isPlatformAdmin: true,
  };
  const result = await handlePushRoute({
    request: { method: "GET", headers: {} },
    pathname: "/api/push/diagnostics",
    body: {},
    context: { database, session: adminSession },
  });

  assert.equal(result.status, 200);
  assert.equal(result.payload.diagnostic.tenantId, "hotel-a");
  assert.equal(result.payload.diagnostic.status, "provider_accepted");

  await assert.rejects(
    () => handlePushRoute({
      request: { method: "GET", headers: {} },
      pathname: "/api/push/diagnostics",
      body: {},
      context: {
        database,
        session: {
          user: { id: "staff", globalRole: null },
          activeTenantId: "hotel-a",
          memberships: [{ tenantId: "hotel-a", userId: "staff", role: "staff" }],
          isPlatformAdmin: false,
        },
      },
    }),
    /Tenant admin access is required/,
  );
});
