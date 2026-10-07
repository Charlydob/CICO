import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthContext";
import {
  getDevices,
  getDevice,
  registerDevice,
  getFirmwareReleases,
  startDeviceUpdate,
  cancelDeviceUpdate,
  sendDeviceCommand,
  revokeDeviceCredential,
  deleteFirmwareRelease,
  uploadFirmware,
  downloadFirmwareRelease,
  updateDeviceConfiguration,
} from "../../services/backendApi";
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
  const [calibration, setCalibration] = useState({ closedAngle: 10, openAngle: 90, holdMs: 1500 });
  const [rfidAllowlist, setRfidAllowlist] = useState("");
  useEffect(() => {
    if (selected?.hardwareModel !== "ESP32_DEVKIT_CHECKOUT_V1") return;
    setCalibration({
      closedAngle: selected.desiredConfig?.closedAngle ?? 10,
      openAngle: selected.desiredConfig?.openAngle ?? 90,
      holdMs: selected.desiredConfig?.holdMs ?? 1500,
    });
    setRfidAllowlist((selected.desiredConfig?.allowedRfids || []).join(", "));
  }, [selected?.id]);
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
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  }
  async function publish(event: FormEvent) {
    event.preventDefault();
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
      await uploadFirmware(file, metadata);
      setFile(null);
      setFileKey((key) => key + 1);
    }, "Firmware release published. SHA-256 calculated by server.");
  }
  const compatible = updateDevice
    ? releases.filter(
        (release) =>
          release.hardwareModel === updateDevice.hardwareModel &&
          isNewer(release.version, updateDevice.currentFirmwareVersion),
      )
    : [];
  return (
    <section className="module-page ota-page">
      <div className="module-title">
        <div>
          <h1>Devices / Firmware</h1>
          <p>Platform Admin · remote firmware updates</p>
        </div>
        <button disabled={busy} onClick={() => void run(reload, "Refreshed.")}>
          Refresh
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
          Firmware Releases
        </button>
      </div>
      {notice && (
        <p role="status" className="ota-notice">
          {notice}
        </p>
      )}
      {tab === "devices" ? (
        <>
          <div className="panel ota-table-scroll">
            <table className="ota-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Status / Hardware</th>
                  <th>Firmware / Target</th>
                  <th>Last seen</th>
                  <th>Update</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <strong>{device.name}</strong>
                      <br />
                      {device.deviceId}
                    </td>
                    <td>
                      {device.status}
                      <br />
                      {device.hardwareModel}
                    </td>
                    <td>
                      {device.currentFirmwareVersion || "—"}
                      <br />
                      Target {device.targetFirmwareVersion || "—"}
                    </td>
                    <td>{age(device.lastSeenAt)}</td>
                    <td>
                      {updateLabel(device.latestUpdate)}
                      {device.latestUpdate?.stalled && (
                        <p>Awaiting device confirmation</p>
                      )}
                    </td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(
                            async () => setSelected(await getDevice(device.id)),
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
            {!devices.length && <p>No registered devices.</p>}
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
              }, "Device registered. Provision its individual credential on the backend host.");
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
            <p>Application firmware.bin only · OTA slot 1792 KiB</p>
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
            <button className="primary-button" disabled={busy || !file}>
              {busy ? "Uploading…" : "Publish release"}
            </button>
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
                      <button
                        disabled={busy}
                        onClick={() => {
                          setTab("devices");
                          setNotice(
                            `Select a ${release.hardwareModel} device and press Update.`,
                          );
                        }}
                      >
                        Assign / Update device
                      </button>{" "}
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
                              `Delete unused release ${release.version} / ${release.buildId}?`,
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
      {selected && (
        <div className="ota-modal-backdrop">
          <section
            className="ota-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Device details"
          >
            <button onClick={() => setSelected(null)}>Close</button>
            <h2>{selected.name}</h2>
            <dl className="ota-details">
              {Object.entries({
                "Device ID": selected.deviceId,
                Hotel: selected.tenant?.name || "Unassigned",
                Hardware: selected.hardwareModel,
                Firmware: selected.currentFirmwareVersion,
                Build: selected.currentBuildId,
                Target: selected.targetFirmwareVersion,
                Status: selected.status,
                "Last seen": age(selected.lastSeenAt),
                RSSI: selected.lastRssi,
                IP: selected.lastIp,
                "Uptime (s)": selected.uptime,
                "Free heap": selected.freeHeap,
                PSRAM: selected.psram,
                "Config version": selected.configVersion,
                "Last reset": selected.lastResetReason,
                "Last OTA result": selected.lastOtaResult,
                "Last RFID": selected.lastRfid,
                "RFID raw frame": selected.lastRfidRaw,
                "Trap": selected.trapState,
                Credentials: selected.credentialConfigured
                  ? "Provisioned"
                  : "Not provisioned / Revoked",
              }).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value ?? "—"}</dd>
                </div>
              ))}
            </dl>
            {selected.hardwareModel === "ESP32_DEVKIT_CHECKOUT_V1" && (
              <section className="panel settings-form ota-form" aria-label="Trap calibration">
                <h3>Trap calibration</h3>
                <label>Closed
                  <input type="number" min="0" max="180" value={calibration.closedAngle}
                    onChange={(e) => setCalibration({ ...calibration, closedAngle: Number(e.target.value) })} />
                </label>
                <label>Open
                  <input type="number" min="0" max="180" value={calibration.openAngle}
                    onChange={(e) => setCalibration({ ...calibration, openAngle: Number(e.target.value) })} />
                </label>
                <label>Hold (ms)
                  <input type="number" min="100" max="30000" step="100" value={calibration.holdMs}
                    onChange={(e) => setCalibration({ ...calibration, holdMs: Number(e.target.value) })} />
                </label>
                <label>Allowed RFID UIDs
                  <input value={rfidAllowlist} placeholder="AABBCCDD, 11223344"
                    onChange={(e) => setRfidAllowlist(e.target.value)} />
                </label>
                <div className="ota-tabs">
                  <button disabled={busy} onClick={() => void run(() => sendDeviceCommand(selected.id, "SET_SERVO_CONFIG", calibration), "Move queued.")}>Move</button>
                  <button disabled={busy} onClick={() => void run(() => sendDeviceCommand(selected.id, "OPEN_TRAP"), "Open queued.")}>Open</button>
                  <button disabled={busy} onClick={() => void run(() => sendDeviceCommand(selected.id, "CLOSE_TRAP"), "Close queued.")}>Close</button>
                  <button disabled={busy} onClick={() => void run(() => sendDeviceCommand(selected.id, "CYCLE_TRAP"), "Test cycle queued.")}>Test</button>
                  <button disabled={busy} onClick={() => void run(() => sendDeviceCommand(selected.id, "SERVO_RAW_PWM_TEST"), "Raw PWM test queued.")}>Test PWM crudo</button>
                  <button disabled={busy} onClick={() => void run(() => sendDeviceCommand(selected.id, "SERVO_RAW_PIN25_TEST"), "GPIO25 servo test queued.")}>Test servo GPIO25</button>
                  <button className="primary-button" disabled={busy} onClick={() => void run(() => updateDeviceConfiguration(selected.id, {
                    ...calibration,
                    allowedRfids: rfidAllowlist.split(",").map((value) => value.trim()).filter(Boolean),
                  }), "Configuration saved for sync.")}>Save</button>
                </div>
              </section>
            )}
            <div className="ota-tabs">
              {selected.hardwareModel === "ESP32_DEVKIT_CHECKOUT_V1" && (
                <button disabled={busy} onClick={() => void run(() => sendDeviceCommand(selected.id, "CHECK_RFID"), "RFID check queued.")}>Check RFID</button>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  void run(
                    () => sendDeviceCommand(selected.id, "CHECK_UPDATE"),
                    "CHECK_UPDATE queued.",
                  )
                }
              >
                Check update
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Restart ${selected.name}?`))
                    void run(
                      () => sendDeviceCommand(selected.id, "RESTART"),
                      "RESTART queued.",
                    );
                }}
              >
                Restart
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Revoke ${selected.name}'s credential? It will stop contacting CICO until provisioned again.`,
                    )
                  )
                    void run(
                      () => revokeDeviceCredential(selected.id),
                      "Credential revoked.",
                    );
                }}
              >
                Revoke credential
              </button>
            </div>
            <h3>Update history</h3>
            {selected.updates?.map((update) => (
              <article key={update.id}>
                <strong>
                  {update.release.version} · {update.release.buildId}
                </strong>
                <p>
                  {updateLabel(update)} ·{" "}
                  {new Date(update.createdAt).toLocaleString()}
                </p>
                {update.stalled && (
                  <p>
                    Awaiting device confirmation; check connectivity and boot
                    diagnostics.
                  </p>
                )}
                {ACTIVE.includes(update.status) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `¿Cancelar la actualización ${update.release.version} / ${update.release.buildId}? CICO dejará de distribuirla. Si el dispositivo ya estaba instalando o reiniciando, la cancelación no puede deshacer los bytes ya escritos.`,
                        )
                      )
                        void run(
                          () => cancelDeviceUpdate(selected.id, update.id),
                          "Actualización cancelada. El historial se ha conservado.",
                        );
                    }}
                  >
                    Cancelar actualización
                  </button>
                )}
                <details>
                  <summary>Events</summary>
                  {update.events?.map((event) => (
                    <p key={event.id}>
                      {new Date(event.createdAt).toLocaleString()} ·{" "}
                      {event.status} {event.progress}% {event.resultCode}
                    </p>
                  ))}
                </details>
              </article>
            ))}
            <h3>Commands</h3>
            {selected.commands?.map((command) => (
              <p key={command.id}>
                {command.type} ·{" "}
                {command.status === "PENDING" &&
                new Date(command.expiresAt).getTime() <= Date.now()
                  ? "EXPIRED"
                  : command.status}{" "}
                · {new Date(command.createdAt).toLocaleString()}
              </p>
            ))}
            {selected.hardwareModel === "ESP32_DEVKIT_CHECKOUT_V1" && (
              <>
                <h3>Device logs</h3>
                {selected.events?.map((event) => (
                  <p key={event.id}>{new Date(event.createdAt).toLocaleString()} · {event.type} · {event.detail || "—"}</p>
                ))}
              </>
            )}
          </section>
        </div>
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
                  `START UPDATE on ${updateDevice.name}? The device will restart after verification.`,
                )
              )
                return;
              void run(async () => {
                await startDeviceUpdate(updateDevice.id, releaseId);
                setUpdateDevice(null);
              }, "Update pending. Waiting for the device to poll CICO.");
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
              its health check confirmation.
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
