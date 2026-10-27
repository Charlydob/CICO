import test from "node:test";
import assert from "node:assert/strict";
import {
  connectTelegramChat,
  connectTelegramStaff,
  createStaffPairingCode,
  createTelegramPairingCode,
  disconnectTelegramChat,
  getHousekeepingBoard,
  getHousekeepingStaff,
  handleHousekeepingAction,
  registerManualTelegramCheckout,
  saveHousekeepingBoardMessage,
  validateTelegramIntegrationSecret,
} from "./telegramIntegrationService.js";
import {
  createRoom,
  registerCheckout,
  updateRoom,
} from "./checkoutService.js";

function createFakeDatabase(initial = {}) {
  const data = {
    tenants: {},
    tenantSettings: {},
    diagnostics: {},
    rooms: {},
    checkoutEvents: {},
    occupancyCycles: {},
    keyIdentifiers: {},
    ...initial,
  };

  return {
    data,
    async listRecords(collection) {
      return Object.values(data[collection] || {});
    },
    async listTenantRecords(collection, tenantId) {
      return Object.values(data[collection] || {}).filter((record) => record.tenantId === tenantId);
    },
    async getRecord(collection, id) {
      return data[collection]?.[id];
    },
    async getTenantRecord(collection, tenantId, id) {
      const record = data[collection]?.[id];
      return record?.tenantId === tenantId ? record : undefined;
    },
    async setRecord(collection, id, value) {
      data[collection] ||= {};
      data[collection][id] = { ...value, id };
      return data[collection][id];
    },
    async ensureCurrentOccupancyCycle({
      tenantId,
      roomId,
      reason = "ready",
      metadata = {},
    }) {
      const current = Object.values(data.occupancyCycles).find(
        (cycle) => cycle.tenantId === tenantId && cycle.roomId === roomId && !cycle.consumedAt,
      );

      if (current) {
        current.metadata = { ...(current.metadata || {}), ...metadata };
        return { cycle: current, created: false };
      }

      const cycleNumber =
        Object.values(data.occupancyCycles)
          .filter((cycle) => cycle.tenantId === tenantId && cycle.roomId === roomId)
          .reduce((highest, cycle) => Math.max(highest, Number(cycle.cycleNumber || 0)), 0) + 1;
      const cycle = {
        id: `cycle-${cycleNumber}`,
        tenantId,
        roomId,
        cycleNumber,
        openedAt: new Date().toISOString(),
        createdReason: reason,
        consumedAt: null,
        metadata,
      };
      data.occupancyCycles[cycle.id] = cycle;
      return { cycle, created: true };
    },
    async registerCheckoutForCurrentCycle(input) {
      const room = data.rooms[input.roomId];
      const current = Object.values(data.occupancyCycles).find(
        (cycle) => cycle.tenantId === input.tenantId && cycle.roomId === input.roomId && !cycle.consumedAt,
      );
      const cycle =
        current ||
        (
          await this.ensureCurrentOccupancyCycle({
            tenantId: input.tenantId,
            roomId: input.roomId,
            reason: "checkout_recovery",
          })
        ).cycle;
      const timestamp = new Date().toISOString();
      const event = {
        id: input.id,
        tenantId: input.tenantId,
        roomId: input.roomId,
        occupancyCycleId: cycle.id,
        source: input.source,
        sourceIdentifier: input.sourceIdentifier,
        status: "registered",
        timestamp,
        metadata: input.metadata || {},
      };
      data.checkoutEvents[event.id] = event;
      data.occupancyCycles[cycle.id] = { ...cycle, consumedAt: timestamp };
      data.rooms[room.id] = {
        ...room,
        status: "ready_for_cleaning",
        lastCheckoutAt: timestamp,
        lastCheckoutSource: input.source,
        checkoutDueDate: null,
        checkoutDueSource: null,
        updatedAt: timestamp,
      };
      return { duplicate: false, event, room: data.rooms[room.id] };
    },
  };
}

