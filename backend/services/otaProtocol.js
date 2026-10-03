import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const HARDWARE = Object.freeze({
  CROWPANEL_7_V3: { otaSlotBytes: 1792 * 1024 },
  ESP32_DEVKIT_CHECKOUT_V1: { otaSlotBytes: 1792 * 1024 },
});
export const COMMANDS = Object.freeze([
  "OPEN_TRAP", "CLOSE_TRAP", "CYCLE_TRAP", "SET_SERVO_CONFIG",
  "CHECK_RFID", "RESTART", "CHECK_UPDATE",
]);
export const ACTIVE_STATES = [
  "PENDING",
  "DOWNLOADING",
  "VERIFYING",
  "INSTALLING",
  "REBOOTING",
  "HEALTH_CHECK",
];
export const TERMINAL_STATES = ["SUCCESS", "FAILED", "ROLLED_BACK"];
export const HEALTH_FLAGS = [
  "boot",
  "config",
  "display",
  "lvgl",
  "touch",
  "wifi_stack",
  "ready",
  "app_valid",
];
export const CHECKOUTBOX_HEALTH_FLAGS = [
  "boot", "config", "rfid_uart", "servo", "wifi_stack", "ready", "app_valid",
];
export function otaError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
export function textField(value, name, max = 128, optional = false) {
  if (optional && (value === undefined || value === null || value === ""))
    return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw otaError(`Invalid ${name}.`);
  }
  return value.trim();
}
export function uuid(value, name = "id") {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw otaError(`Invalid ${name}.`);
  return value;
}
export function hardwareSpec(model) {
  const spec = Object.hasOwn(HARDWARE, model) ? HARDWARE[model] : null;
  if (!spec) throw otaError("Unsupported hardware model.");
  return spec;
}
export function version(value) {
  const result = textField(value, "firmware version", 32);
  if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(result))
    throw otaError("Use a numeric major.minor.patch version.");
  return result;
}
export function compareVersions(a, b) {
  const left = version(a).split(".").map(Number),
    right = version(b).split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
export function validToken(token, hash) {
  return (
    typeof token === "string" &&
    /^[a-f0-9]{64}$/.test(token) &&
    typeof hash === "string" &&
    /^[a-f0-9]{64}$/.test(hash) &&
    timingSafeEqual(
      Buffer.from(hashToken(token), "hex"),
      Buffer.from(hash, "hex"),
    )
  );
}
export function publicDevice(device, now = Date.now()) {
  const { tokenHash, ...safe } = device;
  return {
    ...safe,
    credentialConfigured: Boolean(tokenHash && !device.credentialRevokedAt),
    status: device.credentialRevokedAt
      ? "REVOKED"
      : device.lastSeenAt &&
          now - new Date(device.lastSeenAt).getTime() < 90_000
        ? "ONLINE"
        : "OFFLINE",
  };
}
export function validateReleaseMetadata(input) {
  const hardwareModel = textField(input.hardwareModel, "hardware model");
  hardwareSpec(hardwareModel);
  const fileName = textField(input.fileName, "file name", 128);
  if (!/^[\w. -]+\.bin$/i.test(fileName) || fileName.includes(".."))
    throw otaError("Upload an application .bin file.");
  return {
    version: version(input.version),
    buildId: textField(input.buildId, "build ID"),
    hardwareModel,
    fileName,
    releaseNotes:
      textField(input.releaseNotes, "release notes", 8000, true) || "",
  };
}
function int(value, name, min = 0, max = 2147483647) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw otaError(`Invalid ${name}.`);
  return value;
}
export function heartbeatPatch(body, device) {
  if (
    body.device_id !== device.deviceId ||
    body.hardware_model !== device.hardwareModel
  )
    throw otaError("Device identity/hardware mismatch.", 409);
  const ip = textField(body.local_ip, "local IP", 45, true);
  if (ip && !isIP(ip)) throw otaError("Invalid local IP.");
  // Explicit allowlist: Wi-Fi credentials and arbitrary diagnostics never enter the database.
  const result = textField(body.last_ota_result, "OTA result", 64, true);
  if (result && !/^[A-Z0-9_]+$/.test(result))
    throw otaError("OTA result must be a diagnostic code.");
  const checkout = {};
  if (device.hardwareModel === "ESP32_DEVKIT_CHECKOUT_V1") {
    const lastRfid = textField(body.last_rfid, "last RFID", 64, true);
    const lastRfidRaw = textField(body.last_rfid_raw, "last RFID raw frame", 128, true);
    const trapState = textField(body.trap_state, "trap state", 16, true);
    if (lastRfid && !/^[A-Fa-f0-9]+$/.test(lastRfid)) throw otaError("Invalid RFID value.");
    if (lastRfidRaw && !/^[A-Fa-f0-9]+$/.test(lastRfidRaw)) throw otaError("Invalid RFID raw frame.");
    if (trapState && !["OPEN", "CLOSED"].includes(trapState)) throw otaError("Invalid trap state.");
    Object.assign(checkout, { lastRfid, lastRfidRaw, trapState });
  }
  return {
    currentFirmwareVersion: version(body.firmware_version),
    currentBuildId: textField(body.build_id, "build ID"),
    configVersion: textField(body.config_version, "config version", 128, true),
    uptime: int(body.uptime, "uptime"),
    lastRssi: int(body.rssi, "RSSI", -127, 0),
    lastIp: ip,
    freeHeap: int(body.free_heap, "free heap"),
    psram: int(body.psram, "PSRAM"),
    lastResetReason: textField(body.last_reset_reason, "reset reason", 64),
    ...(result ? { lastOtaResult: result } : {}),
    lastSeenAt: new Date(),
    status: "ONLINE",
    ...checkout,
  };
}
export function servoConfiguration(input, versionValue = null) {
  const closedAngle = int(input.closedAngle, "closed angle", 0, 180);
  const openAngle = int(input.openAngle, "open angle", 0, 180);
  const holdMs = int(input.holdMs, "hold milliseconds", 100, 30000);

  if (closedAngle === openAngle)
    throw otaError("Open and closed angles must differ.");

  const allowedRfids =
    input.allowedRfids === undefined ? [] : input.allowedRfids;

  if (
    !Array.isArray(allowedRfids) ||
    allowedRfids.length > 500 ||
    allowedRfids.some(
      (value) =>
        typeof value !== "string" ||
        !/^[A-Fa-f0-9]{1,64}$/.test(value),
    )
  )
    throw otaError("Invalid RFID allowlist.");

  return {
    closedAngle,
    openAngle,
    holdMs,
    allowedRfids: [
      ...new Set(allowedRfids.map((value) => value.toUpperCase())),
    ],
    ...(versionValue ? { version: versionValue } : {}),
  };
}

