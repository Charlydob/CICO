import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPaymentsService } from "./paymentsService.js";
function fixture() {
  const a = randomUUID(),
    b = randomUUID(),
    user = randomUUID(),
    data = {
      tenants: {
        [a]: { id: a, slug: "hotel-a", active: true },
        [b]: { id: b, slug: "hotel-b", active: true },
      },
      diagnostics: {},
      tenantSettings: {},
    };
  const db = {
    getRecord: async (c, k) => data[c]?.[k],
    setRecord: async (c, k, v) => {
      data[c] ||= {};
      return (data[c][k] = {
        ...v,
        ...(c === "tenantSettings" ? { tenantId: k } : { id: k }),
      });
    },
    deleteRecord: async (c, k) => {
      delete data[c][k];
    },
    listRecords: async (c) => Object.values(data[c] || {}),
  };
  const session = {
      user: { id: user },
      activeTenantId: a,
      isPlatformAdmin: false,
      memberships: [{ tenantId: a, role: "tenant_admin" }],
    },
    other = {
      user: { id: randomUUID() },
      activeTenantId: b,
      isPlatformAdmin: false,
      memberships: [{ tenantId: b, role: "tenant_admin" }],
    };
  const config = {
    APP_ORIGIN: "https://cico.test",
    STRIPE_CONNECT_CLIENT_ID: "ca_fixture",
    STRIPE_CONNECT_SECRET_KEY: "sk_test_fixture",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_fixture",
  };
  let now = 1000,
    calls = 0,
    revokes = 0,
    deny = false;
  const client = {
    oauth: {
      token: async () => {
        calls++;
        return { stripe_user_id: "acct_fixture", livemode: false };
      },
      deauthorize: async (input) => {
        if (deny) throw Error("provider failure");
        revokes++;
        return input;
      },
    },
    webhooks: {
      constructEvent: (raw, sig) => {
        if (sig !== "valid") throw Error("invalid signature");
        return JSON.parse(raw);
      },
    },
  };
  const service = createPaymentsService(db, {
    config,
    stripeClient: client,
    clock: () => now,
  });
  return {
    a,
    b,
    db,
    data,
    session,
    other,
    service,
    client,
    config,
    get calls() {
      return calls;
    },
    get revokes() {
      return revokes;
    },
    expire() {
      now += 600001;
    },
    denyRevoke(v) {
      deny = v;
    },
  };
}
async function state(f, session = f.session) {
  return new URL((await f.service.start(session)).url).searchParams.get(
    "state",
  );
}
test("OAuth state is bound to hotel/user, single use and contains no stored credentials", async () => {
  const f = fixture(),
    s = await state(f);
  assert.equal(JSON.stringify(f.data.diagnostics).includes(s), false);
  await assert.rejects(
    f.service.callback(f.other, { state: s, code: "fixture" }),
    { statusCode: 403 },
  );
  assert.equal(f.calls, 0);
  assert.equal(
    await f.service.callback(f.session, { state: s, code: "fixture" }),
    "https://cico.test/t/hotel-a/settings/payments?connection=connected",
  );
  await assert.rejects(
    f.service.callback(f.session, { state: s, code: "fixture" }),
    { statusCode: 400 },
  );
  assert.equal(f.calls, 1);
  const status = await f.service.status(f.session);
  assert.equal(status.connected, true);
  assert.equal(status.mode, "test");
  assert.equal(JSON.stringify(status).includes("sk_test"), false);
  assert.equal(f.data.tenantSettings[f.a].stripe.access_token, undefined);
});
test("expired states and account reuse cannot connect another hotel", async () => {
  const f = fixture(),
    s = await state(f);
  f.expire();
  await assert.rejects(f.service.callback(f.session, { state: s, code: "x" }), {
    statusCode: 400,
  });
  assert.equal(f.calls, 0);
  await f.service.callback(f.session, { state: await state(f), code: "x" });
  await assert.rejects(
    f.service.callback(f.other, { state: await state(f, f.other), code: "x" }),
    { statusCode: 409 },
  );
  assert.equal((await f.service.status(f.other)).connected, false);
});
test("disconnect needs provider confirmation; signed account determines the hotel", async () => {
  const f = fixture();
  await f.service.callback(f.session, { state: await state(f), code: "x" });
  await assert.rejects(f.service.verifyWebhook("{}", "invalid"), {
    statusCode: 400,
  });
  const result = await f.service.verifyWebhook(
    JSON.stringify({
      account: "acct_fixture",
      livemode: false,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId: f.b } } },
    }),
    "valid",
  );
  assert.equal(result.tenantId, f.a);
  f.denyRevoke(true);
  await assert.rejects(f.service.disconnect(f.session), { statusCode: 502 });
  assert.equal((await f.service.status(f.session)).connected, true);
  f.denyRevoke(false);
  await f.service.disconnect(f.session);
  assert.equal(f.revokes, 1);
  assert.equal((await f.service.status(f.session)).connected, false);
});
test("unconfigured platform and staff cannot start linking", async () => {
  const f = fixture(),
    off = createPaymentsService(f.db, { config: {} });
  assert.equal((await off.status(f.session)).connectAvailable, false);
  await assert.rejects(off.start(f.session), { statusCode: 503 });
  await assert.rejects(
    f.service.start({
      ...f.session,
      memberships: [{ tenantId: f.a, role: "staff" }],
    }),
    { statusCode: 403 },
  );
});
