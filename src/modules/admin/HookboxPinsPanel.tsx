import { useEffect, useState } from "react";
import {
  hookboxRequest,
  adminHookboxPinsRequest,
} from "../../services/backendApi";
type Hook = {
  hook: number;
  room: string;
  enabled: boolean;
  state: string;
  hasPin: boolean;
};
type Data = {
  hooks: Hook[];
  settings: { minLength: number; maxLength: number };
};
export function HookboxPinsPanel({
  deviceId,
  platformAdmin = false,
}: {
  deviceId: string;
  platformAdmin?: boolean;
}) {
  const [data, setData] = useState<Data>(),
    [form, setForm] = useState({ hook: 1, room: "", pin: "", enabled: true }),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const api = <T,>(suffix = "", body?: unknown) =>
    platformAdmin
      ? adminHookboxPinsRequest<T>(deviceId, suffix, body)
      : hookboxRequest<T>("devices/" + deviceId + "/hooks" + suffix, body);
  async function load() {
    setData(await api<Data>());
  }
  useEffect(() => {
    void load().catch((e) => setMessage(e.message));
  }, [deviceId]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
      setMessage("Guardado");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setForm((v) => ({ ...v, pin: "" }));
      setBusy(false);
    }
  }
  const states: Record<string, string> = {
    AVAILABLE: "Disponible",
    DELIVERED: "Entregado (activación eléctrica)",
    BLOCKED: "Bloqueado · revisar entrega",
    ERROR: "Error",
  };
  return (
    <section className="panel">
      <h2>Ganchos y PIN</h2>
      <p>
        El PIN se guarda protegido y no vuelve a mostrarse. Tras una entrega,
        rearma el gancho cuando hayas repuesto la llave.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))",
          gap: 12,
        }}
      >
        {data?.hooks.map((h) => (
          <article
            key={h.hook}
            style={{ padding: 14, border: "1px solid #aaa", borderRadius: 12 }}
          >
            <strong>
              Gancho {h.hook} · {h.room}
            </strong>
            <p>
              {states[h.state]}
              {!h.enabled ? " · Desactivado" : ""}
            </p>
            <button onClick={() => setForm({ ...h, pin: "" })}>Editar</button>
            {h.state !== "AVAILABLE" && (
              <button
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(
                    "Motivo del rearme (llave repuesta o intervención):",
                  );
                  if (reason)
                    void run(() => api("/rearm", { hook: h.hook, reason }));
                }}
              >
                Rehabilitar entrega
              </button>
            )}
          </article>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api("", form));
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}
      >
        <label>
          Gancho físico
          <select
            value={form.hook}
            onChange={(e) => {
              const hook = Number(e.target.value),
                h = data?.hooks.find((h) => h.hook === hook);
              setForm(
                h
                  ? { ...h, pin: "" }
                  : { hook, room: "", pin: "", enabled: true },
              );
            }}
          >
            {Array.from({ length: 25 }, (_, i) => (
              <option key={i + 1}>{i + 1}</option>
            ))}
          </select>
        </label>
        <label>
          Habitación
          <input
            required
            maxLength={16}
            value={form.room}
            onChange={(e) => setForm({ ...form, room: e.target.value })}
          />
        </label>
        <label>
          Nuevo PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            pattern="[0-9]*"
            minLength={data?.settings.minLength || 4}
            maxLength={data?.settings.maxLength || 12}
            value={form.pin}
            onChange={(e) =>
              setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })
            }
            placeholder={
              data?.hooks.some((h) => h.hook === form.hook)
                ? "Vacío: conservar PIN"
                : "Introduce PIN"
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Activo
        </label>
        <button disabled={busy}>Guardar gancho</button>
      </form>
      {data && (
        <fieldset>
          <legend>Longitud permitida del PIN</legend>
          {(["minLength", "maxLength"] as const).map((k) => (
            <label key={k}>
              {k === "minLength" ? "Mínimo" : "Máximo"}
              <input
                type="number"
                min={4}
                max={12}
                value={data.settings[k]}
                onChange={(e) =>
                  setData({
                    ...data,
                    settings: { ...data.settings, [k]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
          <button
            disabled={busy}
            onClick={() => void run(() => api("", { settings: data.settings }))}
          >
            Guardar longitudes
          </button>
        </fieldset>
      )}
      <details>
        <summary>Identificar canal sin activar el gancho</summary>
        <p>
          Gancho {form.hook}: placa {Math.floor((form.hook - 1) / 8) + 1},
          dirección 0x{(0x20 + Math.floor((form.hook - 1) / 8)).toString(16)},
          canal A{(form.hook - 1) % 8}.
        </p>
        <p>
          Comprueba la etiqueta y el cableado con la alimentación de actuadores
          desconectada. Esta consulta no activa salidas.
        </p>
        {platformAdmin && (
          <small>
            Los drivers y el cableado conservan su asignación existente.
          </small>
        )}
      </details>
      <p role="status">{message}</p>
    </section>
  );
}
