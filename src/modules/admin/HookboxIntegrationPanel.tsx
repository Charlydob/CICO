import { useEffect, useState } from "react";
import {
  hookboxRequest,
  adminHookboxIntegrationRequest,
} from "../../services/backendApi";
type Field = { key: string; source: string; value: string };
type Outbound = {
  enabled: boolean;
  contractConfirmed: boolean;
  endpoint: string;
  method: string;
  timeZone: string;
  dateFormat: string;
  fields: Field[];
};
type Event = {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  httpStatus: number | null;
  lastError: string | null;
  occurredAt: string;
  httpAcceptedAt: string | null;
  history: unknown[];
};
type Config = {
  outbound: Outbound;
  headerNames: string[];
  preview: Record<string, string>;
  history: Event[];
};
const sources = [
  ["room", "Habitación"],
  ["datetime", "Fecha y hora del evento"],
  ["device", "Dispositivo"],
  ["operationId", "Identificador de operación"],
  ["constant", "Valor fijo"],
];
export function HookboxIntegrationPanel({
  deviceId,
  platformAdmin = false,
}: {
  deviceId: string;
  platformAdmin?: boolean;
}) {
  const [config, setConfig] = useState<Config>(),
    [outbound, setOutbound] = useState<Outbound>(),
    [headerName, setHeaderName] = useState("Authorization"),
    [headerValue, setHeaderValue] = useState(""),
    [clearHeaders, setClearHeaders] = useState(false),
    [preview, setPreview] = useState<Record<string, string>>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  function api<T>(path = "", body?: unknown): Promise<T> {
    return platformAdmin
      ? adminHookboxIntegrationRequest<T>(deviceId, path, body)
      : hookboxRequest<T>("devices/" + deviceId + "/integration" + path, body);
  }
  async function load() {
    const c = await api<Config>();
    setConfig(c);
    setOutbound(c.outbound);
    setPreview(c.preview);
  }
  useEffect(() => {
    setOutbound(undefined);
    void load().catch((e) => setMessage(e.message));
  }, [deviceId, platformAdmin]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!outbound)
    return (
      <section className="panel">
        <h2>Integración HTTP</h2>
        <p>{message || "Cargando…"}</p>
      </section>
    );
  const change = (patch: Partial<Outbound>) =>
    setOutbound({ ...outbound, ...patch });
  const field = (i: number, p: Partial<Field>) =>
    change({
      fields: outbound.fields.map((f, n) => (i === n ? { ...f, ...p } : f)),
    });
  const states: Record<string, string> = {
    HELD: "Retenido · integración desactivada",
    PENDING: "Pendiente",
    SENDING: "Enviando",
    RETRY: "Reintento pendiente",
    FAILED: "Error",
    HTTP_ACCEPTED: "Aceptado por HTTP · procesamiento del hotel sin confirmar",
  };
  return (
    <section className="panel" style={{ display: "grid", gap: 14 }}>
      <h2>Integración HTTP</h2>
      <p>
        Envía el evento después de confirmar la activación eléctrica o aceptar
        una devolución. La retirada física de la llave no puede verificarse con
        el hardware actual.
      </p>
      <label>
        Destino HTTPS
        <input
          type="url"
          style={{ width: "100%" }}
          value={outbound.endpoint}
          onChange={(e) => change({ endpoint: e.target.value })}
          placeholder="https://servidor-del-hotel/endpoint.php"
        />
      </label>
      <label>
        Método
        <select
          value={outbound.method}
          onChange={(e) => change({ method: e.target.value })}
        >
          {["POST", "PUT", "PATCH"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        Zona horaria
        <input
          value={outbound.timeZone}
          onChange={(e) => change({ timeZone: e.target.value })}
          placeholder="Europe/Zurich"
        />
      </label>
      <label>
        Formato de fecha
        <select
          value={outbound.dateFormat}
          onChange={(e) => change({ dateFormat: e.target.value })}
        >
          {["DD.MM.YYYY HH:mm", "YYYY-MM-DD HH:mm:ss", "ISO8601"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <h3>Campos JSON</h3>
      {outbound.fields.map((f, i) => (
        <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <label>
            Nombre
            <input
              value={f.key}
              onChange={(e) => field(i, { key: e.target.value })}
            />
          </label>
          <label>
            Dato
            <select
              value={f.source}
              onChange={(e) => field(i, { source: e.target.value })}
            >
              {sources.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {f.source === "constant" && (
            <label>
              Valor fijo
              <input
                value={f.value}
                onChange={(e) => field(i, { value: e.target.value })}
              />
            </label>
          )}
          <button
            disabled={outbound.fields.length <= 1}
            onClick={() =>
              change({ fields: outbound.fields.filter((_, n) => n !== i) })
            }
          >
            Quitar
          </button>
        </div>
      ))}
      <button
        disabled={outbound.fields.length >= 20}
        onClick={() =>
          change({
            fields: [
              ...outbound.fields,
              { key: "", source: "room", value: "" },
            ],
          })
        }
      >
        Añadir campo
      </button>
      <h3>Cabeceras y autenticación</h3>
      <p>
        Guardadas:{" "}
        {config?.headerNames.map((n) => n + ": ••••••••").join(", ") ||
          "Ninguna"}
      </p>
      <label>
        Cabecera
        <input
          value={headerName}
          onChange={(e) => setHeaderName(e.target.value)}
        />
      </label>
      <label>
        Valor secreto
        <input
          type="password"
          autoComplete="new-password"
          value={headerValue}
          onChange={(e) => setHeaderValue(e.target.value)}
          placeholder="Bearer … o clave API"
        />
      </label>
      <small>
        Para acceso básico, usa Authorization con el valor Basic facilitado por
        el hotel.
      </small>
      <label>
        <input
          type="checkbox"
          checked={clearHeaders}
          onChange={(e) => setClearHeaders(e.target.checked)}
        />
        Eliminar las cabeceras guardadas
      </label>
      <label>
        <input
          type="checkbox"
          checked={outbound.contractConfirmed}
          onChange={(e) => change({ contractConfirmed: e.target.checked })}
        />
        Contrato, credenciales y autorización del hotel confirmados
      </label>
      <label>
        <input
          type="checkbox"
          checked={outbound.enabled}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
        Activar envíos reales para eventos nuevos
      </label>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const c = await api<Config>("", {
              outbound,
              clearHeaders,
              headers: headerValue
                ? [{ name: headerName, value: headerValue }]
                : [],
            });
            setConfig(c);
            setOutbound(c.outbound);
            setPreview(c.preview);
            setHeaderValue("");
            setClearHeaders(false);
            setMessage("Configuración guardada");
          })
        }
      >
        Guardar configuración
      </button>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const r = await api<{ preview: Record<string, string> }>(
              "/simulate",
              { outbound },
            );
            setPreview(r.preview);
            setMessage(
              "Prueba simulada: no se ha enviado ninguna petición ni activado hardware",
            );
          })
        }
      >
        Simular JSON sin enviar
      </button>
      <pre>{JSON.stringify(preview, null, 2)}</pre>
      <h3>Historial de envíos</h3>
      <button onClick={() => void run(load)}>Actualizar historial</button>
      <p>
        Un HTTP 2xx indica aceptación HTTP. El procesamiento del hotel queda sin
        confirmar. Reenviar puede repetir una notificación si el hotel no admite
        deduplicación.
      </p>
      {config?.history.map((e) => (
        <article key={e.id}>
          <strong>
            {e.kind === "checkin" ? "Check-in" : "Check-out"} ·{" "}
            {new Date(e.occurredAt).toLocaleString()}
          </strong>
          <p>
            {states[e.state]} · Intentos: {e.attempts} · HTTP:{" "}
            {e.httpStatus || "—"} {e.lastError}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "¿Reenviar este mismo evento? El hotel podría procesarlo de nuevo.",
                )
              )
                void run(async () => {
                  await api("/retry", { eventId: e.id });
                  await load();
                });
            }}
          >
            Reenviar evento
          </button>
          <details>
            <summary>Ver intentos</summary>
            <pre>{JSON.stringify(e.history, null, 2)}</pre>
          </details>
        </article>
      ))}
      <p role="status">{message}</p>
    </section>
  );
}
