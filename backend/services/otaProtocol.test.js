import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ACTIVE_STATES,
  HEALTH_FLAGS,
  compareVersions,
  hashToken,
  validToken,
  publicDevice,
  heartbeatPatch,
  validateStatusReport,
  validateReleaseMetadata,
} from "./otaProtocol.js";
import { createFirmwareStorage } from "./firmwareStorage.js";
import {
  handleOtaRoute,
  requireFirmwarePublisher,
  requireOtaTransport,
} from "../routes/otaRoutes.js";

const device = { deviceId: "hookbox-lab", hardwareModel: "CROWPANEL_7_V3" };
export function heartbeat(extra = {}) {
  return {
    device_id: device.deviceId,
    hardware_model: device.hardwareModel,
    firmware_version: "2.4.0",
    build_id: "20261002.ota-base",
    config_version: "1",
    uptime: 300,
    rssi: -55,
    local_ip: "192.168.1.123",
    free_heap: 100000,
    psram: 4000000,
    last_reset_reason: "POWERON",
    last_ota_result: null,
    ...extra,
  };
}
function image(size = 512) {
  const value = Buffer.alloc(size, 0x42);
  value[0] = 0xe9;
  value.writeUInt16LE(9, 12);
  value.writeUInt32LE(0xabcd5432, 32);
  return value;
}
function upload(data, headers = {}) {
  const request = Readable.from(Array.isArray(data) ? data : [data]);
  request.headers = headers;
  return request;
}
const update = {
  status: "DOWNLOADING",
  progress: 37,
  previousVersion: "2.4.0",
  previousBuildId: "20261002.ota-base",
  release: { version: "2.4.1", buildId: "20261002.ota-test" },
};

