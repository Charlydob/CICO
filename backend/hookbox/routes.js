import {
  requireTenant,
  requireTenantAdmin,
} from "../services/tenantService.js";
import { requireOtaTransport } from "../routes/otaRoutes.js";
import { fail } from "../../shared/hookbox/contract.mjs";
export async function readHookboxJson(request, limit = 12288) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""))
    fail("Use application/json", 415);
  let bytes = 0,
    chunks = [];
  for await (const c of request) {
    bytes += c.length;
    if (bytes > limit) fail("Request too large", 413);
    chunks.push(c);
  }
  try {
    const x = JSON.parse(Buffer.concat(chunks).toString());
    if (!x || Array.isArray(x) || typeof x !== "object") throw Error();
    return x;
  } catch {
    fail("Invalid JSON");
  }
}
export async function handleHookboxRoute({
  request,
  response,
  pathname,
  service,
  otaService,
  getContext,
  limiter,
  responseHeaders = {},
}) {
  const devicePath = "/api/device/v1/hookbox/",
    adminPath = "/api/hookbox/";
  if (!pathname.startsWith(devicePath) && !pathname.startsWith(adminPath))
    return false;
  requireOtaTransport(request);
  if (!limiter.allow(request.socket?.remoteAddress || "unknown"))
    fail("Too many requests", 429);
  let payload;
  const send = (p) => {
    response.writeHead(200, {
      ...responseHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(p));
    return true;
  };
  const binary = (a) => {
    response.writeHead(200, {
      ...responseHeaders,
      "Content-Type": "application/octet-stream",
      "Cache-Control": "private, no-store",
      "Content-Length": a.bytes.length,
      "Access-Control-Expose-Headers":
        "X-Asset-Width, X-Asset-Height, X-Asset-Sha256",
      "X-Asset-Sha256": a.id,
      "X-Asset-Width": a.width,
      "X-Asset-Height": a.height,
    });
    response.end(Buffer.from(a.bytes));
    return true;
  };
  if (pathname.startsWith(devicePath)) {
    const d = await otaService.authenticate(request);
    const path = pathname.slice(devicePath.length);
    if (!d.tenantId && request.method === "GET" && path === "design")
      return send({
        schemaVersion: 1,
        version: null,
        tenantId: null,
        hotelName: "HOOKBOX",
      });
    if (!d.tenantId) fail("Device has no hotel", 403);
    let traceRequest = {};
    try {
      if (request.method === "GET" && path === "design")
        payload = await service.sync(d);
      else if (
        request.method === "GET" &&
        /^assets\/[a-f0-9]{64}$/.test(path)
      ) {
        return binary(await service.deviceAsset(d, path.split("/")[1]));
      } else if (
        request.method === "GET" &&
        /^operations\/[a-f0-9-]{36}$/.test(path)
      )
        payload = await service.status(d, path.split("/")[1]);
      else if (request.method === "POST") {
        const body = await readHookboxJson(request);
        traceRequest = body;
        if (body.schemaVersion !== 1) fail("Unsupported schema");
        const methods = {
          "design/ack": "ack",
          lookup: "lookup",
          verify: "verify",
          "release/start": "start",
          "release/result": "result",
          complete: "finish",
        };
        if (!methods[path]) fail("Hookbox endpoint not found", 404);
        payload = await service[methods[path]](d, body);
      } else fail("Hookbox endpoint not found", 404);
      await service.trace(d, path, traceRequest, payload, 200);
    } catch (error) {
      await service
        .trace(
          d,
          path,
          traceRequest,
          { error: error.message },
          error.statusCode || 500,
        )
        .catch(() => {});
      await service.failure(d, path, error.statusCode || 500).catch(() => {});
      throw error;
    }
  } else {
    const { session } = await getContext(request);
    const tenant = requireTenant(session);
    requireTenantAdmin(session, tenant);
    if (
      !["GET", "HEAD"].includes(request.method) &&
      (!process.env.APP_ORIGIN ||
        request.headers.origin !== process.env.APP_ORIGIN)
    )
      fail("Request origin not allowed", 403);
    const path = pathname.slice(adminPath.length);
    if (request.method === "GET" && path === "devices")
      payload = await service.devices(tenant);
    else if (request.method === "GET" && /^devices\/[a-f0-9-]{36}$/.test(path))
      payload = await service.device(tenant, path.split("/")[1]);
    else if (request.method === "GET" && path === "editor")
      payload = await service.editor(
        tenant,
        new URL(request.url, "http://localhost").searchParams.get("deviceId"),
      );
    else if (request.method === "GET" && path === "diagnostics")
      payload = await service.diagnostics(
        tenant,
        new URL(request.url, "http://localhost").searchParams.get("deviceId"),
      );
    else if (request.method === "GET" && /^assets\/[a-f0-9]{64}$/.test(path))
      return binary(await service.asset(tenant, path.split("/")[1]));
    else if (request.method === "POST") {
      const body = await readHookboxJson(
        request,
        path === "assets" ? 50000 : 12288,
      );
      if (path === "inherit") payload = await service.inherit(tenant, body);
      else if (path === "draft") payload = await service.draft(tenant, body);
      else if (path === "publish")
        payload = await service.publish(tenant, body, session.user.id);
      else if (path === "assets") payload = await service.upload(tenant, body);
      else fail("Hookbox endpoint not found", 404);
    } else fail("Hookbox endpoint not found", 404);
  }
  return send(payload);
}
