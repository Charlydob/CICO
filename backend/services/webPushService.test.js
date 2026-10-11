import test from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";
import {
  DEFAULT_VAPID_SUBJECT,
  ensureWebPushConfig,
  getScheduledPushStatus,
  getPushStatus,
  getCheckoutPushDiagnostic,
  processDueScheduledPushes,
  resolveVapidSubject,
  schedulePush,
  sendRfidReturnPush,
  sendNewCheckoutPush,
  sendPushToSubscription,
  sendTestPushToSubscription,
  setWebPushTestHooks,
  subscribeUserPush,
  unsubscribeUserPush,
  updatePushPreference,
} from "./webPushService.js";

function createFakeDatabase(initial = {}) {
  const data = {
    webPushConfigs: {},
    pushSubscriptions: {},
    pushPreferences: {},
    scheduledPushes: {},
    users: {},
    memberships: {},
    tenants: {},
    rooms: {},
    checkoutEvents: {},
    ...initial,
  };

  return {
    data,
    async setRecord(collection, id, value) {
      data[collection] ||= {};
      data[collection][id] = collection === "diagnostics"
        ? { key: id, value }
        : { ...value, id };
      return data[collection][id];
    },
    async getRecord(collection, id) {
      return data[collection]?.[id];
    },
    async listRecords(collection) {
      return Object.values(data[collection] || {});
    },
    async listTenantRecords(collection, tenantId) {
      return Object.values(data[collection] || {}).filter((record) => record.tenantId === tenantId);
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

function validVapidKeys() {
  return webpush.generateVAPIDKeys();
}

test("default VAPID subject is the public production origin", () => {
  assert.equal(DEFAULT_VAPID_SUBJECT, "https://hotelapp.charlydob.com");
  assert.equal(resolveVapidSubject({}), "https://hotelapp.charlydob.com");
  assert.equal(
    resolveVapidSubject({
      VAPID_SUBJECT: " https://custom.example ",
      WEB_PUSH_SUBJECT: "https://fallback.example",
    }),
    "https://custom.example",
  );
  assert.equal(
    resolveVapidSubject({
      VAPID_SUBJECT: " ",
      WEB_PUSH_SUBJECT: " https://web-push.example ",
    }),
    "https://web-push.example",
  );
});

test("VAPID keys are generated once and reused across service calls", async () => {
  const database = createFakeDatabase();
  let generated = 0;
  const reset = setWebPushTestHooks({
    generateVapidKeys() {
      generated += 1;
      return { publicKey: `public-${generated}`, privateKey: `private-${generated}` };
    },
  });

  try {
    const first = await ensureWebPushConfig(database);
    const second = await ensureWebPushConfig(database);

    assert.equal(generated, 1);
    assert.equal(first.publicKey, "public-1");
    assert.equal(second.publicKey, "public-1");

    setWebPushTestHooks({
      generateVapidKeys() {
        generated += 1;
        return { publicKey: "new-public", privateKey: "new-private" };
      },
    });

    const afterRestart = await ensureWebPushConfig(database);
    assert.equal(afterRestart.publicKey, "public-1");
    assert.equal(generated, 1);
  } finally {
    reset();
  }
});

test("existing VAPID keys are reused for sends without regeneration", async () => {
  const keys = validVapidKeys();
  const database = createFakeDatabase({
    webPushConfigs: {
      global: {
        id: "global",
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  let generated = 0;
  const reset = setWebPushTestHooks({
    generateVapidKeys() {
      generated += 1;
      return validVapidKeys();
    },
    sendNotification: async () => ({ statusCode: 201 }),
  });

  try {
    const subscription = await subscribeUserPush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-a"),
    });
    const result = await sendPushToSubscription(
      database,
      database.data.pushSubscriptions[subscription.id],
      { title: "HotelApp" },
    );

    assert.equal(result.sent, true);
    assert.equal(generated, 0);
    assert.equal(database.data.webPushConfigs.global.publicKey, keys.publicKey);
    assert.equal(database.data.webPushConfigs.global.privateKey, keys.privateKey);
  } finally {
    reset();
  }
});

test("push status exposes only the VAPID public key", async () => {
  const database = createFakeDatabase();
  const reset = setWebPushTestHooks({
    generateVapidKeys: () => ({ publicKey: "public-key", privateKey: "private-key" }),
  });

  try {
    const status = await getPushStatus(database, { userId: "user-a", tenantId: "hotel-a" });
    const serialized = JSON.stringify(status);

    assert.equal(status.vapidPublicKey, "public-key");
    assert.equal(serialized.includes("private-key"), false);
    assert.equal(Object.hasOwn(status, "privateKey"), false);
  } finally {
    reset();
  }
});

test("users can register multiple devices and cannot spoof another userId", async () => {
  const database = createFakeDatabase();
  const reset = setWebPushTestHooks({
    generateVapidKeys: () => ({ publicKey: "public", privateKey: "private" }),
  });

  try {
    await subscribeUserPush(database, {
      userId: "real-user",
      tenantId: "hotel-a",
      subscription: { ...browserSubscription("endpoint-1"), userId: "attacker" },
      userAgent: "iPhone",
    });
    await subscribeUserPush(database, {
      userId: "real-user",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-2"),
      userAgent: "Desktop",
    });

    const subscriptions = Object.values(database.data.pushSubscriptions);
    assert.equal(subscriptions.length, 2);
    assert.equal(subscriptions.every((subscription) => subscription.userId === "real-user"), true);
    assert.deepEqual(
      subscriptions.map((subscription) => subscription.endpoint).sort(),
      ["endpoint-1", "endpoint-2"],
    );

    const preference = Object.values(database.data.pushPreferences)[0];
    assert.equal(preference.enabled, true);
    assert.equal(preference.newCheckout, true);
    assert.equal(preference.assignedToMe, true);
    assert.equal(preference.roomCompleted, false);
  } finally {
    reset();
  }
});

test("unsubscribe disables only the current user's device", async () => {
  const database = createFakeDatabase();
  const reset = setWebPushTestHooks({
    generateVapidKeys: () => ({ publicKey: "public", privateKey: "private" }),
  });

  try {
    await subscribeUserPush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-a"),
    });
    await subscribeUserPush(database, {
      userId: "user-b",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-b"),
    });

    await unsubscribeUserPush(database, { userId: "user-a", endpoint: "endpoint-a" });

    assert.ok(Object.values(database.data.pushSubscriptions).find((item) => item.endpoint === "endpoint-a").disabledAt);
    assert.equal(Object.values(database.data.pushSubscriptions).find((item) => item.endpoint === "endpoint-b").disabledAt, null);
  } finally {
    reset();
  }
});

test("404 and 410 Web Push responses disable dead subscriptions", async () => {
  const database = createFakeDatabase();
  const reset = setWebPushTestHooks({
    generateVapidKeys: validVapidKeys,
    sendNotification: async () => {
      const error = new Error("gone");
      error.statusCode = 410;
      throw error;
    },
  });

  try {
    const subscription = await subscribeUserPush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-a"),
    });
    const result = await sendPushToSubscription(
      database,
      database.data.pushSubscriptions[subscription.id],
      { title: "HotelApp" },
    );

    assert.equal(result.sent, false);
    assert.equal(result.disabled, true);
    assert.ok(database.data.pushSubscriptions[subscription.id].disabledAt);
    assert.equal(database.data.pushSubscriptions[subscription.id].failureCount, 1);
  } finally {
    reset();
  }
});

test("Apple BadJwtToken Web Push failures expose safe diagnostics", async () => {
  const keys = validVapidKeys();
  const database = createFakeDatabase({
    webPushConfigs: {
      global: {
        id: "global",
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  const reset = setWebPushTestHooks({
    sendNotification: async () => {
      const error = new Error("Apple Web Push rejected the JWT.");
      error.statusCode = 403;
      error.body = '{"reason":"BadJwtToken"}';
      error.headers = {
        "content-type": "application/json",
        "apns-id": "test-apns-id",
        authorization: "Bearer should-not-leak",
      };
      throw error;
    },
  });

  try {
    const subscription = await subscribeUserPush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-a"),
    });
    const result = await sendPushToSubscription(
      database,
      database.data.pushSubscriptions[subscription.id],
      { title: "HotelApp" },
    );

    assert.equal(result.sent, false);
    assert.equal(result.httpStatus, 403);
    assert.equal(result.providerReason, "BadJwtToken");
    assert.equal(result.diagnostics.statusCode, 403);
    assert.equal(result.diagnostics.message, "Apple Web Push rejected the JWT.");
    assert.equal(result.diagnostics.body, '{"reason":"BadJwtToken"}');
    assert.equal(result.diagnostics.headers["content-type"], "application/json");
    assert.equal(result.diagnostics.headers["apns-id"], "test-apns-id");
    assert.equal(Object.hasOwn(result.diagnostics.headers, "authorization"), false);
    assert.equal(JSON.stringify(result).includes(keys.privateKey), false);
  } finally {
    reset();
  }
});

test("push preferences are isolated by user and tenant", async () => {
  const database = createFakeDatabase();

  await updatePushPreference(database, "user-a", "hotel-a", { enabled: false, roomCompleted: true });
  await updatePushPreference(database, "user-a", "hotel-b", { enabled: true, newCheckout: false });
  await updatePushPreference(database, "user-b", "hotel-a", { enabled: true });

  const preferences = Object.values(database.data.pushPreferences);
  assert.equal(preferences.length, 3);
  assert.equal(preferences.find((item) => item.userId === "user-a" && item.tenantId === "hotel-a").roomCompleted, true);
  assert.equal(preferences.find((item) => item.userId === "user-a" && item.tenantId === "hotel-b").newCheckout, false);
  assert.equal(preferences.find((item) => item.userId === "user-b" && item.tenantId === "hotel-a").enabled, true);
});

test("RFID return push is sent only to authorized users of the matching hotel", async () => {
  const sent=[];
  const database=createFakeDatabase({
    users:{
      a:{id:"user-a",globalRole:null,active:true},
      b:{id:"user-b",globalRole:null,active:true},
    },
    memberships:{
      a:{id:"membership-a",userId:"user-a",tenantId:"hotel-a",role:"manager"},
      b:{id:"membership-b",userId:"user-b",tenantId:"hotel-b",role:"manager"},
    },
    tenants:{
      a:{id:"hotel-a",slug:"hotel-a",name:"Hotel A"},
      b:{id:"hotel-b",slug:"hotel-b",name:"Hotel B"},
    },
  });
  const reset=setWebPushTestHooks({
    generateVapidKeys:validVapidKeys,
    sendNotification:async(subscription,payload)=>sent.push({subscription,payload:JSON.parse(payload)}),
  });
  try {
    await subscribeUserPush(database,{userId:"user-a",tenantId:"hotel-a",subscription:browserSubscription("endpoint-a")});
    await subscribeUserPush(database,{userId:"user-b",tenantId:"hotel-b",subscription:browserSubscription("endpoint-b")});
    const result=await sendRfidReturnPush(database,{
      tenant:database.data.tenants.a,
      room:{id:"room-204",number:"204"},
      event:{id:"return-1",tenantId:"hotel-a",roomId:"room-204"},
    });
    assert.equal(result.recipients,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].subscription.endpoint,"endpoint-a");
    assert.equal(sent[0].payload.type,"checkout.rfid_return_recorded");
    assert.equal(sent[0].payload.tenantId,"hotel-a");
    assert.match(sent[0].payload.body,/Habitación 204/);
  } finally { reset(); }
});

test("platform_admin can store preferences for an active tenant without membership", async () => {
  const database = createFakeDatabase({
    users: {
      admin: { id: "admin", email: "admin@example.test", displayName: "Admin", globalRole: "platform_admin", active: true },
    },
    tenants: {
      "hotel-a": { id: "hotel-a", slug: "hotel-a", name: "Hotel A", active: true },
    },
  });

  const preference = await updatePushPreference(database, "admin", "hotel-a", { enabled: true });
  assert.equal(preference.userId, "admin");
  assert.equal(preference.tenantId, "hotel-a");
  assert.equal(Object.values(database.data.memberships).length, 0);
});

test("checkout push includes hotel and room and accepts a subscribed support admin", async () => {
  const keys = validVapidKeys();
  const sent = [];
  const database = createFakeDatabase({
    users: {
      admin: { id: "admin", globalRole: "platform_admin", active: true },
      other: { id: "other", globalRole: null, active: true },
    },
    memberships: {
      other: { id: "membership-other", userId: "other", tenantId: "other-hotel", role: "manager" },
    },
    tenants: {
      demo: { id: "demo", slug: "demo-hotel", name: "Demo Hotel", active: true },
      other: { id: "other-hotel", slug: "other-hotel", name: "Other Hotel", active: true },
    },
  });
  const reset = setWebPushTestHooks({
    generateVapidKeys: () => keys,
    sendNotification: async (subscription, payload) => {
      sent.push({ subscription, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    },
  });

  try {
    await subscribeUserPush(database, {
      userId: "other",
      tenantId: "other-hotel",
      subscription: browserSubscription("https://push.example.test/foreign-endpoint"),
    });
    await subscribeUserPush(database, {
      userId: "admin",
      tenantId: "demo",
      subscription: browserSubscription("https://push.example.test/private-endpoint"),
    });
    const result = await sendNewCheckoutPush(database, {
      tenant: database.data.tenants.demo,
      room: { id: "room-204", number: "204" },
      event: { id: "checkout-1", tenantId: "demo", roomId: "room-204", source: "rfid" },
    });
    const diagnostic = await getCheckoutPushDiagnostic(database, "demo");

    assert.equal(result.recipients, 1);
    assert.equal(result.activeSubscriptions, 1);
    assert.equal(result.acceptedByProvider, 1);
    assert.equal(result.status, "provider_accepted");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subscription.endpoint, "https://push.example.test/private-endpoint");
    assert.match(sent[0].payload.body, /Demo Hotel.*204/);
    assert.equal(sent[0].payload.url, "/t/demo-hotel/?housekeepingRoom=204");
    assert.equal(diagnostic.eventSource, "rfid");
    assert.equal(diagnostic.status, "provider_accepted");
    assert.equal(diagnostic.results[0].httpStatus, 201);
    assert.equal(JSON.stringify(diagnostic).includes("private-endpoint"), false);
    assert.equal(JSON.stringify(diagnostic).includes(keys.privateKey), false);
  } finally {
    reset();
  }
});

test("checkout push diagnoses eligible users without active subscriptions", async () => {
  const database = createFakeDatabase({
    users: { manager: { id: "manager", globalRole: null, active: true } },
    memberships: {
      manager: { id: "membership-manager", userId: "manager", tenantId: "hotel-a", role: "manager" },
    },
    tenants: { hotel: { id: "hotel-a", slug: "hotel-a", name: "Hotel A" } },
  });
  await updatePushPreference(database, "manager", "hotel-a", { enabled: true, newCheckout: true });

  const result = await sendNewCheckoutPush(database, {
    tenant: database.data.tenants.hotel,
    room: { id: "room-1", number: "1" },
    event: { id: "checkout-1", tenantId: "hotel-a", roomId: "room-1", source: "manual" },
  });

  assert.equal(result.recipients, 1);
  assert.equal(result.activeSubscriptions, 0);
  assert.equal(result.status, "no_active_subscriptions");
  assert.equal((await getCheckoutPushDiagnostic(database, "hotel-a")).missingSubscriptions, 1);
});

test("expired checkout subscription is disabled and rejection is diagnostic", async () => {
  const database = createFakeDatabase({
    users: { manager: { id: "manager", globalRole: null, active: true } },
    memberships: {
      manager: { id: "membership-manager", userId: "manager", tenantId: "hotel-a", role: "manager" },
    },
    tenants: { hotel: { id: "hotel-a", slug: "hotel-a", name: "Hotel A" } },
  });
  const reset = setWebPushTestHooks({
    generateVapidKeys: validVapidKeys,
    sendNotification: async () => {
      const error = new Error("Push subscription expired.");
      error.statusCode = 410;
      throw error;
    },
  });

  try {
    const subscription = await subscribeUserPush(database, {
      userId: "manager",
      tenantId: "hotel-a",
      subscription: browserSubscription("expired-endpoint"),
    });
    const result = await sendNewCheckoutPush(database, {
      tenant: database.data.tenants.hotel,
      room: { id: "room-1", number: "1" },
      event: { id: "checkout-1", tenantId: "hotel-a", roomId: "room-1", source: "qr" },
    });
    const diagnostic = await getCheckoutPushDiagnostic(database, "hotel-a");

    assert.equal(result.status, "provider_rejected");
    assert.equal(result.rejectedByProvider, 1);
    assert.equal(diagnostic.results[0].httpStatus, 410);
    assert.equal(diagnostic.results[0].disabled, true);
    assert.ok(database.data.pushSubscriptions[subscription.id].disabledAt);

    const followingResult = await sendNewCheckoutPush(database, {
      tenant: database.data.tenants.hotel,
      room: { id: "room-2", number: "2" },
      event: { id: "checkout-2", tenantId: "hotel-a", roomId: "room-2", source: "manual" },
    });
    assert.equal(followingResult.status, "subscriptions_disabled");
    assert.equal(followingResult.activeSubscriptions, 0);
    assert.equal(followingResult.disabledSubscriptions, 1);
    assert.equal((await getCheckoutPushDiagnostic(database, "hotel-a")).missingSubscriptions, 0);
  } finally {
    reset();
  }
});

test("scheduled push is persisted and sent when due without a frontend timer", async () => {
  const sent = [];
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", slug: "hotel-a", name: "Hotel A", active: true },
    },
  });
  const reset = setWebPushTestHooks({
    generateVapidKeys: validVapidKeys,
    sendNotification: async (subscription, payload) => {
      sent.push({ subscription, payload: JSON.parse(payload) });
    },
  });

  try {
    await subscribeUserPush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-a"),
    });
    const scheduled = await schedulePush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      endpoint: "endpoint-a",
      title: "HotelApp",
      body: "scheduled",
      url: "/t/hotel-a/",
      sendAt: new Date(Date.now() - 1000).toISOString(),
    });

    assert.equal(database.data.scheduledPushes[scheduled.id].status, "pending");
    const pendingStatus = await getScheduledPushStatus(database, {
      id: scheduled.id,
      userId: "user-a",
      tenantId: "hotel-a",
    });
    assert.equal(pendingStatus.status, "pending");
    assert.equal(pendingStatus.sendAt, scheduled.sendAt);

    const results = await processDueScheduledPushes(database);
    assert.equal(results.length, 1);
    assert.equal(results[0].sent, true);
    assert.equal(database.data.scheduledPushes[scheduled.id].status, "sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.body, "scheduled");
    const sentStatus = await getScheduledPushStatus(database, {
      id: scheduled.id,
      userId: "user-a",
      tenantId: "hotel-a",
    });
    assert.equal(sentStatus.status, "sent");
    assert.ok(sentStatus.sentAt);
    assert.equal(sentStatus.error, "");
    assert.equal(sentStatus.providerReason, "");
  } finally {
    reset();
  }
});

