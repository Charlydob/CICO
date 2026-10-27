import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEventProcessor } from "../eventProcessor.js";
import {
  archiveRoom,
  createKeyIdentifier,
  createKeyIdentifiersBulk,
  createRoom,
  createRoomsBulk,
  checkoutIdentifierFromValue,
  createCheckoutAttemptToken,
  deleteKeyIdentifier,
  ensureRoomOccupiedCycle,
  listCheckoutOverview,
  registerCheckout,
  registerCheckoutByIdentifier,
  resolveCheckoutByIdentifier,
  setTodayCheckoutRooms,
  updateKeyIdentifier,
  updateRoom,
  updateManagedRoom,
} from "./checkoutService.js";
import { requireModule } from "./tenantService.js";

function createFakeDatabase(initial = {}) {
  const data = {
    users: {},
    memberships: {},
    tenants: {},
    tenantModules: {},
    rooms: {},
    keyIdentifiers: {},
    checkoutEvents: {},
    occupancyCycles: {},
    checkIns: {},
    detections: {},
    diagnostics: {},
    tenantSettings: {},
    ...initial,
  };
  const roomQueues = new Map();

  async function getTenantRecord(collection, tenantId, id) {
    const record = data[collection][id];
    return record?.tenantId === tenantId ? record : undefined;
  }

  async function listTenantRecords(collection, tenantId) {
    return Object.values(data[collection]).filter((record) => record.tenantId === tenantId);
  }

  async function ensureCurrentOccupancyCycle({
    tenantId,
    roomId,
    reason = "ready",
    metadata = {},
    reservationCode,
    guestName,
    guestEmail,
    departureAt,
  }) {
    const current = Object.values(data.occupancyCycles).find(
      (cycle) => cycle.tenantId === tenantId && cycle.roomId === roomId && !cycle.consumedAt,
    );

    if (current) {
      Object.assign(current, {
        reservationCode:
          reservationCode === undefined ? current.reservationCode : String(reservationCode || ""),
        guestName: guestName === undefined ? current.guestName : String(guestName || ""),
        guestEmail: guestEmail === undefined ? current.guestEmail : String(guestEmail || ""),
        departureAt: departureAt === undefined ? current.departureAt : departureAt,
        metadata: {
          ...(current.metadata || {}),
          ...(metadata || {}),
        },
      });
      return { cycle: current, created: false };
    }

    const cycleNumber =
      Object.values(data.occupancyCycles)
        .filter((cycle) => cycle.tenantId === tenantId && cycle.roomId === roomId)
        .reduce((highest, cycle) => Math.max(highest, Number(cycle.cycleNumber || 0)), 0) + 1;
    const cycle = {
      id: `cycle-${randomUUID()}`,
      tenantId,
      roomId,
      cycleNumber,
      openedAt: new Date().toISOString(),
      createdReason: reason,
      consumedAt: null,
      reservationCode: String(reservationCode || ""),
      guestName: String(guestName || ""),
      guestEmail: String(guestEmail || ""),
      departureAt: departureAt || null,
      metadata: metadata || {},
    };
    data.occupancyCycles[cycle.id] = cycle;
    return { cycle, created: true };
  }

  async function registerCheckoutForCurrentCycle(input) {
    const queueKey = `${input.tenantId}:${input.roomId}`;
    const previous = roomQueues.get(queueKey) || Promise.resolve();
    const next = previous.then(async () => {
      const room = await getTenantRecord("rooms", input.tenantId, input.roomId);

      if (!room || room.active === false) {
        const error = new Error("Room not found.");
        error.statusCode = 404;
        throw error;
      }

      const current = Object.values(data.occupancyCycles).find(
        (cycle) =>
          cycle.tenantId === input.tenantId && cycle.roomId === input.roomId && !cycle.consumedAt,
      );

      if (
        !current &&
        input.suppressIfRoomPending &&
        ["ready_for_cleaning", "cleaning"].includes(room.status)
      ) {
        const duplicateEvent = Object.values(data.checkoutEvents)
          .filter((event) => event.tenantId === input.tenantId && event.roomId === input.roomId)
          .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())[0];
        return { duplicate: true, event: duplicateEvent, room };
      }

      if (current && input.occupancyCycleId && current.id !== input.occupancyCycleId) {
        const error = new Error("This checkout page is no longer valid.");
        error.statusCode = 409;
        error.code = "STALE_CHECKOUT_ATTEMPT";
        throw error;
      }

      if (!current && input.occupancyCycleId) {
        const duplicateEvent = Object.values(data.checkoutEvents).find(
          (event) => event.occupancyCycleId === input.occupancyCycleId,
        );
        const cycle = data.occupancyCycles[input.occupancyCycleId];

        if (cycle?.consumedAt && duplicateEvent) {
          return { duplicate: true, event: duplicateEvent, room };
        }

        const error = new Error("This checkout page is no longer valid.");
        error.statusCode = 409;
        error.code = "STALE_CHECKOUT_ATTEMPT";
        throw error;
      }

      const cycle =
        current ||
        (
          await ensureCurrentOccupancyCycle({
            tenantId: input.tenantId,
            roomId: input.roomId,
            reason: "checkout_recovery",
          })
        ).cycle;
      const duplicateEvent = Object.values(data.checkoutEvents).find(
        (event) => event.occupancyCycleId === cycle.id,
      );

      if (duplicateEvent) {
        return { duplicate: true, event: duplicateEvent, room };
      }

      const timestamp = new Date().toISOString();
      const event = {
        id: input.id || randomUUID(),
        tenantId: input.tenantId,
        roomId: input.roomId,
        occupancyCycleId: cycle.id,
        source: input.source,
        sourceIdentifier: input.sourceIdentifier,
        status: "registered",
        timestamp,
        metadata: input.metadata || {},
      };
      const updatedRoom = {
        ...room,
        status: "ready_for_cleaning",
        lastCheckoutAt: timestamp,
        lastCheckoutSource: input.source,
        updatedAt: timestamp,
      };
      data.checkoutEvents[event.id] = event;
      data.occupancyCycles[cycle.id] = { ...cycle, consumedAt: timestamp };
      data.rooms[room.id] = updatedRoom;
      return { duplicate: false, event, room: updatedRoom };
    });
    roomQueues.set(queueKey, next.catch(() => undefined));
    return next;
  }

  return {
    data,
    async setRecord(collection, id, value) {
      data[collection][id] = { ...value, id };
      return data[collection][id];
    },
    async getRecord(collection, id) {
      return data[collection][id];
    },
    async listRecords(collection) {
      return Object.values(data[collection]);
    },
    async deleteRecord(collection, id) {
      delete data[collection][id];
    },
    listTenantRecords,
    getTenantRecord,
    async getTenantModules(tenantId) {
      return Object.fromEntries(
        Object.values(data.tenantModules[tenantId] || {}).map((module) => [
          module.moduleId,
          module.enabled,
        ]),
      );
    },
    async setTenantModule(tenantId, moduleId, enabled) {
      data.tenantModules[tenantId] ||= {};
      data.tenantModules[tenantId][moduleId] = { tenantId, moduleId, enabled };
      return data.tenantModules[tenantId][moduleId];
    },
    async createCheckIn(checkIn) {
      const id = checkIn.id || randomUUID();
      data.checkIns[id] = { ...checkIn, id };
      return data.checkIns[id];
    },
    async getCheckIns() {
      return Object.values(data.checkIns);
    },
    async updateStripeDiagnostic(diagnostic) {
      data.diagnostics.stripe = {
        key: "stripe",
        value: {
          ...(data.diagnostics.stripe?.value || {}),
          ...diagnostic,
        },
      };
      return data.diagnostics.stripe;
    },
    async getDetections() {
      return Object.values(data.detections);
    },
    async updateDetection(id, patch) {
      data.detections[id] = { ...data.detections[id], ...patch };
      return data.detections[id];
    },
    ensureCurrentOccupancyCycle,
    registerCheckoutForCurrentCycle,
  };
}

