import test from "node:test";
import { writeFile } from "node:fs/promises";
import { redactProtocol } from "./diagnostics.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createHookboxService } from "./service.js";
import { handleHookboxRoute } from "./routes.js";
import { createCheckinProvider } from "./provider.js";
import { createOtaService } from "../services/otaService.js";
import { hashToken } from "../services/otaProtocol.js";
import { defaultTheme } from "../../shared/hookbox/contract.mjs";
const url = process.env.HOOKBOX_TEST_DATABASE_URL,
  exe = process.env.HOOKBOX_NATIVE_EXECUTABLE;
test(
  "real authenticated HTTP + PostgreSQL + configurable provider + compiled C++ firmware policy: 1 and 25 hooks",
  {
    skip:
      !(url && exe) &&
      "Set HOOKBOX_TEST_DATABASE_URL and HOOKBOX_NATIVE_EXECUTABLE for compiled firmware integration",
  },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.OTA_DEV_ALLOW_HTTP = "true";
    const db = new PrismaClient({ datasources: { db: { url } } }),
      tenantId = randomUUID(),
      id = randomUUID(),
      token = "b".repeat(64);
    let count = 1;
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      body = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer integration-fixture") {
        res.writeHead(403);
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify(
          req.url.endsWith("lookup")
            ? {
                schemaVersion: 1,
                status: body.value === "ambiguous" ? "AMBIGUOUS" : "CHALLENGE",
                challengeId: "fixture",
              }
            : {
                schemaVersion: 1,
                authorized: body.proof === "123456",
                identityVerified: body.proof === "123456",
                conditionsSatisfied: true,
                reservationId: body.challengeId + "-" + count,
                rooms: Array.from({ length: count }, (_, i) => String(101 + i)),
              },
        ),
      );
    });
    await new Promise((r) => provider.listen(0, "127.0.0.1", r));
    const service = createHookboxService(
        db,
        createCheckinProvider(
          JSON.stringify({
            [tenantId]: {
              url: `http://127.0.0.1:${provider.address().port}/`,
              token: "integration-fixture",
              mock: true,
            },
          }),
        ),
      ),
      otaService = createOtaService(db, {});
    const server = createServer(async (request, response) => {
      try {
        await handleHookboxRoute({
          request,
          response,
          pathname: new URL(request.url, "http://localhost").pathname,
          service,
          otaService,
          limiter: { allow: () => true },
          getContext: async () => {
            throw Error("admin disabled in this fixture");
          },
        });
      } catch (e) {
        response.writeHead(e.statusCode || 500, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: e.message }));
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/api/device/v1/hookbox/`;
    const exchanges = [];
    const api = async (path, body) => {
      const r = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          "X-Device-Id": id,
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        ...(body
          ? { body: JSON.stringify({ schemaVersion: 1, ...body }) }
          : {}),
      });
      const payload = await r.json();
      exchanges.push({
        path: "/api/device/v1/hookbox/" + path,
        method: body ? "POST" : "GET",
        status: r.status,
        request: redactProtocol(body ? { schemaVersion: 1, ...body } : {}),
        response: redactProtocol(payload),
      });
      return { status: r.status, body: payload };
    };
    try {
      await db.tenant.create({
        data: { id: tenantId, name: "Integration fixture", slug: tenantId },
      });
      await db.device.create({
        data: {
          id,
          deviceId: id,
          tenantId,
          name: "Simulated CrowPanel",
          hardwareModel: "CROWPANEL_7_V3",
          tokenHash: hashToken(token),
        },
      });
      await service.editor(tenantId);
      await service.draft(tenantId, {
        revision: 0,
        theme: defaultTheme(),
        mapping: Array.from({ length: 25 }, (_, i) => ({
          room: String(101 + i),
          hook: i + 1,
        })),
      });
      await service.publish(tenantId, { revision: 1 }, "test");
      assert.equal((await api("design")).status, 200);
      for (count of [1, 25]) {
        const operationId = randomUUID();
        assert.equal(
          (
            await api("lookup", {
              operationId,
              language: "de",
              method: "id",
              value: "fixture",
            })
          ).body.status,
          "CHALLENGE",
        );
        assert.equal(
          (await api("verify", { operationId, proof: "wrong" })).body.status,
          "DENIED",
        );
        const auth = (await api("verify", { operationId, proof: "123456" }))
          .body;
        assert.equal(auth.status, "AUTHORIZED");
        assert.equal(auth.rooms.length, count);
        assert.equal(
          (await api("release/start", { operationId, mock: true })).body.status,
          "RELEASING",
        );
        const native = spawnSync(exe, [], {
          input:
            JSON.stringify({
              ...auth,
              identityVerified: auth.status === "AUTHORIZED",
              conditionsSatisfied: true,
            }) + "\n",
          encoding: "utf8",
        });
        assert.equal(native.status, 0, native.stderr);
        const lines = native.stdout.trim().split(/\r?\n/).map(JSON.parse);
        assert.equal(lines.length, count + 1);
        for (const result of lines.slice(0, -1)) {
          assert.equal(
            (
              await api("release/result", {
                ...result,
                operationId,
                mock: true,
              })
            ).status,
            200,
          );
        }
        assert.equal(
          (await api("complete", { operationId })).body.status,
          "COMPLETE",
        );
        assert.equal(
          (await api("release/start", { operationId, mock: true })).body.status,
          "COMPLETE",
        );
        const dup = randomUUID();
        await api("lookup", {
          operationId: dup,
          language: "de",
          method: "id",
          value: "fixture",
        });
        await api("verify", { operationId: dup, proof: "123456" });
        assert.equal(
          (await api("release/start", { operationId: dup, mock: true })).status,
          409,
        );
        await db.hookboxOperation.update({
          where: { id: dup },
          data: { expiresAt: new Date(0) },
        });
      }
      const amb = (
        await api("lookup", {
          operationId: randomUUID(),
          language: "de",
          method: "surname",
          value: "ambiguous",
        })
      ).body;
      assert.equal(amb.status, "AMBIGUOUS");
      const traces = await service.diagnostics(tenantId);
      assert.ok(traces.length > 25);
      assert.ok(!JSON.stringify(traces).includes("123456"));
      assert.ok(!JSON.stringify(traces).includes(token));
      if (process.env.HOOKBOX_INTEGRATION_EVIDENCE)
        await writeFile(
          process.env.HOOKBOX_INTEGRATION_EVIDENCE,
          JSON.stringify(
            {
              description:
                "Actual local HTTP and PostgreSQL exchanges with compiled C++ firmware core; simulated electrical outputs",
              exchanges,
            },
            null,
            2,
          ),
        );
    } finally {
      await new Promise((r) => server.close(r));
      await new Promise((r) => provider.close(r));
      await db.hookboxClaim.deleteMany({ where: { tenantId } });
      await db.hookboxOperation.deleteMany({ where: { tenantId } });
      await db.device.delete({ where: { id } });
      await db.hookboxDesign.deleteMany({ where: { tenantId } });
      await db.hookboxHotel.deleteMany({ where: { tenantId } });
      await db.tenant.delete({ where: { id: tenantId } });
      await db.$disconnect();
    }
  },
);
