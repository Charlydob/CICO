import { randomBytes } from "node:crypto";
import {
  ACTIVE_STATES,
  TERMINAL_STATES,
  hashToken,
  validToken,
  publicDevice,
  hardwareSpec,
  textField,
  uuid,
  compareVersions,
  heartbeatPatch,
  validateStatusReport,
  otaError,
  commandPayload,
  servoConfiguration,
  deviceEvents,
} from "./otaProtocol.js";

// Persisted requests/events are shared by every backend replica; device operations serialize in PostgreSQL.
async function lockDevice(tx, id, authenticated) {
  await tx.$queryRaw`WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${`ota:${id}`}))) SELECT 1::int FROM lock`;
  const device = await tx.device.findUnique({ where: { id } });
  if (!device) throw otaError("Device not found.", 404);
  if (
    authenticated &&
    (device.credentialRevokedAt ||
      !device.tokenHash ||
      device.tokenHash !== authenticated.tokenHash)
  ) {
    throw otaError("Device authentication required.", 401);
  }
  return device;
}
async function activeUpdate(tx, deviceId) {
  return tx.otaRequest.findFirst({
    where: { deviceId, status: { in: ACTIVE_STATES } },
    include: { release: true },
    orderBy: { createdAt: "desc" },
  });
}
function publicUpdate(update) {
  if (!update) return null;
  const { release, ...rest } = update;
  return {
    ...rest,
    ...(release ? { release: publicRelease(release) } : {}),
    stalled:
      ACTIVE_STATES.includes(update.status) &&
      Date.now() - new Date(update.updatedAt).getTime() > 10 * 60_000,
  };
}
export function publicRelease(release) {
  const { storagePath, ...safe } = release;
  return safe;
}
export function createOtaService(prisma, storage) {
  async function withDevice(id, fn, authenticated) {
    return prisma.$transaction(
      async (tx) => fn(tx, await lockDevice(tx, id, authenticated)),
      { timeout: 15_000 },
    );
  }
  return {
    async listDevices() {
      const devices = await prisma.device.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          updates: {
            take: 1,
            orderBy: { createdAt: "desc" },
            include: { release: true },
          },
        },
      });
      return devices.map(({ updates, ...device }) => ({
        ...publicDevice(device),
        latestUpdate: publicUpdate(updates[0]),
      }));
    },
    async getDevice(id) {
      uuid(id);
      const device = await prisma.device.findUnique({
        where: { id },
        include: {
          updates: {
            take: 20,
            orderBy: { createdAt: "desc" },
            include: {
              release: true,
              events: { take: 100, orderBy: { createdAt: "desc" } },
            },
          },
          commands: { take: 20, orderBy: { createdAt: "desc" } },
          events: { take: 100, orderBy: { createdAt: "desc" } },
          tenant: { select: { name: true, id: true } },
        },
      });
      if (!device) throw otaError("Device not found.", 404);
      const { updates, ...rest } = device;
      return { ...publicDevice(rest), updates: updates.map(publicUpdate) };
    },
    async createDevice(input) {
      const deviceId = textField(input.deviceId, "device ID", 64);
      if (!/^[A-Za-z0-9_-]+$/.test(deviceId))
        throw otaError("Invalid device ID.");
      const hardwareModel = textField(input.hardwareModel, "hardware model");
      hardwareSpec(hardwareModel);
      const tenantId = input.tenantId
        ? uuid(input.tenantId, "tenant ID")
        : null;
      if (
        tenantId &&
        !(await prisma.tenant.findUnique({ where: { id: tenantId } }))
      )
        throw otaError("Tenant not found.", 404);
      try {
        return publicDevice(
          await prisma.device.create({
            data: {
              deviceId,
              hardwareModel,
              tenantId,
              name: textField(input.name, "device name"),
            },
          }),
        );
      } catch (error) {
        if (error.code === "P2002")
          throw otaError("Device ID is already registered.", 409);
        throw error;
      }
    },
    async rotateCredential(id) {
      uuid(id);
      return withDevice(id, async (tx, device) => {
        const token = randomBytes(32).toString("hex");
        await tx.device.update({
          where: { id },
          data: {
            tokenHash: hashToken(token),
            credentialVersion: { increment: 1 },
            credentialRotatedAt: new Date(),
            credentialRevokedAt: null,
          },
        });
        return {
          device_id: device.deviceId,
          token,
          credential_version: device.credentialVersion + 1,
        };
      });
    },
    async revokeCredential(id) {
      uuid(id);
      return withDevice(id, async (tx) =>
        publicDevice(
          await tx.device.update({
            where: { id },
            data: { tokenHash: null, credentialRevokedAt: new Date() },
          }),
        ),
      );
    },
    async authenticate(request) {
      const deviceId = request.headers["x-device-id"],
        authorization = request.headers.authorization;
      if (
        typeof deviceId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId) ||
        typeof authorization !== "string" ||
        !/^Bearer [a-f0-9]{64}$/.test(authorization)
      ) {
        throw otaError("Device authentication required.", 401);
      }
      const device = await prisma.device.findUnique({ where: { deviceId } });
      if (
        !device ||
        device.credentialRevokedAt ||
        !validToken(authorization.slice(7), device.tokenHash)
      )
        throw otaError("Device authentication required.", 401);
      return device;
    },
    async heartbeat(device, body) {
      const patch = heartbeatPatch(body, device);
      return withDevice(
        device.id,
        async (tx) => {
          await tx.device.update({ where: { id: device.id }, data: patch });
          return { accepted: true, server_time: new Date().toISOString() };
        },
        device,
      );
    },
    async listReleases() {
      return (
        await prisma.firmwareRelease.findMany({
          where: { status: "PUBLISHED" },
          orderBy: { createdAt: "desc" },
        })
      ).map(publicRelease);
    },
    async publishRelease(metadata, artifact, userId) {
      try {
        return publicRelease(
          await prisma.firmwareRelease.create({
            data: { ...metadata, ...artifact, createdBy: userId },
          }),
        );
      } catch (error) {
        await storage.remove(artifact.storagePath);
        if (error.code === "P2002")
          throw otaError(
            "Release already exists; published releases are immutable.",
            409,
          );
        throw error;
      }
    },
    async deleteRelease(id) {
      uuid(id);
      const key = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM firmware_releases WHERE id = ${id}::uuid FOR UPDATE`;
        const release = await tx.firmwareRelease.findUnique({ where: { id } });
        if (!release) throw otaError("Release not found.", 404);
        if (await tx.otaRequest.count({ where: { releaseId: id } }))
          throw otaError(
            "Release has update history and cannot be deleted.",
            409,
          );
        await tx.firmwareRelease.update({
          where: { id },
          data: { status: "DELETED" },
        });
        return release.storagePath;
      });
      await storage.remove(key);
      return { deleted: true };
    },
    async assignUpdate(id, releaseId, requestedBy) {
      uuid(id);
      uuid(releaseId, "release ID");
      return prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM firmware_releases WHERE id = ${releaseId}::uuid FOR UPDATE`;
          const device = await lockDevice(tx, id);
          const release = await tx.firmwareRelease.findUnique({
            where: { id: releaseId },
          });
          if (!release || release.status !== "PUBLISHED")
            throw otaError("Published release not found.", 404);
          if (!device.tokenHash || device.credentialRevokedAt)
            throw otaError(
              "Provision device credentials before updating.",
              409,
            );
          if (release.hardwareModel !== device.hardwareModel)
            throw otaError("Firmware hardware is incompatible.", 409);
          if (
            release.fileSize > hardwareSpec(device.hardwareModel).otaSlotBytes
          )
            throw otaError("Firmware exceeds OTA slot.", 409);
          if (!device.currentFirmwareVersion || !device.currentBuildId)
            throw otaError(
              "A device heartbeat is required before updating.",
              409,
            );
          if (
            compareVersions(release.version, device.currentFirmwareVersion) <= 0
          )
            throw otaError("Select a newer firmware version.", 409);
          if (await activeUpdate(tx, id))
            throw otaError("Device already has an active update.", 409);
          if (
            await tx.deviceCommand.count({
              where: {
                deviceId: id,
                status: "PENDING",
                expiresAt: { gt: new Date() },
              },
            })
          )
            throw otaError("Wait for the pending device command.", 409);
          await storage.get(release);
          const update = await tx.otaRequest.create({
            data: {
              deviceId: id,
              releaseId,
              requestedBy,
              previousVersion: device.currentFirmwareVersion,
              previousBuildId: device.currentBuildId,
              events: { create: { status: "PENDING", progress: 0 } },
            },
            include: { release: true },
          });
          await tx.device.update({
            where: { id },
            data: {
              targetFirmwareVersion: release.version,
              lastOtaStatus: "PENDING",
              lastOtaResult: null,
            },
          });
          return publicUpdate(update);
        },
        { timeout: 15_000 },
      );
    },
    async poll(device) {
      return withDevice(
        device.id,
        async (tx, current) => {
          const update = await activeUpdate(tx, current.id);
          const command = update
            ? null
            : await tx.deviceCommand.findFirst({
                where: {
                  deviceId: current.id,
                  status: "PENDING",
                  expiresAt: { gt: new Date() },
                },
                orderBy: { createdAt: "asc" },
              });
          return {
            protocol_version: 1,
            poll_after_seconds: 20,
            command: command
              ? {
                  id: command.id,
                  type: command.type,
                  payload: command.payload,
                  expires_at: command.expiresAt,
                }
              : null,
            configuration:
              current.hardwareModel === "ESP32_DEVKIT_CHECKOUT_V1" &&
              current.desiredConfig?.version &&
              current.desiredConfig.version !== current.configVersion
                ? current.desiredConfig
                : null,
            update: update
              ? {
                  request_id: update.id,
                  status: update.status,
                  version: update.release.version,
                  build_id: update.release.buildId,
                  hardware_model: update.release.hardwareModel,
                  file_size: update.release.fileSize,
                  sha256: update.release.sha256,
                  signature: update.release.signature,
                  download_path: `/api/device/v1/updates/${update.id}/firmware`,
                }
              : null,
          };
        },
        device,
      );
    },
    async report(device, body) {
      const id = uuid(body.request_id, "request ID");
      return withDevice(
        device.id,
        async (tx, current) => {
          const update = await tx.otaRequest.findUnique({
            where: { id },
            include: { release: true },
          });
          if (!update || update.deviceId !== current.id)
            throw otaError("Update not found.", 404);
          const patch = validateStatusReport(update, body);
          if (patch.duplicate) return { accepted: true, duplicate: true };
          await tx.otaRequest.update({ where: { id }, data: patch });
          await tx.otaEvent.create({
            data: {
              requestId: id,
              status: patch.status,
              progress: patch.progress,
              resultCode: patch.resultCode,
            },
          });
          await tx.device.update({
            where: { id: current.id },
            data: {
              lastOtaStatus: patch.status,
              lastOtaResult: patch.resultCode || patch.status,
              ...(TERMINAL_STATES.includes(patch.status)
                ? { targetFirmwareVersion: null }
                : {}),
              ...(["SUCCESS", "ROLLED_BACK"].includes(patch.status)
                ? {
                    currentFirmwareVersion: body.firmware_version,
                    currentBuildId: body.build_id,
                  }
                : {}),
              lastSeenAt: new Date(),
              status: "ONLINE",
            },
          });
          return { accepted: true, status: patch.status };
        },
        device,
      );
    },
    async downloadForDevice(device, requestId) {
      uuid(requestId, "request ID");
      return withDevice(
        device.id,
        async (tx) => {
          const update = await tx.otaRequest.findUnique({
            where: { id: requestId },
            include: { release: true },
          });
          if (
            !update ||
            update.deviceId !== device.id ||
            !ACTIVE_STATES.includes(update.status) ||
            update.release.hardwareModel !== device.hardwareModel
          )
            throw otaError("Firmware download is not authorized.", 403);
          return {
            release: update.release,
            file: await storage.get(update.release),
          };
        },
        device,
      );
    },
    async downloadForAdmin(releaseId) {
      uuid(releaseId, "release ID");
      const release = await prisma.firmwareRelease.findUnique({
        where: { id: releaseId },
      });
      if (!release || release.status !== "PUBLISHED")
        throw otaError("Release not found.", 404);
      return { release, file: await storage.get(release) };
    },
    async command(id, type, payload, requestedBy) {
      uuid(id);
      if (requestedBy === undefined) { requestedBy = payload; payload = {}; }
      const validatedPayload = commandPayload(type, payload);
      return withDevice(id, async (tx, device) => {
        if (!device.tokenHash || device.credentialRevokedAt)
          throw otaError("Device is not provisioned.", 409);
        if (await activeUpdate(tx, id))
          throw otaError("Commands are disabled during OTA.", 409);
        if (
          await tx.deviceCommand.count({
            where: {
              deviceId: id,
              status: "PENDING",
              expiresAt: { gt: new Date() },
            },
          })
        )
          throw otaError("Device already has a pending command.", 409);
        return tx.deviceCommand.create({
          data: {
            deviceId: id,
            type,
            payload: validatedPayload,
            requestedBy,
            expiresAt: new Date(Date.now() + 5 * 60_000),
          },
        });
      });
    },
    async acknowledgeCommand(device, body) {
      const id = uuid(body.command_id, "command ID");
      const result = body.result === undefined ? null : {
        ok: body.ok === true,
        value: textField(body.result, "command result", 512, true),
      };
      return withDevice(
        device.id,
        async (tx) => {
          const command = await tx.deviceCommand.findUnique({ where: { id } });
          if (!command || command.deviceId !== device.id)
            throw otaError("Command not found.", 404);
          if (command.status === "ACKNOWLEDGED")
            return { accepted: true, duplicate: true };
          if (new Date(command.expiresAt) <= new Date())
            throw otaError("Command expired.", 409);
          await tx.deviceCommand.update({
            where: { id },
            data: { status: "ACKNOWLEDGED", completedAt: new Date(), result },
          });
          return { accepted: true };
        },
        device,
      );
    },
    async updateConfiguration(id, input) {
      uuid(id);
      const version = String(Date.now());
      const config = servoConfiguration(input, version);
      return withDevice(id, async (tx, device) => {
        if (device.hardwareModel !== "ESP32_DEVKIT_CHECKOUT_V1")
          throw otaError("Servo configuration is only available for CheckoutBox hardware.", 409);
        await tx.device.update({ where: { id }, data: { desiredConfig: config } });
        return config;
      });
    },
    async ingestEvents(device, body) {
      const events = deviceEvents(body);
      await prisma.deviceEvent.createMany({
        data: events.map((event) => ({ ...event, deviceId: device.id })),
      });
      return { accepted: true, count: events.length };
    },
  };
}