function withN8nCheckoutWebhook(fetchImplementation, callback) {
  const originalFetch = global.fetch;
  const originalUrl = process.env.N8N_CHECKOUT_WEBHOOK_URL;
  const originalSecret = process.env.N8N_CHECKOUT_WEBHOOK_SECRET;

  global.fetch = fetchImplementation;
  process.env.N8N_CHECKOUT_WEBHOOK_URL = "https://n8n.example.test/webhook/checkout";
  process.env.N8N_CHECKOUT_WEBHOOK_SECRET = "shared-secret";

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      global.fetch = originalFetch;
      if (originalUrl === undefined) {
        delete process.env.N8N_CHECKOUT_WEBHOOK_URL;
      } else {
        process.env.N8N_CHECKOUT_WEBHOOK_URL = originalUrl;
      }
      if (originalSecret === undefined) {
        delete process.env.N8N_CHECKOUT_WEBHOOK_SECRET;
      } else {
        process.env.N8N_CHECKOUT_WEBHOOK_SECRET = originalSecret;
      }
    });
}

function createNotificationDatabase({ tenantId = "hotelA", enabled = true, chatId = "chat-a" } = {}) {
  return createFakeDatabase({
    tenants: {
      [tenantId]: { id: tenantId, name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      [tenantId]: { checkout: { moduleId: "checkout", enabled: true } },
    },
    tenantSettings: {
      [tenantId]: {
        tenantId,
        notifications: {
          telegram: { enabled, chatId, botToken: "legacy-token" },
        },
      },
    },
  });
}

function parseWebhookCall(call) {
  return {
    url: call[0],
    init: call[1],
    payload: JSON.parse(call[1].body),
  };
}

test("module entitlement is enforced per tenant", async () => {
  const database = createFakeDatabase({
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
      hotelB: { checkout: { moduleId: "checkout", enabled: false } },
    },
  });

  await assert.doesNotReject(() =>
    requireModule(database, { activeTenantId: "hotelA",memberships:[{tenantId:"hotelA",role:"tenant_admin"}] }, "checkout"),
  );
  await assert.rejects(
    () => requireModule(database, { activeTenantId: "hotelB",memberships:[{tenantId:"hotelB",role:"tenant_admin"}] }, "checkout"),
    /not enabled/,
  );
});

