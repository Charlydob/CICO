import { randomUUID } from "node:crypto";
import webpush from "web-push";
import {
  canManageHousekeeping,
  canUseHousekeeping,
} from "./housekeepingPermissions.js";

const WEB_PUSH_CONFIG_ID = "global";
export const DEFAULT_VAPID_SUBJECT = "https://hotelapp.charlydob.com";
const DEAD_SUBSCRIPTION_STATUS = new Set([404, 410]);
const SENSITIVE_HEADER_PATTERN = /authorization|cookie|token|secret|key/i;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 4000;

let generateVapidKeys = () => webpush.generateVAPIDKeys();
let sendNotification = (subscription, payload) => webpush.sendNotification(subscription, payload);

export function setWebPushTestHooks(hooks = {}) {
  const previous = { generateVapidKeys, sendNotification };

  if (hooks.generateVapidKeys) {
    generateVapidKeys = hooks.generateVapidKeys;
  }

  if (hooks.sendNotification) {
    sendNotification = hooks.sendNotification;
  }

  return () => {
    generateVapidKeys = previous.generateVapidKeys;
    sendNotification = previous.sendNotification;
  };
}

function now() {
  return new Date().toISOString();
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function boolOr(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

export function resolveVapidSubject(env = process.env) {
  return cleanString(env.VAPID_SUBJECT) || cleanString(env.WEB_PUSH_SUBJECT) || DEFAULT_VAPID_SUBJECT;
}

function truncateDiagnosticText(value, maxLength = MAX_DIAGNOSTIC_TEXT_LENGTH) {
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
}

function normalizeStatusCode(value) {
  const statusCode = Number(value?.statusCode || value?.status);
  return Number.isFinite(statusCode) ? statusCode : undefined;
}

function normalizeDiagnosticBody(body) {
  if (body === undefined || body === null || body === "") {
    return undefined;
  }

  if (Buffer.isBuffer(body)) {
    return truncateDiagnosticText(body.toString("utf8"));
  }

  if (typeof body === "string") {
    return truncateDiagnosticText(body);
  }

  if (typeof body === "object") {
    try {
      return JSON.parse(JSON.stringify(body));
    } catch {
      return truncateDiagnosticText(body);
    }
  }

  return truncateDiagnosticText(body);
}

function normalizeDiagnosticHeaders(headers) {
  if (!headers) {
    return undefined;
  }

  const entries = [];
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => entries.push([key, value]));
  } else if (typeof headers.entries === "function") {
    entries.push(...headers.entries());
  } else if (Array.isArray(headers)) {
    entries.push(...headers);
  } else if (typeof headers === "object") {
    entries.push(...Object.entries(headers));
  }

  const safeHeaders = {};
  for (const [name, value] of entries) {
    const key = cleanString(name).toLowerCase();
    if (!key || SENSITIVE_HEADER_PATTERN.test(key)) {
      continue;
    }

    const text = Array.isArray(value)
      ? value.map((item) => truncateDiagnosticText(item, 1000)).join(", ")
      : truncateDiagnosticText(value, 1000);
    if (text) {
      safeHeaders[key] = text;
    }
  }

  return Object.keys(safeHeaders).length ? safeHeaders : undefined;
}

function providerReasonFromBody(body) {
  if (!body) {
    return "";
  }

  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    return cleanString(parsed?.reason || parsed?.error?.reason);
  } catch {
    return "";
  }
}

function webPushFailureDiagnostics(error) {
  const body = normalizeDiagnosticBody(error?.body);
  const headers = normalizeDiagnosticHeaders(error?.headers);
  const providerReason =
    cleanString(error?.reason) ||
    providerReasonFromBody(body) ||
    providerReasonFromBody(error?.body);

  return {
    statusCode: normalizeStatusCode(error),
    message: error instanceof Error ? error.message : "Web Push failed.",
    ...(body !== undefined ? { body } : {}),
    ...(headers ? { headers } : {}),
    ...(providerReason ? { providerReason } : {}),
  };
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    endpoint: subscription.endpoint,
    userAgent: subscription.userAgent || "",
    createdAt: subscription.createdAt || "",
    updatedAt: subscription.updatedAt || "",
    lastSuccessAt: subscription.lastSuccessAt || null,
    lastFailureAt: subscription.lastFailureAt || null,
    disabledAt: subscription.disabledAt || null,
  };
}

