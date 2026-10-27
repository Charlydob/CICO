import {
  requirePlatformAdmin,
  requireTenant,
  requireTenantManager,
} from "./tenantService.js";
export function authorizeCustomerRoute(session, method, path) {
  if (
    path.startsWith("/api/admin/") ||
    /^\/api\/(test-|plates\/|reservations\/(debug|refresh))/.test(path) ||
    /^\/api\/settings\/(frigate|google-sheets|json-feed|reservation-|notifications|stripe\/test)/.test(
      path,
    ) ||
    path.startsWith("/api/integrations/telegram/")
  )
    requirePlatformAdmin(session);
  if (path === "/api/settings/integrations") {
    requireTenant(session);
    requireTenantManager(session);
  }
  if (path === "/api/settings/stripe") requirePlatformAdmin(session);
}
export async function authorizeEvidence(database, session, kind, filename) {
  const tenantId = requireTenant(session);
  const field = kind === "snapshot" ? "localSnapshotPath" : "localVideoPath";
  const rows = await database.listTenantRecords("detections", tenantId);
  const valid = rows.some(
    (d) =>
      String(d[field] || "")
        .replace(/\\/g, "/")
        .split("/")
        .pop() === filename ||
      String(d[kind === "snapshot" ? "snapshotUrl" : "videoUrl"] || "")
        .split("/")
        .pop() === filename,
  );
  if (!valid)
    throw Object.assign(Error("Evidence not found."), { statusCode: 404 });
}
export function customerIntegrationSettings(settings) {
  return {
    reservations: {
      source: "not_connected",
      mapping: {},
      googleSheets: { connected: false },
      jsonFeed: { connected: false, auth: {} },
      reservationWebhook: { connected: false },
      sourceDiagnostics: {},
    },
    stripe: {
      connected: settings.stripe.connected,
      mode: settings.stripe.mode || null,
    },
    frigate: { connected: false },
    notifications: {},
    dashboard: settings.dashboard,
  };
}
