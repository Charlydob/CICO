import { KeyRound, UserPlus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { APP_NAME } from "../config/app";
import { acceptInvitation, getInvitation } from "../services/backendApi";
import type { UserInvitation } from "../types/tenant";
import { useAuth } from "./AuthContext";

function tokenFromPath() {
  return decodeURIComponent(window.location.pathname.replace(/^\/accept-invite\//, ""));
}

export function AcceptInvitePage() {
  const { refreshSession, selectTenant } = useAuth();
  const [invitation, setInvitation] = useState<UserInvitation>();
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const token = tokenFromPath();

  useEffect(() => {
    void getInvitation(token)
      .then(setInvitation)
      .catch((error) =>
        setNotice(error instanceof Error ? error.message : "Invitation could not be loaded."),
      );
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!invitation || invitation.status !== "pending") {
      return;
    }

    setBusy(true);
    setNotice("");
    try {
      if (!password) {
        throw new Error("Enter a password to continue.");
      }

      const result = await acceptInvitation(token, invitation.email, password);
      await refreshSession();
      await selectTenant(result.tenantId);
      window.location.assign(
        result.tenantSlug ? `/t/${encodeURIComponent(result.tenantSlug)}/dashboard` : "/",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not accept invitation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-heading">
          <UserPlus size={28} />
          <div>
            <h1>{APP_NAME}</h1>
            <p>Accept your hotel invitation.</p>
          </div>
        </div>

        {invitation && (
          <div className="invite-summary">
            <span>{invitation.tenantName || invitation.tenantId}</span>
            <strong>{invitation.email}</strong>
            <span>{invitation.role==="tenant_admin"?"Hotel owner":invitation.role==="manager"?"Manager":"Staff"}</span>
          </div>
        )}

        {!notice&&!invitation&&<p role="status">Loading invitation…</p>}
        {(notice || (invitation&&invitation.status !== "pending")) && (
          <div className="notice error">
            {notice || `This invitation is ${invitation?.status}.`}
          </div>
        )}

        {invitation?.status === "pending" && (
          <label>
            <span>Password</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <small>Use your CICO password if you already have an account, or choose a new password of at least eight characters.</small>
          </label>
        )}

        <button
          className="primary-button"
          type="submit"
          disabled={busy || !invitation || invitation.status !== "pending"}
        >
          <KeyRound size={16} />
          Accept invitation
        </button>
      </form>
    </main>
  );
}