function defaultPreference(userId, tenantId, enabled = false) {
  return {
    id: "",
    userId,
    tenantId,
    enabled,
    newCheckout: true,
    assignedToMe: true,
    roomCompleted: false,
  };
}

async function listRecords(database, collection) {
  try {
    return await database.listRecords(collection);
  } catch {
    return [];
  }
}

async function getRecord(database, collection, id) {
  try {
    return await database.getRecord(collection, id);
  } catch {
    return undefined;
  }
}

function normalizeBrowserSubscription(input = {}) {
  const endpoint = cleanString(input.endpoint);
  const keys = input.keys && typeof input.keys === "object" ? input.keys : {};
  const p256dh = cleanString(input.p256dh || keys.p256dh);
  const auth = cleanString(input.auth || keys.auth);

  if (!endpoint || !p256dh || !auth) {
    const error = new Error("A valid browser PushSubscription is required.");
    error.statusCode = 400;
    throw error;
  }

  return { endpoint, p256dh, auth };
}

async function findSubscriptionByEndpoint(database, endpoint) {
  return (await listRecords(database, "pushSubscriptions")).find(
    (subscription) => subscription.endpoint === endpoint,
  );
}

async function findSubscriptionForUser(database, userId, endpoint) {
  return (await listRecords(database, "pushSubscriptions")).find(
    (subscription) => subscription.userId === userId && subscription.endpoint === endpoint,
  );
}

async function activeSubscriptionsForUser(database, userId) {
  return (await listRecords(database, "pushSubscriptions")).filter(
    (subscription) => subscription.userId === userId && !subscription.disabledAt,
  );
}