function withTelegramSecret(secret, callback) {
  const originalSecret = process.env.N8N_CHECKOUT_WEBHOOK_SECRET;
  process.env.N8N_CHECKOUT_WEBHOOK_SECRET = secret;

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (originalSecret === undefined) {
        delete process.env.N8N_CHECKOUT_WEBHOOK_SECRET;
      } else {
        process.env.N8N_CHECKOUT_WEBHOOK_SECRET = originalSecret;
      }
    });
}

test("housekeeping staff endpoint support authenticates and isolates active tenant members", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", active: true },
      "hotel-b": { id: "hotel-b", active: true },
    },
    tenantSettings: {
      "hotel-a": { notifications: { telegram: { enabled: true, chatId: "-1001" } } },
      "hotel-b": { notifications: { telegram: { enabled: true, chatId: "-1002" } } },
    },
    users: {
      admin: { id: "admin", email: "admin@example.test", displayName: "Admin", active: true, passwordHash: "hidden" },
      manager: { id: "manager", email: "manager@example.test", displayName: "Manager", active: true, telegramUserId: "22", telegramUsername: "@boss", passwordHash: "hidden" },
      staff: { id: "staff", email: "staff@example.test", displayName: "Staff", active: true, telegramUserId: null, passwordHash: "hidden" },
      inactive: { id: "inactive", email: "inactive@example.test", displayName: "Inactive", active: false },
      outsider: { id: "outsider", email: "outside@example.test", displayName: "Outside", active: true, telegramUserId: "99" },
    },
    memberships: {
      admin: { id: "ma", tenantId: "hotel-a", userId: "admin", role: "tenant_admin" },
      manager: { id: "mm", tenantId: "hotel-a", userId: "manager", role: "manager" },
      staff: { id: "ms", tenantId: "hotel-a", userId: "staff", role: "staff" },
      inactive: { id: "mi", tenantId: "hotel-a", userId: "inactive", role: "staff" },
      outsider: { id: "mo", tenantId: "hotel-b", userId: "outsider", role: "staff" },
    },
  });

  await withTelegramSecret("shared-secret", async () => {
    assert.equal(validateTelegramIntegrationSecret({ "x-hotelapp-secret": "shared-secret" }), true);
    assert.equal(validateTelegramIntegrationSecret({ "x-hotelapp-secret": "wrong" }), false);
  });

  const byTenant = await getHousekeepingStaff(database, { tenantId: "hotel-a" });
  const byChat = await getHousekeepingStaff(database, { chatId: "-1001" });
  assert.deepEqual(byChat, byTenant);
  assert.deepEqual(byTenant.members.map((member) => member.role), ["tenant_admin", "manager", "staff"]);
  assert.equal(byTenant.members.some((member) => member.userId === "outsider"), false);
  assert.equal(byTenant.members.some((member) => member.userId === "inactive"), false);
  assert.equal(JSON.stringify(byTenant).includes("passwordHash"), false);
  assert.equal(byTenant.members.find((member) => member.userId === "manager").telegramLinked, true);
  assert.equal(byTenant.members.find((member) => member.userId === "staff").telegramLinked, false);
  assert.equal(byTenant.members.find((member) => member.userId === "manager").telegramUsername, "boss");
  await assert.rejects(
    () => getHousekeepingStaff(database, { tenantId: "hotel-a", chatId: "-1002" }),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(() => getHousekeepingStaff(database, {}), /Tenant not found/);
});

