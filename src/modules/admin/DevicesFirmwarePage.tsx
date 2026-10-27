import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  getDevices,
  getDevice,
  registerDevice,
  getFirmwareReleases,
  startDeviceUpdate,
  deleteFirmwareRelease,
  uploadFirmware,
  publishFirmwareRelease,
  downloadFirmwareRelease,
} from "../../services/backendApi";
import { DeviceDetailPanel } from "./DeviceDetailPanel";
import type {
  PhysicalDevice,
  FirmwareRelease,
  OtaUpdate,
} from "../../types/firmware";

const SLOT_BYTES = 1792 * 1024;
const ACTIVE = [
  "PENDING",
  "DOWNLOADING",
  "VERIFYING",
  "INSTALLING",
  "REBOOTING",
  "HEALTH_CHECK",
];
function age(value: string | null) {
  if (!value) return "Never";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  return seconds < 60
    ? `${seconds} s ago`
    : `${Math.floor(seconds / 60)} min ago`;
}
function updateLabel(update?: OtaUpdate | null) {
  return update
    ? `${update.status}${update.status === "DOWNLOADING" ? ` ${update.progress}%` : ""}${update.resultCode ? ` · ${update.resultCode}` : ""}`
    : "—";
}
function isNewer(candidate: string, current: string | null) {
  if (!current) return false;
  const a = candidate.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function DevicesFirmwarePage() {
  const { session } = useAuth();
  const listScrollPosition = useRef(0);
  const [tab, setTab] = useState<"devices" | "releases">("devices");
  const [devices, setDevices] = useState<PhysicalDevice[]>([]),
    [releases, setReleases] = useState<FirmwareRelease[]>([]);
  const [selected, setSelected] = useState<PhysicalDevice | null>(null),
    [updateDevice, setUpdateDevice] = useState<PhysicalDevice | null>(null);
  const [releaseId, setReleaseId] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null),
    [fileKey, setFileKey] = useState(0);
  const [metadata, setMetadata] = useState({
    version: "",
    buildId: "",
    hardwareModel: "CROWPANEL_7_V3",
    releaseNotes: "",
  });
  const [newDevice, setNewDevice] = useState({
    name: "Hookbox Lab",
    deviceId: "",
    hardwareModel: "CROWPANEL_7_V3",
    tenantId: "",
  });
  async function reload() {
    const [nextDevices, nextReleases] = await Promise.all([
      getDevices(),
      getFirmwareReleases(),
    ]);
    setDevices(nextDevices);
    setReleases(nextReleases);
  }
  useEffect(() => {
    if (!session?.isPlatformAdmin) return;
    let alive = true,
      running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const [nextDevices, nextReleases, detail] = await Promise.all([
          getDevices(),
          getFirmwareReleases(),
          selected?.id ? getDevice(selected.id) : Promise.resolve(null),
        ]);
        if (alive) {
          setDevices(nextDevices);
          setReleases(nextReleases);
          if (detail) setSelected(detail);
        }
      } catch (error) {
        if (alive)
          setNotice(
            error instanceof Error
              ? error.message
              : "Could not refresh devices.",
          );
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session?.isPlatformAdmin, selected?.id]);
  if (!session?.isPlatformAdmin) return null;
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice("");
    try {
      await action();
      setNotice(success);
      await reload();
      if (selected) setSelected(await getDevice(selected.id));
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Operation failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function openDevice(device: PhysicalDevice) {
    listScrollPosition.current = window.scrollY;
    const detail = await getDevice(device.id);
    setSelected(detail);
    window.scrollTo({ top: 0 });
  }
  function closeDevice() {
    setSelected(null);
    window.requestAnimationFrame(() => window.scrollTo({ top: listScrollPosition.current }));
  }
  async function publish(event: FormEvent) {
    event.preventDefault();
    const submitter=(event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null;
    const status=submitter?.value==="DRAFT"?"DRAFT" as const:"PUBLISHED" as const;
    if (
      !file ||
      !/\.bin$/i.test(file.name) ||
      !file.size ||
      file.size > SLOT_BYTES
    ) {
      setNotice("Select firmware.bin, up to 1792 KiB.");
      return;
    }
    await run(async () => {
      await uploadFirmware(file, {...metadata,status});
      setFile(null);
      setFileKey((key) => key + 1);
    }, status==="DRAFT"?"Borrador guardado. SHA-256 calculado por el servidor.":"Firmware release published. SHA-256 calculated by server.");
  }
  const compatible = updateDevice
    ? releases.filter(
        (release) =>
          release.hardwareModel === updateDevice.hardwareModel &&
          release.status === "PUBLISHED" &&
          isNewer(release.version, updateDevice.currentFirmwareVersion),
      )
    : [];
  return (
    <section className="module-page ota-page">
      {!selected&&<><div className="module-title">
        <div>
          <h1>Devices / Firmware</h1>
          <p>Platform management · Remote updates</p>
        </div>
        <button disabled={busy} onClick={() => void run(reload, "Data refreshed.")}>
          Update
        </button>
      </div>
      <div className="ota-tabs">
        <button
          className={tab === "devices" ? "active" : ""}
          onClick={() => setTab("devices")}
        >
          Devices
        </button>
        <button
          className={tab === "releases" ? "active" : ""}
          onClick={() => setTab("releases")}
        >
          Firmware releases
        </button>
      </div></>}
      {notice && (
        <p role="status" className="ota-notice">
          {notice}
        </p>
      )}
      {tab === "devices" ? (
        selected ? <DeviceDetailPanel
          device={selected}
          devices={devices}
          tenants={session.tenants}
          busy={busy}
          run={run}
          onBack={closeDevice}
          onStartUpdate={(device)=>{setUpdateDevice(device);setReleaseId("");}}
        /> : <>
          <div className="panel ota-table-scroll">
            <table className="ota-table device-list-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Status / Hardware</th>
                  <th>Firmware / Target</th>
                  <th>Last connection</th>
                  <th>Update</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td data-label="Device">
                      <strong>{device.name}</strong>
                      <br />
                      {device.deviceId}
                    </td>
                    <td data-label="Status and hardware">
                      {device.status}
                      <br />
                      {device.hardwareModel}
                    </td>
                    <td data-label="Firmware">
                      {device.currentFirmwareVersion || "—"}
                      <br />
                      Target {device.targetFirmwareVersion || "—"}
                    </td>
                    <td data-label="Last connection">{age(device.lastSeenAt)}</td>
                    <td data-label="Update">
                      {updateLabel(device.latestUpdate)}
                      {device.latestUpdate?.stalled && (
                        <p>Waiting for device confirmation</p>
                      )}
                    </td>
                    <td data-label="Actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => openDevice(device),
                            "",
                          )
                        }
                      >
                        Details
                      </button>{" "}
                      <button
                        disabled={
                          busy ||
                          !device.credentialConfigured ||
                          !device.currentFirmwareVersion ||
                          ACTIVE.includes(device.latestUpdate?.status || "")
                        }
                        onClick={() => {
                          setUpdateDevice(device);
                          setReleaseId("");
                        }}
                      >
                        Update
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!devices.length && <p>No devices registered.</p>}
          </div>
          <form
            className="panel settings-form ota-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await registerDevice({
                  ...newDevice,
                  tenantId: newDevice.tenantId || null,
                });
                setNewDevice({ ...newDevice, deviceId: "" });
              }, "Device registrado. Provisiona su credencial individual en el servidor.");
            }}
          >
            <h2>Register device</h2>
            <label>
              Name
              <input
                required
                value={newDevice.name}
                onChange={(e) =>
                  setNewDevice({ ...newDevice, name: e.target.value })
                }
              />
            </label>
            <label>
              Device ID
              <input
                required
                pattern="[A-Za-z0-9_-]+"
                maxLength={64}
                value={newDevice.deviceId}
                onChange={(e) =>
                  setNewDevice({ ...newDevice, deviceId: e.target.value })
                }
              />
            </label>
            <label>
              Hardware
              <select
                value={newDevice.hardwareModel}
                onChange={(e) =>
                  setNewDevice({ ...newDevice, hardwareModel: e.target.value })
                }
              >
                <option>CROWPANEL_7_V3</option>
                <option>ESP32_DEVKIT_CHECKOUT_V1</option>
              </select>
            </label>
            <label>
              Hotel
              <select
                value={newDevice.tenantId}
                onChange={(e) =>
                  setNewDevice({ ...newDevice, tenantId: e.target.value })
                }
              >
                <option value="">Unassigned / Lab</option>
                {session.tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={busy}>
              Register
            </button>
          </form>
        </>
      ) : (
        <>
          <form
            className="panel settings-form ota-form"
            onSubmit={(event) => void publish(event)}
          >
            <h2>Upload firmware</h2>
            <p>Application image firmware.bin only · OTA partition 1792 KiB</p>
            <label>
              Version
              <input
                required
                pattern="[0-9]+\.[0-9]+\.[0-9]+"
                placeholder="2.4.1"
                value={metadata.version}
                onChange={(e) =>
                  setMetadata({ ...metadata, version: e.target.value })
                }
              />
            </label>
            <label>
              Build
              <input
                required
                maxLength={128}
                placeholder="20261002.ota-test"
                value={metadata.buildId}
                onChange={(e) =>
                  setMetadata({ ...metadata, buildId: e.target.value })
                }
              />
            </label>
            <label>
              Hardware
              <select
                value={metadata.hardwareModel}
                onChange={(e) =>
                  setMetadata({ ...metadata, hardwareModel: e.target.value })
                }
              >
                <option>CROWPANEL_7_V3</option>
                <option>ESP32_DEVKIT_CHECKOUT_V1</option>
              </select>
            </label>
            <label>
              Release notes
              <textarea
                maxLength={8000}
                value={metadata.releaseNotes}
                onChange={(e) =>
                  setMetadata({ ...metadata, releaseNotes: e.target.value })
                }
              />
            </label>
            <label>
              Firmware
              <input
                key={fileKey}
                type="file"
                accept=".bin"
                required
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
            <div className="ota-tabs"><button name="status" value="DRAFT" disabled={busy || !file}>
              {busy ? "Saving…" : "Save draft"}
            </button><button name="status" value="PUBLISHED" className="primary-button" disabled={busy || !file}>
              {busy ? "Uploading…" : "Publish release"}
            </button></div>
          </form>
          <div className="panel ota-table-scroll">
            <table className="ota-table">
              <thead>
                <tr>
                  <th>Version / Build</th>
                  <th>Hardware / Size</th>
                  <th>SHA-256</th>
                  <th>Created / Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release) => (
                  <tr key={release.id}>
                    <td>
                      {release.version}
                      <br />
                      {release.buildId}
                      <br/><strong>{release.status}</strong>
                    </td>
                    <td>
                      {release.hardwareModel}
                      <br />
                      {release.fileSize.toLocaleString()} bytes
                    </td>
                    <td>
                      <code className="ota-hash">{release.sha256}</code>
                    </td>
                    <td>
                      {new Date(release.createdAt).toLocaleString()}
                      <p>{release.releaseNotes}</p>
                    </td>
                    <td>
                      {release.status==="PUBLISHED"&&<button
                        disabled={busy}
                        onClick={() => {
                          setTab("devices");
                          setNotice(
                            `Selecciona un dispositivo ${release.hardwareModel} y pulsa Update.`,
                          );
                        }}
                      >
                        Assign / update device
                      </button>} {release.status==="DRAFT"&&<button disabled={busy} onClick={()=>window.confirm(`¿Publish ${release.version} / ${release.buildId}?`)&&void run(()=>publishFirmwareRelease(release.id),"Release publicada; aún no asignada a ningún dispositivo.")}>Publish</button>} {" "}
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => downloadFirmwareRelease(release.id),
                            "Firmware downloaded.",
                          )
                        }
                      >
                        Download
                      </button>{" "}
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `¿Delete la release sin uso ${release.version} / ${release.buildId}?`,
                            )
                          )
                            void run(
                              () => deleteFirmwareRelease(release.id),
                              "Release deleted.",
                            );
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {updateDevice && (
        <div className="ota-modal-backdrop">
          <form
            className="ota-modal ota-form"
            role="dialog"
            aria-modal="true"
            aria-label="Start firmware update"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !releaseId ||
                !window.confirm(
                  `¿START UPDATE en ${updateDevice.name}? El dispositivo se reiniciará tras verificarla.`,
                )
              )
                return;
              void run(async () => {
                await startDeviceUpdate(updateDevice.id, releaseId);
                setUpdateDevice(null);
              }, "Update pendiente. Esperando la siguiente consulta del dispositivo.");
            }}
          >
            <h2>Update {updateDevice.name}</h2>
            <p>
              Current: {updateDevice.currentFirmwareVersion} ·{" "}
              {updateDevice.currentBuildId}
              <br />
              Hardware: {updateDevice.hardwareModel}
            </p>
            <label>
              Compatible release
              <select
                required
                value={releaseId}
                onChange={(e) => setReleaseId(e.target.value)}
              >
                <option value="">Select a newer release</option>
                {compatible.map((release) => (
                  <option key={release.id} value={release.id}>
                    {release.version} · {release.buildId}
                  </option>
                ))}
              </select>
            </label>
            {!compatible.length && (
              <p>Upload a newer compatible release first.</p>
            )}
            <p>
              The device downloads, verifies and restarts. Completion requires
              confirmation of its health check.
            </p>
            <div className="ota-tabs">
              <button
                type="button"
                disabled={busy}
                onClick={() => setUpdateDevice(null)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy || !releaseId}>
                START UPDATE
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