export async function ensureWebPushConfig(database) {
  const existing = await getRecord(database, "webPushConfigs", WEB_PUSH_CONFIG_ID);

  if (existing?.publicKey && existing?.privateKey) {
    return existing;
  }

  const keys = generateVapidKeys();
  const timestamp = now();

  try {
    return await database.setRecord("webPushConfigs", WEB_PUSH_CONFIG_ID, {
      id: WEB_PUSH_CONFIG_ID,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (error) {
    const concurrent = await getRecord(database, "webPushConfigs", WEB_PUSH_CONFIG_ID);
    if (concurrent?.publicKey && concurrent?.privateKey) {
      return concurrent;
    }

    throw error;
  }
}

export async function getPushPreference(database, userId, tenantId) {
  if (!tenantId) {
    return undefined;
  }

  const existing = (await listRecords(database, "pushPreferences")).find(
    (preference) => preference.userId === userId && preference.tenantId === tenantId,
  );

  return existing || defaultPreference(userId, tenantId, false);
}

export async function updatePushPreference(database, userId, tenantId, patch = {}) {
  if (!tenantId) {
    const error = new Error("An active tenant is required.");
    error.statusCode = 403;
    throw error;
  }

  const existing = (await listRecords(database, "pushPreferences")).find(
    (preference) => preference.userId === userId && preference.tenantId === tenantId,
  );
  const timestamp = now();
  const next = {
    ...(existing || {
      id: randomUUID(),
      userId,
      tenantId,
      createdAt: timestamp,
    }),
    enabled: boolOr(patch.enabled, existing?.enabled ?? true),
    newCheckout: boolOr(patch.newCheckout, existing?.newCheckout ?? true),
    assignedToMe: boolOr(patch.assignedToMe, existing?.assignedToMe ?? true),
    roomCompleted: boolOr(patch.roomCompleted, existing?.roomCompleted ?? false),
    updatedAt: timestamp,
  };

  return database.setRecord("pushPreferences", next.id, next);
}

export async function getPushStatus(database, { userId, tenantId }) {
  const config = await ensureWebPushConfig(database);
  const subscriptions = (await listRecords(database, "pushSubscriptions")).filter(
    (subscription) => subscription.userId === userId,
  );
  const activeSubscriptions = subscriptions.filter((subscription) => !subscription.disabledAt);

  return {
    supported: true,
    configured: Boolean(config.publicKey),
    vapidPublicKey: config.publicKey,
    subscriptionCount: activeSubscriptions.length,
    subscriptions: subscriptions.map(publicSubscription),
    preference: tenantId ? await getPushPreference(database, userId, tenantId) : undefined,
  };
}

export async function subscribeUserPush(database, { userId, tenantId, subscription, userAgent }) {
  await ensureWebPushConfig(database);
  const browserSubscription = normalizeBrowserSubscription(subscription);
  const existing = await findSubscriptionByEndpoint(database, browserSubscription.endpoint);
  const timestamp = now();
  const record = {
    ...(existing || { id: randomUUID(), createdAt: timestamp, failureCount: 0 }),
    userId,
    endpoint: browserSubscription.endpoint,
    p256dh: browserSubscription.p256dh,
    auth: browserSubscription.auth,
    userAgent: cleanString(userAgent),
    failureCount: 0,
    disabledAt: null,
    updatedAt: timestamp,
  };

  const saved = await database.setRecord("pushSubscriptions", record.id, record);

  if (tenantId) {
    await updatePushPreference(database, userId, tenantId, { enabled: true });
  }

  return publicSubscription(saved);
}

export async function unsubscribeUserPush(database, { userId, endpoint }) {
  const cleanEndpoint = cleanString(endpoint);
  if (!cleanEndpoint) {
    const error = new Error("Push subscription endpoint is required.");
    error.statusCode = 400;
    throw error;
  }

  const subscription = await findSubscriptionForUser(database, userId, cleanEndpoint);
  if (!subscription) {
    return { success: true, disabled: false };
  }

  await database.setRecord("pushSubscriptions", subscription.id, {
    ...subscription,
    disabledAt: now(),
    updatedAt: now(),
  });

  return { success: true, disabled: true };
}

function browserSubscription(subscription) {
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  };
}

async function markPushSuccess(database, subscription) {
  await database.setRecord("pushSubscriptions", subscription.id, {
    ...subscription,
    failureCount: 0,
    lastSuccessAt: now(),
    lastFailureAt: subscription.lastFailureAt || null,
    disabledAt: null,
    updatedAt: now(),
  });
}

async function markPushFailure(database, subscription, error) {
  const statusCode = normalizeStatusCode(error);
  const dead = DEAD_SUBSCRIPTION_STATUS.has(statusCode);

  await database.setRecord("pushSubscriptions", subscription.id, {
    ...subscription,
    failureCount: Number(subscription.failureCount || 0) + 1,
    lastFailureAt: now(),
    disabledAt: dead ? now() : subscription.disabledAt || null,
    updatedAt: now(),
  });

  return { statusCode, dead };
}

export async function sendPushToSubscription(database, subscription, payload) {
  if (!subscription || subscription.disabledAt) {
    return { sent: false, skipped: true };
  }

  const config = await ensureWebPushConfig(database);
  webpush.setVapidDetails(resolveVapidSubject(), config.publicKey, config.privateKey);

  try {
    const response = await sendNotification(browserSubscription(subscription), JSON.stringify(payload));
    await markPushSuccess(database, subscription);
    return { sent: true, httpStatus: normalizeStatusCode(response) };
  } catch (error) {
    const diagnostics = webPushFailureDiagnostics(error);
    const failure = await markPushFailure(database, subscription, diagnostics);
    return {
      sent: false,
      error: diagnostics.message,
      httpStatus: diagnostics.statusCode,
      providerReason: diagnostics.providerReason || "",
      disabled: failure.dead,
      diagnostics,
    };
  }
}

function notificationUrl(tenant, room) {
  const slug = cleanString(tenant?.slug);
  const roomNumber = cleanString(room?.number);

  return `${slug ? `/t/${encodeURIComponent(slug)}/` : "/"}${
    roomNumber ? `?housekeepingRoom=${encodeURIComponent(roomNumber)}` : ""
  }`;
}

async function pendingBadgeCount(database, tenantId) {
  const [rooms, events, tenant] = await Promise.all([
    database.listTenantRecords("rooms", tenantId).catch(() => []),
    database.listTenantRecords("checkoutEvents", tenantId).catch(() => []),
    getRecord(database, "tenants", tenantId),
  ]);
  const timezone = tenant?.basicInfo?.timezone || "UTC";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const eventRoomIds = new Set(
    events
      .filter((event) => {
        const eventDay = new Intl.DateTimeFormat("en-CA", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(event.timestamp));
        return eventDay === today;
      })
      .map((event) => event.roomId),
  );

  return rooms.filter(
    (room) =>
      room.active !== false &&
      !room.deletedAt &&
      ["ready_for_cleaning", "cleaning"].includes(room.status) &&
      eventRoomIds.has(room.id),
  ).length;
}

function basePayload({ type, tenant, room, event, title, body, url, badge }) {
  return {
    type,
    title,
    body,
    url: url || notificationUrl(tenant, room),
    badge,
    tenantId: tenant?.id || event?.tenantId || "",
    tenantSlug: tenant?.slug || "",
    roomId: room?.id || event?.roomId || "",
    roomNumber: room?.number || "",
    eventId: event?.id || "",
    timestamp: now(),
  };
}

async function roleForUser(database, tenantId, user) {
  if (user.globalRole === "platform_admin") {
    return "platform_admin";
  }

  const membership = (await listRecords(database, "memberships")).find(
    (candidate) => candidate.tenantId === tenantId && candidate.userId === user.id,
  );

  return membership?.role || "";
}

async function recipientsForTenant(database, tenantId, predicate) {
  const [users, memberships, preferences] = await Promise.all([
    listRecords(database, "users"),
    listRecords(database, "memberships"),
    listRecords(database, "pushPreferences"),
  ]);
  const userIds = new Set(
    memberships
      .filter((membership) => membership.tenantId === tenantId)
      .map((membership) => membership.userId),
  );

  for (const preference of preferences.filter((item) => item.tenantId === tenantId)) {
    const user = users.find((candidate) => candidate.id === preference.userId);
    if (user?.globalRole === "platform_admin") {
      userIds.add(user.id);
    }
  }

  const recipients = [];

  for (const userId of userIds) {
    const user = users.find((candidate) => candidate.id === userId && candidate.active !== false);
    if (!user) {
      continue;
    }

    const role = await roleForUser(database, tenantId, user);
    const preference = preferences.find(
      (candidate) => candidate.userId === user.id && candidate.tenantId === tenantId,
    );

    if (preference?.enabled && predicate({ user, role, preference })) {
      recipients.push({ user, role, preference });
    }
  }

  return recipients;
}

async function sendPayloadToUser(database, userId, payload) {
  const subscriptions = await activeSubscriptionsForUser(database, userId);
  const results = await Promise.allSettled(
    subscriptions.map((subscription) => sendPushToSubscription(database, subscription, payload)),
  );

  return results.map((result) =>
    result.status === "fulfilled" ? result.value : { sent: false, error: result.reason?.message },
  );
}

export async function sendNewCheckoutPush(database, { tenant, room, event }) {
  const badge = await pendingBadgeCount(database, tenant.id);
  const payload = basePayload({
    type: "housekeeping.new_checkout",
    tenant,
    room,
    event,
    badge,
    title: `🧹 Habitacion ${room.number}`,
    body: "Checkout recibido. Lista para limpieza.",
  });
  const recipients = await recipientsForTenant(
    database,
    tenant.id,
    ({ role, preference }) => canUseHousekeeping(role) && Boolean(preference.newCheckout),
  );

  const results = await Promise.allSettled(
    recipients.map((recipient) => sendPayloadToUser(database, recipient.user.id, payload)),
  );

  return { recipients: recipients.length, results };
}

export async function sendRfidReturnPush(database, { tenant, room, event }) {
  const badge = await pendingBadgeCount(database, tenant.id);
  const payload = basePayload({
    type: "checkout.rfid_return_recorded",
    tenant,
    room,
    event,
    badge,
    title: "Nueva devolución registrada",
    body: `Habitación ${room.number} · lectura RFID autorizada.`,
  });
  const recipients = await recipientsForTenant(
    database,
    tenant.id,
    ({ role, preference }) => canUseHousekeeping(role) && Boolean(preference.newCheckout),
  );
  const results = await Promise.allSettled(
    recipients.map((recipient) => sendPayloadToUser(database, recipient.user.id, payload)),
  );

  return { recipients: recipients.length, results };
}

export async function sendAssignmentPush(database, { tenant, room, event, assignedUserId }) {
  const preference = await getPushPreference(database, assignedUserId, tenant.id);
  if (!preference?.enabled || !preference.assignedToMe) {
    return { recipients: 0, skipped: true };
  }

  const badge = await pendingBadgeCount(database, tenant.id);
  const payload = basePayload({
    type: "housekeeping.assigned",
    tenant,
    room,
    event,
    badge,
    title: `👤 Habitacion ${room.number} asignada`,
    body: "Esta habitacion ha sido asignada a ti.",
  });
  const results = await sendPayloadToUser(database, assignedUserId, payload);

  return { recipients: results.length ? 1 : 0, results };
}

export async function sendRoomCompletedPush(database, { tenant, room, event, actorUser }) {
  const badge = await pendingBadgeCount(database, tenant.id);
  const payload = basePayload({
    type: "housekeeping.completed",
    tenant,
    room,
    event,
    badge,
    title: `✅ Habitacion ${room.number} terminada`,
    body: `Finalizada por ${actorUser?.displayName || actorUser?.email || "HotelApp"}.`,
  });
  const recipients = await recipientsForTenant(
    database,
    tenant.id,
    ({ role, preference }) => canManageHousekeeping(role) && Boolean(preference.roomCompleted),
  );
  const results = await Promise.allSettled(
    recipients.map((recipient) => sendPayloadToUser(database, recipient.user.id, payload)),
  );

  return { recipients: recipients.length, results };
}

export async function sendTestPushToSubscription(database, { userId, endpoint, tenant, title, body, url }) {
  const subscription = await findSubscriptionForUser(database, userId, endpoint);
  if (!subscription || subscription.disabledAt) {
    const error = new Error("Push subscription not found for this device.");
    error.statusCode = 404;
    throw error;
  }

  const payload = basePayload({
    type: "push.test",
    tenant,
    room: undefined,
    event: undefined,
    title: title || "🔔 HotelApp",
    body: body || "Las notificaciones Web Push funcionan correctamente.",
    url: url || (tenant?.slug ? `/t/${encodeURIComponent(tenant.slug)}/` : "/"),
    badge: 0,
  });

  return sendPushToSubscription(database, subscription, payload);
}

export async function schedulePush(database, input = {}) {
  const endpoint = cleanString(input.endpoint);
  const subscription = endpoint
    ? await findSubscriptionForUser(database, input.userId, endpoint)
    : undefined;

  if (endpoint && (!subscription || subscription.disabledAt)) {
    const error = new Error("Push subscription not found for this device.");
    error.statusCode = 404;
    throw error;
  }

  const timestamp = now();
  const record = {
    id: randomUUID(),
    userId: input.userId,
    tenantId: input.tenantId,
    subscriptionId: subscription?.id || cleanString(input.subscriptionId) || null,
    endpoint: endpoint || subscription?.endpoint || "",
    title: cleanString(input.title) || "🔔 HotelApp",
    body: cleanString(input.body) || "Las notificaciones Web Push funcionan correctamente.",
    url: cleanString(input.url) || "/",
    sendAt: input.sendAt instanceof Date ? input.sendAt.toISOString() : cleanString(input.sendAt),
    status: "pending",
    error: "",
    httpStatus: null,
    providerReason: "",
    createdAt: timestamp,
  };

  return database.setRecord("scheduledPushes", record.id, record);
}

function publicScheduledPushStatus(scheduled) {
  const httpStatus = normalizeStatusCode({
    statusCode: scheduled.httpStatus,
  });

  return {
    id: scheduled.id,
    status: ["pending", "sending", "sent", "failed"].includes(scheduled.status)
      ? scheduled.status
      : "pending",
    sendAt: scheduled.sendAt,
    sentAt: scheduled.sentAt || null,
    error: scheduled.error || "",
    providerReason: scheduled.providerReason || "",
    ...(httpStatus ? { httpStatus } : {}),
  };
}

export async function getScheduledPushStatus(database, { id, userId, tenantId }) {
  const scheduled = await getRecord(database, "scheduledPushes", cleanString(id));
  if (!scheduled || scheduled.userId !== userId || scheduled.tenantId !== tenantId) {
    const error = new Error("Scheduled push test not found.");
    error.statusCode = 404;
    throw error;
  }

  return publicScheduledPushStatus(scheduled);
}

export async function processDueScheduledPushes(database, { limit = 20 } = {}) {
  const due = (await listRecords(database, "scheduledPushes"))
    .filter((item) => item.status === "pending" && new Date(item.sendAt).getTime() <= Date.now())
    .sort((left, right) => new Date(left.sendAt).getTime() - new Date(right.sendAt).getTime())
    .slice(0, limit);
  const results = [];

  for (const scheduled of due) {
    await database.setRecord("scheduledPushes", scheduled.id, {
      ...scheduled,
      status: "sending",
      error: "",
      providerReason: "",
      httpStatus: null,
    });

    try {
      const subscription =
        (scheduled.subscriptionId
          ? await getRecord(database, "pushSubscriptions", scheduled.subscriptionId)
          : undefined) ||
        (scheduled.endpoint
          ? await findSubscriptionForUser(database, scheduled.userId, scheduled.endpoint)
          : undefined);
      const tenant = await getRecord(database, "tenants", scheduled.tenantId);

      if (!subscription || subscription.disabledAt) {
        throw new Error("Push subscription is no longer active.");
      }

      const sent = await sendPushToSubscription(
        database,
        subscription,
        basePayload({
          type: "push.scheduled_test",
          tenant,
          title: scheduled.title,
          body: scheduled.body,
          url: scheduled.url,
          badge: 0,
        }),
      );

      if (!sent.sent) {
        const message = sent.error || sent.providerReason || "Web Push failed.";
        const updated = await database.setRecord("scheduledPushes", scheduled.id, {
          ...scheduled,
          status: "failed",
          error: message,
          httpStatus: sent.httpStatus || null,
          providerReason: sent.providerReason || "",
        });
        results.push({
          scheduledPush: updated,
          sent: false,
          error: message,
          providerReason: sent.providerReason || "",
        });
        continue;
      }

      const updated = await database.setRecord("scheduledPushes", scheduled.id, {
        ...scheduled,
        status: "sent",
        sentAt: now(),
        error: "",
        httpStatus: sent.httpStatus || null,
        providerReason: "",
      });
      results.push({ scheduledPush: updated, sent: true });
    } catch (error) {
      const diagnostics = webPushFailureDiagnostics(error);
      const updated = await database.setRecord("scheduledPushes", scheduled.id, {
        ...scheduled,
        status: "failed",
        error: diagnostics.message,
        httpStatus: diagnostics.statusCode || null,
        providerReason: diagnostics.providerReason || "",
      });
      results.push({
        scheduledPush: updated,
        sent: false,
        error: diagnostics.message,
        providerReason: diagnostics.providerReason || "",
      });
    }
  }

  return results;
}
