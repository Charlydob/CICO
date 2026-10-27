import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { SettingsIntegrations } from "../../components/SettingsIntegrations";
import {
  getBackendStatus,
  getDashboardSettings,
  getAppVersion,
  getIntegrationSettings,
  updateDashboardSettings,
  updateTenantProfile,
  type AppVersion,
  type BackendStatus,
  type DashboardSettings,
  type DashboardWidgetKey,
  type IntegrationSettings,
} from "../../services/backendApi";
import { getBackendUrl } from "../../services/backendConfigService";
import type { ReservationLoadResult } from "../../types/reservation";

export function TechnicalSettingsPage() {
  const { session, activeTenantId, refreshSession } = useAuth();
  const [notice, setNotice] = useState("");
  const [backendStatus, setBackendStatus] = useState<BackendStatus>();
  const [integrationSettings, setIntegrationSettings] =
    useState<IntegrationSettings>();
  const [dashboardSettings, setDashboardSettings] =
    useState<DashboardSettings>();
  const [appVersion, setAppVersion] = useState<AppVersion>();
  const [backendUrl, setActiveBackendUrl] = useState(getBackendUrl());
  const activeTenant = session?.tenants.find(
    (tenant) => tenant.id === activeTenantId,
  );
  const activeTenantRole =
    session?.memberships.find(
      (membership) => membership.tenantId === activeTenantId,
    )?.role ||
    (session?.isPlatformAdmin && activeTenantId ? "platform_admin" : undefined);
  const canEditHotel =
    activeTenantRole === "tenant_admin" ||
    activeTenantRole === "platform_admin";
  const [hotelName, setHotelName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [address, setAddress] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [phone, setPhone] = useState("");

  async function refreshBackendState() {
    const [nextStatus, nextSettings, nextVersion] = await Promise.all([
      getBackendStatus(),
      getIntegrationSettings(),
      getAppVersion(),
    ]);
    setBackendStatus(nextStatus);
    setIntegrationSettings(nextSettings);
    setAppVersion(nextVersion);
    if (canEditHotel) {
      setDashboardSettings(await getDashboardSettings());
    }
  }

  useEffect(() => {
    void refreshBackendState().catch((error) =>
      setNotice(
        error instanceof Error ? error.message : "Could not load settings.",
      ),
    );
  }, []);

  useEffect(() => {
    setHotelName(activeTenant?.name || "");
    setDisplayName(
      activeTenant?.basicInfo?.displayName || activeTenant?.name || "",
    );
    setAddress(activeTenant?.basicInfo?.address || "");
    setContactEmail(activeTenant?.basicInfo?.contactEmail || "");
    setPhone(activeTenant?.basicInfo?.phone || "");
  }, [activeTenant]);

  async function saveHotelProfile() {
    await updateTenantProfile({
      name: hotelName,
      displayName,
      basicInfo: {
        displayName,
        address,
        contactEmail,
        phone,
      },
    });
    await refreshSession();
    setNotice("Hotel profile saved.");
  }

  async function saveDashboardWidgets(nextSettings = dashboardSettings) {
    if (!nextSettings) return;
    setDashboardSettings(await updateDashboardSettings(nextSettings));
    setNotice("Dashboard widgets saved.");
  }

  function toggleWidget(
    role: keyof DashboardSettings["widgets"],
    key: DashboardWidgetKey,
  ) {
    if (!dashboardSettings) return;
    const next = {
      widgets: {
        ...dashboardSettings.widgets,
        [role]: {
          ...dashboardSettings.widgets[role],
          [key]: !dashboardSettings.widgets[role][key],
        },
      },
    };
    setDashboardSettings(next);
  }

  return (
    <section className="module-page">
      {notice && (
        <div
          className={notice.includes("Could not") ? "notice error" : "notice"}
        >
          {notice}
        </div>
      )}
      {canEditHotel && (
        <section className="panel">
          <div className="section-heading">
            <h2>Hotel Profile</h2>
            <span>{activeTenant?.slug}</span>
          </div>
          <div className="settings-form">
            <div className="settings-split">
              <label>
                <span>Hotel name</span>
                <input
                  value={hotelName}
                  onChange={(event) => setHotelName(event.target.value)}
                />
              </label>
              <label>
                <span>Visible name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
            </div>
            <label>
              <span>Address</span>
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            </label>
            <div className="settings-split">
              <label>
                <span>Contact email</span>
                <input
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                />
              </label>
              <label>
                <span>Phone</span>
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </label>
            </div>
            <div className="button-row">
              <button type="button" onClick={() => void saveHotelProfile()}>
                <Save size={15} />
                Save hotel
              </button>
            </div>
          </div>
        </section>
      )}
      {canEditHotel && dashboardSettings && (
        <section className="panel">
          <div className="section-heading">
            <h2>Dashboard widgets</h2>
          </div>
          <div className="settings-form dashboard-widget-settings">
            {(
              Object.keys(dashboardSettings.widgets) as Array<
                keyof DashboardSettings["widgets"]
              >
            ).map((role) => (
              <div key={role} className="widget-role-block">
                <strong>{role}</strong>
                <div className="widget-toggle-grid">
                  {(
                    Object.keys(
                      dashboardSettings.widgets[role],
                    ) as DashboardWidgetKey[]
                  ).map((key) => (
                    <label key={key} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={dashboardSettings.widgets[role][key]}
                        onChange={() => toggleWidget(role, key)}
                      />
                      <span>{key}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <button type="button" onClick={() => void saveDashboardWidgets()}>
              <Save size={15} />
              Save widgets
            </button>
          </div>
        </section>
      )}
      <SettingsIntegrations
        settings={integrationSettings}
        backendStatus={backendStatus}
        backendUrl={backendUrl}
        onBackendUrlChange={async (url) => {
          setActiveBackendUrl(url);
          await refreshBackendState();
        }}
        onSettingsChange={setIntegrationSettings}
        onNotice={setNotice}
        onRefreshReservations={async () => {
          await refreshBackendState();
        }}
      />
      <section className="panel">
        <div className="section-heading">
          <h2>About</h2>
        </div>
        <div className="meta-list settings-form">
          <span>Version</span>
          <strong>{appVersion?.version || "unknown"}</strong>
          <span>Environment</span>
          <strong>{appVersion?.environment || "unknown"}</strong>
        </div>
      </section>
    </section>
  );
}

export const emptyReservationDiagnostics: ReservationLoadResult = {
  reservations: [],
  source: "demo",
  updatedAt: new Date().toISOString(),
};
