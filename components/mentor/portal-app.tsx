"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { mentorRequest } from "./api";
import { LoginForm } from "./auth-form";
import { GroupsView, type ReportSelection } from "./groups";
import { useResource } from "./hooks";
import { navigation, PortalShell, type View } from "./shell";
import { useSession } from "./session";
import { ErrorNotice, LoadingState } from "./ui";
import { ReportDialog, ReportsView } from "./reports";
import { BalanceView, StoreView, TransactionsView } from "./credits";
import { ProfileView } from "./profile";
import { SupportView } from "./support";
import { WebMcpBridge } from "./webmcp";
export function PortalApp() {
  const { session, loading, error, refresh } = useSession();
  if (loading) return <div className="auth-page"><div className="auth-surface"><Link className="portal-brand" href="/">Mentor Portal</Link><LoadingState /></div></div>;
  if (error) return <div className="auth-page"><div className="auth-surface"><ErrorNotice error={error} retry={refresh} /></div></div>;
  if (!session?.user) return <LoginForm />;
  if (session.user.role === "admin") return <div className="auth-page"><div className="auth-surface"><h1>Account administration</h1><p className="auth-intro">Manage invitations and portal access.</p><Button asChild><Link href="/manage">Manage accounts</Link></Button></div></div>;
  return <SignedInPortal />;
}
function SignedInPortal() {
  const [active, setActive] = useState<View>("groups");
  const [report, setReport] = useState<ReportSelection | null>(null);
  const [revision, setRevision] = useState(0);
  const load = useCallback(() => mentorRequest("bootstrap", {}), []);
  const resource = useResource(load);
  useEffect(() => {
    const sync = () => { const id = window.location.hash.slice(1); if (navigation.some(item => item.id === id)) setActive(id as View); };
    sync(); window.addEventListener("hashchange", sync); return () => window.removeEventListener("hashchange", sync);
  }, []);
  const navigate = useCallback((view: View) => { setActive(view); window.history.pushState(null, "", `#${view}`); }, []);
  return <PortalShell active={active} navigate={navigate}><WebMcpBridge active={active} navigate={navigate} />{resource.loading && !resource.data ? <LoadingState /> : resource.error && !resource.data ? <ErrorNotice error={resource.error} retry={resource.reload} /> : resource.data ? <>{active === "groups" ? <GroupsView groups={resource.data.groups} onReport={setReport} revision={revision} /> : active === "reports" ? <ReportsView groups={resource.data.groups} onReport={setReport} revision={revision} /> : active === "balance" ? <BalanceView /> : active === "transactions" ? <TransactionsView /> : active === "store" ? <StoreView /> : active === "profile" ? <ProfileView /> : <SupportView />}<ReportDialog selection={report} close={() => setReport(null)} onSaved={() => { setRevision(value => value + 1); void resource.reload(); }} /></> : null}</PortalShell>;
}
