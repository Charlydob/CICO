import test from "node:test";
import assert from "node:assert/strict";
import {
  STEINBOCK_CHECKOUT_ENDPOINT,
  DEFAULT_CHECKOUT_JSON_TEMPLATE,
  defaultsForCheckoutWebhook,
  validateCheckoutWebhookSettings,
  renderCheckoutWebhookPayload,
  buildCheckoutWebhookDelivery,
  buildRfidCheckoutWebhookDelivery,
  publicCheckoutWebhookSettings,
  processDueCheckoutWebhooks,
} from "./checkoutWebhookService.js";

const tenant = { slug: "gasthaus-steinbock", name: "Gasthaus Steinbock" };
const base = defaultsForCheckoutWebhook(tenant);

test("Steinbock gets the endpoint while unrelated hotels remain independent", () => {
  assert.equal(base.url, STEINBOCK_CHECKOUT_ENDPOINT);
  assert.equal(base.enabled, false);
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
  const delivery = buildCheckoutWebhookDelivery(validateCheckoutWebhookSettings({ ...base, enabled: true }),
    event, { number: "105" }, "ABCD1234", "box-1");
  assert.equal(delivery.tenantId, "tenant-a");
  assert.equal(delivery.checkoutEventId, "e-1");
  assert.equal(delivery.endpointUrl, STEINBOCK_CHECKOUT_ENDPOINT);
  assert.deepEqual(delivery.payload, { Key: "105", "Checkout at": "29.10.2026 09:57" });
  assert.equal(buildCheckoutWebhookDelivery({ ...base, enabled: false }, event, { number: "105" }, "", ""), null);
});

test("each authorized RFID read queues its own webhook with no checkout event or occupancy state", () => {
  const settings = validateCheckoutWebhookSettings({
    ...base, enabled: true, url: "https://checkin.baerenkiental.ch/checkout?token=example",
    authHeaderName: "Authorization", authHeaderValue: "Bearer example",
  });
  const at = new Date("2026-11-06T13:30:00.000Z");
  const first = buildRfidCheckoutWebhookDelivery(settings, {
    id: "reading-1", tenantId: "tenant-b", uid: "2E00B6D7B5", createdAt: at,
  }, "107", "checkoutbox-lab-01");
  const second = buildRfidCheckoutWebhookDelivery(settings, {
    id: "reading-2", tenantId: "tenant-b", uid: "2E00B6D7B5", createdAt: at,
  }, "107", "checkoutbox-lab-01");
  assert.equal(first.rfidReadingId, "reading-1");
  assert.equal(second.rfidReadingId, "reading-2");
  assert.equal(first.checkoutEventId, undefined);
  assert.deepEqual(first.payload, { "Key": "107", "Checkout at": "06.11.2026 14:30" });
  assert.deepEqual(second.payload, first.payload);
  assert.equal(first.authHeaderName, "Authorization");
  assert.equal(first.authHeaderValue, "Bearer example");
  assert.equal(buildRfidCheckoutWebhookDelivery({ ...settings, enabled: false }, {
    id: "reading-3", tenantId: "tenant-b", uid: "2E00B6D7B5", createdAt: at,
  }, "107", "box"), null);
  assert.equal(buildRfidCheckoutWebhookDelivery(settings, {
    id: "reading-4", tenantId: "tenant-b", uid: "2E00B6D7B5", createdAt: at,
  }, "", "box"), null);
});

test("TLS connection probe uses only DNS and TLS, with no HTTP request", async () => {
  const { probeCheckoutWebhookConnection } = await import("./checkoutWebhookService.js");
  const calls = [];
  const mockSocket = {
    authorized: true,
    once(event, callback) {
      if (event === "secureConnect") this.secureConnect = callback;
      return this;
    },
    getProtocol: () => "TLSv1.3",
    end: () => calls.push("socket-closed"),
    destroy: () => {},
  };
  const result = await probeCheckoutWebhookConnection(STEINBOCK_CHECKOUT_ENDPOINT, {
    resolveDns: (host, options, callback) => {
      calls.push("dns");
      callback(null, [{ address: "93.184.215.14", family: 4 }]);
    },
    connectTls: ({ host, port, servername }) => {
      calls.push("tls");
      assert.equal(host, "93.184.215.14");
      assert.equal(port, 443);
      assert.equal(servername, "checkin.gasthaus-steinbock.ch");
      queueMicrotask(() => mockSocket.secureConnect());
      return mockSocket;
    },
  });
  assert.deepEqual(result, { connected: true, dns: true, tls: true, protocol: "TLSv1.3" });
  assert.deepEqual(calls, ["dns", "tls", "socket-closed"]);
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

test("HTTP 404 ends this read after one attempt; the next RFID read can still enqueue a new POST", async () => {
  const delivery = {
    id: "d-404", rfidReadingId: "r-1", checkoutEventId: null,
    status: "PENDING", attempts: 0, nextAttemptAt: new Date(0), createdAt: new Date(0),
  };
  const prisma = { checkoutWebhookDelivery: {
    findMany: async () => delivery.status === "PENDING" ? [structuredClone(delivery)] : [],
    updateMany: async ({ data }) => { Object.assign(delivery, data); return { count: 1 }; },
  } };
  let calls = 0;
  await processDueCheckoutWebhooks(prisma, { send: async () => { calls++; return { ok: false, status: 404 }; } });
  await processDueCheckoutWebhooks(prisma, { send: async () => { calls++; return { ok: false, status: 404 }; } });
  assert.equal(calls, 1);
  assert.equal(delivery.status, "FAILED");
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.lastHttpStatus, 404);
});