test("room access codes remain strings and can be added, changed, and cleared", async () => {
  const database = createFakeDatabase();
  const room = await createRoom(database, "hotelA", { number: "102", accessCode: "0421" });

  assert.equal(room.accessCode, "0421");
  assert.equal((await listCheckoutOverview(database, "hotelA")).rooms[0].accessCode, "0421");

  const changed = await updateRoom(database, "hotelA", room.id, { accessCode: "A739" });
  assert.equal(changed.accessCode, "A739");

  const cleared = await updateRoom(database, "hotelA", room.id, { accessCode: "" });
  assert.equal(cleared.accessCode, null);
});

test("room overview returns null access codes for legacy rooms", async () => {
  const database = createFakeDatabase({
    rooms: { legacy: { id: "legacy", tenantId: "hotelA", number: "101", active: true } },
  });

  const overview = await listCheckoutOverview(database, "hotelA");
  assert.equal(overview.rooms[0].accessCode, null);
});

test("setting today's checkout rooms refreshes the Telegram housekeeping board", async () => {
  const calls = [];
  const database = createNotificationDatabase();
  const firstRoom = await createRoom(database, "hotelA", { number: "204" });
  const secondRoom = await createRoom(database, "hotelA", { number: "206" });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    const result = await setTodayCheckoutRooms(
      database,
      "hotelA",
      [firstRoom.id, secondRoom.id],
      "2026-08-26",
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(result.roomIds, [firstRoom.id, secondRoom.id]);
    assert.equal(database.data.rooms[firstRoom.id].checkoutDueDate, "2026-08-26");
    assert.equal(database.data.rooms[secondRoom.id].checkoutDueDate, "2026-08-26");
    assert.equal(calls.length, 1);

    const webhook = parseWebhookCall(calls[0]);
    assert.equal(webhook.url, "https://n8n.example.test/webhook/checkout");
    assert.equal(webhook.init.headers["X-HotelApp-Secret"], "shared-secret");
    assert.deepEqual(webhook.payload, {
      event: "housekeeping.board.refresh",
      tenant: { id: "hotelA", slug: "hotel-a", name: "Hotel A" },
      notification: { chatId: "chat-a", timezone: "Europe/Zurich" },
      reason: "checkout_today_changed",
      timestamp: webhook.payload.timestamp,
    });
    assert.ok(!Number.isNaN(Date.parse(webhook.payload.timestamp)));
    assert.equal(Object.values(database.data.checkoutEvents).length, 0);
  });
});

test("setting today's checkout rooms succeeds when the board refresh fails", async () => {
  const database = createNotificationDatabase();
  const room = await createRoom(database, "hotelA", { number: "204" });

  await withN8nCheckoutWebhook(async () => {
    throw new Error("n8n unavailable");
  }, async () => {
    await assert.doesNotReject(() =>
      setTodayCheckoutRooms(database, "hotelA", [room.id], "2026-08-26"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.data.rooms[room.id].checkoutDueDate, "2026-08-26");
  });
});

test("QR checkout sends n8n webhook", async () => {
  const calls = [];
  const database = createNotificationDatabase();
  const room = await createRoom(database, "hotelA", { number: "109" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    const target = await resolveCheckoutByIdentifier(database, key.identifier, "qr");
    const result = await registerCheckoutByIdentifier(database, key.identifier, "qr", {
      attemptToken: target.attemptToken,
    });

    assert.equal(result.duplicate, false);
    assert.equal(calls.length, 1);
    const { url, init, payload } = parseWebhookCall(calls[0]);
    assert.equal(url, "https://n8n.example.test/webhook/checkout");
    assert.equal(init.headers["X-HotelApp-Secret"], "shared-secret");
    assert.equal(payload.event, "checkout.completed");
    assert.equal(payload.checkout.source, "qr");
    assert.equal(payload.room.number, "109");
    assert.equal(database.data.diagnostics["checkout-push:hotelA"].eventSource, "qr");
  });
});

test("manual checkout sends n8n webhook", async () => {
  const calls = [];
  const database = createNotificationDatabase();
  const room = await createRoom(database, "hotelA", { number: "204" });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    const result = await registerCheckout(database, "hotelA", room.id, "manual");

    assert.equal(result.duplicate, false);
    assert.equal(calls.length, 1);
    assert.equal(parseWebhookCall(calls[0]).payload.checkout.source, "manual");
    assert.equal(database.data.diagnostics["checkout-push:hotelA"].eventSource, "manual");
  });
});

