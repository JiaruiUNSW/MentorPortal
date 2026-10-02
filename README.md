# Mentor Portal

An independent **Node.js 24 + Next.js** service for My Groups, Reports, Balance, Transactions, Credit Store, My Profile and Support. Mentors sign in with invitation-based portal accounts; a ChatGPT account or GPT Sites session is not required.

Production runs two Docker services: `web` serves the application and `sync` collects SharePoint data through the configured server-side HTTP bridge. Both use the `portal-data` volume: SQLite for accounts, sessions and cached records, plus a private filesystem bucket for files. Neither storage directory is publicly served.

See [DEPLOYMENT.md](DEPLOYMENT.md) for installation, account migration, HTTPS, backups and rollback. The public domain is **not yet selected**. This repository does not assert that deployment or broad external access is complete.

## Data and access

| Data | Background refresh |
| --- | --- |
| Private: profile, groups, report/expense history, credit, personalized ranking, transactions, tickets and reward-request history | Every 24 hours |
| Catalog: Credit Store rewards and options | Every 48 hours |
| Maximum usable snapshot age | 72 hours from its last successful synchronization |

Intervals run from a successful snapshot, not a fixed midnight schedule. The worker checks for due work every 30 seconds. With `MENTOR_CACHE_ENABLED=true`, ordinary page-data reads use local SQLite snapshots and **never start upstream HTTP requests**. Keep this setting enabled: disabling it selects the retained legacy synchronous read path. There is no page-triggered synchronization button.

Snapshots are isolated by portal account, SharePoint `User.ID` and namespace; catalog data is also identity-scoped. A failed refresh retains the complete last-good snapshot, with a stale notice, until the hard age limit. A definitive source authorization failure purges both snapshots for that identity and denies access. Cold or hard-expired data returns an explicit unavailable state rather than fetching synchronously or falling back to demo data.

Live business writes are **disabled by default**. If explicitly enabled after review, writes still use real-time source authorization and version/idempotency checks, then schedule a background cache refresh. A successful write acknowledgement can precede its appearance in cached history. Attachment downloads also retain their live authorization path; attachment bytes are not preloaded into the page cache.

The initial live pilot requires `MENTOR_SYNC_ALLOWED_USER_IDS`. An empty list admits no Mentor account. IDs must also be approved by the upstream Flow: adding an ID locally does not open source access. Existing source adapters are limited to approved IDs; this is not a general opening for every external mentor.

## Accounts

Accounts are independent email/password invitations, with server-owned Mentor ID mappings, revocable sessions and origin/CSRF checks. Passwords retain standard salted **PBKDF2-HMAC-SHA256 with 600,000 iterations**. Account administrators can invite or revoke access but cannot act as Mentors through the data API.

For a new installation, first-administrator setup requires a private `SETUP_TOKEN` of at least 32 characters; remove it after setup. Existing-account migration preserves reviewed password hashes, imports no sessions, and rejects outstanding invitations. No invitation email is sent automatically. Details: [account API](AUTH-CONTRACT.md) and [migration procedure](DEPLOYMENT.md#existing-account-migration).

## Local development

Use **Node 24** and the checked-in lockfile. For a new local demo checkout, put these non-production settings in a private `.env.local`:

```dotenv
PORTAL_MODE=demo
APP_ORIGIN=http://127.0.0.1:3000
DATA_DIR=./data
```

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. `Explore preview` is available only when the backend confirms demo mode. Demo records are synthetic, persistent and isolated from SharePoint. A missing mode defaults to live.

```sh
npm run typecheck
npm test
npm run build
```

`build` produces Next's standalone output and the `standalone-dist` synchronization/import bundles. Migrations in `drizzle/` are applied and checksum-checked at Node startup; do not edit an applied migration.

The synchronization scripts are `npm run sync:once` and `npm run sync:worker`. They require runtime variables in their process environment. To load a private environment file safely with Node 24:

```sh
npm run sync:build
node --env-file=.env.production --run sync:once
node --env-file=.env.production --run sync:worker
```

Run either the long-running worker or an isolated one-shot check as appropriate. A one-shot check processes due accounts; it is not an unconditional force refresh. Inspect its outcome and synchronized count.

For an explicit operator refresh, pass `--force` together with `--once`. Credit-criteria text uses the existing Canvas v548 presentation rules when the source omits it; those labels never calculate or award credits.

## Production configuration

Copy [`.env.example`](.env.example) to a private `.env.production` with mode `0600`, then supply the approved ID scope and bridge credentials privately. Defaults are live mode, cache enabled, and live writes disabled. The Compose file binds port `3100` to **127.0.0.1 only** and loads `.env.production` through `env_file`.

Before public access, configure an exact HTTPS `APP_ORIGIN`. Only set `TRUST_PROXY=true` behind an isolated proxy that overwrites `X-Real-IP`; direct public access to the backend must remain blocked. Keep signed Flow URLs, bridge keys, account exports, SQLite files, cached personal records and private objects out of this public repository and all public assets.

`GET /api/health` checks the web process's database access. It does not prove that upstream synchronization or source permissions are healthy; also inspect `sync` logs and authenticated data freshness.

## Compatibility and reference

The source retains the legacy Worker adapter, tests and `build:legacy-worker` / `dev:legacy-worker` scripts for compatibility. The Node production path uses neither Sites hosting nor Cloudflare D1/R2 services: `instrumentation.ts` installs the SQLite/filesystem adapters.

- [Browser/data contract](DATA-CONTRACT.md)
- [Standalone storage behavior](lib/standalone/README.md)
- [Cache, scheduling and isolation details](lib/mentor-cache/README.md)

Public source should contain only application code, templates and synthetic fixtures. Production data and private migration material belong outside the repository.
