import { useEffect, useState } from "react";
import { hookboxRequest } from "../../services/backendApi";
import { getBackendUrl } from "../../services/backendConfigService";

type Source = "room" | "checkin_at" | "stay_unit_id" | "request_id" | "last_name" | "reservation_code" | "constant";
type Field = { key: string; source: Source; value: string };
type Outbound = { enabled: boolean; endpoint: string; method: "POST"; dateFormat: string; fields: Field[] };
type Contract = {
  outbound: Outbound;
  webhookUrlPath: string;
  webhookEnabled: boolean;
  preview: Record<string, string>;
  webhookSecret?: string;
};
const sources: { value: Source; label: string; sample: string }[] = [
  { value: "room", label: "Número de habitación", sample: "109" },
  { value: "checkin_at", label: "Fecha y hora de check-in", sample: "28.10.2026 14:28" },
  { value: "stay_unit_id", label: "ID de estancia del hotel", sample: "ABC123" },
  { value: "request_id", label: "ID de solicitud CICO", sample: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  { value: "last_name", label: "Apellido del huésped", sample: "García" },
  { value: "reservation_code", label: "Código de reserva", sample: "R12345" },
  { value: "constant", label: "Texto fijo personalizado", sample: "" },
];

export function HookboxIntegrationPanel({ deviceId }: { deviceId: string }) {
  const [config, setConfig] = useState<Contract | null>(null);
  const [outbound, setOutbound] = useState<Outbound | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newSecret, setNewSecret] = useState("");
  useEffect(() => {
    let mounted = true;
    setConfig(null); setOutbound(null); setError(""); setNewSecret("");
    void hookboxRequest<Contract>("devices/" + deviceId + "/integration")
      .then((result) => { if (mounted) { setConfig(result); setOutbound(result.outbound); } })
      .catch((err: Error) => { if (mounted) setError(err.message); });
    return () => { mounted = false; };
  }, [deviceId]);

  function changeField(index: number, patch: Partial<Field>) {
    setOutbound((old) => old ? {
      ...old, fields: old.fields.map((f, i) => i === index ? { ...f, ...patch } : f),
    } : old);
  }
  async function perform(action: () => Promise<Contract>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await action();
      setConfig(result); setOutbound(result.outbound); setNewSecret(result.webhookSecret || "");
      setNotice(success);
    } catch (e) { setError(e instanceof Error ? e.message : "Error de configuración"); }
    finally { setBusy(false); }
  }
  if (!outbound) return <section className="panel"><h3>Integración con el hotel</h3><p>{error || "Cargando configuración…"}</p></section>;
  const preview = Object.fromEntries(outbound.fields.filter((f) => f.key.trim()).map((f) => [
    f.key, f.source === "constant" ? f.value :
      f.source === "checkin_at" && outbound.dateFormat === "YYYY-MM-DD HH:mm:ss"
        ? "2026-10-28 14:28:00" :
      f.source === "checkin_at" && outbound.dateFormat === "ISO8601"
        ? "2026-10-28T13:28:00.000Z" :
      sources.find((s) => s.value === f.source)?.sample || "",
  ]));
  const webhookUrl = getBackendUrl().replace(/\/$/, "") + (config?.webhookUrlPath || "");
  return <section className="panel compact-device-section" style={{ display: "grid", gap: 18 }}>
    <header><h3>Conexión con el sistema del hotel</h3>
      <p>Configura aquí qué datos envía CICO al hotel y dónde recibe las autorizaciones. No hace falta modificar el firmware de los Adafruit.</p>
    </header>

    <div style={{ display: "grid", gap: 8 }}>
      <h4>1. CICO envía datos al hotel (POST)</h4>
      <label>Dirección que te facilitará Urs (endpoint HTTPS)
        <input style={{ width: "100%" }} type="url" placeholder="https://checkin.gasthaus-steinbock.ch/checkinguest.php"
          value={outbound.endpoint} onChange={(e) => setOutbound({ ...outbound, endpoint: e.target.value })}/>
      </label>
      <p style={{ margin: 0 }}>Método: <strong>POST</strong> · Contenido: <code>application/json</code></p>
      <label>Formato de fecha
        <select value={outbound.dateFormat} onChange={(e) => setOutbound({ ...outbound, dateFormat: e.target.value })}>
          <option value="DD.MM.YYYY HH:mm">28.10.2026 14:28</option>
          <option value="YYYY-MM-DD HH:mm:ss">2026-10-28 14:28:00</option>
          <option value="ISO8601">ISO 8601</option>
        </select>
      </label>
      <h4>Campos del JSON (puedes añadir, quitar o cambiar los nombres)</h4>
      <p>El nombre de la izquierda debe coincidir exactamente con lo que pida Urs. A la derecha eliges qué dato pone CICO.</p>
      {outbound.fields.map((field, index) => <div key={index} style={{ display: "grid", gridTemplateColumns: "minmax(105px,1fr) minmax(140px,1.4fr) auto", alignItems: "end", gap: 8 }}>
        <label>Nombre del campo
          <input aria-label={"Campo JSON " + (index + 1)} value={field.key} onChange={(e) => changeField(index, { key: e.target.value })}/>
        </label>
        <label>Dato que se envía
          <select value={field.source} onChange={(e) => changeField(index, { source: e.target.value as Source })}>
            {sources.map((source) => <option value={source.value} key={source.value}>{source.label}</option>)}
          </select>
        </label>
        <button type="button" title="Eliminar este campo" disabled={outbound.fields.length <= 1} onClick={() => setOutbound({ ...outbound, fields: outbound.fields.filter((_, i) => i !== index) })}>Quitar</button>
        {field.source === "constant" && <label style={{ gridColumn: "1 / -1" }}>Texto fijo
          <input value={field.value} onChange={(e) => changeField(index, { value: e.target.value })}/>
        </label>}
      </div>)}
      <button type="button" disabled={outbound.fields.length >= 20} onClick={() => setOutbound({ ...outbound, fields: [...outbound.fields, { key: "", source: "room", value: "" }] })}>+ Añadir otro campo</button>
      <div><strong>Vista previa del JSON (datos ficticios)</strong>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(preview, null, 2)}</pre>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={outbound.enabled} onChange={(e) => setOutbound({ ...outbound, enabled: e.target.checked })}/>
        Habilitar configuración de salida
      </label>
      <small>Guardar no envía ninguna petición al hotel. El envío real sólo debe activarse al integrar su contrato definitivo.</small>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void perform(
        () => hookboxRequest<Contract>("devices/" + deviceId + "/integration", { outbound }),
        "Configuración guardada para este dispositivo. No se ha enviado ningún POST.",
      )}>Guardar configuración</button>
    </div>

    <div style={{ display: "grid", gap: 8 }}>
      <h4>2. El hotel envía un webhook a CICO</h4>
      <p>Facilita esta URL a Urs cuando esté desplegada y confirmada:</p>
      <code style={{ overflowWrap: "anywhere" }}>{webhookUrl}</code>
      <button type="button" onClick={() => void navigator.clipboard.writeText(webhookUrl)}>Copiar URL</button>
      <p>Cabecera de seguridad: <code>X-Cico-Webhook-Secret</code>. {config?.webhookEnabled ? "Secreto configurado." : "Aún no hay secreto configurado."}</p>
      <button type="button" disabled={busy} onClick={() => {
        if (config?.webhookEnabled && !window.confirm("¿Generar un secreto nuevo? El anterior dejará de funcionar.")) return;
        void perform(() => hookboxRequest<Contract>("devices/" + deviceId + "/integration/rotate-secret", {}), "Secreto generado. Cópialo ahora: sólo se muestra una vez.");
      }}>{config?.webhookEnabled ? "Renovar secreto" : "Generar secreto"}</button>
      {newSecret && <div><strong>Secreto (guardar y entregar por un canal privado)</strong>
        <code style={{ display: "block", overflowWrap: "anywhere" }}>{newSecret}</code>
        <button type="button" onClick={() => void navigator.clipboard.writeText(newSecret)}>Copiar secreto</button>
      </div>}
      <p>JSON de webhook inicialmente previsto:</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({
        action: "release",
        request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        stay_unit_id: "ABC123",
        room: "109",
      }, null, 2)}</pre>
      <small>El webhook sólo puede autorizar una solicitud CICO que siga activa. No dispara el solenoide directamente. La estructura final está pendiente de Urs.</small>
    </div>
    {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
