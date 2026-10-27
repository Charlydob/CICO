import { Bell, BellOff, LogOut, Save, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { LOCALES, useI18n, type Locale } from "../../i18n";
import {
  BackendRequestError,
  getCheckoutPushDiagnostic,
  getPushStatus,
  sendPushTest,
  updatePushPreferences,
  updateMyProfile,
  type CheckoutPushDiagnostic,
  type PushStatus,
} from "../../services/backendApi";
import {
  activatePushDevice,
  browserSupportsWebPush,
  getCurrentBrowserSubscription,
  shouldShowIosInstallHint,
} from "../../services/pushClient";

function cleanDisplayName(value?: string | null) {
  return String(value || "").trim();
}

export function ProfilePage() {
  const { user, session, activeTenantId, logout, refreshSession } = useAuth();
  const { locale, setLocale, t } = useI18n();
  const [username, setUsername] = useState(user?.username || "");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [pushStatus, setPushStatus] = useState<PushStatus>();
  const [currentEndpoint, setCurrentEndpoint] = useState("");
  const [pushTestResult, setPushTestResult] = useState("");
  const [pushDiagnostic, setPushDiagnostic] = useState<CheckoutPushDiagnostic | null>(null);
  const membership = session?.memberships.find((item) => item.tenantId === activeTenantId);
  const activeTenant = session?.tenants.find((tenant) => tenant.id === activeTenantId);
  const role = membership?.role || (session?.isPlatformAdmin && activeTenantId ? "platform_admin" : "");
  const alias = cleanDisplayName(membership?.alias);
  const subscriptionActive = Boolean(
    currentEndpoint &&
      pushStatus?.subscriptions.some(
        (subscription) => subscription.endpoint === currentEndpoint && !subscription.disabledAt,
      ),
  );
  const pushActive = subscriptionActive && Boolean(pushStatus?.preference?.enabled);
  const canViewPushDiagnostics = Boolean(session?.isPlatformAdmin);

  const displayName = useMemo(
    () => alias || user?.username || user?.displayName || user?.email || "",
    [alias, user?.displayName, user?.email, user?.username],
  );

  const refreshPush = useCallback(async () => {
    if (!browserSupportsWebPush()) {
      setPushStatus(undefined);
      setCurrentEndpoint("");
      return;
    }
    const [status, subscription] = await Promise.all([
      getPushStatus(),
      getCurrentBrowserSubscription(),
    ]);
    setPushStatus(status);
    setCurrentEndpoint(subscription?.endpoint || "");
  }, []);

  useEffect(() => {
    setUsername(user?.username || "");
  }, [user?.username]);

  useEffect(() => {
    void refreshPush().catch(() => undefined);
    setPushTestResult("");
  }, [activeTenantId, refreshPush]);

  useEffect(() => {
    if (!canViewPushDiagnostics) {
      setPushDiagnostic(null);
      return;
    }
    void getCheckoutPushDiagnostic().then(setPushDiagnostic).catch(() => setPushDiagnostic(null));
  }, [activeTenantId, canViewPushDiagnostics]);

  async function saveProfile() {
    setBusy("profile");
    setNotice("");
    try {
      await updateMyProfile({ username: username.trim() || null });
      await refreshSession();
      setNotice(t("saved"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save profile.");
    } finally {
      setBusy("");
    }
  }

  async function toggleNotifications() {
    setBusy("push");
    setNotice("");
    try {
      if (pushActive) {
        await updatePushPreferences({ enabled: false });
      } else {
        await activatePushDevice();
      }
      await refreshPush();
      setNotice(t("saved"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update notifications.");
    } finally {
      setBusy("");
    }
  }

  async function testNotifications() {
    if (!currentEndpoint) {
      setPushTestResult("This device has no active push subscription.");
      return;
    }
    setBusy("push-test");
    setPushTestResult("");
    try {
      const result = await sendPushTest(currentEndpoint);
      setPushTestResult(
        `Provider accepted delivery${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}. ` +
          "This does not confirm that the notification appeared on the device.",
      );
      await refreshPush();
    } catch (error) {
      if (error instanceof BackendRequestError) {
        const status = Number(error.payload?.httpStatus || error.status) || undefined;
        const reason = String(error.payload?.providerReason || error.payload?.error || error.message);
        setPushTestResult(
          `Provider rejected delivery${status ? ` (HTTP ${status})` : ""}: ${reason}`,
        );
      } else {
        setPushTestResult(error instanceof Error ? error.message : "Could not send the test notification.");
      }
      await refreshPush().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="module-page profile-page">
      {notice && <div className={notice.includes("Could not") || notice.includes("must") ? "notice error" : "notice"}>{notice}</div>}
      <section className="panel profile-summary">
        <div className="profile-avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</div>
        <div>
          <h1>{displayName}</h1>
          <span>{activeTenant?.name || t("profile")}</span>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>{t("profile")}</h2>
        </div>
        <div className="settings-form">
          <label>
            <span>{t("username")}</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Charly" />
          </label>
          <div className="profile-meta-grid">
            <span>{t("email")}</span><strong>{user?.email}</strong>
            <span>{t("role")}</span><strong>{({tenant_admin:"Hotel owner",manager:"Manager",staff:"Staff",platform_admin:"Superadmin"} as Record<string,string>)[role||""]||"-"}</strong>
            <span>{t("hotelAlias")}</span><strong>{alias || "-"}</strong>
          </div>
          <button type="button" onClick={() => void saveProfile()} disabled={busy !== ""}>
            <Save size={15} /> {t("save")}
          </button>
        </div>
      </section>

      <details className="panel profile-settings" open><summary>Settings</summary>
        <div className="section-heading">
          <h2>{t("language")}</h2>
        </div>
        <div className="settings-form">
          <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
            {LOCALES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
      </details>

      <section className="panel">
        <div className="section-heading">
          <h2>{t("notifications")}</h2>
          <span>{pushActive ? t("enabled") : t("disabled")}</span>
        </div>
        <div className="notification-body compact-notifications">
          {!browserSupportsWebPush() && shouldShowIosInstallHint() ? (
            <p>{t("activateNotifications")}</p>
          ) : !browserSupportsWebPush() ? (
            <p>Web Push unavailable.</p>
          ) : (
            <>
              <button type="button" onClick={() => void toggleNotifications()} disabled={busy !== "" || !activeTenantId}>
                {pushActive ? <BellOff size={16} /> : <Bell size={16} />}
                {pushActive ? t("deactivateNotifications") : t("activateNotifications")}
              </button>
              {subscriptionActive && activeTenantId && (
                <button type="button" onClick={() => void testNotifications()} disabled={busy !== ""}>
                  <Send size={16} /> Send test notification
                </button>
              )}
              {pushTestResult && <p>{pushTestResult}</p>}
            </>
          )}
          {canViewPushDiagnostics && pushDiagnostic && (
            <details className="collapsible-panel">
              <summary>Last checkout diagnostic</summary>
              <div className="profile-meta-grid">
                <span>Intento</span><strong>{new Date(pushDiagnostic.attemptedAt).toLocaleString()}</strong>
                <span>Hotel / habitación</span><strong>{pushDiagnostic.hotelName} · {pushDiagnostic.roomNumber}</strong>
                <span>Evento</span><strong>{pushDiagnostic.eventSource} · {pushDiagnostic.eventId}</strong>
                <span>Estado</span><strong>{pushDiagnostic.status}</strong>
                <span>Destinatarios</span><strong>{pushDiagnostic.eligibleRecipients}</strong>
                <span>Suscripciones activas</span><strong>{pushDiagnostic.activeSubscriptions}</strong>
                <span>Suscripciones desactivadas</span><strong>{pushDiagnostic.disabledSubscriptions}</strong>
                <span>Destinatarios sin suscripción</span><strong>{pushDiagnostic.missingSubscriptions}</strong>
                <span>Aceptadas por proveedor</span><strong>{pushDiagnostic.acceptedByProvider}</strong>
                <span>Rechazadas</span><strong>{pushDiagnostic.rejectedByProvider}</strong>
              </div>
              {pushDiagnostic.results.map((result, index) => (
                <p key={result.subscriptionId || index}>
                  Suscripción {index + 1}: {result.status}
                  {result.httpStatus ? ` · HTTP ${result.httpStatus}` : ""}
                  {result.providerReason ? ` · ${result.providerReason}` : ""}
                  {result.error ? ` · ${result.error}` : ""}
                </p>
              ))}
              <small>“Aceptada” confirma la respuesta del proveedor, no la visualización en el iPhone.</small>
            </details>
          )}
        </div>
      </section>

      {session?.isPlatformAdmin && user?.telegramUserId && (
        <details className="panel collapsible-panel">
          <summary>{t("legacyIntegrations")}</summary>
          <div className="settings-form">
            <strong>Telegram @{user.telegramUsername?.replace(/^@/, "") || user.telegramUserId}</strong>
          </div>
        </details>
      )}

      <button className="logout-button profile-logout" type="button" onClick={() => void logout()}>
        <LogOut size={16} /> {t("logout")}
      </button>
    </section>
  );
}