test("staff pairing is one-use and linked staff can complete the housekeeping task sequence", async () => {
  const database = createFakeDatabase({
    tenants: { "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true } },
    tenantSettings: { "hotel-a": { tenantId: "hotel-a", notifications: { telegram: { enabled: true, chatId: "-1001" } } } },
    users: { staff: { id: "staff", email: "staff@example.test", displayName: "Staff", active: true } },
    memberships: { member: { id: "member", tenantId: "hotel-a", userId: "staff", role: "staff" } },
  });
  const session = { user: database.data.users.staff, memberships: [database.data.memberships.member], isPlatformAdmin: false };
  const pairing = await createStaffPairingCode(database, session, "hotel-a");
  const linked = await connectTelegramStaff(database, { code: pairing.code, telegramUserId: "9007199254740999", telegramUsername: "worker" });
  assert.equal(linked.role, "staff");
  await assert.rejects(() => connectTelegramStaff(database, { code: pairing.code, telegramUserId: "2" }), /Invalid or expired/);

  const room = await createRoom(database, "hotel-a", { number: "204", status: "occupied" });
  const checkout = await registerCheckout(database, "hotel-a", room.id, "manual");
  const actor = { tenantId: "hotel-a", chatId: "-1001", telegramUserId: "9007199254740999", eventId: checkout.event.id };
  await handleHousekeepingAction(database, { ...actor, action: "claim" });
  await handleHousekeepingAction(database, { ...actor, action: "bed_done" });
  await handleHousekeepingAction(database, { ...actor, action: "cleaning_done" });
  const completed = await handleHousekeepingAction(database, { ...actor, action: "complete" });
  assert.equal(database.data.rooms[room.id].status, "ready");
  assert.equal(completed.board.done[0].housekeeping.completedBy.userId, "staff");
  await assert.rejects(() => handleHousekeepingAction(database, { ...actor, action: "assign", assignmentTarget: "staff@example.test" }), /Manager access/);
});

test("legacy completion respects independent task checks", async () => {
  const database = createFakeDatabase({
    tenants: { "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true } },
    tenantSettings: { "hotel-a": { tenantId: "hotel-a", notifications: { telegram: { enabled: true, chatId: "-1001" } } } },
    users: { staff: { id: "staff", email: "staff@example.test", displayName: "Staff", active: true, telegramUserId: "1" } },
    memberships: { member: { id: "member", tenantId: "hotel-a", userId: "staff", role: "staff" } },
  });
  const room = await createRoom(database, "hotel-a", { number: "205", status: "occupied" });
  const checkout = await registerCheckout(database, "hotel-a", room.id, "manual");

  await assert.rejects(handleHousekeepingAction(database,{tenantId:"hotel-a",chatId:"-1001",telegramUserId:"1",eventId:checkout.event.id,action:"complete"}),{statusCode:409});
  for(const action of ["bed_done","cleaning_done"])await handleHousekeepingAction(database,{tenantId:"hotel-a",chatId:"-1001",telegramUserId:"1",eventId:checkout.event.id,action});
  await handleHousekeepingAction(database, {
    tenantId: "hotel-a", chatId: "-1001", telegramUserId: "1", eventId: checkout.event.id, action: "complete",
  });

  const housekeeping = database.data.checkoutEvents[checkout.event.id].metadata.housekeeping;
  assert.equal(housekeeping.bedDoneByUserId, "staff");
  assert.equal(housekeeping.cleaningDoneByUserId, "staff");
  assert.equal(housekeeping.completedByUserId, "staff");
  assert.ok(housekeeping.bedDoneAt);
  assert.ok(housekeeping.cleaningDoneAt);
  assert.equal(database.data.rooms[room.id].status, "ready");
});

test("complete preserves previously recorded housekeeping timestamps and authors", async () => {
  const database = createFakeDatabase({
    tenants: { "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true } },
    tenantSettings: { "hotel-a": { tenantId: "hotel-a", notifications: { telegram: { enabled: true, chatId: "-1001" } } } },
    users: {
      first: { id: "first", email: "first@example.test", displayName: "First", active: true, telegramUserId: "1" },
      finisher: { id: "finisher", email: "finisher@example.test", displayName: "Finisher", active: true, telegramUserId: "2" },
    },
    memberships: {
      first: { id: "first-member", tenantId: "hotel-a", userId: "first", role: "staff" },
      finisher: { id: "finisher-member", tenantId: "hotel-a", userId: "finisher", role: "staff" },
    },
  });
  const room = await createRoom(database, "hotel-a", { number: "206", status: "occupied" });
  const checkout = await registerCheckout(database, "hotel-a", room.id, "manual");
  const action = { tenantId: "hotel-a", chatId: "-1001", eventId: checkout.event.id };
  await handleHousekeepingAction(database, { ...action, telegramUserId: "1", action: "bed_done" });
  await handleHousekeepingAction(database, { ...action, telegramUserId: "1", action: "cleaning_done" });
  const prior = { ...database.data.checkoutEvents[checkout.event.id].metadata.housekeeping };

  await handleHousekeepingAction(database, { ...action, telegramUserId: "2", action: "complete" });

  const housekeeping = database.data.checkoutEvents[checkout.event.id].metadata.housekeeping;
  assert.equal(housekeeping.bedDoneByUserId, "first");
  assert.equal(housekeeping.bedDoneAt, prior.bedDoneAt);
  assert.equal(housekeeping.cleaningDoneByUserId, "first");
  assert.equal(housekeeping.cleaningDoneAt, prior.cleaningDoneAt);
  assert.equal(housekeeping.completedByUserId, "finisher");
  assert.ok(housekeeping.completedAt);
  assert.equal(database.data.rooms[room.id].status, "ready");
});

test("personal Telegram pairing supports every tenant role and stores only the authenticated user", async () => {
  const tenantId = "hotel-a";
  const users = Object.fromEntries(
    ["staff", "manager", "tenant_admin", "platform_admin", "outsider"].map((id) => [
      id,
      { id, email: `${id}@example.test`, displayName: id },
    ]),
  );
  const memberships = Object.fromEntries(
    ["staff", "manager", "tenant_admin"].map((role) => [
      role,
      { id: `membership-${role}`, tenantId, userId: role, role },
    ]),
  );
  const database = createFakeDatabase({
    tenants: { [tenantId]: { id: tenantId, name: "Hotel A", slug: "hotel-a", active: true } },
    users,
    memberships,
  });

  for (const role of ["staff", "manager", "tenant_admin"]) {
    const pairing = await createStaffPairingCode(database, {
      user: users[role],
      memberships: [memberships[role]],
      isPlatformAdmin: false,
    }, tenantId);
    assert.equal(database.data.diagnostics.telegramStaffPairingCodes.codes[pairing.code].userId, role);
  }

  const platformPairing = await createStaffPairingCode(database, {
    user: users.platform_admin,
    memberships: [],
    isPlatformAdmin: true,
  }, tenantId);
  assert.equal(
    database.data.diagnostics.telegramStaffPairingCodes.codes[platformPairing.code].userId,
    "platform_admin",
  );

  await assert.rejects(
    () => createStaffPairingCode(database, {
      user: users.outsider,
      memberships: [],
      isPlatformAdmin: false,
    }, tenantId),
    (error) => error.statusCode === 403,
  );
});

test("staff cannot register manual checkout while manager can resolve tenant by connected chat", async () => {
  const database = createFakeDatabase({
    tenants: { "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true } },
    tenantSettings: { "hotel-a": { tenantId: "hotel-a", notifications: { telegram: { enabled: true, chatId: "-1001" } } } },
    users: {
      staff: { id: "staff", email: "staff@example.test", displayName: "Staff", telegramUserId: "1" },
      manager: { id: "manager", email: "manager@example.test", displayName: "Manager", telegramUserId: "2" },
    },
    memberships: {
      staffMember: { id: "staffMember", tenantId: "hotel-a", userId: "staff", role: "staff" },
      managerMember: { id: "managerMember", tenantId: "hotel-a", userId: "manager", role: "manager" },
    },
  });
  await createRoom(database, "hotel-a", { number: "205", status: "occupied" });
  await assert.rejects(() => registerManualTelegramCheckout(database, { chatId: "-1001", roomNumber: "205", telegramUserId: "1" }), /Manager access/);
  const result = await registerManualTelegramCheckout(database, { chatId: "-1001", roomNumber: "205", telegramUserId: "2" });
  assert.equal(result.tenantId, "hotel-a");
  assert.equal(result.event.metadata.origin, "telegram");
});

test("Telegram pairing code is tenant-scoped and expires in about 10 minutes", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
    },
  });

  const pairing = await createTelegramPairingCode(database, "hotel-a");

  assert.match(pairing.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(pairing.tenant, { id: "hotel-a", name: "Hotel A", slug: "hotel-a" });
  assert.equal(database.data.diagnostics.telegramPairingCodes.codes[pairing.code].tenantId, "hotel-a");
  assert.ok(new Date(pairing.expiresAt).getTime() - Date.now() <= 10 * 60 * 1000);
});

test("Telegram connect stores tenant settings and invalidates the code", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
    },
  });
  const pairing = await createTelegramPairingCode(database, "hotel-a");

  const result = await connectTelegramChat(database, {
    code: pairing.code,
    chatId: "-100123456789",
    chatTitle: "Housekeeping Hotel A",
    chatType: "supergroup",
    telegramUserId: "42",
    telegramUsername: "admin",
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.tenant, { id: "hotel-a", name: "Hotel A", slug: "hotel-a" });
  assert.deepEqual(database.data.tenantSettings["hotel-a"].notifications.telegram, {
    enabled: true,
    chatId: "-100123456789",
    chatTitle: "Housekeeping Hotel A",
    chatType: "supergroup",
    connectedAt: database.data.tenantSettings["hotel-a"].notifications.telegram.connectedAt,
    telegramUserId: "42",
    telegramUsername: "admin",
    diagnostics: {
      lastAttemptAt: "",
      lastSuccessAt: "",
      lastError: "",
      httpStatus: undefined,
      checkoutEventId: "",
      room: "",
      source: "",
    },
  });
  assert.equal(database.data.diagnostics.telegramPairingCodes.codes[pairing.code], undefined);

  const reused = await connectTelegramChat(database, {
    code: pairing.code,
    chatId: "-100000000000",
  });
  assert.deepEqual(reused, { success: false, error: "Invalid or expired pairing code." });
});

