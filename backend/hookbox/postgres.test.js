import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createHookboxService } from "./service.js";
import { createPinService } from "./pins.js";
import {
  defaultOutbound,
  saveDeviceIntegration,
  getDeviceIntegration,
  createOutboundWorker,
  retryOutbound,
} from "./integration.js";
const url = process.env.HOOKBOX_TEST_DATABASE_URL;
test(
  "PostgreSQL PIN flow, concurrent claims, isolation, lockout, power loss, outbox restart/retry and rearm",
  { skip: !url },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } }),
      tenant = randomUUID(),
      other = randomUUID(),
      id = randomUUID(),
      id2 = randomUUID(),
      foreign = randomUUID();
    const device = { id, tenantId: tenant, deviceId: id, tokenHash: "fixture" },
      pins = createPinService(db),
      s = createHookboxService(db, () => {
        throw Error("Provider must never run");
      });
    try {
      await db.tenant.createMany({
        data: [
          { id: tenant, name: "PIN A", slug: tenant },
          { id: other, name: "PIN B", slug: other },
        ],
      });
      await db.device.createMany({
        data: [
          { id, tenantId: tenant },
          { id: id2, tenantId: tenant },
          { id: foreign, tenantId: other },
        ].map((d) => ({
          ...d,
          deviceId: d.id,
          name: d.id,
          hardwareModel: "CROWPANEL_7_V3",
          tokenHash: "fixture",
        })),
      });
      await pins.save(
        tenant,
        id,
        { hook: 1, room: "105", pin: "5932", enabled: true },
        "test",
      );
      assert.equal((await pins.list(tenant, id)).hooks[0].hasPin, true);
      assert.equal(
        JSON.stringify(await pins.list(tenant, id)).includes("5932"),
        false,
      );
      assert.match(
        (await db.devicePinHook.findFirst({ where: { deviceId: id } })).pinHash,
        /^\$argon2id\$/,
      );
      await assert.rejects(
        pins.save(tenant, id, { hook: 2, room: "106", pin: "5932" }),
        /PIN ya utilizado/,
      );
      await assert.rejects(
        pins.save(tenant, id, { hook: 2, room: "105", pin: "875621" }),
        /Habitación ya/,
      );
      await assert.rejects(pins.list(other, id), (e) => e.statusCode === 404);
      for (const d of [
        { id: id2, tenantId: tenant, tokenHash: "fixture" },
        { id: foreign, tenantId: other, tokenHash: "fixture" },
      ])
        assert.equal(
          (await pins.validate(d, { operationId: randomUUID(), pin: "5932" }))
            .status,
          "DENIED",
        );
      for (let i = 0; i < 5; i++)
        assert.equal(
          (
            await pins.validate(device, {
              operationId: randomUUID(),
              pin: "0000",
            })
          ).status,
          "DENIED",
        );
      assert.equal(
        (
          await createPinService(db).validate(device, {
            operationId: randomUUID(),
            pin: "5932",
          })
        ).status,
        "LOCKED",
      );
      await db.devicePinGuard.update({
        where: { deviceId: id },
        data: { lockedUntil: new Date(0), failures: 0 },
      });
      const c = {
        ...defaultOutbound(),
        endpoint: "https://hotel.example/checkin",
        enabled: true,
        contractConfirmed: true,
      };
      await saveDeviceIntegration({ prisma: db }, tenant, id, {
        outbound: c,
        headers: [{ name: "Authorization", value: "Bearer backend-secret" }],
      });
      assert.equal(
        JSON.stringify(
          await getDeviceIntegration({ prisma: db }, tenant, id),
        ).includes("backend-secret"),
        false,
      );
      const attempts = await Promise.all([
        pins.validate(device, { operationId: randomUUID(), pin: "5932" }),
        pins.validate(device, { operationId: randomUUID(), pin: "5932" }),
      ]);
      assert.equal(attempts.filter((x) => x.status === "AUTHORIZED").length, 1);
      const op = attempts.find((x) => x.status === "AUTHORIZED"),
        operationId = op.operationId;
      assert.deepEqual(op.rooms, [{ room: "105", hook: 1 }]);
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        0,
      );
      await s.start(device, { operationId });
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        0,
      );
      const result = {
        operationId,
        index: 0,
        result: "ELECTRICAL_ACTIVATION",
        physicallyConfirmed: false,
        mock: false,
      };
      await s.result(device, result);
      await s.result(device, result);
      await s.finish(device, { operationId });
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        1,
      );
      const eventId = "checkin:" + operationId;
      assert.equal(
        (await db.devicePinHook.findFirst({ where: { deviceId: id } })).state,
        "DELIVERED",
      );
      assert.equal(
        (
          await pins.validate(device, {
            operationId: randomUUID(),
            pin: "5932",
          })
        ).status,
        "DENIED",
      );
      let sends = 0;
      const send = async (config, payload, secrets, event) => {
        sends++;
        assert.equal(event, eventId);
        assert.equal(payload.key, "105");
        assert.equal(secrets.authorization, "Bearer backend-secret");
        return sends === 1 ? 503 : 200;
      };
      await createOutboundWorker(db, send)();
      let e = await db.deviceOutboundEvent.findUnique({
        where: { id: eventId },
      });
      assert.equal(e.state, "RETRY");
      assert.equal(e.httpAcceptedAt, null);
      await db.deviceOutboundEvent.update({
        where: { id: eventId },
        data: { nextAttemptAt: new Date(0) },
      });
      await createOutboundWorker(db, send)();
      e = await db.deviceOutboundEvent.findUnique({ where: { id: eventId } });
      assert.equal(e.state, "HTTP_ACCEPTED");
      assert.ok(e.httpAcceptedAt);
      assert.equal(e.processedAt, null);
      assert.equal(e.attempts, 2);
      await createOutboundWorker(db, send)();
      assert.equal(sends, 2);
      assert.equal(JSON.stringify(await retryOutbound({ prisma: db }, tenant, id, eventId)).includes("backend-secret"),false);
      await createOutboundWorker(db, send)();
      assert.equal(sends, 3);
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        1,
      );
      await pins.rearm(
        tenant,
        id,
        { hook: 1, reason: "Llave repuesta" },
        "admin",
      );
      const power = await pins.validate(device, {
        operationId: randomUUID(),
        pin: "5932",
      });
      await s.start(device, { operationId: power.operationId });
      assert.equal(
        (
          await createPinService(db).validate(device, {
            operationId: randomUUID(),
            pin: "5932",
          })
        ).status,
        "DENIED",
      );
      await assert.rejects(
        pins.rearm(tenant, id, { hook: 1, reason: "Intervención" }, "admin"),
        /Espera/,
      );
      await s.result(device, {
        operationId: power.operationId,
        index: 0,
        result: "UNCERTAIN",
        physicallyConfirmed: false,
        mock: false,
      });
      await pins.rearm(
        tenant,
        id,
        { hook: 1, reason: "Intervención verificada" },
        "admin",
      );
      await assert.rejects(
        s.result(device, {
          operationId: power.operationId,
          index: 0,
          result: "ELECTRICAL_ACTIVATION",
          physicallyConfirmed: false,
          mock: false,
        }),
        /Conflicting/,
      );
      // All four driver boards are reachable through the preserved mapping, without hardware.
      for (const hook of [9, 17, 25]) {
        await pins.save(tenant, id, {
          hook,
          room: String(100 + hook),
          pin: String(8000 + hook),
        });
        const p = await pins.validate(device, {
          operationId: randomUUID(),
          pin: String(8000 + hook),
          mock: true,
        });
        assert.equal(p.rooms[0].hook, hook);
        await s.start(device, { operationId: p.operationId });
        await s.result(device, {
          operationId: p.operationId,
          index: 0,
          result: "MOCK_ACTIVATION",
          physicallyConfirmed: false,
          mock: true,
        });
        await s.finish(device, { operationId: p.operationId });
      }
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        1,
      );
      await assert.rejects(s.lookup(device, {}), (e) => e.statusCode === 410);
      await assert.rejects(s.verify(device, {}), (e) => e.statusCode === 410);
    } finally {
      await db.deviceOutboundEvent.deleteMany({
        where: { tenantId: { in: [tenant, other] } },
      });
      await db.hookboxClaim.deleteMany({
        where: { tenantId: { in: [tenant, other] } },
      });
      await db.hookboxOperation.deleteMany({
        where: { tenantId: { in: [tenant, other] } },
      });
      await db.device.deleteMany({ where: { id: { in: [id, id2, foreign] } } });
      await db.tenant.deleteMany({ where: { id: { in: [tenant, other] } } });
      await db.$disconnect();
    }
  },
);
