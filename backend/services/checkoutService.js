import {
  getSavedHousekeepingBoard,
  sendCheckoutNotification,
  sendHousekeepingBoardRefresh,
} from "./notificationService.js";
import { getTenantSettings } from "./tenantSettingsService.js";
import { sendNewCheckoutPush } from "./webPushService.js";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const CHECKOUT_ATTEMPT_TOKEN_TTL_SECONDS = Number(
  process.env.CHECKOUT_ATTEMPT_TOKEN_TTL_SECONDS || 30 * 60,
);
const VALID_ROOM_STATUSES = new Set([
  "occupied",
  "checkout_received",
  "ready_for_cleaning",
  "cleaning",
  "ready",
  "unknown",
]);
const VALID_SOURCES = new Set(["qr", "nfc", "rfid", "manual", "pms", "other"]);
const VALID_KEY_TYPES = new Set(["qr", "nfc", "rfid"]);

function now() {
  return new Date().toISOString();
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function token() {
  return `ck_${randomUUID().replace(/-/g, "")}${randomBytes(8).toString("hex")}`;
}

function attemptTokenSecret() {
  return (
    cleanString(process.env.CHECKOUT_ATTEMPT_TOKEN_SECRET) ||
    cleanString(process.env.SESSION_SECRET) ||
    cleanString(process.env.N8N_CHECKOUT_WEBHOOK_SECRET) ||
    "dev-checkout-attempt-token-secret"
  );
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function signAttemptPayload(payload) {
  return createHmac("sha256", attemptTokenSecret()).update(payload).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function checkoutError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isRoomAvailable(room) {
  return Boolean(room) && room.active !== false && !room.deletedAt;
}

export function createCheckoutAttemptToken({
  tenantId,
  roomId,
  occupancyCycleId,
  expiresAt = Date.now() + CHECKOUT_ATTEMPT_TOKEN_TTL_SECONDS * 1000,
}) {
  const payload = base64UrlJson({
    tenantId,
    roomId,
    occupancyCycleId,
    exp: expiresAt,
  });

  return `${payload}.${signAttemptPayload(payload)}`;
}

export function verifyCheckoutAttemptToken(value) {
  const raw = cleanString(value);
  const [payload, signature, extra] = raw.split(".");

  if (!payload || !signature || extra) {
    throw checkoutError("Checkout confirmation is no longer valid.", 401, "CHECKOUT_ATTEMPT_INVALID");
  }

  if (!safeEqual(signature, signAttemptPayload(payload))) {
    throw checkoutError("Checkout confirmation is no longer valid.", 401, "CHECKOUT_ATTEMPT_INVALID");
  }

  let decoded;

  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw checkoutError("Checkout confirmation is no longer valid.", 401, "CHECKOUT_ATTEMPT_INVALID");
  }

  if (!decoded?.tenantId || !decoded?.roomId || !decoded?.occupancyCycleId || !decoded?.exp) {
    throw checkoutError("Checkout confirmation is no longer valid.", 401, "CHECKOUT_ATTEMPT_INVALID");
  }

  if (Number(decoded.exp) <= Date.now()) {
    throw checkoutError("Checkout confirmation has expired.", 401, "CHECKOUT_ATTEMPT_EXPIRED");
  }

  return {
    tenantId: String(decoded.tenantId),
    roomId: String(decoded.roomId),
    occupancyCycleId: String(decoded.occupancyCycleId),
  };
}

function splitRoomNumbers(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,\r\n]+/);
  const seen = new Set();
  const numbers = [];
  const duplicateInput = [];

  for (const item of values) {
    const number = cleanString(item);

    if (!number) {
      continue;
    }

    if (seen.has(number)) {
      duplicateInput.push(number);
      continue;
    }

    seen.add(number);
    numbers.push(number);
  }

  return { numbers, duplicateInput };
}

export function checkoutIdentifierFromValue(value) {
  const raw = cleanString(value);

  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw, "https://checkout.local");
    const directMatch = parsed.pathname.match(/^\/checkout\/([^/]+)$/);

    if (directMatch) {
      return decodeURIComponent(directMatch[1]);
    }
  } catch {
    return raw;
  }

  return raw;
}

export async function listCheckoutOverview(database, tenantId) {
  const [rooms, events] = await Promise.all([
    database.listTenantRecords("rooms", tenantId),
    database.listTenantRecords("checkoutEvents", tenantId),
  ]);

  return {
    rooms: rooms
      .filter(isRoomAvailable)
      .map((room) => ({ ...room, accessCode: room.accessCode ?? null }))
      .sort((left, right) => String(left.number).localeCompare(String(right.number))),
    events: events
      .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
      .slice(0, 50),
  };
}

