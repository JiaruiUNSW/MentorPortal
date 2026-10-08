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
import { DataSyncStatus } from "./data-sync-status";
import { createGroupDirectoryLoader, type GroupSelection } from "./group-directory";
import { AsyncJobsProvider, AsyncJobsSummary } from "./async-jobs";
export function PortalApp() {
  const { session, loading, error, refresh } = useSession();
  if (loading) return <div className="auth-page"><div className="auth-surface"><Link className="portal-brand" href="/">Mentor Portal</Link><LoadingState /></div></div>;
  if (error) return <div className="auth-page"><div className="auth-surface"><ErrorNotice error={error} retry={refresh} /></div></div>;
  if (!session?.user) return <LoginForm />;
  if (session.user.role === "admin") return <div className="auth-page"><div className="auth-surface"><h1>Account administration</h1><p className="auth-intro">Manage invitations and portal access.</p><Button asChild><Link href="/manage">Manage accounts</Link></Button></div></div>;
  return <SignedInPortal key={`${session.user.accountId}:${session.user.mentorUserId}:${session.mode}`} />;
}
function SignedInPortal() {
  const [active, setActive] = useState<View>("groups");
  const [report, setReport] = useState<ReportSelection | null>(null);
  const [revision, setRevision] = useState(0);
  const [groupSelection, setGroupSelection] = useState<GroupSelection>({ round: "", groupId: "" });
  const loadBootstrap = useCallback(() => mentorRequest("bootstrap", {}), []);
  const [loadGroups] = useState(() => createGroupDirectoryLoader(payload => mentorRequest("groups.list", payload)));
  const bootstrap = useResource(loadBootstrap);
  const directory = useResource(loadGroups);
  const reloadBootstrap = bootstrap.reload;
  const reloadDirectory = directory.reload;
  const onSaved = useCallback(() => {
    setRevision(value => value + 1);
    void Promise.all([reloadBootstrap(), reloadDirectory()]);
  }, [reloadBootstrap, reloadDirectory]);

  useEffect(() => {
    const sync = () => { const id = window.location.hash.slice(1); if (navigation.some(item => item.id === id)) setActive(id as View); };
    sync(); window.addEventListener("hashchange", sync); return () => window.removeEventListener("hashchange", sync);
  }, []);
  const navigate = useCallback((view: View) => { setActive(view); window.history.pushState(null, "", `#${view}`); }, []);

  let page: React.ReactNode;
  if (active === "groups" || active === "reports") {
    if (directory.error) page = <ErrorNotice error={directory.error} retry={directory.reload} />;
    else if (!directory.data) page = <LoadingState label="Loading your groups…" />;
    else if (active === "groups") page = <>
      {bootstrap.error ? <ErrorNotice error={bootstrap.error} retry={bootstrap.reload} /> : bootstrap.data?.dataSync?.stale ? <DataSyncStatus mode={bootstrap.data.mode} dataSync={bootstrap.data.dataSync} /> : null}
      <GroupsView groups={directory.data} selection={groupSelection} onSelectionChange={setGroupSelection} preferredGroupId={bootstrap.data?.groups[0]?.id} onReport={setReport} revision={revision} />
      {!bootstrap.error && bootstrap.data && !bootstrap.data.dataSync?.stale ? <DataSyncStatus mode={bootstrap.data.mode} dataSync={bootstrap.data.dataSync} /> : null}
    </>;
    else page = <ReportsView key={directory.data.map(group => group.id).sort().join(",")} groups={directory.data} onReport={setReport} revision={revision} />;
  } else if (active === "balance") page = <BalanceView />;
  else if (active === "transactions") page = <TransactionsView />;
  else if (active === "store") page = <StoreView />;
  else if (active === "profile") page = <ProfileView />;
  else page = <SupportView />;

  return <AsyncJobsProvider onSynced={onSaved}><PortalShell active={active} navigate={navigate}>
    <WebMcpBridge active={active} navigate={navigate} />
    <AsyncJobsSummary />
    {page}
    <ReportDialog selection={report} close={() => setReport(null)} onSaved={onSaved} />
  </PortalShell></AsyncJobsProvider>;
}
