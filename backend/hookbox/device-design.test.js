import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createHookboxService } from "./service.js";
import { defaultTheme } from "../../shared/hookbox/contract.mjs";
import { redactProtocol } from "./diagnostics.js";
const url = process.env.HOOKBOX_TEST_DATABASE_URL;
test(
  "device-specific publication, inherited hotel design, restoration, diagnostics and hotel isolation",
  { skip: !url },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const tenantId = randomUUID(),
      other = randomUUID(),
      ids = [randomUUID(), randomUUID()];
    const s = createHookboxService(db, () => {});
    try {
      await db.tenant.createMany({
        data: [tenantId, other].map((id) => ({ id, name: "test", slug: id })),
      });
      await db.device.createMany({
        data: ids.map((id) => ({
          id,
          deviceId: id,
          tenantId,
          name: id,
          hardwareModel: "CROWPANEL_7_V3",
          tokenHash: "test",
        })),
      });
      const [a, b] = await Promise.all(
        ids.map((id) => db.device.findUnique({ where: { id } })),
      );
      let e = await s.editor(tenantId);
      await s.draft(tenantId, {
        revision: e.hotel.revision,
        theme: defaultTheme("hotel"),
        mapping: [{ room: "101", hook: 1 }],
      });
      const hotel = await s.publish(tenantId, { revision: 1 }, "test");
      e = await s.editor(tenantId, a.id);
      await s.draft(tenantId, {
        deviceId: a.id,
        revision: e.hotel.revision,
        theme: defaultTheme("device"),
        mapping: [{ room: "101", hook: 25 }],
      });
      const device = await s.publish(
        tenantId,
        { deviceId: a.id, revision: 1 },
        "test",
      );
      assert.equal((await s.sync(a)).version, device.version);
      assert.equal((await s.sync(b)).version, hotel.version);
      assert.equal(
        JSON.parse((await s.sync(a)).manifest).roomMapping[0].hook,
        25,
      );
      await assert.rejects(s.editor(other, a.id), { statusCode: 404 });
      await assert.rejects(
        s.ack(b, {
          version: device.version,
          sha256: device.sha256,
          status: "applied",
        }),
      );
      e = await s.editor(tenantId);
      await s.publish(tenantId, { revision: e.hotel.revision }, "test");
      assert.equal((await s.sync(a)).version, device.version);
      await s.trace(
        a,
        "verify",
        { proof: "sensitive", value: "surname", token: "secret" },
        {
          reservationId: "private",
          rooms: [{ room: "101", hook: 25 }],
          status: "AUTHORIZED",
        },
        200,
      );
      const traces = await s.diagnostics(tenantId, a.id);
      assert.equal(traces.length, 1);
      assert.equal(traces[0].request.proof, "[REDACTED]");
      assert.equal(traces[0].response.rooms[0].hook, 25);
      assert.equal((await s.diagnostics(other)).length, 0);
      await assert.rejects(s.diagnostics(other, a.id));
      await assert.rejects(s.inherit(other,{deviceId:a.id}));
      await s.inherit(tenantId,{deviceId:a.id});
      assert.equal((await s.sync(a)).version,(await s.sync(b)).version);
    } finally {
      await db.device.deleteMany({ where: { id: { in: ids } } });
      await db.hookboxDesign.deleteMany({ where: { tenantId } });
      await db.hookboxHotel.deleteMany({ where: { tenantId } });
      await db.tenant.deleteMany({ where: { id: { in: [tenantId, other] } } });
      await db.$disconnect();
    }
  },
);
test("recursive diagnostic redaction preserves JSON structure", () => {
  assert.deepEqual(
    redactProtocol({
      proof: "x",
      rooms: [{ room: "101", hook: 1 }],
      status: "AUTHORIZED",
      mock: false,
    }),
    {
      proof: "[REDACTED]",
      rooms: [{ room: "[REDACTED]", hook: 1 }],
      status: "AUTHORIZED",
      mock: false,
    },
  );
});
