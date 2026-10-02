import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const HARDWARE = Object.freeze({
  CROWPANEL_7_V3: { otaSlotBytes: 1792 * 1024 },
});
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
  };
}
export function heartbeatConfirmsActiveSuccess(update, body) {
  const targetMatches =
    body.firmware_version === update?.release?.version &&
    body.build_id === update?.release?.buildId;
  return Boolean(
    update &&
      ["REBOOTING", "HEALTH_CHECK"].includes(update.status) &&
      targetMatches &&
      (update.status === "HEALTH_CHECK" || body.last_ota_result === "SUCCESS"),
  );
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
    if (
      body.firmware_version !== update.release.version ||
      body.build_id !== update.release.buildId ||
      !HEALTH_FLAGS.every((flag) => body.health_check?.[flag] === true)
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