export function commandPayload(type, payload) {
  if (!COMMANDS.includes(type))
    throw otaError(
      "Unknown command. START_UPDATE requires a release.",
    );

  if (type === "SET_SERVO_CONFIG")
    return servoConfiguration(payload || {});

  if (
    payload !== undefined &&
    (payload === null ||
      Array.isArray(payload) ||
      typeof payload !== "object")
  )
    throw otaError("Command payload must be an object.");

  return payload || {};
}

export function deviceEvents(body) {
  if (
    !Array.isArray(body.events) ||
    body.events.length < 1 ||
    body.events.length > 50
  )
    throw otaError("Provide 1 to 50 events.");

  return body.events.map((event) => ({
    type: textField(event.type, "event type", 64),
    detail: textField(event.detail, "event detail", 512, true),
    uptimeMs: int(event.uptime_ms ?? 0, "event uptime", 0),
  }));
}

export function heartbeatTargetTransition(update, body) {
  const targetMatches =
    body.firmware_version === update?.release?.version &&
    body.build_id === update?.release?.buildId;

  if (!update || !targetMatches) return null;
  if (update.status === "REBOOTING") return "HEALTH_CHECK";
  if (update.status === "HEALTH_CHECK") return "SUCCESS";

  return null;
}

export function validateStatusReport(update, body) {
  const state = body.status;
  if (![...ACTIVE_STATES, ...TERMINAL_STATES].includes(state))
    throw otaError("Unknown OTA status.");
  const progress = int(body.progress ?? 0, "progress", 0, 100);
  if (TERMINAL_STATES.includes(update.status)) {
    if (state !== update.status) {
      // A pre-2.4.6 device may have received a successful HEALTH_CHECK response,
      // sent SUCCESS, and then lost the SUCCESS response before persisting its
      // local phase. On reboot/retry it sends HEALTH_CHECK again forever. The
      // server already has the stronger terminal result, so acknowledging this
      // one stale precursor is safe and lets that client advance to an
      // idempotent SUCCESS retry.
      if (update.status === "SUCCESS" && state === "HEALTH_CHECK")
        return { duplicate: true, recoveredStalePrecursor: true };
      throw otaError("OTA result is already final.", 409);
    }
    return { duplicate: true };
  }
  if (
    state === "PENDING" ||
    (ACTIVE_STATES.includes(state) &&
      ACTIVE_STATES.indexOf(state) < ACTIVE_STATES.indexOf(update.status))
  ) {
    throw otaError("OTA state cannot move backwards.", 409);
  }
  if (state === update.status && progress < update.progress)
    throw otaError("OTA progress cannot move backwards.", 409);
  const resultCode = textField(body.result_code, "result code", 64, true);
  if (resultCode && !/^[A-Z0-9_]+$/.test(resultCode))
    throw otaError("Use a diagnostic code, never a URL or secret.");
  if (state === "SUCCESS") {
    const requiredHealth = update.release.hardwareModel === "ESP32_DEVKIT_CHECKOUT_V1"
      ? CHECKOUTBOX_HEALTH_FLAGS : HEALTH_FLAGS;
    if (
      body.firmware_version !== update.release.version ||
      body.build_id !== update.release.buildId ||
      !requiredHealth.every((flag) => body.health_check?.[flag] === true)
    )
      throw otaError(
        "SUCCESS requires matching version/build and a confirmed health check.",
        409,
      );
  }
  if (state === "ROLLED_BACK") {
    if (
      !update.previousVersion ||
      !update.previousBuildId ||
      body.firmware_version !== update.previousVersion ||
      body.build_id !== update.previousBuildId ||
      body.rolled_back !== true
    )
      throw otaError(
        "Rollback requires the previous firmware and boot rollback evidence.",
        409,
      );
  }
  return {
    status: state,
    progress: state === "SUCCESS" ? 100 : progress,
    resultCode,
    ...(TERMINAL_STATES.includes(state) ? { completedAt: new Date() } : {}),
  };
}
