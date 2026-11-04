import { lookup } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { getTenantSettings } from "./tenantSettingsService.js";

export const STEINBOCK_CHECKOUT_ENDPOINT = "https://checkin.gasthaus-steinbock.ch/checkoutguest.php";
export const DEFAULT_CHECKOUT_JSON_TEMPLATE = '{\n  "Key": "{{key}}",\n  "Checkout at": "{{checkout_at}}"\n}';
const VARIABLES = new Set(["key", "room", "checkout_at", "checkout_at_iso", "rfid_uid", "device_id", "checkout_event_id"]);
const PLACEHOLDER = /{{\s*([a-z_]+)\s*}}/g;
const MAX_ATTEMPTS = 8;

export function defaultsForCheckoutWebhook(tenant) {
  const isSteinbock = /steinbock/i.test([tenant?.slug, tenant?.name].filter(Boolean).join(" "));
  return {
    enabled: false, // Never send real guest events until the hotel explicitly enables it.
    url: isSteinbock ? STEINBOCK_CHECKOUT_ENDPOINT : "",
    jsonTemplate: DEFAULT_CHECKOUT_JSON_TEMPLATE,
    timezone: "Europe/Zurich",
    authHeaderName: "",
    authHeaderValue: "",
  };
}

export function checkoutWebhookSettings(stored, tenant) {
  const defaults = defaultsForCheckoutWebhook(tenant);
  return { ...defaults, ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) };
}

export function publicCheckoutWebhookSettings(settings) {
  const { authHeaderValue, ...safe } = settings;
  return { ...safe, authConfigured: Boolean(authHeaderValue) };
}

function assertPublicHostname(hostname) {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") || isIP(hostname)) {
    throw Object.assign(new Error("Use a public HTTPS domain, not a local host or IP."), { statusCode: 400 });
  }
}

export function validateCheckoutWebhookSettings(input, current) {
  if (!input || Array.isArray(input) || typeof input !== "object") throw Object.assign(new Error("Invalid settings."), { statusCode: 400 });
  const enabled = input.enabled === true;
  const url = String(input.url ?? "").trim();
  const jsonTemplate = String(input.jsonTemplate ?? "").trim();
  const timezone = String(input.timezone ?? "Europe/Zurich").trim();
  const authHeaderName = String(input.authHeaderName ?? "").trim();
  const authHeaderValue = input.clearAuth === true ? "" :
    (typeof input.authHeaderValue === "string" && input.authHeaderValue.length ? input.authHeaderValue : current?.authHeaderValue || "");
  if (url.length > 2048 || (enabled && !url)) throw Object.assign(new Error("An HTTPS endpoint URL is required."), { statusCode: 400 });
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw Object.assign(new Error("Invalid URL."), { statusCode: 400 }); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.port) {
      throw Object.assign(new Error("Use a public HTTPS URL without credentials, fragments or custom ports."), { statusCode: 400 });
    }
    assertPublicHostname(parsed.hostname.toLowerCase());
  }
  if (!jsonTemplate || jsonTemplate.length > 8192) throw Object.assign(new Error("JSON template must be 1–8192 characters."), { statusCode: 400 });
  let parsedTemplate;
  try { parsedTemplate = JSON.parse(jsonTemplate); } catch { throw Object.assign(new Error("Template must be valid JSON."), { statusCode: 400 }); }
  if (!parsedTemplate || Array.isArray(parsedTemplate) || typeof parsedTemplate !== "object") {
    throw Object.assign(new Error("Template root must be a JSON object."), { statusCode: 400 });
  }
  const validateTokens = (value) => {
    if (typeof value === "string") {
      for (const token of value.matchAll(/{{\s*([^{}]+)\s*}}/g)) {
        if (!VARIABLES.has(token[1].trim())) throw Object.assign(new Error(`Unknown placeholder: ${token[1]}`), { statusCode: 400 });
      }
      if (value.includes("{{") && !/{{\s*([a-z_]+)\s*}}/.test(value)) throw Object.assign(new Error("Invalid placeholder."), { statusCode: 400 });
    } else if (Array.isArray(value)) value.forEach(validateTokens);
    else if (value && typeof value === "object") Object.values(value).forEach(validateTokens);
  };
  validateTokens(parsedTemplate);
  try { new Intl.DateTimeFormat("en-GB", { timeZone: timezone }); } catch { throw Object.assign(new Error("Invalid IANA timezone."), { statusCode: 400 }); }
  if (authHeaderName && !/^[A-Za-z0-9-]{1,64}$/.test(authHeaderName)) throw Object.assign(new Error("Invalid authorization header name."), { statusCode: 400 });
  if (authHeaderName && ["host", "content-length", "content-type", "connection", "idempotency-key"].includes(authHeaderName.toLowerCase())) {
    throw Object.assign(new Error("That header name is reserved."), { statusCode: 400 });
  }
  if (authHeaderValue.length > 2048 || /[\r\n]/.test(authHeaderValue)) throw Object.assign(new Error("Invalid authorization value."), { statusCode: 400 });
  if (authHeaderValue && !authHeaderName) throw Object.assign(new Error("Provide a header name for the authorization value."), { statusCode: 400 });
  return { enabled, url, jsonTemplate, timezone, authHeaderName, authHeaderValue };
}

