import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createOtaService } from "../services/otaService.js";
import { createRoom } from "../services/checkoutService.js";
import { getDeviceIntegration } from "./integration.js";
const url = process.env.CHECKOUT_POSTGRES_TEST_DATABASE_URL;
test(
  "Checkout RFID preserves housekeeping and notifications; only correlated accepted return creates outbox",
  { skip: !url },
  async () => {
    process.env.DATABASE_URL = url;
    const { createDatabaseClient } = await import("../databaseClient.js");
    const database = createDatabaseClient(),
      db = database.prisma,
      tenant = randomUUID(),
      id = randomUUID();
    let notifications = 0;
    const s = createOtaService(
      db,
      {},
      {
        database,
        checkoutNotifier: async () => {
          notifications++;
        },
      },
    );
    try {
      await db.tenant.create({
        data: { id: tenant, name: "Return fixture", slug: tenant },
      });
      await database.setTenantModule(tenant, "checkout", true);
      const room = await createRoom(database, tenant, {
        number: "105",
        status: "occupied",
      });
      const device = await db.device.create({
        data: {
          id,
          deviceId: id,
          tenantId: tenant,
          name: "Return fixture",
          hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1",
          tokenHash: "fixture",
        },
      });
      await s.upsertRfidKey(id, {
        uid: "AABBCCDD",
        room: "105",
        authorized: true,
        active: true,
      });
      const batch = (type, detail, uptime_ms = 100) =>
        s.ingestEvents(device, { events: [{ type, detail, uptime_ms }] });
      await batch("RFID_READ", "AABBCCDD accepted", 100);
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        0,
      );
      assert.equal(
        await db.checkoutEvent.count({ where: { tenantId: tenant } }),
        1,
      );
      assert.equal(
        (await db.room.findUnique({ where: { id: room.id } })).status,
        "ready_for_cleaning",
      );
      assert.equal(notifications, 1);
      const operationId = randomUUID();
      await batch(
        "RETURN_ACCEPTED",
        JSON.stringify({ uid: "AABBCCDD", operationId, rfidUptimeMs: 999 }),
        150,
      );
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        0,
      );
      await batch(
        "RETURN_ACCEPTED",
        JSON.stringify({ uid: "AABBCCDD", operationId, rfidUptimeMs: 100 }),
        150,
      );
      await batch(
        "RETURN_ACCEPTED",
        JSON.stringify({ uid: "AABBCCDD", operationId, rfidUptimeMs: 100 }),
        150,
      );
      const events = await db.deviceOutboundEvent.findMany({
        where: { deviceId: id },
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "checkout");
      assert.equal(events[0].payload.key, "105");
      assert.ok(events[0].payload["check-out at"]);
      assert.equal(events[0].state, "HELD");
      assert.equal(notifications, 1);
      const config = await getDeviceIntegration(database, tenant, id);
      assert.equal(config.outbound.enabled, false);
      assert.equal(config.outbound.fields[1].key, "check-out at");

      // New firmware can deliver a persisted acceptance after reboot even if its RAM RFID log was lost.
      const room2 = await createRoom(database, tenant, {
        number: "106",
        status: "occupied",
      });
      await s.upsertRfidKey(id, {
        uid: "11223344",
        room: "106",
        authorized: true,
        active: true,
      });
      const durable = {
        uid: "11223344",
        operationId: randomUUID(),
        rfidUptimeMs: 200,
        durable: true,
      occurredAt:new Date(Date.now()-60000).toISOString(),
      };
      await batch("RETURN_ACCEPTED", JSON.stringify(durable), 300);
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        2,
      );
      assert.equal((await db.deviceOutboundEvent.findFirst({where:{deviceId:id,payload:{path:['key'],equals:'106'}}})).occurredAt.toISOString(),durable.occurredAt);
    await db.room.update({
        where: { id: room2.id },
        data: { status: "ready" },
      });
      await batch("RETURN_ACCEPTED", JSON.stringify(durable), 400);
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        2,
      );
      assert.equal(
        (await db.room.findUnique({ where: { id: room2.id } })).status,
        "ready",
      );
    } finally {
      await db.deviceOutboundEvent.deleteMany({ where: { deviceId: id } });
      await db.device.deleteMany({ where: { id } });
      await db.tenant.deleteMany({ where: { id: tenant } });
      await database.disconnect();
    }
  },
);