test("scheduled push status reflects provider failures", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", slug: "hotel-a", name: "Hotel A", active: true },
    },
  });
  const reset = setWebPushTestHooks({
    generateVapidKeys: validVapidKeys,
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
    const scheduled = await schedulePush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      endpoint: "endpoint-a",
      title: "HotelApp",
      body: "scheduled",
      url: "/t/hotel-a/",
      sendAt: new Date(Date.now() - 1000).toISOString(),
    });

    const results = await processDueScheduledPushes(database);
    assert.equal(results.length, 1);
    assert.equal(results[0].sent, false);
    assert.equal(database.data.scheduledPushes[scheduled.id].status, "failed");

    const status = await getScheduledPushStatus(database, {
      id: scheduled.id,
      userId: "user-a",
      tenantId: "hotel-a",
    });
    assert.equal(status.status, "failed");
    assert.equal(status.error, "Apple Web Push rejected the JWT.");
    assert.equal(status.httpStatus, 403);
    assert.equal(status.providerReason, "BadJwtToken");
  } finally {
    reset();
  }
});

test("test push uses the backend web push path", async () => {
  const sent = [];
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", slug: "hotel-a", name: "Hotel A", active: true },
    },
  });
  const reset = setWebPushTestHooks({
    generateVapidKeys: validVapidKeys,
    sendNotification: async (subscription, payload) => {
      sent.push({ subscription, payload: JSON.parse(payload) });
    },
  });

  try {
    await subscribeUserPush(database, {
      userId: "user-a",
      tenantId: "hotel-a",
      subscription: browserSubscription("endpoint-a"),
    });

    const result = await sendTestPushToSubscription(database, {
      userId: "user-a",
      endpoint: "endpoint-a",
      tenant: database.data.tenants["hotel-a"],
    });

    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.type, "push.test");
  } finally {
    reset();
  }
});
