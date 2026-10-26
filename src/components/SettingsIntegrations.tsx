import { Copy, Plus, Plug, RefreshCw, Save, Trash2, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import {
  disconnectGoogleSheets,
  disconnectJsonFeed,
  disconnectReservationWebhook,
  disconnectStripe,
  disconnectTelegram,
  generateTelegramPairingCode,
  getIntegrationSettings,
  previewReservationSource,
  saveFrigate,
  saveGoogleSheets,
  saveJsonFeed,
  saveReservationWebhook,
  saveReservationMapping,
  saveStripe,
  testReservationMapping,
  testFrigate,
  testBackendConnection,
  testGoogleSheets,
  testJsonFeed,
  testStripe,
  testTelegramNotification,
  type IntegrationSettings,
  type BackendStatus,
  type JsonAuthSettings,
  type ReservationMapping,
  type ReservationSourcePreview,
} from "../services/backendApi";
import {
  getDefaultBackendUrl,
  resetBackendUrl,
  setBackendUrl,
} from "../services/backendConfigService";

interface SettingsIntegrationsProps {
  settings?: IntegrationSettings;
  backendStatus?: BackendStatus;
  backendUrl: string;
  onBackendUrlChange: (url: string) => Promise<void>;
  onSettingsChange: (settings: IntegrationSettings) => void;
  onNotice: (message: string) => void;
  onRefreshReservations: () => Promise<void>;
}

type StandardReservationMappingKey = Exclude<keyof ReservationMapping, "customFields">;

const mappingLabels: Array<{ key: StandardReservationMappingKey; label: string; group: "Core" | "Optional" }> = [
  { key: "reservationCode", label: "Reservation Number", group: "Core" },
  { key: "name", label: "Full Name", group: "Optional" },
  { key: "email", label: "Email", group: "Optional" },
  { key: "plate", label: "License Plate", group: "Optional" },
  { key: "room", label: "Room", group: "Optional" },
  { key: "parkingValid", label: "Parking Valid", group: "Optional" },
  { key: "arrivalAt", label: "Arrival Date", group: "Optional" },
  { key: "departureAt", label: "Departure Date", group: "Optional" },
  { key: "checkInAt", label: "Check-In Date", group: "Optional" },
  { key: "checkOutAt", label: "Check-Out Date", group: "Optional" },
  { key: "nights", label: "Nights", group: "Optional" },
  { key: "reservationStatus", label: "Reservation Status", group: "Optional" },
  { key: "parkingStartAt", label: "Parking Start", group: "Optional" },
  { key: "parkingEndAt", label: "Parking End", group: "Optional" },
];

function joinBackendPath(backendUrl: string, path: string): string {
  return `${backendUrl.replace(/\/+$/g, "")}${path}`;
}

function isPublicHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function defaultJsonAuth(): JsonAuthSettings {
  return {
    type: "none",
    apiKeyHeader: "x-api-key",
  };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function formatDate(value?: string | null): string {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function statusText(connected?: boolean): string {
  return connected ? "Connected" : "Disconnected";
}

export function SettingsIntegrations({
  settings,
  backendStatus,
  backendUrl,
  onBackendUrlChange,
  onSettingsChange,
  onNotice,
  onRefreshReservations,
}: SettingsIntegrationsProps) {
  const [backendUrlInput, setBackendUrlInput] = useState(backendUrl);
  const [backendTestMessage, setBackendTestMessage] = useState("");
  const [googleUrl, setGoogleUrl] = useState("");
  const [jsonUrl, setJsonUrl] = useState("");
  const [jsonPath, setJsonPath] = useState("");
  const [jsonAuth, setJsonAuth] = useState<JsonAuthSettings>(defaultJsonAuth);
  const [reservationSourceMode, setReservationSourceMode] = useState<"json" | "reservationWebhook">("json");
  const [reservationWebhookHeaderName, setReservationWebhookHeaderName] = useState("x-hotel-automation-secret");
  const [reservationWebhookSecret, setReservationWebhookSecret] = useState("");
  const [sourcePreview, setSourcePreview] = useState<ReservationSourcePreview | undefined>();
  const [mappingPreview, setMappingPreview] = useState<ReservationSourcePreview | undefined>();
  const [stripeSecretKey, setStripeSecretKey] = useState("");
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState("");
  const [telegramPairing, setTelegramPairing] = useState<
    | {
        code: string;
        expiresAt: string;
        tenant: { id: string; name: string; slug: string };
      }
    | undefined
  >();
  const [frigateBaseUrl, setFrigateBaseUrl] = useState("");
  const [frigatePollIntervalMs, setFrigatePollIntervalMs] = useState(5000);
  const [frigateCameras, setFrigateCameras] = useState("");
  const [mapping, setMapping] = useState<ReservationMapping>({
    reservationCode: "reservationCode",
    name: "name",
    email: "email",
    plate: "plate",
    parkingValid: "parkingValid",
    room: "room",
    arrivalAt: "arrivalAt",
    departureAt: "departureAt",
    checkInAt: "checkInAt",
    checkOutAt: "checkOutAt",
    nights: "nights",
    reservationStatus: "reservationStatus",
    parkingStartAt: "parkingStartAt",
    parkingEndAt: "parkingEndAt",
    customFields: [],
  });
  const [busy, setBusy] = useState("");

  useEffect(() => {
    setBackendUrlInput(backendUrl);
  }, [backendUrl]);

  useEffect(() => {
    if (!settings) {
      return;
    }

    setGoogleUrl(settings.reservations.googleSheets.csvUrl || "");
    setJsonUrl(settings.reservations.jsonFeed.url || "");
    setJsonPath(settings.reservations.jsonFeed.jsonPath || "");
    setJsonAuth({
      ...defaultJsonAuth(),
      ...settings.reservations.jsonFeed.auth,
      bearerToken: "",
      apiKeyValue: "",
      basicPassword: "",
    });
    setReservationSourceMode(
      settings.reservations.source === "reservationWebhook" ? "reservationWebhook" : "json",
    );
    setReservationWebhookHeaderName(
      settings.reservations.reservationWebhook.headerName || "x-hotel-automation-secret",
    );
    setSourcePreview(
      settings.reservations.sourceDiagnostics?.recordsFound !== undefined
        ? {
            reservationsFound: settings.reservations.sourceDiagnostics.recordsFound || 0,
            detectedFields: settings.reservations.sourceDiagnostics.detectedFields || [],
            detectedFieldCount:
              settings.reservations.sourceDiagnostics.detectedFieldCount || 0,
            sampleRecord: settings.reservations.sourceDiagnostics.sampleRecord || {},
            sampleNormalized:
              settings.reservations.sourceDiagnostics.sampleNormalized ||
              ({
                reservationCode: "",
                name: "",
                email: "",
                plate: "",
                parkingValid: false,
                room: "",
              }),
            mappedFields: [],
            missingOptionalFields: [],
            ignoredFields: [],
            errors: settings.reservations.sourceDiagnostics.lastError
              ? [settings.reservations.sourceDiagnostics.lastError]
              : [],
          }
        : undefined,
    );
    setFrigateBaseUrl(backendStatus?.frigateBaseUrl || settings.frigate.baseUrl || "");
    setFrigatePollIntervalMs(
      backendStatus?.frigatePollIntervalMs || settings.frigate.pollIntervalMs || 5000,
    );
    setFrigateCameras((settings.frigate.cameras || []).join("\n"));
    setMapping(settings.reservations.mapping);
  }, [settings, backendStatus]);

  async function run(label: string, action: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      const result = await action();
      if (result && typeof result === "object" && "reservations" in result) {
        onSettingsChange(result as IntegrationSettings);
      }
      onNotice(success);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Settings request failed.");
    } finally {
      setBusy("");
    }
  }

  async function reloadSettings() {
    const next = await getIntegrationSettings();
    onSettingsChange(next);
    return next;
  }

  async function handleTestBackendUrl() {
    setBusy("backend-test");
    setBackendTestMessage("");
    try {
      const status = await testBackendConnection(backendUrlInput);
      setBackendTestMessage(
        `Connected · Frigate ${status.frigateConnected ? "Connected" : "Disconnected"} · ${status.reservationsLoaded} reservations`,
      );
      onNotice("Backend connection works.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed.";
      setBackendTestMessage(`Connection failed · ${message}`);
      onNotice(`Connection failed: ${message}`);
    } finally {
      setBusy("");
    }
  }

  async function handleSaveBackendUrl() {
    setBusy("backend-save");
    try {
      const nextUrl = setBackendUrl(backendUrlInput);
      setBackendTestMessage("Saved.");
      await onBackendUrlChange(nextUrl);
      onNotice("Backend URL saved.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid Backend URL.";
      setBackendTestMessage(`Connection failed · ${message}`);
      onNotice(message);
    } finally {
      setBusy("");
    }
  }

  async function handleResetBackendUrl() {
    setBusy("backend-reset");
    try {
      const nextUrl = resetBackendUrl();
      setBackendUrlInput(nextUrl);
      setBackendTestMessage("Reset to default.");
      await onBackendUrlChange(nextUrl);
      onNotice("Backend URL reset to default.");
    } finally {
      setBusy("");
    }
  }

  async function copyToClipboard(value: string) {
    await navigator.clipboard.writeText(value);
    onNotice("Copied to clipboard.");
  }

  async function handlePreviewSource() {
    setBusy("reservation-preview");
    try {
      const preview = await previewReservationSource(reservationSourceMode);
      setSourcePreview(preview);
      onNotice("Reservation source preview loaded.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not preview reservation source.");
    } finally {
      setBusy("");
    }
  }

  async function handleTestMapping() {
    setBusy("mapping-test");
    try {
      const preview = await testReservationMapping(mapping);
      setMappingPreview(preview);
      onNotice("Reservation mapping tested.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not test reservation mapping.");
    } finally {
      setBusy("");
    }
  }

  function updateJsonAuth(patch: Partial<JsonAuthSettings>) {
    setJsonAuth((current) => ({ ...current, ...patch }));
  }

  function addCustomField() {
    setMapping((current) => ({
      ...current,
      customFields: [
        ...(current.customFields || []),
        { internalName: "", externalField: "" },
      ],
    }));
  }

  function updateCustomField(
    index: number,
    patch: Partial<{ internalName: string; externalField: string }>,
  ) {
    setMapping((current) => ({
      ...current,
      customFields: (current.customFields || []).map((field, fieldIndex) =>
        fieldIndex === index ? { ...field, ...patch } : field,
      ),
    }));
  }

  function removeCustomField(index: number) {
    setMapping((current) => ({
      ...current,
      customFields: (current.customFields || []).filter((_, fieldIndex) => fieldIndex !== index),
    }));
  }

  const stripeWebhookUrl = joinBackendPath(backendUrl, "/api/stripe/webhook");
  const reservationWebhookUrl = joinBackendPath(backendUrl, "/api/reservations/webhook");
  const publicHttpsWarning = isPublicHttpsUrl(backendUrl)
    ? ""
    : "A public HTTPS backend URL is required to receive Stripe webhooks.";
  const detectedFields =
    sourcePreview?.detectedFields ||
    settings?.reservations.sourceDiagnostics?.detectedFields ||
    [];
  const telegramSettings = settings?.notifications?.telegram;
  const telegramConnected = Boolean(telegramSettings?.enabled && telegramSettings.chatId);
  const telegramConnectCommand = telegramPairing ? `/connect ${telegramPairing.code}` : "";
  const telegramDiagnostics = telegramSettings?.diagnostics || {};

  return (
    <section className="settings-page">
      <div className="settings-title">
        <h2>Settings</h2>
        <span>Integrations</span>
      </div>

      <div className="integration-grid">
        <section className="panel integration-card">
          <div className="section-heading">
            <h2>Backend</h2>
            <span>{backendStatus?.backendOnline ? "Online" : "Unreachable"}</span>
          </div>
          <div className="settings-form">
            <div className="meta-list">
              <span>Current Backend URL</span>
              <strong>{backendUrl}</strong>
              <span>Default Backend URL</span>
              <strong>{getDefaultBackendUrl()}</strong>
              <span>Connection Status</span>
              <strong className={backendStatus?.backendOnline ? "" : "error-text"}>
                {backendStatus?.backendOnline ? "Connected" : "Unreachable"}
              </strong>
              <span>Test Result</span>
              <strong
                className={backendTestMessage.startsWith("Connection failed") ? "error-text" : ""}
              >
                {backendTestMessage || "-"}
              </strong>
            </div>
            <label>
              <span>Backend URL</span>
              <input
                value={backendUrlInput}
                onChange={(event) => setBackendUrlInput(event.target.value)}
                placeholder="https://example.trycloudflare.com"
              />
            </label>
            <div className="button-row">
              <button type="button" onClick={handleTestBackendUrl} disabled={busy !== ""}>
                <Wifi size={15} />
                Test Connection
              </button>
              <button type="button" onClick={handleSaveBackendUrl} disabled={busy !== ""}>
                <Save size={15} />
                Save
              </button>
              <button type="button" onClick={handleResetBackendUrl} disabled={busy !== ""}>
                <RefreshCw size={15} />
                Reset to Default
              </button>
            </div>
          </div>
        </section>

        <section className="panel integration-card">
          <div className="section-heading">
            <h2>Google Sheets</h2>
            <span>{statusText(settings?.reservations.googleSheets.connected)}</span>
          </div>
          <div className="settings-form">
            <label>
              <span>Google Sheets CSV URL</span>
              <input value={googleUrl} onChange={(event) => setGoogleUrl(event.target.value)} />
            </label>
            <div className="meta-list">
              <span>Reservations Loaded</span>
              <strong>{settings?.reservationDiagnostics?.reservationsLoaded ?? 0}</strong>
              <span>Last Refresh</span>
              <strong>{formatDate(settings?.reservationDiagnostics?.lastReservationRefreshAt)}</strong>
              <span>Last Error</span>
              <strong className={settings?.reservationDiagnostics?.reservationLoadError ? "error-text" : ""}>
                {settings?.reservationDiagnostics?.reservationLoadError || "No errors"}
              </strong>
            </div>
            <div className="button-row">
              <button type="button" onClick={() => run("google-test", () => testGoogleSheets(googleUrl), "Google Sheets connection works.")} disabled={busy !== ""}>
                <Wifi size={15} />
                Test Connection
              </button>
              <button type="button" onClick={() => run("google-save", async () => { const next = await saveGoogleSheets(googleUrl); await reloadSettings(); return next; }, "Google Sheets saved.")} disabled={busy !== ""}>
                <Save size={15} />
                Save
              </button>
              <button type="button" onClick={() => run("google-refresh", onRefreshReservations, "Reservations refreshed.")} disabled={busy !== ""}>
                <RefreshCw size={15} />
                Refresh Now
              </button>
              <button type="button" onClick={() => run("google-disconnect", async () => { await disconnectGoogleSheets(); return reloadSettings(); }, "Google Sheets disconnected.")} disabled={busy !== ""}>
                <Trash2 size={15} />
                Disconnect
              </button>
            </div>
          </div>
        </section>

        <section className="panel integration-card">
          <div className="section-heading">
            <h2>Reservation Source</h2>
            <span>
              {reservationSourceMode === "reservationWebhook"
                ? statusText(settings?.reservations.reservationWebhook.connected)
                : statusText(settings?.reservations.jsonFeed.connected)}
            </span>
          </div>
          <div className="settings-form">
            <div className="segmented-row">
              <label>
                <input
                  type="radio"
                  checked={reservationSourceMode === "json"}
                  onChange={() => setReservationSourceMode("json")}
                />
                <span>JSON URL / API</span>
              </label>
              <label>
                <input
                  type="radio"
                  checked={reservationSourceMode === "reservationWebhook"}
                  onChange={() => setReservationSourceMode("reservationWebhook")}
                />
                <span>Webhook</span>
              </label>
            </div>

            {reservationSourceMode === "json" ? (
              <>
                <label>
                  <span>JSON URL / API Endpoint</span>
                  <input value={jsonUrl} onChange={(event) => setJsonUrl(event.target.value)} />
                </label>
                <label>
                  <span>Reservations JSON Path</span>
                  <input
                    value={jsonPath}
                    onChange={(event) => setJsonPath(event.target.value)}
                    placeholder="reservations"
                  />
                </label>
                <label>
                  <span>Authentication</span>
                  <select
                    value={jsonAuth.type}
                    onChange={(event) =>
                      updateJsonAuth({ type: event.target.value as JsonAuthSettings["type"] })
                    }
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="apiKey">API Key</option>
                    <option value="basic">Basic Auth</option>
                  </select>
                </label>
                {jsonAuth.type === "bearer" && (
                  <label>
                    <span>Bearer Token</span>
                    <input
                      type="password"
                      placeholder={jsonAuth.configured ? "Configured" : ""}
                      value={jsonAuth.bearerToken || ""}
                      onChange={(event) => updateJsonAuth({ bearerToken: event.target.value })}
                    />
                  </label>
                )}
                {jsonAuth.type === "apiKey" && (
                  <div className="settings-split">
                    <label>
                      <span>API Key Header</span>
                      <input
                        value={jsonAuth.apiKeyHeader || "x-api-key"}
                        onChange={(event) => updateJsonAuth({ apiKeyHeader: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>API Key</span>
                      <input
                        type="password"
                        placeholder={jsonAuth.configured ? "Configured" : ""}
                        value={jsonAuth.apiKeyValue || ""}
                        onChange={(event) => updateJsonAuth({ apiKeyValue: event.target.value })}
                      />
                    </label>
                  </div>
                )}
                {jsonAuth.type === "basic" && (
                  <div className="settings-split">
                    <label>
                      <span>Username</span>
                      <input
                        value={jsonAuth.basicUsername || ""}
                        onChange={(event) =>
                          updateJsonAuth({ basicUsername: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Password</span>
                      <input
                        type="password"
                        placeholder={jsonAuth.configured ? "Configured" : ""}
                        value={jsonAuth.basicPassword || ""}
                        onChange={(event) =>
                          updateJsonAuth({ basicPassword: event.target.value })
                        }
                      />
                    </label>
                  </div>
                )}
              </>
            ) : (
              <>
                <label>
                  <span>Reservation Webhook URL</span>
                  <div className="copy-field">
                    <input readOnly value={reservationWebhookUrl} />
                    <button
                      type="button"
                      onClick={() => copyToClipboard(reservationWebhookUrl)}
                      disabled={busy !== ""}
                    >
                      <Copy size={15} />
                      Copy
                    </button>
                  </div>
                </label>
                <label>
                  <span>Webhook Authentication Header</span>
                  <input
                    value={reservationWebhookHeaderName}
                    onChange={(event) => setReservationWebhookHeaderName(event.target.value)}
                  />
                </label>
                <label>
                  <span>Reservations JSON Path</span>
                  <input
                    value={jsonPath}
                    onChange={(event) => setJsonPath(event.target.value)}
                    placeholder="reservations"
                  />
                </label>
                <label>
                  <span>Webhook Shared Secret</span>
                  <input
                    type="password"
                    placeholder={
                      settings?.reservations.reservationWebhook.secretConfigured
                        ? "Configured"
                        : ""
                    }
                    value={reservationWebhookSecret}
                    onChange={(event) => setReservationWebhookSecret(event.target.value)}
                  />
                </label>
              </>
            )}

            <div className="meta-list">
              <span>Connection Status</span>
              <strong>
                {reservationSourceMode === "reservationWebhook"
                  ? statusText(settings?.reservations.reservationWebhook.connected)
                  : statusText(settings?.reservations.jsonFeed.connected)}
              </strong>
              <span>Records Found</span>
              <strong>{sourcePreview?.reservationsFound ?? settings?.reservationDiagnostics?.reservationsLoaded ?? 0}</strong>
              <span>Last Refresh</span>
              <strong>{formatDate(settings?.reservationDiagnostics?.lastReservationRefreshAt)}</strong>
              <span>Last Payload Received</span>
              <strong>{formatDate(settings?.reservations.sourceDiagnostics?.lastReceivedAt)}</strong>
              <span>Last Error</span>
              <strong className={settings?.reservationDiagnostics?.reservationLoadError ? "error-text" : ""}>
                {settings?.reservationDiagnostics?.reservationLoadError ||
                  settings?.reservations.sourceDiagnostics?.lastError ||
                  "No errors"}
              </strong>
            </div>

            {sourcePreview && (
              <div className="source-preview">
                <strong>
                  Detected {sourcePreview.reservationsFound} reservations ·{" "}
                  {sourcePreview.detectedFieldCount} fields
                </strong>
                <div className="field-chip-list">
                  {sourcePreview.detectedFields.slice(0, 24).map((field) => (
                    <span key={field}>{field}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="button-row">
              {reservationSourceMode === "json" ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        "json-test",
                        async () => {
                          const result = await testJsonFeed(jsonUrl, jsonPath, jsonAuth);
                          setSourcePreview(result.preview);
                          return result;
                        },
                        "Reservation source connection works.",
                      )
                    }
                    disabled={busy !== ""}
                  >
                    <Wifi size={15} />
                    Test Connection
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        "json-save",
                        async () => {
                          const next = await saveJsonFeed(jsonUrl, jsonPath, jsonAuth);
                          await reloadSettings();
                          return next;
                        },
                        "Reservation source saved.",
                      )
                    }
                    disabled={busy !== ""}
                  >
                    <Save size={15} />
                    Save
                  </button>
                  <button type="button" onClick={handlePreviewSource} disabled={busy !== ""}>
                    <Plug size={15} />
                    Preview Source
                  </button>
                  <button type="button" onClick={() => run("json-refresh", onRefreshReservations, "Reservations refreshed.")} disabled={busy !== ""}>
                    <RefreshCw size={15} />
                    Refresh Now
                  </button>
                  <button type="button" onClick={() => run("json-disconnect", async () => { await disconnectJsonFeed(); return reloadSettings(); }, "Reservation source disconnected.")} disabled={busy !== ""}>
                    <Trash2 size={15} />
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        "webhook-save",
                        async () => {
                          await saveReservationWebhook(
                            reservationWebhookHeaderName,
                            reservationWebhookSecret,
                            jsonPath,
                          );
                          setReservationWebhookSecret("");
                          return reloadSettings();
                        },
                        "Reservation webhook saved.",
                      )
                    }
                    disabled={busy !== ""}
                  >
                    <Save size={15} />
                    Save
                  </button>
                  <button type="button" onClick={handlePreviewSource} disabled={busy !== ""}>
                    <Plug size={15} />
                    Preview Source
                  </button>
                  <button type="button" onClick={() => run("webhook-refresh", onRefreshReservations, "Reservations refreshed.")} disabled={busy !== ""}>
                    <RefreshCw size={15} />
                    Refresh Now
                  </button>
                  <button type="button" onClick={() => run("webhook-disconnect", async () => { await disconnectReservationWebhook(); return reloadSettings(); }, "Reservation webhook disconnected.")} disabled={busy !== ""}>
                    <Trash2 size={15} />
                    Disconnect
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        <section className="panel integration-card">
          <div className="section-heading">
            <h2>Reservation Field Mapping</h2>
            <Plug size={17} />
          </div>
          <div className="settings-form">
            <datalist id="detected-source-fields">
              {detectedFields.map((field) => (
                <option key={field} value={field} />
              ))}
            </datalist>
            {detectedFields.length > 0 && (
              <div className="source-preview">
                <strong>Detected Source Fields</strong>
                <div className="field-chip-list">
                  {detectedFields.slice(0, 32).map((field) => (
                    <span key={field}>{field}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="mapping-form">
              {mappingLabels.map((field) => (
                <label key={field.key}>
                  <span>
                    {field.label}
                    <small>{field.group}</small>
                  </span>
                  <input
                    list="detected-source-fields"
                    value={mapping[field.key]}
                    onChange={(event) =>
                      setMapping((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            <div className="custom-field-list">
              {(mapping.customFields || []).map((field, index) => (
                <div className="custom-field-row" key={`${field.internalName}-${index}`}>
                  <label>
                    <span>Internal name</span>
                    <input
                      value={field.internalName}
                      onChange={(event) =>
                        updateCustomField(index, { internalName: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>External field</span>
                    <input
                      list="detected-source-fields"
                      value={field.externalField}
                      onChange={(event) =>
                        updateCustomField(index, { externalField: event.target.value })
                      }
                    />
                  </label>
                  <button type="button" onClick={() => removeCustomField(index)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            {mappingPreview && (
              <div className="mapping-preview">
                <strong>Test Mapping</strong>
                <div className="mapping-preview-grid">
                  <div>
                    <span>External</span>
                    <pre>{formatJson(mappingPreview.sampleRecord)}</pre>
                  </div>
                  <div>
                    <span>Normalized Hotel Automation Reservation</span>
                    <pre>{formatJson(mappingPreview.sampleNormalized)}</pre>
                  </div>
                </div>
                <div className="meta-list">
                  <span>Mapped Fields</span>
                  <strong>{mappingPreview.mappedFields.join(", ") || "-"}</strong>
                  <span>Optional Fields Missing</span>
                  <strong>{mappingPreview.missingOptionalFields.join(", ") || "-"}</strong>
                  <span>Ignored Fields</span>
                  <strong>{mappingPreview.ignoredFields.slice(0, 12).join(", ") || "-"}</strong>
                  <span>Errors</span>
                  <strong className={mappingPreview.errors.length > 0 ? "error-text" : ""}>
                    {mappingPreview.errors.join(", ") || "No errors"}
                  </strong>
                </div>
              </div>
            )}
            <div className="button-row">
              <button type="button" onClick={addCustomField} disabled={busy !== ""}>
                <Plus size={15} />
                Add Custom Field
              </button>
              <button type="button" onClick={handleTestMapping} disabled={busy !== ""}>
                <Plug size={15} />
                Test Mapping
              </button>
              <button type="button" onClick={() => run("mapping-save", async () => { const next = await saveReservationMapping(mapping); await reloadSettings(); return next; }, "Reservation field mapping saved.")} disabled={busy !== ""}>
                <Save size={15} />
                Save Mapping
              </button>
            </div>
          </div>
        </section>

        <section className="panel integration-card">
          <div className="section-heading">
            <h2>Stripe</h2>
            <span>{settings?.stripe.connected ? "Connected" : "Not configured"}</span>
          </div>
          <div className="settings-form">
            <label>
              <span>Stripe Secret Key</span>
              <input
                type="password"
                value={stripeSecretKey}
                placeholder={settings?.stripe.secretKeyMasked || ""}
                onChange={(event) => setStripeSecretKey(event.target.value)}
              />
            </label>
            <label>
              <span>Stripe Webhook Secret</span>
              <input
                type="password"
                value={stripeWebhookSecret}
                placeholder={settings?.stripe.webhookSecretConfigured ? "Configured" : ""}
                onChange={(event) => setStripeWebhookSecret(event.target.value)}
              />
            </label>
            <label>
              <span>Stripe Webhook URL</span>
              <div className="copy-field">
                <input readOnly value={stripeWebhookUrl} />
                <button
                  type="button"
                  onClick={() => copyToClipboard(stripeWebhookUrl)}
                  disabled={busy !== ""}
                >
                  <Copy size={15} />
                  Copy
                </button>
              </div>
            </label>
            {publicHttpsWarning && <p className="settings-warning">{publicHttpsWarning}</p>}
            <div className="meta-list">
              <span>Secret Key</span>
              <strong>{settings?.stripe.secretKeyMasked || "-"}</strong>
              <span>Webhook Secret</span>
              <strong>{settings?.stripe.webhookSecretConfigured ? "Configured" : "-"}</strong>
            </div>
            <div className="button-row">
              <button type="button" onClick={() => run("stripe-test", () => testStripe(stripeSecretKey), "Stripe connection works.")} disabled={busy !== ""}>
                <Wifi size={15} />
                Test Connection
              </button>
              <button type="button" onClick={() => run("stripe-save", async () => { await saveStripe(stripeSecretKey, stripeWebhookSecret); setStripeSecretKey(""); setStripeWebhookSecret(""); return reloadSettings(); }, "Stripe settings saved.")} disabled={busy !== ""}>
                <Save size={15} />
                Save
              </button>
              <button type="button" onClick={() => run("stripe-disconnect", async () => { await disconnectStripe(); return reloadSettings(); }, "Stripe disconnected.")} disabled={busy !== ""}>
                <Trash2 size={15} />
                Disconnect
              </button>
            </div>
          </div>
        </section>

        <section className="panel integration-card">
          <div className="section-heading">
            <h2>Frigate</h2>
            <span>{statusText(backendStatus?.frigateConnected)}</span>
          </div>
          <div className="settings-form">
            <div className="meta-list">
              <span>Effective Frigate URL</span>
              <strong>{backendStatus?.frigateBaseUrl || settings?.frigate.baseUrl || "-"}</strong>
              <span>Connection status</span>
              <strong>{statusText(backendStatus?.frigateConnected)}</strong>
            </div>
            <label>
              <span>Frigate Base URL</span>
              <input value={frigateBaseUrl} onChange={(event) => setFrigateBaseUrl(event.target.value)} />
            </label>
            <label>
              <span>Poll interval</span>
              <input
                type="number"
                min={1000}
                step={500}
                value={frigatePollIntervalMs}
                onChange={(event) => setFrigatePollIntervalMs(Number(event.target.value))}
              />
            </label>
            <label>
              <span>Cameras</span>
              <textarea
                value={frigateCameras}
                onChange={(event) => setFrigateCameras(event.target.value)}
                placeholder="entrance&#10;parking-east"
                rows={4}
              />
            </label>
            <div className="meta-list">
              <span>Last Poll</span>
              <strong>{formatDate(backendStatus?.lastPollAt || settings?.frigate.lastPollAt)}</strong>
              <span>Last Event Processed</span>
              <strong>{formatDate(backendStatus?.lastEventProcessed)}</strong>
              <span>Detected Version</span>
              <strong>{backendStatus?.frigateVersion || settings?.frigate.version || "-"}</strong>
            </div>
            <div className="button-row">
              <button type="button" onClick={() => run("frigate-test", () => testFrigate(frigateBaseUrl), "Frigate connection works.")} disabled={busy !== ""}>
                <Wifi size={15} />
                Test Connection
              </button>
              <button type="button" onClick={() => run("frigate-save", async () => { await saveFrigate(frigateBaseUrl, frigatePollIntervalMs, frigateCameras.split(/\r?\n/).map((camera) => camera.trim()).filter(Boolean)); return reloadSettings(); }, "Frigate settings saved.")} disabled={busy !== ""}>
                <Save size={15} />
                Save
              </button>
            </div>
          </div>
        </section>

        <section className="panel integration-card">
          <div className="section-heading">
            <h2>Conectar Telegram</h2>
            <span>{telegramConnected ? "Telegram conectado" : "Desconectado"}</span>
          </div>
          <div className="settings-form">
            <div className="meta-list">
              <span>Estado</span>
              <strong>{telegramConnected ? "✅ Telegram conectado" : "No conectado"}</strong>
              <span>Grupo</span>
              <strong>{telegramSettings?.chatTitle || telegramSettings?.chatId || "-"}</strong>
              <span>Conectado</span>
              <strong>{formatDate(telegramSettings?.connectedAt)}</strong>
              <span>Last attempt</span>
              <strong>{formatDate(telegramDiagnostics.lastAttemptAt)}</strong>
              <span>Last success</span>
              <strong>{formatDate(telegramDiagnostics.lastSuccessAt)}</strong>
              <span>Last error</span>
              <strong className={telegramDiagnostics.lastError ? "error-text" : ""}>
                {telegramDiagnostics.lastError || "No errors"}
              </strong>
              <span>HTTP status</span>
              <strong>{telegramDiagnostics.httpStatus || "-"}</strong>
              <span>Checkout event</span>
              <strong>{telegramDiagnostics.checkoutEventId || "-"}</strong>
              <span>Room</span>
              <strong>{telegramDiagnostics.room || "-"}</strong>
              <span>Source</span>
              <strong>{telegramDiagnostics.source || "-"}</strong>
            </div>

            {telegramPairing && (
              <div className="source-preview">
                <strong>{telegramPairing.code}</strong>
                <p>
                  Añade el bot de HotelApp al grupo de Telegram que debe recibir los avisos y
                  escribe: {telegramConnectCommand}
                </p>
                <div className="meta-list">
                  <span>Hotel</span>
                  <strong>{telegramPairing.tenant.name}</strong>
                  <span>Caduca</span>
                  <strong>{formatDate(telegramPairing.expiresAt)}</strong>
                </div>
              </div>
            )}

            <div className="button-row">
              <button
                type="button"
                onClick={() =>
                  run(
                    "telegram-pairing",
                    async () => {
                      const pairing = await generateTelegramPairingCode();
                      setTelegramPairing(pairing);
                      return pairing;
                    },
                    "Telegram pairing code generated.",
                  )
                }
                disabled={busy !== ""}
              >
                <Plus size={15} />
                Generar código
              </button>
              {telegramPairing && (
                <button
                  type="button"
                  onClick={() => copyToClipboard(telegramConnectCommand)}
                  disabled={busy !== ""}
                >
                  <Copy size={15} />
                  Copiar comando
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  run(
                    "telegram-test",
                    async () => {
                      const result = await testTelegramNotification();
                      await reloadSettings();

                      if (!result.success) {
                        throw new Error(result.error || "Telegram test notification failed.");
                      }

                      return result;
                    },
                    "Telegram test notification sent.",
                  )
                }
                disabled={busy !== "" || !telegramConnected}
              >
                <Wifi size={15} />
                Send test notification
              </button>
              <button
                type="button"
                onClick={() =>
                  run(
                    "telegram-disconnect",
                    async () => {
                      setTelegramPairing(undefined);
                      return disconnectTelegram();
                    },
                    "Telegram disconnected.",
                  )
                }
                disabled={busy !== "" || !telegramConnected}
              >
                <Trash2 size={15} />
                Desconectar Telegram
              </button>
            </div>
          </div>
        </section>
      </div>

      <section className="panel">
        <h2>Pantallas HOOKBOX</h2>
        <p>Personaliza la pantalla de cada dispositivo asignado a este hotel.</p>
        <a href={(window.location.pathname.match(/^\/t\/[^/]+/)?.[0]||'')+'/devices'}>Mis dispositivos HOOKBOX</a>
      </section>
    </section>
  );
}
