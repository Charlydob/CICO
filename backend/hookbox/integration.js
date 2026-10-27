import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getTenantSettings, updateTenantSettings } from "../services/tenantSettingsService.js";

const SOURCES = new Set(["room", "checkin_at", "stay_unit_id", "request_id", "last_name", "reservation_code", "constant"]);
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const bad = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
export const webhookPath = (deviceId) => "/api/integrations/hookbox/devices/" + deviceId + "/webhook";
export const defaultOutbound = () => ({
  enabled: false,
  endpoint: "",
  method: "POST",
  dateFormat: "DD.MM.YYYY HH:mm",
  fields: [
    { key: "key", source: "room", value: "" },
    { key: "check-in at", source: "checkin_at", value: "" },
    { key: "request_id", source: "request_id", value: "" },
  ],
});
function normalizeOutbound(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fields = source.fields === undefined ? defaultOutbound().fields : source.fields;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 20) bad("Define entre 1 y 20 campos JSON.");
  const seen = new Set();
  const normalized = fields.map((field) => {
    const key = String(field?.key || "").trim();
    const from = String(field?.source || "");
    const value = String(field?.value || "");
    if (!/^[A-Za-z0-9 _-]{1,64}$/.test(key) || key === "__proto__" || seen.has(key)) bad("Nombre de campo JSON inválido o repetido.");
    if (!SOURCES.has(from) || value.length > 256) bad("Origen de valor JSON inválido.");
    seen.add(key);
    return { key, source: from, value: from === "constant" ? value : "" };
  });
  const endpoint = String(source.endpoint || "").trim();
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { bad("La URL del hotel no es válida."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname || url.port && url.port !== "443")
      bad("Utiliza una URL HTTPS sin usuario, contraseña, fragmento ni puerto alternativo.");
    if (/^(localhost|.*\.localhost|.*\.local|127\..*|10\..*|192\.168\..*|169\.254\..*|0\.0\.0\.0|\[.*\])$/i.test(url.hostname))
      bad("La URL debe apuntar a un servidor público HTTPS.");
  }
  const dateFormat = String(source.dateFormat || "DD.MM.YYYY HH:mm");
  if (!["DD.MM.YYYY HH:mm", "YYYY-MM-DD HH:mm:ss", "ISO8601"].includes(dateFormat)) bad("Formato de fecha no compatible.");
  if (source.enabled && !endpoint) bad("Indica el endpoint antes de activar la integración.");
  return { enabled: source.enabled === true, endpoint, method: "POST", dateFormat, fields: normalized };
}
function values(outbound, input) {
  const iso = new Date(input.checkin_at || "2026-10-28T14:28:00+01:00");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(iso).map(p => [p.type, p.value]));
  const checkinAt = outbound.dateFormat === "ISO8601"
    ? iso.toISOString()
    : outbound.dateFormat === "YYYY-MM-DD HH:mm:ss"
      ? [parts.year, parts.month, parts.day].join("-") + " " + [parts.hour, parts.minute, parts.second].join(":")
      : [parts.day, parts.month, parts.year].join(".") + " " + [parts.hour, parts.minute].join(":");
  return {
    room: String(input.room || ""), checkin_at: checkinAt,
    stay_unit_id: String(input.stay_unit_id || ""), request_id: String(input.request_id || ""),
    last_name: String(input.last_name || ""), reservation_code: String(input.reservation_code || ""),
  };
}
export function buildOutboundPreview(outbound, input = {}) {
  const config = normalizeOutbound({ ...outbound, enabled: false });
  const context = values(config, {
    room: "109", checkin_at: "2026-10-28T14:28:00+01:00",
    stay_unit_id: "ABC123", request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    last_name: "García", reservation_code: "R12345",
    ...input,
  });
  return Object.fromEntries(config.fields.map((f) => [f.key, f.source === "constant" ? f.value : context[f.source]]));
}
async function own(database, tenantId, deviceId) {
  if (!ID.test(deviceId)) bad("Dispositivo inválido.");
  const d = await database.prisma.device.findFirst({
    where: { id: deviceId, tenantId, hardwareModel: "CROWPANEL_7_V3" },
    select: { id: true, tenantId: true, tokenHash: true, credentialRevokedAt: true },
  });
  if (!d) bad("Dispositivo no encontrado en este hotel.", 404);
  return d;
}
const saved = async (database, tenantId, deviceId) => {
  const settings = await getTenantSettings(database, tenantId);
  return settings.integrations?.hookboxDeviceContracts?.[deviceId] || {};
};
async function put(database, tenantId, deviceId, config) {
  const settings = await getTenantSettings(database, tenantId);
  await updateTenantSettings(database, tenantId, {
    integrations: {
      ...settings.integrations,
      hookboxDeviceContracts: {
        ...settings.integrations?.hookboxDeviceContracts,
        [deviceId]: config,
      },
    },
  });
}
function publicConfig(deviceId, config) {
  const outbound = normalizeOutbound(config.outbound || defaultOutbound());
  return {
    outbound, webhookUrlPath: webhookPath(deviceId),
    webhookEnabled: Boolean(config.secretHash),
    preview: buildOutboundPreview(outbound),
    note: "El webhook sólo autoriza una operación CICO activa; la máquina inicia la entrega por su flujo habitual.",
  };
}
export async function getDeviceIntegration(database, tenantId, deviceId) {
  await own(database, tenantId, deviceId);
  return publicConfig(deviceId, await saved(database, tenantId, deviceId));
}
export async function saveDeviceIntegration(database, tenantId, deviceId, body) {
  await own(database, tenantId, deviceId);
  const existing = await saved(database, tenantId, deviceId);
  await put(database, tenantId, deviceId, {
    ...existing, outbound: normalizeOutbound(body?.outbound),
  });
  return getDeviceIntegration(database, tenantId, deviceId);
}
export async function rotateDeviceWebhookSecret(database, tenantId, deviceId) {
  await own(database, tenantId, deviceId);
  const token = randomBytes(32).toString("hex");
  const existing = await saved(database, tenantId, deviceId);
  await put(database, tenantId, deviceId, {
    ...existing, secretHash: createHash("sha256").update(token).digest("hex"),
  });
  return { ...await getDeviceIntegration(database, tenantId, deviceId), webhookSecret: token };
}
export async function receiveDeviceWebhook({ database, deviceId, token, payload, service }) {
  if (!ID.test(deviceId)) bad("Not found", 404);
  const device = await database.prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true, tenantId: true, hardwareModel: true, tokenHash: true, credentialRevokedAt: true },
  });
  if (!device?.tenantId || device.hardwareModel !== "CROWPANEL_7_V3" || !device.tokenHash || device.credentialRevokedAt)
    bad("Not found", 404);
  const config = await saved(database, device.tenantId, device.id);
  if (!config.secretHash || !/^[a-f0-9]{64}$/i.test(config.secretHash)) bad("Webhook unavailable", 403);
  const actual = createHash("sha256").update(typeof token === "string" ? token : "").digest();
  const expected = Buffer.from(config.secretHash, "hex");
  if (!timingSafeEqual(actual, expected)) bad("Unauthorized", 401);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) bad("Invalid JSON");
  const requestId = String(payload.request_id || "").trim();
  const room = String(payload.room || "").trim();
  const stayUnitId = String(payload.stay_unit_id || "").trim();
  if (payload.action !== "release" || !ID.test(requestId) ||
      !/^[A-Za-z0-9_-]{1,16}$/.test(room) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(stayUnitId))
    bad("Expected action, request_id, room and stay_unit_id");
  return service.authorizeFromWebhook(device, {
    request_id: requestId, room, stay_unit_id: stayUnitId,
  });
}
