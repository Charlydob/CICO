import argon2 from "argon2";
import { fail } from "../../shared/hookbox/contract.mjs";
export async function lockPinDevice(tx, tenantId, deviceId) {
  await tx.$queryRaw`SELECT id FROM devices WHERE id=${deviceId}::uuid FOR UPDATE`;
  const device = await tx.device.findFirst({
    where: { id: deviceId, tenantId, hardwareModel: "CROWPANEL_7_V3" },
  });
  if (!device) fail("Dispositivo no encontrado en este hotel", 404);
  return device;
}
const safeHook = ({ pinHash, ...h }) => ({ ...h, hasPin: Boolean(pinHash) });
export function createPinService(prisma) {
  async function transaction(tenant, id, fn) {
    return prisma.$transaction(
      async (tx) => {
        const d = await lockPinDevice(tx, tenant, id);
        return fn(tx, d);
      },
      { timeout: 60000 },
    );
  }
  const hooks = (tx, tenantId, deviceId) =>
    tx.devicePinHook.findMany({
      where: { tenantId, deviceId },
      orderBy: { hook: "asc" },
    });
  async function guard(tx, tenantId, deviceId) {
    const g = await tx.devicePinGuard.findUnique({ where: { deviceId } });
    if (g && g.tenantId !== tenantId) {
      await tx.devicePinGuard.delete({ where: { deviceId } });
      await tx.devicePinHook.deleteMany({ where: { deviceId } });
    }
    return tx.devicePinGuard.upsert({
      where: { deviceId },
      create: { deviceId, tenantId },
      update: {},
    });
  }
  return {
    async list(tenant, id) {
      return transaction(tenant, id, async (tx) => ({
        settings: await guard(tx, tenant, id),
        hooks: (await hooks(tx, tenant, id)).map(safeHook),
      }));
    },
    async save(tenant, id, input, actor) {
      return transaction(tenant, id, async (tx) => {
        const g = await guard(tx, tenant, id);
        if (input.settings) {
          const { minLength, maxLength } = input.settings;
          if (
            !Number.isInteger(minLength) ||
            !Number.isInteger(maxLength) ||
            minLength < 4 ||
            maxLength > 12 ||
            maxLength < minLength
          )
            fail("PIN: entre 4 y 12 cifras");
          await tx.devicePinGuard.update({
            where: { deviceId: id },
            data: { minLength, maxLength },
          });
          return { ok: true };
        }
        const { hook } = input,
          room = String(input.room || "").trim();
        if (
          !Number.isInteger(hook) ||
          hook < 1 ||
          hook > 25 ||
          !/^[-A-Za-z0-9 ]{1,16}$/.test(room)
        )
          fail("Selecciona gancho 1–25 y una habitación válida");
        const all = await hooks(tx, tenant, id),
          current = all.find((h) => h.hook === hook);
        if (
          all.some(
            (h) =>
              h.hook !== hook && h.room.toLowerCase() === room.toLowerCase(),
          )
        )
          fail("Habitación ya asignada", 409);
        if (
          current &&
          current.state !== "AVAILABLE" &&
          (current.room !== room || input.pin)
        )
          fail("Rearma el gancho antes de cambiar habitación o PIN", 409);
        let pinHash = current?.pinHash;
        if (input.pin !== undefined && input.pin !== "") {
          if (
            typeof input.pin !== "string" ||
            !/^\d+$/.test(input.pin) ||
            input.pin.length < g.minLength ||
            input.pin.length > g.maxLength
          )
            fail("Longitud de PIN no permitida");
          for (const h of all)
            if (h.hook !== hook && (await argon2.verify(h.pinHash, input.pin)))
              fail("PIN ya utilizado en este dispositivo", 409);
          pinHash = await argon2.hash(input.pin, { type: argon2.argon2id });
        }
        if (!pinHash) fail("Introduce un PIN para el nuevo gancho");
        await tx.devicePinHook.upsert({
          where: { deviceId_hook: { deviceId: id, hook } },
          create: {
            tenantId: tenant,
            deviceId: id,
            hook,
            room,
            pinHash,
            enabled: input.enabled !== false,
          },
          update: { room, pinHash, enabled: input.enabled !== false },
        });
        await tx.deviceEvent.create({
          data: {
            deviceId: id,
            type: "hookbox.hook_configured",
            detail: JSON.stringify({ hook, actor }),
            uptimeMs: 0,
          },
        });
        return { ok: true };
      });
    },
    async rearm(tenant, id, input, actor) {
      return transaction(tenant, id, async (tx) => {
        const h = await tx.devicePinHook.findFirst({
          where: { deviceId: id, tenantId: tenant, hook: input.hook },
        });
        if (!h) fail("Gancho no encontrado", 404);
        if (typeof input.reason !== "string" || input.reason.trim().length < 3)
          fail("Indica el motivo del rearme");
        if (h.operationId) {
          const op = await tx.hookboxOperation.findUnique({
            where: { id: h.operationId },
          });
          if (op && ["AUTHORIZED", "RELEASING"].includes(op.state.status)) {
            if (op.expiresAt > new Date())
              fail(
                "Espera a que termine o caduque la entrega (2 minutos)",
                409,
              );
            await tx.hookboxOperation.update({
              where: { id: op.id },
              data: { state: { ...op.state, status: "UNCERTAIN" } },
            });
          }
        }
        await tx.devicePinHook.update({
          where: { id: h.id },
          data: { state: "AVAILABLE", operationId: null },
        });
        await tx.deviceEvent.create({
          data: {
            deviceId: id,
            type: "hookbox.rearmed",
            detail: JSON.stringify({
              hook: h.hook,
              actor,
              reason: input.reason.slice(0, 160),
            }),
            uptimeMs: 0,
          },
        });
        return { ok: true };
      });
    },
    async validate(device, input) {
      return transaction(device.tenantId, device.id, async (tx, d) => {
        if (
          !d.tokenHash ||
          d.tokenHash !== device.tokenHash ||
          d.credentialRevokedAt
        )
          fail("Device revoked", 403);
        const g = await guard(tx, d.tenantId, d.id),
          now = new Date();
        if (
          typeof input.operationId !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            input.operationId,
          )
        )
          fail("Invalid operation ID");
        const deny = () => ({
          schemaVersion: 1,
          operationId: input.operationId,
          status: "DENIED",
          rooms: [],
          results: [],
          mock: false,
        });
        if (g.lockedUntil && g.lockedUntil > now)
          return {
            ...deny(),
            status: "LOCKED",
            retryAfter: Math.ceil((g.lockedUntil - now) / 1000),
          };
        // Malformed and unavailable PINs count identically. Never trace or persist plaintext.
        let selected;
        const valid =
          typeof input.pin === "string" &&
          /^\d{4,12}$/.test(input.pin) &&
          input.pin.length >= g.minLength &&
          input.pin.length <= g.maxLength;
        if (valid)
          for (const h of await hooks(tx, d.tenantId, d.id))
            if (await argon2.verify(h.pinHash, input.pin)) selected = h;
        if (!selected || !selected.enabled || selected.state !== "AVAILABLE") {
          const failures = now - g.windowAt > 900000 ? 1 : g.failures + 1;
          await tx.devicePinGuard.update({
            where: { deviceId: d.id },
            data: {
              failures,
              windowAt: now - g.windowAt > 900000 ? now : g.windowAt,
              lockedUntil: failures >= 5 ? new Date(+now + 900000) : null,
            },
          });
          return deny();
        }
        // operation IDs are single use, including across hotels/devices.
        if (
          await tx.hookboxOperation.findUnique({
            where: { id: input.operationId },
          })
        )
          return deny();
        const mock = input.mock === true;
        // Mock declarations can only produce mock outcomes, never live outbound events.
        const op = await tx.hookboxOperation.create({
          data: {
            id: input.operationId,
            tenantId: d.tenantId,
            deviceId: d.id,
            expiresAt: new Date(+now + 120000),
            state: {
              pinHookId: selected.id,
              status: "AUTHORIZED",
              rooms: [{ room: selected.room, hook: selected.hook }],
              results: [],
              mock,
            },
          },
        });
        await tx.devicePinHook.update({
          where: { id: selected.id },
          data: { state: "BLOCKED", operationId: op.id },
        });
        await tx.devicePinGuard.update({
          where: { deviceId: d.id },
          data: { failures: 0, lockedUntil: null, windowAt: now },
        });
        return {
          schemaVersion: 1,
          operationId: op.id,
          status: "AUTHORIZED",
          expiresAt: op.expiresAt.toISOString(),
          rooms: op.state.rooms,
          results: [],
          mock,
        };
      });
    },
  };
}