function checkoutDate(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick("day")}.${pick("month")}.${pick("year")} ${pick("hour")}:${pick("minute")}`;
}

export function renderCheckoutWebhookPayload(settings, checkout) {
  const timestamp = new Date(checkout.timestamp);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Invalid checkout timestamp.");
  const vars = {
    key: String(checkout.key || checkout.room || ""),
    room: String(checkout.room || checkout.key || ""),
    checkout_at: checkoutDate(timestamp, settings.timezone),
    checkout_at_iso: timestamp.toISOString(),
    rfid_uid: String(checkout.uid || ""),
    device_id: String(checkout.deviceId || ""),
    checkout_event_id: String(checkout.eventId || ""),
  };
  const replace = (value) => {
    if (typeof value === "string") return value.replace(PLACEHOLDER, (_, name) => vars[name] ?? "");
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, replace(val)]));
    return value;
  };
  return replace(JSON.parse(settings.jsonTemplate));
}

export async function getCheckoutWebhookSettings(database, tenantId) {
  const [tenant, settings] = await Promise.all([
    database.getRecord("tenants", tenantId), getTenantSettings(database, tenantId),
  ]);
  return checkoutWebhookSettings(settings.integrations?.checkoutBoxWebhook, tenant);
}

export function buildCheckoutWebhookDelivery(settings, event, room, uid, deviceId) {
  if (!settings.enabled || !settings.url) return null;
  const payload = renderCheckoutWebhookPayload(settings, {
    timestamp: event.timestamp,
    eventId: event.id,
    key: room.number,
    room: room.number,
    uid, deviceId,
  });
  return {
    tenantId: event.tenantId, checkoutEventId: event.id, endpointUrl: settings.url,
    payload, authHeaderName: settings.authHeaderName || null,
    authHeaderValue: settings.authHeaderValue || null,
    status: "PENDING",
  };
}

function publicIp(address, family) {
  if (family === 4) {
    const [a,b,c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  const ip = address.toLowerCase();
  return family === 6 && /^[23][0-9a-f]{0,3}:/.test(ip) && !ip.startsWith("2001:db8:");
}

export async function sendCheckoutWebhook(delivery) {
  const url = new URL(delivery.endpointUrl);
  assertPublicHostname(url.hostname.toLowerCase());
  const body = JSON.stringify(delivery.payload);
  if (Buffer.byteLength(body) > 16384) throw new Error("Webhook payload exceeds 16 KiB.");
  return new Promise((resolve, reject) => {
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Idempotency-Key": delivery.checkoutEventId,
    };
    if (delivery.authHeaderName && delivery.authHeaderValue) headers[delivery.authHeaderName] = delivery.authHeaderValue;
    const req = httpsRequest(url, {
      method: "POST", headers, timeout: 8000,
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          const approved = addresses.find((entry) => publicIp(entry.address, entry.family));
          if (!approved) return callback(new Error("Endpoint resolves to a non-public IP."));
          callback(null, approved.address, approved.family);
        });
      },
    }, (response) => {
      response.resume(); // Never include the hotel's response body in logs.
      response.on("end", () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode }));
    });
    req.on("timeout", () => req.destroy(new Error("Webhook timeout.")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function processDueCheckoutWebhooks(prisma, { send = sendCheckoutWebhook, limit = 15 } = {}) {
  const now = new Date();
  const due = await prisma.checkoutWebhookDelivery.findMany({
    where: { status: { in: ["PENDING", "RETRY", "PROCESSING"] }, nextAttemptAt: { lte: now } },
    orderBy: { createdAt: "asc" }, take: limit,
  });
  for (const delivery of due) {
    const lease = await prisma.checkoutWebhookDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, nextAttemptAt: { lte: now } },
      data: { status: "PROCESSING", nextAttemptAt: new Date(Date.now() + 30_000) },
    });
    if (!lease.count) continue;
    let result, error;
    try { result = await send(delivery); } catch (cause) { error = cause; }
    const attempts = delivery.attempts + 1;
    const success = Boolean(result?.ok);
    const status = success ? "SUCCEEDED" : attempts >= MAX_ATTEMPTS ? "FAILED" : "RETRY";
    // Do not overwrite an in-progress delivery reclaimed by another worker.
    await prisma.checkoutWebhookDelivery.updateMany({
      where: { id: delivery.id, status: "PROCESSING", attempts: delivery.attempts },
      data: {
        status, attempts,
        nextAttemptAt: new Date(Date.now() + (success ? 0 : Math.min(3600, 2 ** attempts * 15) * 1000)),
        lastHttpStatus: result?.status || null,
        lastError: success ? null : String(error?.message || `HTTP ${result?.status || 0}`).slice(0, 300),
        ...(success ? { sentAt: new Date() } : {}),
      },
    });
  }
  return due.length;
}
