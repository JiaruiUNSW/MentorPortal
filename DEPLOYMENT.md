# Standalone deployment

Target: the server reached through the SSH alias **`service-manager`**. This is a host alias, not a service-management integration. Repository: `git@github.com:JiaruiUNSW/MentorPortal.git`. **Public domain: to be confirmed.** These instructions describe the deployment procedure, not an already completed deployment.

Use Docker Engine with Compose v2. The image runs Node 24 as UID/GID `10001`; the web process and synchronization worker share the persistent `portal-data` volume. Commands below run from the server's repository checkout unless marked otherwise.

## 1. Source and private configuration

Once the reviewed source is available in the repository:

```sh
git clone git@github.com:JiaruiUNSW/MentorPortal.git
cd MentorPortal
umask 077
test -f .env.production || cp .env.example .env.production
chmod 600 .env.production
```

Edit `.env.production` privately. Never commit it or print resolved secret-bearing Compose configuration into shared logs.

| Setting | Initial configuration |
| --- | --- |
| `PORTAL_MODE` | `live` |
| `APP_ORIGIN` | `http://127.0.0.1:3100` for the pre-publication SSH-tunnel test |
| `PORTAL_HTTP_PORT` | `3100`; Compose binds only `127.0.0.1` |
| `TRUST_PROXY` | `false` for the tunnel test |
| `MENTOR_LIVE_WRITES_ENABLED` | `false` |
| `MENTOR_REDEEM_ENABLED` | Optional; `false` pauses new reward requests independently, unset/`true` preserves existing behavior |
| `MENTOR_ASYNC_WRITES_ENABLED` | `false` initially; explicit `true` allows opted-in attendance/report submissions to be durably accepted |
| `MENTOR_CACHE_ENABLED` | `true`; keep enabled for page reads to stay local |
| `MENTOR_CACHE_PRIVATE_TTL_HOURS` | `24` |
| `MENTOR_CACHE_CATALOG_TTL_HOURS` | `48` |
| `MENTOR_CACHE_MAX_STALE_HOURS` | `72`, absolute age since successful synchronization |
| `MENTOR_SYNC_ALLOWED_USER_IDS` | Required approved SharePoint `User.ID` list; blank means nobody is admitted |
| `MENTOR_BRIDGE_KEY`, `MENTOR_READ_URL` | Supply the approved bridge secret and signed read endpoint privately |
| `MENTOR_ATTACHMENT_URL` | Supply the reviewed attachment endpoint if live downloads are required |
| `PORTAL_IMAGE_TAG` | Prefer an immutable reviewed commit/release tag; defaults to `local` |

The server sets `DATA_DIR=/data` and `MIGRATIONS_DIR=/app/drizzle` inside both containers. Other operation-specific `MENTOR_*_URL` settings remain private and are needed only for the corresponding reviewed live paths. Do not enable live writes merely to test installation.

Do not disable `MENTOR_CACHE_ENABLED` for this deployment: `false` selects the retained legacy direct-HTTP read path.

After the corresponding live paths have been verified, ordinary editing can be enabled with `MENTOR_LIVE_WRITES_ENABLED=true` while keeping `MENTOR_REDEEM_ENABLED=false`. The redemption pause rejects new reward requests before creating a local write claim or calling a Flow. Reward browsing, request history, background status collection and already-running external approvals continue. The explicit pause also applies in demo mode; it does not change credit calculation or approval semantics. Deploy this code before setting the new flag, then recreate `web` with the updated private environment (a container restart alone does not apply changed Compose environment values). Refresh the browser session to update its displayed capability. Restoring the flag to `true` or removing it permits redemption only when the existing global live-write gate also permits it.

The local ID allowlist and upstream authorization must both admit the pilot. The current source Flow does not permit all external mentors. Do not replace that source check with a broad local allowlist.

## 2. Build

The image also bundles `standalone-dist/write-worker.mjs`. Compose service `writer` shares the existing private environment and `portal-data` volume, polls its durable queue every second, and is independent of the daily cache `sync` worker. Deploy `web`, `sync` and `writer` together before enabling async admission. Browser clients additionally send `Prefer: respond-async`; other clients retain the original synchronous contract. Keep redemption's separate activation setting unchanged.

Web post-response execution and `writer` have a 100-second Docker stop grace, allowing the current bounded attempt to finish. The writer stops taking new work on SIGTERM and closes SQLite after the current attempt settles. A forced termination can leave an uncertain source request; queue lease expiry does not authorize a new business POST. Turning the global write gate off pauses unstarted jobs, while disabling only async admission lets accepted work drain. Before an older release is restored, follow the backup/rollback instructions: stop all writers, verify no unresolved jobs, retain the exact applied migrations, and keep global writes off. Migration 0006 is additive and must not be removed from an image opening an already migrated database.

```sh
docker compose --env-file .env.production build web
```

The build runs `next build --webpack` and `scripts/build-sync.mjs`. The shared image includes `standalone-dist/sync-worker.mjs`, `standalone-dist/import-auth.mjs` and the migration directory. Runtime database migrations are automatic; startup refuses modified or missing already-applied migration files.