export async function setTodayCheckoutRooms(database, tenantId, roomIds, date) {
  const selected = new Set(Array.isArray(roomIds) ? roomIds.map(String) : []);
  const rooms = (await database.listTenantRecords("rooms", tenantId)).filter(isRoomAvailable);
  const invalid = [...selected].filter((id) => !rooms.some((room) => room.id === id));
  if (invalid.length) {
    const error = new Error("One or more rooms were not found.");
    error.statusCode = 400;
    throw error;
  }

  await Promise.all(rooms.map((room) => {
    const currentlyToday = String(room.checkoutDueDate || "").slice(0, 10) === date;
    if (!selected.has(room.id) && !currentlyToday) return undefined;
    return database.setRecord("rooms", room.id, {
      ...room,
      checkoutDueDate: selected.has(room.id) ? date : null,
      checkoutDueSource: selected.has(room.id) ? "manual" : null,
      updatedAt: now(),
    });
  }));

  void Promise.all([
    database.getRecord("tenants", tenantId),
    getTenantSettings(database, tenantId),
  ])
    .then(([tenant, tenantSettings]) =>
      sendHousekeepingBoardRefresh({ tenant, tenantSettings }),
    )
    .catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[Notifications] housekeeping board refresh setup failed: ${message}`);
    });

  return {
    date,
    source: "manual",
    roomIds: rooms.filter((room) => selected.has(room.id)).map((room) => room.id),
  };
}

function publicCycle(cycle) {
  return cycle
    ? {
        id: cycle.id,
        tenantId: cycle.tenantId,
        roomId: cycle.roomId,
        cycleNumber: cycle.cycleNumber,
        openedAt: cycle.openedAt,
        consumedAt: cycle.consumedAt,
      }
    : undefined;
}

async function ensureCurrentOccupancyCycle(database, tenantId, roomId, input = {}) {
  if (database.ensureCurrentOccupancyCycle) {
    return database.ensureCurrentOccupancyCycle({
      tenantId,
      roomId,
      ...input,
    });
  }

  const existing = (await database.listTenantRecords("occupancyCycles", tenantId)).find(
    (cycle) => cycle.roomId === roomId && !cycle.consumedAt,
  );

  if (existing) {
    const metadata = {
      ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
      ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
    };
    const updated = {
      ...existing,
      reservationCode:
        input.reservationCode === undefined ? existing.reservationCode : cleanString(input.reservationCode),
      guestName: input.guestName === undefined ? existing.guestName : cleanString(input.guestName),
      guestEmail: input.guestEmail === undefined ? existing.guestEmail : cleanString(input.guestEmail),
      departureAt: input.departureAt === undefined ? existing.departureAt : input.departureAt,
      metadata,
    };
    await database.setRecord("occupancyCycles", existing.id, updated);
    return { cycle: updated, created: false };
  }

  const roomCycles = (await database.listTenantRecords("occupancyCycles", tenantId)).filter(
    (cycle) => cycle.roomId === roomId,
  );
  const cycle = {
    id: randomUUID(),
    tenantId,
    roomId,
    cycleNumber:
      roomCycles.reduce((highest, cycleItem) => Math.max(highest, Number(cycleItem.cycleNumber || 0)), 0) + 1,
    openedAt: now(),
    createdReason: cleanString(input.reason) || "ready",
    consumedAt: null,
    reservationCode: cleanString(input.reservationCode),
    guestName: cleanString(input.guestName),
    guestEmail: cleanString(input.guestEmail),
    departureAt: input.departureAt || null,
    metadata: input.metadata || {},
  };

  await database.setRecord("occupancyCycles", cycle.id, cycle);
  return { cycle, created: true };
}

async function findCurrentOccupancyCycle(database, tenantId, roomId) {
  const cycles = await database.listTenantRecords("occupancyCycles", tenantId);

  return cycles.find((cycle) => cycle.roomId === roomId && !cycle.consumedAt);
}

export async function createRoom(database, tenantId, input) {
  const timestamp = now();
  const number = cleanString(input.number);

  if (!number) {
    const error = new Error("Room number is required.");
    error.statusCode = 400;
    throw error;
  }

  const existing = (await database.listTenantRecords("rooms", tenantId)).find(
    (room) => room.number === number && !room.deletedAt,
  );

  if (existing) {
    const error = new Error("Room number already exists.");
    error.statusCode = 409;
    error.code = "ROOM_EXISTS";
    throw error;
  }

  const room = {
    id: randomUUID(),
    tenantId,
    number,
    name: cleanString(input.name),
    accessCode: cleanString(input.accessCode) || null,
    active: input.active !== false,
    status: VALID_ROOM_STATUSES.has(input.status) ? input.status : "unknown",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await database.setRecord("rooms", room.id, room);

  if (room.status === "ready" || room.status === "occupied") {
    await ensureCurrentOccupancyCycle(database, tenantId, room.id, {
      reason: room.status,
      metadata: { source: "room_create" },
    });
  }

  return room;
}

export async function createRoomsBulk(database, tenantId, input = {}) {
  const { numbers, duplicateInput } = splitRoomNumbers(input.numbers ?? input.roomNumbers);

  if (numbers.length === 0) {
    const error = new Error("At least one room number is required.");
    error.statusCode = 400;
    throw error;
  }

  const existingNumbers = new Map(
    (await database.listTenantRecords("rooms", tenantId))
      .filter((room) => !room.deletedAt)
      .map((room) => [room.number, room]),
  );
  const created = [];
  const skippedExisting = [];
  const keys = [];

  for (const number of numbers) {
    const existing = existingNumbers.get(number);

    if (existing) {
      skippedExisting.push({ id: existing.id, number: existing.number });
      continue;
    }

    const room = await createRoom(database, tenantId, {
      number,
      name: cleanString(input.name),
      status: input.status,
      active: input.active,
    });
    created.push(room);
    existingNumbers.set(room.number, room);

    if (input.createQr !== false) {
      keys.push(
        await createKeyIdentifier(database, tenantId, {
          roomId: room.id,
          label: cleanString(input.keyLabel) || `Room ${room.number}`,
          type: "qr",
        }),
      );
    }
  }

  return {
    created,
    skippedExisting,
    duplicateInput,
    keys,
    summary: {
      created: created.length,
      skippedExisting: skippedExisting.length,
      duplicateInput: duplicateInput.length,
      keysCreated: keys.length,
    },
  };
}

export async function updateRoom(database, tenantId, roomId, patch) {
  const current = await database.getTenantRecord("rooms", tenantId, roomId);

  if (!current || current.deletedAt) {
    const error = new Error("Room not found.");
    error.statusCode = 404;
    throw error;
  }

  const room = {
    ...current,
    number: cleanString(patch.number) || current.number,
    name: patch.name === undefined ? current.name : cleanString(patch.name),
    accessCode:
      patch.accessCode === undefined ? current.accessCode ?? null : cleanString(patch.accessCode) || null,
    active: patch.active === undefined ? current.active !== false : Boolean(patch.active),
    status: VALID_ROOM_STATUSES.has(patch.status) ? patch.status : current.status,
    lastCleanedAt:
      patch.status === "ready" && ["ready_for_cleaning", "cleaning"].includes(current.status)
        ? now()
        : current.lastCleanedAt,
    updatedAt: now(),
  };

  await database.setRecord("rooms", roomId, room);

  if (room.status === "ready") {
    await ensureCurrentOccupancyCycle(database, tenantId, roomId, {
      reason: "ready",
      metadata: { source: "room_status" },
    });
  } else if (room.status === "occupied") {
    await ensureCurrentOccupancyCycle(database, tenantId, roomId, {
      reason: "occupied",
      metadata: { source: "room_status" },
    });
  }

  return room;
}

export async function listKeyIdentifiers(database, tenantId) {
  return database.listTenantRecords("keyIdentifiers", tenantId);
}

export async function createKeyIdentifier(database, tenantId, input) {
  const room = await database.getTenantRecord("rooms", tenantId, cleanString(input.roomId));

  if (!isRoomAvailable(room)) {
    const error = new Error("Room not found.");
    error.statusCode = 404;
    throw error;
  }

  const timestamp = now();
  const key = {
    id: randomUUID(),
    tenantId,
    roomId: room.id,
    type: VALID_KEY_TYPES.has(input.type) ? input.type : "qr",
    identifier: cleanString(input.identifier) || token(),
    label: cleanString(input.label) || `Room ${room.number}`,
    active: input.active !== false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await database.setRecord("keyIdentifiers", key.id, key);
  return key;
}

export async function createKeyIdentifiersBulk(database, tenantId, input = {}) {
  const rooms = (await database.listTenantRecords("rooms", tenantId))
    .filter(isRoomAvailable)
    .sort((left, right) => String(left.number).localeCompare(String(right.number)));
  const keys = await database.listTenantRecords("keyIdentifiers", tenantId);
  const activeQrKeysByRoom = new Map();

  for (const key of keys) {
    if (key.type === "qr" && key.active !== false) {
      const roomKeys = activeQrKeysByRoom.get(key.roomId) || [];
      roomKeys.push(key);
      activeQrKeysByRoom.set(key.roomId, roomKeys);
    }
  }

  const label = cleanString(input.label);
  const regenerateExisting = Boolean(input.regenerateExisting);
  const created = [];
  const regenerated = [];
  const skippedExisting = [];

  for (const room of rooms) {
    const existingKeys = activeQrKeysByRoom.get(room.id) || [];

    if (existingKeys.length > 0) {
      if (!regenerateExisting) {
        skippedExisting.push({
          id: existingKeys[0].id,
          roomId: room.id,
          roomNumber: room.number,
          label: existingKeys[0].label || "",
        });
        continue;
      }

      const [primaryKey, ...extraKeys] = existingKeys;
      const updatedKey = await updateKeyIdentifier(database, tenantId, primaryKey.id, {
        regenerate: true,
        label: label || primaryKey.label,
        active: true,
      });
      regenerated.push(updatedKey);

      for (const extraKey of extraKeys) {
        await updateKeyIdentifier(database, tenantId, extraKey.id, { active: false });
      }

      continue;
    }

    created.push(
      await createKeyIdentifier(database, tenantId, {
        roomId: room.id,
        label: label || `Room ${room.number}`,
        type: "qr",
      }),
    );
  }

  return {
    created,
    regenerated,
    skippedExisting,
    summary: {
      created: created.length,
      regenerated: regenerated.length,
      skippedExisting: skippedExisting.length,
      rooms: rooms.length,
    },
  };
}

export async function updateKeyIdentifier(database, tenantId, keyId, patch) {
  const current = await database.getTenantRecord("keyIdentifiers", tenantId, keyId);

  if (!current) {
    const error = new Error("Key identifier not found.");
    error.statusCode = 404;
    throw error;
  }

  const key = {
    ...current,
    roomId: cleanString(patch.roomId) || current.roomId,
    type: VALID_KEY_TYPES.has(patch.type) ? patch.type : current.type,
    label: patch.label === undefined ? current.label : cleanString(patch.label),
    active: patch.active === undefined ? current.active !== false : Boolean(patch.active),
    identifier: patch.regenerate ? token() : current.identifier,
    updatedAt: now(),
  };

  if (!isRoomAvailable(await database.getTenantRecord("rooms", tenantId, key.roomId))) {
    const error = new Error("Room not found.");
    error.statusCode = 404;
    throw error;
  }

  await database.setRecord("keyIdentifiers", keyId, key);
  return key;
}

export async function deleteKeyIdentifier(database, tenantId, keyId) {
  const current = await database.getTenantRecord("keyIdentifiers", tenantId, keyId);

  if (!current) {
    const error = new Error("Key identifier not found.");
    error.statusCode = 404;
    throw error;
  }

  if (database.deleteRecord) {
    await database.deleteRecord("keyIdentifiers", keyId);
  } else {
    await database.setRecord("keyIdentifiers", keyId, {
      ...current,
      active: false,
      deletedAt: now(),
      updatedAt: now(),
    });
  }

  return { success: true, deletedId: keyId };
}

export async function archiveRoom(database, tenantId, roomId) {
  const current = await database.getTenantRecord("rooms", tenantId, roomId);

  if (!current || current.deletedAt) {
    const error = new Error("Room not found.");
    error.statusCode = 404;
    throw error;
  }

  const timestamp = now();
  const archivedRoom = {
    ...current,
    active: false,
    status: "unknown",
    deletedAt: timestamp,
    updatedAt: timestamp,
  };
  const keys = (await database.listTenantRecords("keyIdentifiers", tenantId)).filter(
    (key) => key.roomId === roomId && key.active !== false,
  );

  await database.setRecord("rooms", roomId, archivedRoom);
  await Promise.all(
    keys.map((key) =>
      database.setRecord("keyIdentifiers", key.id, {
        ...key,
        active: false,
        updatedAt: timestamp,
      }),
    ),
  );

  return { success: true, room: archivedRoom, deactivatedKeys: keys.length };
}

export async function registerCheckout(database, tenantId, roomId, source, options = {}) {
  if (!VALID_SOURCES.has(source)) {
    const error = new Error("Invalid checkout source.");
    error.statusCode = 400;
    throw error;
  }

  const sourceIdentifier = cleanString(options.sourceIdentifier);
  const room = options.transaction
    ? await options.transaction.room.findUnique({ where: { id: roomId } })
    : await database.getTenantRecord("rooms", tenantId, roomId);

  if (!isRoomAvailable(room) || room.tenantId !== tenantId) {
    const error = new Error("Room not found.");
    error.statusCode = 404;
    throw error;
  }

  let result;

  if (database.registerCheckoutForCurrentCycle) {
    result = await database.registerCheckoutForCurrentCycle(
      {
        id: randomUUID(),
        tenantId,
        roomId,
        occupancyCycleId: options.occupancyCycleId,
        suppressIfRoomPending: options.suppressIfRoomPending,
        source,
        sourceIdentifier,
        metadata: options.metadata || {},
      },
      options.transaction,
    );
  } else {
    const currentCycle = await findCurrentOccupancyCycle(database, tenantId, roomId);

    if (
      !currentCycle &&
      options.suppressIfRoomPending &&
      ["ready_for_cleaning", "cleaning"].includes(room.status)
    ) {
      const duplicateEvent = (await database.listTenantRecords("checkoutEvents", tenantId))
        .filter((event) => event.roomId === roomId)
        .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())[0];
      return { duplicate: true, event: duplicateEvent, room };
    }

    if (currentCycle && options.occupancyCycleId && currentCycle.id !== options.occupancyCycleId) {
      throw checkoutError("This checkout page is no longer valid.", 409, "STALE_CHECKOUT_ATTEMPT");
    }

    if (!currentCycle && options.occupancyCycleId) {
      const attemptedCycle = await database.getTenantRecord(
        "occupancyCycles",
        tenantId,
        options.occupancyCycleId,
      );
      const duplicateEvent = (await database.listTenantRecords("checkoutEvents", tenantId)).find(
        (event) => event.occupancyCycleId === options.occupancyCycleId,
      );

      if (attemptedCycle?.consumedAt && duplicateEvent) {
        return {
          duplicate: true,
          event: duplicateEvent,
          room,
        };
      }

      throw checkoutError("This checkout page is no longer valid.", 409, "STALE_CHECKOUT_ATTEMPT");
    }

    const cycle =
      currentCycle ||
      (
        await ensureCurrentOccupancyCycle(database, tenantId, roomId, {
          reason: "checkout_recovery",
          metadata: { recoveredBy: source },
        })
      ).cycle;
    const duplicateEvent = (await database.listTenantRecords("checkoutEvents", tenantId)).find(
      (event) => event.occupancyCycleId === cycle.id,
    );

    if (duplicateEvent) {
      return {
        duplicate: true,
        event: duplicateEvent,
        room,
      };
    }

    const timestamp = now();
    const event = {
      id: randomUUID(),
      tenantId,
      roomId,
      occupancyCycleId: cycle.id,
      source,
      sourceIdentifier,
      timestamp,
      status: "registered",
      metadata: options.metadata || {},
    };
    const updatedRoom = {
      ...room,
      status: "ready_for_cleaning",
      lastCheckoutAt: timestamp,
      lastCheckoutSource: source,
      checkoutDueDate: null,
      checkoutDueSource: null,
      updatedAt: timestamp,
    };

    await database.setRecord("checkoutEvents", event.id, event);
    await database.setRecord("occupancyCycles", cycle.id, {
      ...cycle,
      consumedAt: timestamp,
    });
    await database.setRecord("rooms", roomId, updatedRoom);

    result = {
      duplicate: false,
      event,
      room: updatedRoom,
    };
  }

  if (result.duplicate) {
    return result;
  }

  if (!options.deferNotifications) {
    await dispatchCheckoutNotifications(database, result).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[Notifications] checkout notification setup failed: ${message}`);
    });
  }

  return {
    duplicate: false,
    event: result.event,
    room: result.room,
  };
}

