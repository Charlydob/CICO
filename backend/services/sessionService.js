import argon2 from "argon2";
import { parseCookie, stringifySetCookie } from "cookie";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAuthSession } from "./tenantService.js";

function parse(value) {
  return parseCookie(value);
}

function serialize(name, value, options) {
  return stringifySetCookie({
    name,
    value,
    ...options,
  });
}
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "hotelapp_session";
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 14);

function now() {
  return new Date();
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value) {
  return cleanString(value).toLowerCase();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function newSessionId() {
  return randomBytes(32).toString("base64url");
}

function sessionSecret() {
  return process.env.SESSION_SECRET || "dev-session-secret";
}

function signSessionId(sessionId) {
  return createHmac("sha256", sessionSecret()).update(sessionId).digest("base64url");
}

function encodeSessionCookie(sessionId) {
  return `${sessionId}.${signSessionId(sessionId)}`;
}

function decodeSessionCookie(value) {
  const [sessionId, signature] = String(value || "").split(".");

  if (!sessionId || !signature) {
    return "";
  }

  const expected = signSessionId(sessionId);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);

  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return "";
  }

  return sessionId;
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function sessionCookieHeader(sessionId, expiresAt) {
  return serialize(SESSION_COOKIE, encodeSessionCookie(sessionId), {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookieHeader() {
  return serialize(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function readSessionId(request) {
  return decodeSessionCookie(parse(request.headers.cookie || "")[SESSION_COOKIE]);
}

export async function hashPassword(password) {
  const cleanPassword = String(password ?? "");

  if (cleanPassword.length < 8) {
    const error = new Error("Password must be at least 8 characters.");
    error.statusCode = 400;
    throw error;
  }

  return argon2.hash(cleanPassword, { type: argon2.argon2id });
}

export async function verifyPassword(hash, password) {
  return argon2.verify(hash, String(password ?? ""));
}

export async function createLoginSession(database, user) {
  const id = newSessionId();
  const expiresAt = addDays(now(), SESSION_TTL_DAYS);
  await database.setRecord("sessions", id, {
    id,
    userId: user.id,
    expiresAt: expiresAt.toISOString(),
    createdAt: now().toISOString(),
    lastSeenAt: now().toISOString(),
  });
  return { id, expiresAt };
}

export async function loginWithPassword(database, input) {
  const email = normalizeEmail(input.email);
  const user = (await database.listRecords("users")).find(
    (candidate) => candidate.email === email,
  );

  if (!user || user.active === false || !(await verifyPassword(user.passwordHash, input.password))) {
    const error = new Error("Invalid email or password.");
    error.statusCode = 401;
    throw error;
  }

  const session = await createLoginSession(database, user);
  return {
    user,
    session,
  };
}

export async function destroyRequestSession(database, request) {
  const sessionId = readSessionId(request);

  if (sessionId) {
    await database.deleteRecord("sessions", sessionId).catch(() => {});
  }
}

export async function authenticateSessionRequest(database, request) {
  const sessionId = readSessionId(request);

  if (!sessionId) {
    const error = new Error("Authentication is required.");
    error.statusCode = 401;
    throw error;
  }

  const sessionRecord = await database.getRecord("sessions", sessionId);

  if (!sessionRecord || new Date(sessionRecord.expiresAt).getTime() <= Date.now()) {
    if (sessionRecord) {
      await database.deleteRecord("sessions", sessionId).catch(() => {});
    }

    const error = new Error("Session has expired.");
    error.statusCode = 401;
    throw error;
  }

  const user = await database.getRecord("users", sessionRecord.userId);

  if (!user || user.active === false) {
    const error = new Error("Authentication is required.");
    error.statusCode = 401;
    throw error;
  }

  await database.updateRecord("sessions", sessionId, {
    lastSeenAt: now().toISOString(),
  });

  let selectedTenantId = request.headers["x-tenant-id"];
  const selectedTenantSlug = request.headers["x-tenant-slug"];

  if (!selectedTenantId && selectedTenantSlug) {
    const cleanSlug = cleanString(selectedTenantSlug);
    const available=user.globalRole==="platform_admin"?await database.listRecords("tenants"):await Promise.all((await database.getMembershipsForUser(user.id)).map(m=>database.getRecord("tenants",m.tenantId)));
    const tenant=available.find(candidate=>candidate?.slug===cleanSlug);
    if(!tenant&&user.globalRole!=="platform_admin")throw Object.assign(Error("Hotel access denied."),{statusCode:403});

    if (!tenant) {
      const error = new Error("Tenant not found.");
      error.statusCode = 404;
      throw error;
    }

    selectedTenantId = tenant.id;
  }

  return getAuthSession(database, user, selectedTenantId);
}
