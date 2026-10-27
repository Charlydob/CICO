import { getDeviceIntegration, saveDeviceIntegration, rotateDeviceWebhookSecret } from "../hookbox/integration.js";
import { MODULE_REGISTRY } from "../moduleRegistry.js";
import {
  createTenant,
  deleteTenant,
  requirePlatformAdmin,
  setTenantModule,
  updateTenant,
} from "../services/tenantService.js";
import {
  getTenantSettings,
  getPublicTenantSettings,
  updateTenantSettings,
} from "../services/tenantSettingsService.js";
import {
  createUserInvitation,
  getInvitationLink,
  listTenantInvitations,
  regenerateUserInvitation,
  revokeTenantMembership,
  revokeUserInvitation,
  updateTenantMembershipRole,
} from "../services/invitationService.js";
import {
  displayNameForMembership,
  updateTenantMembershipAlias,
} from "../services/userDisplayService.js";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

async function buildTenantAdminSummary(database, tenant, memberships, users) {
  const [modules, settings, rooms, keys, invitations] = await Promise.all([
    database.getTenantModules(tenant.id),
    getTenantSettings(database, tenant.id),
    database.listTenantRecords("rooms", tenant.id),
    database.listTenantRecords("keyIdentifiers", tenant.id),
    listTenantInvitations(database, tenant.id),
  ]);
  const tenantMemberships = safeArray(memberships).filter(
    (membership) => membership.tenantId === tenant.id,
  );
  const tenantUsers = tenantMemberships.map((membership) => ({
    ...membership,
    status: "active",
    displayName: displayNameForMembership(
      safeArray(users).find((user) => user.id === membership.userId),
      membership,
    ),
    user: (() => {
      const user = safeArray(users).find((candidate) => candidate.id === membership.userId) || {
        id: membership.userId,
        email: "",
        displayName: "",
      };
      const { passwordHash, usernameNormalized, ...safeUser } = user;
      return safeUser;
    })(),
  }));

  return {
    ...tenant,
    users: tenantUsers,
    invitations,
    userCount: tenantUsers.length,
    modules: modules || {},
    settingsSummary: {
      reservationSource: settings?.reservations?.source || "demo",
      frigateBaseUrl: settings?.frigate?.baseUrl || "",
      stripeConnected: Boolean(settings?.stripe?.secretKey && settings?.stripe?.webhookSecret),
      telegramEnabled: Boolean(settings?.notifications?.telegram?.enabled),
      rooms: safeArray(rooms).length,
      keys: safeArray(keys).length,
      updatedAt: settings?.updatedAt || null,
    },
  };
}

function requestBaseUrl(request) {
  return (
    process.env.APP_ORIGIN ||
    process.env.FRONTEND_URL ||
    request.headers.origin ||
    `http://${request.headers.host || "127.0.0.1:5173"}`
  );
}

