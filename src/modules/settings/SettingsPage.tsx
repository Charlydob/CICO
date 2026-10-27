import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { TenantUsersPage } from "./TenantUsersPage";
import { HookboxDevicesPage } from "../hookbox/HookboxDevicesPage";
import {
  updateTenantProfile,
  hotelPaymentRequest,
} from "../../services/backendApi";
export function SettingsPage() {
  const { session, activeTenantId, refreshSession } = useAuth(),
    hotel = session?.tenants.find((h) => h.id === activeTenantId);
  const base = "/t/" + encodeURIComponent(hotel?.slug || "") + "/settings",
    section =
      window.location.pathname.split("/settings")[1]?.split("/")[1] ||
      (window.location.pathname.endsWith("/integrations")
        ? "integrations"
        : "general");
  const [name, setName] = useState(hotel?.name || ""),
    [address, setAddress] = useState(hotel?.basicInfo?.address || ""),
    [email, setEmail] = useState(hotel?.basicInfo?.contactEmail || ""),
    [phone, setPhone] = useState(hotel?.basicInfo?.phone || ""),
    [timezone, setTimezone] = useState(hotel?.basicInfo?.timezone || "UTC"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="module-page customer-settings">
      <div className="module-title">
        <div>
          <h1>Settings</h1>
          <p>{hotel?.name}</p>
        </div>
      </div>
      <nav className="settings-tabs" aria-label="Hotel settings">
        {[
          ["general", "General"],
          ["users", "Staff & Users"],
          ["display", "HOOKBOX Display"],
          ["payments", "Payments"],
          ["integrations", "Integrations"],
        ].map(([key, label]) => (
          <a
            key={key}
            className={section === key ? "active" : ""}
            href={base + "/" + key}
          >
            {label}
          </a>
        ))}
      </nav>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {section === "users" ? (
        <TenantUsersPage />
      ) : section === "display" ? (
        <HookboxDevicesPage />
      ) : section === "payments" ? (
        <PaymentsSettings />
      ) : section === "integrations" ? (
        <section className="panel integration-summary">
          <h2>Property management system</h2>
          <span className="status-tag">Not connected</span>
          <p>
            PMS connection is coming soon. Your hotel’s rooms and daily
            departures can be managed manually.
          </p>
        </section>
      ) : (
        <form
          className="panel settings-compact"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setNotice("");
            try {
              await updateTenantProfile({
                name,
                displayName: name,
                basicInfo: {
                  ...hotel?.basicInfo,
                  displayName: name,
                  address,
                  contactEmail: email,
                  phone,
                  timezone,
                },
              });
              await refreshSession();
              setNotice("Hotel details saved.");
            } catch (err) {
              setNotice((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>General</h2>
          <label>
            Hotel name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <div className="settings-split">
            <label>
              Contact email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Phone
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
          </div>
          <label>
            Time zone
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Europe/Zurich"
            />
            <small>Used for daily checkout and housekeeping dates.</small>
          </label>
          <button className="primary" disabled={busy} type="submit">
            {busy ? "Saving…" : "Save changes"}
          </button>
        </form>
      )}
    </section>
  );
}
function PaymentsSettings() {
  const [state, setState] = useState<{
      connected: boolean;
      mode: string | null;
      connectAvailable: boolean;
    }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetchPayment()
      .then(setState)
      .catch((e) => setError(e.message));
  }, []);
  async function fetchPayment() {
    const r = await hookboxRequestPayment("GET");
    return r;
  }
  async function action(type: string) {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      if (
        type === "connect" &&
        state?.connected &&
        !window.confirm("Replace the Stripe connection for this hotel?")
      )
        return;
      if (
        type === "disconnect" &&
        !window.confirm(
          "Disconnect Stripe from this hotel? Existing payments and history will be kept.",
        )
      )
        return;
      const r = await hookboxRequestPayment("POST", { action: type });
      if (r.url) window.location.assign(r.url);
      else setState(await fetchPayment());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel integration-summary">
      <h2>Stripe</h2>
      {error && <p role="alert">{error}</p>}
      {new URLSearchParams(window.location.search).get("connection") ===
        "connected" && <p role="status">Stripe account connected.</p>}
      {new URLSearchParams(window.location.search).get("connection") ===
        "cancelled" && (
        <p role="status">
          Connection cancelled. Your existing settings have been kept.
        </p>
      )}
      {!state ? (
        <p>Loading payment connection…</p>
      ) : (
        <>
          <span className="status-tag">
            {state.connected ? "Connected" : "Not connected"}
          </span>
          {state.mode && (
            <strong>
              {state.mode === "live"
                ? "Live payments"
                : "Test mode — no live charges"}
            </strong>
          )}
          <p>
            Connect your Stripe account securely. Credentials stay on the
            server.
          </p>
          <div className="button-row">
            <button
              disabled={busy || !state.connectAvailable}
              onClick={() => void action("connect")}
            >
              {state.connected ? "Reconnect Stripe" : "Connect Stripe"}
            </button>
            {state.connected && (
              <button disabled={busy} onClick={() => void action("disconnect")}>
                Disconnect
              </button>
            )}
          </div>
          {!state.connectAvailable && (
            <p>Account linking is not configured by the platform yet.</p>
          )}
        </>
      )}
    </section>
  );
}
async function hookboxRequestPayment(
  method: string,
  body?: unknown,
): Promise<any> {
  return hotelPaymentRequest(method, body);
}
