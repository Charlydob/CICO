import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { requireTenant, requireTenantAdmin } from "./tenantService.js";
import {
  getTenantSettings,
  updateTenantSettings,
} from "./tenantSettingsService.js";
import { createDatabaseClient } from "../databaseClient.js";
const fail = (message, statusCode = 400) => {
    throw Object.assign(Error(message), { statusCode });
  },
  hash = (s) => createHash("sha256").update(s).digest("hex");
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createPaymentsService(
  database,
  { config = process.env, stripeClient, clock = Date.now } = {},
) {
  const origin = String(config.APP_ORIGIN || "").replace(/\/$/, ""),
    clientId = config.STRIPE_CONNECT_CLIENT_ID,
    secret = config.STRIPE_CONNECT_SECRET_KEY;
  const configured = Boolean(
    clientId &&
      secret &&
      config.STRIPE_CONNECT_WEBHOOK_SECRET &&
      /^https:\/\//.test(origin),
  );
  const sdk = () => {
    if (!configured)
      fail("Stripe account linking is not configured by the platform.", 503);
    return (
      stripeClient ||
      new Stripe(secret, { maxNetworkRetries: 1, timeout: 15000 })
    );
  };
  const own = (session) => {
    const tenant = requireTenant(session);
    requireTenantAdmin(session, tenant);
    return tenant;
  };
  const stateKey = (tenant, user) => `stripe-connect:${tenant}:${user}`;
  async function consume(session, state) {
    const [tenant, random, ...extra] = String(state || "").split(".");
    if (!/^[a-f0-9-]{36}$/.test(tenant) || !random || extra.length)
      fail("Connection request is invalid or expired.");
    requireTenantAdmin(session, tenant);
    const key = stateKey(tenant, session.user.id);
    const take = async (db) => {
      const record = await db.getRecord("diagnostics", key),
        value = record?.value || record;
      if (
        !value ||
        value.userId !== session.user.id ||
        value.tenantId !== tenant ||
        value.expiresAt < clock() ||
        !same(value.hash, hash(state))
      )
        fail("Connection request is invalid or expired.");
      await db.deleteRecord("diagnostics", key);
      return tenant;
    };
    if (database.prisma?.$transaction)
      return database.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT key FROM diagnostics WHERE key=${key} FOR UPDATE`;
        return take(createDatabaseClient(tx));
      });
    return take(database);
  }
  return {
    async status(session) {
      const tenant = own(session),
        s = (await getTenantSettings(database, tenant)).stripe;
      return {
        provider: "stripe",
        connected: Boolean(
          s.enabled && (s.connectAccountId || (s.secretKey && s.webhookSecret)),
        ),
        mode: s.connectAccountId
          ? s.connectMode
          : s.secretKey?.startsWith("sk_live_")
            ? "live"
            : s.secretKey?.startsWith("sk_test_")
              ? "test"
              : null,
        connectAvailable: configured,
      };
    },
    async start(session) {
      const tenant = own(session);
      sdk();
      const state = tenant + "." + randomBytes(32).toString("base64url");
      await database.setRecord(
        "diagnostics",
        stateKey(tenant, session.user.id),
        {
          tenantId: tenant,
          userId: session.user.id,
          hash: hash(state),
          expiresAt: clock() + 600000,
        },
      );
      const url = new URL("https://connect.stripe.com/oauth/authorize");
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        scope: "read_write",
        redirect_uri: origin + "/api/tenant/payments/stripe/callback",
        state,
      }).toString();
      return { url: url.toString() };
    },
    async callback(session, query) {
      sdk();
      const tenant = await consume(session, query.state),
        hotel = await database.getRecord("tenants", tenant);
      if (!hotel || hotel.active === false) fail("Hotel access denied.", 403);
      const redirect =
        origin + "/t/" + encodeURIComponent(hotel.slug) + "/settings/payments";
      if (query.error) return redirect + "?connection=cancelled";
      if (
        typeof query.code !== "string" ||
        !query.code ||
        query.code.length > 512
      )
        fail("Invalid authorization response.");
      let token;
      try {
        token = await sdk().oauth.token({
          grant_type: "authorization_code",
          code: query.code,
        });
      } catch {
        fail(
          "Stripe did not authorize the connection. Try again from Payments.",
          502,
        );
      }
      if (
        !/^acct_[a-zA-Z0-9]+$/.test(token.stripe_user_id) ||
        typeof token.livemode !== "boolean" ||
        token.livemode !== secret.startsWith("sk_live_")
      )
        fail("Stripe connection mode could not be verified.", 502);
      const save = async (db) => {
        const settings = await db.listRecords("tenantSettings");
        if (
          settings.some(
            (s) =>
              s.tenantId !== tenant &&
              s.stripe?.connectAccountId === token.stripe_user_id,
          )
        )
          fail("This payment account cannot be linked to this hotel.", 409);
        await updateTenantSettings(db, tenant, {
          stripe: {
            enabled: true,
            connectionType: "connect",
            connectAccountId: token.stripe_user_id,
            connectMode: token.livemode ? "live" : "test",
            connectedAt: new Date(clock()).toISOString(),
          },
        });
        await db.setRecord("diagnostics", "payment-connection:" + tenant, {
          tenantId: tenant,
          actorId: session.user.id,
          action: "connected",
          at: new Date(clock()).toISOString(),
        });
      };
      if (database.prisma?.$transaction)
        await database.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`WITH l AS (SELECT pg_advisory_xact_lock(hashtext(${`stripe-account:${token.stripe_user_id}`}))) SELECT 1::int FROM l`;
          await save(createDatabaseClient(tx));
        });
      else await save(database);
      return redirect + "?connection=connected";
    },
    async verifyWebhook(raw, signature) {
      if (!config.STRIPE_CONNECT_WEBHOOK_SECRET)
        fail("Stripe webhook is not configured.", 503);
      let event;
      try {
        event = sdk().webhooks.constructEvent(
          raw,
          signature,
          config.STRIPE_CONNECT_WEBHOOK_SECRET,
        );
      } catch {
        fail("Invalid Stripe signature.", 400);
      }
      if (!event.account) return { event, tenantId: null };
      const settings = (await database.listRecords("tenantSettings")).filter(
        (s) =>
          s.stripe?.enabled &&
          s.stripe?.connectAccountId === event.account &&
          s.stripe?.connectMode === (event.livemode ? "live" : "test"),
      );
      if (settings.length !== 1) return { event, tenantId: null };
      const hotel = await database.getRecord("tenants", settings[0].tenantId);
      if (!hotel || hotel.active === false) return { event, tenantId: null };
      if (event.type === "account.application.deauthorized") {
        await updateTenantSettings(database, hotel.id, {
          stripe: { enabled: false, connectAccountId: null },
        });
        return { event, tenantId: null };
      }
      return { event, tenantId: hotel.id };
    },
    async disconnect(session) {
      const tenant = own(session),
        s = (await getTenantSettings(database, tenant)).stripe;
      if (s.connectAccountId) {
        if (
          s.connectMode !== (secret?.startsWith("sk_live_") ? "live" : "test")
        )
          fail(
            "The platform must configure the matching Stripe mode before unlinking.",
            503,
          );
        try {
          await sdk().oauth.deauthorize({
            client_id: clientId,
            stripe_user_id: s.connectAccountId,
          });
        } catch {
          fail(
            "Stripe could not confirm disconnection. The connection has been kept.",
            502,
          );
        }
      }
      await updateTenantSettings(database, tenant, {
        stripe: {
          enabled: false,
          connectAccountId: null,
          connectionType: null,
          connectMode: null,
        },
      });
      await database.setRecord("diagnostics", "payment-connection:" + tenant, {
        tenantId: tenant,
        actorId: session.user.id,
        action: "disconnected",
        at: new Date(clock()).toISOString(),
      });
      return { disconnected: true };
    },
  };
}

// Persist the check-in and its room changes together, once per provider payment.
export async function recordConnectedPayment(
  database,
  tenantId,
  account,
  input,
  process,
) {
  const keys = [
    input.stripeEventId && `event:${input.stripeEventId}`,
    input.stripePaymentIntentId && `intent:${input.stripePaymentIntentId}`,
    input.stripeCheckoutSessionId && `session:${input.stripeCheckoutSessionId}`,
  ]
    .filter(Boolean)
    .sort();
  if (!keys.length) fail("Payment identifier is missing.");
  const execute = async (db) => {
    const existing = (await db.listTenantRecords("checkIns", tenantId)).find(
      (row) =>
        (input.stripeEventId && row.stripeEventId === input.stripeEventId) ||
        (input.stripePaymentIntentId &&
          row.stripePaymentIntentId === input.stripePaymentIntentId) ||
        (input.stripeCheckoutSessionId &&
          row.stripeCheckoutSessionId === input.stripeCheckoutSessionId),
    );
    if (existing) return { duplicate: true, checkIn: existing };
    return { duplicate: false, checkIn: await process(db) };
  };
  if (!database.prisma?.$transaction) return execute(database);
  return database.prisma.$transaction(
    async (tx) => {
      for (const key of keys)
        await tx.$queryRaw`WITH l AS (SELECT pg_advisory_xact_lock(hashtext(${`cico-stripe:${tenantId}:${account}:${key}`}))) SELECT 1::int FROM l`;
      return execute(createDatabaseClient(tx));
    },
    { timeout: 20000, maxWait: 20000 },
  );
}
