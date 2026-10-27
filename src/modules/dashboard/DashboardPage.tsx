import {
  Bed,
  Bell,
  CheckCircle2,
  Clock,
  Copy,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  UserCheck,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useI18n } from "../../i18n";
import {
  BackendRequestError,
  generateTelegramStaffPairingCode,
  getBackendStatus,
  getCheckoutOverview,
  getDashboardSettings,
  getHousekeepingBoard,
  getHousekeepingStaff,
  getParkingDetections,
  manualHousekeepingCheckout,
  performHousekeepingAction,
  schedulePushTest,
  sendPushTest,
  type BackendStatus,
  type DashboardSettings,
  type DashboardWidgetSettings,
  type HousekeepingBoard,
  type HousekeepingRoomItem,
  type HousekeepingStaffMember,
} from "../../services/backendApi";
import {
  getCurrentBrowserSubscription,
  updateAppBadge,
} from "../../services/pushClient";
import type { CheckoutOverview } from "../../types/checkout";
import type { Detection } from "../../types/detection";
import type { ModuleId, TenantRole } from "../../types/modules";

type HousekeepingAction = "claim" | "bed_done" | "cleaning_done" | "complete" | "assign" | "undo_bed" | "undo_cleaning" | "reopen";
type RoomFilter = "all" | "unassigned" | "mine" | "inProgress" | "done";

const DEFAULT_WIDGETS: Record<TenantRole | "platform_admin", DashboardWidgetSettings> = {
  staff: {
    housekeeping: true, checkouts: true, reservations: false, parking: false,
    recentActivity: false, notifications: true, telegram: false, diagnostics: false,
  },
  manager: {
    housekeeping: true, checkouts: true, reservations: true, parking: true,
    recentActivity: true, notifications: true, telegram: false, diagnostics: false,
  },
  tenant_admin: {
    housekeeping: true, checkouts: true, reservations: true, parking: true,
    recentActivity: true, notifications: true, telegram: true, diagnostics: false,
  },
  platform_admin: {
    housekeeping: true, checkouts: true, reservations: true, parking: true,
    recentActivity: true, notifications: true, telegram: true, diagnostics: true,
  },
};

function isToday(value?: string | null): boolean {
  if (!value) return false;
  const date = new Date(value);
  const today = new Date();
  return date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
}

function roleCanUseHousekeeping(role?: TenantRole | "platform_admin"): boolean {
  return ["platform_admin", "tenant_admin", "manager", "staff"].includes(role || "");
}

function roleCanManageHousekeeping(role?: TenantRole | "platform_admin"): boolean {
  return ["platform_admin", "tenant_admin", "manager"].includes(role || "");
}

function roomAssignee(room: HousekeepingRoomItem) {
  return room.housekeeping.assignedTo?.displayName || "";
}

function selectedRoomFromBoard(board: HousekeepingBoard, current?: HousekeepingRoomItem) {
  if (!current) return undefined;
  return [...board.items, ...board.done].find((item) => item.eventId === current.eventId);
}

