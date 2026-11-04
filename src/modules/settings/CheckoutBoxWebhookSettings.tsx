import { useEffect, useState } from "react";
import {
  getCheckoutBoxWebhookSettings,
  saveCheckoutBoxWebhookSettings,
  previewCheckoutBoxWebhook,
  testCheckoutBoxWebhookConnection,
  getCheckoutBoxWebhookDeliveries,
  type CheckoutBoxWebhookSettings as WebhookSettings,
  type CheckoutBoxWebhookDelivery,
} from "../../services/backendApi";

export function CheckoutBoxWebhookSettings() {
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [deliveries, setDeliveries] = useState<CheckoutBoxWebhookDelivery[]>([]);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [clearAuth, setClearAuth] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getCheckoutBoxWebhookSettings(), getCheckoutBoxWebhookDeliveries()])
      .then(([config, history]) => {
        if (!cancelled) { setSettings(config); setDeliveries(history); }
      }).catch((error) => { if (!cancelled) setNotice(error instanceof Error ? error.message : "Unable to load webhook settings."); });
    return () => { cancelled = true; };
  }, []);

  async function run(action: "save" | "preview") {
    if (!settings) return;
    setBusy(true); setNotice("");
    try {
      if (action === "save") {
        const saved = await saveCheckoutBoxWebhookSettings({ ...settings, clearAuth });
        setSettings({ ...saved, authHeaderValue: "" });
        setClearAuth(false);
        setNotice("Saved for this hotel. Future authorized RFID checkouts will use these settings.");
      } else {
        const example = await previewCheckoutBoxWebhook(settings);
        setPreview(JSON.stringify(example.payload, null, 2));
        setNotice("Example rendered locally. Nothing was sent to the hotel's API.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not process settings.");
    } finally { setBusy(false); }
  }

  async function testConnection() {
    if (!settings) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await testCheckoutBoxWebhookConnection(settings);
      setNotice(result.connected
        ? `Connected securely (${result.protocol}). DNS and TLS verified. No HTTP request or checkout sent.`
        : "Could not establish a secure connection.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Connection test failed.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshDeliveries() {
    try { setDeliveries(await getCheckoutBoxWebhookDeliveries()); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not load delivery history."); }
  }

  function patch<K extends keyof WebhookSettings>(key: K, value: WebhookSettings[K]) {
    setSettings((current) => current ? { ...current, [key]: value } : current);
    setPreview("");
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Checkout Box · Hotel API</h2>
        <span>Configured separately for each hotel</span>
      </div>
      {!settings ? <p>{notice || "Loading settings..."}</p> : (
        <div className="settings-form">
          <label className="checkbox-row">
            <input type="checkbox" checked={settings.enabled} onChange={(event) => patch("enabled", event.target.checked)} />
            <span>Send a webhook after a new, authorized RFID checkout</span>
          </label>
          <label>
            <span>Hotel endpoint (HTTPS · POST)</span>
            <input type="url" value={settings.url} onChange={(event) => patch("url", event.target.value)}
              placeholder="https://hotel.example/api/checkout" />
          </label>
          <label>
            <span>JSON body template</span>
            <textarea rows={7} spellCheck={false} style={{ fontFamily: "monospace" }}
              value={settings.jsonTemplate} onChange={(event) => patch("jsonTemplate", event.target.value)} />
          </label>
          <p className="muted">
            Placeholders: <code>{"{{key}}"}</code>, <code>{"{{room}}"}</code>, <code>{"{{checkout_at}}"}</code>,
            {" "}<code>{"{{checkout_at_iso}}"}</code>, <code>{"{{rfid_uid}}"}</code>,
            {" "}<code>{"{{device_id}}"}</code>, <code>{"{{checkout_event_id}}"}</code>.
            The date format is DD.MM.YYYY HH:mm.
          </p>
          <label>
            <span>Date/time zone (IANA)</span>
            <input value={settings.timezone} onChange={(event) => patch("timezone", event.target.value)}
              placeholder="Europe/Zurich" />
          </label>
          <div className="settings-split">
            <label>
              <span>Optional API auth header</span>
              <input value={settings.authHeaderName} onChange={(event) => patch("authHeaderName", event.target.value)}
                placeholder="Authorization or X-API-Key" />
            </label>
            <label>
              <span>Header value {settings.authConfigured ? "(saved; leave blank to keep)" : ""}</span>
              <input type="password" autoComplete="off" value={settings.authHeaderValue || ""}
                onChange={(event) => patch("authHeaderValue", event.target.value)}
                placeholder={settings.authConfigured ? "Configured" : "Bearer token / key"} />
            </label>
          </div>
          {settings.authConfigured && (
            <label className="checkbox-row">
              <input type="checkbox" checked={clearAuth} onChange={(event) => setClearAuth(event.target.checked)} />
              <span>Remove saved authorization value</span>
            </label>
          )}
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => void run("preview")}>Preview JSON</button>
            <button type="button" disabled={busy} onClick={() => void testConnection()}>Test DNS + TLS (no checkout)</button>
            <button type="button" disabled={busy} onClick={() => void run("save")}>Save hotel integration</button>
          </div>
          {preview && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview}</pre>}
          {notice && <p role="status">{notice}</p>}
          <div className="section-heading">
            <h3>Latest deliveries</h3>
            <button type="button" disabled={busy} onClick={() => void refreshDeliveries()}>Refresh</button>
          </div>
          {deliveries.length ? (
            <ul>
              {deliveries.slice(0, 10).map((delivery) => (
                <li key={delivery.id}>
                  <strong>{delivery.status}</strong> · {new Date(delivery.createdAt).toLocaleString()}
                  {" "}· {delivery.attempts} attempt(s)
                  {delivery.lastHttpStatus ? ` · HTTP ${delivery.lastHttpStatus}` : ""}
                  {delivery.lastError ? ` · ${delivery.lastError}` : ""}
                </li>
              ))}
            </ul>
          ) : <p>No deliveries yet. Preview does not send real events.</p>}
        </div>
      )}
    </section>
  );
}