## Existing-account migration

For a migration from the old host, use a reviewed **private JSON export**, not a copy of the old sessions or personal-data cache. The importer is `scripts/import-auth.ts`, bundled as `standalone-dist/import-auth.mjs`. It requires:

- `schemaVersion: 1` and only `auth_accounts`, `auth_setup`, and optional `auth_invites` tables.
- Canonical live account rows with their original IDs, Mentor mappings and standard 600,000-iteration password hashes.
- Exactly one existing administrator and its `first-admin:live` setup record.
- Only accepted or revoked invitation records. Resolve all outstanding invitations before export; unused links are not migrated.

No sessions are imported; users sign in again. Repeating an identical import is safe, but conflicting destination records fail instead of being overwritten. Do not run first-administrator setup before importing an existing administrator. The repository supplies an importer, not a command that exports all source data indiscriminately.

Keep the export outside the checkout with mode `0600`. Set `PORTAL_AUTH_EXPORT` to its absolute private path. Stop both services for the account cutover, then feed the export into a disposable container's private tmpfs:

```sh
chmod 600 "${PORTAL_AUTH_EXPORT:?Set the private export path}"
docker compose --env-file .env.production stop sync web
docker compose --env-file .env.production run --rm --no-deps -T web \
  sh -c 'umask 077; cat > /tmp/account-export.private.json && node standalone-dist/import-auth.mjs /tmp/account-export.private.json --apply' \
  < "$PORTAL_AUTH_EXPORT"
```

This preserves hashes and uses the shared destination volume. The temporary file disappears with the disposable container. Check for `account_migration_complete` and `sessionsImported: 0`; retain the source export only in controlled private storage.

For a genuinely new installation instead, provide a random private `SETUP_TOKEN` of at least 32 characters, start the web service, and use `/setup`. Remove that token and recreate `web` after successful setup. Use `/manage` for invitations. Activation links are shared manually; no email is sent by these commands.

## 3. Start and test through the tunnel

```sh
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
curl --fail http://127.0.0.1:3100/api/health
docker compose --env-file .env.production logs --tail=100 sync
```

`sync` starts after `web` is healthy. A healthy `/api/health` proves database access, not successful Flow collection. The first data view can return `CACHE_PENDING` until an approved active Mentor account has a complete snapshot. Missing bridge configuration or authorization failures must be resolved on the server; visiting the page does not trigger a source fetch.

From your own computer, with the existing SSH alias configured:

```sh
ssh -N -L 3100:127.0.0.1:3100 service-manager
```

Open `http://127.0.0.1:3100` locally. Keep the browser URL and `APP_ORIGIN` identical for origin/CSRF validation. Test login, approved-account data, cache timestamps and default read-only behavior. The tunnel is the initial test path while the public domain is undecided.

## 4. HTTPS publication — domain pending

Before exposing a public endpoint:

1. Choose the actual domain and configure a TLS reverse proxy.
2. Set `APP_ORIGIN` to its exact HTTPS origin, with no path/query. Set `TRUST_PROXY=true` only for this trusted proxy arrangement.
3. Keep the backend isolated. The checked-in Compose binding must remain loopback-only.
4. Have the proxy **overwrite** `X-Real-IP` with the verified client address; never pass an arbitrary browser-supplied value through.

For a host-side Nginx proxy, the relevant location directives are:

```nginx
proxy_pass http://127.0.0.1:3100;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

These are forwarding directives, not a complete TLS/domain configuration. If another proxy is in front, configure its trusted-address handling explicitly. Do not trust arbitrary forwarded-header chains. After changing runtime configuration:

```sh
docker compose --env-file .env.production up -d --force-recreate
```

Recheck login and CSRF through the final HTTPS URL. Public DNS/TLS and visitor access are separate from a successful local health check.

## USSO through the dedicated Authentik provider

The confirmed USSO public origin is `https://mentor-portal.com`; its exact callback is `https://mentor-portal.com/api/auth/usso/callback`. The dedicated issuer is `https://login.jiarui.academy/application/o/mentor-portal/`. Follow [deploy/usso/README.md](deploy/usso/README.md) for the bounded provider setup, HTTPS metadata verification, private credential handoff and manual disable procedure. Creating the provider does not itself activate Portal login.

Keep `MENTOR_USSO_ENABLED=false` until the dedicated provider credentials are privately installed and the reviewed Portal build is ready. Enable only its own `MENTOR_USSO_CLIENT_ID` and `MENTOR_USSO_CLIENT_SECRET`, with `MENTOR_USSO_ISSUER` set to the exact issuer above and `APP_ORIGIN=https://mentor-portal.com`. Never reuse IssueMesh or another application's credentials. Keep callback query strings out of reverse-proxy access logs.

