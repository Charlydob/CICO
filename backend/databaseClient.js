import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

const MODEL_BY_COLLECTION = {
  users: "user",
  sessions: "session",
  tenants: "tenant",
  memberships: "membership",
  webPushConfigs: "webPushConfig",
  pushSubscriptions: "pushSubscription",
  pushPreferences: "pushPreference",
  scheduledPushes: "scheduledPush",
  tenantSettings: "tenantSettings",
  rooms: "room",
  keyIdentifiers: "keyIdentifier",
  checkoutEvents: "checkoutEvent",
  occupancyCycles: "occupancyCycle",
  invitations: "invitation",
  userInvitations: "invitation",
  detections: "detection",
  checkIns: "checkIn",
  plateStates: "plateState",
  diagnostics: "diagnostic",
};

const TENANT_SCOPED = new Set([
  "rooms",
  "keyIdentifiers",
  "checkoutEvents",
  "occupancyCycles",
  "detections",
  "checkIns",
  "invitations",
  "userInvitations",
]);

const DATE_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "expiresAt",
  "usedAt",
  "revokedAt",
  "lastSeenAt",
  "detectedAt",
  "checkInAt",
  "timestamp",
  "firstSeenAt",
  "seenAgainAt",
  "releasedAt",
  "lastCheckoutAt",
  "openedAt",
  "consumedAt",
  "departureAt",
  "deletedAt",
  "checkoutDueDate",
  "lastCleanedAt",
  "telegramMessageDeletedAt",
  "lastSuccessAt",
  "lastFailureAt",
  "disabledAt",
  "sendAt",
  "sentAt",
]);

const JSON_FIELDS = new Set([
  "basicInfo",
  "reservations",
  "frigate",
  "cameras",
  "stripe",
  "telegram",
  "notifications",
  "checkout",
  "dashboard",
  "integrations",
  "metadata",
  "associationCandidates",
  "value",
]);

function modelName(collection) {
  const model = MODEL_BY_COLLECTION[collection];

  if (!model) {
    throw new Error(`Unknown database collection '${collection}'.`);
  }

  return model;
}

function removeUndefinedValues(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedValues);
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, fieldValue]) => fieldValue !== undefined)
        .map(([key, fieldValue]) => [key, removeUndefinedValues(fieldValue)]),
    );
  }

  return value;
}

function normalizeForWrite(value = {}) {
  const next = removeUndefinedValues(value);

  for (const key of DATE_FIELDS) {
    if (typeof next[key] === "string" && next[key]) {
      next[key] = new Date(next[key]);
    }
  }

  for (const key of JSON_FIELDS) {
    if (next[key] === undefined) {
      continue;
    }

    if (next[key] === null) {
      next[key] = key === "associationCandidates" ? null : {};
    }
  }

  return next;
}

function normalizeForRead(value) {
  if (!value) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForRead);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => [key, normalizeForRead(fieldValue)]),
    );
  }

  return value;
}

function normalizeId(collection, id, value = {}) {
  if (collection === "tenantSettings") {
    return { ...value, tenantId: id };
  }

  if (collection === "plateStates") {
    return { ...value, plate: id };
  }

  if (collection === "diagnostics") {
    return { key: id, value };
  }

  return { ...value, id };
}

function buildWhere(collection, id) {
  if (collection === "tenantSettings") {
    return { tenantId: id };
  }

  if (collection === "plateStates") {
    return { plate: id };
  }

  if (collection === "diagnostics") {
    return { key: id };
  }

  return { id };
}

function createData(collection, id, value) {
  if (collection === "tenantSettings") {
    return normalizeForWrite({ ...value, tenantId: id });
  }

  if (collection === "plateStates") {
    return normalizeForWrite({ ...value, plate: id });
  }

  if (collection === "diagnostics") {
    return normalizeForWrite({ key: id, value });
  }

  return normalizeForWrite({ ...value, id });
}

