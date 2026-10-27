import QRCode from "qrcode";
import {
  archiveRoom,
  createKeyIdentifier,
  createRoom,
  createKeyIdentifiersBulk,
  createRoomsBulk,
  deleteKeyIdentifier,
  listCheckoutOverview,
  listKeyIdentifiers,
  registerCheckout,
  registerCheckoutByIdentifier,
  resolveCheckoutByIdentifier,
  setTodayCheckoutRooms,
  updateKeyIdentifier,
  updateManagedRoom,
} from "../services/checkoutService.js";
import { requireModule, requireTenantAdmin, getTenantRole } from "../services/tenantService.js";
import { requireHousekeepingPermission } from "../services/housekeepingPermissions.js";

function publicBaseUrl(request) {
  return (
    process.env.PUBLIC_APP_URL ||
    `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`
  ).replace(/\/+$/g, "");
}

function keyCheckoutUrl(request, key) {
  return `${publicBaseUrl(request)}/checkout/${encodeURIComponent(key.identifier)}`;
}

async function withQrPayload(request, key) {
  const checkoutUrl = keyCheckoutUrl(request, key);

  return {
    ...key,
    checkoutUrl,
    qrDataUrl: await QRCode.toDataURL(checkoutUrl, { errorCorrectionLevel: "H", margin: 4 }),
  };
}

export async function handleCheckoutRoute({ request, pathname, parsedUrl, body, context }) {
  const { database, session } = context;
  const tenantId = await requireModule(database, session, "checkout");

  if (request.method === "GET" && pathname === "/api/checkout/overview") {
    const tenant = await database.getRecord("tenants", tenantId);
    const overview = await listCheckoutOverview(database, tenantId);
    const timezone = tenant?.basicInfo?.timezone || "UTC";
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type)?.value;
    const todayDate = `${part("year")}-${part("month")}-${part("day")}`;
    const publicUrl = `${publicBaseUrl(request)}/public/${tenant.slug}/checkout`;

    return {
      status: 200,
      payload: {
        ...overview,
        todayDate,
        publicUrl,
        publicQrDataUrl: await QRCode.toDataURL(publicUrl, { errorCorrectionLevel: "H", margin: 4 }),
      },
    };
  }

  if (request.method === "GET" && pathname === "/api/checkout/keys") {
    requireTenantAdmin(session,tenantId);
    const keys = await listKeyIdentifiers(database, tenantId);
    return { status: 200, payload: keys };
  }

  if (request.method === "PUT" && pathname === "/api/checkout/today") {
    requireTenantAdmin(session, tenantId);
    const tenant = await database.getRecord("tenants", tenantId);
    const timezone = tenant?.basicInfo?.timezone || "UTC";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const part = (type) => parts.find((item) => item.type === type)?.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    return { status: 200, payload: await setTodayCheckoutRooms(database, tenantId, body.roomIds, date,session.user.id) };
  }

  if (request.method === "POST" && pathname === "/api/checkout/rooms") {
    requireTenantAdmin(session, tenantId);
    return { status: 201, payload: await createRoom(database, tenantId, body) };
  }

  if (request.method === "POST" && pathname === "/api/checkout/rooms/bulk") {
    requireTenantAdmin(session, tenantId);
    const result = await createRoomsBulk(database, tenantId, body);
    return {
      status: 201,
      payload: {
        ...result,
        keys: await Promise.all(result.keys.map((key) => withQrPayload(request, key))),
      },
    };
  }

  const roomMatch = pathname.match(/^\/api\/checkout\/rooms\/([^/]+)$/);
  if (request.method === "PATCH" && roomMatch) {
    requireTenantAdmin(session, tenantId);
    return {
      status: 200,
      payload: await updateManagedRoom(database, tenantId, decodeURIComponent(roomMatch[1]), body,session.user.id),
    };
  }

  if (request.method === "DELETE" && roomMatch) {
    requireTenantAdmin(session, tenantId);
    return {
      status: 200,
      payload: await archiveRoom(database, tenantId, decodeURIComponent(roomMatch[1]),session.user.id),
    };
  }

  if (request.method === "POST" && pathname === "/api/checkout/keys") {
    requireTenantAdmin(session, tenantId);
    const key = await createKeyIdentifier(database, tenantId, body);
    return {
      status: 201,
      payload: await withQrPayload(request, key),
    };
  }

  if (request.method === "POST" && pathname === "/api/checkout/keys/bulk") {
    requireTenantAdmin(session, tenantId);
    const result = await createKeyIdentifiersBulk(database, tenantId, body);
    return {
      status: 201,
      payload: {
        ...result,
        keys: await Promise.all(
          [...result.created, ...result.regenerated].map((key) => withQrPayload(request, key)),
        ),
      },
    };
  }

  const keyMatch = pathname.match(/^\/api\/checkout\/keys\/([^/]+)$/);
  if (request.method === "PATCH" && keyMatch) {
    requireTenantAdmin(session, tenantId);
    const key = await updateKeyIdentifier(
      database,
      tenantId,
      decodeURIComponent(keyMatch[1]),
      body,
    );
    return {
      status: 200,
      payload: await withQrPayload(request, key),
    };
  }

  if (request.method === "DELETE" && keyMatch) {
    requireTenantAdmin(session, tenantId);
    return {
      status: 200,
      payload: await deleteKeyIdentifier(database, tenantId, decodeURIComponent(keyMatch[1])),
    };
  }

  const keyQrMatch = pathname.match(/^\/api\/checkout\/keys\/([^/]+)\/qr$/);
  if (request.method === "GET" && keyQrMatch) {
    requireTenantAdmin(session,tenantId);
    const key = await database.getTenantRecord(
      "keyIdentifiers",
      tenantId,
      decodeURIComponent(keyQrMatch[1]),
    );

    if (!key) {
      const error = new Error("Key identifier not found.");
      error.statusCode = 404;
      throw error;
    }

    return {
      status: 200,
      payload: {
        checkoutUrl: keyCheckoutUrl(request, key),
        qrDataUrl: await QRCode.toDataURL(keyCheckoutUrl(request, key), {
          errorCorrectionLevel: "H",
          margin: 4,
        }),
      },
    };
  }

  if (request.method === "POST" && pathname === "/api/checkout/manual") {
    requireHousekeepingPermission(getTenantRole(session, tenantId), "manage");
    const roomId = String(body.roomId || "").trim();
    return {
      status: 201,
      payload: await registerCheckout(database, tenantId, roomId, "manual", {
        sourceIdentifier: `manual:${session.user.id}`,
        metadata: { userId: session.user.id },
      }),
    };
  }

  return undefined;
}

