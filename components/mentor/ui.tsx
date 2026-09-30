"use client";
import { AlertCircle, Check, Minus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
export function ErrorNotice({ error, retry }: { error: Error | null; retry?: () => void }) {
  if (!error) return null;
  return <Alert variant="destructive"><AlertCircle /><AlertTitle>Something needs attention</AlertTitle><AlertDescription>{error.message}{retry ? <Button variant="outline" onClick={retry}>Try again</Button> : null}</AlertDescription></Alert>;
}
export function SuccessNotice({ children }: { children: React.ReactNode }) { return <Alert role="status"><Check /><AlertTitle>Saved</AlertTitle><AlertDescription>{children}</AlertDescription></Alert>; }
export function LoadingState({ label = "Loading your portal…" }: { label?: string }) {
  return <div className="loading-state" role="status" aria-label={label}><span className="sr-only">{label}</span><Skeleton className="h-7 w-48" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>;
}
export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) { return <Empty><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{children}</EmptyDescription></EmptyHeader></Empty>; }
export function PageHeader({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) { return <header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{children}</header>; }
export function StatusMark({ complete = false, children, dot = false }: { complete?: boolean; children: React.ReactNode; dot?: boolean }) { return <span className="status-text"><span className={cn("status-mark", complete && "is-complete", dot && "is-dot")} aria-hidden="true">{dot ? null : complete ? <Check /> : <Minus />}</span>{children}</span>; }
export function Initials({ name }: { name: string }) { const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(n => n[0]).join(""); return <Avatar size="lg"><AvatarFallback>{initials}</AvatarFallback></Avatar>; }
export function dateLabel(value?: string | null) { if (!value) return "—"; const date = new Date(value.length === 10 ? `${value}T12:00:00` : value); return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" }).format(date); }
export function humanize(value: string) { return value.replaceAll("_", " ").replace(/^./, s => s.toUpperCase()); }