export async function handleAdminRoute({ request, pathname, body, context }) {
  const { database, session } = context;
  requirePlatformAdmin(session);

  const deviceIntegration = pathname.match(/^\/api\/admin\/devices\/([a-f0-9-]{36})\/integration(\/rotate-secret)?$/);
  if (deviceIntegration) {
    const id = deviceIntegration[1];
    const device = await database.prisma.device.findUnique({
      where: { id }, select: { tenantId: true, hardwareModel: true },
    });
    if (!device?.tenantId || device.hardwareModel !== "CROWPANEL_7_V3") {
      throw Object.assign(new Error("HOOKBOX device not found."), { statusCode: 404 });
    }
    if (request.method === "GET" && !deviceIntegration[2])
      return { status: 200, payload: await getDeviceIntegration(database, device.tenantId, id) };
    if (request.method === "POST" && !deviceIntegration[2])
      return { status: 200, payload: await saveDeviceIntegration(database, device.tenantId, id, body) };
    if (request.method === "POST" && deviceIntegration[2])
      return { status: 200, payload: await rotateDeviceWebhookSecret(database, device.tenantId, id) };
    return { status: 405, payload: { error: "Method not allowed" } };
  }

  if (request.method === "GET" && pathname === "/api/admin/tenants") {
    const [tenants, memberships, users] = await Promise.all([
      database.listRecords("tenants"),
      database.listRecords("memberships"),
      database.listRecords("users"),
    ]);

    const payload = [];
    for (const tenant of safeArray(tenants)) {
      payload.push(await buildTenantAdminSummary(database, tenant, memberships, users));
    }

    return { status: 200, payload };
  }

  if (request.method === "POST" && pathname === "/api/admin/tenants") {
    return { status: 201, payload: await createTenant(database, body) };
  }

  const tenantMatch = pathname.match(/^\/api\/admin\/tenants\/([^/]+)$/);
  if (request.method === "GET" && tenantMatch) {
    const tenantId = decodeURIComponent(tenantMatch[1]);
    const [tenant, memberships, users, modules] = await Promise.all([
      database.getRecord("tenants", tenantId),
      database.listRecords("memberships"),
      database.listRecords("users"),
      database.getTenantModules(tenantId),
    ]);

    if (!tenant) {
      const error = new Error("Tenant not found.");
      error.statusCode = 404;
      throw error;
    }

    return {
      status: 200,
      payload: {
        tenant,
        users,
        memberships: memberships.filter((membership) => membership.tenantId === tenantId),
        modules,
        moduleRegistry: MODULE_REGISTRY,
      },
    };
  }

  if (request.method === "PATCH" && tenantMatch) {
    const tenantId = decodeURIComponent(tenantMatch[1]);
    return { status: 200, payload: await updateTenant(database, tenantId, body) };
  }

  if (request.method === "DELETE" && tenantMatch) {
    const tenantId = decodeURIComponent(tenantMatch[1]);
    return { status: 200, payload: await deleteTenant(database, tenantId) };
  }

  const tenantIntegrationsMatch = pathname.match(
    /^\/api\/admin\/tenants\/([^/]+)\/settings\/integrations$/,
  );
  if (request.method === "GET" && tenantIntegrationsMatch) {
    const tenantId = decodeURIComponent(tenantIntegrationsMatch[1]);
    return {
      status: 200,
      payload: await getPublicTenantSettings(database, tenantId),
    };
  }

  if (request.method === "PATCH" && tenantIntegrationsMatch) {
    const tenantId = decodeURIComponent(tenantIntegrationsMatch[1]);
    await updateTenantSettings(database, tenantId, body);
    return {
      status: 200,
      payload: await getPublicTenantSettings(database, tenantId),
    };
  }

  const invitationCreateMatch = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/invitations$/);
  if (request.method === "POST" && invitationCreateMatch) {
    return {
      status: 201,
      payload: await createUserInvitation(
        database,
        session,
        decodeURIComponent(invitationCreateMatch[1]),
        body,
        { baseUrl: requestBaseUrl(request) },
      ),
    };
  }

  const membershipDeleteMatch = pathname.match(
    /^\/api\/admin\/tenants\/([^/]+)\/memberships\/([^/]+)$/,
  );
  if (request.method === "DELETE" && membershipDeleteMatch) {
    return {
      status: 200,
      payload: await revokeTenantMembership(
        database,
        session,
        decodeURIComponent(membershipDeleteMatch[1]),
        decodeURIComponent(membershipDeleteMatch[2]),
      ),
    };
  }

  if (request.method === "PATCH" && membershipDeleteMatch) {
    return {
      status: 200,
      payload: await updateTenantMembershipRole(
        database,
        session,
        decodeURIComponent(membershipDeleteMatch[1]),
        decodeURIComponent(membershipDeleteMatch[2]),
        body.role,
      ),
    };
  }

  const membershipAliasMatch = pathname.match(
    /^\/api\/admin\/tenants\/([^/]+)\/memberships\/([^/]+)\/alias$/,
  );
  if (request.method === "PATCH" && membershipAliasMatch) {
    return {
      status: 200,
      payload: await updateTenantMembershipAlias(
        database,
        session,
        decodeURIComponent(membershipAliasMatch[1]),
        decodeURIComponent(membershipAliasMatch[2]),
        body,
        (currentSession) => requirePlatformAdmin(currentSession),
      ),
    };
  }

  const invitationMatch = pathname.match(
    /^\/api\/admin\/tenants\/([^/]+)\/invitations\/([^/]+)$/,
  );
  if (request.method === "GET" && invitationMatch) {
    return {
      status: 200,
      payload: await getInvitationLink(
        database,
        session,
        decodeURIComponent(invitationMatch[1]),
        decodeURIComponent(invitationMatch[2]),
        requestBaseUrl(request),
      ),
    };
  }

  if (request.method === "DELETE" && invitationMatch) {
    return {
      status: 200,
      payload: await revokeUserInvitation(
        database,
        session,
        decodeURIComponent(invitationMatch[1]),
        decodeURIComponent(invitationMatch[2]),
      ),
    };
  }

  const invitationRegenerateMatch = pathname.match(
    /^\/api\/admin\/tenants\/([^/]+)\/invitations\/([^/]+)\/regenerate$/,
  );
  if (request.method === "POST" && invitationRegenerateMatch) {
    return {
      status: 200,
      payload: await regenerateUserInvitation(
        database,
        session,
        decodeURIComponent(invitationRegenerateMatch[1]),
        decodeURIComponent(invitationRegenerateMatch[2]),
        requestBaseUrl(request),
      ),
    };
  }

  const moduleMatch = pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/modules\/([^/]+)$/);
  if (request.method === "PATCH" && moduleMatch) {
    return {
      status: 200,
      payload: await setTenantModule(
        database,
        decodeURIComponent(moduleMatch[1]),
        decodeURIComponent(moduleMatch[2]),
        body.enabled,
      ),
    };
  }

  return undefined;
}
