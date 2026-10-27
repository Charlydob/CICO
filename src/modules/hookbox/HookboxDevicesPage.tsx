import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { hookboxRequest } from "../../services/backendApi";
import "./hookbox.css";
import { HookboxPinsPanel } from "../admin/HookboxPinsPanel";

import { HookboxIntegrationPanel } from "../admin/HookboxIntegrationPanel";
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
      <h1>{selected?.name || "My HOOKBOX devices"}</h1>
      <p>
        Customize the displays assigned to your hotel. Published designs sync
        automatically with the display.
      </p>
      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading devices…</p>}
      {selected ? (
        <>
          <a href={base}>Back to my devices</a>
          <div className="hb-device-detail">
            <div>
              <span>Display</span>
              <strong>{selected.deviceId}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>
                {selected.lastSeenAt &&
                Date.now() - Date.parse(selected.lastSeenAt) < 90000
                  ? "Connected"
                  : "No recent connection"}
              </strong>
            </div>
            <div>
              <span>Published design</span>
              <strong>{selected.uiDesiredVersion || "Default template"}</strong>
            </div>
            <div>
              <span>Design confirmed by display</span>
              <strong>
                {selected.uiAppliedVersion || "Waiting for confirmation"}
              </strong>
            </div>
          </div>
          <a className="hb-primary-link" href={`${base}/${selected.id}/screen`}>
            Customize display
          </a>
          <HookboxPinsPanel deviceId={selected.id} />
          <HookboxIntegrationPanel deviceId={selected.id} />
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
              <a href={`${base}/${d.id}`}>View device</a>
              <a className="hb-primary-link" href={`${base}/${d.id}/screen`}>
                Customize display
              </a>
            </article>
          ))}
          {!loading && !error && !devices.length && (
            <p>
              No HOOKBOX displays are assigned to this hotel. Contact your
              platform administrator to assign a display.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
