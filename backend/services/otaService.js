import { randomBytes } from "node:crypto";
import { sendRfidReturnPush } from "./webPushService.js";
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
  heartbeatTargetTransition,
  validateStatusReport,
  otaError,
  commandPayloadForHardware,
  servoConfiguration,
  deviceEvents,
} from "./otaProtocol.js";

function rfidUid(value) {
  const uid=textField(value,"RFID UID",10).toUpperCase();
  if(!/^(?:[A-F0-9]{8}|[A-F0-9]{10})$/.test(uid))
    throw otaError("RFID UID must be exactly 8 or 10 hexadecimal characters.");
  return uid;
}

async function rebuildDesiredConfiguration(tx,device) {
  const keys=await tx.deviceRfidKey.findMany({
    where:{deviceId:device.id,authorized:true,active:true},
    orderBy:{uid:"asc"},select:{uid:true},
  });
  if(keys.length>128) throw otaError("A device can authorize at most 128 RFID keys.",409);
  const version=String(Date.now());
  const config=servoConfiguration({
    closedAngle:device.desiredConfig?.closedAngle??10,
    openAngle:device.desiredConfig?.openAngle??90,
    holdMs:device.desiredConfig?.holdMs??1500,
    duplicateRfidMs:device.desiredConfig?.duplicateRfidMs,
    activationCooldownMs:device.desiredConfig?.activationCooldownMs,
    motionStepMs:device.desiredConfig?.motionStepMs,
    heartbeatSec:device.desiredConfig?.heartbeatSec,
    pollSec:device.desiredConfig?.pollSec,
    diagnosticEnabled:device.desiredConfig?.diagnosticEnabled,
    diagnosticTimeoutSec:device.desiredConfig?.diagnosticTimeoutSec,
    startupBehavior:device.desiredConfig?.startupBehavior,
    disconnectBehavior:device.desiredConfig?.disconnectBehavior,
    allowedRfids:keys.map((key)=>key.uid),
  },version);
  await tx.device.update({where:{id:device.id},data:{desiredConfig:config,configRejectedReason:null}});
  return config;
}

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
function publicUpdate(update, device) {
  if (!update) return null;
  const { release, ...rest } = update;
  const versionMatches = Boolean(
    device?.currentFirmwareVersion &&
      release?.version === device.currentFirmwareVersion,
  );
  const buildMatches = Boolean(
    device?.currentBuildId && release?.buildId === device.currentBuildId,
  );
  return {
    ...rest,
    ...(release ? { release: publicRelease(release) } : {}),
    stalled:
      ACTIVE_STATES.includes(update.status) &&
      Date.now() - new Date(update.updatedAt).getTime() > 10 * 60_000,
    reconciliation: device
      ? {
          installedVersion: device.currentFirmwareVersion,
          installedBuild: device.currentBuildId,
          versionMatches,
          buildMatches,
          state:
            versionMatches && buildMatches
              ? "INSTALLED_MATCHES_RELEASE"
              : versionMatches
                ? "INSTALLED_BUILD_MISMATCH"
                : "INSTALLED_VERSION_DIFFERS",
        }
      : undefined,
  };
}
export function publicRelease(release) {
  const { storagePath, ...safe } = release;
  return safe;
}
export function createOtaService(prisma, storage, { database } = {}) {
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
        latestUpdate: publicUpdate(updates[0], device),
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
          rfidKeys: { take: 128, orderBy: [{ lastSeenAt: "desc" }, { updatedAt: "desc" }] },
          rfidReadings: { take: 25, orderBy: { createdAt: "desc" } },
          tenantAssignments: { take: 10, orderBy: { createdAt: "desc" } },
          tenant: { select: { name: true, id: true } },
        },
      });
      if (!device) throw otaError("Device not found.", 404);
      const { updates, ...rest } = device;
      const [rfidReadings, commands, otaUpdates] = await Promise.all([
        prisma.deviceRfidReading.count({ where: { deviceId: id } }),
        prisma.deviceCommand.count({ where: { deviceId: id } }),
        prisma.otaRequest.count({ where: { deviceId: id } }),
      ]);
      return {
        ...publicDevice(rest),
        updates: updates.map((update) => publicUpdate(update, device)),
        historyTotals: { rfidReadings, commands, otaUpdates },
      };
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
    async assignTenant(id, tenantIdInput, assignedBy) {
      uuid(id);
      uuid(assignedBy, "assigning user ID");
      const tenantId = tenantIdInput ? uuid(tenantIdInput, "tenant ID") : null;
      return withDevice(id, async (tx, device) => {
        const [fromTenant, toTenant] = await Promise.all([
          device.tenantId
            ? tx.tenant.findUnique({ where: { id: device.tenantId } })
            : null,
          tenantId ? tx.tenant.findUnique({ where: { id: tenantId } }) : null,
        ]);
        if (tenantId && !toTenant) throw otaError("Tenant not found.", 404);
        if (device.tenantId === tenantId)
          return publicDevice({ ...device, tenant: toTenant });
        await tx.deviceTenantAssignment.create({
          data: {
            deviceId: id,
            fromTenantId: device.tenantId,
            fromTenantName: fromTenant?.name || "",
            toTenantId: tenantId,
            toTenantName: toTenant?.name || "",
            assignedBy,
          },
        });
        return publicDevice(
          await tx.device.update({
            where: { id },
            data: { tenantId },
            include: { tenant: { select: { id: true, name: true } } },
          }),
        );
      });
    },
    async listRfidReadings(id, input = {}) {
      uuid(id);
      const page = Math.max(1, Math.min(100000, Number(input.page) || 1));
      const pageSize = Math.max(1, Math.min(100, Number(input.pageSize) || 25));
      const where = { deviceId: id };
      if (input.room) where.room = { contains: textField(input.room, "room filter", 64), mode: "insensitive" };
      if (input.uid) where.uid = { contains: textField(input.uid, "UID filter", 10).toUpperCase() };
      if (input.result) where.result = textField(input.result, "result filter", 64);
      const createdAt = {};
      if (input.from) {
        const from = new Date(input.from);
        if (!Number.isFinite(from.getTime())) throw otaError("Invalid from date.");
        createdAt.gte = from;
      }
      if (input.to) {
        const to = new Date(input.to);
        if (!Number.isFinite(to.getTime())) throw otaError("Invalid to date.");
        createdAt.lte = to;
      }
      if (Object.keys(createdAt).length) where.createdAt = createdAt;
      const [items, total] = await Promise.all([
        prisma.deviceRfidReading.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.deviceRfidReading.count({ where }),
      ]);
      return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
    },
    async listHistory(id, input = {}) {
      uuid(id);
      const kind = input.kind === "updates" ? "updates" : "commands";
      const page = Math.max(1, Math.min(100000, Number(input.page) || 1));
      const pageSize = Math.max(1, Math.min(50, Number(input.pageSize) || 20));
      const where = { deviceId: id };
      const model = kind === "updates" ? prisma.otaRequest : prisma.deviceCommand;
      const [items, total] = await Promise.all([
        model.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
          ...(kind === "updates"
            ? { include: { release: true, events: { orderBy: { createdAt: "desc" } } } }
            : {}),
        }),
        model.count({ where }),
      ]);
      return {
        items: kind === "updates" ? items.map((item) => publicUpdate(item)) : items,
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize),
      };
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
        async (tx, current) => {
          const active = await activeUpdate(tx, device.id);
          const targetTransition = heartbeatTargetTransition(active, body);
          const installedBuildMismatch = Boolean(
            active &&
              ["REBOOTING", "HEALTH_CHECK"].includes(active.status) &&
              body.firmware_version === active.release.version &&
              body.build_id !== active.release.buildId,
          );
          // A device can retain an OTA phase in NVS after an administrator
          // cancels its request. Keep the audited cancellation result as the
          // server source of truth while the device clears that stale phase.
          if (!active && current.lastOtaStatus === "CANCELLED")
            delete patch.lastOtaResult;
          if (targetTransition) {
            const completedAt =
              targetTransition === "SUCCESS" ? new Date() : undefined;
            const progress = targetTransition === "SUCCESS" ? 100 : 95;
            await tx.otaRequest.update({
              where: { id: active.id },
              data: { status: targetTransition, progress, completedAt },
            });
            await tx.otaEvent.create({
              data: { requestId: active.id, status: targetTransition, progress },
            });
          } else if (installedBuildMismatch) {
            await tx.otaRequest.update({
              where: { id: active.id },
              data: {
                status: "FAILED",
                resultCode: "INSTALLED_BUILD_MISMATCH",
                completedAt: new Date(),
              },
            });
            await tx.otaEvent.create({
              data: {
                requestId: active.id,
                status: "FAILED",
                progress: active.progress,
                resultCode: "INSTALLED_BUILD_MISMATCH",
              },
            });
          }
          await tx.device.update({
            where: { id: device.id },
            data: {
              ...patch,
              ...(patch.configChecksum &&
              patch.configChecksum === current.desiredConfig?.checksum &&
              patch.authorizedRfidCount === (current.desiredConfig?.allowedRfids?.length ?? 0)
                ? { appliedConfig: current.desiredConfig, configAppliedAt: new Date(), configRejectedReason: null }
                : {}),
              ...(targetTransition
                ? {
                    lastOtaStatus: targetTransition,
                    ...(targetTransition === "SUCCESS"
                      ? {
                          lastOtaResult: "SUCCESS",
                          targetFirmwareVersion: null,
                        }
                      : {}),
                  }
                : {}),
              ...(installedBuildMismatch
                ? {
                    lastOtaStatus: "FAILED",
                    lastOtaResult: "INSTALLED_BUILD_MISMATCH",
                    targetFirmwareVersion: null,
                  }
                : {}),
            },
          });
          return {
            accepted: true,
            server_time: new Date().toISOString(),
            ...(targetTransition === "HEALTH_CHECK"
              ? { ota_health_check: true }
              : {}),
            ...(targetTransition === "SUCCESS"
              ? { ota_reconciled: true }
              : {}),
            ...(installedBuildMismatch
              ? { ota_reconciliation_error: "INSTALLED_BUILD_MISMATCH" }
              : {}),
          };
        },
        device,
      );
    },
    async listReleases() {
      return (
        await prisma.firmwareRelease.findMany({
          where: { status: { in:["DRAFT","PUBLISHED"] } },
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
    async publishDraft(id) {
      uuid(id);
      try {
        return publicRelease(await prisma.firmwareRelease.update({
          where:{id,status:"DRAFT"},data:{status:"PUBLISHED"},
        }));
      } catch(error) {
        if(error.code==="P2025") throw otaError("Draft release not found.",404);
        throw error;
      }
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
          if (device.servoDiagnosticState === "RUNNING")
            throw otaError("Stop the servo diagnostic before starting OTA.",409);
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
    async cancelUpdate(deviceId, requestId, cancelledBy) {
      uuid(deviceId, "device ID");
      uuid(requestId, "request ID");
      uuid(cancelledBy, "cancelling user ID");
      return withDevice(deviceId, async (tx, device) => {
        const update = await tx.otaRequest.findUnique({
          where: { id: requestId },
          include: { release: true },
        });
        if (!update || update.deviceId !== device.id)
          throw otaError("Update not found.", 404);
        if (update.status === "CANCELLED") return publicUpdate(update);
        if (!ACTIVE_STATES.includes(update.status))
          throw otaError("Only an active update can be cancelled.", 409);
        const cancelledAt = new Date();
        const cancelled = await tx.otaRequest.update({
          where: { id: requestId },
          data: {
            status: "CANCELLED",
            resultCode: "ADMIN_CANCELLED",
            completedAt: cancelledAt,
            cancelledAt,
            cancelledBy,
          },
          include: { release: true },
        });
        await tx.otaEvent.create({
          data: {
            requestId,
            status: "CANCELLED",
            progress: update.progress,
            resultCode: "ADMIN_CANCELLED",
          },
        });
        await tx.device.update({
          where: { id: device.id },
          data: {
            targetFirmwareVersion: null,
            lastOtaStatus: "CANCELLED",
            lastOtaResult: "ADMIN_CANCELLED",
          },
        });
        return publicUpdate(cancelled);
      });
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
              (current.desiredConfig.version !== current.configVersion ||
                current.desiredConfig.checksum !== current.configChecksum ||
                (current.desiredConfig.allowedRfids?.length ?? 0) !== current.authorizedRfidCount)
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
          if (update.status === "CANCELLED")
            return { accepted: true, duplicate: true, cancelled: true };
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
      if (!release || !["DRAFT","PUBLISHED"].includes(release.status))
        throw otaError("Release not found.", 404);
      return { release, file: await storage.get(release) };
    },
    async command(id, type, payload, requestedBy) {
      uuid(id);
      if (requestedBy === undefined) { requestedBy = payload; payload = {}; }
      return withDevice(id, async (tx, device) => {
        const validatedPayload = commandPayloadForHardware(device.hardwareModel, type, payload);
        if (!device.tokenHash || device.credentialRevokedAt)
          throw otaError("Device is not provisioned.", 409);
        if (await activeUpdate(tx, id))
          throw otaError("Commands are disabled during OTA.", 409);
        const servoMovementCommands=[
          "OPEN_TRAP", "CLOSE_TRAP", "CYCLE_TRAP", "SET_SERVO_CONFIG",
          "SERVO_DIAG_START", "SERVO_RAW_PWM_TEST", "SERVO_RAW_PIN25_TEST", "TEST_SERVO_POSITION",
        ];
        if(device.servoDiagnosticState==="RUNNING" && servoMovementCommands.includes(type))
          throw otaError("Stop the running servo diagnostic first.",409);
        if(type==="SERVO_DIAG_START" && device.desiredConfig?.version &&
          device.desiredConfig.version!==device.configVersion)
          throw otaError("Wait for the pending servo configuration to synchronize.",409);
        const pendingWhere={deviceId:id,status:"PENDING",expiresAt:{gt:new Date()}};
        let pendingCount=await tx.deviceCommand.count({where:pendingWhere});
        if(pendingCount && type==="TEST_SERVO_POSITION") {
          await tx.deviceCommand.updateMany({
            where:{...pendingWhere,type:"TEST_SERVO_POSITION"},
            data:{
              status:"CANCELLED",completedAt:new Date(),
              result:{ok:false,value:"superseded_by_newer_preview_position"},
            },
          });
          pendingCount=await tx.deviceCommand.count({where:pendingWhere});
        }
        if(pendingCount && type!=="SERVO_DIAG_STOP")
          throw otaError("Device already has a pending command.", 409);
        if(pendingCount) {
          await tx.deviceCommand.updateMany({where:pendingWhere,data:{
            status:"CANCELLED",completedAt:new Date(),
            result:{ok:false,value:"superseded_by_servo_diagnostic_stop"},
          }});
        }
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
          if (command.status !== "PENDING")
            return { accepted: true, duplicate: true, status: command.status };
          if (new Date(command.expiresAt) <= new Date())
            throw otaError("Command expired.", 409);
          await tx.deviceCommand.update({
            where: { id },
            data: { status: "ACKNOWLEDGED", completedAt: new Date(), result },
          });
          if (body.ok === true && command.type === "SERVO_DIAG_START") {
            await tx.device.update({
              where: { id: device.id },
              data: {
                servoDiagnosticState: "RUNNING",
                servoDiagnosticRemaining: command.payload.durationSec,
              },
            });
          } else if (body.ok === true && command.type === "SERVO_DIAG_STOP") {
            await tx.device.update({
              where: { id: device.id },
              data: {
                servoDiagnosticState: "COMPLETED",
                servoDiagnosticRemaining: 0,
              },
            });
          }
          return { accepted: true };
        },
        device,
      );
    },
    async updateConfiguration(id, input) {
      uuid(id);
      const version = String(Date.now());
      return withDevice(id, async (tx, device) => {
        if (device.hardwareModel !== "ESP32_DEVKIT_CHECKOUT_V1")
          throw otaError("Servo configuration is only available for CheckoutBox hardware.", 409);
        const pendingDiagnostic = await tx.deviceCommand.count({
          where: {
            deviceId: id,
            type: "SERVO_DIAG_START",
            status: "PENDING",
            expiresAt: { gt: new Date() },
          },
        });
        if (device.servoDiagnosticState === "RUNNING" || pendingDiagnostic)
          throw otaError("Stop the servo diagnostic before changing configuration.", 409);
        const keys=await tx.deviceRfidKey.findMany({where:{deviceId:id,authorized:true,active:true},select:{uid:true},orderBy:{uid:"asc"}});
        const config = servoConfiguration({...input,allowedRfids:keys.map((key)=>key.uid)}, version);
        await tx.device.update({ where: { id }, data: { desiredConfig: config,configRejectedReason:null } });
        return config;
      });
    },
    async upsertRfidKey(id,input) {
      uuid(id);
      return withDevice(id,async(tx,device)=>{
        if(device.hardwareModel!=="ESP32_DEVKIT_CHECKOUT_V1")
          throw otaError("RFID keys are only available for CheckoutBox hardware.",409);
        const uid=rfidUid(input.uid);
        const authorized=input.authorized===true;
        const active=input.active!==false;
        const name=textField(input.name,"RFID name",120,true)||"";
        const room=textField(input.room,"room",32,true)||"";
        if(authorized&&active) {
          const count=await tx.deviceRfidKey.count({where:{deviceId:id,authorized:true,active:true,uid:{not:uid}}});
          if(count>=128) throw otaError("A device can authorize at most 128 RFID keys.",409);
        }
        const key=await tx.deviceRfidKey.upsert({
          where:{deviceId_uid:{deviceId:id,uid}},
          create:{deviceId:id,uid,name,room,authorized,active},
          update:{name,room,authorized,active},
        });
        const config=await rebuildDesiredConfiguration(tx,device);
        return {key,configuration:config};
      });
    },
    async deleteRfidKey(id,keyId) {
      uuid(id); uuid(keyId,"RFID key ID");
      return withDevice(id,async(tx,device)=>{
        const key=await tx.deviceRfidKey.findUnique({where:{id:keyId}});
        if(!key||key.deviceId!==id) throw otaError("RFID key not found.",404);
        await tx.deviceRfidKey.delete({where:{id:keyId}});
        const config=await rebuildDesiredConfiguration(tx,device);
        return {deleted:true,configuration:config};
      });
    },
    async ingestEvents(device, body) {
      const events = deviceEvents(body);
      const notifications = await prisma.$transaction(async(tx)=>{
        const queuedNotifications=[];
        // Serialize event batches per device so simultaneous polls cannot both
        // create a return before either one can observe the other reading.
        if(typeof tx.$queryRaw==="function")
          await tx.$queryRaw`WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${`rfid:${device.id}`}))) SELECT 1::int FROM lock`;
        await tx.deviceEvent.createMany({data:events.map((event)=>({...event,deviceId:device.id}))});
        for(const event of events) {
          if(event.type==="RFID_READ") {
            const match=event.detail?.match(/^([A-Fa-f0-9]{8}|[A-Fa-f0-9]{10})(?:\s|$)/);
            if(match) {
              const uid=match[1].toUpperCase(),seen=new Date();
              const key=await tx.deviceRfidKey.upsert({
                where:{deviceId_uid:{deviceId:device.id,uid}},
                create:{deviceId:device.id,uid,firstSeenAt:seen,lastSeenAt:seen},
                update:{lastSeenAt:seen},
              });
              const duplicateWindowMs=Math.max(
                1500,
                Math.min(10000,Number(device.desiredConfig?.duplicateRfidMs)||1500),
              );
              const previous=await tx.deviceRfidReading.findFirst({
                where:{deviceId:device.id,uid},orderBy:{createdAt:"desc"},
              });
              const duplicate=Boolean(previous&&seen.getTime()-new Date(previous.createdAt).getTime()<duplicateWindowMs);
              const tenant=device.tenantId
                ? await tx.tenant.findUnique({where:{id:device.tenantId}})
                : null;
              const normalizedRoom=key.room.replace(/^habitaci[oó]n\s+/i,"").trim();
              const room=tenant&&normalizedRoom
                ? await tx.room.findFirst({where:{
                    tenantId:tenant.id,active:true,deletedAt:null,
                    OR:[
                      {number:{equals:normalizedRoom,mode:"insensitive"}},
                      {name:{equals:normalizedRoom,mode:"insensitive"}},
                    ],
                  }})
                : null;
              const validReturn=Boolean(key.authorized&&key.active&&tenant&&room&&!duplicate);
              const reading=await tx.deviceRfidReading.create({data:{
                deviceId:device.id,tenantId:tenant?.id||null,keyId:key.id,uid,
                keyName:key.name,room:key.room,hotelName:tenant?.name||"",
                authorized:key.authorized,active:key.active,duplicate,
                eventType:validReturn?"RETURN_RECORDED":"RFID_READ",
                result:duplicate?"DUPLICATE_SUPPRESSED":validReturn?"AUTHORIZED_RETURN_RECORDED":
                  key.authorized&&key.active?"AUTHORIZED_ROOM_NOT_LINKED":"NOT_AUTHORIZED",
                diagnostic:event.detail||null,deviceUptimeMs:event.uptimeMs,
              }});
              if(validReturn) {
                const checkoutEvent=await tx.checkoutEvent.create({data:{
                  tenantId:tenant.id,roomId:room.id,source:"rfid_return",
                  sourceIdentifier:reading.id,status:"recorded_unconfirmed",
                  metadata:{
                    deviceId:device.id,deviceName:device.name,uid,
                    keyName:key.name,roomSnapshot:key.room,hotelSnapshot:tenant.name,
                    physicalConfirmation:false,rule:"authorized_rfid_read",
                  },
                }});
                await tx.deviceRfidReading.update({
                  where:{id:reading.id},data:{checkoutEventId:checkoutEvent.id},
                });
                queuedNotifications.push({tenant,room,event:checkoutEvent});
              }
            }
          } else if(event.type==="CONFIG_REJECTED"||event.type==="CONFIG_STALE_REJECTED") {
            await tx.device.update({where:{id:device.id},data:{configRejectedReason:event.detail||event.type}});
          }
        }
        const cutoff=await tx.deviceEvent.findFirst({
          where:{deviceId:device.id},orderBy:{createdAt:"desc"},skip:999,select:{createdAt:true},
        });
        if(cutoff) await tx.deviceEvent.deleteMany({where:{deviceId:device.id,createdAt:{lt:cutoff.createdAt}}});
        return queuedNotifications;
      });
      if(database) for(const notification of notifications)
        void sendRfidReturnPush(database,notification).catch((error)=>
          console.warn(`[WebPush] RFID return notification failed: ${error instanceof Error?error.message:"unknown error"}`),
        );
      return { accepted: true, count: events.length };
    },
  };
}
