import { createServer } from "node:http";
import { handleOtaRoute } from "./routes/otaRoutes.js";
import { createOtaService } from "./services/otaService.js";
import { createFirmwareStorage } from "./services/firmwareStorage.js";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import Stripe from "stripe";
import { STRIPE_FIELD_MAPPING } from "./config/stripeMapping.js";
import {
  getFrigateSettings,
  getReservationSettings,
  getStripeSettings,
  loadLocalSettings,
} from "./localSettings.js";
import { MODULE_REGISTRY } from "./moduleRegistry.js";
import { authenticateRequest } from "./middleware/auth.js";
import { createRateLimiter } from "./rateLimiter.js";
import { handleAdminRoute } from "./routes/adminRoutes.js";
import {
  handleCheckoutRoute,
  handlePublicCheckoutRoute,
} from "./routes/checkoutRoutes.js";
import { handleHousekeepingRoute } from "./routes/housekeepingRoutes.js";
import { handleInvitationRoute } from "./routes/invitationRoutes.js";
import { handlePushRoute } from "./routes/pushRoutes.js";
import { handleUserManagementRoute } from "./routes/userManagementRoutes.js";
import { handleVersionRoute } from "./routes/versionRoutes.js";
import {
  DEFAULT_TENANT_ID,
  ensureBootstrapTenant,
  requireModule,
  requireTenant,
  requireTenantAdmin,
} from "./services/tenantService.js";
import {
  getTenantSettings,
  getPublicTenantSettings,
  updateTenantSettings,
} from "./services/tenantSettingsService.js";
import { sendTestCheckoutNotification } from "./services/notificationService.js";
import { processDueScheduledPushes } from "./services/webPushService.js";
import {
  connectTelegramChat,
  connectTelegramStaff,
  createStaffPairingCode,
  createTelegramPairingCode,
  disconnectTelegramChat,
  getHousekeepingBoard,
  getHousekeepingStaff,
  handleHousekeepingAction,
  registerManualTelegramCheckout,
  saveHousekeepingBoardMessage,
  saveCheckoutTelegramMessage,
  validateTelegramIntegrationSecret,
} from "./services/telegramIntegrationService.js";
import {
  clearSessionCookieHeader,
  loginWithPassword,
  sessionCookieHeader,
  destroyRequestSession,
} from "./services/sessionService.js";

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");

  try {
    const raw = readFileSync(envPath, "utf8");

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=").replace(/^['"]|['"]$/g, "");

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function sendJson(response, statusCode, payload, headers = {}, request) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...corsHeaders(request),
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function corsHeaders(request) {
  const allowedOrigin = process.env.CORS_ORIGIN || process.env.APP_ORIGIN || "";
  const requestOrigin = request?.headers?.origin;

  return {
    "Access-Control-Allow-Origin": allowedOrigin || requestOrigin || "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Stripe-Signature, X-Tenant-Id, X-Tenant-Slug, X-HotelApp-Secret",
  };
}

async function sendEvidenceFile(response, filePath, contentType) {
  try {
    await stat(filePath);
  } catch {
    sendJson(response, 404, { error: "Evidence file not found." });
    return;
  }

  response.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  const rawBody = await readRawBody(request);

  if (rawBody.length === 0) {
    return {};
  }

  return JSON.parse(rawBody.toString("utf8"));
}

async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function getMetadataValue(metadata, fieldName) {
  const value = metadata?.[fieldName];
  return typeof value === "string" ? value.trim() : "";
}

function extractStripeCheckInInput(stripeEvent) {
  const stripeObject = stripeEvent.data.object;
  const metadata = stripeObject.metadata || {};
  const reservationCode = getMetadataValue(
    metadata,
    STRIPE_FIELD_MAPPING.reservationNumber,
  );
  const metadataFullName = getMetadataValue(metadata, STRIPE_FIELD_MAPPING.fullName);
  const metadataEmail = getMetadataValue(metadata, "email");
  const fullName =
    metadataFullName ||
    (typeof stripeObject.customer_details?.name === "string"
      ? stripeObject.customer_details.name.trim()
      : "");
  const email =
    metadataEmail ||
    (typeof stripeObject.customer_details?.email === "string"
      ? stripeObject.customer_details.email.trim()
      : "") ||
    (typeof stripeObject.receipt_email === "string" ? stripeObject.receipt_email.trim() : "");
  const paymentStatus =
    typeof stripeObject.payment_status === "string"
      ? stripeObject.payment_status
      : stripeObject.status;

  if (stripeEvent.type === "checkout.session.completed") {
    return {
      reservationCode,
      fullName,
      email,
      checkInAt: new Date(stripeEvent.created * 1000).toISOString(),
      source: "stripe",
      stripeEventId: stripeEvent.id,
      stripePaymentIntentId:
        typeof stripeObject.payment_intent === "string"
          ? stripeObject.payment_intent
          : stripeObject.payment_intent?.id,
      stripeCheckoutSessionId: stripeObject.id,
      paymentStatus,
      metadata,
    };
  }

  if (stripeEvent.type === "payment_intent.succeeded") {
    return {
      reservationCode,
      fullName,
      email,
      checkInAt: new Date(stripeEvent.created * 1000).toISOString(),
      source: "stripe",
      stripeEventId: stripeEvent.id,
      stripePaymentIntentId: stripeObject.id,
      paymentStatus,
      metadata,
    };
  }

  return undefined;
}

function cleanJsonAuthInput(nextAuth = {}, currentAuth = {}) {
  const type = ["none", "bearer", "apiKey", "basic"].includes(nextAuth.type)
    ? nextAuth.type
    : currentAuth.type || "none";

  if (type === "none") {
    return { type: "none" };
  }

  return {
    type,
    bearerToken: String(nextAuth.bearerToken ?? "").trim() || currentAuth.bearerToken || "",
    apiKeyHeader:
      String(nextAuth.apiKeyHeader ?? "").trim() || currentAuth.apiKeyHeader || "x-api-key",
    apiKeyValue: String(nextAuth.apiKeyValue ?? "").trim() || currentAuth.apiKeyValue || "",
    basicUsername:
      String(nextAuth.basicUsername ?? "").trim() || currentAuth.basicUsername || "",
    basicPassword:
      String(nextAuth.basicPassword ?? "").trim() || currentAuth.basicPassword || "",
  };
}

function getHeaderValue(headers, headerName) {
  return headers[String(headerName || "").toLowerCase()];
}

function verifyReservationWebhook(request) {
  const { reservationWebhook } = getReservationSettings();

  if (!reservationWebhook.secret) {
    return true;
  }

  return getHeaderValue(request.headers, reservationWebhook.headerName) === reservationWebhook.secret;
}

loadEnvFile();
await loadLocalSettings();

const [
  { createEventProcessor },
  {
    forceRefreshReservations,
    getReservations,
    getReservationDebug,
    getReservationDiagnostics,
    previewReservationSource,
    saveReservationWebhookPayload,
    testReservationMapping,
    testReservationConnection,
  },
  { createFileStorage },
  { createDatabaseClient },
  { createFrigateClient },
  { createPlateCooldownStore },
  { createProcessedEventsStore },
] = await Promise.all([
  import("./eventProcessor.js"),
  import("./reservationService.js"),
  import("./fileStorage.js"),
  import("./databaseClient.js"),
  import("./frigateClient.js"),
  import("./plateCooldown.js"),
  import("./processedEvents.js"),
]);

const port = Number(process.env.BACKEND_PORT || 3001);
const host = process.env.BACKEND_HOST || "0.0.0.0";
const status = {
  running: true,
  frigateConnected: false,
  lastPollAt: null,
  lastEventProcessed: null,
  frigateLastEvent: null,
  frigateVersion: null,
};

const database = createDatabaseClient();
const firmwareStorage = createFirmwareStorage();
const otaService = createOtaService(database.prisma, firmwareStorage);
const deviceLimiter = createRateLimiter({ windowMs: 60_000, max: 240 });
await ensureBootstrapTenant(database);
const publicCheckoutLimiter = createRateLimiter({
  windowMs: Number(process.env.PUBLIC_CHECKOUT_RATE_WINDOW_MS || 60_000),
  max: Number(process.env.PUBLIC_CHECKOUT_RATE_LIMIT || 30),
});
let cachedFrigateClient;
let cachedFrigateBaseUrl = "";
function getActiveFrigateClient() {
  const { baseUrl } = getFrigateSettings();

  if (!cachedFrigateClient || cachedFrigateBaseUrl !== baseUrl) {
    cachedFrigateBaseUrl = baseUrl;
    cachedFrigateClient = createFrigateClient({ baseUrl });
  }

  return cachedFrigateClient;
}
const frigateClient = {
  get baseUrl() {
    return getActiveFrigateClient().baseUrl;
  },
  testConnection() {
    return getActiveFrigateClient().testConnection();
  },
  getVersion() {
    return getActiveFrigateClient().getVersion();
  },
  getRecentCarEvents() {
    return getActiveFrigateClient().getRecentCarEvents();
  },
  getSnapshotBuffer(eventId) {
    return getActiveFrigateClient().getSnapshotBuffer(eventId);
  },
  getClipBuffer(eventId) {
    return getActiveFrigateClient().getClipBuffer(eventId);
  },
};
const fileStorage = createFileStorage();
const processedEvents = await createProcessedEventsStore();
const processedStripeEvents = await createProcessedEventsStore(
  path.resolve(
    process.cwd(),
    process.env.PROCESSED_STRIPE_EVENTS_PATH ||
      path.join(process.env.DATA_DIR || "backend/data", "processed-stripe-events.json"),
  ),
);
const plateCooldown = await createPlateCooldownStore();
function getStripeClient(secretKey = getStripeSettings().secretKey) {
  return secretKey ? new Stripe(secretKey) : undefined;
}
await fileStorage.ensureDirectories();

const eventProcessor = createEventProcessor({
  database,
  frigateClient,
  fileStorage,
  processedEvents,
  plateCooldown,
  tenantId: DEFAULT_TENANT_ID,
  onDetectionStored(detection) {
    status.lastEventProcessed = detection.detectedAt;
  },
  onCheckInStored(checkIn) {
    status.lastCheckInCreated = checkIn.createdAt;
  },
});

function detectionBelongsToTenant(detection, tenantId) {
  return detection?.tenantId === tenantId || (!detection?.tenantId && tenantId === DEFAULT_TENANT_ID);
}

function requireDetectionForTenant(detection, tenantId) {
  if (!detectionBelongsToTenant(detection, tenantId)) {
    const error = new Error("Detection not found.");
    error.statusCode = 404;
    throw error;
  }
}

function sendRouteResult(response, result) {
  if (!result) {
    return false;
  }

  sendJson(response, result.status, result.payload, result.headers || {});
  return true;
}

async function getProtectedContext(request) {
  const session = await authenticateRequest(request, database);
  return { database, session, publicCheckoutLimiter };
}

function logUnexpectedError(scope, error) {
  const statusCode = error?.statusCode || 500;

  if (statusCode >= 500) {
    console.error(`[${scope}] Unexpected error`);
    console.error(error?.stack || error);
  }
}

function publicCheckoutErrorPayload(error) {
  const statusCode = error?.statusCode && error.statusCode < 500 ? error.statusCode : 503;
  const code =
    error?.code && statusCode < 500 ? error.code : "CHECKOUT_TEMPORARILY_UNAVAILABLE";
  const knownMessages = {
    QR_INVALID: "This checkout QR is not valid.",
    QR_DEACTIVATED: "This checkout QR is no longer active.",
    CHECKOUT_ATTEMPT_INVALID: "This checkout page is no longer valid.",
    CHECKOUT_ATTEMPT_EXPIRED: "This checkout page is no longer valid.",
    STALE_CHECKOUT_ATTEMPT: "This checkout page is no longer valid.",
    CHECKOUT_ALREADY_RECEIVED: "Checkout has already been received for this stay.",
    RATE_LIMITED: "Too many checkout attempts. Please wait a moment.",
  };

  return {
    statusCode,
    payload: {
      error: knownMessages[code] || "Checkout is temporarily unavailable. Please try again.",
      code,
    },
  };
}

try {
  await forceRefreshReservations();
} catch {
  // The diagnostics endpoints expose the reservation load error.
}

let polling = false;
let scheduledPushPolling = false;

async function pollFrigate() {
  if (polling) {
    return;
  }

  polling = true;
  status.lastPollAt = new Date().toISOString();

  try {
    await eventProcessor.refreshExpiredPlateStates(status.lastPollAt);
    const events = await frigateClient.getRecentCarEvents();
    status.frigateConnected = true;
    status.frigateLastEvent = events[0]?.id || null;
    console.log(`[Frigate] Found ${events.length} recent events`);

    for (const event of events) {
      await eventProcessor.processFrigateEvent(event);
    }
  } catch (error) {
    status.frigateConnected = false;
    console.warn(`[Frigate] Poll failed: ${error.message}`);
  } finally {
    polling = false;
  }
}

async function pollScheduledPushes() {
  if (scheduledPushPolling) {
    return;
  }

  scheduledPushPolling = true;
  try {
    await processDueScheduledPushes(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn(`[WebPush] scheduled push poll failed: ${message}`);
  } finally {
    scheduledPushPolling = false;
  }
}

try {
  const connection = await frigateClient.testConnection();
  status.frigateConnected = true;
  status.frigateVersion = connection?.version || (await frigateClient.getVersion());
  console.log("[Frigate] Connected");
} catch (error) {
  console.warn(`[Frigate] Not connected: ${error.message}`);
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const parsedUrl = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const pathname = parsedUrl.pathname;

  try {
    if (await handleOtaRoute({ request, response, pathname, parsedUrl, service: otaService,
      storage: firmwareStorage, getContext: getProtectedContext, limiter: deviceLimiter, responseHeaders: corsHeaders(request) })) return;
    if (request.method === "GET" && pathname === "/api/health") {
      let databaseConnected = false;
      try {
        databaseConnected = await database.testConnection();
      } catch {
        databaseConnected = false;
      }

      sendJson(response, databaseConnected ? 200 : 503, {
        ok: databaseConnected,
        database: { connected: databaseConnected },
      });
      return;
    }

    const versionResult = handleVersionRoute({ request, pathname });
    if (sendRouteResult(response, versionResult)) {
      return;
    }

    if (pathname.startsWith("/api/public/")) {
      let result;

      try {
        result = await handlePublicCheckoutRoute({
          request,
          pathname,
          body: request.method === "GET" ? {} : await readJsonBody(request),
          context: { database, publicCheckoutLimiter },
        });
      } catch (error) {
        console.error("[PublicCheckout] Internal error");
        console.error(error?.stack || error);
        const publicError = publicCheckoutErrorPayload(error);
        sendJson(response, publicError.statusCode, publicError.payload);
        return;
      }

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (request.method === "POST" && pathname === "/api/auth/login") {
      const { user, session } = await loginWithPassword(database, await readJsonBody(request));
      sendJson(
        response,
        200,
        { success: true, user: { id: user.id, email: user.email, displayName: user.displayName } },
        { "Set-Cookie": sessionCookieHeader(session.id, session.expiresAt) },
      );
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/logout") {
      await destroyRequestSession(database, request);
      sendJson(response, 200, { success: true }, { "Set-Cookie": clearSessionCookieHeader() });
      return;
    }

    if (request.method === "GET" && pathname === "/api/auth/session") {
      try {
        const session = await authenticateRequest(request, database);
        sendJson(response, 200, session);
      } catch (error) {
        logUnexpectedError("AuthSession", error);
        sendJson(response, error.statusCode || 500, {
          error: error instanceof Error ? error.message : "Unexpected server error",
        });
      }
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/api/invitations/")) {
      const result = await handleInvitationRoute({
        request,
        pathname,
        context: { database },
      });

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (request.method === "GET" && pathname === "/api/modules") {
      await authenticateRequest(request, database);
      sendJson(response, 200, MODULE_REGISTRY);
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/connect") {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." });
        return;
      }

      const result = await connectTelegramChat(database, await readJsonBody(request));
      sendJson(response, result.success ? 200 : 400, result);
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/staff/connect") {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." }); return;
      }
      sendJson(response, 200, await connectTelegramStaff(database, await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/manual-checkout") {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." }); return;
      }
      sendJson(response, 200, await registerManualTelegramCheckout(database, await readJsonBody(request)));
      return;
    }

    if (
      request.method === "GET" &&
      pathname === "/api/integrations/telegram/housekeeping-board"
    ) {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." });
        return;
      }

      sendJson(
        response,
        200,
        await getHousekeepingBoard(database, {
          tenantId: parsedUrl.searchParams.get("tenantId"),
          tenantSlug: parsedUrl.searchParams.get("tenantSlug") || parsedUrl.searchParams.get("slug"),
          chatId: parsedUrl.searchParams.get("chatId"),
        }),
      );
      return;
    }

    if (
      request.method === "GET" &&
      pathname === "/api/integrations/telegram/housekeeping-staff"
    ) {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." });
        return;
      }

      sendJson(response, 200, await getHousekeepingStaff(database, {
        tenantId: parsedUrl.searchParams.get("tenantId"),
        chatId: parsedUrl.searchParams.get("chatId"),
      }));
      return;
    }

    if (
      request.method === "POST" &&
      pathname === "/api/integrations/telegram/housekeeping-board/message"
    ) {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." });
        return;
      }

      sendJson(response, 200, await saveHousekeepingBoardMessage(database, await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/housekeeping-action") {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." });
        return;
      }

      sendJson(response, 200, await handleHousekeepingAction(database, await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/checkout-message") {
      if (!validateTelegramIntegrationSecret(request.headers)) {
        sendJson(response, 401, { success: false, error: "Unauthorized." }); return;
      }
      sendJson(response, 200, await saveCheckoutTelegramMessage(database, await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/pairing-code") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      sendJson(response, 200, await createTelegramPairingCode(database, tenantId));
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/staff-pairing-code") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      sendJson(response, 200, await createStaffPairingCode(database, context.session, tenantId));
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/disconnect") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      await disconnectTelegramChat(database, tenantId);
      sendJson(response, 200, await getPublicTenantSettings(database, tenantId));
      return;
    }

    if (request.method === "POST" && pathname === "/api/integrations/telegram/test") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const [tenant, tenantSettings] = await Promise.all([
        database.getRecord("tenants", tenantId),
        getTenantSettings(database, tenantId),
      ]);
      const result = await sendTestCheckoutNotification({
        database,
        tenant,
        tenantSettings,
      });

      sendJson(response, 200, {
        success: Boolean(result.sent),
        skipped: Boolean(result.skipped),
        error: result.error || result.diagnostics?.lastError || "",
        httpStatus: result.httpStatus,
        diagnostics: result.diagnostics || {},
      });
      return;
    }

    if (pathname.startsWith("/api/push/")) {
      const result = await handlePushRoute({
        request,
        pathname,
        body: request.method === "GET" ? {} : await readJsonBody(request),
        context: await getProtectedContext(request),
      });

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (pathname.startsWith("/api/housekeeping/")) {
      const result = await handleHousekeepingRoute({
        request,
        pathname,
        body: request.method === "GET" ? {} : await readJsonBody(request),
        context: await getProtectedContext(request),
      });

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (pathname.startsWith("/api/checkout/")) {
      const result = await handleCheckoutRoute({
        request,
        pathname,
        parsedUrl,
        body: request.method === "GET" ? {} : await readJsonBody(request),
        context: await getProtectedContext(request),
      });

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (pathname.startsWith("/api/admin/")) {
      const result = await handleAdminRoute({
        request,
        pathname,
        body: request.method === "GET" ? {} : await readJsonBody(request),
        context: await getProtectedContext(request),
      });

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (pathname.startsWith("/api/tenant/")) {
      const result = await handleUserManagementRoute({
        request,
        pathname,
        body: request.method === "GET" ? {} : await readJsonBody(request),
        context: await getProtectedContext(request),
      });

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (request.method === "POST" && pathname.startsWith("/api/invitations/")) {
      const result = await handleInvitationRoute({
        request,
        pathname,
        body: await readJsonBody(request),
        context: { database },
      });

      if (sendRouteResult(response, result)) {
        return;
      }
    }

    if (request.method === "GET" && pathname === "/api/parking/detections") {
      const context = await getProtectedContext(request);
      const tenantId = await requireModule(database, context.session, "parking");
      const detections = (await database.getDetections())
        .filter((detection) => detectionBelongsToTenant(detection, tenantId))
        .sort((left, right) => new Date(right.detectedAt).getTime() - new Date(left.detectedAt).getTime());
      sendJson(response, 200, detections);
      return;
    }

    const detectionReviewMatch = pathname.match(/^\/api\/parking\/detections\/([^/]+)\/review$/);
    if (request.method === "PATCH" && detectionReviewMatch) {
      const context = await getProtectedContext(request);
      const tenantId = await requireModule(database, context.session, "parking");
      const detectionId = decodeURIComponent(detectionReviewMatch[1]);
      const detection = await database.getDetection(detectionId);
      requireDetectionForTenant(detection, tenantId);
      const body = await readJsonBody(request);
      const reviewStatus = ["pending", "confirmed", "dismissed"].includes(body.reviewStatus)
        ? body.reviewStatus
        : "pending";
      await database.updateDetection(detectionId, { reviewStatus });
      sendJson(response, 200, { success: true });
      return;
    }

    const detectionConfirmMatch = pathname.match(/^\/api\/parking\/detections\/([^/]+)\/confirm$/);
    if (request.method === "POST" && detectionConfirmMatch) {
      const context = await getProtectedContext(request);
      const tenantId = await requireModule(database, context.session, "parking");
      const detectionId = decodeURIComponent(detectionConfirmMatch[1]);
      const detection = await database.getDetection(detectionId);
      requireDetectionForTenant(detection, tenantId);
      const body = await readJsonBody(request);
      const candidate = body.candidate || {};
      await database.updateDetection(detectionId, {
        associationStatus: "matched",
        reviewStatus: "confirmed",
        associationMethod: "temporal",
        reservationCode: candidate.reservationCode,
        room: candidate.room ?? null,
        guestName: candidate.fullName,
        guestEmail: candidate.guestEmail ?? null,
        checkInAt: candidate.checkInAt,
        timeDifferenceMinutes: candidate.timeDifferenceMinutes,
        confidence: candidate.confidence,
        parkingStatus: candidate.parkingStatus ?? "unknown",
        associationCandidates: null,
      });
      sendJson(response, 200, { success: true });
      return;
    }

    const evidenceMatch = pathname.match(/^\/api\/evidence\/(snapshots|clips)\/([^/]+)$/);
    if (request.method === "GET" && evidenceMatch) {
      await getProtectedContext(request);
      const [, collection, filename] = evidenceMatch;
      const kind = collection === "clips" ? "clip" : "snapshot";
      const contentType = kind === "clip" ? "video/mp4" : "image/jpeg";
      await sendEvidenceFile(
        response,
        fileStorage.getEvidenceFilePath(kind, decodeURIComponent(filename)),
        contentType,
      );
      return;
    }

    if (request.method === "GET" && pathname === "/api/status") {
      const context = await getProtectedContext(request);
      await eventProcessor.refreshExpiredPlateStates();
      const plateStateDiagnostics = await database.getPlateStateDiagnostics();
      const tenantSettings = context.session.activeTenantId
        ? await getTenantSettings(database, context.session.activeTenantId)
        : undefined;

      sendJson(response, 200, {
        ...status,
        backendOnline: true,
        frigateBaseUrl: getFrigateSettings().baseUrl,
        frigatePollIntervalMs: getFrigateSettings().pollIntervalMs,
        processedEvents: processedEvents.count(),
        processedStripeEvents: processedStripeEvents.count(),
        plateCooldownEntries: plateCooldown.count(),
        ...plateStateDiagnostics,
        stripeConfigured: Boolean(
          tenantSettings?.stripe?.enabled &&
            tenantSettings?.stripe?.secretKey &&
            tenantSettings?.stripe?.webhookSecret,
        ),
        ...getReservationDiagnostics(),
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/settings/integrations") {
      const context = await getProtectedContext(request);
      requireTenant(context.session);
      let databaseConnected = false;
      try {
        databaseConnected = await database.testConnection();
      } catch {
        databaseConnected = false;
      }

      const tenantSettings = await getPublicTenantSettings(
        database,
        context.session.activeTenantId,
      );

      sendJson(response, 200, {
        ...tenantSettings,
        frigate: {
          ...tenantSettings.frigate,
          lastPollAt: status.lastPollAt,
          lastEvent: status.frigateLastEvent,
          version: status.frigateVersion,
        },
        backend: { online: true },
        database: { connected: databaseConnected },
        reservationDiagnostics: getReservationDiagnostics(),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/notifications") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const body = await readJsonBody(request);
      const telegram = body.telegram || {};
      const notificationPatch = {
        enabled: Boolean(telegram.enabled),
        chatId: String(telegram.chatId ?? "").trim(),
      };

      await updateTenantSettings(database, tenantId, {
        notifications: {
          telegram: notificationPatch,
        },
      });
      sendJson(response, 200, await getPublicTenantSettings(database, tenantId));
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/google-sheets/test") {
      const context = await getProtectedContext(request);
      requireTenantAdmin(context.session);
      const body = await readJsonBody(request);
      const csvUrl = String(body.csvUrl ?? "").trim();
      const result = await testReservationConnection("googleSheets", {
        googleSheetUrl: csvUrl,
        mapping: getReservationSettings().mapping,
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/google-sheets") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const body = await readJsonBody(request);
      await updateTenantSettings(database, tenantId, {
        reservations: {
          enabled: true,
          source: "googleSheets",
          googleSheets: { csvUrl: String(body.csvUrl ?? "").trim() },
        },
      });
      sendJson(response, 200, {
        ...(await getPublicTenantSettings(database, tenantId)),
        reservationDiagnostics: getReservationDiagnostics(),
      });
      return;
    }

    if (request.method === "DELETE" && pathname === "/api/settings/google-sheets") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      await updateTenantSettings(database, tenantId, {
        reservations: {
          enabled: false,
          source: null,
          googleSheets: { csvUrl: "" },
        },
      });
      sendJson(response, 200, await getPublicTenantSettings(database, tenantId));
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/json-feed/test") {
      const context = await getProtectedContext(request);
      requireTenantAdmin(context.session);
      const body = await readJsonBody(request);
      const jsonUrl = String(body.url ?? "").trim();
      const result = await testReservationConnection("json", {
        jsonUrl,
        jsonPath: String(body.jsonPath ?? "").trim(),
        auth: cleanJsonAuthInput(body.auth, getReservationSettings().jsonAuth),
        mapping: getReservationSettings().mapping,
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/json-feed") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const body = await readJsonBody(request);
      const currentSettings = await getTenantSettings(database, tenantId);
      await updateTenantSettings(database, tenantId, {
        reservations: {
          enabled: true,
          source: "json",
          jsonFeed: {
            url: String(body.url ?? "").trim(),
            jsonPath: String(body.jsonPath ?? "").trim(),
            auth: cleanJsonAuthInput(body.auth, currentSettings.reservations?.jsonFeed?.auth),
          },
        },
      });
      sendJson(response, 200, {
        ...(await getPublicTenantSettings(database, tenantId)),
        reservationDiagnostics: getReservationDiagnostics(),
      });
      return;
    }

    if (request.method === "DELETE" && pathname === "/api/settings/json-feed") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      await updateTenantSettings(database, tenantId, {
        reservations: {
          enabled: false,
          source: null,
          jsonFeed: { url: "", jsonPath: "", auth: { type: "none" } },
        },
      });
      sendJson(response, 200, await getPublicTenantSettings(database, tenantId));
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/reservation-webhook") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const body = await readJsonBody(request);
      const currentSettings = await getTenantSettings(database, tenantId);
      await updateTenantSettings(database, tenantId, {
        reservations: {
          enabled: true,
          source: "reservationWebhook",
          jsonFeed: {
            jsonPath: String(body.jsonPath ?? "").trim(),
          },
          reservationWebhook: {
            headerName:
              String(body.headerName ?? "").trim() ||
              currentSettings.reservations?.reservationWebhook?.headerName,
            secret:
              String(body.secret ?? "").trim() ||
              currentSettings.reservations?.reservationWebhook?.secret,
          },
        },
      });
      sendJson(response, 200, {
        ...(await getPublicTenantSettings(database, tenantId)),
        reservationDiagnostics: getReservationDiagnostics(),
      });
      return;
    }

    if (request.method === "DELETE" && pathname === "/api/settings/reservation-webhook") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      await updateTenantSettings(database, tenantId, {
        reservations: {
          enabled: false,
          source: null,
          reservationWebhook: { headerName: "x-hotel-automation-secret", secret: "" },
        },
      });
      sendJson(response, 200, await getPublicTenantSettings(database, tenantId));
      return;
    }

    if (request.method === "POST" && pathname === "/api/reservations/webhook") {
      if (!verifyReservationWebhook(request)) {
        sendJson(response, 401, { error: "Invalid reservation webhook secret." });
        return;
      }

      const body = await readJsonBody(request);
      const preview = await saveReservationWebhookPayload(body);

      if (getReservationSettings().source === "reservationWebhook") {
        await forceRefreshReservations();
      }

      sendJson(response, 202, {
        received: true,
        preview,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/reservation-source/preview") {
      const context = await getProtectedContext(request);
      requireTenantAdmin(context.session);
      const body = await readJsonBody(request);
      const preview = await previewReservationSource(
        body.source || getReservationSettings().source,
      );
      sendJson(response, 200, preview);
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/reservation-mapping") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const body = await readJsonBody(request);
      await updateTenantSettings(database, tenantId, {
        reservations: { mapping: body.mapping ?? {} },
      });
      sendJson(response, 200, {
        ...(await getPublicTenantSettings(database, tenantId)),
        reservationDiagnostics: getReservationDiagnostics(),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/reservation-mapping/test") {
      const context = await getProtectedContext(request);
      requireTenantAdmin(context.session);
      const body = await readJsonBody(request);
      sendJson(response, 200, await testReservationMapping(body.mapping ?? {}));
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/stripe/test") {
      const context = await getProtectedContext(request);
      requireTenantAdmin(context.session);
      const body = await readJsonBody(request);
      const secretKey = String(body.secretKey ?? getStripeSettings().secretKey ?? "").trim();

      if (!secretKey) {
        sendJson(response, 400, { error: "Stripe Secret Key is required." });
        return;
      }

      await getStripeClient(secretKey).balance.retrieve();
      sendJson(response, 200, { connected: true });
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/stripe") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const body = await readJsonBody(request);
      const currentSettings = await getTenantSettings(database, tenantId);
      await updateTenantSettings(database, tenantId, {
        stripe: {
          enabled: true,
          secretKey: String(body.secretKey ?? "").trim() || currentSettings.stripe?.secretKey,
          webhookSecret:
            String(body.webhookSecret ?? "").trim() || currentSettings.stripe?.webhookSecret,
        },
      });
      sendJson(response, 200, (await getPublicTenantSettings(database, tenantId)).stripe);
      return;
    }

    if (request.method === "DELETE" && pathname === "/api/settings/stripe") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      await updateTenantSettings(database, tenantId, {
        stripe: { enabled: false, secretKey: "", webhookSecret: "" },
      });
      sendJson(response, 200, (await getPublicTenantSettings(database, tenantId)).stripe);
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/frigate/test") {
      const context = await getProtectedContext(request);
      requireTenantAdmin(context.session);
      const body = await readJsonBody(request);
      const baseUrl = String(body.baseUrl ?? getFrigateSettings().baseUrl).trim();
      const testClient = createFrigateClient({ baseUrl });
      const connection = await testClient.testConnection();
      sendJson(response, 200, connection);
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings/frigate") {
      const context = await getProtectedContext(request);
      const tenantId = requireTenant(context.session);
      requireTenantAdmin(context.session, tenantId);
      const body = await readJsonBody(request);
      await updateTenantSettings(database, tenantId, {
        frigate: {
          enabled: true,
          baseUrl: String(body.baseUrl ?? "").trim(),
          pollIntervalMs: Number(body.pollIntervalMs || getFrigateSettings().pollIntervalMs),
          cameras: Array.isArray(body.cameras)
            ? body.cameras.map((camera) => String(camera).trim()).filter(Boolean)
            : undefined,
        },
      });
      sendJson(response, 200, (await getPublicTenantSettings(database, tenantId)).frigate);
      return;
    }

    if (request.method === "GET" && pathname === "/api/reservations/debug") {
      const context = await getProtectedContext(request);
      await requireModule(database, context.session, "parking");
      try {
        await getReservations();
      } catch {
        sendJson(response, 500, {
          ...getReservationDebug(),
          ...getReservationDiagnostics(),
        });
        return;
      }

      sendJson(response, 200, getReservationDebug());
      return;
    }

    if (request.method === "POST" && pathname === "/api/reservations/refresh") {
      const context = await getProtectedContext(request);
      await requireModule(database, context.session, "parking");
      try {
        await forceRefreshReservations();
        sendJson(response, 200, {
          ...getReservationDebug(),
          ...getReservationDiagnostics(),
        });
      } catch {
        sendJson(response, 500, {
          ...getReservationDebug(),
          ...getReservationDiagnostics(),
        });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/stripe/webhook") {
      const rawBody = await readRawBody(request);
      const signature = request.headers["stripe-signature"];
      const stripeSettings = getStripeSettings();
      const stripe = getStripeClient(stripeSettings.secretKey);

      if (!stripe || !stripeSettings.webhookSecret) {
        sendJson(response, 500, {
          error: "Stripe Secret Key or Stripe Webhook Secret is not configured.",
        });
        return;
      }

      let stripeEvent;

      try {
        stripeEvent = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          stripeSettings.webhookSecret,
        );
      } catch (error) {
        await database.updateStripeDiagnostic({
          lastEventReceivedAt: new Date().toISOString(),
          lastStatus: "invalid event",
          lastError: error instanceof Error ? error.message : "Invalid Stripe signature.",
        });
        sendJson(response, 400, { error: "Invalid Stripe signature." });
        return;
      }

      const checkInInput = extractStripeCheckInInput(stripeEvent);

      if (!checkInInput) {
        sendJson(response, 200, { received: true, ignored: true });
        return;
      }

      const paymentKeys = [
        `event:${checkInInput.stripeEventId}`,
        checkInInput.stripePaymentIntentId
          ? `paymentIntent:${checkInInput.stripePaymentIntentId}`
          : "",
        checkInInput.stripeCheckoutSessionId
          ? `checkoutSession:${checkInInput.stripeCheckoutSessionId}`
          : "",
      ].filter(Boolean);

      if (paymentKeys.some((key) => processedStripeEvents.has(key))) {
        sendJson(response, 200, { received: true, duplicate: true });
        return;
      }

      if (!checkInInput.reservationCode) {
        await database.updateStripeDiagnostic({
          lastEventReceivedAt: new Date().toISOString(),
          lastStripeEventId: checkInInput.stripeEventId,
          lastReservationNumber: "",
          lastFullName: checkInInput.fullName,
          lastStatus: "invalid event",
          lastError: "reservationNumber is missing in metadata.",
        });
        await Promise.all(paymentKeys.map((key) => processedStripeEvents.mark(key)));
        sendJson(response, 200, { received: true, incomplete: true });
        return;
      }

      const checkIn = await eventProcessor.processCheckInEvent(checkInInput);
      await Promise.all(paymentKeys.map((key) => processedStripeEvents.mark(key)));
      sendJson(response, 201, checkIn);
      return;
    }

    if (request.method === "DELETE" && pathname.startsWith("/api/detections/")) {
      const context = await getProtectedContext(request);
      const tenantId = await requireModule(database, context.session, "parking");
      const detectionId = decodeURIComponent(pathname.replace("/api/detections/", ""));

      try {
        console.log(`[Detection] Delete requested: ${detectionId}`);
        const detection = await database.getDetection(detectionId);

        if (!detection) {
          console.warn(`[Detection] Delete failed: detection not found (${detectionId})`);
          sendJson(response, 404, { error: "Detection not found." });
          return;
        }
        requireDetectionForTenant(detection, tenantId);

        if (detection.localSnapshotPath) {
          await fileStorage.deleteEvidencePath(detection.localSnapshotPath);
          console.log(`[Evidence] Snapshot deleted: ${detection.localSnapshotPath}`);
        }

        if (detection.localVideoPath) {
          await fileStorage.deleteEvidencePath(detection.localVideoPath);
          console.log(`[Evidence] Clip deleted: ${detection.localVideoPath}`);
        }

        await database.deleteDetection(detectionId);
        console.log(`[Database] Detection deleted: ${detectionId}`);
        sendJson(response, 200, { success: true, deletedId: detectionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown delete failure.";
        console.warn(`[Detection] Delete failed: ${message}`);
        sendJson(response, 500, { error: message });
      }
      return;
    }

    const plateReleaseMatch = pathname.match(/^\/api\/plates\/([^/]+)\/release$/);
    if (request.method === "POST" && plateReleaseMatch) {
      const context = await getProtectedContext(request);
      await requireModule(database, context.session, "parking");
      const [, rawPlate] = plateReleaseMatch;
      await eventProcessor.releasePlateAssignment(decodeURIComponent(rawPlate));
      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === "POST" && pathname === "/api/test-detection") {
      const context = await getProtectedContext(request);
      const tenantId = await requireModule(database, context.session, "parking");
      const body = await readJsonBody(request);
      const plate = String(body.plate ?? "").trim();
      const camera = String(body.camera ?? "test").trim();
      const detectedAt = body.detectedAt
        ? new Date(String(body.detectedAt)).toISOString()
        : new Date().toISOString();

      if (!plate || !camera) {
        sendJson(response, 400, { error: "Plate and camera are required." });
        return;
      }

      const detection = await eventProcessor.processDetectionWithCooldown({
        tenantId,
        plate,
        camera,
        detectedAt,
        snapshotUrl: body.snapshotUrl ? String(body.snapshotUrl) : undefined,
        videoUrl: body.videoUrl ? String(body.videoUrl) : undefined,
      });
      sendJson(response, detection ? 201 : 200, {
        detection,
        ignoredByCooldown: !detection,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/test-checkin") {
      const context = await getProtectedContext(request);
      const tenantId = await requireModule(database, context.session, "checkout");
      const body = await readJsonBody(request);
      const reservationCode = String(body.reservationCode ?? "").trim();
      const fullName = String(body.fullName ?? "").trim();

      if (!reservationCode || !fullName) {
        sendJson(response, 400, {
          error: "Reservation number and full name are required.",
        });
        return;
      }

      const checkIn = await eventProcessor.processCheckInEvent({
        tenantId,
        reservationCode,
        fullName,
        checkInAt: new Date().toISOString(),
        source: "stripe",
      });
      sendJson(response, 201, checkIn);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (pathname.startsWith("/api/device/") || /^\/api\/admin\/(devices|firmware-releases)(\/|$)/.test(pathname)) {
      // Prisma exceptions can contain query arguments: never log OTA exceptions or return them to clients.
      if (response.headersSent) { response.destroy(); return; }
      sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "OTA service error." });
      return;
    }
    logUnexpectedError("HTTP", error);
    sendJson(response, error.statusCode || 500, {
      error: error instanceof Error ? error.message : "Unexpected server error",
      ...(error?.code ? { code: error.code } : {}),
    });
  }
});

server.listen(port, host, () => {
  console.log(`[Backend] Listening on http://${host}:${port}`);
});

function scheduleNextPoll() {
  setTimeout(async () => {
    await pollFrigate();
    scheduleNextPoll();
  }, getFrigateSettings().pollIntervalMs);
}

void pollFrigate().finally(scheduleNextPoll);

const scheduledPushInterval = setInterval(() => {
  void pollScheduledPushes();
}, Number(process.env.SCHEDULED_PUSH_POLL_INTERVAL_MS || 1500));
scheduledPushInterval.unref?.();
void pollScheduledPushes();