test("checkout webhook uses the correct tenant and chatId", async () => {
  const calls = [];
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
      hotelB: { id: "hotelB", name: "Hotel B", slug: "hotel-b", active: true },
    },
    tenantSettings: {
      hotelA: {
        tenantId: "hotelA",
        notifications: { telegram: { enabled: true, chatId: "chat-a" } },
      },
      hotelB: {
        tenantId: "hotelB",
        notifications: { telegram: { enabled: true, chatId: "chat-b" } },
      },
    },
  });
  const room = await createRoom(database, "hotelB", { number: "305", name: "Suite" });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    await registerCheckout(database, "hotelB", room.id, "manual");

    assert.equal(calls.length, 1);
    const { payload } = parseWebhookCall(calls[0]);
    assert.deepEqual(payload.tenant, {
      id: "hotelB",
      slug: "hotel-b",
      name: "Hotel B",
    });
    assert.equal(payload.notification.chatId, "chat-b");
    assert.equal(payload.room.id, room.id);
    assert.equal(payload.room.name, "Suite");
  });
});

test("checkout webhook includes the persisted housekeeping board reference", async () => {
  const calls = [];
  const database = createNotificationDatabase();
  database.data.diagnostics.telegramHousekeepingBoards = {
    hotelA: {
      tenantId: "hotelA",
      chatId: "chat-a",
      messageId: 12345,
      threadId: 12,
      updatedAt: "2026-08-25T10:00:00.000Z",
    },
  };
  const room = await createRoom(database, "hotelA", { number: "204" });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    await registerCheckout(database, "hotelA", room.id, "manual");

    assert.equal(calls.length, 1);
    assert.deepEqual(parseWebhookCall(calls[0]).payload.notification.housekeepingBoard, {
      tenantId: "hotelA",
      chatId: "chat-a",
      messageId: 12345,
      threadId: 12,
      updatedAt: "2026-08-25T10:00:00.000Z",
    });
  });
});

test("duplicate checkout does not send another n8n webhook", async () => {
  const calls = [];
  const database = createNotificationDatabase();
  const room = await createRoom(database, "hotelA", { number: "109" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    const target = await resolveCheckoutByIdentifier(database, key.identifier, "qr");
    const first = await registerCheckoutByIdentifier(database, key.identifier, "qr", {
      attemptToken: target.attemptToken,
    });
    const second = await registerCheckoutByIdentifier(database, key.identifier, "qr", {
      attemptToken: target.attemptToken,
    });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(calls.length, 1);
  });
});

test("repeated RFID after its debounce window remains idempotent for the occupancy cycle", async () => {
  const calls = [];
  const database = createNotificationDatabase();
  const room = await createRoom(database, "hotelA", { number: "204", status: "occupied" });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    const first = await registerCheckout(database, "hotelA", room.id, "rfid", {
      suppressIfRoomPending: true,
      sourceIdentifier: "reading-1",
    });
    const repeated = await registerCheckout(database, "hotelA", room.id, "rfid", {
      suppressIfRoomPending: true,
      sourceIdentifier: "reading-2",
    });

    assert.equal(first.duplicate, false);
    assert.equal(repeated.duplicate, true);
    assert.equal(Object.values(database.data.checkoutEvents).length, 1);
    assert.equal(database.data.rooms[room.id].status, "ready_for_cleaning");
    assert.equal(calls.length, 1);
  });
});

test("n8n webhook failure does not break checkout registration", async () => {
  const database = createNotificationDatabase();
  const room = await createRoom(database, "hotelA", { number: "109" });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    await withN8nCheckoutWebhook(async () => {
      throw new Error("n8n unavailable");
    }, async () => {
      const result = await registerCheckout(database, "hotelA", room.id, "manual");
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(result.duplicate, false);
      assert.equal(Object.values(database.data.checkoutEvents).length, 1);
      assert.equal(warnings.some((warning) => warning.includes("n8n checkout webhook failed")), true);
    });
  } finally {
    console.warn = originalWarn;
  }
});

