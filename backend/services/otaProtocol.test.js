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
  heartbeatTargetTransition,
  validateStatusReport,
  validateReleaseMetadata,
  hardwareSpec,
  commandPayload,
  commandPayloadForHardware,
  servoConfiguration,
  deviceEvents,
} from "./otaProtocol.js";
import { createFirmwareStorage } from "./firmwareStorage.js";
import { requireOtaTransport } from "../routes/otaRoutes.js";

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
test("CheckoutBox hardware, servo commands and telemetry are strictly validated", () => {
  assert.equal(hardwareSpec("ESP32_DEVKIT_CHECKOUT_V1").otaSlotBytes, 1792 * 1024);
  assert.deepEqual(commandPayload("OPEN_TRAP"), {});
  assert.deepEqual(commandPayloadForHardware("ESP32_DEVKIT_CHECKOUT_V1", "SERVO_RAW_PWM_TEST"), {});
  assert.deepEqual(commandPayloadForHardware("ESP32_DEVKIT_CHECKOUT_V1", "SERVO_RAW_PIN25_TEST"), {});
  assert.deepEqual(commandPayloadForHardware("ESP32_DEVKIT_CHECKOUT_V1","SERVO_DIAG_START",{durationSec:60}),{durationSec:60});
  assert.deepEqual(commandPayloadForHardware("ESP32_DEVKIT_CHECKOUT_V1","SERVO_DIAG_STOP"),{});
  assert.throws(() => commandPayloadForHardware("CROWPANEL_7_V3", "SERVO_RAW_PWM_TEST"));
  assert.throws(() => commandPayloadForHardware("CROWPANEL_7_V3", "SERVO_RAW_PIN25_TEST"));
  assert.throws(()=>commandPayloadForHardware("CROWPANEL_7_V3","SERVO_DIAG_START",{durationSec:60}));
  for(const durationSec of [9,11,121])
    assert.throws(()=>commandPayload("SERVO_DIAG_START",{durationSec}));
  assert.deepEqual(commandPayload("SET_SERVO_CONFIG", { closedAngle: 10, openAngle: 95, holdMs: 1200 }), {
    closedAngle: 10, openAngle: 95, holdMs: 1200, allowedRfids: [],
  });
  assert.deepEqual(commandPayload("SET_SERVO_CONFIG", {
    closedAngle: 10, openAngle: 95, holdMs: 1200, allowedRfids: ["aabbccdd"],
  }).allowedRfids, ["AABBCCDD"]);
  assert.throws(() => commandPayload("SET_SERVO_CONFIG", {
    closedAngle: 10, openAngle: 95, holdMs: 1200, allowedRfids: ["AABBCCDDEEFF"],
  }));
  assert.throws(() => commandPayload("SET_SERVO_CONFIG", {
    closedAngle: 10, openAngle: 95, holdMs: 1200, allowedRfids: ["AABBCCD"],
  }));
  assert.throws(()=>servoConfiguration({closedAngle:5,openAngle:95,holdMs:1200}));
  assert.throws(() => servoConfiguration({ closedAngle: 90, openAngle: 90, holdMs: 1000 }));
  assert.throws(() => commandPayload("DESTROY"));
  assert.equal(deviceEvents({ events: [{ type: "RFID_READ", detail: "AABBCCDD", uptime_ms: 12 }] })[0].uptimeMs, 12);
  const checkoutDevice = { deviceId: "checkoutbox-lab-01", hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1" };
  const patch = heartbeatPatch({ ...heartbeat(), device_id: checkoutDevice.deviceId,
    hardware_model: checkoutDevice.hardwareModel, last_rfid: "AABBCCDD",
    last_rfid_raw: "020902AABBCCDD0003", trap_state: "CLOSED",
    servo_diag_state:"RUNNING",servo_diag_remaining_s:42 }, checkoutDevice);
  assert.equal(patch.lastRfid, "AABBCCDD");
  assert.equal(patch.servoDiagnosticState,"RUNNING");
  assert.equal(patch.servoDiagnosticRemaining,42);
  assert.throws(()=>heartbeatPatch({...heartbeat(),device_id:checkoutDevice.deviceId,
    hardware_model:checkoutDevice.hardwareModel,servo_diag_state:"COMPLETED",
    servo_diag_remaining_s:1},checkoutDevice));
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
  const checkoutSuccess = {
    ...success,
    health_check: Object.fromEntries(["boot", "config", "rfid_uart", "servo", "wifi_stack", "ready", "app_valid"].map((flag) => [flag, true])),
  };
  assert.equal(validateStatusReport({ ...update, release: { ...update.release, hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1" } }, checkoutSuccess).progress, 100);
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
  assert.deepEqual(
    validateStatusReport(
      { ...update, status: "SUCCESS" },
      { status: "HEALTH_CHECK", progress: 95 },
    ),
    { duplicate: true, recoveredStalePrecursor: true },
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

test("authenticated heartbeat advances an exact target one post-reboot state at a time", () => {
  const active = {
    status: "REBOOTING",
    release: { version: "2.4.6", buildId: "build-final" },
  };
  const exact = {
    firmware_version: "2.4.6",
    build_id: "build-final",
  };
  assert.equal(heartbeatTargetTransition(active, exact), "HEALTH_CHECK");
  assert.equal(
    heartbeatTargetTransition(active, { ...exact, build_id: "wrong" }),
    null,
  );
  assert.equal(
    heartbeatTargetTransition(
      { ...active, status: "HEALTH_CHECK" },
      exact,
    ),
    "SUCCESS",
  );
  assert.equal(
    heartbeatTargetTransition(
      { ...active, status: "HEALTH_CHECK" },
      { ...exact, firmware_version: "2.4.7" },
    ),
    null,
  );
  assert.equal(
    heartbeatTargetTransition({ ...active, status: "DOWNLOADING" }, exact),
    null,
  );
  assert.equal(
    heartbeatTargetTransition({ ...active, status: "SUCCESS" }, exact),
    null,
  );
});

test("pending SUCCESS after heartbeat reconciliation remains idempotent", () => {
  const success = {
    status: "SUCCESS",
    firmware_version: "2.4.1",
    build_id: update.release.buildId,
    health_check: Object.fromEntries(HEALTH_FLAGS.map((flag) => [flag, true])),
  };
  assert.deepEqual(validateStatusReport({ ...update, status: "SUCCESS" }, success), {
    duplicate: true,
  });
});