test("expired Telegram pairing code cannot connect", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
    },
    diagnostics: {
      telegramPairingCodes: {
        codes: {
          ABC742: {
            code: "ABC742",
            tenantId: "hotel-a",
            createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
            expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        },
      },
    },
  });

  const result = await connectTelegramChat(database, {
    code: "ABC742",
    chatId: "-100123456789",
  });

  assert.deepEqual(result, { success: false, error: "Invalid or expired pairing code." });
  assert.equal(database.data.tenantSettings["hotel-a"], undefined);
});

test("Telegram integration secret validates n8n calls", async () => {
  await withTelegramSecret("shared-secret", async () => {
    assert.equal(
      validateTelegramIntegrationSecret({ "x-hotelapp-secret": "shared-secret" }),
      true,
    );
    assert.equal(validateTelegramIntegrationSecret({ "x-hotelapp-secret": "wrong" }), false);
  });
});

test("disconnect Telegram clears chat settings", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
    },
    tenantSettings: {
      "hotel-a": {
        tenantId: "hotel-a",
        notifications: {
          telegram: {
            enabled: true,
            chatId: "-100123456789",
            chatTitle: "Housekeeping Hotel A",
            chatType: "supergroup",
            connectedAt: new Date().toISOString(),
          },
        },
      },
    },
  });

  await disconnectTelegramChat(database, "hotel-a");

  assert.deepEqual(database.data.tenantSettings["hotel-a"].notifications.telegram, {
    enabled: false,
    chatId: "",
    chatTitle: "",
    chatType: "",
    connectedAt: "",
    telegramUserId: "",
    telegramUsername: "",
    diagnostics: {
      lastAttemptAt: "",
      lastSuccessAt: "",
      lastError: "",
      httpStatus: undefined,
      checkoutEventId: "",
      room: "",
      source: "",
    },
  });
});