function actionError(error: unknown) {
  if (error instanceof BackendRequestError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Could not update.";
}

function optimisticBoard(
  board: HousekeepingBoard | undefined,
  eventId: string,
  action: HousekeepingAction,
  userId?: string,
  assignedTo?: HousekeepingStaffMember,
): HousekeepingBoard | undefined {
  if (!board) return board;
  const timestamp = new Date().toISOString();
  const mapRoom = (room: HousekeepingRoomItem): HousekeepingRoomItem => {
    if (room.eventId !== eventId) return room;
    const housekeeping = { ...room.housekeeping };
    if (action === "claim") {
      housekeeping.assignedTo = assignedTo ? {
        userId: assignedTo.userId,
        displayName: assignedTo.displayName,
        telegramUsername: assignedTo.telegramUsername,
        role: assignedTo.role,
      } : housekeeping.assignedTo;
      housekeeping.assignedAt = timestamp;
    }
    if (action === "assign" && assignedTo) {
      housekeeping.assignedTo = {
        userId: assignedTo.userId,
        displayName: assignedTo.displayName,
        telegramUsername: assignedTo.telegramUsername,
        role: assignedTo.role,
      };
      housekeeping.assignedAt = timestamp;
    }
    if (action === "bed_done" || action === "complete") housekeeping.bedDoneAt ||= timestamp;
    if (action === "cleaning_done" || action === "complete") housekeeping.cleaningDoneAt ||= timestamp;
    if (action === "complete") housekeeping.completedAt ||= timestamp;
    return { ...room, status: action === "claim" ? "cleaning" : room.status, housekeeping };
  };
  const items = board.items.map(mapRoom);
  const done = board.done.map(mapRoom);
  if (action === "complete") {
    const completed = items.find((room) => room.eventId === eventId);
    return {
      ...board,
      items: items.filter((room) => room.eventId !== eventId),
      done: completed ? [{ ...completed, status: "ready", cleanedTimestamp: timestamp }, ...done] : done,
    };
  }
  return { ...board, items, done };
}

export function DashboardPage({
  enabledModules,
  focusHousekeeping = false,
}: {
  enabledModules: Record<ModuleId, boolean>;
  focusHousekeeping?: boolean;
}) {
  const { user, session, activeTenantId } = useAuth();
  const { t } = useI18n();
  const [status, setStatus] = useState<BackendStatus>();
  const [checkout, setCheckout] = useState<CheckoutOverview>();
  const [detections, setDetections] = useState<Detection[]>([]);
  const [board, setBoard] = useState<HousekeepingBoard>();
  const [staff, setStaff] = useState<HousekeepingStaffMember[]>([]);
  const [widgets, setWidgets] = useState<DashboardSettings>();
  const [filter, setFilter] = useState<RoomFilter>(focusHousekeeping ? "all" : "all");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [detailRoom, setDetailRoom] = useState<HousekeepingRoomItem>();
  const [assignmentRoom, setAssignmentRoom] = useState<HousekeepingRoomItem>();
  const [manualOpen, setManualOpen] = useState(false);
  const [manualRoomId, setManualRoomId] = useState("");
  const [manualAssigneeUserId, setManualAssigneeUserId] = useState("");
  const [telegramPairing, setTelegramPairing] = useState<
    Awaited<ReturnType<typeof generateTelegramStaffPairingCode>> | undefined
  >();
  const [currentEndpoint, setCurrentEndpoint] = useState("");
  const [testDelay, setTestDelay] = useState(20);

  const activeTenantRole = useMemo(
    () =>
      session?.memberships.find((membership) => membership.tenantId === activeTenantId)?.role ||
      (session?.isPlatformAdmin && activeTenantId ? "platform_admin" : undefined),
    [activeTenantId, session?.isPlatformAdmin, session?.memberships],
  );
  const roleKey = (activeTenantRole || "staff") as TenantRole | "platform_admin";
  const canUseHousekeeping = enabledModules.checkout && roleCanUseHousekeeping(activeTenantRole);
  const canManageHousekeeping = roleCanManageHousekeeping(activeTenantRole);
  const visibleWidgets = widgets?.widgets?.[roleKey] || DEFAULT_WIDGETS[roleKey];
  const currentStaff = staff.find((member) => member.userId === user?.id);
  const assignableStaff = staff.filter((member) =>
    ["platform_admin", "tenant_admin", "manager", "staff"].includes(member.role),
  );

  const refreshHousekeeping = useCallback(async () => {
    if (!canUseHousekeeping) return;
    const [nextBoard, nextStaff] = await Promise.all([getHousekeepingBoard(), getHousekeepingStaff()]);
    setBoard(nextBoard);
    setStaff(nextStaff.members);
    setDetailRoom((current) => selectedRoomFromBoard(nextBoard, current));
    setAssignmentRoom((current) => selectedRoomFromBoard(nextBoard, current));
    await updateAppBadge(nextBoard.summary.total);
  }, [canUseHousekeeping]);

  useEffect(() => {
    void getDashboardSettings().then(setWidgets).catch(() => undefined);
    void getBackendStatus().then(setStatus).catch(() => undefined);
    if (enabledModules.parking) void getParkingDetections().then(setDetections).catch(() => undefined);
    if (enabledModules.checkout) void getCheckoutOverview().then(setCheckout).catch(() => undefined);
    void getCurrentBrowserSubscription().then((subscription) => setCurrentEndpoint(subscription?.endpoint || "")).catch(() => undefined);
  }, [enabledModules.checkout, enabledModules.parking]);

  useEffect(() => {
    void refreshHousekeeping().catch(() => undefined);
    if (!canUseHousekeeping) return undefined;
    const interval = window.setInterval(() => void refreshHousekeeping().catch(() => undefined), 10_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshHousekeeping().catch(() => undefined);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [canUseHousekeeping, refreshHousekeeping]);

  useEffect(() => {
    const roomNumber = new URLSearchParams(window.location.search).get("housekeepingRoom");
    if (!roomNumber || !board) return;
    const room = [...board.items, ...board.done].find((item) => item.roomNumber === roomNumber);
    if (!room) return;
    setDetailRoom(room);
    const url = new URL(window.location.href);
    url.searchParams.delete("housekeepingRoom");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [board]);

  const checkoutsToday = checkout?.events.filter((event) => event.status!=="reversed"&&isToday(event.timestamp)).length ?? 0;
  const waitingRooms = checkout?.rooms.filter((room) => room.status === "ready_for_cleaning").length ?? 0;
  const detectionsToday = detections.filter((detection) => isToday(detection.detectedAt)).length;
  const progressTotal = (board?.items.length || 0) + (board?.done.length || 0);
  const progressDone = board?.done.length || 0;
  const progressPercent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : 100;
  const averageCleaningMinutes = useMemo(() => {
    const durations = (board?.done || [])
      .map((room) => {
        const completed = new Date(room.housekeeping.completedAt || room.cleanedTimestamp || "").getTime();
        const checkoutAt = new Date(room.checkoutTimestamp || "").getTime();
        return Number.isFinite(completed) && Number.isFinite(checkoutAt) ? (completed - checkoutAt) / 60_000 : 0;
      })
      .filter((minutes) => minutes > 0 && minutes < 24 * 60);
    return durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0;
  }, [board?.done]);

  const roomsForList = useMemo(() => {
    const rooms = [...(board?.items || []), ...(filter === "done" || filter === "all" ? board?.done || [] : [])];
    return rooms.filter((room) => {
      if (filter === "unassigned") return !room.housekeeping.assignedTo;
      if (filter === "mine") return room.housekeeping.assignedTo?.userId === user?.id;
      if (filter === "inProgress") return room.status === "cleaning";
      if (filter === "done") return Boolean(room.housekeeping.completedAt || room.cleanedTimestamp);
      return true;
    });
  }, [board?.done, board?.items, filter, user?.id]);

  async function runRoomAction(room: HousekeepingRoomItem, action: HousekeepingAction, targetUserId?: string) {
    const correction=action==="reopen"||Boolean(room.housekeeping.completedAt);if(correction&&!window.confirm("Reopen this completed cleaning? Other employees may be affected."))return;
    const previous = board;
    const target = targetUserId ? staff.find((member) => member.userId === targetUserId) : currentStaff;
    setBoard((current) => optimisticBoard(current, room.eventId, action, user?.id, target));
    setBusy(`${action}-${room.eventId}`);
    setNotice("");
    try {
      const result = await performHousekeepingAction({
        action,confirmed:correction,
        eventId: room.eventId,
        assignmentTargetUserId: action === "assign" ? targetUserId : undefined,
      });
      setBoard(result.board);
      setDetailRoom((current) => selectedRoomFromBoard(result.board, current));
      setAssignmentRoom(undefined);
      await updateAppBadge(result.board.summary.total);
    } catch (error) {
      setBoard(previous);
      setNotice(actionError(error));
    } finally {
      setBusy("");
    }
  }

  async function handleAssignee(room: HousekeepingRoomItem) {
    if (!canManageHousekeeping) {
      if (!room.housekeeping.assignedTo) {
        await runRoomAction(room, "claim");
      }
      return;
    }
    setAssignmentRoom(room);
  }

  async function createManualCheckout() {
    if (!manualRoomId) return;
    setBusy("manual");
    setNotice("");
    try {
      await manualHousekeepingCheckout({
        roomId: manualRoomId,
        assignmentTargetUserId: manualAssigneeUserId || undefined,
      });
      setManualOpen(false);
      setManualRoomId("");
      setManualAssigneeUserId("");
      await refreshHousekeeping();
    } catch (error) {
      setNotice(actionError(error));
    } finally {
      setBusy("");
    }
  }

  async function createTelegramCode() {
    setBusy("telegram");
    setNotice("");
    try {
      setTelegramPairing(await generateTelegramStaffPairingCode());
    } catch (error) {
      setNotice(actionError(error));
    } finally {
      setBusy("");
    }
  }

  async function sendPushDiagnostic(scheduled: boolean) {
    if (!currentEndpoint) {
      setNotice("Activate this device first.");
      return;
    }
    setBusy(scheduled ? "push-schedule" : "push-test");
    try {
      if (scheduled) {
        await schedulePushTest(currentEndpoint, testDelay);
      } else {
        await sendPushTest(currentEndpoint);
      }
      setNotice(t("saved"));
    } catch (error) {
      setNotice(actionError(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className={`module-page dashboard-workspace ${focusHousekeeping ? "focus-housekeeping" : ""}`}>
      {notice && <div className="notice error">{notice}</div>}

      <div className="module-title compact-title">
        <div>
          <h1>{focusHousekeeping ? t("housekeeping") : t("today")}</h1>
          <p>{board?.tenant.name || (status?.reservationSource === "demo" ? "" : status?.reservationSource) || ""}</p>
        </div>
        <button type="button" className="icon-button" onClick={() => void refreshHousekeeping()} aria-label={t("refresh")}>
          <RefreshCw size={17} />
        </button>
      </div>

      <div className="platform-stats operational-grid">
        {enabledModules.checkout && visibleWidgets.housekeeping && (
          <button type="button" className="stat-item compact-kpi" onClick={() => setFilter("all")}>
            <Sparkles size={18} /><strong>{waitingRooms}</strong><span>{t("roomsToClean")}</span>
          </button>
        )}
        {enabledModules.checkout && visibleWidgets.checkouts && (
          <button type="button" className="stat-item compact-kpi" onClick={() => setManualOpen(canManageHousekeeping)}>
            <Clock size={18} /><strong>{checkoutsToday}</strong><span>{t("checkoutsToday")}</span>
          </button>
        )}
        {enabledModules.parking && visibleWidgets.parking && (
          <button type="button" className="stat-item compact-kpi">
            <span aria-hidden="true">P</span><strong>{detectionsToday}</strong><span>{t("parkingToday")}</span>
          </button>
        )}
        {visibleWidgets.reservations && status?.reservationSource && status.reservationSource !== "demo" && (
          <button type="button" className="stat-item compact-kpi">
            <span aria-hidden="true">R</span><strong>{status?.reservationsLoaded ?? 0}</strong><span>{t("currentReservations")}</span>
          </button>
        )}
      </div>

      {canUseHousekeeping && visibleWidgets.housekeeping && (
        <section className="panel housekeeping-panel mobile-primary-panel">
          <div className="section-heading housekeeping-heading">
            <div>
              <h2>{t("housekeeping")}</h2>
              <span>
                {board?.summary.waiting || 0} {t("pending")} - {board?.summary.cleaning || 0} {t("inProgress")} - {board?.summary.done || 0} {t("done")}
              </span>
            </div>
            <div className="button-row">
              {canManageHousekeeping && (
                <button type="button" className="icon-button small" onClick={() => setManualOpen(true)} aria-label={t("manualCheckout")}>
                  <Plus size={16} />
                </button>
              )}
            </div>
          </div>
          <div className="housekeeping-progress" aria-label={`${progressPercent}%`}>
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          {canManageHousekeeping && averageCleaningMinutes > 0 && (
            <div className="metric-strip">{t("averageCleaningToday")}: <strong>{averageCleaningMinutes} min</strong></div>
          )}
          <div className="chip-scroll">
            {([
              ["all", t("all")],
              ["unassigned", t("unassigned")],
              ["mine", t("mine")],
              ["inProgress", t("inProgress")],
              ["done", t("done")],
            ] as Array<[RoomFilter, string]>).map(([id, label]) => (
              <button key={id} type="button" className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="housekeeping-dense-list">
            {roomsForList.map((room) => (
              <article key={room.eventId} className={`hk-room-row ${room.housekeeping.completedAt ? "completed" : ""}`}>
                <button type="button" className="hk-room-main" onClick={() => setDetailRoom(room)}>
                  <strong>{room.roomNumber}</strong>
                  <span>{room.accessCode ? `${t("accessCode")} ${room.accessCode}` : room.roomName || t("details")}</span>
                </button>
                <button type="button" className="hk-assignee" onClick={() => void handleAssignee(room)}>
                  {room.housekeeping.assignedTo ? roomAssignee(room) : t("notAssigned")}
                </button>
                <div className="hk-inline-actions">
                  <button
                    type="button"
                    className={room.housekeeping.bedDoneAt ? "done" : ""}
                    aria-label={`${t("bed")} ${room.roomNumber}`}
                    aria-pressed={Boolean(room.housekeeping.bedDoneAt)}
                    disabled={Boolean(busy)||(Boolean(room.housekeeping.completedAt)&&!canManageHousekeeping)}
                    onClick={() => void runRoomAction(room, room.housekeeping.bedDoneAt?"undo_bed":"bed_done")}
                  >
                    <Bed size={16} />{room.housekeeping.bedDoneAt && <CheckCircle2 size={11} />}
                  </button>
                  <button
                    type="button"
                    className={room.housekeeping.cleaningDoneAt ? "done" : ""}
                    aria-label={`${t("cleaning")} ${room.roomNumber}`}
                    aria-pressed={Boolean(room.housekeeping.cleaningDoneAt)}
                    disabled={Boolean(busy)||(Boolean(room.housekeeping.completedAt)&&!canManageHousekeeping)}
                    onClick={() => void runRoomAction(room, room.housekeeping.cleaningDoneAt?"undo_cleaning":"cleaning_done")}
                  >
                    <Sparkles size={16} />{room.housekeeping.cleaningDoneAt && <CheckCircle2 size={11} />}
                  </button>
                  <button
                    type="button"
                    className="finish"
                    aria-label={`${room.housekeeping.completedAt?"Reopen cleaning":t("finish")} ${room.roomNumber}`}
                    disabled={Boolean(busy)||!room.housekeeping.bedDoneAt||!room.housekeeping.cleaningDoneAt||(Boolean(room.housekeeping.completedAt)&&!canManageHousekeeping)}
                    onClick={() => void runRoomAction(room, room.housekeeping.completedAt?"reopen":"complete")}
                  >
                    <CheckCircle2 size={17} />
                  </button>
                </div>
              </article>
            ))}
            {roomsForList.length === 0 && <p className="empty-state">{t("noRoomsPending")}</p>}
          </div>
        </section>
      )}

      {visibleWidgets.recentActivity && (
        <details className="panel collapsible-panel">
          <summary>{t("recentActivity")} <span>{checkout?.events.length || 0}</span></summary>
          <div className="activity-list">
            {(checkout?.events || []).slice(0, 8).map((event) => {
              const room = checkout?.rooms.find((item) => item.id === event.roomId);
              return (
                <div key={event.id}>
                  <span>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <strong>{t("room")} {room?.number || "-"}</strong>
                  <span>{event.status==="reversed"?"Reversed":event.source.toUpperCase()}</span>
                </div>
              );
            })}
            {(!checkout?.events || checkout.events.length === 0) && <p className="empty-state">No activity.</p>}
          </div>
        </details>
      )}

      {session?.isPlatformAdmin && (visibleWidgets.telegram || visibleWidgets.diagnostics) && (
        <details className="panel collapsible-panel">
          <summary>{t("secondaryTools")}</summary>
          <div className="settings-form">
            {visibleWidgets.telegram && (
              <div className="tool-block">
                <h3>Telegram</h3>
                {user?.telegramUserId ? (
                  <strong>Connected @{user.telegramUsername?.replace(/^@/, "") || user.telegramUserId}</strong>
                ) : (
                  <>
                    <button type="button" onClick={() => void createTelegramCode()} disabled={busy !== ""}>
                      <UserPlus size={15} /> Link Telegram
                    </button>
                    {telegramPairing && (
                      <div className="copy-field">
                        <code>/staff {telegramPairing.code}</code>
                        <button type="button" onClick={() => void navigator.clipboard.writeText(`/staff ${telegramPairing.code}`)}>
                          <Copy size={15} />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {visibleWidgets.diagnostics && (
              <div className="tool-block">
                <h3>Web Push diagnostics</h3>
                <div className="push-test-grid compact">
                  <button type="button" onClick={() => void sendPushDiagnostic(false)} disabled={busy !== ""}>
                    <Send size={16} /> Send test
                  </button>
                  <label>
                    <span>Delay</span>
                    <input type="number" min={5} max={600} value={testDelay} onChange={(event) => setTestDelay(Number(event.target.value))} />
                  </label>
                  <button type="button" onClick={() => void sendPushDiagnostic(true)} disabled={busy !== ""}>
                    <Bell size={16} /> Schedule
                  </button>
                </div>
              </div>
            )}
          </div>
        </details>
      )}

      {assignmentRoom && (
        <BottomSheet title={`${t("assignRoom")} ${assignmentRoom.roomNumber}`} onClose={() => setAssignmentRoom(undefined)}>
          <div className="staff-pick-list">
            {assignableStaff.map((member) => (
              <button
                key={member.userId}
                type="button"
                onClick={() => void runRoomAction(assignmentRoom, "assign", member.userId)}
              >
                <UserCheck size={16} />
                <span>{member.displayName}</span>
                <small>{member.role}</small>
              </button>
            ))}
          </div>
        </BottomSheet>
      )}

      {detailRoom && (
        <BottomSheet title={`${t("room")} ${detailRoom.roomNumber}`} onClose={() => setDetailRoom(undefined)}>
          <div className="housekeeping-detail-list">
            <span>{t("accessCode")}: <strong>{detailRoom.accessCode || "-"}</strong></span>
            <span>{t("checkout")}: <strong>{new Date(detailRoom.checkoutTimestamp).toLocaleString()}</strong></span>
            <span>{t("assigned")}: <strong>{roomAssignee(detailRoom) || t("notAssigned")}</strong></span>
            <span>{t("bed")}: <strong>{detailRoom.housekeeping.bedDoneAt ? new Date(detailRoom.housekeeping.bedDoneAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("pending")}</strong></span>
            <span>{t("cleaning")}: <strong>{detailRoom.housekeeping.cleaningDoneAt ? new Date(detailRoom.housekeeping.cleaningDoneAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("pending")}</strong></span>
            <span>{t("finish")}: <strong>{detailRoom.housekeeping.completedBy?.displayName || "-"}</strong></span>
          </div>
        </BottomSheet>
      )}

      {manualOpen && (
        <BottomSheet title={t("manualCheckout")} onClose={() => setManualOpen(false)}>
          <div className="manual-checkout-form">
            <label>
              <span>{t("room")}</span>
              <select value={manualRoomId} onChange={(event) => setManualRoomId(event.target.value)}>
                <option value="">-</option>
                {(board?.allRooms || []).map((room) => (
                  <option key={room.roomId} value={room.roomId}>{room.roomNumber} - {room.status}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("assigned")}</span>
              <select value={manualAssigneeUserId} onChange={(event) => setManualAssigneeUserId(event.target.value)}>
                <option value="">-</option>
                {assignableStaff.map((member) => (
                  <option key={member.userId} value={member.userId}>{member.displayName} - {member.role}</option>
                ))}
              </select>
            </label>
            <button type="button" className="primary-button" onClick={() => void createManualCheckout()} disabled={busy !== "" || !manualRoomId}>
              <Plus size={15} /> {t("manualCheckout")}
            </button>
          </div>
        </BottomSheet>
      )}
    </section>
  );
}

function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop housekeeping-sheet-backdrop" onClick={onClose}>
      <section className="housekeeping-sheet" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
        <div className="housekeeping-sheet-title">
          <h2>{title}</h2>
        </div>
        {children}
      </section>
    </div>
  );
}