test("device tokens are individual, hashed, constant-time compared and never exposed in public device", () => {
  const token = randomBytes(32).toString("hex"),
    hash = hashToken(token);
  assert.notEqual(token, hash);
  assert.equal(validToken(token, hash), true);
  assert.equal(validToken(randomBytes(32).toString("hex"), hash), false);
  for (const bad of ["", null, "a", "X".repeat(64)])
    assert.equal(validToken(bad, hash), false);
  const safe = publicDevice({
    ...device,
    tokenHash: hash,
    lastSeenAt: new Date(),
    credentialRevokedAt: null,
  });
  assert.equal(safe.status, "ONLINE");
  assert.equal(safe.credentialConfigured, true);
  assert.equal("tokenHash" in safe, false);
  assert.equal(
    publicDevice({ lastSeenAt: new Date(Date.now() - 100000) }).status,
    "OFFLINE",
  );
});
test("numeric version comparison handles minor/patch widths and rejects malformed versions", () => {
  assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
  assert.equal(compareVersions("2.4.0", "2.4.1"), -1);
  assert.equal(compareVersions("2.4.1", "2.4.1"), 0);
  assert.throws(() => compareVersions("2.4", "2.4.1"));
});
test("heartbeat stores allowlisted diagnostics without Wi-Fi secrets and validates identity", () => {
  const result = heartbeatPatch(
    heartbeat({ wifi_password: "must-not-store", ssid: "do-not-store" }),
    device,
  );
  assert.equal(result.lastRssi, -55);
  assert.equal(result.uptime, 300);
  assert.equal("wifi_password" in result, false);
  assert.equal("ssid" in result, false);
  assert.throws(() =>
    heartbeatPatch(heartbeat({ device_id: "other" }), device),
  );
  assert.throws(() =>
    heartbeatPatch(heartbeat({ hardware_model: "OTHER" }), device),
  );
  assert.throws(() => heartbeatPatch(heartbeat({ local_ip: "bad" }), device));
  assert.throws(() => heartbeatPatch(heartbeat({ free_heap: -1 }), device));
});
test("release metadata rejects unknown hardware, non-bin and traversal paths", () => {
  const metadata = {
    version: "2.4.1",
    buildId: "20261002.ota-test",
    hardwareModel: device.hardwareModel,
    fileName: "firmware.bin",
  };
  assert.equal(validateReleaseMetadata(metadata).releaseNotes, "");
  for (const patch of [
    { fileName: "firmware.zip" },
    { fileName: "../firmware.bin" },
    { hardwareModel: "__proto__" },
    { version: "latest" },
  ])
    assert.throws(() => validateReleaseMetadata({ ...metadata, ...patch }));
});
test("OTA states advance monotonically, require boot health for success and previous build for rollback", () => {
  assert.equal(
    validateStatusReport(update, { status: "VERIFYING" }).status,
    "VERIFYING",
  );
  assert.throws(() =>
    validateStatusReport(update, { status: "DOWNLOADING", progress: 36 }),
  );
  assert.throws(() =>
    validateStatusReport(
      { ...update, status: "VERIFYING" },
      { status: "DOWNLOADING" },
    ),
  );
  assert.throws(() =>
    validateStatusReport(update, {
      status: "SUCCESS",
      firmware_version: "2.4.1",
      build_id: update.release.buildId,
    }),
  );
  const success = {
    status: "SUCCESS",
    firmware_version: "2.4.1",
    build_id: update.release.buildId,
    health_check: Object.fromEntries(HEALTH_FLAGS.map((flag) => [flag, true])),
  };
  assert.equal(validateStatusReport(update, success).progress, 100);
  assert.throws(() =>
    validateStatusReport(update, { ...success, build_id: "wrong" }),
  );
  for (const flag of HEALTH_FLAGS)
    assert.throws(() =>
      validateStatusReport(update, {
        ...success,
        health_check: { ...success.health_check, [flag]: false },
      }),
    );
  const rollback = {
    status: "ROLLED_BACK",
    firmware_version: update.previousVersion,
    build_id: update.previousBuildId,
    rolled_back: true,
    result_code: "BOOT_VALIDATION_FAILED",
  };
  assert.equal(validateStatusReport(update, rollback).status, "ROLLED_BACK");
  assert.throws(() =>
    validateStatusReport(update, { ...rollback, firmware_version: "2.4.1" }),
  );
  assert.throws(() =>
    validateStatusReport(update, {
      status: "FAILED",
      result_code: "https://secret.invalid",
    }),
  );
  assert.equal(
    validateStatusReport({ ...update, status: "SUCCESS" }, success).duplicate,
    true,
  );
  assert.throws(() =>
    validateStatusReport({ ...update, status: "SUCCESS" }, rollback),
  );
  assert.equal(ACTIVE_STATES.includes("SUCCESS"), false);
});
test("server hashes persisted bytes and rejects empty, bootloader, merged USB and oversized firmware", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ota-storage-")),
    storage = createFirmwareStorage(root);
  try {
    const bytes = image(),
      artifact = await storage.save(
        upload([bytes.subarray(0, 8), bytes.subarray(8)]),
        device.hardwareModel,
      );
    assert.equal(artifact.fileSize, bytes.length);
    assert.equal(
      artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await readFile(await storage.get(artifact)), bytes);
    const max = image(1792 * 1024);
    const maximum = await storage.save(upload(max), device.hardwareModel);
    assert.equal(maximum.fileSize, max.length);
    await assert.rejects(
      storage.save(upload(Buffer.alloc(0)), device.hardwareModel),
    );
    await assert.rejects(
      storage.save(upload(image(1792 * 1024 + 1)), device.hardwareModel),
      { statusCode: 413 },
    );
    await assert.rejects(
      storage.save(upload(Buffer.alloc(512, 0xff)), device.hardwareModel),
    );
    const bootloader = image();
    bootloader.writeUInt32LE(0, 32);
    await assert.rejects(
      storage.save(upload(bootloader), device.hardwareModel),
    );
    const otherChip = image();
    otherChip.writeUInt16LE(0, 12);
    await assert.rejects(storage.save(upload(otherChip), device.hardwareModel));
    await assert.rejects(
      storage.save(
        upload(bytes, { "content-length": "9999999" }),
        device.hardwareModel,
      ),
      { statusCode: 413 },
    );
    await assert.rejects(
      storage.save(
        upload(bytes, { "content-length": "1000" }),
        device.hardwareModel,
      ),
    );
    await assert.rejects(
      storage.get({ storagePath: "../secret", fileSize: 1 }),
    );
    assert.equal(
      (await readdir(root)).filter((name) => name.endsWith(".upload")).length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("production OTA rejects HTTP and cannot enable the development exception", () => {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    OTA_DEV_ALLOW_HTTP: process.env.OTA_DEV_ALLOW_HTTP,
    OTA_PUBLIC_ORIGIN: process.env.OTA_PUBLIC_ORIGIN,
    OTA_TRUST_PROXY: process.env.OTA_TRUST_PROXY,
  };
  try {
    process.env.NODE_ENV = "production";
    process.env.OTA_DEV_ALLOW_HTTP = "true";
    process.env.OTA_PUBLIC_ORIGIN = "https://cico.example";
    process.env.OTA_TRUST_PROXY = "false";
    assert.throws(() => requireOtaTransport({ headers: {}, socket: {} }), {
      statusCode: 426,
    });
    assert.doesNotThrow(() =>
      requireOtaTransport({ headers: {}, socket: { encrypted: true } }),
    );
    process.env.OTA_TRUST_PROXY = "true";
    assert.doesNotThrow(() =>
      requireOtaTransport({
        headers: { "x-forwarded-proto": "https" },
        socket: {},
      }),
    );
    process.env.OTA_PUBLIC_ORIGIN = "http://cico.example";
    assert.throws(
      () =>
        requireOtaTransport({
          headers: { "x-forwarded-proto": "https" },
          socket: {},
        }),
      { statusCode: 503 },
    );
  } finally {
    for (const [key, value] of Object.entries(original))
      value === undefined
        ? delete process.env[key]
        : (process.env[key] = value);
  }
});

test("CI firmware publisher uses a dedicated rotatable token", () => {
  const env = { CICO_FIRMWARE_PUBLISH_TOKEN: "a".repeat(64) };
  assert.doesNotThrow(() =>
    requireFirmwarePublisher(
      { headers: { authorization: `Bearer ${"a".repeat(64)}` } },
      env,
    ),
  );
  for (const authorization of [undefined, "Bearer wrong", `Basic ${"a".repeat(64)}`])
    assert.throws(
      () => requireFirmwarePublisher({ headers: { authorization } }, env),
      { statusCode: 401 },
    );
  assert.throws(
    () =>
      requireFirmwarePublisher(
        { headers: { authorization: `Bearer ${"a".repeat(64)}` } },
        {},
      ),
    { statusCode: 401 },
  );
});

test("CI publisher validates the declared checksum and cannot assign devices", async () => {
  const original = {
    token: process.env.CICO_FIRMWARE_PUBLISH_TOKEN,
    origin: process.env.OTA_PUBLIC_ORIGIN,
  };
  process.env.CICO_FIRMWARE_PUBLISH_TOKEN = "p".repeat(64);
  process.env.OTA_PUBLIC_ORIGIN = "https://cico.example";
  const sha256 = "a".repeat(64);
  const makeRequest = () => {
    const request = upload(image(), {
      authorization: `Bearer ${"p".repeat(64)}`,
      "content-type": "application/octet-stream",
      "x-firmware-sha256": sha256,
    });
    request.method = "POST";
    request.socket = { encrypted: true };
    return request;
  };
  let published = 0;
  const response = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  const common = {
    response,
    pathname: "/api/ci/v1/firmware-releases",
    parsedUrl: new URL(
      "https://cico.example/api/ci/v1/firmware-releases?version=2.4.1&buildId=20261002.ota-test&hardwareModel=CROWPANEL_7_V3&fileName=firmware.bin",
    ),
    service: {
      async publishRelease(metadata, artifact, userId) {
        published += 1;
        assert.equal(userId, null);
        assert.equal(metadata.version, "2.4.1");
        return { ...metadata, ...artifact };
      },
    },
    getContext: async () => {
      throw new Error("CI must not use a browser session");
    },
    limiter: { allow: () => true },
  };
  try {
    await handleOtaRoute({
      ...common,
      request: makeRequest(),
      storage: {
        save: async () => ({ storagePath: "artifact.bin", fileSize: 512, sha256 }),
        remove: async () => assert.fail("valid artifact must not be removed"),
      },
    });
    assert.equal(response.status, 201);
    assert.equal(published, 1);
    let removed = false;
    await assert.rejects(
      handleOtaRoute({
        ...common,
        request: makeRequest(),
        storage: {
          save: async () => ({ storagePath: "bad.bin", fileSize: 512, sha256: "b".repeat(64) }),
          remove: async () => {
            removed = true;
          },
        },
      }),
      { statusCode: 409 },
    );
    assert.equal(removed, true);
    assert.equal(published, 1);
  } finally {
    original.token === undefined
      ? delete process.env.CICO_FIRMWARE_PUBLISH_TOKEN
      : (process.env.CICO_FIRMWARE_PUBLISH_TOKEN = original.token);
    original.origin === undefined
      ? delete process.env.OTA_PUBLIC_ORIGIN
      : (process.env.OTA_PUBLIC_ORIGIN = original.origin);
  }
});