test("n8n webhook failure stores tenant Telegram diagnostics", async () => {
  const database = createNotificationDatabase();
  const room = await createRoom(database, "hotelA", { number: "109" });

  await withN8nCheckoutWebhook(async () => {
    return { ok: false, status: 503 };
  }, async () => {
    const result = await registerCheckout(database, "hotelA", room.id, "manual");
    await new Promise((resolve) => setImmediate(resolve));
    const diagnostics =
      database.data.tenantSettings.hotelA.notifications.telegram.diagnostics;

    assert.equal(result.duplicate, false);
    assert.equal(diagnostics.httpStatus, 503);
    assert.equal(diagnostics.lastError, "n8n HTTP 503");
    assert.equal(diagnostics.checkoutEventId, result.event.id);
    assert.equal(diagnostics.room, "109");
    assert.equal(diagnostics.source, "manual");
  });
});

test("disabled Telegram notifications do not call n8n webhook", async () => {
  const calls = [];
  const database = createNotificationDatabase({ enabled: false, chatId: "chat-a" });
  const room = await createRoom(database, "hotelA", { number: "109" });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    const result = await registerCheckout(database, "hotelA", room.id, "manual");

    assert.equal(result.duplicate, false);
    assert.equal(calls.length, 0);
  });
});

test("missing Telegram chatId does not call n8n webhook", async () => {
  const calls = [];
  const database = createNotificationDatabase({ enabled: true, chatId: "" });
  const room = await createRoom(database, "hotelA", { number: "109" });

  await withN8nCheckoutWebhook(async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  }, async () => {
    const result = await registerCheckout(database, "hotelA", room.id, "manual");

    assert.equal(result.duplicate, false);
    assert.equal(calls.length, 0);
  });
});

test("tenant-scoped room listing never returns another tenant room", async () => {
  const database = createFakeDatabase();
  await database.setRecord("rooms", "a-room", {
    id: "a-room",
    tenantId: "hotelA",
    number: "101",
    active: true,
    status: "unknown",
  });
  await database.setRecord("rooms", "b-room", {
    id: "b-room",
    tenantId: "hotelB",
    number: "202",
    active: true,
    status: "unknown",
  });

  const overview = await listCheckoutOverview(database, "hotelA");

  assert.deepEqual(
    overview.rooms.map((room) => room.number),
    ["101"],
  );
});

test("bulk room creation trims, deduplicates, skips existing rooms, and creates QR keys", async () => {
  const database = createFakeDatabase();
  await createRoom(database, "hotelA", { number: "102" });

  const result = await createRoomsBulk(database, "hotelA", {
    numbers: "101, 102,\n103\n101\n  ",
    createQr: true,
    keyLabel: "Checkout",
  });

  assert.deepEqual(
    result.created.map((room) => room.number),
    ["101", "103"],
  );
  assert.deepEqual(
    result.skippedExisting.map((room) => room.number),
    ["102"],
  );
  assert.deepEqual(result.duplicateInput, ["101"]);
  assert.equal(result.keys.length, 2);
  assert.equal(result.keys.every((key) => key.label === "Checkout"), true);
});

test("bulk room creation can skip QR creation", async () => {
  const database = createFakeDatabase();
  const result = await createRoomsBulk(database, "hotelA", {
    numbers: "201\n202",
    createQr: false,
  });

  assert.equal(result.created.length, 2);
  assert.equal(result.keys.length, 0);
  assert.equal(Object.values(database.data.keyIdentifiers).length, 0);
});

test("bulk QR generation skips existing active keys by default", async () => {
  const database = createFakeDatabase();
  const room101 = await createRoom(database, "hotelA", { number: "101" });
  await createRoom(database, "hotelA", { number: "102" });
  await createKeyIdentifier(database, "hotelA", { roomId: room101.id, label: "Existing" });

  const result = await createKeyIdentifiersBulk(database, "hotelA", {
    label: "Checkout",
  });

  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.skippedExisting, 1);
  assert.equal(result.skippedExisting[0].roomNumber, "101");
  assert.equal(Object.values(database.data.keyIdentifiers).filter((key) => key.active).length, 2);
});

test("bulk QR generation regenerates existing keys only when explicitly requested", async () => {
  const database = createFakeDatabase();
  const room = await createRoom(database, "hotelA", { number: "101" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id, label: "Old" });

  const result = await createKeyIdentifiersBulk(database, "hotelA", {
    label: "Checkout",
    regenerateExisting: true,
  });

  assert.equal(result.summary.created, 0);
  assert.equal(result.summary.regenerated, 1);
  assert.notEqual(result.regenerated[0].identifier, key.identifier);
  assert.equal(result.regenerated[0].label, "Checkout");
  assert.equal(Object.values(database.data.keyIdentifiers).filter((item) => item.active).length, 1);
});

