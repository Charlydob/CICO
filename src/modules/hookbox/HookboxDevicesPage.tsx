import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { hookboxRequest } from "../../services/backendApi";
import "./hookbox.css";
type Panel = {
  id: string;
  deviceId: string;
  name: string;
  status: string;
  hardwareModel: string;
  currentFirmwareVersion: string | null;
  currentBuildId: string | null;
  lastSeenAt: string | null;
  uiDesiredVersion: string | null;
  uiAppliedVersion: string | null;
  uiRejectedReason: string | null;
};
export function HookboxDevicesPage() {
  const { session, activeTenantId } = useAuth();
  const [devices, setDevices] = useState<Panel[]>([]),
    [selected, setSelected] = useState<Panel>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const tenant = session?.tenants.find((t) => t.id === activeTenantId),
    base = `/t/${encodeURIComponent(tenant?.slug || "")}/devices`;
  const id = window.location.pathname.match(/\/devices\/([a-f0-9-]+)\/?$/)?.[1];
  useEffect(() => {
    let active = true;
    setLoading(true);
    void (
      id
        ? hookboxRequest<Panel>("devices/" + id).then((d) => {
            if (active) setSelected(d);
          })
        : hookboxRequest<Panel[]>("devices").then((d) => {
            if (active) setDevices(d);
          })
    )
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return (
    <section className="hb-editor hb-device-page">
      <p className="hb-eyebrow">{tenant?.name}</p>
      <h1>{selected?.name || "Mis dispositivos HOOKBOX"}</h1>
      <p>
        Personaliza las pantallas asignadas a tu hotel. Los cambios de diseño se
        sincronizan sin actualizar el firmware.
      </p>
      {error && <p role="alert">{error}</p>}
      {loading && <p>Cargando dispositivos…</p>}
      {selected ? (
        <>
          <a href={base}>Volver a mis dispositivos</a>
          <div className="hb-device-detail">
            <div>
              <span>Pantalla</span>
              <strong>{selected.deviceId}</strong>
            </div>
            <div>
              <span>Estado</span>
              <strong>
                {selected.lastSeenAt &&
                Date.now() - Date.parse(selected.lastSeenAt) < 90000
                  ? "Conectado"
                  : "Sin conexión reciente"}
              </strong>
            </div>
            <div>
              <span>Firmware</span>
              <strong>
                {selected.currentFirmwareVersion || "Sin informar"}
              </strong>
            </div>
            <div>
              <span>Diseño publicado</span>
              <strong>
                {selected.uiDesiredVersion || "Plantilla predeterminada"}
              </strong>
            </div>
            <div>
              <span>Diseño confirmado por la pantalla</span>
              <strong>
                {selected.uiAppliedVersion || "Pendiente de confirmación"}
              </strong>
            </div>
          </div>
          <a className="hb-primary-link" href={`${base}/${selected.id}/screen`}>
            Personalizar pantalla
          </a>
          {selected.uiRejectedReason && (
            <p role="alert">{selected.uiRejectedReason}</p>
          )}
        </>
      ) : (
        <div className="hb-device-cards">
          {devices.map((d) => (
            <article key={d.id}>
              <span className="hb-eyebrow">HOOKBOX</span>
              <h2>{d.name}</h2>
              <p>
                {d.currentFirmwareVersion
                  ? "Firmware " + d.currentFirmwareVersion
                  : "Sin firmware informado"}
              </p>
              <a href={`${base}/${d.id}`}>Ver dispositivo</a>
              <a className="hb-primary-link" href={`${base}/${d.id}/screen`}>
                Personalizar pantalla
              </a>
            </article>
          ))}
          {!loading && !error && !devices.length && (
            <p>
              No hay dispositivos HOOKBOX asignados a este hotel. El
              administrador de plataforma puede asignarlos.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