test("Telegram housekeeping Ready uses private double confirmation and creates one next cycle", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  const originalUrl = process.env.N8N_CHECKOUT_WEBHOOK_URL;
  const originalSecret = process.env.N8N_CHECKOUT_WEBHOOK_SECRET;
  global.fetch = async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  };
  process.env.N8N_CHECKOUT_WEBHOOK_URL = "https://n8n.example.test/webhook/checkout";
  process.env.N8N_CHECKOUT_WEBHOOK_SECRET = "shared-secret";

  try {
    const database = createFakeDatabase({
      tenants: {
        "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
      },
      tenantSettings: {
        "hotel-a": {
          tenantId: "hotel-a",
          notifications: {
            telegram: {
              enabled: true,
              chatId: "-100123456789",
            },
          },
        },
      },
    });
    const room = await createRoom(database, "hotel-a", { number: "109", status: "occupied" });
    const checkout = await registerCheckout(database, "hotel-a", room.id, "manual", {
      sourceIdentifier: "manual:test",
    });
    const board = await getHousekeepingBoard(database, { tenantId: "hotel-a" });

    assert.equal(calls.length, 1);
    assert.equal(board.items.length, 1);
    assert.equal(board.items[0].eventId, checkout.event.id);

    const savedBoard = await saveHousekeepingBoardMessage(database, {
      tenantId: "hotel-a",
      chatId: "-100123456789",
      messageId: "77",
    });

    assert.equal(savedBoard.board.messageId, 77);

    const firstClick = await handleHousekeepingAction(database, {
      tenantId: "hotel-a",
      action: "ready",
      eventId: checkout.event.id,
      chatId: "-100123456789",
      telegramUserId: "42",
    });

    assert.equal(firstClick.confirmationRequired, true);
    assert.equal(database.data.rooms[room.id].status, "ready_for_cleaning");
    assert.equal(Object.values(database.data.occupancyCycles).length, 1);

    const secondClick = await handleHousekeepingAction(database, {
      tenantId: "hotel-a",
      action: "ready",
      eventId: checkout.event.id,
      chatId: "-100123456789",
      telegramUserId: "42",
    });

    assert.equal(secondClick.confirmed, true);
    assert.equal(secondClick.board.items.length, 0);
    assert.equal(database.data.rooms[room.id].status, "ready");
    assert.equal(Object.values(database.data.occupancyCycles).length, 2);
    assert.equal(
      Object.values(database.data.occupancyCycles).filter(
        (cycle) => cycle.roomId === room.id && !cycle.consumedAt,
      ).length,
      1,
    );
    assert.equal(calls.length, 1);
  } finally {
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
  }
});