test("QR identifier resolves room, updates room state and is idempotent", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });

  const target = await resolveCheckoutByIdentifier(database, key.identifier, "qr");
  const first = await registerCheckoutByIdentifier(database, key.identifier, "qr", {
    attemptToken: target.attemptToken,
  });
  const second = await registerCheckoutByIdentifier(database, key.identifier, "qr", {
    attemptToken: target.attemptToken,
  });
  const updatedRoom = await database.getTenantRecord("rooms", "hotelA", room.id);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(updatedRoom.status, "ready_for_cleaning");
  assert.equal(Object.values(database.data.checkoutEvents).length, 1);
});

function cyclesForRoom(database, roomId) {
  return Object.values(database.data.occupancyCycles)
    .filter((cycle) => cycle.roomId === roomId)
    .sort((left, right) => Number(left.cycleNumber) - Number(right.cycleNumber));
}

function currentCycleForRoom(database, roomId) {
  return cyclesForRoom(database, roomId).find((cycle) => !cycle.consumedAt);
}

async function checkoutWithResolvedQr(database, key) {
  const target = await resolveCheckoutByIdentifier(database, key.identifier, "qr");
  const result = await registerCheckoutByIdentifier(database, key.identifier, "qr", {
    attemptToken: target.attemptToken,
  });
  return { target, result };
}

test("static QR checkout follows the ready-created occupancy cycle lifecycle", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109", status: "occupied" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });

  assert.equal(cyclesForRoom(database, room.id).length, 1);
  assert.equal(currentCycleForRoom(database, room.id).cycleNumber, 1);

  const first = await checkoutWithResolvedQr(database, key);

  assert.equal(first.result.duplicate, false);
  assert.equal(cyclesForRoom(database, room.id)[0].consumedAt, first.result.event.timestamp);

  await updateRoom(database, "hotelA", room.id, { status: "cleaning" });
  await updateRoom(database, "hotelA", room.id, { status: "ready" });

  assert.equal(cyclesForRoom(database, room.id).length, 2);
  assert.equal(currentCycleForRoom(database, room.id).cycleNumber, 2);

  await updateRoom(database, "hotelA", room.id, { status: "ready" });

  assert.equal(cyclesForRoom(database, room.id).length, 2);

  await ensureRoomOccupiedCycle(database, "hotelA", room.id, {
    reservationCode: "RES-2",
    guestName: "Ada Lovelace",
    guestEmail: "ada@example.test",
    metadata: { source: "stripe" },
  });

  assert.equal(cyclesForRoom(database, room.id).length, 2);
  assert.equal(currentCycleForRoom(database, room.id).reservationCode, "RES-2");

  await updateRoom(database, "hotelA", room.id, { status: "occupied" });

  assert.equal(cyclesForRoom(database, room.id).length, 2);

  const second = await checkoutWithResolvedQr(database, key);
  const lastCheckoutAt = second.result.room.lastCheckoutAt;
  const duplicate = await registerCheckoutByIdentifier(database, key.identifier, "qr", {
    attemptToken: second.target.attemptToken,
  });

  assert.equal(second.result.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(Object.values(database.data.checkoutEvents).length, 2);
  assert.equal(database.data.rooms[room.id].lastCheckoutAt, lastCheckoutAt);

  await updateRoom(database, "hotelA", room.id, { status: "cleaning" });
  await updateRoom(database, "hotelA", room.id, { status: "ready" });

  assert.equal(cyclesForRoom(database, room.id).length, 3);
  assert.equal(currentCycleForRoom(database, room.id).cycleNumber, 3);

  const third = await checkoutWithResolvedQr(database, key);

  assert.equal(third.result.duplicate, false);
  assert.equal(Object.values(database.data.checkoutEvents).length, 3);
});

test("Stripe check-in after Ready reuses the current cycle", async () => {
  const database = createFakeDatabase({
    rooms: {},
  });
  const room = await createRoom(database, "hotelA", { number: "109", status: "ready" });
  const readyCycle = currentCycleForRoom(database, room.id);
  const processor = createEventProcessor({
    database,
    frigateClient: {},
    fileStorage: {},
    processedEvents: {},
    plateCooldown: {},
    tenantId: "hotelA",
  });

  const checkIn = await processor.processCheckInEvent({
    tenantId: "hotelA",
    reservationCode: "STRIPE-2",
    fullName: "Ada Lovelace",
    email: "ada@example.test",
    room: "109",
    checkInAt: new Date().toISOString(),
    source: "stripe",
    stripeEventId: "evt_2",
  });

  assert.equal(checkIn.reservationCode, "STRIPE-2");
  assert.equal(cyclesForRoom(database, room.id).length, 1);
  assert.equal(currentCycleForRoom(database, room.id).id, readyCycle.id);
  assert.equal(currentCycleForRoom(database, room.id).reservationCode, "STRIPE-2");
  assert.equal(database.data.rooms[room.id].status, "occupied");
});

