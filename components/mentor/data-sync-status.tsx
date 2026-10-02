import type { OperationResults } from "@/lib/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type DataSync = NonNullable<OperationResults["bootstrap"]["dataSync"]>;
type Props = { mode: "demo" | "live"; dataSync?: DataSync };

const syncDateFormat = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Australia/Sydney",
  timeZoneName: "short",
});

function SyncTime({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return <span>Time unavailable</span>;
  return <time dateTime={date.toISOString()}>{syncDateFormat.format(date)}</time>;
}

function RefreshTimes({ dataSync }: { dataSync: DataSync }) {
  return <dl className="data-sync-times flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
    <div className="flex flex-wrap gap-x-2"><dt>Last updated</dt><dd><SyncTime value={dataSync.lastSyncedAt} /></dd></div>
    <div className="flex flex-wrap gap-x-2"><dt>Next refresh</dt><dd><SyncTime value={dataSync.nextSyncAt} /></dd></div>
  </dl>;
}

/** Describes the server's cached snapshot. Rendering never initiates a refresh. */
export function DataSyncStatus({ mode, dataSync }: Props) {
  if (mode !== "live" || !dataSync) return null;
  if (dataSync.stale) {
    return <Alert className="data-sync-warning mb-6" role="status" aria-atomic="true">
      <AlertTitle>Showing last-known data</AlertTitle>
      <AlertDescription><RefreshTimes dataSync={dataSync} /></AlertDescription>
    </Alert>;
  }
  return <footer className="data-sync-footer" role="status" aria-label="Data refresh status" aria-atomic="true"><RefreshTimes dataSync={dataSync} /></footer>;
}
