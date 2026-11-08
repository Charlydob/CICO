import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createDeviceProvisioningService } from "./deviceProvisioningService.js";
import { hashToken } from "./otaProtocol.js";

function fakePrisma() {
  const legacy = {
    id: randomUUID(), deviceId: "checkoutbox-lab-01", hardwareUid: null,
    hardwareModel: "ESP32_DEVKIT_CHECKOUT_V1", name: "Checkout Box 1",
    tenantId: randomUUID(), tokenHash: hashToken("a".repeat(64)),
    credentialVersion: 7, credentialRevokedAt: null,
  };
  const state = { discoveries: [], devices: [legacy], tenants: [] };
  const prisma = {
    deviceDiscovery: {
      findUnique: async ({ where }) => state.discoveries.find((item) =>
        (where.id && item.id === where.id) || (where.deviceId && item.deviceId === where.deviceId)) || null,
      findMany: async () => [...state.discoveries],
      create: async ({ data }) => {
        const item = { id: randomUUID(), status: "PENDING", approvedDeviceId: null,
          firstSeenAt: new Date(), approvedAt: null, credentialDeliveredAt: null, approvedBy: null, ...data };
        state.discoveries.push(item); return item;
      },
      update: async ({ where, data }) => {
        const item = state.discoveries.find((entry) => entry.id === where.id);
        Object.assign(item, data); return item;
      },
    },
    device: {
      findFirst: async ({ where }) => state.devices.find((item) => where.OR.some((clause) =>
        (clause.deviceId && item.deviceId === clause.deviceId) ||
        (clause.hardwareUid && item.hardwareUid === clause.hardwareUid))) || null,
      findUnique: async ({ where }) => state.devices.find((item) =>
        (where.id && item.id === where.id) || (where.deviceId && item.deviceId === where.deviceId)) || null,
      create: async ({ data }) => {
        const item = { id: randomUUID(), credentialRevokedAt: null, lastSeenAt: null,
          createdAt: new Date(), updatedAt: new Date(), ...data };
        state.devices.push(item); return item;
      },
    },
    tenant: { findUnique: async ({ where }) => state.tenants.find((item) => item.id === where.id) || null },
    $transaction: async (callback) => callback(prisma),
  };
  return { prisma, state, legacySnapshot: structuredClone(legacy) };
}

test("universal discovery requires physical proof and leaves Checkout Box 1 intact", async () => {
  const { prisma, state, legacySnapshot } = fakePrisma();
  const service = createDeviceProvisioningService(prisma, {
    masterKey: "11".repeat(32), publicOrigin: "https://cico.example.test",
  });
  const bootstrap = "22".repeat(32);
  const discovery = await service.discover({
    device_id: "checkoutbox-6cc8404e0790", hardware_model: "ESP32_DEVKIT_CHECKOUT_V1",
    mac: "6C:C8:40:4E:07:90", firmware_version: "1.4.0",
    build_id: "20261108.universal-provisioning", bootstrap_token: bootstrap,
    pairing_code: "12345678",
  });
  assert.equal(discovery.status, "PENDING");
  assert.equal(state.devices.length, 1, "discovery must not create an active device");
  const visible = await service.list();
  assert.equal(visible[0].deviceId, "checkoutbox-6cc8404e0790");
  assert.equal("pairingCodeHash" in visible[0], false);
  assert.equal("bootstrapTokenHash" in visible[0], false);

  await assert.rejects(
    service.approve(discovery.discovery_id, { pairingCode: "00000000", name: "Checkout Box 2", tenantId: null }, randomUUID()),
    (error) => error.statusCode === 403,
  );
  const approved = await service.approve(
    discovery.discovery_id,
    { pairingCode: "12345678", name: "Checkout Box 2", tenantId: null },
    randomUUID(),
  );
  assert.equal(approved.deviceId, "checkoutbox-6cc8404e0790");
  assert.equal(approved.hardwareUid, "6cc8404e0790");
  assert.equal(state.devices.length, 2);

  await assert.rejects(
    service.status({ device_id: approved.deviceId, bootstrap_token: "33".repeat(32) }),
    (error) => error.statusCode === 401,
  );
  const credentials = await service.status({ device_id: approved.deviceId, bootstrap_token: bootstrap });
  assert.equal(credentials.status, "APPROVED");
  assert.match(credentials.token, /^[a-f0-9]{64}$/);
  assert.equal(state.devices[1].tokenHash, hashToken(credentials.token));
  assert.deepEqual(state.devices[0], legacySnapshot, "legacy Checkout Box 1 must remain untouched");
});

test("spoofed identity that does not match the MAC is rejected", async () => {
  const { prisma } = fakePrisma();
  const service = createDeviceProvisioningService(prisma, {
    masterKey: "11".repeat(32), publicOrigin: "https://cico.example.test",
  });
  await assert.rejects(service.discover({
    device_id: "checkoutbox-000000000000", hardware_model: "ESP32_DEVKIT_CHECKOUT_V1",
    mac: "6C:C8:40:4E:07:90", firmware_version: "1.4.0", build_id: "test",
    bootstrap_token: "22".repeat(32), pairing_code: "12345678",
  }), (error) => error.statusCode === 409);
});