export async function dispatchCheckoutNotifications(database, result) {
  const tenantId = result.event.tenantId;
  const [tenant, tenantSettings, housekeepingBoard] = await Promise.all([
    database.getRecord("tenants", tenantId),
    getTenantSettings(database, tenantId),
    getSavedHousekeepingBoard(database, tenantId),
  ]);
  void Promise.allSettled([
    sendCheckoutNotification({
      database,
      tenant,
      tenantSettings,
      room: result.room,
      event: result.event,
      housekeepingBoard,
    }),
    sendNewCheckoutPush(database, {
      tenant,
      room: result.room,
      event: result.event,
    }),
  ]).then((results) => {
    const webPushFailure = results[1];
    if (webPushFailure?.status === "rejected") {
      const error = webPushFailure.reason;
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[WebPush] checkout push failed: ${message}`);
    }
  });

  return {
    duplicate: false,
    event: result.event,
    room: result.room,
  };
}

async function findKeyByIdentifier(database, identifier, type = "qr") {
  const cleanIdentifier = checkoutIdentifierFromValue(identifier);
  const matches = (await database.listRecords("keyIdentifiers")).filter(
    (key) => key.identifier === cleanIdentifier && key.type === type,
  );
  const key = matches[0];

  if (!key) {
    const error = new Error("Checkout QR is invalid.");
    error.statusCode = 404;
    error.code = "QR_INVALID";
    throw error;
  }

  if (key.active === false) {
    const error = new Error("Checkout QR is deactivated.");
    error.statusCode = 410;
    error.code = "QR_DEACTIVATED";
    throw error;
  }

  return key;
}

export async function resolveCheckoutByIdentifier(database, identifier, type = "qr") {
  const key = await findKeyByIdentifier(database, identifier, type);
  const [room, tenant, modules] = await Promise.all([
    database.getTenantRecord("rooms", key.tenantId, key.roomId),
    database.getRecord("tenants", key.tenantId),
    database.getTenantModules(key.tenantId),
  ]);

  if (!tenant || tenant.active === false || !modules.checkout) {
    const error = new Error("Hotel checkout is not available.");
    error.statusCode = 404;
    error.code = "CHECKOUT_UNAVAILABLE";
    throw error;
  }

  if (!isRoomAvailable(room)) {
    const error = new Error("Room is not available for checkout.");
    error.statusCode = 404;
    error.code = "ROOM_UNAVAILABLE";
    throw error;
  }

  let currentCycle;

  if (room.status === "ready_for_cleaning" || room.status === "cleaning") {
    currentCycle = await findCurrentOccupancyCycle(database, key.tenantId, key.roomId);

    if (!currentCycle) {
      throw checkoutError(
        "Checkout has already been received for this stay.",
        409,
        "CHECKOUT_ALREADY_RECEIVED",
      );
    }
  } else {
    currentCycle = (
      await ensureCurrentOccupancyCycle(database, key.tenantId, key.roomId, {
        reason: room.status === "ready" ? "ready" : "checkout_resolve",
        metadata: {
          source: "public_checkout_resolve",
          keyId: key.id,
        },
      })
    ).cycle;
  }

  return {
    key: {
      id: key.id,
      type: key.type,
      label: key.label || "",
    },
    room: {
      id: room.id,
      number: room.number,
      name: room.name || "",
      status: room.status,
    },
    tenant: {
      name: tenant.name,
      slug: tenant.slug,
    },
    attemptToken: createCheckoutAttemptToken({
      tenantId: key.tenantId,
      roomId: key.roomId,
      occupancyCycleId: currentCycle.id,
    }),
    occupancyCycle: publicCycle(currentCycle),
  };
}

export async function registerCheckoutByIdentifier(database, identifier, type = "qr", options = {}) {
  const key = await findKeyByIdentifier(database, identifier, type);
  const attempt = verifyCheckoutAttemptToken(options.attemptToken);

  if (attempt.tenantId !== key.tenantId || attempt.roomId !== key.roomId) {
    throw checkoutError("This checkout page is no longer valid.", 409, "STALE_CHECKOUT_ATTEMPT");
  }

  return registerCheckout(database, key.tenantId, key.roomId, type, {
    sourceIdentifier: key.identifier,
    occupancyCycleId: attempt.occupancyCycleId,
    metadata: { keyId: key.id },
  });
}

export async function ensureRoomReadyCycle(database, tenantId, roomId, options = {}) {
  return ensureCurrentOccupancyCycle(database, tenantId, roomId, {
    reason: "ready",
    metadata: options.metadata || {},
  });
}

export async function ensureRoomOccupiedCycle(database, tenantId, roomId, options = {}) {
  return ensureCurrentOccupancyCycle(database, tenantId, roomId, {
    reason: "occupied",
    reservationCode: options.reservationCode,
    guestName: options.guestName,
    guestEmail: options.guestEmail,
    departureAt: options.departureAt,
    metadata: options.metadata || {},
  });
}
