import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { createHookboxService } from "./service.js";
import { defaultTheme } from "../../shared/hookbox/contract.mjs";
const url = process.env.HOOKBOX_TEST_DATABASE_URL;
test(
  "PostgreSQL Hookbox: tenants, publication, ACK, replay, concurrent claims, sequential outcomes, reboot uncertainty",
  {
    skip:
      !url &&
      "Set HOOKBOX_TEST_DATABASE_URL to an isolated migrated test database",
  },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } }),
      ta = randomUUID(),
      tb = randomUUID(),
      da = randomUUID(),
      dbid = randomUUID();
    let verifyCalls = 0;
    const provider = async (tenant, action, b) => {
      if (action === "lookup")
        return {
          schemaVersion: 1,
          status: b.value === "ambiguous" ? "AMBIGUOUS" : "CHALLENGE",
          challengeId: "challenge",
          mock: true,
        };
      verifyCalls++;
      if (b.proof !== "123456") throw Error("denied");
      return {
        schemaVersion: 1,
        authorized: true,
        identityVerified: true,
        conditionsSatisfied: true,
        reservationId: "stay-" + tenant,
        rooms: ["101", "102"],
        mock: true,
      };
    };
    const s = createHookboxService(db, provider);
    try {
      await db.tenant.createMany({
        data: [
          { id: ta, name: "A", slug: "hb-" + ta },
          { id: tb, name: "B", slug: "hb-" + tb },
        ],
      });
      await db.device.createMany({
        data: [
          {
            id: da,
            deviceId: "test-" + da,
            tenantId: ta,
            name: "Panel A",
            hardwareModel: "CROWPANEL_7_V3",
            tokenHash: "hash-a",
          },
          {
            id: dbid,
            deviceId: "test-" + dbid,
            tenantId: tb,
            name: "Panel B",
            hardwareModel: "CROWPANEL_7_V3",
            tokenHash: "hash-b",
          },
        ],
      });
      const a = await db.device.findUnique({ where: { id: da } }),
        b = await db.device.findUnique({ where: { id: dbid } });
      let editor = await s.editor(ta);
      assert.equal(editor.hotel.revision, 0);
      const theme = defaultTheme("Hotel A");
      await s.draft(ta, {
        revision: 0,
        theme,
        mapping: [
          { room: "101", hook: 1 },
          { room: "102", hook: 25 },
        ],
      });
      await assert.rejects(s.draft(ta, { revision: 0, theme, mapping: [] }), {
        statusCode: 409,
      });
      const p = await s.publish(ta, { revision: 1 }, "test-user");
      assert.equal((await s.sync(a)).version, p.version);
      const stored = await db.hookboxDesign.findUnique({
        where: { id: p.version },
      });
      assert.notEqual(
        JSON.stringify(stored.manifest),
        stored.manifestRaw,
        "PostgreSQL JSONB reordered the editor object",
      );
      const reloaded = await createHookboxService(db, provider).sync(a);
      assert.equal(reloaded.manifest, stored.manifestRaw);
      assert.equal(
        createHash("sha256").update(reloaded.manifest, "utf8").digest("hex"),
        reloaded.sha256,
      );
      assert.equal(reloaded.sha256, p.sha256);

      assert.equal((await s.sync(b)).version, null);
      await assert.rejects(
        s.ack(b, { version: p.version, sha256: p.sha256, status: "applied" }),
      );
      await s.ack(a, {
        version: p.version,
        sha256: p.sha256,
        status: "applied",
      });
      assert.equal((await s.editor(ta)).devices[0].uiAppliedVersion, p.version);
      // Visual publication leaves the prior servo/RFID configuration untouched.
      assert.deepEqual(
        (await db.device.findUnique({ where: { id: da } })).desiredConfig,
        {},
      );
      const asset = await s.upload(ta, {
        kind: "logo",
        width: 1,
        height: 1,
        data: Buffer.from([0, 0]).toString("base64"),
      });
      await assert.rejects(s.asset(tb, asset.id));
      await assert.rejects(
        s.upload(ta, { kind: "logo", width: 801, height: 480, data: "AA==" }),
      );
      const id = randomUUID(),
        lookup = {
          schemaVersion: 1,
          operationId: id,
          language: "de",
          method: "surname",
          value: "Müller",
        };
      const l = await s.lookup(a, lookup);
      assert.equal(l.status, "CHALLENGE");
      assert.equal(l.rooms, undefined);
      assert.equal((await s.lookup(a, lookup)).operationId, id);
      await assert.rejects(s.lookup(b, lookup));
      await assert.rejects(s.start(a, { operationId: id }));
      for (let i = 0; i < 3; i++)
        assert.equal(
          (await s.verify(a, { operationId: id, proof: "wrong" })).status,
          "DENIED",
        );
      await assert.rejects(s.verify(a, { operationId: id, proof: "123456" }));
      assert.equal(verifyCalls, 3);
      const id2 = randomUUID();
      await s.lookup(a, { ...lookup, operationId: id2 });
      assert.equal(
        (await s.verify(a, { operationId: id2, proof: "123456" })).status,
        "AUTHORIZED",
      );
      const starts = await Promise.all([
        s.start(a, { operationId: id2 }),
        s.start(a, { operationId: id2 }),
      ]);
      assert.equal(starts[0].status, "RELEASING");
      assert.equal(await db.hookboxClaim.count({ where: { tenantId: ta } }), 2);
      await assert.rejects(
        s.result(a, {
          operationId: id2,
          index: 1,
          result: "MOCK_ACTIVATION",
          physicallyConfirmed: false,
          mock: true,
        }),
        { statusCode: 409 },
      );
      await assert.rejects(s.finish(a, { operationId: id2 }));
      const report = {
        operationId: id2,
        index: 0,
        result: "MOCK_ACTIVATION",
        physicallyConfirmed: false,
        mock: true,
      };
      await s.result(a, report);
      await s.result(a, report);
      await assert.rejects(s.result(a, { ...report, result: "UNCERTAIN" }), {
        statusCode: 409,
      });
      await s.result(a, { ...report, index: 1, result: "UNCERTAIN" });
      await assert.rejects(s.finish(a, { operationId: id2 }));
      assert.equal(
        (await createHookboxService(db, provider).status(a, id2)).status,
        "UNCERTAIN",
      );
      // A reboot or an expired session does not release durable claims.
      await db.hookboxOperation.update({
        where: { id: id2 },
        data: { expiresAt: new Date(0) },
      });
      const id3 = randomUUID();
      await s.lookup(a, { ...lookup, operationId: id3 });
      await s.verify(a, { operationId: id3, proof: "123456" });
      await assert.rejects(s.start(a, { operationId: id3 }), {
        statusCode: 409,
      });
      await db.device.update({ where: { id: da }, data: { tenantId: tb } });
      await assert.rejects(s.sync(a), { statusCode: 403 });
    } finally {
      await db.hookboxClaim.deleteMany({
        where: { tenantId: { in: [ta, tb] } },
      });
      await db.hookboxOperation.deleteMany({
        where: { tenantId: { in: [ta, tb] } },
      });
      await db.deviceEvent.deleteMany({
        where: { deviceId: { in: [da, dbid] } },
      });
      await db.device.deleteMany({ where: { id: { in: [da, dbid] } } });
      await db.hookboxDesign.deleteMany({
        where: { tenantId: { in: [ta, tb] } },
      });
      await db.hookboxAsset.deleteMany({
        where: { tenantId: { in: [ta, tb] } },
      });
      await db.hookboxHotel.deleteMany({
        where: { tenantId: { in: [ta, tb] } },
      });
      await db.tenant.deleteMany({ where: { id: { in: [ta, tb] } } });
      await db.$disconnect();
    }
  },
);