export async function handlePublicCheckoutRoute({ request, pathname, body = {}, context }) {
  const { database, publicCheckoutLimiter } = context;

  const publicPageMatch = pathname.match(/^\/api\/public\/tenants\/([^/]+)\/checkout$/);
  if (request.method === "GET" && publicPageMatch) {
    const slug = decodeURIComponent(publicPageMatch[1]);
    const tenant = (await database.listRecords("tenants")).find(
      (item) => item.slug === slug && item.active !== false,
    );

    if (!tenant) {
      const error = new Error("Hotel checkout is not available.");
      error.statusCode = 404;
      throw error;
    }

    const modules = await database.getTenantModules(tenant.id);
    if (!modules.checkout) {
      const error = new Error("Hotel checkout is not available.");
      error.statusCode = 404;
      throw error;
    }

    return {
      status: 200,
      payload: {
        tenantName: tenant.name,
        slug: tenant.slug,
        enabled: true,
      },
    };
  }

  const checkoutMatch = pathname.match(/^\/api\/public\/checkout\/([^/]+)$/);
  if (request.method === "GET" && checkoutMatch) {
    return {
      status: 200,
      payload: await resolveCheckoutByIdentifier(
        database,
        decodeURIComponent(checkoutMatch[1]),
        "qr",
      ),
    };
  }

  if (request.method === "POST" && checkoutMatch) {
    const ip = request.socket?.remoteAddress || "unknown";
    const checkoutIdentifier = decodeURIComponent(checkoutMatch[1]);

    if (!publicCheckoutLimiter.allow(`${ip}:${checkoutIdentifier}`)) {
      const error = new Error("Too many checkout attempts. Please wait a moment.");
      error.statusCode = 429;
      error.code = "RATE_LIMITED";
      throw error;
    }

    const result = await registerCheckoutByIdentifier(
      database,
      checkoutIdentifier,
      "qr",
      { attemptToken: body.attemptToken },
    );

    return {
      status: 200,
      payload: {
        success: true,
        duplicate: result.duplicate,
        timestamp: result.event.timestamp,
        room: {
          number: result.room.number,
        },
      },
    };
  }

  return undefined;
}
