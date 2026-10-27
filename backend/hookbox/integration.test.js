import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultOutbound,
  normalizeOutbound,
  buildOutboundPreview,
  receiveDeviceWebhook,
  rotateDeviceWebhookSecret,
} from "./integration.js";
import { publicAddress, resolvePublic, endpointUrl } from "./httpTransport.js";
import { redactProtocol } from "./diagnostics.js";
import { defaultTheme, validateTheme } from "../../shared/hookbox/contract.mjs";
test("JSON fields, date zone and daylight saving use event time", () => {
  const config = defaultOutbound();
  assert.deepEqual(buildOutboundPreview(config), {
    key: "105",
    "check-in at": "28.10.2026 14:28",
  });
  assert.equal(
    buildOutboundPreview(config, { occurredAt: "2026-07-01T12:28:00Z" })[
      "check-in at"
    ],
    "01.07.2026 14:28",
  );
  const checkout = defaultOutbound("checkout");
  assert.equal(
    buildOutboundPreview(checkout)["check-out at"],
    "28.10.2026 14:28",
  );
  assert.throws(
    () =>
      normalizeOutbound({
        ...config,
        enabled: true,
        endpoint: "https://hotel.example/",
      }),
    /Confirma/,
  );
  assert.throws(
    () => normalizeOutbound({ ...config, timeZone: "Mars/Base" }),
    /Zona/,
  );
  assert.throws(
    () =>
      normalizeOutbound({
        ...config,
        fields: [
          { key: "key", source: "room" },
          { key: "key", source: "device" },
        ],
      }),
    /repetido/,
  );
});
test("SSRF: public DNS required, mixed answers denied, all special IPv4/IPv6 denied", async () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.1.1",
    "198.18.1.1",
    "224.1.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2001:4860:4860::8888"), true);
  for (const u of [
    "http://hotel.example/",
    "https://user:pass@hotel.example/",
    "https://localhost/",
    "https://127.1/",
    "https://[::1]/",
    "https://2130706433/",
    "https://hotel.example:8443/",
  ])
    assert.throws(() => endpointUrl(u));
  await assert.rejects(
    resolvePublic("https://hotel.example/", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
    /no pública/,
  );
  assert.equal(
    (
      await resolvePublic("https://hotel.example/", async () => [
        { address: "8.8.8.8", family: 4 },
      ])
    ).ip.address,
    "8.8.8.8",
  );
});
test("retired authorization and PIN redaction", async () => {
  await assert.rejects(receiveDeviceWebhook({}), (e) => e.statusCode === 410);
  await assert.rejects(
    rotateDeviceWebhookSecret({}),
    (e) => e.statusCode === 410,
  );
  assert.equal(
    redactProtocol({ pin: "5932", nested: { pinHash: "hash" } }).pin,
    "[REDACTED]",
  );
});
test("PIN layout: QR visible/hidden/left, bounds and margin persist", () => {
  const t = defaultTheme();
  assert.equal(t.qr.enabled, false);
  assert.equal(validateTheme(t).qr.x, 592);
  t.qr.enabled = true;
  validateTheme(t);
  t.qr.x = 32;
  validateTheme(t);
  t.qr.x = 350;
  assert.throws(() => validateTheme(t), /invade/);
  t.qr.x = 592;
  t.qr.margin = 0;
  assert.throws(() => validateTheme(t), /margen/);
});
