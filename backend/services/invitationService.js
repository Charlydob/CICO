import { createHash, randomBytes, randomUUID,createCipheriv,createDecipheriv } from "node:crypto";
import { sendUserInvitationNotification } from "./notificationService.js";
import { createLoginSession, hashPassword, verifyPassword } from "./sessionService.js";
import { displayNameForMembership } from "./userDisplayService.js";

const INVITABLE_ROLES = new Set(["tenant_admin", "manager", "staff"]);
const INVITATION_TTL_DAYS = Number(process.env.INVITATION_TTL_DAYS || 7);

function now() {
  return new Date().toISOString();
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value) {
  return cleanString(value).toLowerCase();
}

function assertValidEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("A valid email is required.");
    error.statusCode = 400;
    throw error;
  }
}

function assertInvitableRole(role) {
  if (!INVITABLE_ROLES.has(role)) {
    const error = new Error("Only tenant_admin, manager and staff can be invited.");
    error.statusCode = 400;
    throw error;
  }
}

export function membershipId(tenantId, userId) {
  return randomUUID();
}

function publicInvitation(invitation, tenant, includeLink) {
  if (!invitation) {
    return undefined;
  }

  const status = invitation.revokedAt
    ? "revoked"
    : invitation.usedAt
      ? "used"
      : new Date(invitation.expiresAt).getTime() <= Date.now()
        ? "expired"
        : "pending";

  return {
    id: invitation.id,
    email: invitation.email,
    tenantId: invitation.tenantId,
    tenantName: tenant?.name || "",
    role: invitation.role,
    invitedByUserId: invitation.invitedBy,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    usedAt: invitation.usedAt || null,
    revokedAt: invitation.revokedAt || null,
    status,
    ...(includeLink ? { inviteUrl: includeLink } : {}),
  };
}

function inviteUrlFromToken(token, baseUrl) {
  const origin = cleanString(baseUrl).replace(/\/+$/, "") || "http://127.0.0.1:5173";
  return `${origin}/accept-invite/${encodeURIComponent(token)}`;
}

function generateToken() {
  return randomBytes(32).toString("base64url");
}

