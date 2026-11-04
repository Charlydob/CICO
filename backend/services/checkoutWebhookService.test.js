import test from "node:test";
import assert from "node:assert/strict";
import {
  STEINBOCK_CHECKOUT_ENDPOINT,
  DEFAULT_CHECKOUT_JSON_TEMPLATE,
  defaultsForCheckoutWebhook,
  validateCheckoutWebhookSettings,
  renderCheckoutWebhookPayload,
  buildCheckoutWebhookDelivery,
  publicCheckoutWebhookSettings,
  processDueCheckoutWebhooks,
} from "./checkoutWebhookService.js";

const tenant = { slug: "gasthaus-steinbock", name: "Gasthaus Steinbock" };
const base = defaultsForCheckoutWebhook(tenant);

test("Steinbock gets the endpoint while unrelated hotels remain independent", () => {
  assert.equal(base.url, STEINBOCK_CHECKOUT_ENDPOINT);
  assert.equal(base.enabled, true);
  assert.equal(defaultsForCheckoutWebhook({ slug: "hotel-two" }).url, "");
  assert.equal(defaultsForCheckoutWebhook({ slug: "hotel-two" }).enabled, false);
});

test("JSON preview renders key and Swiss checkout time from the actual event", () => {
  const settings = validateCheckoutWebhookSettings(base);
  const payload = renderCheckoutWebhookPayload(settings, {
    key: "105", room: "105", uid: "2E00B6D7B5", deviceId: "box-1",
    eventId: "event-1", timestamp: "2026-10-29T08:57:00.000Z",
  });
  assert.deepEqual(payload, { Key: "105", "Checkout at": "29.10.2026 09:57" });
  assert.equal(settings.jsonTemplate, DEFAULT_CHECKOUT_JSON_TEMPLATE);
});

test("template variables are escaped as JSON and secret does not appear in settings response", () => {
  const settings = validateCheckoutWebhookSettings({
    ...base,
    jsonTemplate: '{"key":"{{key}}","meta":{"uid":"{{rfid_uid}}"}}',
    authHeaderName: "X-API-Key",
    authHeaderValue: "secret-value",
  });
  assert.deepEqual(renderCheckoutWebhookPayload(settings, {
    key: '105"\\break', room: "105", uid: "ABCD1234", timestamp: "2026-10-29T08:57:00Z",
  }), { key: '105"\\break', meta: { uid: "ABCD1234" } });
  assert.equal(JSON.stringify(publicCheckoutWebhookSettings(settings)).includes("secret-value"), false);
});

test("invalid or unsafe URLs and non-JSON bodies are rejected", () => {
  assert.throws(() => validateCheckoutWebhookSettings({ ...base, url: "http://hotel.test/api" }), /HTTPS/);
  assert.throws(() => validateCheckoutWebhookSettings({ ...base, url: "https://127.0.0.1/checkout" }), /public HTTPS/);
  assert.throws(() => validateCheckoutWebhookSettings({ ...base, jsonTemplate: "Key: {{key}}" }), /valid JSON/);
  assert.throws(() => validateCheckoutWebhookSettings({ ...base, jsonTemplate: '{"unused":"{{not_allowed}}"}' }), /Unknown placeholder/);
});

test("one checkout produces a delivery only if integration is enabled", () => {
  const event = { id: "e-1", tenantId: "tenant-a", timestamp: "2026-10-29T08:57:00Z" };
  const delivery = buildCheckoutWebhookDelivery(validateCheckoutWebhookSettings(base),
    event, { number: "105" }, "ABCD1234", "box-1");
  assert.equal(delivery.tenantId, "tenant-a");
  assert.equal(delivery.checkoutEventId, "e-1");
  assert.equal(delivery.endpointUrl, STEINBOCK_CHECKOUT_ENDPOINT);
  assert.deepEqual(delivery.payload, { Key: "105", "Checkout at": "29.10.2026 09:57" });
  assert.equal(buildCheckoutWebhookDelivery({ ...base, enabled: false }, event, { number: "105" }, "", ""), null);
});

test("outbox marks a successful POST and records the HTTP status", async () => {
  const delivery = {
    id: "d-1", checkoutEventId: "e-1", status: "PENDING", attempts: 0,
    nextAttemptAt: new Date(0), createdAt: new Date(0),
  };
  const prisma = { checkoutWebhookDelivery: {
    findMany: async () => [structuredClone(delivery)],
    updateMany: async ({ where, data }) => {
      if (where.status !== delivery.status || (where.attempts !== undefined && where.attempts !== delivery.attempts)) return { count: 0 };
      Object.assign(delivery, data); return { count: 1 };
    },
  } };
  let sent = 0;
  await processDueCheckoutWebhooks(prisma, { send: async () => { sent++; return { ok: true, status: 200 }; } });
  assert.equal(sent, 1);
  assert.equal(delivery.status, "SUCCEEDED");
  assert.equal(delivery.lastHttpStatus, 200);
  assert.equal(delivery.attempts, 1);
  assert.ok(delivery.sentAt instanceof Date);
});

test("outbox schedules a retry after a failed POST", async () => {
  const delivery = {
    id: "d-2", checkoutEventId: "e-2", status: "PENDING", attempts: 0,
    nextAttemptAt: new Date(0), createdAt: new Date(0),
  };
  const prisma = { checkoutWebhookDelivery: {
    findMany: async () => [structuredClone(delivery)],
    updateMany: async ({ data }) => { Object.assign(delivery, data); return { count: 1 }; },
  } };
  await processDueCheckoutWebhooks(prisma, { send: async () => ({ ok: false, status: 503 }) });
  assert.equal(delivery.status, "RETRY");
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.lastHttpStatus, 503);
  assert.ok(delivery.nextAttemptAt.getTime() > Date.now());
});
