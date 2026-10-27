import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import https from "node:https";
import { fail } from "../../shared/hookbox/contract.mjs";
const denied = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  denied.addSubnet(ip, prefix, "ipv4");
export function publicAddress(ip) {
  if (isIP(ip) === 4) return !denied.check(ip, "ipv4");
  // Restrict IPv6 to global unicast, excluding special/documentation/transition ranges.
  return (
    isIP(ip) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(ip) &&
    !/^2001:(?:0:|db8:|[0-1][0-9a-f]:|2[0-9a-f]:)/i.test(ip) &&
    !/^2002:/i.test(ip) &&
    !/^3fff:/i.test(ip)
  );
}
export function endpointUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("Indica una URL HTTPS válida");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== "443") ||
    u.hostname === "localhost" ||
    /\.(local|internal|localhost)$/i.test(u.hostname)
  )
    fail("Destino público HTTPS requerido");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host)) fail("Destino interno no permitido");
  return u;
}
export async function resolvePublic(url, resolver = lookup) {
  const u = endpointUrl(url),
    host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolver(host, { all: true, verbatim: true });
  if (!ips.length || ips.some((x) => !publicAddress(x.address)))
    fail("El destino resuelve a una red no pública");
  return { u, ip: ips[0] };
}
export async function sendPublicJson(config, payload, secrets, eventId) {
  const { u, ip } = await resolvePublic(config.endpoint),
    data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: config.method,
        headers: {
          ...secrets,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "Idempotency-Key": eventId,
        },
        lookup: (_host, options, cb) =>
          cb(null, options.all ? [ip] : ip.address, ip.family),
      },
      (res) => {
        // Do not follow redirects or retain potentially sensitive response bodies.
        res.on("error", () => reject(new Error("NETWORK_ERROR")));
        res.on("aborted", () => reject(new Error("NETWORK_ERROR")));
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("TIMEOUT")), 10000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("NETWORK_ERROR")));
    req.end(data);
  });
}
