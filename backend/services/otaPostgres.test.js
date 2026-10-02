import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createOtaService } from "./otaService.js";
import { createFirmwareStorage } from "./firmwareStorage.js";
import { HEALTH_FLAGS } from "./otaProtocol.js";
import { handleOtaRoute } from "../routes/otaRoutes.js";
import { createRateLimiter } from "../rateLimiter.js";
import { authenticateRequest } from "../middleware/auth.js";
import { createLoginSession, sessionCookieHeader } from "./sessionService.js";

const url = process.env.OTA_POSTGRES_TEST_DATABASE_URL;
test(
  "PostgreSQL + HTTP OTA vertical, authorization, rollback and concurrent requests",
  {
    skip:
      !url &&
      "Set OTA_POSTGRES_TEST_DATABASE_URL to a disposable migrated PostgreSQL database.",
  },
  async (t) => {
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = "test";
    process.env.OTA_DEV_ALLOW_HTTP = "true";
    process.env.APP_ORIGIN = "https://ota-test.example";
    const { createDatabaseClient } = await import("../databaseClient.js");
    const database = createDatabaseClient(),
      prisma = database.prisma;
    const root = await mkdtemp(path.join(tmpdir(), "cico-ota-pg-")),
      storage = createFirmwareStorage(root),
      service = createOtaService(prisma, storage);
    const tenantId = randomUUID(),
      adminId = randomUUID(),
      userId = randomUUID();
    const deviceIds = [],
      releaseIds = [];
    const limiter = createRateLimiter({ max: 10000 });
    const server = createServer(async (request, response) => {
      try {
        const parsedUrl = new URL(request.url, "http://localhost");
        await handleOtaRoute({
          request,
          response,
          pathname: parsedUrl.pathname,
          parsedUrl,
          service,
          storage,
          limiter,
          getContext: async (req) => ({
            database,
            session: await authenticateRequest(req, database),
          }),
        });
      } catch (error) {
        response.writeHead(error.statusCode || 500, {
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: error.statusCode ? error.message : "Internal error",
          }),
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let adminCookie, tenantCookie, credentials, device, release, pending;
    const bytes = Buffer.alloc(1024, 0x31);
    bytes[0] = 0xe9;
    bytes.writeUInt16LE(9, 12);
    bytes.writeUInt32LE(0xabcd5432, 32);
    const deviceHeaders = () => ({
      "x-device-id": device.deviceId,
      authorization: `Bearer ${credentials.token}`,
    });
    async function api(
      endpoint,
      { cookie, method = "GET", body, raw, headers = {} } = {},
    ) {
      const result = await fetch(`${base}${endpoint}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method !== "GET" ? { origin: process.env.APP_ORIGIN } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : raw,
      });
      return { status: result.status, body: await result.json() };
    }
    const heartbeat = (version = "2.4.0", build = "20261002.ota-base") => ({
      device_id: device.deviceId,
      hardware_model: "CROWPANEL_7_V3",
      firmware_version: version,
      build_id: build,
      config_version: "1",
      uptime: 100,
      rssi: -50,
      local_ip: "192.168.1.2",
      free_heap: 123456,
      psram: 4000000,
      last_reset_reason: "POWERON",
      last_ota_result: null,
    });
    async function publish(version = "2.4.1", buildId = "20261002.ota-test") {
      const params = new URLSearchParams({
        version,
        buildId,
        hardwareModel: "CROWPANEL_7_V3",
        fileName: "firmware.bin",
      });
      const result = await api(`/api/admin/firmware-releases?${params}`, {
        method: "POST",
        cookie: adminCookie,
        raw: bytes,
        headers: { "content-type": "application/octet-stream" },
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      releaseIds.push(result.body.id);
      return result.body;
    }
    try {
      await prisma.tenant.create({
        data: { id: tenantId, name: "OTA test hotel", slug: `ota-${tenantId}` },
      });
      await prisma.user.createMany({
        data: [
          {
            id: adminId,
            email: `${adminId}@test.local`,
            displayName: "OTA admin",
            passwordHash: "unused",
            globalRole: "platform_admin",
          },
          {
            id: userId,
            email: `${userId}@test.local`,
            displayName: "Hotel admin",
            passwordHash: "unused",
          },
        ],
      });
      await prisma.membership.create({
        data: { userId, tenantId, role: "tenant_admin" },
      });
      for (const [id, isAdmin] of [
        [adminId, true],
        [userId, false],
      ]) {
        const session = await createLoginSession(database, { id });
        const cookie = sessionCookieHeader(session.id, session.expiresAt).split(
          ";",
        )[0];
        if (isAdmin) adminCookie = cookie;
        else tenantCookie = cookie;
      }
      await t.test(
        "Platform Admin alone can register devices, list/upload firmware and access downloads",
        async () => {
          assert.equal((await api("/api/admin/devices")).status, 401);
          for (const endpoint of [
            "/api/admin/devices",
            "/api/admin/firmware-releases",
          ])
            assert.equal(
              (await api(endpoint, { cookie: tenantCookie })).status,
              403,
            );
          assert.equal(
            (
              await api("/api/admin/firmware-releases?fileName=firmware.bin", {
                cookie: tenantCookie,
                method: "POST",
                raw: bytes,
                headers: { "content-type": "application/octet-stream" },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await api("/api/admin/devices", {
                cookie: adminCookie,
                method: "POST",
                headers: { origin: "https://evil.example" },
                body: { name: "bad" },
              })
            ).status,
            403,
          );
          const result = await api("/api/admin/devices", {
            cookie: adminCookie,
            method: "POST",
            body: {
              name: "Hookbox Lab",
              deviceId: `hookbox-${randomUUID()}`,
              hardwareModel: "CROWPANEL_7_V3",
              tenantId,
            },
          });
          assert.equal(result.status, 201);
          device = result.body;
          deviceIds.push(device.id);
          assert.equal(device.credentialConfigured, false);
          assert.equal("tokenHash" in device, false);
          credentials = await service.rotateCredential(device.id);
          assert.notEqual(
            (await prisma.device.findUnique({ where: { id: device.id } }))
              .tokenHash,
            credentials.token,
          );
          assert.equal(
            (
              await api(`/api/admin/devices/${device.id}/updates`, {
                cookie: tenantCookie,
                method: "POST",
                body: { releaseId: randomUUID() },
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "heartbeat authenticates individual credentials, persists diagnostics and denies identity mismatch",
        async () => {
          assert.equal(
            (
              await api("/api/device/v1/heartbeat", {
                method: "POST",
                body: heartbeat(),
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await api("/api/device/v1/heartbeat", {
                method: "POST",
                body: heartbeat(),
                headers: {
                  ...deviceHeaders(),
                  authorization: `Bearer ${"a".repeat(64)}`,
                },
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await api("/api/device/v1/heartbeat", {
                method: "POST",
                body: { ...heartbeat(), device_id: "another" },
                headers: deviceHeaders(),
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await api("/api/device/v1/heartbeat", {
                method: "POST",
                body: { ...heartbeat(), wifi_password: "not-persisted" },
                headers: deviceHeaders(),
              })
            ).status,
            200,
          );
          const details = (
            await api(`/api/admin/devices/${device.id}`, {
              cookie: adminCookie,
            })
          ).body;
          assert.equal(details.currentFirmwareVersion, "2.4.0");
          assert.equal(details.status, "ONLINE");
          assert.equal(details.lastRssi, -50);
          assert.equal(
            JSON.stringify(details).includes("not-persisted"),
            false,
          );
          assert.equal(
            JSON.stringify(details).includes(credentials.token),
            false,
          );
        },
      );
      await t.test(
        "upload persists server SHA, rejects empty/oversize/wrong files and immutable duplicates",
        async () => {
          release = await publish();
          assert.equal(
            release.sha256,
            createHash("sha256").update(bytes).digest("hex"),
          );
          assert.equal(release.fileSize, bytes.length);
          const params = new URLSearchParams({
            version: "2.4.1",
            buildId: "20261002.ota-test",
            hardwareModel: "CROWPANEL_7_V3",
            fileName: "firmware.bin",
          });
          for (const [raw, status] of [
            [bytes, 409],
            [Buffer.alloc(0), 400],
            [Buffer.alloc(1792 * 1024 + 1), 413],
          ]) {
            assert.equal(
              (
                await api(`/api/admin/firmware-releases?${params}`, {
                  cookie: adminCookie,
                  method: "POST",
                  raw,
                  headers: { "content-type": "application/octet-stream" },
                })
              ).status,
              status,
            );
          }
          assert.equal(
            (
              await api(
                `/api/admin/firmware-releases?${params}&fileName=bad.zip`,
                {
                  cookie: adminCookie,
                  method: "POST",
                  raw: bytes,
                  headers: { "content-type": "application/octet-stream" },
                },
              )
            ).status,
            400,
          );
          assert.equal(
            (
              await fetch(
                `${base}/api/admin/firmware-releases/${release.id}/download`,
                { headers: { cookie: tenantCookie } },
              )
            ).status,
            403,
          );
          const download = await fetch(
            `${base}/api/admin/firmware-releases/${release.id}/download`,
            { headers: { cookie: adminCookie } },
          );
          assert.equal(download.status, 200);
          assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
        },
      );
      await t.test(
        "hardware incompatibility and concurrent assignments cannot create overlapping OTA",
        async () => {
          const incompatible = await prisma.firmwareRelease.create({
            data: {
              version: "2.4.1",
              buildId: "other",
              hardwareModel: "OTHER_MODEL",
              fileName: "firmware.bin",
              fileSize: 1024,
              sha256: release.sha256,
              storagePath: `${randomUUID()}.bin`,
              createdBy: adminId,
            },
          });
          releaseIds.push(incompatible.id);
          assert.equal(
            (
              await api(`/api/admin/devices/${device.id}/updates`, {
                method: "POST",
                cookie: adminCookie,
                body: { releaseId: incompatible.id },
              })
            ).status,
            409,
          );
          const results = await Promise.all(
            [1, 2].map(() =>
              api(`/api/admin/devices/${device.id}/updates`, {
                method: "POST",
                cookie: adminCookie,
                body: { releaseId: release.id },
              }),
            ),
          );
          assert.deepEqual(
            results.map((result) => result.status).sort(),
            [201, 409],
          );
          pending = results.find((result) => result.status === 201).body;
          assert.equal(pending.status, "PENDING");
          assert.equal(
            (
              await api(`/api/admin/firmware-releases/${release.id}`, {
                method: "DELETE",
                cookie: adminCookie,
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "device polling returns assigned metadata, download is authenticated and scoped to its request",
        async () => {
          const poll = (
            await api("/api/device/v1/update", { headers: deviceHeaders() })
          ).body;
          assert.equal(poll.update.request_id, pending.id);
          assert.equal(poll.update.sha256, release.sha256);
          assert.equal(poll.update.signature, null);
          assert.equal(
            (await fetch(`${base}${poll.update.download_path}`)).status,
            401,
          );
          const download = await fetch(`${base}${poll.update.download_path}`, {
            headers: deviceHeaders(),
          });
          assert.equal(download.status, 200);
          assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
          const other = await service.createDevice({
            deviceId: `other-${randomUUID()}`,
            name: "Other",
            hardwareModel: "CROWPANEL_7_V3",
          });
          deviceIds.push(other.id);
          const token = await service.rotateCredential(other.id);
          assert.equal(
            (
              await fetch(`${base}${poll.update.download_path}`, {
                headers: {
                  "x-device-id": other.deviceId,
                  authorization: `Bearer ${token.token}`,
                },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await api(`/api/admin/devices/${device.id}/commands`, {
                method: "POST",
                cookie: adminCookie,
                body: { type: "RESTART" },
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "progress and health gate persist; a device-reported SHA failure leaves the current version unchanged",
        async () => {
          const report = (body) =>
            api("/api/device/v1/update/status", {
              method: "POST",
              headers: deviceHeaders(),
              body: { request_id: pending.id, ...body },
            });
          assert.equal(
            (
              await report({
                status: "SUCCESS",
                firmware_version: "2.4.1",
                build_id: release.buildId,
              })
            ).status,
            409,
          );
          for (const [status, progress] of [
            ["DOWNLOADING", 37],
            ["VERIFYING", 100],
            ["INSTALLING", 100],
            ["REBOOTING", 100],
            ["HEALTH_CHECK", 0],
          ])
            assert.equal((await report({ status, progress })).status, 200);
          const successful = {
            status: "SUCCESS",
            firmware_version: "2.4.1",
            build_id: release.buildId,
            health_check: Object.fromEntries(
              HEALTH_FLAGS.map((flag) => [flag, true]),
            ),
          };
          assert.equal((await report(successful)).status, 200);
          assert.equal((await report(successful)).body.duplicate, true);
          const details = (
            await api(`/api/admin/devices/${device.id}`, {
              cookie: adminCookie,
            })
          ).body;
          assert.equal(details.currentFirmwareVersion, "2.4.1");
          assert.equal(details.targetFirmwareVersion, null);
          assert.equal(details.updates[0].status, "SUCCESS");
          assert.equal(details.updates[0].events.length, 7);
          assert.equal(
            (
              await service.poll(
                await service.authenticate({ headers: deviceHeaders() }),
              )
            ).update,
            null,
          );
          assert.equal(
            (
              await fetch(
                `${base}/api/device/v1/updates/${pending.id}/firmware`,
                { headers: deviceHeaders() },
              )
            ).status,
            403,
          );
          const next = await publish("2.4.2", "sha-test");
          pending = await service.assignUpdate(device.id, next.id, adminId);
          assert.equal(
            (await report({ status: "FAILED", result_code: "SHA256_MISMATCH" }))
              .status,
            200,
          );
          assert.equal(
            (await service.getDevice(device.id)).currentFirmwareVersion,
            "2.4.1",
          );
        },
      );
      await t.test(
        "controlled rollback restores previous version and CICO records ROLLED_BACK",
        async () => {
          const next = await publish("2.4.3", "rollback-test");
          pending = await service.assignUpdate(device.id, next.id, adminId);
          const result = await api("/api/device/v1/update/status", {
            method: "POST",
            headers: deviceHeaders(),
            body: {
              request_id: pending.id,
              status: "ROLLED_BACK",
              firmware_version: "2.4.1",
              build_id: release.buildId,
              rolled_back: true,
              result_code: "BOOT_VALIDATION_FAILED",
            },
          });
          assert.equal(result.status, 200);
          const details = await service.getDevice(device.id);
          assert.equal(details.lastOtaStatus, "ROLLED_BACK");
          assert.equal(details.currentFirmwareVersion, "2.4.1");
          assert.equal(details.targetFirmwareVersion, null);
        },
      );
      await t.test(
        "commands are allowlisted, acknowledged idempotently, expired commands not delivered",
        async () => {
          assert.equal(
            (
              await api(`/api/admin/devices/${device.id}/commands`, {
                method: "POST",
                cookie: adminCookie,
                body: { type: "SHELL" },
              })
            ).status,
            400,
          );
          const cmd = await service.command(device.id, "RESTART", adminId);
          assert.equal(
            (await api("/api/device/v1/update", { headers: deviceHeaders() }))
              .body.command.type,
            "RESTART",
          );
          for (let i = 0; i < 2; i++)
            assert.equal(
              (
                await api("/api/device/v1/commands/ack", {
                  method: "POST",
                  headers: deviceHeaders(),
                  body: { command_id: cmd.id },
                })
              ).status,
              200,
            );
          const expired = await service.command(
            device.id,
            "CHECK_UPDATE",
            adminId,
          );
          await prisma.deviceCommand.update({
            where: { id: expired.id },
            data: { expiresAt: new Date(0) },
          });
          assert.equal(
            (await api("/api/device/v1/update", { headers: deviceHeaders() }))
              .body.command,
            null,
          );
        },
      );
      await t.test(
        "manual provisioning writes a private file, logs no token and refuses overwrite before rotation",
        async () => {
          const output = path.join(root, "lab.device-provisioning.json");
          const args = [
            fileURLToPath(
              new URL("../scripts/provisionDevice.js", import.meta.url),
            ),
            device.deviceId,
            output,
          ];
          const options = {
            env: {
              ...process.env,
              DATABASE_URL: url,
              OTA_PUBLIC_ORIGIN: "https://ota-test.example",
            },
          };
          const result = await promisify(execFile)(
            process.execPath,
            args,
            options,
          );
          const provisioned = JSON.parse(await readFile(output, "utf8"));
          assert.equal((await stat(output)).mode & 0o777, 0o600);
          assert.equal(provisioned.device_id, device.deviceId);
          assert.equal(result.stdout.includes(provisioned.token), false);
          assert.equal(result.stderr.includes(provisioned.token), false);
          credentials = { token: provisioned.token };
          const before = await prisma.device.findUnique({
            where: { id: device.id },
          });
          await assert.rejects(
            promisify(execFile)(process.execPath, args, options),
          );
          const after = await prisma.device.findUnique({
            where: { id: device.id },
          });
          assert.equal(after.credentialVersion, before.credentialVersion);
          assert.equal(after.tokenHash, before.tokenHash);
        },
      );

      await t.test(
        "files survive recreating storage/service; credential rotation/revocation rejects old tokens and stale operations",
        async () => {
          assert.deepEqual(
            await readFile(
              await createFirmwareStorage(root).get(
                await prisma.firmwareRelease.findUnique({
                  where: { id: release.id },
                }),
              ),
            ),
            bytes,
          );
          const previous = await service.authenticate({
            headers: deviceHeaders(),
          });
          credentials = await service.rotateCredential(device.id);
          await assert.rejects(service.heartbeat(previous, heartbeat()), {
            statusCode: 401,
          });
          assert.equal(
            (
              await api("/api/device/v1/heartbeat", {
                method: "POST",
                headers: deviceHeaders(),
                body: heartbeat("2.4.1", release.buildId),
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await api(`/api/admin/devices/${device.id}/revoke-credential`, {
                method: "POST",
                cookie: adminCookie,
              })
            ).status,
            200,
          );
          assert.equal(
            (await api("/api/device/v1/update", { headers: deviceHeaders() }))
              .status,
            401,
          );
          assert.equal((await service.getDevice(device.id)).status, "REVOKED");
          const unused = await publish("9.0.0", "delete-test");
          await service.deleteRelease(unused.id);
          await assert.rejects(service.downloadForAdmin(unused.id), {
            statusCode: 404,
          });
        },
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await prisma.otaRequest.deleteMany({
        where: { deviceId: { in: deviceIds } },
      });
      await prisma.deviceCommand.deleteMany({
        where: { deviceId: { in: deviceIds } },
      });
      await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
      await prisma.firmwareRelease.deleteMany({
        where: { id: { in: releaseIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [adminId, userId] } },
      });
      await prisma.tenant.delete({ where: { id: tenantId } });
      await database.disconnect();
      await rm(root, { recursive: true, force: true });
    }
  },
);
