import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { handleOtaRoute } from "../routes/otaRoutes.js";
import { handleAdminRoute } from "../routes/adminRoutes.js";
import { createOtaService } from "../services/otaService.js";
import { authenticateRequest } from "../middleware/auth.js";
import {
  createLoginSession,
  sessionCookieHeader,
} from "../services/sessionService.js";
const url = process.env.HOOKBOX_TEST_DATABASE_URL;
test(
  "real admin HTTP route composition reaches hook PIN and integration settings after OTA router",
  { skip: !url },
  async () => {
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = "test";
    process.env.OTA_DEV_ALLOW_HTTP = "true";
    process.env.APP_ORIGIN = "https://pin-admin.example";
    const { createDatabaseClient } = await import("../databaseClient.js");
    const database = createDatabaseClient(),
      db = database.prisma,
      tenant = randomUUID(),
      userId = randomUUID(),
      id = randomUUID(),
      checkoutId = randomUUID();
    const ota = createOtaService(db, {}, { database });
    const context = async (request) => ({
      database,
      session: await authenticateRequest(request, database),
    });
    const server = createServer(async (request, response) => {
      try {
        const parsedUrl = new URL(request.url, "http://localhost"),
          pathname = parsedUrl.pathname;
        if (
          await handleOtaRoute({
            request,
            response,
            pathname,
            parsedUrl,
            service: ota,
            storage: {},
            getContext: context,
            limiter: { allow: () => true },
          })
        )
          return;
        const chunks = [];
        for await (const c of request) chunks.push(c);
        const body = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : {};
        const result = await handleAdminRoute({
          request,
          pathname,
          body,
          context: await context(request),
        });
        response.writeHead(result.status, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(result.payload));
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
    try {
      await db.tenant.create({
        data: { id: tenant, name: "Admin route fixture", slug: tenant },
      });
      const user = await db.user.create({
        data: {
          id: userId,
          email: userId + "@example.test",
          passwordHash: "unused",
          displayName: "Admin fixture",
          globalRole: "platform_admin",
        },
      });
      await db.device.createMany({
        data: [
          { id, hardwareModel: "CROWPANEL_7_V3" },
          { id: checkoutId, hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1" },
        ].map((d) => ({ ...d, deviceId: d.id, name: d.id, tenantId: tenant })),
      });
      const session = await createLoginSession(database, user),
        cookie = sessionCookieHeader(session.id, session.expiresAt).split(
          ";",
        )[0];
      const api = async (path, body) => {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}` + path,
          {
            method: body ? "POST" : "GET",
            headers: {
              cookie,
              origin: process.env.APP_ORIGIN,
              "content-type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        );
        return { status: response.status, data: await response.json() };
      };
      const hooks = "/api/admin/devices/" + id + "/hooks",
        integration = "/api/admin/devices/" + id + "/integration";
      assert.equal((await api(hooks)).status, 200);
      assert.equal(
        (await api(hooks, { hook: 1, room: "105", pin: "5932" })).status,
        200,
      );
      const list = await api(hooks);
      assert.equal(list.data.hooks[0].hasPin, true);
      assert.equal(JSON.stringify(list).includes("5932"), false);
      const initial = await api(integration);
      assert.equal(initial.status, 200);
      assert.equal(initial.data.outbound.enabled, false);
      assert.equal(
        (
          await api(integration, {
            outbound: initial.data.outbound,
            headers: [
              { name: "Authorization", value: "Bearer private-test-value" },
            ],
          })
        ).status,
        200,
      );
      const saved = await api(integration);
      assert.equal(JSON.stringify(saved).includes("private-test-value"), false);
      const simulated = await api(integration + "/simulate", {
        outbound: initial.data.outbound,
      });
      assert.equal(simulated.status, 200);
      assert.equal(simulated.data.simulated, true);
      assert.equal(simulated.data.preview.key, "105");
      const checkout = await api(
        "/api/admin/devices/" + checkoutId + "/integration",
      );
      assert.equal(checkout.status, 200);
      assert.equal(checkout.data.outbound.fields[1].key, "check-out at");
    } finally {
      await new Promise((r) => server.close(r));
      await db.device.deleteMany({ where: { id: { in: [id, checkoutId] } } });
      await db.user.deleteMany({ where: { id: userId } });
      await db.tenant.deleteMany({ where: { id: tenant } });
      await database.disconnect();
    }
  },
);
