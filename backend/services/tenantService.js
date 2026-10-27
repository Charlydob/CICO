import { IMPLEMENTED_MODULE_IDS, MODULE_REGISTRY, isKnownModule } from "../moduleRegistry.js";
import { randomUUID } from "node:crypto";
import {
  createEmptyTenantSettings,
  getTenantSettings,
  updateTenantSettings,
} from "./tenantSettingsService.js";
import argon2 from "argon2";

export const DEFAULT_TENANT_ID =
  process.env.DEFAULT_TENANT_ID || "00000000-0000-4000-8000-000000000001";
const DEFAULT_TENANT_SLUG = process.env.DEFAULT_TENANT_SLUG || "default-hotel";
const DEFAULT_TENANT_NAME = process.env.DEFAULT_TENANT_NAME || "Default Hotel";
export const DEMO_TENANT_ID =
  process.env.DEMO_TENANT_ID || "00000000-0000-4000-8000-000000000002";
const DEMO_TENANT_SLUG = "demo-hotel";
const DEMO_TENANT_NAME = "Demo Hotel";
const DEMO_FRIGATE_BASE_URL = "http://frigate:5000";

function now() {
  return new Date().toISOString();
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function hashBootstrapPassword(password) {
  if (String(password || "").length < 8) {
    const error = new Error("BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters.");
    error.statusCode = 500;
    throw error;
  }

  return argon2.hash(String(password), { type: argon2.argon2id });
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function modulesResponse(moduleMap = {}) {
  return MODULE_REGISTRY.map((module) => ({
    ...module,
    enabled: Boolean(moduleMap[module.id]),
  }));
}

function publicUser(user) {
  const { passwordHash, usernameNormalized, ...safeUser } = user;
  return safeUser;
}

export async function ensureBootstrapTenant(database) {
  const existing = await database.getRecord("tenants", DEFAULT_TENANT_ID);
  const timestamp = now();

  if (!existing) {
    await database.setRecord("tenants", DEFAULT_TENANT_ID, {
      id: DEFAULT_TENANT_ID,
      name: DEFAULT_TENANT_NAME,
      slug: DEFAULT_TENANT_SLUG,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const currentModules = await database.getTenantModules(DEFAULT_TENANT_ID);

  for (const moduleId of IMPLEMENTED_MODULE_IDS) {
    if (currentModules[moduleId] === undefined) {
      await database.setTenantModule(DEFAULT_TENANT_ID, moduleId, true);
    }
  }

  await ensureDemoTenant(database);

  const platformAdmins = (await database.listRecords("users")).filter(
    (user) => user.globalRole === "platform_admin",
  );

  if (platformAdmins.length > 0) {
    return;
  }

  const email = cleanString(process.env.BOOTSTRAP_ADMIN_EMAIL).toLowerCase();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || "");

  if (!email || !password) {
    console.warn(
      "[Auth] No platform_admin exists. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD before first production start.",
    );
    return;
  }

  await database.setRecord("users", randomUUID(), {
    email,
    passwordHash: await hashBootstrapPassword(password),
    displayName: email,
    globalRole: "platform_admin",
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function ensureDemoTenant(database) {
  const timestamp = now();
  const tenants = await database.listRecords("tenants");
  const existing =
    tenants.find((tenant) => tenant.slug === DEMO_TENANT_SLUG) ||
    (await database.getRecord("tenants", DEMO_TENANT_ID));
  const tenantId = existing?.id || DEMO_TENANT_ID;

  if (!existing) {
    await database.setRecord("tenants", tenantId, {
      id: tenantId,
      name: DEMO_TENANT_NAME,
      slug: DEMO_TENANT_SLUG,
      active: true,
      basicInfo: {
        displayName: DEMO_TENANT_NAME,
        address: "",
        contactEmail: "",
        phone: "",
        timezone: "",
        demo: true,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } else if (existing.name !== DEMO_TENANT_NAME || existing.slug !== DEMO_TENANT_SLUG) {
    await database.setRecord("tenants", tenantId, {
      ...existing,
      name: DEMO_TENANT_NAME,
      slug: DEMO_TENANT_SLUG,
      basicInfo: {
        ...(existing.basicInfo || {}),
        displayName: existing.basicInfo?.displayName || DEMO_TENANT_NAME,
        demo: true,
      },
      updatedAt: timestamp,
    });
  }

  for (const moduleId of IMPLEMENTED_MODULE_IDS) {
    await database.setTenantModule(tenantId, moduleId, true);
  }

  const settings = await getTenantSettings(database, tenantId);
  if (!settings.createdAt) {
    await createEmptyTenantSettings(database, tenantId);
  }

  const nextSettings = await getTenantSettings(database, tenantId);
  if (!cleanString(nextSettings.frigate?.baseUrl)) {
    await updateTenantSettings(database, tenantId, {
      frigate: {
        enabled: true,
        baseUrl: DEMO_FRIGATE_BASE_URL,
        pollIntervalMs: nextSettings.frigate?.pollIntervalMs || 5000,
        cameras: nextSettings.frigate?.cameras || [],
      },
    });
  }

  return database.getRecord("tenants", tenantId);
}

export async function syncUserFromAuth(database, authUser) {
  const userId = authUser.id || authUser.uid;
  const user = userId ? await database.getRecord("users", userId) : undefined;

  if (!user) {
    const error = new Error("Authentication is required.");
    error.statusCode = 401;
    throw error;
  }

  return user;
}

export async function getAuthSession(database, authUser, selectedTenantId) {
  const user = await syncUserFromAuth(database, authUser);
  const memberships = safeArray(await database.getMembershipsForUser(user.id));
  const isPlatformAdmin = user.globalRole === "platform_admin";
  const tenants = safeArray(
    isPlatformAdmin
      ? await database.listRecords("tenants")
      : await Promise.all(
          memberships.map((membership) => database.getRecord("tenants", membership.tenantId)),
        ),
  );
  const activeTenants = tenants.filter((tenant) => tenant && tenant.active !== false);
  let activeTenantId = cleanString(selectedTenantId);

  if (activeTenantId) {
    const allowed =
      activeTenants.some(tenant=>tenant.id===activeTenantId) && (isPlatformAdmin || memberships.some((membership) => membership.tenantId === activeTenantId));

    if (!allowed) {
      const error = new Error("You do not have access to this tenant.");
      error.statusCode = 403;
      throw error;
    }
  } else {
    activeTenantId = isPlatformAdmin ? "" : activeTenants[0]?.id || "";
  }

  const modulesByTenant = {};
  for (const tenant of activeTenants) {
    modulesByTenant[tenant.id] = (await database.getTenantModules(tenant.id)) || {};
  }
  activeTenantId ||= "";
  const activeTenantModules = activeTenantId ? modulesByTenant[activeTenantId] || {} : {};

  return {
    user: publicUser(user),
    memberships,
    tenants: activeTenants,
    modules: modulesResponse(activeTenantModules),
    modulesByTenant,
    activeTenantId,
    isPlatformAdmin,
  };
}

export function requireTenant(session) {
  if (!session.activeTenantId) {
    const error = new Error("No tenant is available for this user.");
    error.statusCode = 403;
    throw error;
  }

  if(!session.isPlatformAdmin&&!session.memberships?.some(m=>m.tenantId===session.activeTenantId))throw Object.assign(Error("Hotel access denied."),{statusCode:403});
  return session.activeTenantId;
}

export async function requireModule(database, session, moduleId) {
  if (!isKnownModule(moduleId)) {
    const error = new Error("Unknown module.");
    error.statusCode = 404;
    throw error;
  }

  const tenantId = requireTenant(session);
  const modules = await database.getTenantModules(tenantId);

  if (!modules[moduleId]) {
    const error = new Error(`Module '${moduleId}' is not enabled for this tenant.`);
    error.statusCode = 403;
    throw error;
  }

  return tenantId;
}

export function requirePlatformAdmin(session) {
  if (!session.isPlatformAdmin) {
    const error = new Error("Platform admin access is required.");
    error.statusCode = 403;
    throw error;
  }
}

export function getTenantRole(session, tenantId = session.activeTenantId) {
  if (session.isPlatformAdmin) {
    return "platform_admin";
  }

  return session.memberships.find((membership) => membership.tenantId === tenantId)?.role;
}

export function requireTenantAdmin(session, tenantId = session.activeTenantId) {
  const role = getTenantRole(session, tenantId);

  if (!["tenant_admin","platform_admin","manager"].includes(role)) {
    const error = new Error("Tenant admin access is required.");
    error.statusCode = 403;
    throw error;
  }
}

export function requireTenantManager(session, tenantId = session.activeTenantId) {
  const role = getTenantRole(session, tenantId);

  if (!["platform_admin", "tenant_admin", "manager"].includes(role || "")) {
    const error = new Error("Manager access is required.");
    error.statusCode = 403;
    throw error;
  }
}

export async function createTenant(database, input) {
  const timestamp = now();
  const id = randomUUID();
  const slug = slugify(input.slug || input.name) || `tenant-${id.slice(0, 8)}`;
  const existing = (await database.listRecords("tenants")).find((tenant) => tenant.slug === slug);

  if (existing) {
    const error = new Error("A tenant with this slug already exists.");
    error.statusCode = 409;
    throw error;
  }

  const tenant = {
    id,
    name: cleanString(input.name) || "New Hotel",
    slug,
    active: input.active !== false,
    basicInfo: {
      displayName: cleanString(input.displayName || input.name) || "New Hotel",
      address: cleanString(input.address),
      contactEmail: cleanString(input.contactEmail),
      phone: cleanString(input.phone),
      timezone: cleanString(input.timezone),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await database.setRecord("tenants", id, tenant);

  for (const module of MODULE_REGISTRY) {
    await database.setTenantModule(id, module.id, Boolean(input.modules?.[module.id]));
  }

  await createEmptyTenantSettings(database, id);
  if (tenant.slug === DEMO_TENANT_SLUG) {
    await updateTenantSettings(database, id, {
      frigate: {
        enabled: true,
        baseUrl: DEMO_FRIGATE_BASE_URL,
        pollIntervalMs: 5000,
        cameras: [],
      },
    });
  }
  return tenant;
}

export async function updateTenant(database, tenantId, patch) {
  const current = await database.getRecord("tenants", tenantId);

  if (!current) {
    const error = new Error("Tenant not found.");
    error.statusCode = 404;
    throw error;
  }

  const nextSlug = slugify(patch.slug) || current.slug;
  if (nextSlug !== current.slug) {
    const tenants = await database.listRecords("tenants");
    const slugOwner = tenants.find(
      (tenant) => tenant.id !== tenantId && tenant.slug === nextSlug,
    );

    if (slugOwner) {
      const error = new Error("A tenant with this slug already exists.");
      error.statusCode = 409;
      throw error;
    }
  }

  const next = {
    ...current,
    name: cleanString(patch.name) || current.name,
    slug: nextSlug,
    active: patch.active === undefined ? current.active : Boolean(patch.active),
    basicInfo: {
      ...(current.basicInfo || {}),
      ...(patch.basicInfo || {}),
      displayName:
        cleanString(patch.basicInfo?.displayName ?? patch.displayName) ||
        current.basicInfo?.displayName ||
        cleanString(patch.name) ||
        current.name,
      address: patch.basicInfo?.address===undefined?current.basicInfo?.address||"":cleanString(patch.basicInfo.address),
      contactEmail:
        patch.basicInfo?.contactEmail===undefined?current.basicInfo?.contactEmail||"":cleanString(patch.basicInfo.contactEmail),
      phone: patch.basicInfo?.phone===undefined?current.basicInfo?.phone||"":cleanString(patch.basicInfo.phone),
      timezone: patch.basicInfo?.timezone===undefined?current.basicInfo?.timezone||"":cleanString(patch.basicInfo.timezone),
    },
    updatedAt: now(),
  };

  await database.setRecord("tenants", tenantId, next);
  return next;
}

export async function deleteTenant(database, tenantId) {
  const current = await database.getRecord("tenants", tenantId);

  if (!current) {
    const error = new Error("Tenant not found.");
    error.statusCode = 404;
    throw error;
  }

  await database.deleteRecord("tenants", tenantId);
  return { success: true };
}

export async function assignUserToTenant(database, tenantId, input) {
  const userId = cleanString(input.userId);
  const role = ["tenant_admin", "manager", "staff"].includes(input.role) ? input.role : "staff";

  if (!userId) {
    const error = new Error("userId is required.");
    error.statusCode = 400;
    throw error;
  }

  const timestamp = now();
  const membership = {
    id: randomUUID(),
    tenantId,
    userId,
    role,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await database.setRecord("memberships", membership.id, membership);
  return membership;
}

export async function setTenantModule(database, tenantId, moduleId, enabled) {
  if (!isKnownModule(moduleId)) {
    const error = new Error("Unknown module.");
    error.statusCode = 400;
    throw error;
  }

  return database.setTenantModule(tenantId, moduleId, Boolean(enabled));
}
