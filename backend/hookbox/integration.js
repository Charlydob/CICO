import { fail } from "../../shared/hookbox/contract.mjs";
import { endpointUrl, sendPublicJson } from "./httpTransport.js";
export const defaultOutbound = (kind = "checkin") => ({
  enabled: false,
  contractConfirmed: false,
  endpoint:
    kind === "checkout"
      ? "https://checkin.gasthaus-steinbock.ch/checkoutguest.php"
      : "https://checkin.gasthaus-steinbock.ch/checkinguest.php",
  method: "POST",
  timeZone: "Europe/Zurich",
  dateFormat: "DD.MM.YYYY HH:mm",
  fields: [
    { key: "key", source: "room", value: "" },
    {
      key: kind === "checkout" ? "check-out at" : "check-in at",
      source: "datetime",
      value: "",
    },
  ],
});
export function normalizeOutbound(raw = {}, kind = "checkin") {
  const c = { ...defaultOutbound(kind), ...raw };
  if (c.endpoint) endpointUrl(c.endpoint);
  if (!["POST", "PUT", "PATCH"].includes(c.method))
    fail("Método HTTP no compatible");
  if (
    !["DD.MM.YYYY HH:mm", "YYYY-MM-DD HH:mm:ss", "ISO8601"].includes(
      c.dateFormat,
    )
  )
    fail("Formato de fecha no compatible");
  try {
    new Intl.DateTimeFormat("en", { timeZone: c.timeZone }).format();
  } catch {
    fail("Zona horaria no válida");
  }
  if (c.enabled && (!c.endpoint || c.contractConfirmed !== true))
    fail("Confirma contrato, credenciales y autorización antes de activar");
  if (!Array.isArray(c.fields) || c.fields.length < 1 || c.fields.length > 20)
    fail("Define entre 1 y 20 campos");
  const keys = new Set();
  c.fields = c.fields.map((f) => {
    const key = String(f.key || "").trim(),
      source =
        f.source === "checkin_at"
          ? "datetime"
          : f.source === "request_id"
            ? "operationId"
            : f.source;
    if (
      !/^[A-Za-z0-9 _-]{1,64}$/.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      keys.has(key)
    )
      fail("Nombre de campo inválido o repetido");
    if (
      !["room", "datetime", "device", "operationId", "constant"].includes(
        source,
      )
    )
      fail("Origen no compatible");
    keys.add(key);
    return {
      key,
      source,
      value: source === "constant" ? String(f.value || "").slice(0, 256) : "",
    };
  });
  return {
    enabled: c.enabled === true,
    contractConfirmed: c.contractConfirmed === true,
    endpoint: c.endpoint,
    method: c.method,
    timeZone: c.timeZone,
    dateFormat: c.dateFormat,
    fields: c.fields,
  };
}
export function buildOutboundPreview(raw, input = {}) {
  const c = normalizeOutbound({ ...raw, enabled: false }),
    date = new Date(
      input.occurredAt || input.checkin_at || "2026-10-28T13:28:00Z",
    );
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: c.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  const datetime =
    c.dateFormat === "ISO8601"
      ? date.toISOString()
      : c.dateFormat === "YYYY-MM-DD HH:mm:ss"
        ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
        : `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
  const values = {
    room: "105",
    device: "HOOKBOX",
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...input,
    datetime,
  };
  return Object.fromEntries(
    c.fields.map((f) => [
      f.key,
      f.source === "constant" ? f.value : String(values[f.source] || ""),
    ]),
  );
}
async function own(tx, tenantId, id) {
  const d = await tx.device.findFirst({
    where: {
      id,
      tenantId,
      hardwareModel: { in: ["CROWPANEL_7_V3", "ESP32_DEVKIT_CHECKOUT_V1"] },
    },
  });
  if (!d) fail("Dispositivo no encontrado en este hotel", 404);
  return d;
}
export async function getDeviceIntegration(database, tenantId, id) {
  const db = database.prisma,
    d = await own(db, tenantId, id),
    s = await db.deviceHttpIntegration.findFirst({
      where: { deviceId: id, tenantId },
    });
  const outbound = normalizeOutbound(
    s?.config ||
      defaultOutbound(
        d.hardwareModel === "CROWPANEL_7_V3" ? "checkin" : "checkout",
      ),
  );
  const history = await db.deviceOutboundEvent.findMany({
    where: { deviceId: id, tenantId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      kind: true,
      state: true,
      attempts: true,
      httpStatus: true,
      httpAcceptedAt: true,
      processedAt: true,
      lastError: true,
      occurredAt: true,
      history: true,
      payload: true,
    },
  });
  return {
    outbound,
    headerNames: Object.keys(s?.secrets || {}),
    preview: buildOutboundPreview(outbound),
    history,
  };
}
export async function saveDeviceIntegration(database, tenantId, id, body) {
  await database.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM devices WHERE id=${id}::uuid FOR UPDATE`;
    const d = await own(tx, tenantId, id),
      existing = await tx.deviceHttpIntegration.findFirst({
        where: { deviceId: id, tenantId },
      });
    const config = normalizeOutbound(
      body.outbound,
      d.hardwareModel === "CROWPANEL_7_V3" ? "checkin" : "checkout",
    );
    let secrets = body.clearHeaders ? {} : { ...existing?.secrets };
    if (body.headers) {
      if (!Array.isArray(body.headers) || body.headers.length > 12)
        fail("Máximo 12 cabeceras");
      for (const h of body.headers) {
        if (
          !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(h.name) ||
          /^(host|content-|connection|transfer-encoding|idempotency-key|proxy-|cookie|expect|upgrade|te|trailer)/i.test(
            h.name,
          ) ||
          typeof h.value !== "string" ||
          /[\r\n\x00]/.test(h.value) ||
          h.value.length > 2048
        )
          fail("Cabecera no permitida");
        if (h.value) secrets[h.name.toLowerCase()] = h.value;
      }
    }
    await tx.deviceHttpIntegration.upsert({
      where: { deviceId: id },
      create: { deviceId: id, tenantId, config, secrets },
      update: { tenantId, config, secrets },
    });
  });
  return getDeviceIntegration(database, tenantId, id);
}
export async function enqueueOutbound(
  tx,
  device,
  kind,
  operationId,
  room,
  occurredAt = new Date(),
) {
  const s = await tx.deviceHttpIntegration.findFirst({
    where: { deviceId: device.id, tenantId: device.tenantId },
  });
  const config = normalizeOutbound(s?.config || defaultOutbound(kind));
  const context = {
    room,
    device: device.deviceId,
    operationId,
    occurredAt: occurredAt.toISOString(),
  };
  return tx.deviceOutboundEvent.upsert({
    where: { id: `${kind}:${operationId}` },
    update: {},
    create: {
      id: `${kind}:${operationId}`,
      deviceId: device.id,
      tenantId: device.tenantId,
      kind,
      operationId,
      occurredAt,
      context,
      config,
      payload: buildOutboundPreview(config, context),
      secretSnapshot: s?.secrets || {},
      state: config.enabled ? "PENDING" : "HELD",
    },
  });
}
export async function retryOutbound(database, tenantId, id, eventId) {
  return database.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM devices WHERE id=${id}::uuid FOR UPDATE`;
    await own(tx, tenantId, id);
    const event = await tx.deviceOutboundEvent.findFirst({
      where: { id: eventId, deviceId: id, tenantId },
    });
    const s = await tx.deviceHttpIntegration.findFirst({
      where: { deviceId: id, tenantId },
    });
    if (!event || !s?.config.enabled || !s.config.contractConfirmed)
      fail("Activa una integración confirmada para reenviar", 409);
    if (event.state === "SENDING" && event.nextAttemptAt > new Date())
      fail("Envío en curso", 409);
    const config = normalizeOutbound(s.config);
    const updated=await tx.deviceOutboundEvent.update({
      where: { id: eventId },
      data: {
        state: "PENDING",
        attempts: 0,
        nextAttemptAt: new Date(),
        config,
        secretSnapshot: s.secrets,
        payload: buildOutboundPreview(config, event.context),
        lastError: null,
        history: [
          ...event.history,
          { at: new Date().toISOString(), action: "ADMIN_RETRY" },
        ],
      },
    });
    return {id:updated.id,state:updated.state,attempts:updated.attempts,nextAttemptAt:updated.nextAttemptAt};
  });
}
export function createOutboundWorker(prisma, send = sendPublicJson) {
  return async function runOnce() {
    const now = new Date();
    const candidates = await prisma.deviceOutboundEvent.findMany({
      where: {
        state: { in: ["PENDING", "RETRY", "SENDING"] },
        nextAttemptAt: { lte: now },
      },
      orderBy: { nextAttemptAt: "asc" },
      take: 10,
    });
    for (const candidate of candidates) {
      const event = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM devices WHERE id=${candidate.deviceId}::uuid FOR UPDATE`;
        const e = await tx.deviceOutboundEvent.findUnique({
          where: { id: candidate.id },
        });
        if (
          !e ||
          !["PENDING", "RETRY", "SENDING"].includes(e.state) ||
          e.nextAttemptAt > now
        )
          return null;
        const d = await tx.device.findUnique({ where: { id: e.deviceId } }),
          s = await tx.deviceHttpIntegration.findFirst({
            where: { deviceId: e.deviceId, tenantId: e.tenantId },
          });
        if (
          d?.tenantId !== e.tenantId ||
          !s?.config.enabled ||
          !s.config.contractConfirmed
        ) {
          await tx.deviceOutboundEvent.update({
            where: { id: e.id },
            data: { state: "HELD" },
          });
          return null;
        }
        if (e.attempts >= 8) {
          await tx.deviceOutboundEvent.update({
            where: { id: e.id },
            data: { state: "FAILED", lastError: "RETRY_LIMIT" },
          });
          return null;
        }
        return {
          ...(await tx.deviceOutboundEvent.update({
            where: { id: e.id },
            data: {
              state: "SENDING",
              attempts: { increment: 1 },
              nextAttemptAt: new Date(+now + 60000),
            },
          })),
          secrets: e.secretSnapshot,
        };
      });
      if (!event) continue;
      let httpStatus = null,
        error = null;
      try {
        httpStatus = await send(
          event.config,
          event.payload,
          event.secrets,
          event.id,
        );
      } catch {
        error = "NETWORK_OR_DESTINATION_ERROR";
      }
      const accepted = httpStatus >= 200 && httpStatus < 300,
        temporary =
          !httpStatus ||
          [408, 425, 429].includes(httpStatus) ||
          httpStatus >= 500;
      const at = new Date();
      const state = accepted
        ? "HTTP_ACCEPTED"
        : temporary && event.attempts < 8
          ? "RETRY"
          : "FAILED";
      await prisma.deviceOutboundEvent.update({
        where: { id: event.id },
        data: {
          state,
          httpStatus,
          lastError: error || (!accepted ? `HTTP_${httpStatus}` : null),
          ...(accepted ? { httpAcceptedAt: at } : {}),
          nextAttemptAt: new Date(
            +at + Math.min(3600000, 5000 * 2 ** event.attempts),
          ),
          history: [
            ...event.history,
            {
              at: at.toISOString(),
              attempt: event.attempts,
              httpStatus,
              state,
              error,
            },
          ],
        },
      });
    }
  };
}
// Old hotel authorization endpoints are deliberately retired.
export async function rotateDeviceWebhookSecret() {
  fail("La autorización por webhook se ha retirado", 410);
}
export async function receiveDeviceWebhook() {
  fail("La autorización por webhook se ha retirado", 410);
}
