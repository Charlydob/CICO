import {CheckoutWorkflow} from "./CheckoutWorkflow";
import {useAuth} from "../../auth/AuthContext";
import { CalendarCheck, Download, KeyRound, Plus, Printer, QrCode, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createCheckoutKey,
  createCheckoutKeysBulk,
  createRoom,
  createRoomsBulk,
  deleteCheckoutKey,
  deleteRoom,
  getCheckoutKeys,
  getCheckoutOverview,
  manualCheckout,
  setTodayCheckoutRooms,
  updateCheckoutKey,
  updateRoom,
} from "../../services/backendApi";
import type { CheckoutEvent, CheckoutOverview, KeyIdentifier, Room, RoomStatus } from "../../types/checkout";

const ALL_ROOMS = "__all__";

type QrTextMode = "none" | "label" | "room" | "label-room";

interface QrPreview {
  keyId?: string;
  roomId?: string;
  label: string;
  roomNumber?: string;
  dataUrl: string;
  checkoutUrl?: string;
  filename: string;
}

const filters: Array<{ id: "all" | RoomStatus; label: string }> = [
  { id: "all", label: "All" },
  { id: "ready_for_cleaning", label: "Pending cleaning" },
  { id: "cleaning", label: "Cleaning" },
  { id: "ready", label: "Ready" },
];

const qrTextModes: Array<{ id: QrTextMode; label: string }> = [
  { id: "none", label: "None" },
  { id: "label", label: "Label only" },
  { id: "room", label: "Room only" },
  { id: "label-room", label: "Label + room" },
];

function roomStatusLabel(status: RoomStatus) {
  return status.replace(/_/g, " ");
}

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString() : "-";
}

function slug(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function qrBadgeLines(mode: QrTextMode, label: string, roomNumber?: string) {
  const cleanLabel = label.trim();
  const cleanRoom = roomNumber?.trim();

  if (mode === "label" && cleanLabel) {
    return [{ text: cleanLabel.toUpperCase(), size: 54, weight: 800 }];
  }

  if (mode === "room" && cleanRoom) {
    return [{ text: `ROOM ${cleanRoom}`.toUpperCase(), size: 50, weight: 800 }];
  }

  if (mode === "label-room") {
    return [
      cleanLabel ? { text: cleanLabel.toUpperCase(), size: 48, weight: 800 } : undefined,
      cleanRoom ? { text: `ROOM ${cleanRoom}`.toUpperCase(), size: 34, weight: 700 } : undefined,
    ].filter(Boolean) as Array<{ text: string; size: number; weight: number }>;
  }

  return [];
}

function qrFilename(label: string, roomNumber?: string) {
  const roomPart = roomNumber ? `room-${slug(roomNumber)}` : "checkout";
  const labelPart = slug(label || "checkout");

  return `${roomPart}-${labelPart}-qr.png`;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not render QR image."));
    image.src = src;
  });
}

async function printableQrDataUrl({
  qrDataUrl,
  label,
  roomNumber,
  textMode,
}: {
  qrDataUrl: string;
  label: string;
  roomNumber?: string;
  textMode: QrTextMode;
}) {
  const lines = qrBadgeLines(textMode, label, roomNumber);

  if (lines.length === 0) {
    return qrDataUrl;
  }

  const qrImage = await loadImage(qrDataUrl);
  const canvas = document.createElement("canvas");
  const qrSize = 760;
  canvas.width = qrSize;
  canvas.height = qrSize;

  const context = canvas.getContext("2d");
  if (!context) {
    return qrDataUrl;
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(qrImage, 0, 0, qrSize, qrSize);

  const maxBadgeWidth = qrSize * 0.42;
  const horizontalPadding = 34;
  const verticalPadding = 24;
  const gap = lines.length > 1 ? 10 : 0;
  const measured = lines.map((line) => {
    let size = line.size;
    context.font = `${line.weight} ${size}px Arial, sans-serif`;
    while (context.measureText(line.text).width > maxBadgeWidth - horizontalPadding * 2 && size > 22) {
      size -= 2;
      context.font = `${line.weight} ${size}px Arial, sans-serif`;
    }
    return { ...line, size, width: context.measureText(line.text).width };
  });
  const badgeWidth = Math.min(
    maxBadgeWidth,
    Math.max(210, Math.max(...measured.map((line) => line.width)) + horizontalPadding * 2),
  );
  const lineHeights = measured.map((line) => line.size * 1.05);
  const badgeHeight =
    lineHeights.reduce((total, height) => total + height, 0) + gap * (lines.length - 1) + verticalPadding * 2;
  const badgeX = (qrSize - badgeWidth) / 2;
  const badgeY = (qrSize - badgeHeight) / 2;

  context.shadowColor = "rgba(17, 24, 39, 0.18)";
  context.shadowBlur = 8;
  context.shadowOffsetY = 2;
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 18);
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = "#e5e7eb";
  context.lineWidth = 3;
  context.stroke();

  context.fillStyle = "#111827";
  context.textAlign = "center";
  context.textBaseline = "middle";

  let y = badgeY + verticalPadding;
  for (const [index, line] of measured.entries()) {
    context.font = `${line.weight} ${line.size}px Arial, sans-serif`;
    y += lineHeights[index] / 2;
    context.fillText(line.text, qrSize / 2, y);
    y += lineHeights[index] / 2 + gap;
  }

  return canvas.toDataURL("image/png");
}

