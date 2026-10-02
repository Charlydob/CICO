import {
  Building2,
  CarFront,
  ClipboardCheck,
  ArrowLeft,
  Home,
  LogOut,
  MoreHorizontal,
  Settings,
  Shield,
  Users,
  UserCircle,
  Wrench,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { APP_NAME } from "../config/app";
import { MODULE_REGISTRY, type ModuleId } from "../types/modules";
import { useAuth } from "../auth/AuthContext";
import { useI18n, type TranslationKey } from "../i18n";

export type AppRoute =
  | "dashboard"
  | "housekeeping"
  | "parking"
  | "checkout"
  | "reservations"
  | "integrations"
  | "settings"
  | "users"
  | "devices"
  | "admin"
  | "profile";

interface AppLayoutProps {
  route: AppRoute;
  onRouteChange: (route: AppRoute) => void;
  enabledModules: Record<ModuleId, boolean>;
  children: ReactNode;
}

const routeIcons = {
  dashboard: Home,
  housekeeping: Sparkles,
  parking: CarFront,
  checkout: ClipboardCheck,
  reservations: Building2,
  integrations: Wrench,
  settings: Settings,
  users: Users,
  admin: Shield,
  devices: Wrench,
  profile: UserCircle,
};

export function AppLayout({ route, onRouteChange, enabledModules, children }: AppLayoutProps) {
  const { session, activeTenantId, selectTenant, logout } = useAuth();
  const { t } = useI18n();
  const enabled = MODULE_REGISTRY.filter((module) => enabledModules[module.id] && module.implemented);
  const activeTenant = session?.tenants.find((tenant) => tenant.id === activeTenantId);
  const activeTenantRole = session?.memberships.find(
    (membership) => membership.tenantId === activeTenantId,
  )?.role || (session?.isPlatformAdmin && activeTenantId ? "platform_admin" : undefined);
  const canConfigureTenant =
    activeTenantRole === "tenant_admin" || activeTenantRole === "platform_admin";
  const displayTenantName = activeTenant?.basicInfo?.displayName || activeTenant?.name || APP_NAME;
  const userInitial = (session?.user.username || session?.user.displayName || session?.user.email || "?")
    .slice(0, 1)
    .toUpperCase();

  function navButton(target: AppRoute, label: string, className = "") {
    const Icon = routeIcons[target];
    return (
      <button
        key={target}
        type="button"
        className={`${route === target ? "active" : ""} ${className}`.trim()}
        onClick={() => onRouteChange(target)}
      >
        <Icon size={17} />
        {label}
      </button>
    );
  }

  async function handleTenantChange(tenantId: string) {
    const tenant = session?.tenants.find((candidate) => candidate.id === tenantId);
    await selectTenant(tenantId || undefined);

    if (!tenantId) {
      window.history.pushState({}, "", "/admin");
      onRouteChange("admin");
      return;
    }

    const nextRoute = route === "admin" ? "dashboard" : route;
    const path =
      nextRoute === "dashboard"
        ? `/t/${encodeURIComponent(tenant?.slug || tenantId)}`
          : nextRoute === "users"
            ? `/t/${encodeURIComponent(tenant?.slug || tenantId)}/settings/users`
            : nextRoute === "profile"
              ? `/t/${encodeURIComponent(tenant?.slug || tenantId)}/profile`
            : `/t/${encodeURIComponent(tenant?.slug || tenantId)}/${nextRoute}`;
    window.history.pushState({}, "", path);
    onRouteChange(nextRoute);
  }

  const mobileNav = (() => {
    if (!activeTenantId) {
      return session?.isPlatformAdmin ? [{ route: "admin" as AppRoute, label: t("admin") }, { route: "devices" as AppRoute, label: "Devices / Firmware" }] : [];
    }

    if (activeTenantRole === "staff") {
      return [
        { route: "dashboard" as AppRoute, label: t("home") },
        { route: "housekeeping" as AppRoute, label: t("housekeeping") },
        { route: "profile" as AppRoute, label: t("profile") },
      ];
    }

    if (activeTenantRole === "manager") {
      return [
        { route: "dashboard" as AppRoute, label: t("home") },
        { route: "housekeeping" as AppRoute, label: t("housekeeping") },
        { route: enabledModules.checkout ? "checkout" as AppRoute : "dashboard" as AppRoute, label: t("operations") },
        { route: "profile" as AppRoute, label: t("profile") },
      ];
    }

    if (activeTenantRole === "tenant_admin") {
      return [
        { route: "dashboard" as AppRoute, label: t("home") },
        { route: enabledModules.checkout ? "checkout" as AppRoute : "dashboard" as AppRoute, label: t("operations") },
        { route: "users" as AppRoute, label: t("team") },
        { route: "settings" as AppRoute, label: t("more"), Icon: MoreHorizontal },
      ];
    }

    return [
      { route: "dashboard" as AppRoute, label: t("home") },
      { route: enabledModules.checkout ? "checkout" as AppRoute : "dashboard" as AppRoute, label: t("operations") },
      { route: "users" as AppRoute, label: t("team") },
      { route: "admin" as AppRoute, label: t("admin") },
      { route: "profile" as AppRoute, label: t("profile") },
    ];
  })();

  return (
    <div className="platform-shell">
      <header className="mobile-topbar">
        <div>
          <strong>{displayTenantName}</strong>
          {session?.isPlatformAdmin && activeTenantId && (
            <button type="button" className="support-chip" onClick={() => void handleTenantChange("")}>
              {t("supportMode")} - {t("exit")}
            </button>
          )}
        </div>
        <div className="mobile-topbar-actions">
          {session && session.tenants.length > 1 && (
            <select
              aria-label="Hotel"
              value={activeTenantId || ""}
              onChange={(event) => void handleTenantChange(event.target.value)}
            >
              {session.isPlatformAdmin && <option value="">Admin</option>}
              {session.tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>{tenant.name}</option>
              ))}
            </select>
          )}
          <button type="button" className="avatar-button" onClick={() => onRouteChange("profile")}>
            {userInitial}
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <strong>{APP_NAME}</strong>
          <span>{session?.user.email}</span>
        </div>
        {session?.tenants.length ? (
          <label className="tenant-picker">
            <span>Tenant</span>
            <select
              value={activeTenantId || ""}
              onChange={(event) => void handleTenantChange(event.target.value)}
            >
              {session.isPlatformAdmin && <option value="">Admin only</option>}
              {session.tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="tenant-empty">
            <span>Tenant</span>
            <strong>No tenant selected</strong>
          </div>
        )}
        <nav className="sidebar-nav" aria-label="Application navigation">
          {activeTenantId && (
            <>
              {navButton("dashboard", t("dashboard"))}
              {navButton("housekeeping", t("housekeeping"))}
              <span>{t("operations")}</span>
              {enabled.some((module) => module.id === "parking") && navButton("parking", t("parking"))}
              {enabled.some((module) => module.id === "checkout") && navButton("checkout", t("checkout"))}
              {canConfigureTenant && (
                <>
                  <span>{t("team")}</span>
                  {navButton("reservations", t("reservations"))}
                  <span>{t("settings")}</span>
                  {navButton("integrations", "Integrations")}
                  {navButton("settings", t("settings"))}
                  {navButton("users", t("team"))}
                </>
              )}
              {navButton("profile", t("profile"))}
            </>
          )}
          {session?.isPlatformAdmin && (
            <>
              <span>{t("admin")}</span>
              {navButton("admin", "Platform Admin")}
              {navButton("devices", "Devices / Firmware")}
            </>
          )}
        </nav>
        <button className="logout-button" type="button" onClick={() => void logout()}>
          <LogOut size={16} />
          {t("logout")}
        </button>
      </aside>
      <main className="platform-main">
        {session?.isPlatformAdmin && activeTenantId && (
          <div className="support-mode-banner desktop-only-support">
            <strong>{t("supportMode")} - {activeTenant?.name || activeTenantId}</strong>
            <button type="button" onClick={() => void handleTenantChange("")}>
              <ArrowLeft size={15} />
              {t("backToAdmin")}
            </button>
          </div>
        )}
        {children}
      </main>
      {mobileNav.length > 0 && (
        <nav className="bottom-nav" aria-label="Mobile navigation">
          {mobileNav.slice(0, 5).map((item) => {
            const Icon = item.Icon || routeIcons[item.route];
            return (
              <button
                key={`${item.route}-${item.label}`}
                type="button"
                className={route === item.route ? "active" : ""}
                onClick={() => onRouteChange(item.route)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
