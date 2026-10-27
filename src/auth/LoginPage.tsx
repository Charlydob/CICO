import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { APP_NAME } from "../config/app";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const { login, error: sessionError } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy("login");
    setNotice("");
    try {
      await login(email, password);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-heading">
          <KeyRound size={28} />
          <div>
            <h1>{APP_NAME}</h1>
            <p>{t("loginSubtitle")}</p>
          </div>
        </div>
        {(notice || sessionError) && <div className="notice error">{notice || sessionError}</div>}
        <label>
          <span>{t("email")}</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          <span>{t("password")}</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="primary-button" type="submit" disabled={busy !== ""}>
          {t("signIn")}
        </button>
      </form>
    </main>
  );
}
