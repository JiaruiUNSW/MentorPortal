"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { authenticate } from "./api";
import { useSession } from "./session";
import { ErrorNotice, LoadingState } from "./ui";
export function LoginForm() {
  const router = useRouter();
  const { session, accept, loading, error, refresh } = useSession();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [pending, setPending] = useState<string | null>(null); const [formError, setFormError] = useState<Error | null>(null);
  async function signIn(kind: "login" | "demo") {
    setPending(kind); setFormError(null);
    try { const value = await authenticate(kind, kind === "demo" ? {} : { email, password }); accept(value); router.replace(value.user?.role === "admin" ? "/manage" : "/"); }
    catch (e) { setFormError(e as Error); setPending(null); }
  }
  return <div className="auth-page"><Link className="portal-brand auth-brand" href="/">Mentor Portal</Link><main className="auth-surface"><h1>Sign in</h1><p className="auth-intro">Access your groups, reports and mentor account.</p>{loading ? <LoadingState label="Connecting securely…" /> : error ? <ErrorNotice error={error} retry={refresh} /> : <form onSubmit={event => { event.preventDefault(); void signIn("login"); }}><FieldGroup><Field><FieldLabel htmlFor="email">Email address</FieldLabel><Input id="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} disabled={!!pending} /></Field><Field><FieldLabel htmlFor="password">Password</FieldLabel><Input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} disabled={!!pending} /></Field><ErrorNotice error={formError} /></FieldGroup><div className="form-actions"><Button type="submit" disabled={!!pending}>{pending === "login" ? "Signing in…" : "Sign in"}</Button>{session?.mode === "demo" ? <Button type="button" variant="outline" onClick={() => void signIn("demo")} disabled={!!pending}>{pending === "demo" ? "Opening preview…" : "Explore preview"}</Button> : null}</div></form>}<p className="auth-note">New here? Open the invitation link provided by your portal administrator.</p>{session?.mode === "demo" ? <p className="auth-note">Preview data is synthetic. Your changes are saved in this private preview.</p> : null}</main></div>;
}
