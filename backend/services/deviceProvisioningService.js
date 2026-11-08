import { createHmac, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { hardwareSpec, hashToken, otaError, publicDevice, textField, uuid, version } from "./otaProtocol.js";

const DELIVERY_WINDOW_MS = 15 * 60_000;

function equalHex(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function normalizedMac(value) {
  const result = textField(value, "hardware MAC", 17).replace(/[:-]/g, "").toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(result)) throw otaError("Invalid hardware MAC.");
  return result;
}
function universalIdentity(value, mac) {
  const deviceId = textField(value, "device ID", 64).toLowerCase();
  if (!/^(checkoutbox|hookbox)-[a-f0-9]{12}$/.test(deviceId) || !deviceId.endsWith(mac))
    throw otaError("Device ID must be derived from the hardware MAC.", 409);
  return deviceId;
}
function bootstrap(value) {
  const result = textField(value, "bootstrap token", 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw otaError("Invalid bootstrap token.");
  return result;
}
function pairingCode(value) {
  const result = textField(value, "pairing code", 8);
  if (!/^\d{8}$/.test(result)) throw otaError("Pairing code must contain 8 digits.");
  return result;
}
function publicDiscovery(record) {
  const { pairingCodeHash, bootstrapTokenHash, ...safe } = record;
  return safe;
}

export function createDeviceProvisioningService(prisma, options = {}) {
  const masterKey = options.masterKey ?? process.env.PROVISIONING_MASTER_KEY ?? "";
  const publicOrigin = options.publicOrigin ?? process.env.OTA_PUBLIC_ORIGIN ?? process.env.APP_ORIGIN ?? "";
  function configured() {
    let https = false;
    try { https = new URL(publicOrigin).protocol === "https:"; } catch { https = false; }
    if (!/^[a-f0-9]{64}$/i.test(masterKey) || !https)
      throw otaError("Automatic device provisioning is not configured.", 503);
  }
  function credential(discovery) {
    configured();
    return createHmac("sha256", Buffer.from(masterKey, "hex"))
      .update(`credential:${discovery.deviceId}:${discovery.bootstrapTokenHash}`)
      .digest("hex");
  }
  async function authenticateBootstrap(input) {
    configured();
    const deviceId = textField(input.device_id, "device ID", 64).toLowerCase();
    const token = bootstrap(input.bootstrap_token);
    const discovery = await prisma.deviceDiscovery.findUnique({ where: { deviceId } });
    if (!discovery || !equalHex(hashToken(token), discovery.bootstrapTokenHash))
      throw otaError("Bootstrap authentication required.", 401);
    return discovery;
  }
  return {
    async discover(input) {
      configured();
      const mac = normalizedMac(input.mac);
      const deviceId = universalIdentity(input.device_id, mac);
      const hardwareModel = textField(input.hardware_model, "hardware model");
      hardwareSpec(hardwareModel);
      const firmwareVersion = version(input.firmware_version);
      const buildId = textField(input.build_id, "build ID");
      const token = bootstrap(input.bootstrap_token);
      const code = pairingCode(input.pairing_code);
      if (await prisma.device.findFirst({ where: { OR: [{ deviceId }, { hardwareUid: mac }] } }))
        throw otaError("This hardware is already registered.", 409);
      const existing = await prisma.deviceDiscovery.findUnique({ where: { deviceId } });
      if (existing && !equalHex(hashToken(token), existing.bootstrapTokenHash))
        throw otaError("Discovery identity is already bound to different hardware credentials.", 409);
      const data = {
        deviceId, hardwareModel, hardwareUid: mac, firmwareVersion, buildId,
        pairingCodeHash: await argon2.hash(`${deviceId}:${code}`, { type: argon2.argon2id }),
        bootstrapTokenHash: hashToken(token), lastSeenAt: new Date(),
      };
      const record = existing
        ? await prisma.deviceDiscovery.update({ where: { id: existing.id }, data })
        : await prisma.deviceDiscovery.create({ data });
      return { status: record.status, discovery_id: record.id };
    },
    async status(input) {
      const discovery = await authenticateBootstrap(input);
      if (discovery.status !== "APPROVED") return { status: "PENDING" };
      if (discovery.credentialDeliveredAt &&
          Date.now() - new Date(discovery.credentialDeliveredAt).getTime() > DELIVERY_WINDOW_MS)
        throw otaError("Credential delivery window expired; ask an administrator to restart pairing.", 409);
      const device = await prisma.device.findUnique({ where: { id: discovery.approvedDeviceId } });
      const token = credential(discovery);
      if (!device || device.credentialRevokedAt || !equalHex(hashToken(token), device.tokenHash))
        throw otaError("Approved device credential is unavailable.", 409);
      if (!discovery.credentialDeliveredAt)
        await prisma.deviceDiscovery.update({
          where: { id: discovery.id }, data: { credentialDeliveredAt: new Date() },
        });
      return {
        status: "APPROVED", device_id: discovery.deviceId,
        api_base: publicOrigin.replace(/\/$/, ""), token,
        credential_version: device.credentialVersion,
      };
    },
    async list() {
      configured();
      return (await prisma.deviceDiscovery.findMany({
        orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }],
      })).map(publicDiscovery);
    },
    async approve(id, input, approvedBy) {
      configured(); uuid(id, "discovery ID"); uuid(approvedBy, "approving user ID");
      const code = pairingCode(input.pairingCode);
      const name = textField(input.name, "device name");
      const tenantId = input.tenantId ? uuid(input.tenantId, "tenant ID") : null;
      return prisma.$transaction(async (tx) => {
        const discovery = await tx.deviceDiscovery.findUnique({ where: { id } });
        if (!discovery) throw otaError("Device discovery not found.", 404);
        if (!(await argon2.verify(discovery.pairingCodeHash, `${discovery.deviceId}:${code}`)))
          throw otaError("Incorrect physical pairing code.", 403);
        if (tenantId && !(await tx.tenant.findUnique({ where: { id: tenantId } })))
          throw otaError("Tenant not found.", 404);
        if (discovery.status === "APPROVED") {
          const existing = await tx.device.findUnique({ where: { id: discovery.approvedDeviceId } });
          if (!existing) throw otaError("Approved device record is missing.", 409);
          return publicDevice(existing);
        }
        const token = credential(discovery);
        let device;
        try {
          device = await tx.device.create({ data: {
            deviceId: discovery.deviceId, hardwareModel: discovery.hardwareModel,
            hardwareUid: discovery.hardwareUid, name, tenantId,
            tokenHash: hashToken(token), credentialVersion: 1,
            credentialRotatedAt: new Date(), status: "OFFLINE",
          }});
        } catch (error) {
          if (error.code === "P2002") throw otaError("Device identity is already registered.", 409);
          throw error;
        }
        await tx.deviceDiscovery.update({ where: { id }, data: {
          status: "APPROVED", approvedDeviceId: device.id,
          approvedAt: new Date(), approvedBy,
        }});
        return publicDevice(device);
      });
    },
  };
}
