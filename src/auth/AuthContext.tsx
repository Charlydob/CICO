import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  loginWithPassword,
  logoutSession,
  getAuthSession,
  setSelectedTenantId,
  setSelectedTenantSlug,
} from "../services/backendApi";
import type { AuthSession, UserProfile } from "../types/tenant";

interface AuthContextValue {
  user?: UserProfile;
  session?: AuthSession;
  activeTenantId?: string;
  loading: boolean;
  error: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectTenant: (tenantId?: string) => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function tenantSlugFromPath() {
  const match = window.location.pathname.match(/^\/t\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession>();
  const [activeTenantId, setActiveTenant] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sessionRequest = useRef(0);

  async function loadSession(explicitTenantId?: { value?: string }) {
    const requestId = ++sessionRequest.current;
    if (explicitTenantId) {
      setSelectedTenantId(explicitTenantId.value);
      setSelectedTenantSlug(undefined);
    } else {
      setSelectedTenantId(undefined);
      setSelectedTenantSlug(tenantSlugFromPath());
    }
    const next = await getAuthSession();
    if (requestId !== sessionRequest.current) return;
    const tenantId = next.activeTenantId || undefined;
    setSession(next);
    setError("");
    setActiveTenant(tenantId);
    setSelectedTenantId(tenantId);
    setSelectedTenantSlug(undefined);
  }

  async function refreshSession() {
    await loadSession();
  }

  useEffect(() => {
    void refreshSession()
      .catch(() => {
        setSession(undefined);
        setActiveTenant(undefined);
        setSelectedTenantId(undefined);
        setSelectedTenantSlug(undefined);
      })
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user,
      session,
      activeTenantId,
      loading,
      error,
      async login(email, password) {
        setError("");
        await loginWithPassword(email, password);
        await refreshSession();
      },
      async logout() {
        await logoutSession();
        setSession(undefined);
        setActiveTenant(undefined);
        setSelectedTenantId(undefined);
        setSelectedTenantSlug(undefined);
      },
      async selectTenant(tenantId) {
        const nextTenantId = tenantId || undefined;
        setSelectedTenantSlug(undefined);
        setSelectedTenantId(nextTenantId);
        setActiveTenant(nextTenantId);
        await loadSession({ value: nextTenantId });
      },
      refreshSession,
    }),
    [session, activeTenantId, loading, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return context;
}