test("stale old-cycle checkout page is rejected after Ready opens the next cycle", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109", status: "occupied" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });
  const oldPage = await resolveCheckoutByIdentifier(database, key.identifier, "qr");

  await registerCheckoutByIdentifier(database, key.identifier, "qr", {
    attemptToken: oldPage.attemptToken,
  });
  await updateRoom(database, "hotelA", room.id, { status: "ready" });

  await assert.rejects(
    () =>
      registerCheckoutByIdentifier(database, key.identifier, "qr", {
        attemptToken: oldPage.attemptToken,
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "STALE_CHECKOUT_ATTEMPT");
      return true;
    },
  );
  assert.equal(Object.values(database.data.checkoutEvents).length, 1);
});

test("direct public checkout API replay without attempt token is rejected", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109", status: "occupied" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });

  await assert.rejects(
    () => registerCheckoutByIdentifier(database, key.identifier, "qr"),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, "CHECKOUT_ATTEMPT_INVALID");
      return true;
    },
  );
  assert.equal(Object.values(database.data.checkoutEvents).length, 0);
});

test("expired checkout attempt token is rejected", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109", status: "occupied" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });
  const cycle = currentCycleForRoom(database, room.id);
  const expiredToken = createCheckoutAttemptToken({
    tenantId: "hotelA",
    roomId: room.id,
    occupancyCycleId: cycle.id,
    expiresAt: Date.now() - 1000,
  });

  await assert.rejects(
    () =>
      registerCheckoutByIdentifier(database, key.identifier, "qr", {
        attemptToken: expiredToken,
      }),
    (error) => {
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, "CHECKOUT_ATTEMPT_EXPIRED");
      return true;
    },
  );
});

test("concurrent same-cycle checkout requests produce one event", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109", status: "occupied" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });
  const target = await resolveCheckoutByIdentifier(database, key.identifier, "qr");
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      registerCheckoutByIdentifier(database, key.identifier, "qr", {
        attemptToken: target.attemptToken,
      }),
    ),
  );

  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 7);
  assert.equal(Object.values(database.data.checkoutEvents).length, 1);
});

test("different rooms can checkout concurrently", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room109 = await createRoom(database, "hotelA", { number: "109", status: "occupied" });
  const room204 = await createRoom(database, "hotelA", { number: "204", status: "occupied" });
  const key109 = await createKeyIdentifier(database, "hotelA", { roomId: room109.id });
  const key204 = await createKeyIdentifier(database, "hotelA", { roomId: room204.id });
  const [target109, target204] = await Promise.all([
    resolveCheckoutByIdentifier(database, key109.identifier, "qr"),
    resolveCheckoutByIdentifier(database, key204.identifier, "qr"),
  ]);
  const [checkout109, checkout204] = await Promise.all([
    registerCheckoutByIdentifier(database, key109.identifier, "qr", {
      attemptToken: target109.attemptToken,
    }),
    registerCheckoutByIdentifier(database, key204.identifier, "qr", {
      attemptToken: target204.attemptToken,
    }),
  ]);

  assert.equal(checkout109.duplicate, false);
  assert.equal(checkout204.duplicate, false);
  assert.equal(Object.values(database.data.checkoutEvents).length, 2);
});

test("direct checkout URL is normalized to the secure key identifier", () => {
  assert.equal(
    checkoutIdentifierFromValue("https://hotelapp.charlydob.com/checkout/ck_securetoken"),
    "ck_securetoken",
  );
  assert.equal(checkoutIdentifierFromValue("ck_securetoken"), "ck_securetoken");
});

test("valid QR can be resolved without registering checkout", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });

  const target = await resolveCheckoutByIdentifier(database, key.identifier, "qr");

  assert.equal(target.room.number, "109");
  assert.equal(target.tenant.slug, "hotel-a");
  assert.equal(Object.values(database.data.checkoutEvents).length, 0);
});

test("invalid QR is rejected", async () => {
  const database = createFakeDatabase();

  await assert.rejects(
    () => resolveCheckoutByIdentifier(database, "not-a-real-key", "qr"),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "QR_INVALID");
      return true;
    },
  );
});

test("deactivated QR is rejected distinctly", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "109" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });
  await updateKeyIdentifier(database, "hotelA", key.id, { active: false });

  await assert.rejects(
    () => resolveCheckoutByIdentifier(database, key.identifier, "qr"),
    (error) => {
      assert.equal(error.statusCode, 410);
      assert.equal(error.code, "QR_DEACTIVATED");
      return true;
    },
  );
});

test("deleted QR is removed and no longer resolves", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "201" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });

  await deleteKeyIdentifier(database, "hotelA", key.id);

  assert.equal(database.data.rooms[room.id].number, "201");
  assert.equal(Object.values(database.data.keyIdentifiers).length, 0);
  await assert.rejects(
    () => resolveCheckoutByIdentifier(database, key.identifier, "qr"),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "QR_INVALID");
      return true;
    },
  );
});

