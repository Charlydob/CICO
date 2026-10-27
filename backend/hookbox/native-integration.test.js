import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createHookboxService } from "./service.js";
import { handleHookboxRoute } from "./routes.js";
import { createOtaService } from "../services/otaService.js";
import { hashToken } from "../services/otaProtocol.js";
import { defaultTheme } from "../../shared/hookbox/contract.mjs";
const url = process.env.HOOKBOX_TEST_DATABASE_URL,
  exe = process.env.HOOKBOX_NATIVE_EXECUTABLE;
test(
  "authenticated HTTP + PostgreSQL PIN + compiled C++ safe actuator simulation on all 25 hooks",
  { skip: !(url && exe), timeout: 240000 },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.OTA_DEV_ALLOW_HTTP = "true";
    const db = new PrismaClient({ datasources: { db: { url } } }),
      tenant = randomUUID(),
      id = randomUUID(),
      token = "b".repeat(64);
    const s = createHookboxService(db, () => {
        throw Error("No external provider allowed");
      }),
      ota = createOtaService(db, {});
    const server = createServer(async (request, response) => {
      try {
        if (
          !(await handleHookboxRoute({
            request,
            response,
            pathname: new URL(request.url, "http://localhost").pathname,
            service: s,
            otaService: ota,
            getContext: () => {
              throw Error("No admin session");
            },
            limiter: { allow: () => true },
          }))
        ) {
          response.writeHead(404);
          response.end("{}");
        }
      } catch (e) {
        response.writeHead(e.statusCode || 500, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: e.statusCode ? e.message : "Internal error",
          }),
        );
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const api = async (path, body, auth = token) => {
      const r = await fetch(
        `http://127.0.0.1:${server.address().port}/api/device/v1/hookbox/` +
          path,
        {
          method: body ? "POST" : "GET",
          headers: {
            "X-Device-Id": id,
            authorization: "Bearer " + auth,
            "content-type": "application/json",
          },
          ...(body
            ? { body: JSON.stringify({ schemaVersion: 1, ...body }) }
            : {}),
        },
      );
      return { status: r.status, body: await r.json() };
    };
    try {
      await db.tenant.create({
        data: { id: tenant, name: "Native PIN fixture", slug: tenant },
      });
      await db.device.create({
        data: {
          id,
          deviceId: id,
          tenantId: tenant,
          name: "Native PIN simulator",
          hardwareModel: "CROWPANEL_7_V3",
          tokenHash: hashToken(token),
        },
      });
      assert.equal(
        (await api("pin", { operationId: randomUUID(), pin: "0000" }, "wrong"))
          .status,
        401,
      );
      assert.equal(
        (await api("lookup", { operationId: randomUUID(), value: "obsolete" }))
          .status,
        410,
      );
      const h = await s.editor(tenant);
      await s.draft(tenant, {
        revision: h.hotel.revision,
        theme: defaultTheme(),
        mapping: [],
      });
      await s.publish(tenant, { revision: 1 }, "fixture");
      assert.equal((await api("design")).status, 200);
      for (let hook = 1; hook <= 25; hook++)
        await s.saveHook(
          tenant,
          id,
          { hook, room: String(100 + hook), pin: String(6000 + hook) },
          "fixture",
        );
      for (let hook = 1; hook <= 25; hook++) {
        const operationId = randomUUID(),
          pin = String(6000 + hook);
        const p = await api("pin", { operationId, pin, mock: true });
        assert.equal(p.status, 200);
        assert.equal(p.body.status, "AUTHORIZED");
        assert.deepEqual(p.body.rooms, [{ room: String(100 + hook), hook }]);
        assert.equal(
          (await api("release/start", { operationId })).body.status,
          "RELEASING",
        );
        const native = spawnSync(exe, [], {
          input:
            JSON.stringify({
              operationId,
              pinValidated: true,
              rooms: p.body.rooms,
            }) + "\n",
          encoding: "utf8",
        });
        assert.equal(native.status, 0, native.stderr);
        const result = JSON.parse(native.stdout.trim().split("\n")[0]);
        assert.equal(result.hook, hook);
        assert.equal(result.result, "MOCK_ACTIVATION");
        const report = {
          operationId,
          index: 0,
          result: result.result,
          physicallyConfirmed: false,
          mock: true,
        };
        assert.equal((await api("release/result", report)).status, 200);
        assert.equal((await api("release/result", report)).status, 200);
        assert.equal(
          (await api("complete", { operationId })).body.status,
          "COMPLETE",
        );
        if (hook === 1 || hook === 25)
          assert.equal(
            (await api("pin", { operationId: randomUUID(), pin, mock: true }))
              .body.status,
            "DENIED",
          );
      }
      assert.equal(
        await db.deviceOutboundEvent.count({ where: { deviceId: id } }),
        0,
      );
      const traces = await db.hookboxProtocolTrace.findMany({
        where: { deviceId: id, path: "pin" },
      });
      assert.ok(traces.length);
      assert.ok(traces.every((t) => t.request.pin === "[REDACTED]"));
    } finally {
      await new Promise((r) => server.close(r));
      await db.hookboxOperation.deleteMany({ where: { deviceId: id } });
      await db.device.deleteMany({ where: { id } });
      await db.tenant.deleteMany({ where: { id: tenant } });
      await db.$disconnect();
    }
  },
);
