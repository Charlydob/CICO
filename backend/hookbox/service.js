import { redactProtocol } from "./diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import {
  defaultTheme,
  upgradeTheme,
  validateTheme,
  validateMapping,
  validateQuery,
  authorizedRooms,
  LIMITS,
  fail,
} from "../../shared/hookbox/contract.mjs";
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const uuid = (value) => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    fail("Invalid identifier");
  return value;
};
function response(op) {
  const s = op.state;
  return {
    schemaVersion: 1,
    operationId: op.id,
    expiresAt: op.expiresAt.toISOString(),
    status: s.status,
    challenge: s.challenge,
    rooms: ["AUTHORIZED", "RELEASING", "COMPLETE", "UNCERTAIN"].includes(
      s.status,
    )
      ? s.rooms
      : undefined,
    results: s.results || [],
    mock: s.mock === true,
  };
}
const editorDeviceFields = {
  id: true,
  deviceId: true,
  name: true,
  hardwareModel: true,
  status: true,
  currentFirmwareVersion: true,
  currentBuildId: true,
  uiDesiredVersion: true,
  uiAppliedVersion: true,
  uiChecksum: true,
  uiRejectedReason: true,
  lastSeenAt: true,
  events: {
    where: {
      type: {
        in: [
          "hookbox.ui.applied",
          "hookbox.ui.rejected",
          "hookbox.request_failed",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, type: true, detail: true, createdAt: true },
  },
};
export function createHookboxService(prisma, provider) {
  const lock = async (tx, tenant) => {
    await tx.$queryRaw`WITH lock AS (SELECT pg_advisory_xact_lock(hashtext(${`hookbox:${tenant}`}))) SELECT 1::int FROM lock`;
  };
  const transaction = (tenant, fn) => {
    if (!prisma) fail("PostgreSQL required", 503);
    return prisma.$transaction(
      async (tx) => {
        await lock(tx, tenant);
        return fn(tx);
      },
      { timeout: 30000 },
    );
  };
  const event = (tx, device, type, payload) =>
    tx.deviceEvent.create({
      data: {
        deviceId: device.id,
        type,
        detail: JSON.stringify(payload),
        uptimeMs: 0,
      },
    });
  async function owned(tx, device) {
    await tx.$queryRaw`SELECT id FROM devices WHERE id = ${device.id}::uuid FOR UPDATE`;
    const d = await tx.device.findUnique({ where: { id: device.id } });
    if (
      !d ||
      !d.tenantId ||
      d.tenantId !== device.tenantId ||
      d.tokenHash !== device.tokenHash ||
      d.credentialRevokedAt ||
      d.hardwareModel !== "CROWPANEL_7_V3"
    )
      fail("Device ownership or credential changed", 403);
    return d;
  }
  async function hotel(tx, tenant) {
    return tx.hookboxHotel.upsert({
      where: { tenantId: tenant },
      create: {
        tenantId: tenant,
        draft: defaultTheme(
          (
            await tx.tenant.findUnique({
              where: { id: tenant },
              select: { name: true },
            })
          )?.name || "Hotel",
        ),
      },
      update: {},
    });
  }
  async function scope(tx, tenant, deviceId) {
    if (!deviceId) return hotel(tx, tenant);
    uuid(deviceId);
    await tx.$queryRaw`SELECT id FROM devices WHERE id = ${deviceId}::uuid FOR UPDATE`;
    const d = await tx.device.findFirst({
      where: {
        id: uuid(deviceId),
        tenantId: tenant,
        hardwareModel: "CROWPANEL_7_V3",
      },
    });
    if (!d) fail("Device not found in hotel", 404);
    const h = await hotel(tx, tenant);
    const previous = await tx.hookboxDeviceDesign.findUnique({
      where: { deviceId },
    });
    if (previous && previous.tenantId !== tenant) {
      return tx.hookboxDeviceDesign.update({
        where: { deviceId },
        data: {
          tenantId: tenant,
          draft: h.draft,
          mapping: h.mapping,
          revision: 0,
          publishedVersion: null,
        },
      });
    }
    return tx.hookboxDeviceDesign.upsert({
      where: { deviceId },
      create: {
        deviceId,
        tenantId: tenant,
        draft: h.draft,
        mapping: h.mapping,
      },
      update: {},
    });
  }
  async function published(tx, device) {
    const override = await tx.hookboxDeviceDesign.findFirst({
      where: { deviceId: device.id, tenantId: device.tenantId },
    });
    const h = await tx.hookboxHotel.findUnique({
      where: { tenantId: device.tenantId },
    });
    const version = override?.publishedVersion || h?.publishedVersion;
    if (!version) return null;
    return tx.hookboxDesign.findFirst({
      where: { id: version, tenantId: device.tenantId },
    });
  }
  async function operation(tx, device, id, allowExpired = false) {
    const op = await tx.hookboxOperation.findUnique({
      where: { id: uuid(id) },
    });
    if (!op || op.tenantId !== device.tenantId || op.deviceId !== device.id)
      fail("Operation not found", 404);
    if (!allowExpired && op.expiresAt.getTime() <= Date.now())
      fail("Operation expired", 410);
    return op;
  }
  async function save(tx, op, state) {
    return tx.hookboxOperation.update({
      where: { id: op.id },
      data: { state },
    });
  }
  return {
    async inherit(tenant, input) {
      return transaction(tenant, async (tx) => {
        if (!input.deviceId) fail("Device required");
        await scope(tx, tenant, input.deviceId);
        await tx.hookboxDeviceDesign.delete({
          where: { deviceId: input.deviceId },
        });
        const h = await hotel(tx, tenant);
        await tx.device.update({
          where: { id: input.deviceId },
          data: {
            uiDesiredVersion: h.publishedVersion,
            uiRejectedReason: null,
          },
        });
        return { ok: true };
      });
    },
    async trace(device, path, request, response, status) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        await tx.hookboxProtocolTrace.create({
          data: {
            tenantId: device.tenantId,
            deviceId: device.id,
            path,
            status,
            request: redactProtocol(request || {}),
            response: redactProtocol(response || {}),
          },
        });
      });
    },
    async diagnostics(tenant, deviceId) {
      if (deviceId)
        await transaction(tenant, (tx) => scope(tx, tenant, deviceId));
      return prisma.hookboxProtocolTrace.findMany({
        where: { tenantId: tenant, ...(deviceId ? { deviceId } : {}) },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    },
    async failure(device, phase, status) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        await event(tx, device, "hookbox.request_failed", {
          phase: String(phase).slice(0, 100),
          status,
        });
      });
    },
    async deviceAsset(device, id) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        if (!/^[a-f0-9]{64}$/.test(id)) fail("Invalid asset");
        const a = await tx.hookboxAsset.findUnique({
          where: { tenantId_id: { tenantId: device.tenantId, id } },
        });
        if (!a) fail("Asset not found", 404);
        return a;
      });
    },
    async devices(tenant) {
      return transaction(tenant, (tx) =>
        tx.device.findMany({
          where: { tenantId: tenant, hardwareModel: "CROWPANEL_7_V3" },
          select: editorDeviceFields,
          orderBy: { name: "asc" },
        }),
      );
    },
    async device(tenant, id) {
      return transaction(tenant, async (tx) => {
        const device = await tx.device.findFirst({
          where: {
            id: uuid(id),
            tenantId: tenant,
            hardwareModel: "CROWPANEL_7_V3",
          },
          select: editorDeviceFields,
        });
        if (!device) fail("Device not found in hotel", 404);
        return device;
      });
    },
    async editor(tenant, deviceId) {
      return transaction(tenant, async (tx) => ({
        hotel: await scope(tx, tenant, deviceId).then((h) => ({
          ...h,
          draft: upgradeTheme(h.draft),
        })),
        versions: await tx.hookboxDesign.findMany({
          where: { tenantId: tenant, deviceId: deviceId || null },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        devices: await tx.device.findMany({
          where: { tenantId: tenant, hardwareModel: "CROWPANEL_7_V3" },
          select: editorDeviceFields,
        }),
      }));
    },
    async draft(tenant, input) {
      const theme = validateTheme(input.theme),
        mapping = validateMapping(input.mapping);
      return transaction(tenant, async (tx) => {
        const h = await scope(tx, tenant, input.deviceId);
        if (input.revision !== h.revision)
          fail("Draft changed; reload before saving", 409);
        return (
          input.deviceId ? tx.hookboxDeviceDesign : tx.hookboxHotel
        ).update({
          where: input.deviceId
            ? { deviceId: input.deviceId }
            : { tenantId: tenant },
          data: { draft: theme, mapping, revision: { increment: 1 } },
        });
      });
    },
    async upload(tenant, input) {
      const kind = input.kind;
      if (!["logo", "background"].includes(kind))
        fail("Unsupported image kind");
      const w = input.width,
        h = input.height;
      if (
        !Number.isInteger(w) ||
        !Number.isInteger(h) ||
        w < 1 ||
        h < 1 ||
        w > LIMITS[kind + "Width"] ||
        h > LIMITS[kind + "Height"] ||
        typeof input.data !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) ||
        input.data.length > 45000
      )
        fail("Asset dimensions/encoding exceed limits");
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.length !== w * h * 2 || bytes.length > LIMITS.assetBytes)
        fail("Invalid RGB565 asset");
      const id = digest(bytes);
      return transaction(tenant, (tx) =>
        tx.hookboxAsset
          .upsert({
            where: { tenantId_id: { tenantId: tenant, id } },
            create: { id, tenantId: tenant, kind, width: w, height: h, bytes },
            update: {},
          })
          .then((a) => ({
            id: a.id,
            width: a.width,
            height: a.height,
            kind: a.kind,
          })),
      );
    },
    async asset(tenant, id) {
      if (!/^[a-f0-9]{64}$/.test(id)) fail("Invalid asset");
      const a = await prisma.hookboxAsset.findUnique({
        where: { tenantId_id: { tenantId: tenant, id } },
      });
      if (!a) fail("Asset not found", 404);
      return a;
    },
    async publish(tenant, input, user) {
      return transaction(tenant, async (tx) => {
        const h = await scope(tx, tenant, input.deviceId);
        if (input.revision !== h.revision)
          fail("Draft changed; review latest preview", 409);
        let theme = h.draft,
          mapping = h.mapping;
        if (input.restoreVersion) {
          const old = await tx.hookboxDesign.findFirst({
            where: {
              tenantId: tenant,
              deviceId: input.deviceId || null,
              id: uuid(input.restoreVersion),
            },
          });
          if (!old) fail("Version not found", 404);
          theme = old.manifest.theme;
          mapping = old.manifest.roomMapping || h.mapping;
        }
        theme = validateTheme(theme);
        const assets = [];
        let total = 0;
        for (const kind of ["logo", "background"]) {
          if (!theme[kind]) continue;
          const a = await tx.hookboxAsset.findUnique({
            where: { tenantId_id: { tenantId: tenant, id: theme[kind] } },
          });
          if (!a || a.kind !== kind) fail("Missing or incompatible resource");
          total += a.bytes.length;
          assets.push({
            id: a.id,
            sha256: a.id,
            width: a.width,
            height: a.height,
            bytes: a.bytes.length,
            kind,
            format: "rgb565le",
          });
        }
        if (total > LIMITS.totalAssetBytes) fail("Resource budget exceeded");
        const id = randomUUID(),
          manifest = {
            schemaVersion: 1,
            version: id,
            tenantId: tenant,
            deviceId: input.deviceId || null,
            roomMapping: validateMapping(mapping),
            theme,
            assets,
          };
        const manifestRaw = JSON.stringify(manifest);
        const hash = digest(manifestRaw);
        await tx.hookboxDesign.create({
          data: {
            id,
            tenantId: tenant,
            deviceId: input.deviceId || null,
            manifest,
            manifestRaw,
            sha256: hash,
            createdBy: user,
          },
        });
        await (
          input.deviceId ? tx.hookboxDeviceDesign : tx.hookboxHotel
        ).update({
          where: input.deviceId
            ? { deviceId: input.deviceId }
            : { tenantId: tenant },
          data: {
            publishedVersion: id,
            draft: theme,
            mapping,
            revision: { increment: 1 },
          },
        });
        await tx.device.updateMany({
          where: {
            tenantId: tenant,
            hardwareModel: "CROWPANEL_7_V3",
            ...(input.deviceId
              ? { id: input.deviceId }
              : {
                  id: {
                    notIn: (
                      await tx.hookboxDeviceDesign.findMany({
                        where: {
                          tenantId: tenant,
                          publishedVersion: { not: null },
                        },
                        select: { deviceId: true },
                      })
                    ).map((x) => x.deviceId),
                  },
                }),
          },
          data: { uiDesiredVersion: id, uiRejectedReason: null },
        });
        return { version: id, sha256: hash };
      });
    },
    async sync(device) {
      return transaction(device.tenantId, async (tx) => {
        const d = await owned(tx, device),
          p = await published(tx, d);
        if (!p)
          return {
            schemaVersion: 1,
            version: null,
            tenantId: d.tenantId,
            hotelName:
              (
                await tx.tenant.findUnique({
                  where: { id: d.tenantId },
                  select: { name: true },
                })
              )?.name || "Hotel",
          };
        const manifest = p.manifestRaw ?? JSON.stringify(p.manifest);
        if (digest(manifest) !== p.sha256)
          fail(
            "Published design requires republishing to preserve exact bytes",
            503,
          );
        if (d.uiDesiredVersion !== p.id)
          await tx.device.update({
            where: { id: d.id },
            data: { uiDesiredVersion: p.id },
          });
        return {
          schemaVersion: 1,
          version: p.id,
          tenantId: d.tenantId,
          hotelName: p.manifest.theme.hotelName,
          sha256: p.sha256,
          manifest,
        };
      });
    },
    async ack(device, input) {
      return transaction(device.tenantId, async (tx) => {
        const current = await owned(tx, device);
        const p = await tx.hookboxDesign.findFirst({
          where: { tenantId: device.tenantId, id: uuid(input.version) },
        });
        if (
          !p ||
          (p.deviceId && p.deviceId !== device.id) ||
          input.sha256 !== p.sha256
        )
          fail("Invalid UI acknowledgment");
        if (!["applied", "rejected"].includes(input.status))
          fail("Invalid UI status");
        if (
          input.status === "applied" &&
          current.uiAppliedVersion === p.id &&
          current.uiChecksum === p.sha256 &&
          !current.uiRejectedReason
        )
          return { schemaVersion: 1, ok: true };
        await tx.device.update({
          where: { id: device.id },
          data:
            input.status === "applied"
              ? {
                  uiAppliedVersion: p.id,
                  uiChecksum: p.sha256,
                  uiRejectedReason: null,
                }
              : {
                  uiRejectedReason: String(input.reason || "rejected").slice(
                    0,
                    160,
                  ),
                },
        });
        await event(tx, device, "hookbox.ui." + input.status, {
          version: p.id,
        });
        return { schemaVersion: 1, ok: true };
      });
    },
    async lookup(device, input) {
      input = validateQuery(input);
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        const old = await tx.hookboxOperation.findUnique({
          where: { id: input.operationId },
        });
        const fingerprint = digest(
          JSON.stringify([input.method, input.value, input.language]),
        );
        if (old) {
          await operation(tx, device, old.id);
          if (old.state.fingerprint !== fingerprint)
            fail("operationId reused with different lookup", 409);
          await event(tx, device, "hookbox.duplicate", {
            operationId: old.id,
            phase: "lookup",
          });
          return response(old);
        }
        const busy = await tx.hookboxOperation.findMany({
          where: { deviceId: device.id, expiresAt: { gt: new Date() } },
        });
        if (
          busy.some((o) =>
            ["AUTHORIZED", "RELEASING", "UNCERTAIN"].includes(o.state.status),
          )
        )
          fail("Previous operation requires resolution", 409);
        const p = await provider(device.tenantId, "lookup", {
          operationId: input.operationId,
          method: input.method,
          value: input.value,
          language: input.language,
        });
        if (
          !["CHALLENGE", "INSUFFICIENT", "AMBIGUOUS", "NOT_FOUND"].includes(
            p.status,
          )
        )
          fail("Unsupported lookup response", 502);
        // Lookup never carries room authorization to the device.
        if (
          p.status === "CHALLENGE" &&
          (typeof p.challengeId !== "string" || p.challengeId.length > 128)
        )
          fail("Invalid challenge", 502);
        const op = await tx.hookboxOperation.create({
          data: {
            id: input.operationId,
            tenantId: device.tenantId,
            deviceId: device.id,
            expiresAt: new Date(Date.now() + 120000),
            state: {
              status: p.status,
              challenge: p.status === "CHALLENGE" ? "verification_code" : null,
              challengeId: p.challengeId || null,
              fingerprint,
              attempts: 0,
              rooms: [],
              results: [],
              mock: p.mock === true,
            },
          },
        });
        await event(tx, device, "hookbox.lookup", {
          operationId: op.id,
          status: p.status,
        });
        return response(op);
      });
    },
    async verify(device, input) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        const op = await operation(tx, device, input.operationId),
          s = op.state;
        if (s.status === "AUTHORIZED") return response(op);
        if (
          s.status !== "CHALLENGE" ||
          s.attempts >= 3 ||
          typeof input.proof !== "string" ||
          !/^[-A-Za-z0-9]{4,64}$/.test(input.proof)
        )
          fail("Verification unavailable", 403);
        s.attempts++;
        await save(tx, op, s);
        // Provider denial is persisted without rolling back attempt counters.
        let p;
        try {
          p = await provider(device.tenantId, "verify", {
            operationId: op.id,
            challengeId: s.challengeId,
            proof: input.proof,
          });
          authorizedRooms(p);
        } catch {
          await event(tx, device, "hookbox.verification_denied", {
            operationId: op.id,
            attempt: s.attempts,
          });
          return { ...response({ ...op, state: s }), status: "DENIED" };
        }
        const rooms = authorizedRooms(p),
          publication = await published(tx, device),
          mapping = validateMapping(
            publication?.manifest.roomMapping ||
              (await hotel(tx, device.tenantId)).mapping,
          );
        if (!publication) fail("Publish the room mapping before check-in", 409);
        s.designVersion = publication.id;
        s.rooms = rooms.map((room) => {
          const m = mapping.find((m) => m.room === room);
          if (!m) fail("Authorized room is not mapped", 409);
          return m;
        });
        s.reservationId = p.reservationId;
        s.status = "AUTHORIZED";
        s.mock = p.mock === true;
        await event(tx, device, "hookbox.authorized", {
          operationId: op.id,
          rooms: s.rooms,
        });
        return response(await save(tx, op, s));
      });
    },
    async start(device, input) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        const op = await operation(tx, device, input.operationId),
          s = op.state;
        if (["RELEASING", "COMPLETE", "UNCERTAIN"].includes(s.status)) {
          await event(tx, device, "hookbox.duplicate", {
            operationId: op.id,
            phase: "start",
          });
          return response(op);
        }
        if (s.status !== "AUTHORIZED")
          fail("Identity and delivery conditions required", 403);
        // Uniqueness claims survive uncertainty and power loss. No automatic reclaim/retry.
        for (const r of s.rooms) {
          const prior = await tx.hookboxClaim.findUnique({
            where: {
              tenantId_reservationId_room: {
                tenantId: device.tenantId,
                reservationId: s.reservationId,
                room: r.room,
              },
            },
          });
          if (prior)
            fail("Key already claimed; staff reconciliation required", 409);
        }
        for (const r of s.rooms)
          await tx.hookboxClaim.create({
            data: {
              tenantId: device.tenantId,
              reservationId: s.reservationId,
              room: r.room,
              operationId: op.id,
            },
          });
        s.status = "RELEASING";
        await event(tx, device, "hookbox.release_started", {
          operationId: op.id,
          mock: s.mock,
        });
        return response(await save(tx, op, s));
      });
    },
    async result(device, input) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        const op = await operation(tx, device, input.operationId, true),
          s = op.state;
        if (!["RELEASING", "UNCERTAIN", "COMPLETE"].includes(s.status))
          fail("Release not started", 409);
        if (
          !Number.isInteger(input.index) ||
          !s.rooms[input.index] ||
          ![
            "ELECTRICAL_ACTIVATION",
            "UNCERTAIN",
            "FAILED",
            "MOCK_ACTIVATION",
          ].includes(input.result) ||
          input.physicallyConfirmed !== false ||
          input.mock !== s.mock
        )
          fail("Invalid actuator result");
        if (
          (s.mock && input.result === "ELECTRICAL_ACTIVATION") ||
          (!s.mock && input.result === "MOCK_ACTIVATION")
        )
          fail("MOCK result mismatch");
        const previous = s.results.find((r) => r.index === input.index);
        if (previous) {
          if (previous.result !== input.result)
            fail("Conflicting duplicate result", 409);
          await event(tx, device, "hookbox.duplicate", {
            operationId: op.id,
            phase: "result",
            index: input.index,
          });
          return response(op);
        }
        if (s.status !== "RELEASING" || input.index !== s.results.length)
          fail("Results must be sequential", 409);
        s.results.push({
          index: input.index,
          result: input.result,
          physicallyConfirmed: false,
        });
        if (["UNCERTAIN", "FAILED"].includes(input.result))
          s.status = "UNCERTAIN";
        await event(tx, device, "hookbox.solenoid_result", {
          operationId: op.id,
          ...s.results.at(-1),
        });
        return response(await save(tx, op, s));
      });
    },
    async finish(device, input) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        const op = await operation(tx, device, input.operationId, true),
          s = op.state;
        if (s.status === "COMPLETE") return response(op);
        if (
          s.status !== "RELEASING" ||
          s.results.length !== s.rooms.length ||
          s.results.some(
            (r) =>
              !["ELECTRICAL_ACTIVATION", "MOCK_ACTIVATION"].includes(r.result),
          )
        )
          fail("Release is incomplete or uncertain", 409);
        s.status = "COMPLETE";
        await event(tx, device, "hookbox.complete", {
          operationId: op.id,
          physicallyConfirmed: false,
          mock: s.mock,
        });
        return response(await save(tx, op, s));
      });
    },
    async status(device, id) {
      return transaction(device.tenantId, async (tx) => {
        await owned(tx, device);
        return response(await operation(tx, device, id, true));
      });
    },
  };
}