function invitationKey(){return createHash("sha256").update("cico-invitation-v1:"+(process.env.SESSION_SECRET||"dev-session-secret")).digest();}
function encryptToken(token){const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",invitationKey(),iv),encrypted=Buffer.concat([cipher.update(token,"utf8"),cipher.final()]);return [iv,cipher.getAuthTag(),encrypted].map(v=>v.toString("base64url")).join(".");}
function decryptToken(value){try{const [iv,tag,data]=String(value||"").split(".").map(v=>Buffer.from(v,"base64url"));const cipher=createDecipheriv("aes-256-gcm",invitationKey(),iv);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]).toString("utf8");}catch{throw Object.assign(Error("Renew this invitation before copying its link."),{statusCode:409})}}
function tokenHash(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

export function getTenantRole(session, tenantId = session.activeTenantId) {
  if (session.isPlatformAdmin) {
    return "platform_admin";
  }

  return session.memberships.find((membership) => membership.tenantId === tenantId)?.role;
}

export function requireUserManager(session, tenantId) {
  const role = getTenantRole(session, tenantId);

  if (!["platform_admin","tenant_admin","manager"].includes(role)) {
    const error = new Error("Tenant admin access is required.");
    error.statusCode = 403;
    throw error;
  }

  return role;
}

async function requireTenantExists(database, tenantId) {
  const tenant = await database.getRecord("tenants", tenantId);

  if (!tenant) {
    const error = new Error("Tenant not found.");
    error.statusCode = 404;
    throw error;
  }

  return tenant;
}

export async function listTenantMembers(database, tenantId) {
  const [memberships, users] = await Promise.all([
    database.listRecords("memberships"),
    database.listRecords("users"),
  ]);

  return memberships
    .filter((membership) => membership.tenantId === tenantId)
    .map((membership) => ({
      ...membership,
      status: "active",
      displayName: displayNameForMembership(
        users.find((user) => user.id === membership.userId),
        membership,
      ),
      user: (() => {
        const user = users.find((candidate) => candidate.id === membership.userId) || {
          id: membership.userId,
          email: "",
          displayName: "",
        };
        const { passwordHash, usernameNormalized, ...safeUser } = user;
        return safeUser;
      })(),
    }));
}

export async function listTenantInvitations(database, tenantId) {
  const [invitations, tenant] = await Promise.all([
    database.listRecords("userInvitations"),
    database.getRecord("tenants", tenantId),
  ]);

  return invitations
    .filter((invitation) => invitation.tenantId === tenantId)
    .map((invitation) => publicInvitation(invitation, tenant))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export async function listTenantUsersPayload(database, session, tenantId) {
  requireUserManager(session, tenantId);
  await requireTenantExists(database, tenantId);

  const [members, invitations] = await Promise.all([
    listTenantMembers(database, tenantId),
    listTenantInvitations(database, tenantId),
  ]);

  return { members, invitations };
}

export async function createUserInvitation(database, session, tenantId, input, options = {}) {
  requireUserManager(session, tenantId);
  const tenant = await requireTenantExists(database, tenantId);
  const email = normalizeEmail(input.email);
  const role = cleanString(input.role);
  assertValidEmail(email);
  assertInvitableRole(role);
  if(!session.isPlatformAdmin&&getTenantRole(session,tenantId)==="manager"&&role==="tenant_admin")throw Object.assign(Error("Only the hotel owner can grant owner access."),{statusCode:403});

  const timestamp = now();
  const token = generateToken();
  const invitation = {
    id: randomUUID(),
    email,
    tenantId,
    role,
    tokenHash: tokenHash(token),encryptedToken:encryptToken(token),
    invitedBy: session.user.id,
    createdAt: timestamp,
    expiresAt: input.expiresAt || addDays(timestamp, INVITATION_TTL_DAYS),
    usedAt: null,
    revokedAt: null,
  };

  await database.setRecord("userInvitations", invitation.id, invitation);

  const inviteUrl = inviteUrlFromToken(token, options.baseUrl);
  const delivery=await sendUserInvitationNotification({ invitation, tenant, inviteUrl });
  return {...publicInvitation(invitation, tenant, inviteUrl),delivery:{status:delivery.status}};
}

export async function getInvitationByToken(database, token) {
  const cleanToken = cleanString(token);
  const invitation = (await database.listRecords("userInvitations")).find(
    (candidate) => candidate.tokenHash === tokenHash(cleanToken),
  );

  if (!invitation) {
    const error = new Error("Invitation not found.");
    error.statusCode = 404;
    throw error;
  }

  const tenant = await database.getRecord("tenants", invitation.tenantId);
  return publicInvitation(invitation, tenant);
}

export async function getInvitationLink(database, session, tenantId, invitationId, baseUrl) {
  requireUserManager(session, tenantId);
  const invitation = await database.getRecord("userInvitations", invitationId);

  if (!invitation || invitation.tenantId !== tenantId) {
    const error = new Error("Invitation not found.");
    error.statusCode = 404;
    throw error;
  }

  if (invitation.revokedAt || invitation.usedAt) {
    const error = new Error("Only pending invitations have an invitation link.");
    error.statusCode = 400;
    throw error;
  }

  if(new Date(invitation.expiresAt).getTime()<=Date.now())throw Object.assign(Error("Invitation has expired. Renew it to continue."),{statusCode:400});
  const token=decryptToken(invitation.encryptedToken);
  if(tokenHash(token)!==invitation.tokenHash)throw Object.assign(Error("Renew this invitation before copying its link."),{statusCode:409});

  return { inviteUrl: inviteUrlFromToken(token, baseUrl) };
}

export async function revokeUserInvitation(database, session, tenantId, invitationId,locked=false) {
  requireUserManager(session, tenantId);
  if(database.withInvitationLock&&!locked)return database.withInvitationLock({id:invitationId},tx=>revokeUserInvitation(tx,session,tenantId,invitationId,true));
  const invitation = await database.getRecord("userInvitations", invitationId);

  if (!invitation || invitation.tenantId !== tenantId) {
    const error = new Error("Invitation not found.");
    error.statusCode = 404;
    throw error;
  }

  const next = { ...invitation, revokedAt: invitation.revokedAt || now() };
  await database.setRecord("userInvitations", invitation.id, next);
  const tenant = await database.getRecord("tenants", tenantId);
  return publicInvitation(next, tenant);
}

export async function regenerateUserInvitation(database, session, tenantId, invitationId, baseUrl,locked=false) {
  requireUserManager(session, tenantId);
  if(database.withInvitationLock&&!locked)return database.withInvitationLock({id:invitationId},tx=>regenerateUserInvitation(tx,session,tenantId,invitationId,baseUrl,true));
  const invitation = await database.getRecord("userInvitations", invitationId);

  if (!invitation || invitation.tenantId !== tenantId) {
    const error = new Error("Invitation not found.");
    error.statusCode = 404;
    throw error;
  }

  if (invitation.usedAt) {
    const error = new Error("Used invitations cannot be regenerated.");
    error.statusCode = 400;
    throw error;
  }

  const timestamp = now();
  const token = generateToken();
  const next = {
    ...invitation,
    tokenHash: tokenHash(token),encryptedToken:encryptToken(token),
    expiresAt: addDays(timestamp, INVITATION_TTL_DAYS),
    revokedAt: null,
  };

  await database.setRecord("userInvitations", invitation.id, next);
  const tenant = await database.getRecord("tenants", tenantId);
  const inviteUrl = inviteUrlFromToken(token, baseUrl);
  const delivery=await sendUserInvitationNotification({ invitation: next, tenant, inviteUrl });
  return {...publicInvitation(next, tenant, inviteUrl),delivery:{status:delivery.status}};
}

export async function acceptUserInvitation(database, input, token,locked=false) {
  if(database.withInvitationLock&&!locked)return database.withInvitationLock({hash:tokenHash(cleanString(token))},tx=>acceptUserInvitation(tx,input,token,true));
  const cleanToken = cleanString(token);
  const invitation = (await database.listRecords("userInvitations")).find(
    (candidate) => candidate.tokenHash === tokenHash(cleanToken),
  );

  if (!invitation) {
    const error = new Error("Invitation not found.");
    error.statusCode = 404;
    throw error;
  }

  if (invitation.usedAt) {
    const error = new Error("Invitation has already been used.");
    error.statusCode = 400;
    throw error;
  }

  if (invitation.revokedAt) {
    const error = new Error("Invitation has been revoked.");
    error.statusCode = 400;
    throw error;
  }

  if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
    const error = new Error("Invitation has expired.");
    error.statusCode = 400;
    throw error;
  }

  const tenant = await requireTenantExists(database, invitation.tenantId);
  const email = normalizeEmail(input.email || invitation.email);
  const password = String(input.password || "");

  if (email !== invitation.email) {
    const error = new Error("This invitation belongs to a different email address.");
    error.statusCode = 403;
    throw error;
  }

  let user = (await database.listRecords("users")).find((candidate) => candidate.email === email);

  if (user) {
    if (user.active===false || !(await verifyPassword(user.passwordHash, password))) {
      const error = new Error("Invalid email or password.");
      error.statusCode = 401;
      throw error;
    }
  } else {
    user = await database.createRecord("users", {
      email,
      passwordHash: await hashPassword(password),
      displayName: email,
      active: true,
      createdAt: now(),
      updatedAt: now(),
    });
  }

  const timestamp = now();
  const currentMembership = (await database.getMembershipsForUser(user.id)).find(
    (membership) => membership.tenantId === invitation.tenantId,
  );
  const membership = currentMembership || {
    id: membershipId(invitation.tenantId, user.id),
    tenantId: invitation.tenantId,
    userId: user.id,
    role: invitation.role,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await database.setRecord("memberships", membership.id, membership);
  await database.setRecord("userInvitations", invitation.id, {
    ...invitation,
    usedAt: timestamp,
  });

  return {
    tenantId: invitation.tenantId,
    tenantSlug: tenant.slug,
    membership,
    session: await createLoginSession(database, user),
  };
}

export async function updateTenantMembershipRole(database, session, tenantId, membershipIdValue, role) {
  requireUserManager(session, tenantId);
  assertInvitableRole(role);
  if(!session.isPlatformAdmin&&getTenantRole(session,tenantId)==="manager"&&role==="tenant_admin")throw Object.assign(Error("Only the hotel owner can grant owner access."),{statusCode:403});

  const membership = await database.getRecord("memberships", membershipIdValue);
  if (!membership || membership.tenantId !== tenantId) {
    const error = new Error("Membership not found.");
    error.statusCode = 404;
    throw error;
  }

  if(!session.isPlatformAdmin&&membership.userId===session.user.id)throw Object.assign(Error("You cannot change your own permissions."),{statusCode:403});
  if(!session.isPlatformAdmin&&getTenantRole(session,tenantId)==="manager"&&(membership.role==="tenant_admin"||role==="tenant_admin"))throw Object.assign(Error("Only the hotel owner can manage owner access."),{statusCode:403});
  const next = { ...membership, role, updatedAt: now() };
  await database.setRecord("memberships", membership.id, next);
  return next;
}

export async function revokeTenantMembership(database, session, tenantId, membershipIdValue) {
  requireUserManager(session, tenantId);
  const membership = await database.getRecord("memberships", membershipIdValue);

  if (!membership || membership.tenantId !== tenantId) {
    const error = new Error("Membership not found.");
    error.statusCode = 404;
    throw error;
  }

  if(!session.isPlatformAdmin&&(membership.userId===session.user.id||(getTenantRole(session,tenantId)==="manager"&&membership.role==="tenant_admin")))throw Object.assign(Error("You cannot revoke this access."),{statusCode:403});
  await database.deleteRecord("memberships", membership.id);
  return { success: true };
}
