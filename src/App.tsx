import { useEffect, useMemo, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AcceptInvitePage } from "./auth/AcceptInvitePage";
import { LoginPage } from "./auth/LoginPage";
import { CheckInDemoPage } from "./components/CheckInDemoPage";
import { OnboardingGate } from "./components/OnboardingGate";
import { AppLayout, type AppRoute } from "./layouts/AppLayout";
import { DevicesFirmwarePage } from "./modules/admin/DevicesFirmwarePage";
import { AdminPage } from "./modules/admin/AdminPage";
import { CheckoutPage } from "./modules/checkout/CheckoutPage";
import { PublicCheckoutPage } from "./modules/checkout/PublicCheckoutPage";
import { DashboardPage } from "./modules/dashboard/DashboardPage";
import { ParkingPage } from "./modules/parking/ParkingPage";
import { ProfilePage } from "./modules/profile/ProfilePage";
import { SettingsPage } from "./modules/settings/SettingsPage";
import { TenantUsersPage } from "./modules/settings/TenantUsersPage";
import type { ModuleId } from "./types/modules";

function routeFromPath(): AppRoute {
  const path = window.location.pathname.replace(/^\/t\/[^/]+/, "") || "/";

  if (path.startsWith("/parking")) {
    return "parking";
  }

  if (path.startsWith("/housekeeping")) {
    return "housekeeping";
  }

  if (path.startsWith("/checkout")) {
    return "checkout";
  }

  if (path.startsWith("/reservations")) {
    return "reservations";
  }

  if (path.startsWith("/integrations")) {
    return "integrations";
  }

  if (path.startsWith("/settings")) {
    if (path.startsWith("/settings/users")) {
      return "users";
    }

    return "settings";
  }

  if (path.startsWith("/admin/devices")) return "devices";

  if (path.startsWith("/admin")) {
    return "admin";
  }

  if (path.startsWith("/profile")) {
    return "profile";
  }

  return "dashboard";
}

function tenantSlugFromPath() {
  const match = window.location.pathname.match(/^\/t\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function pathFromRoute(route: AppRoute, tenantSlug?: string) {
  if (route === "devices") return "/admin/devices";

  if (route === "admin") {
    return "/admin";
  }

  const prefix = tenantSlug ? `/t/${encodeURIComponent(tenantSlug)}` : "";

  if (route === "users") {
    return `${prefix}/settings/users`;
  }

  if (route === "profile") {
    return `${prefix}/profile`;
  }

  return route === "dashboard" ? `${prefix || "/"}` : `${prefix}/${route}`;
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="module-page">
      <div className="module-title">
        <div>
          <h1>{title}</h1>
          <p>This area is reserved for the next implementation phase.</p>
        </div>
      </div>
    </section>
  );
}

function PrivateApp() {
  const { user, session, activeTenantId, loading, error } = useAuth();
  const [route, setRoute] = useState<AppRoute>(routeFromPath());
  const activeTenant = session?.tenants.find((tenant) => tenant.id === activeTenantId);

  useEffect(() => {
    const handler = () => setRoute(routeFromPath());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const enabledModules = useMemo(
    () =>
      (activeTenantId && session?.modulesByTenant[activeTenantId]) ||
      ({} as Record<ModuleId, boolean>),
    [activeTenantId, session?.modulesByTenant],
  );
  const activeTenantRole = session?.memberships.find(
    (membership) => membership.tenantId === activeTenantId,
  )?.role || (session?.isPlatformAdmin && activeTenantId ? "platform_admin" : undefined);
  const canConfigureTenant =
    activeTenantRole === "platform_admin" || activeTenantRole === "tenant_admin";

  function navigate(nextRoute: AppRoute) {
    window.history.pushState(
      {},
      "",
      pathFromRoute(nextRoute, nextRoute === "admin" ? undefined : activeTenant?.slug || tenantSlugFromPath()),
    );
    setRoute(nextRoute);
  }

  if (loading) {
    return <main className="loading-screen">Loading session...</main>;
  }

  if (!user) {
    return <LoginPage />;
  }

  if (!session || (!activeTenantId && !session.isPlatformAdmin)) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <h1>Access not configured</h1>
          <p>{error || "Your user does not have a tenant membership yet."}</p>
        </section>
      </main>
    );
  }

  const visibleRoute =
    session.isPlatformAdmin && !activeTenantId && route !== "devices"
      ? "admin"
      : (
          (route === "users" &&
            !canConfigureTenant) ||
          ((route === "settings" || route === "integrations") && !canConfigureTenant) ||
          (route === "parking" && !enabledModules.parking) ||
          (route === "housekeeping" && !enabledModules.checkout) ||
          (route === "checkout" && !enabledModules.checkout)
            ? "dashboard"
            : route
        );

  const page =
    visibleRoute === "parking" ? (
      <ParkingPage />
    ) : visibleRoute === "profile" ? (
      <ProfilePage />
    ) : visibleRoute === "checkout" ? (
      <CheckoutPage />
    ) : visibleRoute === "devices" && session.isPlatformAdmin ? (
      <DevicesFirmwarePage />
    ) : visibleRoute === "admin" && session.isPlatformAdmin ? (
      <AdminPage />
    ) : visibleRoute === "integrations" || visibleRoute === "settings" ? (
      <SettingsPage />
    ) : visibleRoute === "users" ? (
      <TenantUsersPage />
    ) : visibleRoute === "reservations" ? (
      <PlaceholderPage title="Reservations" />
    ) : (
      <DashboardPage enabledModules={enabledModules} focusHousekeeping={visibleRoute === "housekeeping"} />
    );

  return (
    <AppLayout route={visibleRoute} onRouteChange={navigate} enabledModules={enabledModules}>
      <OnboardingGate>
        <div key={activeTenantId || "no-tenant"}>{page}</div>
      </OnboardingGate>
    </AppLayout>
  );
}

export default function App() {
  if (window.location.pathname === "/checkin-demo") {
    return <CheckInDemoPage />;
  }

  if (
    /^\/public\/[^/]+\/checkout$/.test(window.location.pathname) ||
    /^\/checkout\/[^/]+$/.test(window.location.pathname)
  ) {
    return <PublicCheckoutPage />;
  }

  if (/^\/accept-invite\/[^/]+$/.test(window.location.pathname)) {
    return (
      <AuthProvider>
        <AcceptInvitePage />
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <PrivateApp />
    </AuthProvider>
  );
}
