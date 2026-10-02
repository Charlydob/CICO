import { createReadStream } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { requirePlatformAdmin } from "../services/tenantService.js";
import { validateReleaseMetadata, otaError } from "../services/otaProtocol.js";

// This router authenticates BEFORE reading JSON or firmware bytes.
export function requireOtaTransport(request) {
  if (
    process.env.OTA_DEV_ALLOW_HTTP === "true" &&
    process.env.NODE_ENV !== "production"
  )
    return;
  const origin = process.env.OTA_PUBLIC_ORIGIN || process.env.APP_ORIGIN;
  if (!origin || new URL(origin).protocol !== "https:")
    throw otaError("OTA requires an HTTPS public origin.", 503);
  const trustedProxy = process.env.OTA_TRUST_PROXY === "true";
  if (
    !request.socket?.encrypted &&
    !(trustedProxy && request.headers["x-forwarded-proto"] === "https")
  )
    throw otaError("HTTPS is required for OTA.", 426);
}
function requireAdminOrigin(request) {
  if (["GET", "HEAD"].includes(request.method)) return;
  // Cookie-authenticated browser writes require the configured Origin (CSRF defense).
  const allowed = process.env.APP_ORIGIN;
  if (!allowed || request.headers.origin !== allowed)
    throw otaError("Admin request origin is not allowed.", 403);
}
export function requireFirmwarePublisher(request, env = process.env) {
  const expected = env.CICO_FIRMWARE_PUBLISH_TOKEN;
  const authorization = request.headers.authorization;
  const supplied =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
  if (typeof expected !== "string" || expected.length < 32 || !supplied)
    throw otaError("Firmware publisher authentication required.", 401);
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(left, right))
    throw otaError("Firmware publisher authentication required.", 401);
}
export async function readOtaJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""))
    throw otaError("Use application/json.", 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw otaError("OTA JSON exceeds 16 KiB.", 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object")
      throw new Error();
    return body;
  } catch {
    throw otaError("Invalid JSON body.");
  }
}
async function sendFirmware(response, artifact, responseHeaders = {}) {
  const { release, file } = artifact;
  response.writeHead(200, {
    ...responseHeaders,
    "Content-Type": "application/octet-stream",
    "Content-Length": release.fileSize,
    "Content-Disposition": 'attachment; filename="firmware.bin"',
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Firmware-Sha256": release.sha256,
  });
  await pipeline(createReadStream(file), response);
}
export async function handleOtaRoute({
  request,
  response,
  pathname,
  parsedUrl,
  service,
  storage,
  getContext,
  limiter,
  responseHeaders = {},
}) {
  const isDevice = pathname.startsWith("/api/device/v1/");
  const isPublisher = pathname === "/api/ci/v1/firmware-releases";
  const isAdmin = /^\/api\/admin\/(devices|firmware-releases)(\/|$)/.test(
    pathname,
  );
  if (!isDevice && !isAdmin && !isPublisher) return false;
  requireOtaTransport(request);
  let payload,
    status = 200;
  if (isPublisher) {
    requireFirmwarePublisher(request);
    if (request.method !== "POST") throw otaError("OTA endpoint not found.", 404);
    if (request.headers["content-type"] !== "application/octet-stream")
      throw otaError("Upload binary bytes with application/octet-stream.", 415);
    const expectedSha = request.headers["x-firmware-sha256"];
    if (typeof expectedSha !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha))
      throw otaError("X-Firmware-Sha256 is required.", 400);
    const metadata = validateReleaseMetadata(
      Object.fromEntries(parsedUrl.searchParams),
    );
    const artifact = await storage.save(request, metadata.hardwareModel);
    if (artifact.sha256 !== expectedSha) {
      await storage.remove(artifact.storagePath);
      throw otaError("Published checksum does not match uploaded bytes.", 409);
    }
    payload = await service.publishRelease(metadata, artifact, null);
    status = 201;
  } else if (isDevice) {
    if (!limiter.allow(request.socket?.remoteAddress || "unknown"))
      throw otaError("Too many device requests.", 429);
    const device = await service.authenticate(request);
    if (request.method === "POST" && pathname === "/api/device/v1/heartbeat")
      payload = await service.heartbeat(device, await readOtaJson(request));
    else if (request.method === "GET" && pathname === "/api/device/v1/update")
      payload = await service.poll(device);
    else if (
      request.method === "POST" &&
      pathname === "/api/device/v1/update/status"
    )
      payload = await service.report(device, await readOtaJson(request));
    else if (
      request.method === "POST" &&
      pathname === "/api/device/v1/commands/ack"
    )
      payload = await service.acknowledgeCommand(
        device,
        await readOtaJson(request),
      );
    else {
      const match = pathname.match(
        /^\/api\/device\/v1\/updates\/([^/]+)\/firmware$/,
      );
      if (request.method !== "GET" || !match)
        throw otaError("OTA endpoint not found.", 404);
      await sendFirmware(
        response,
        await service.downloadForDevice(device, match[1]),
        responseHeaders,
      );
      return true;
    }
  } else {
    const context = await getContext(request);
    requirePlatformAdmin(context.session);
    requireAdminOrigin(request);
    const userId = context.session.user.id;
    if (pathname === "/api/admin/devices" && request.method === "GET")
      payload = await service.listDevices();
    else if (pathname === "/api/admin/devices" && request.method === "POST") {
      payload = await service.createDevice(await readOtaJson(request));
      status = 201;
    } else if (
      pathname === "/api/admin/firmware-releases" &&
      request.method === "GET"
    )
      payload = await service.listReleases();
    else if (
      pathname === "/api/admin/firmware-releases" &&
      request.method === "POST"
    ) {
      if (request.headers["content-type"] !== "application/octet-stream")
        throw otaError(
          "Upload binary bytes with application/octet-stream.",
          415,
        );
      const metadata = validateReleaseMetadata(
        Object.fromEntries(parsedUrl.searchParams),
      );
      payload = await service.publishRelease(
        metadata,
        await storage.save(request, metadata.hardwareModel),
        userId,
      );
      status = 201;
    } else {
      const device = pathname.match(
        /^\/api\/admin\/devices\/([^/]+)(?:\/(updates|commands|revoke-credential))?$/,
      );
      const release = pathname.match(
        /^\/api\/admin\/firmware-releases\/([^/]+)(?:\/(download))?$/,
      );
      if (device && !device[2] && request.method === "GET")
        payload = await service.getDevice(device[1]);
      else if (device && device[2] === "updates" && request.method === "POST") {
        payload = await service.assignUpdate(
          device[1],
          (await readOtaJson(request)).releaseId,
          userId,
        );
        status = 201;
      } else if (
        device &&
        device[2] === "commands" &&
        request.method === "POST"
      ) {
        payload = await service.command(
          device[1],
          (await readOtaJson(request)).type,
          userId,
        );
        status = 201;
      } else if (
        device &&
        device[2] === "revoke-credential" &&
        request.method === "POST"
      )
        payload = await service.revokeCredential(device[1]);
      else if (release && !release[2] && request.method === "DELETE")
        payload = await service.deleteRelease(release[1]);
      else if (
        release &&
        release[2] === "download" &&
        request.method === "GET"
      ) {
        await sendFirmware(
          response,
          await service.downloadForAdmin(release[1]),
          responseHeaders,
        );
        return true;
      } else throw otaError("OTA endpoint not found.", 404);
    }
  }
  response.writeHead(status, {
    ...responseHeaders,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
  return true;
}