export function CheckoutPage() {
  const {session,activeTenantId}=useAuth();
  const role=session?.memberships.find(m=>m.tenantId===activeTenantId)?.role;
  const canManage=Boolean(session?.isPlatformAdmin||["tenant_admin","manager"].includes(role||""));
  const [overview, setOverview] = useState<CheckoutOverview>();
  const [todayModalOpen, setTodayModalOpen] = useState(false);
  const [todayRoomIds, setTodayRoomIds] = useState<Set<string>>(new Set());
  const [keys, setKeys] = useState<KeyIdentifier[]>([]);
  const [filter, setFilter] = useState<"all" | RoomStatus>("all");
  const [tab, setTab] = useState<"board" | "settings">("board");
  const [roomNumber, setRoomNumber] = useState("");
  const [roomName, setRoomName] = useState("");
  const [roomAccessCode, setRoomAccessCode] = useState("");
  const [bulkRoomNumbers, setBulkRoomNumbers] = useState("");
  const [createQrForBulkRooms, setCreateQrForBulkRooms] = useState(true);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [regenerateExisting, setRegenerateExisting] = useState(false);
  const [qrTextMode, setQrTextMode] = useState<QrTextMode>("label-room");
  const [qrPreview, setQrPreview] = useState<QrPreview>();
  const [qrGallery, setQrGallery] = useState<QrPreview[]>([]);
  const [notice, setNotice] = useState("");

  async function reload() {
    const [nextOverview, nextKeys] = await Promise.all([getCheckoutOverview(), canManage?getCheckoutKeys():Promise.resolve([])]);
    setOverview(nextOverview);
    setKeys(nextKeys);
    setSelectedRoomId((current) => current || nextOverview.rooms[0]?.id || "");
  }

  useEffect(() => {
    void reload().catch((error) =>
      setNotice(error instanceof Error ? error.message : "Could not load checkout."),
    );
  }, []);

  const activeRooms = useMemo(
    () => (overview?.rooms || []).filter((room) => room.active !== false),
    [overview?.rooms],
  );
  const rooms = useMemo(
    () => activeRooms.filter((room) => filter === "all" || room.status === filter),
    [activeRooms, filter],
  );

  async function previewForKey(
    key: KeyIdentifier & { qrDataUrl: string; checkoutUrl?: string },
    room?: Room,
  ): Promise<QrPreview> {
    const dataUrl = await printableQrDataUrl({
      qrDataUrl: key.qrDataUrl,
      label: key.label,
      roomNumber: room?.number,
      textMode: qrTextMode,
    });

    return {
      keyId: key.id,
      roomId: key.roomId,
      label: key.label,
      roomNumber: room?.number,
      dataUrl,
      checkoutUrl: key.checkoutUrl,
      filename: qrFilename(key.label, room?.number),
    };
  }

  async function addRoom() {
    const room = await createRoom({
      number: roomNumber,
      name: roomName,
      accessCode: roomAccessCode || null,
      status: "unknown",
    });
    setRoomNumber("");
    setRoomName("");
    setRoomAccessCode("");
    setSelectedRoomId(room.id);
    setNotice("Room created.");
    await reload();
  }

  async function addRoomsBulk() {
    const result = await createRoomsBulk({
      numbers: bulkRoomNumbers,
      createQr: createQrForBulkRooms,
      keyLabel,
    });
    const createdRoomsById = new Map(result.created.map((room) => [room.id, room]));
    const gallery = await Promise.all(
      result.keys.map((key) => previewForKey(key, createdRoomsById.get(key.roomId))),
    );

    setBulkRoomNumbers("");
    setQrGallery(gallery);
    setQrPreview(gallery[0]);
    setNotice(
      `Created ${result.summary.created} rooms. Skipped ${result.summary.skippedExisting} existing${
        result.duplicateInput.length ? ` and ${result.duplicateInput.length} duplicate inputs` : ""
      }.`,
    );
    await reload();
  }

  async function saveRoomStatus(room: Room, status: RoomStatus) {
    if (!window.confirm("Start or correct room occupancy? Pending cleaning must be completed on the board.")) return;
    try { await updateRoom(room.id, { status }); await reload(); } catch(error) { setNotice(error instanceof Error ? error.message : "Could not update room."); }
  }

  async function deactivateRoom(room: Room) {
    await updateRoom(room.id, { active: false });
    await reload();
  }

  async function saveRoomAccessCode(room: Room, accessCode: string) {
    await updateRoom(room.id, { accessCode: accessCode || null });
    await reload();
  }

  async function removeRoom(room: Room) {
    if (
      !window.confirm(
        `Delete Room ${room.number}?\nIts QR codes will stop working. Historical checkout records will be preserved.`,
      )
    ) {
      return;
    }

    await deleteRoom(room.id);
    setQrGallery((current) => current.filter((item) => item.roomId !== room.id));
    setQrPreview((current) => (current?.roomId === room.id ? undefined : current));
    setSelectedRoomId((current) => (current === room.id ? "" : current));
    setNotice(`Room ${room.number} deleted.`);
    await reload();
  }

  async function createKey() {
    if (selectedRoomId === ALL_ROOMS) {
      const result = await createCheckoutKeysBulk({ label: keyLabel, regenerateExisting });
      const roomsById = new Map(activeRooms.map((room) => [room.id, room]));
      const gallery = await Promise.all(
        result.keys.map((key) => previewForKey(key, roomsById.get(key.roomId))),
      );

      setQrGallery(gallery);
      setQrPreview(gallery[0]);
      setNotice(
        `Generated ${result.summary.created} new QR keys, regenerated ${result.summary.regenerated}, skipped ${result.summary.skippedExisting} existing.`,
      );
      await reload();
      return;
    }

    const key = await createCheckoutKey({ roomId: selectedRoomId, label: keyLabel });
    const room = activeRooms.find((item) => item.id === selectedRoomId);
    const preview = await previewForKey(key, room);
    setKeyLabel("");
    setQrGallery([preview]);
    setQrPreview(preview);
    setNotice("QR key created.");
    await reload();
  }

  async function regenerate(key: KeyIdentifier) {
    const next = await updateCheckoutKey(key.id, { regenerate: true });
    const room = activeRooms.find((item) => item.id === next.roomId);
    const preview = await previewForKey(next, room);
    setQrGallery([preview]);
    setQrPreview(preview);
    setNotice("QR token regenerated.");
    await reload();
  }

  async function toggleKey(key: KeyIdentifier) {
    await updateCheckoutKey(key.id, { active: !key.active });
    await reload();
  }

  async function removeKey(key: KeyIdentifier, room?: Room) {
    const roomLabel = room?.number || "-";
    if (!window.confirm(`Delete QR for Room ${roomLabel}?\nThe printed QR will stop working.`)) {
      return;
    }

    await deleteCheckoutKey(key.id);
    setKeys((current) => current.filter((item) => item.id !== key.id));
    setQrGallery((current) => current.filter((item) => item.keyId !== key.id));
    setQrPreview((current) => (current?.keyId === key.id ? undefined : current));
    setNotice(`QR for Room ${roomLabel} deleted.`);
    await reload();
  }

  async function checkoutManually(room: Room) {
    await manualCheckout(room.id);
    setNotice(`Room ${room.number} checked out manually.`);
    await reload();
  }

  function openTodayCheckouts() {
    const today = overview?.todayDate;
    setTodayRoomIds(new Set(activeRooms.filter((room) =>
      room.checkoutDueDate?.slice(0, 10) === today).map((room) => room.id)));
    setTodayModalOpen(true);
  }

  async function saveTodayCheckouts() {
    try { await setTodayCheckoutRooms([...todayRoomIds]);
    setTodayModalOpen(false);
    setNotice("Today's expected check-outs were saved.");
    await reload(); } catch(error) { setNotice(error instanceof Error ? error.message : "Could not save expected departures."); }
  }

  function downloadQr(item = qrPreview) {
    if (!item) {
      return;
    }

    const link = document.createElement("a");
    link.href = item.dataUrl;
    link.download = item.filename;
    link.click();
  }

  function printGallery() {
    if (qrGallery.length === 0) {
      return;
    }

    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) {
      setNotice("Could not open print sheet.");
      return;
    }

    popup.document.write(`<!doctype html><html><head><title>Checkout QR set</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 24px; }
        .grid { display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
        .item { break-inside: avoid; text-align: center; }
        img { max-width: 220px; width: 100%; }
        strong { display: block; margin-top: 8px; }
      </style></head><body><div class="grid">
      ${qrGallery
        .map(
          (item) =>
            `<div class="item"><img src="${item.dataUrl}" alt=""><strong>Room ${
              item.roomNumber || "-"
            } - ${item.label}</strong></div>`,
        )
        .join("")}
      </div><script>window.onload = () => window.print();</script></body></html>`);
    popup.document.close();
  }

  return (
    <section className="module-page checkout-page">
      <div className="module-title">
        <div>
          <h1>Checkout</h1>
          <p>Guest key checkout events and room readiness.</p>
        </div>
        <div className="button-row">
          {canManage&&<button type="button" className="primary" onClick={openTodayCheckouts}>
            <CalendarCheck size={15} />
            Checkout Today
          </button>}
          <button type="button" onClick={() => void reload()}>
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
      </div>

      {notice && <div className={notice.includes("Could not") ? "notice error" : "notice"}>{notice}</div>}

      {todayModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="checkout-today-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-today-title" onKeyDown={event=>{if(event.key==='Escape')setTodayModalOpen(false);if(event.key==='Tab'){const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}}}>
            <button className="modal-close" type="button" aria-label="Close" autoFocus onClick={() => setTodayModalOpen(false)}><X size={16} /></button>
            <h2 id="checkout-today-title">Check-outs today</h2>
            <p>Select every room expected to check out on {overview?.todayDate}.</p>
            <div className="checkout-today-room-grid">
              {activeRooms.map((room) => {
                const selected = todayRoomIds.has(room.id);
                return <button key={room.id} type="button" className={selected ? "selected" : ""}
                  disabled={["checkout_received","ready_for_cleaning","cleaning"].includes(room.status)} title={["checkout_received","ready_for_cleaning","cleaning"].includes(room.status)?"Already checked out. Complete or correct its cleaning on the board.":undefined}
                  aria-pressed={selected} onClick={() => setTodayRoomIds((current) => {
                    const next = new Set(current); selected ? next.delete(room.id) : next.add(room.id); return next;
                  })}>{room.number}</button>;
              })}
            </div>
            <div className="button-row checkout-today-actions">
              <button type="button" onClick={() => setTodayModalOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={() => void saveTodayCheckouts()}>Save</button>
            </div>
          </section>
        </div>
      )}

      <CheckoutWorkflow overview={overview} canManage={canManage} onCheckout={checkoutManually} onRefresh={reload}/>
      {canManage&&<details className="checkout-management"><summary>Manage rooms, QR codes and checkout settings</summary>
      <div className="segmented-control compact" role="tablist" aria-label="Checkout views">
        <button className={tab === "board" ? "active" : ""} type="button" onClick={() => setTab("board")}>
          Board
        </button>
        <button className={tab === "settings" ? "active" : ""} type="button" onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "board" ? (
        <div className="checkout-grid">
          <section className="panel">
            <div className="section-heading">
              <h2>Rooms</h2>
              <span>{rooms.length}</span>
            </div>
            <div className="checkout-filters">
              {filters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={filter === item.id ? "active" : ""}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="room-list">
              {rooms.map((room) => (
                <article className="room-row" key={room.id}>
                  <div>
                    <strong>Room {room.number}</strong>
                    <span>{room.name || roomStatusLabel(room.status)}</span>
                  </div>
                  <span className={`room-status ${room.status}`}>{roomStatusLabel(room.status)}</span>
                  <span>{formatTime(room.lastCheckoutAt)}</span>
                  <span>{room.lastCheckoutSource?.toUpperCase() || "-"}</span>
                  <div className="row-actions">
                    <button type="button" onClick={() => checkoutManually(room)}>
                      Manual
                    </button>
                    <select
                      aria-label={"Occupancy for room " + room.number}
                      disabled={["checkout_received","ready_for_cleaning","cleaning"].includes(room.status)}
                      value={room.status}
                      onChange={(event) => saveRoomStatus(room, event.target.value as RoomStatus)}
                    >
                      <option value="occupied">Occupied</option>
                      {!["occupied", "unknown"].includes(room.status) && <option value={room.status}>{roomStatusLabel(room.status)}</option>}
                      <option value="unknown">Unknown</option>
                    </select>
                  </div>
                </article>
              ))}
              {rooms.length === 0 && <p className="empty-state">No rooms match this filter.</p>}
            </div>
          </section>

          <RecentEvents events={overview?.events || []} rooms={overview?.rooms || []} />
        </div>
      ) : (
        <div className="checkout-grid">
          <section className="panel">
            <div className="section-heading">
              <h2>Rooms</h2>
            </div>
            <div className="settings-form">
              <div className="settings-split">
                <label>
                  <span>Room number</span>
                  <input value={roomNumber} onChange={(event) => setRoomNumber(event.target.value)} />
                </label>
                <label>
                  <span>Name</span>
                  <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
                </label>
                <label>
                  <span>Código de acceso (caja/puerta)</span>
                  <input
                    type="text"
                    value={roomAccessCode}
                    onChange={(event) => setRoomAccessCode(event.target.value)}
                  />
                </label>
              </div>
              <button type="button" onClick={addRoom} disabled={!roomNumber.trim()}>
                <Plus size={15} />
                Create room
              </button>
              <label>
                <span>Bulk room numbers</span>
                <textarea
                  value={bulkRoomNumbers}
                  onChange={(event) => setBulkRoomNumbers(event.target.value)}
                  placeholder={"101, 102, 103\n104\n105"}
                  rows={5}
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={createQrForBulkRooms}
                  onChange={(event) => setCreateQrForBulkRooms(event.target.checked)}
                />
                <span>Create QR for each room</span>
              </label>
              <button type="button" onClick={addRoomsBulk} disabled={!bulkRoomNumbers.trim()}>
                <Plus size={15} />
                Create rooms in bulk
              </button>
              <div className="settings-table">
                {activeRooms.map((room) => (
                  <div key={room.id}>
                    <strong>Room {room.number}</strong>
                    <span>{room.name || "-"}</span>
                    <label>
                      <span>Código de acceso (caja/puerta)</span>
                      <input
                        type="text"
                        defaultValue={room.accessCode ?? ""}
                        onBlur={(event) => {
                          if (event.target.value !== (room.accessCode ?? "")) {
                            void saveRoomAccessCode(room, event.target.value).catch((error) =>
                              setNotice(error instanceof Error ? error.message : "Could not update room."),
                            );
                          }
                        }}
                      />
                    </label>
                    <span>{roomStatusLabel(room.status)}</span>
                    <button type="button" onClick={() => deactivateRoom(room)}>
                      Deactivate
                    </button>
                    <button type="button" onClick={() => removeRoom(room)}>
                      <Trash2 size={14} />
                      Delete room
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="section-heading">
              <h2>Keys</h2>
            </div>
            <div className="settings-form">
              <div className="settings-split">
                <label>
                  <span>Room</span>
                  <select value={selectedRoomId} onChange={(event) => setSelectedRoomId(event.target.value)}>
                    <option value={ALL_ROOMS}>All rooms</option>
                    {activeRooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        Room {room.number}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Label</span>
                  <input value={keyLabel} onChange={(event) => setKeyLabel(event.target.value)} />
                </label>
              </div>
              <div className="settings-split">
                <label>
                  <span>QR text</span>
                  <select value={qrTextMode} onChange={(event) => setQrTextMode(event.target.value as QrTextMode)}>
                    {qrTextModes.map((mode) => (
                      <option key={mode.id} value={mode.id}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedRoomId === ALL_ROOMS && (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={regenerateExisting}
                      onChange={(event) => setRegenerateExisting(event.target.checked)}
                    />
                    <span>Regenerate existing QR keys</span>
                  </label>
                )}
              </div>
              <button type="button" onClick={createKey} disabled={!selectedRoomId || activeRooms.length === 0}>
                <KeyRound size={15} />
                {selectedRoomId === ALL_ROOMS ? "Generate QR set" : "Create QR key"}
              </button>
              <div className="settings-table">
                {keys.map((key) => {
                  const room = activeRooms.find((item) => item.id === key.roomId);
                  return (
                    <div key={key.id}>
                      <strong>{key.label}</strong>
                      <span>Room {room?.number || "-"}</span>
                      <span>{key.active ? "Active" : "Inactive"}</span>
                      <button type="button" onClick={() => regenerate(key)}>
                        Regenerate
                      </button>
                      <button type="button" onClick={() => toggleKey(key)}>
                        {key.active ? "Deactivate" : "Activate"}
                      </button>
                      <button type="button" onClick={() => removeKey(key, room)}>
                        <Trash2 size={14} />
                        Delete
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="section-heading">
              <h2>Public checkout</h2>
              <QrCode size={17} />
            </div>
            <div className="settings-form">
              <label>
                <span>Public URL</span>
                <input readOnly value={overview?.publicUrl || ""} />
              </label>
              {overview?.publicQrDataUrl && (
                <img className="qr-preview" src={overview.publicQrDataUrl} alt="Public checkout QR" />
              )}
              <strong>Enabled</strong>
            </div>
          </section>

          <section className="panel">
            <div className="section-heading">
              <h2>QR preview</h2>
            </div>
            <div className="settings-form">
              {qrPreview ? (
                <>
                  <img className="qr-preview" src={qrPreview.dataUrl} alt={`${qrPreview.label} QR`} />
                  {qrPreview.checkoutUrl && (
                    <label>
                      <span>Direct URL</span>
                      <input readOnly value={qrPreview.checkoutUrl} />
                    </label>
                  )}
                  <div className="button-row">
                    <button type="button" onClick={() => downloadQr()}>
                      <Download size={15} />
                      Download PNG
                    </button>
                    {qrGallery.length > 1 && (
                      <button type="button" onClick={printGallery}>
                        <Printer size={15} />
                        Print all
                      </button>
                    )}
                  </div>
                  {qrGallery.length > 1 && (
                    <div className="qr-gallery">
                      {qrGallery.map((item) => (
                        <div key={item.filename}>
                          <img src={item.dataUrl} alt={`${item.label} room ${item.roomNumber || ""} QR`} />
                          <strong>Room {item.roomNumber || "-"}</strong>
                          <span>{item.label}</span>
                          <button type="button" onClick={() => downloadQr(item)}>
                            <Download size={14} />
                            Download
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="empty-state">Create or regenerate a key to preview its printable QR.</p>
              )}
            </div>
          </section>
        </div>
      )}
      </details>}
    </section>
  );
}

function RecentEvents({ events, rooms }: { events: CheckoutEvent[]; rooms: Room[] }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Recent activity</h2>
      </div>
      <div className="activity-list">
        {events.slice(0, 20).map((event) => {
          const room = rooms.find((item) => item.id === event.roomId);
          return (
            <div key={event.id}>
              <span>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <strong>Room {room?.number || "-"}</strong>
              <span>Checkout via {event.status==="reversed"?"Reversed":event.source.toUpperCase()}</span>
            </div>
          );
        })}
        {events.length === 0 && <p className="empty-state">No checkout activity yet.</p>}
      </div>
    </section>
  );
}
