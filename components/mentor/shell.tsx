"use client";
import { useState } from "react";
import { ArrowRightLeft, CircleHelp, CreditCard, FileText, Menu, ShoppingCart, UserRound, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ErrorNotice, Initials } from "./ui";
import { useSession } from "./session";
export const navigation = [
  { id: "groups", label: "My Groups", icon: UsersRound }, { id: "reports", label: "Reports", icon: FileText },
  { id: "balance", label: "Balance", icon: CreditCard }, { id: "transactions", label: "Transactions", icon: ArrowRightLeft },
  { id: "store", label: "Credit Store", icon: ShoppingCart }, { id: "profile", label: "My Profile", icon: UserRound },
  { id: "support", label: "Support", icon: CircleHelp },
] as const;
export type View = (typeof navigation)[number]["id"];
function NavLinks({ active, navigate }: { active: View; navigate: (view: View) => void }) { return <nav aria-label="Main navigation" className="portal-nav">{navigation.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} className={cn("nav-link", active === id && "is-active")} aria-current={active === id ? "page" : undefined} onClick={e => { e.preventDefault(); navigate(id); }}><Icon aria-hidden="true" strokeWidth={1.8} /><span>{label}</span></a>)}</nav>; }
export function PortalShell({ active, navigate, children }: { active: View; navigate: (view: View) => void; children: React.ReactNode }) {
  const { session, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false); const [accountOpen, setAccountOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false); const [error, setError] = useState<Error | null>(null);
  const name = session?.user?.displayName || "Mentor"; const preview = session?.mode === "demo";
  const account = <button className="account-button" onClick={() => { setMenuOpen(false); setAccountOpen(true); }} aria-label={`Account for ${name}`}><Initials name={name} /><span><strong>{name}</strong><small>Mentor</small></span></button>;
  async function signOut() { setSigningOut(true); setError(null); try { await logout(); } catch (e) { setError(e as Error); setSigningOut(false); } }
  return <div className="portal-shell"><a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="desktop-sidebar"><a className="portal-brand" href="#groups" onClick={e => { e.preventDefault(); navigate("groups"); }}>Mentor Portal</a><NavLinks active={active} navigate={navigate} />{account}</aside>
    <header className="mobile-appbar"><Sheet open={menuOpen} onOpenChange={setMenuOpen}><SheetTrigger asChild><Button variant="ghost" size="icon-lg" aria-label="Open navigation"><Menu /></Button></SheetTrigger><SheetContent side="left" className="mobile-navigation"><SheetHeader><SheetTitle>Mentor Portal</SheetTitle><SheetDescription className="sr-only">Choose a page in your mentor portal.</SheetDescription></SheetHeader><NavLinks active={active} navigate={view => { navigate(view); setMenuOpen(false); }} />{account}</SheetContent></Sheet><a className="portal-brand" href="#groups" onClick={e => { e.preventDefault(); navigate("groups"); }}>Mentor Portal</a>{preview ? <span className="preview-label">Preview data</span> : null}</header>
    <main id="main-content" className="portal-main" tabIndex={-1}>{preview ? <span className="desktop-preview preview-label" title="All people and records in this preview are synthetic.">Preview data</span> : null}{children}</main>
    <Dialog open={accountOpen} onOpenChange={setAccountOpen}><DialogContent><DialogHeader><DialogTitle>Your account</DialogTitle><DialogDescription>{session?.user?.email}</DialogDescription></DialogHeader><p>Signed in as {name}.</p>{preview ? <p className="muted">This private preview uses synthetic people and records.</p> : null}<ErrorNotice error={error} /><div className="form-actions"><Button variant="outline" onClick={() => { setAccountOpen(false); navigate("profile"); }}>My Profile</Button><Button onClick={signOut} disabled={signingOut}>{signingOut ? "Signing out…" : "Sign out"}</Button></div></DialogContent></Dialog>
  </div>;
}
