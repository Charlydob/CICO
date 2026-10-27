import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildOutboundPreview, getDeviceIntegration, saveDeviceIntegration,
  rotateDeviceWebhookSecret, receiveDeviceWebhook, webhookPath,
} from "./integration.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
function fakeDatabase() {
  let settings = null;
  const device = { id: deviceId, tenantId, hardwareModel: "CROWPANEL_7_V3", tokenHash: "old", credentialRevokedAt: null };
  return {
    prisma: { device: {
      findFirst: async ({ where }) => where.id === deviceId && where.tenantId === tenantId ? device : null,
      findUnique: async ({ where }) => where.id === deviceId ? device : null,
    }},
    getRecord: async (collection, key) => collection === "tenantSettings" && key === tenantId ? settings : null,
    setRecord: async (_collection, _key, value) => { settings = value; return value; },
    stored: () => settings,
  };
}
test("default JSON template is editable and uses a real Europe/Zurich time", () => {
  const sample = buildOutboundPreview({
    fields: [
      { key: "key", source: "room" },
      { key: "check-in at", source: "checkin_at" },
      { key: "literal", source: "constant", value: "ok" },
    ],
  });
  assert.deepEqual(sample, { key: "109", "check-in at": "28.10.2026 14:28", literal: "ok" });
  assert.equal(webhookPath(deviceId), "/api/integrations/hookbox/devices/" + deviceId + "/webhook");
});
test("per-device admin config saves without contacting hotel, validates unsafe values", async () => {
  const db = fakeDatabase();
  const initial = await getDeviceIntegration(db, tenantId, deviceId);
  assert.equal(initial.outbound.enabled, false);
  assert.equal(initial.webhookEnabled, false);
  const changed = await saveDeviceIntegration(db, tenantId, deviceId, { outbound: {
    ...initial.outbound,
    endpoint: "https://checkin.example.com/checkinguest.php",
    enabled: true,
  } });
  assert.equal(changed.outbound.endpoint, "https://checkin.example.com/checkinguest.php");
  assert.equal(changed.outbound.fields[0].key, "key");
  await assert.rejects(saveDeviceIntegration(db, tenantId, deviceId, { outbound: {
    ...initial.outbound, endpoint: "http://localhost:3333/release", enabled: true,
  } }), /HTTPS/);
  await assert.rejects(saveDeviceIntegration(db, tenantId, deviceId, { outbound: {
    ...initial.outbound, fields: [
      { key: "key", source: "room" }, { key: "key", source: "room" },
    ],
  } }), /repetido/);
});
test("webhook denies unauthenticated or mismatched calls; uses only a correlated pending operation", async () => {
  const db = fakeDatabase();
  const rotated = await rotateDeviceWebhookSecret(db, tenantId, deviceId);
  assert.match(rotated.webhookSecret, /^[0-9a-f]{64}$/);
  assert.equal(db.stored().integrations.hookboxDeviceContracts[deviceId].secretHash,
    createHash("sha256").update(rotated.webhookSecret).digest("hex"));
  assert.equal(JSON.stringify(db.stored()).includes(rotated.webhookSecret), false);
  const payload = {
    action: "release", request_id: operationId, room: "109", stay_unit_id: "ABC123",
  };
  let calls = 0;
  const service = { authorizeFromWebhook: async (_device, input) => {
    calls++;
    assert.deepEqual(input, payload); return { status: "AUTHORIZED", duplicate: false };
  }};
  const incoming = { database: db, deviceId, payload, service };
  await assert.rejects(receiveDeviceWebhook({ ...incoming, token: "wrong" }), /Unauthorized/);
  await assert.rejects(receiveDeviceWebhook({ ...incoming, token: rotated.webhookSecret, payload: { ...payload, request_id: "invalid" } }), /Expected/);
  assert.equal(calls, 0);
  assert.equal((await receiveDeviceWebhook({ ...incoming, token: rotated.webhookSecret })).status, "AUTHORIZED");
  assert.equal(calls, 1);
});
