import { useEffect, useState } from "react";
import {
  getHousekeepingBoard,
  performHousekeepingAction,
  setTodayCheckoutRooms,
  type HousekeepingBoard,
  type HousekeepingRoomItem,
} from "../../services/backendApi";
import type { CheckoutOverview, Room } from "../../types/checkout";
export function CheckoutWorkflow({
  overview,
  canManage,
  onCheckout,
  onRefresh,
}: {
  overview?: CheckoutOverview;
  canManage: boolean;
  onCheckout: (room: Room) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [board, setBoard] = useState<HousekeepingBoard>(),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function load() {
    setBoard(await getHousekeepingBoard());
  }
  useEffect(() => {
    let active = true;
    const refresh = () =>
      getHousekeepingBoard()
        .then((b) => {
          if (active) setBoard(b);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [overview]);
  async function act(
    room: HousekeepingRoomItem,
    action:
      | "bed_done"
      | "cleaning_done"
      | "complete"
      | "undo_bed"
      | "undo_cleaning"
      | "reopen"
      | "undo_checkout",
  ) {
    const correction =
      action === "undo_checkout" ||
      action === "reopen" ||
      Boolean(room.housekeeping.completedAt);
    if (
      correction &&
      !window.confirm(
        action === "undo_checkout"
          ? "Undo this checkout? The room returns to pending checkout; its history is kept."
          : "Reopen this completed cleaning? Other employees may be affected.",
      )
    )
      return;
    setBusy(room.eventId);
    setError("");
    try {
      const r = await performHousekeepingAction({
        eventId: room.eventId,
        action,
        confirmed: correction,
      });
      setBoard(r.board);
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function remove(roomId: string) {
    if (!overview) return;
    setBusy(roomId);
    try {
      await setTodayCheckoutRooms(
        overview.rooms
          .filter(
            (r) =>
              r.checkoutDueDate?.slice(0, 10) === overview.todayDate &&
              r.id !== roomId,
          )
          .map((r) => r.id),
      );
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const pending = (overview?.rooms || []).filter(
    (r) =>
      r.active &&
      r.checkoutDueDate?.slice(0, 10) === overview?.todayDate &&
      !["ready_for_cleaning", "cleaning"].includes(r.status),
  );
  function taskRoom(room: HousekeepingRoomItem, done = false) {
    return (
      <article key={room.eventId} className="workflow-room">
        <header>
          <strong>{room.roomNumber}</strong>
          <span>
            {room.housekeeping.assignedTo?.displayName || "Not assigned"}
          </span>
        </header>
        <div className="task-checks">
          <button
            aria-pressed={Boolean(room.housekeeping.bedDoneAt)}
            disabled={Boolean(busy) || (done && !canManage)}
            onClick={() =>
              void act(
                room,
                room.housekeeping.bedDoneAt ? "undo_bed" : "bed_done",
              )
            }
          >
            {room.housekeeping.bedDoneAt ? "✓ " : ""}Bed completed
          </button>
          <button
            aria-pressed={Boolean(room.housekeeping.cleaningDoneAt)}
            disabled={Boolean(busy) || (done && !canManage)}
            onClick={() =>
              void act(
                room,
                room.housekeeping.cleaningDoneAt
                  ? "undo_cleaning"
                  : "cleaning_done",
              )
            }
          >
            {room.housekeeping.cleaningDoneAt ? "✓ " : ""}Cleaning completed
          </button>
        </div>
        {done ? (
          canManage && (
            <button
              disabled={Boolean(busy)}
              onClick={() => void act(room, "reopen")}
            >
              Reopen cleaning
            </button>
          )
        ) : (
          <button
            className="primary"
            disabled={
              Boolean(busy) ||
              !room.housekeeping.bedDoneAt ||
              !room.housekeeping.cleaningDoneAt
            }
            onClick={() => void act(room, "complete")}
          >
            Confirm cleaning
          </button>
        )}
        {canManage && (
          <button
            className="quiet-button"
            disabled={Boolean(busy)}
            onClick={() => void act(room, "undo_checkout")}
          >
            Undo checkout
          </button>
        )}
      </article>
    );
  }
  return (
    <>
      <div className="workflow-help">
        <strong>Expected departure is not a completed checkout.</strong>
        <span>
          PMS: Not connected · Select departures manually with Checkout Today.
        </span>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="checkout-workflow">
        <section className="workflow-column">
          <h2>
            Pending checkout <span>{pending.length}</span>
          </h2>
          {pending.map((room) => (
            <article className="workflow-room" key={room.id}>
              <header>
                <strong>{room.number}</strong>
                <span>Expected today</span>
              </header>
              {canManage && (
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={Boolean(busy)}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          "Mark room " + room.number + " as checked out?",
                        )
                      )
                        return;
                      setBusy(room.id);
                      try {
                        await onCheckout(room);
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy("");
                      }
                    }}
                  >
                    Mark as checked out
                  </button>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() => void remove(room.id)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </article>
          ))}
          {!pending.length && (
            <p className="empty-state">No departures waiting.</p>
          )}
        </section>
        <section className="workflow-column">
          <h2>
            Pending cleaning <span>{board?.items.length || 0}</span>
          </h2>
          {!board ? <p>Loading rooms…</p> : board.items.map((r) => taskRoom(r))}
          {board && !board.items.length && (
            <p className="empty-state">No rooms waiting for cleaning.</p>
          )}
        </section>
        <section className="workflow-column">
          <h2>
            Ready <span>{board?.done.length || 0}</span>
          </h2>
          {board?.done.map((r) => taskRoom(r, true))}
          {board && !board.done.length && (
            <p className="empty-state">No rooms completed today.</p>
          )}
        </section>
      </div>
    </>
  );
}
