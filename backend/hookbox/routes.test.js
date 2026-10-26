import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { handleHookboxRoute } from "./routes.js";
import { createHookboxService } from "./service.js";
import { createOtaService } from "../services/otaService.js";
import { hashToken } from "../services/otaProtocol.js";
import { createRateLimiter } from "../rateLimiter.js";
import { authenticateRequest } from "../middleware/auth.js";
import {
  createLoginSession,
  sessionCookieHeader,
} from "../services/sessionService.js";
import { defaultTheme } from "../../shared/hookbox/contract.mjs";
const url = process.env.HOOKBOX_TEST_DATABASE_URL;
test(
  "HTTP routes use real device and session authentication, hotel roles, CSRF, JSON bounds, missing provider fail closed",
  { skip: !url && "Requires disposable migrated PostgreSQL" },
  async () => {
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = "test";
    process.env.OTA_DEV_ALLOW_HTTP = "true";
    process.env.APP_ORIGIN = "https://hookbox-test.example";
    process.env.SESSION_SECRET = "hookbox-test-session-secret-32-chars";
    const { createDatabaseClient } = await import("../databaseClient.js");
    const database = createDatabaseClient(),
      db = database.prisma,
      tenantId = randomUUID(),
      userId = randomUUID(),
      staffId = randomUUID(),
      id = randomUUID(),
      token = "a".repeat(64);
    const service = createHookboxService(db, async () => {
        throw Object.assign(Error("Provider not configured"), {
          statusCode: 503,
        });
      }),
      otaService = createOtaService(db, {});
    const server = createServer(async (request, response) => {
      try {
        if (
          !(await handleHookboxRoute({
            request,
            response,
            pathname: new URL(request.url, "http://localhost").pathname,
            service,
            otaService,
            getContext: async (req) => ({
              session: await authenticateRequest(req, database),
            }),
            limiter: createRateLimiter({ max: 10000 }),
          }))
        ) {
          response.writeHead(404);
          response.end("{}");
        }
      } catch (e) {
        response.writeHead(e.statusCode || 500, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: e.message }));
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      "X-Device-Id": "hb-" + id,
      authorization: "Bearer " + token,
    };
    const api = (path, options = {}) => fetch(base + path, options);
    try {
      await db.tenant.create({
        data: { id: tenantId, name: "HTTP Hotel", slug: "hb-" + tenantId },
      });
      await db.user.createMany({
        data: [
          {
            id: userId,
            email: userId + "@test.local",
            displayName: "Hotel admin",
            passwordHash: "unused",
          },
          {
            id: staffId,
            email: staffId + "@test.local",
            displayName: "Staff",
            passwordHash: "unused",
          },
        ],
      });
      await db.membership.createMany({
        data: [
          { tenantId, userId, role: "tenant_admin" },
          { tenantId, userId: staffId, role: "staff" },
        ],
      });
      await db.device.create({
        data: {
          id,
          deviceId: "hb-" + id,
          tenantId,
          name: "Test panel",
          hardwareModel: "CROWPANEL_7_V3",
          tokenHash: hashToken(token),
        },
      });
      const login = await createLoginSession(database, { id: userId }),
        staff = await createLoginSession(database, { id: staffId });
      const cookie = sessionCookieHeader(login.id, login.expiresAt).split(
          ";",
        )[0],
        staffCookie = sessionCookieHeader(staff.id, staff.expiresAt).split(
          ";",
        )[0];
      assert.equal((await api("/api/device/v1/hookbox/design")).status, 401);
      assert.equal(
        (await api("/api/device/v1/hookbox/design", { headers })).status,
        200,
      );
      assert.equal((await api("/api/hookbox/editor")).status, 401);
      assert.equal(
        (
          await api("/api/hookbox/editor", {
            headers: { cookie: staffCookie, "X-Tenant-Id": tenantId },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api("/api/hookbox/editor", {
            headers: { cookie, "X-Tenant-Id": tenantId },
          })
        ).status,
        200,
      );
      for(const path of ['/api/hookbox/devices','/api/hookbox/devices/'+id]){
        const own=await api(path,{headers:{cookie,'X-Tenant-Id':tenantId}});assert.equal(own.status,200);assert.equal(JSON.stringify(await own.json()).includes('tokenHash'),false);
        assert.equal((await api(path,{headers:{cookie:staffCookie,'X-Tenant-Id':tenantId}})).status,403);
      }
      const b = JSON.stringify({
        revision: 0,
        theme: defaultTheme(),
        mapping: [{ room: "101", hook: 1 }],
      });
      const admin = {
        cookie,
        "X-Tenant-Id": tenantId,
        "content-type": "application/json",
      };
      assert.equal(
        (
          await api("/api/hookbox/draft", {
            method: "POST",
            headers: admin,
            body: b,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api("/api/hookbox/draft", {
            method: "POST",
            headers: { ...admin, origin: process.env.APP_ORIGIN },
            body: b,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api("/api/device/v1/hookbox/lookup", {
            method: "POST",
            headers: { ...headers, "content-type": "text/plain" },
            body: "{}",
          })
        ).status,
        415,
      );
      assert.equal(
        (
          await api("/api/device/v1/hookbox/lookup", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: "{",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await api("/api/device/v1/hookbox/lookup", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              schemaVersion: 1,
              operationId: randomUUID(),
              language: "es",
              method: "surname",
              value: "Garcia",
            }),
          })
        ).status,
        503,
      );
      assert.equal(await db.hookboxClaim.count({ where: { tenantId } }), 0);
    } finally {
      await new Promise((r) => server.close(r));
      await db.session.deleteMany({
        where: { userId: { in: [userId, staffId] } },
      });
      await db.device.deleteMany({ where: { id } });
      await db.hookboxHotel.deleteMany({ where: { tenantId } });
      await db.membership.deleteMany({ where: { tenantId } });
      await db.user.deleteMany({ where: { id: { in: [userId, staffId] } } });
      await db.tenant.deleteMany({ where: { id: tenantId } });
      await database.disconnect();
    }
  },
);
