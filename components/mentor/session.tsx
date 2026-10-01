"use client";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { authenticate, readSession, type Session } from "./api";
type SessionContextValue = { session: Session | null; loading: boolean; error: Error | null; refresh: () => Promise<void>; accept: (session: Session) => void; logout: () => Promise<void> };
const SessionContext = createContext<SessionContextValue | null>(null);
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try { setSession(await readSession()); } catch (e) { setError(e instanceof Error ? e : new Error("The portal is unavailable.")); } finally { setLoading(false); }
  }, []);
  useEffect(() => { let active = true; void readSession().then(value => { if (active) setSession(value); }).catch(error => { if (active) setError(error as Error); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  const logout = useCallback(async () => { const result = await authenticate("logout", {}); setSession(result); router.replace("/login"); }, [router]);
  return <SessionContext.Provider value={{ session, loading, error, refresh, accept: setSession, logout }}>{children}</SessionContext.Provider>;
}
export function useSession() { const context = useContext(SessionContext); if (!context) throw new Error("SessionProvider is required."); return context; }
export function useMentorReadOnly() { const { session } = useSession(); return session?.mode === 'live' && session.readOnly !== false; }