test("deleted room is archived, keeps history, deactivates keys, and can be recreated", async () => {
  const database = createFakeDatabase({
    tenants: {
      hotelA: { id: "hotelA", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantModules: {
      hotelA: { checkout: { moduleId: "checkout", enabled: true } },
    },
  });
  const room = await createRoom(database, "hotelA", { number: "201", status: "occupied" });
  const key = await createKeyIdentifier(database, "hotelA", { roomId: room.id });
  const target = await resolveCheckoutByIdentifier(database, key.identifier, "qr");
  await registerCheckoutByIdentifier(database, key.identifier, "qr", {
    attemptToken: target.attemptToken,
  });

  await assert.rejects(archiveRoom(database,"hotelA",room.id),{statusCode:409});
  const {applyHousekeepingAction}=await import("./housekeepingService.js");
  const event=Object.values(database.data.checkoutEvents)[0];
  for(const action of ["bed_done","cleaning_done","complete"])await applyHousekeepingAction(database,{tenantId:"hotelA",eventId:event.id,actor:{user:{id:"manager"},role:"manager"},action});
  const deletion = await archiveRoom(database, "hotelA", room.id);

  assert.equal(deletion.success, true);
  assert.equal(database.data.rooms[room.id].active, false);
  assert.ok(database.data.rooms[room.id].deletedAt);
  assert.equal(database.data.keyIdentifiers[key.id].active, false);
  assert.equal(Object.values(database.data.checkoutEvents).length, 1);

  const recreated = await createRoom(database, "hotelA", { number: "201" });
  assert.notEqual(recreated.id, room.id);
  assert.equal(recreated.number, "201");

  await assert.rejects(
    () => resolveCheckoutByIdentifier(database, key.identifier, "qr"),
    (error) => {
      assert.equal(error.statusCode, 410);
      assert.equal(error.code, "QR_DEACTIVATED");
      return true;
    },
  );
});


test('expected departures are audited and room edits cannot skip checkout or cleaning',async()=>{
 const db=createFakeDatabase(),room=await createRoom(db,'hotelA',{number:'111',status:'occupied'});
 await setTodayCheckoutRooms(db,'hotelA',[room.id],'2026-10-27','manager');
 const audit=Object.values(db.data.diagnostics).find(r=>r.action==='expected_departures_changed');assert.equal(audit.actorId,'manager');assert.equal(audit.changes[0].roomId,room.id);
 await assert.rejects(updateManagedRoom(db,'hotelA',room.id,{status:'ready'},'manager'),{statusCode:409});
 await registerCheckout(db,'hotelA',room.id,'manual');
 await assert.rejects(updateManagedRoom(db,'hotelA',room.id,{status:'occupied'},'manager'),{statusCode:409});
 await assert.rejects(updateManagedRoom(db,'hotelA',room.id,{active:false},'manager'),{statusCode:409});
 await assert.rejects(setTodayCheckoutRooms(db,'hotelA',[room.id],'2026-10-27','manager'),{statusCode:409});
});

test('parking temporal association never uses a guest from another hotel or its global plate state',async()=>{
 const at=new Date().toISOString(),db=createFakeDatabase({checkIns:{foreign:{id:'foreign',tenantId:'hotelA',reservationCode:'PRIVATE-A',fullName:'Private Guest',checkInAt:at,room:'101',parkingValid:true}},detections:{foreignDetection:{id:'foreignDetection',tenantId:'hotelA',plate:'FOREIGN',detectedAt:at,associationStatus:'unmatched'}}});
 let plateAccess=0;db.getPlateState=async()=>{plateAccess++;return {activeReservationCode:'PRIVATE-A'}};
 db.createDetection=async input=>{const row={...input,id:randomUUID()};db.data.detections[row.id]=row;return row;};
 const processor=createEventProcessor({database:db,tenantId:'hotelA',fileStorage:{},frigateClient:{},processedEvents:{},plateCooldown:{}});
 const detection=await processor.processFrigateDetection({tenantId:'hotelB',plate:'SAME123',detectedAt:at});
 assert.equal(detection.associationStatus,'unmatched');assert.equal(detection.guestName,undefined);assert.equal(plateAccess,0);
 await processor.processCheckInEvent({tenantId:'hotelB',reservationCode:'OWN-B',fullName:'B Guest',checkInAt:at});
 assert.notEqual(db.data.detections.foreignDetection.guestName,'B Guest');assert.notEqual(db.data.detections.foreignDetection.reservationCode,'OWN-B');
 assert.equal(db.data.detections[detection.id].guestName,'B Guest');
 assert.equal(db.data.detections[detection.id].reservationCode,'OWN-B');
});
