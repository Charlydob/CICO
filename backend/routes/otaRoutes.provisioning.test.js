import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { handleOtaRoute } from "./otaRoutes.js";

function request(pathname, body = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = "POST";
  stream.url = pathname;
  stream.headers = { "content-type": "application/json" };
  stream.socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

function response() {
  return {
    writeHead() {},
    end() {},
  };
}

test("provisioning traffic cannot consume the active-device limiter", async () => {
  const previousAllowHttp = process.env.OTA_DEV_ALLOW_HTTP;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.OTA_DEV_ALLOW_HTTP = "true";
  process.env.NODE_ENV = "test";
  let deviceChecks = 0;
  let provisioningChecks = 0;
  const limiter = { allow: () => { deviceChecks += 1; return true; } };
  const provisioningLimiter = {
    allow: () => { provisioningChecks += 1; return false; },
  };
  try {
    const provisioningPath = "/api/provisioning/v1/discover";
    await assert.rejects(handleOtaRoute({
      request: request(provisioningPath),
      response: response(),
      pathname: provisioningPath,
      parsedUrl: new URL(`http://localhost${provisioningPath}`),
      provisioning: { discover: async () => assert.fail("rate-limited discovery ran") },
      limiter,
      provisioningLimiter,
    }), (error) => error.statusCode === 429);
    assert.equal(deviceChecks, 0);
    assert.equal(provisioningChecks, 1);

    const heartbeatPath = "/api/device/v1/heartbeat";
    await handleOtaRoute({
      request: request(heartbeatPath),
      response: response(),
      pathname: heartbeatPath,
      parsedUrl: new URL(`http://localhost${heartbeatPath}`),
      service: {
        authenticate: async () => ({ id: "legacy-device" }),
        heartbeat: async () => ({ ok: true }),
      },
      limiter,
      provisioningLimiter,
    });
    assert.equal(deviceChecks, 1);
    assert.equal(provisioningChecks, 1);
  } finally {
    if (previousAllowHttp === undefined) delete process.env.OTA_DEV_ALLOW_HTTP;
    else process.env.OTA_DEV_ALLOW_HTTP = previousAllowHttp;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