Existing Portal passwords and SharePoint User IDs remain unchanged. Users explicitly link USSO from their authenticated **Your account** dialog; administrators use **Account access**. A directory identity or matching email is not an automatic account-creation or access grant. To disable new USSO sign-ins, set `MENTOR_USSO_ENABLED=false` and recreate the web service; preserve the dedicated provider and account mappings until a separate removal decision.

## Synchronization and logs

The worker polls every 30 seconds: private snapshots refresh after 24 hours, catalog after 48 hours. Normal source failures retain last-good data and schedule a 15-minute retry. At 72 hours old, the snapshot cannot be served. A definitive source authorization failure purges both namespaces for that account/User.ID, regardless of age.

Page-data reads are local. Explicitly enabled writes still authorize against the source in real time; confirmed records become readable through the local cache while a complete refresh is queued for dependent summaries. An ambiguous result must be reconciled using its original request reference, not repeated under a new key.

After migration `0005_redemption_status_refresh.sql`, unresolved Portal redemptions have a separate five-minute background check. It uses only the existing redemption, balance and transaction read operations (plus bounded pagination), preserving the daily profile/group collection and 48-hour catalog cadence. Original snapshot source age and the 72-hour maximum age do not advance on these targeted checks. Full private refresh takes precedence; a missing or stale snapshot is recollected normally. Approved+debited, rejected+refunded and needs_review stop routine status polling. Errors keep last-good values and retry after 15 minutes; source authorization denial removes the account's snapshots. During a long pending approval this is normally up to 864 logical read RPCs per account per day, plus pagination; ordinary browser reads make no upstream calls.

Keep rollback images migration-compatible: once `0005` is applied, an image that lacks that exact migration file is refused by the storage adapter. Build a rollback image from the prior application code plus all applied migrations, and verify it on an isolated backup copy before a later status-refresh release.

When an owner recovers a needs_review redemption, queue or force one full **private** synchronization afterward using the helper rebuilt from the currently deployed source. The complete refresh discovers processing status and re-arms five-minute checks. Do not reuse an older bundled helper that omits `next_redemption_sync_at`; no new public/browser refresh endpoint is needed.

```sh
docker compose --env-file .env.production logs --tail=100 web sync
docker compose --env-file .env.production logs -f --tail=100 sync
```

Sync logs contain `mentor_sync_tick`, outcome, `accountsChecked`, `namespaceChecks`, synced counts and safe error codes. `partial` or `failed` needs investigation. A zero checked count does not prove that upstream access worked. The first collection may take time because source calls are paced. Private data and catalog snapshots commit independently, so a catalog failure does not discard a completed private refresh.

For an isolated operator one-shot, stop the scheduled worker, run the due work once, inspect the result, then restart it:

```sh
docker compose --env-file .env.production stop sync
docker compose --env-file .env.production run --rm --no-deps sync node standalone-dist/sync-worker.mjs --once
docker compose --env-file .env.production up -d sync
```

An operator can add `--force` to the one-shot command after correcting configuration or source access. It is accepted only with `--once`; scheduled runs always respect the refresh intervals.

For a non-Docker Node 24 installation, `npm run build` includes the synchronization bundles. The npm scripts are `sync:once` and `sync:worker`; load the private environment file without evaluating it as shell code:

```sh
node --env-file=.env.production --run sync:once
node --env-file=.env.production --run sync:worker
```

Both processes must point to the same `DATA_DIR` and migration directory. Do not run two independent schedulers deliberately; the lease prevents concurrent publication but is not a reason to duplicate workers.

## Backup and rollback

Back up the whole private data set, including `portal.sqlite` and `objects/`, and keep secrets/configuration in a separate private backup. **Do not copy only the main SQLite file while WAL writers are active.** Use SQLite's supported backup facilities with coordinated file storage, or stop both services and archive the entire volume:

```sh
umask 077
PORTAL_BACKUP_DIR="$HOME/.local/share/mentor-portal-backups"
mkdir -p "$PORTAL_BACKUP_DIR"
chmod 700 "$PORTAL_BACKUP_DIR"
PORTAL_BACKUP_FILE="$PORTAL_BACKUP_DIR/portal-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker compose --env-file .env.production stop sync web
docker compose --env-file .env.production run --rm --no-deps -T web tar -C /data -czf - . > "$PORTAL_BACKUP_FILE"
tar -tzf "$PORTAL_BACKUP_FILE" > /dev/null
docker compose --env-file .env.production up -d
```

Check command success and periodically restore a backup into a separate private test volume. Backups contain credentials and personal records; do not add them to this public repository or public storage.

Retain the previous image tag and a pre-upgrade backup. For a schema-compatible rollback, set `PORTAL_IMAGE_TAG` in `.env.production` to that retained tag, then:

```sh
docker compose --env-file .env.production up -d --no-build
```

Keep `portal-data`. **Do not use `docker compose down -v`.** If schema compatibility is uncertain or startup rejects the migration history, preserve the current volume and validate the matching backup in a separate volume before cutover; do not overwrite the only production copy.

The legacy Worker build/tests remain available in the source tree. They are not the production startup, migration or hosting path for this standalone deployment.