function updateData(collection, value) {
  if (collection === "diagnostics") {
    return normalizeForWrite({ value });
  }

  const next = normalizeForWrite(value);
  delete next.id;
  delete next.tenantId;
  delete next.plate;
  delete next.key;
  return next;
}

function createRecordData(collection, value) {
  const id = value.id || randomUUID();
  return createData(collection, id, { ...value, id });
}

function orderByFor(collection) {
  if (collection === "detections") {
    return { detectedAt: "desc" };
  }

  if (collection === "checkoutEvents") {
    return { timestamp: "desc" };
  }

  if (collection === "occupancyCycles") {
    return { openedAt: "desc" };
  }

  if (collection === "invitations" || collection === "userInvitations") {
    return { createdAt: "desc" };
  }

  return undefined;
}

function mergeMetadata(left, right) {
  return {
    ...(left && typeof left === "object" && !Array.isArray(left) ? left : {}),
    ...(right && typeof right === "object" && !Array.isArray(right) ? right : {}),
  };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lifecycleError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function lockOccupancyCycle(tx, tenantId, roomId) {
  await tx.$queryRaw`
    WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtext(${`occupancy:${tenantId}:${roomId}`}))
    )
    SELECT 1::int AS locked FROM lock
  `;
}

function occupancyPatch(input = {}) {
  const patch = {
    ...(input.reservationCode !== undefined
      ? { reservationCode: cleanString(input.reservationCode) || null }
      : {}),
    ...(input.guestName !== undefined ? { guestName: cleanString(input.guestName) || null } : {}),
    ...(input.guestEmail !== undefined ? { guestEmail: cleanString(input.guestEmail) || null } : {}),
    ...(input.departureAt !== undefined && input.departureAt
      ? { departureAt: new Date(input.departureAt) }
      : input.departureAt === null
        ? { departureAt: null }
        : {}),
  };

  return patch;
}

async function createCurrentOccupancyCycle(tx, { tenantId, roomId, reason, metadata = {}, ...patch }) {
  const latest = await tx.occupancyCycle.findFirst({
    where: { tenantId, roomId },
    orderBy: { cycleNumber: "desc" },
  });

  return tx.occupancyCycle.create({
    data: normalizeForWrite({
      tenantId,
      roomId,
      cycleNumber: (latest?.cycleNumber || 0) + 1,
      openedAt: new Date(),
      createdReason: cleanString(reason) || "ready",
      metadata,
      ...occupancyPatch(patch),
    }),
  });
}

export function createDatabaseClient() {
  return {
    prisma,

    async disconnect() {
      await prisma.$disconnect();
    },

    async setRecord(collection, id, value) {
      const model = modelName(collection);
      const data = createData(collection, id, value);
      const result = await prisma[model].upsert({
        where: buildWhere(collection, id),
        create: data,
        update: updateData(collection, value),
      });
      return normalizeForRead(result);
    },

    async createRecord(collection, value) {
      const model = modelName(collection);
      const result = await prisma[model].create({
        data: createRecordData(collection, value),
      });
      return normalizeForRead(result);
    },

    async getRecord(collection, id) {
      const model = modelName(collection);
      const result = await prisma[model].findUnique({
        where: buildWhere(collection, id),
      });
      return normalizeForRead(result);
    },

    async updateRecord(collection, id, patch) {
      const model = modelName(collection);
      const result = await prisma[model].update({
        where: buildWhere(collection, id),
        data: updateData(collection, patch),
      });
      return normalizeForRead(result);
    },

    async deleteRecord(collection, id) {
      const model = modelName(collection);
      await prisma[model].delete({ where: buildWhere(collection, id) });
    },

    async listRecords(collection) {
      const model = modelName(collection);
      const result = await prisma[model].findMany({
        ...(orderByFor(collection) ? { orderBy: orderByFor(collection) } : {}),
      });
      return normalizeForRead(result);
    },

    async listTenantRecords(collection, tenantId) {
      if (!TENANT_SCOPED.has(collection)) {
        return [];
      }

      const model = modelName(collection);
      const result = await prisma[model].findMany({
        where: { tenantId },
        ...(orderByFor(collection) ? { orderBy: orderByFor(collection) } : {}),
      });
      return normalizeForRead(result);
    },

    async getTenantRecord(collection, tenantId, id) {
      const record = await this.getRecord(collection, id);
      return record?.tenantId === tenantId ? record : undefined;
    },

    async getMembershipsForUser(userId) {
      return normalizeForRead(await prisma.membership.findMany({ where: { userId } }));
    },

    async getTenantModules(tenantId) {
      const modules = await prisma.tenantModule.findMany({ where: { tenantId } });
      return Object.fromEntries(modules.map((module) => [module.moduleId, Boolean(module.enabled)]));
    },

    async setTenantModule(tenantId, moduleId, enabled) {
      const result = await prisma.tenantModule.upsert({
        where: { tenantId_moduleId: { tenantId, moduleId } },
        create: { tenantId, moduleId, enabled: Boolean(enabled) },
        update: { enabled: Boolean(enabled) },
      });
      return normalizeForRead(result);
    },

    async ensureCurrentOccupancyCycle(input) {
      const result = await prisma.$transaction(async (tx) => {
        await lockOccupancyCycle(tx, input.tenantId, input.roomId);

        const current = await tx.occupancyCycle.findFirst({
          where: {
            tenantId: input.tenantId,
            roomId: input.roomId,
            consumedAt: null,
          },
        });

        if (current) {
          const patch = occupancyPatch(input);
          const metadata = mergeMetadata(current.metadata, input.metadata);
          const shouldUpdate =
            Object.keys(patch).length > 0 ||
            (input.metadata &&
              typeof input.metadata === "object" &&
              Object.keys(input.metadata).length > 0);

          if (!shouldUpdate) {
            return { cycle: current, created: false };
          }

          return {
            cycle: await tx.occupancyCycle.update({
              where: { id: current.id },
              data: normalizeForWrite({
                ...patch,
                metadata,
              }),
            }),
            created: false,
          };
        }

        return {
          cycle: await createCurrentOccupancyCycle(tx, input),
          created: true,
        };
      });

      return {
        cycle: normalizeForRead(result.cycle),
        created: result.created,
      };
    },

    async registerCheckoutForCurrentCycle(input, transaction) {
      const execute = async (tx) => {
        await lockOccupancyCycle(tx, input.tenantId, input.roomId);

        const room = await tx.room.findUnique({ where: { id: input.roomId } });
        if (!room || room.tenantId !== input.tenantId || room.active === false || room.deletedAt) {
          throw lifecycleError("Room not found.", 404, "ROOM_NOT_FOUND");
        }

        const current = await tx.occupancyCycle.findFirst({
          where: {
            tenantId: input.tenantId,
            roomId: input.roomId,
            consumedAt: null,
          },
        });

        if (
          !current &&
          input.suppressIfRoomPending &&
          ["ready_for_cleaning", "cleaning"].includes(room.status)
        ) {
          const duplicateEvent = await tx.checkoutEvent.findFirst({
            where: { tenantId: input.tenantId, roomId: input.roomId },
            orderBy: { timestamp: "desc" },
          });
          return { duplicate: true, event: duplicateEvent, room };
        }

        if (current && input.occupancyCycleId && current.id !== input.occupancyCycleId) {
          throw lifecycleError("This checkout page is no longer valid.", 409, "STALE_CHECKOUT_ATTEMPT");
        }

        if (!current && input.occupancyCycleId) {
          const attemptedCycle = await tx.occupancyCycle.findUnique({
            where: { id: input.occupancyCycleId },
          });
          const newerCycle = await tx.occupancyCycle.findFirst({
            where: {
              tenantId: input.tenantId,
              roomId: input.roomId,
              consumedAt: null,
            },
          });

          if (newerCycle) {
            throw lifecycleError("This checkout page is no longer valid.", 409, "STALE_CHECKOUT_ATTEMPT");
          }

          if (
            attemptedCycle?.tenantId === input.tenantId &&
            attemptedCycle.roomId === input.roomId &&
            attemptedCycle.consumedAt
          ) {
            const duplicateEvent = await tx.checkoutEvent.findUnique({
              where: { occupancyCycleId: attemptedCycle.id },
            });

            if (duplicateEvent) {
              return {
                duplicate: true,
                event: duplicateEvent,
                room,
              };
            }
          }

          throw lifecycleError("This checkout page is no longer valid.", 409, "STALE_CHECKOUT_ATTEMPT");
        }

        const cycle =
          current ||
          (await createCurrentOccupancyCycle(tx, {
            tenantId: input.tenantId,
            roomId: input.roomId,
            reason: "checkout_recovery",
            metadata: {
              recoveredBy: input.source,
            },
          }));

        const timestamp = new Date();

        try {
          const event = await tx.checkoutEvent.create({
            data: normalizeForWrite({
              id: input.id,
              tenantId: input.tenantId,
              roomId: input.roomId,
              occupancyCycleId: cycle.id,
              source: input.source,
              sourceIdentifier: input.sourceIdentifier,
              timestamp,
              status: "registered",
              metadata: input.metadata || {},
            }),
          });

          await tx.occupancyCycle.update({
            where: { id: cycle.id },
            data: { consumedAt: timestamp },
          });

          const updatedRoom = await tx.room.update({
            where: { id: input.roomId },
            data: {
              status: "ready_for_cleaning",
              lastCheckoutAt: timestamp,
              lastCheckoutSource: input.source,
              checkoutDueDate: null,
              checkoutDueSource: null,
              updatedAt: timestamp,
            },
          });

          return {
            duplicate: false,
            event,
            room: updatedRoom,
          };
        } catch (error) {
          if (error?.code !== "P2002") {
            throw error;
          }

          const duplicateEvent = await tx.checkoutEvent.findUnique({
            where: { occupancyCycleId: cycle.id },
          });

          if (!duplicateEvent) {
            throw error;
          }

          return {
            duplicate: true,
            event: duplicateEvent,
            room,
          };
        }
      };
      const result = transaction
        ? await execute(transaction)
        : await prisma.$transaction(execute);

      return normalizeForRead(result);
    },

    async createDetection(detection) {
      return this.createRecord("detections", detection);
    },

    async getDetections() {
      return this.listRecords("detections");
    },

    async getDetection(detectionId) {
      return this.getRecord("detections", detectionId);
    },

    async updateDetection(detectionId, patch) {
      return this.updateRecord("detections", detectionId, patch);
    },

    async deleteDetection(detectionId) {
      return this.deleteRecord("detections", detectionId);
    },

    async getPlateState(plate) {
      return this.getRecord("plateStates", plate);
    },

    async getPlateStates() {
      return this.listRecords("plateStates");
    },

    async updatePlateState(plate, patch) {
      return this.setRecord("plateStates", plate, { ...patch, plate });
    },

    async releasePlateAssignment(plate) {
      return this.updatePlateState(plate, {
        currentlyPresent: false,
        activeReservationCode: null,
        activeRoom: null,
        activeGuestName: null,
        associationStatus: null,
        associationMethod: null,
        confidence: null,
        releasedAt: new Date().toISOString(),
      });
    },

    async getPlateStateDiagnostics() {
      const plateStates = await this.getPlateStates();
      const activePlates = plateStates.filter((plateState) => plateState.activeReservationCode);
      const presentPlates = plateStates.filter((plateState) => plateState.currentlyPresent);

      return {
        activePlates: plateStates.length,
        presentPlates: presentPlates.length,
        assignedPlates: activePlates.length,
      };
    },

    async createCheckIn(checkIn) {
      return this.createRecord("checkIns", checkIn);
    },

    async getCheckIns() {
      return this.listRecords("checkIns");
    },

    async updateStripeDiagnostic(diagnostic) {
      const current = await this.getRecord("diagnostics", "stripe");
      return this.setRecord("diagnostics", "stripe", {
        ...(current?.value || {}),
        ...diagnostic,
      });
    },

    async testConnection() {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    },
  };
}