test("Telegram housekeeping board persists Telegram numeric message_id for later fetches", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
    },
  });

  await saveHousekeepingBoardMessage(database, {
    tenantId: "hotel-a",
    chat: { id: -100123456789 },
    message_id: 12345,
    message_thread_id: 12,
  });

  const board = await getHousekeepingBoard(database, { tenantId: "hotel-a" });

  assert.equal(board.board.messageId, 12345);
  assert.equal(board.board.chatId, "-100123456789");
  assert.equal(board.board.threadId, 12);
});

test("Telegram checkout today follows the manual due date regardless of room status", async () => {
  const database = createFakeDatabase({
    tenants: {
      "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  const occupied = await createRoom(database, "hotel-a", {
    number: "101", status: "occupied", accessCode: "0421",
  });
  const ready = await createRoom(database, "hotel-a", { number: "102", status: "ready" });
  const unknown = await createRoom(database, "hotel-a", { number: "103", status: "unknown" });

  for (const room of [occupied, ready, unknown]) {
    database.data.rooms[room.id] = {
      ...database.data.rooms[room.id],
      checkoutDueDate: today,
      checkoutDueSource: "manual",
    };
  }

  const selectedBoard = await getHousekeepingBoard(database, { tenantId: "hotel-a" });

  assert.deepEqual(
    selectedBoard.checkoutToday.map((room) => room.roomId),
    [occupied.id, ready.id, unknown.id],
  );
  assert.deepEqual(
    selectedBoard.checkoutToday.map(({ room, accessCode }) => ({ room, accessCode })),
    [
      { room: "101", accessCode: "0421" },
      { room: "102", accessCode: null },
      { room: "103", accessCode: null },
    ],
  );

  const checkout = await registerCheckout(database, "hotel-a", ready.id, "manual", {
    sourceIdentifier: "manual:ready-room",
  });
  const checkedOutBoard = await getHousekeepingBoard(database, { tenantId: "hotel-a" });

  assert.deepEqual(
    checkedOutBoard.checkoutToday.map((room) => room.roomId),
    [occupied.id, unknown.id],
  );
  assert.equal(checkedOutBoard.pendingCleaning.length, 1);
  assert.equal(checkedOutBoard.pendingCleaning[0].roomId, ready.id);
  assert.equal(checkedOutBoard.pendingCleaning[0].eventId, checkout.event.id);
});

test("Telegram housekeeping board keeps numeric message id across checkout refreshes", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  const originalUrl = process.env.N8N_CHECKOUT_WEBHOOK_URL;
  const originalSecret = process.env.N8N_CHECKOUT_WEBHOOK_SECRET;
  global.fetch = async (...args) => {
    calls.push(args);
    return { ok: true, status: 200 };
  };
  process.env.N8N_CHECKOUT_WEBHOOK_URL = "https://n8n.example.test/webhook/checkout";
  process.env.N8N_CHECKOUT_WEBHOOK_SECRET = "shared-secret";

  try {
    const database = createFakeDatabase({
      tenants: {
        "hotel-a": { id: "hotel-a", name: "Hotel A", slug: "hotel-a", active: true },
      },
      tenantSettings: {
        "hotel-a": {
          tenantId: "hotel-a",
          notifications: {
            telegram: {
              enabled: true,
              chatId: "-100123456789",
            },
          },
        },
      },
    });
    const firstRoom = await createRoom(database, "hotel-a", {
      number: "109",
      status: "occupied",
    });
    const secondRoom = await createRoom(database, "hotel-a", {
      number: "110",
      status: "occupied",
    });

    const firstCheckout = await registerCheckout(database, "hotel-a", firstRoom.id, "manual", {
      sourceIdentifier: "manual:first",
    });
    assert.equal(calls.length, 1);

    const savedBoard = await saveHousekeepingBoardMessage(database, {
      tenantId: "hotel-a",
      chatId: -100123456789,
      messageId: 77,
      threadId: 12,
    });

    assert.equal(savedBoard.board.chatId, "-100123456789");
    assert.equal(savedBoard.board.messageId, 77);
    assert.equal(savedBoard.board.threadId, 12);
    assert.equal(
      database.data.diagnostics.telegramHousekeepingBoards["hotel-a"].messageId,
      77,
    );

    const nextBoard = await getHousekeepingBoard(database, { tenantId: "hotel-a" });

    assert.equal(nextBoard.board.messageId, 77);
    assert.deepEqual(Object.keys(nextBoard.items[0]).sort(), [
      "checkoutTimestamp",
      "eventId",
      "housekeeping",
      "roomId",
      "roomName",
      "roomNumber",
      "source",
      "status",
    ]);
    assert.equal(nextBoard.items[0].roomId, firstRoom.id);
    assert.equal(nextBoard.items[0].roomNumber, "109");
    assert.equal(nextBoard.items[0].status, "ready_for_cleaning");
    assert.equal(nextBoard.items[0].checkoutTimestamp, firstCheckout.event.timestamp);
    assert.deepEqual(
      nextBoard.items.map((item) => item.eventId),
      [firstCheckout.event.id],
    );

    const secondCheckout = await registerCheckout(database, "hotel-a", secondRoom.id, "manual", {
      sourceIdentifier: "manual:second",
    });
    assert.equal(calls.length, 2);

    const refreshedBoard = await getHousekeepingBoard(database, { tenantId: "hotel-a" });

    assert.equal(refreshedBoard.board.messageId, 77);
    assert.deepEqual(
      refreshedBoard.items.map((item) => item.eventId).sort(),
      [firstCheckout.event.id, secondCheckout.event.id].sort(),
    );
  } finally {
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
  }
});
