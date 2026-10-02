"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { startUsso } from "./api";
import { useSession } from "./session";
import { ErrorNotice, SuccessNotice } from "./ui";

function subscribeLocation(changed: () => void) {
  window.addEventListener("popstate", changed);
  return () => window.removeEventListener("popstate", changed);
}
function locationSearch() { return window.location.search; }
function serverSearch() { return ""; }

const messages: Record<string, string> = {
  unmapped: "This USSO identity is not linked to a portal account. Sign in once with your portal password, then choose Link USSO in Your account. Administrators can link from Account access.",
  "link-conflict": "This USSO identity or portal account is already linked. Sign in with your portal password and contact the portal administrator if you need to change the link.",
  "link-session-expired": "Your portal session changed or expired during linking. Sign in to the same portal account and start linking again.",
  expired: "This USSO sign-in request expired or was already used. Please start sign-in again.",
  unavailable: "USSO is temporarily unavailable. You can still sign in with your portal password.",
  failed: "USSO sign-in could not be verified. Please start again or use your portal password.",
};

export function UssoResultNotice() {
  const search = useSyncExternalStore(subscribeLocation, locationSearch, serverSearch);
  const result = new URLSearchParams(search).get("usso");
  const { session } = useSession();
  if (result === "linked" && session?.usso?.linked) return <SuccessNotice>USSO is now linked to your portal account. Your portal password still works.</SuccessNotice>;
  return result && Object.hasOwn(messages, result) ? <p className="form-hint" role="status">{messages[result]}</p> : null;
}

export function UssoAccountLink() {
  const { session } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (!session?.user || !session.usso?.enabled) return null;
  async function link() {
    setPending(true); setError(null);
    try { const result = await startUsso("link"); window.location.assign(result.authorizationUrl); }
    catch (cause) { setError(cause instanceof Error ? cause : new Error("USSO could not be opened.")); setPending(false); }
  }
  return <section className="form-stack" aria-label="USSO sign-in"><h2 className="form-heading">USSO sign-in</h2>{session.usso.linked ? <p className="form-hint">USSO is connected to this portal account. You can use USSO or your portal password to sign in.</p> : <><p className="form-hint">Link your USSO identity to {session.user.email}. You will be taken to USSO to sign in, then returned to this same portal account.</p><Button type="button" variant="outline" onClick={() => void link()} disabled={pending}>{pending ? "Opening USSO…" : "Link USSO"}</Button></>}<ErrorNotice error={error} /></section>;
}
