# Mentor Portal

Independent invitation-account web portal for the seven Mentor modules in published Power Apps v548: My Groups, Reports, Balance, Transactions, Credit Store, My Profile and Support. React/Vinext UI, Cloudflare Worker backend, D1 accounts/structured state, and R2 protected files.

## Delivery boundary

The initial hosted release is an owner-private **synthetic preview**. Preview saves persist in D1/R2 for that account and never invoke Microsoft services. No real Mentor records, credentials or exported application packages are shipped in this repository.

Live transport fails closed until reviewed Power Automate adapters are configured and activated. Flow review artifacts are in `../outputs/mentor-web-build/power-automate/`; they are stopped drafts, not a live integration. Approval/credit fulfillment, attachment concurrency, the service-only idempotency ledger and tenant connector behaviour need runtime validation before activation. See `DATA-CONTRACT.md` for exact limits.

## Local development

Use Node 22.13+ and the checked-in npm lockfile. The bundled Sites setup uses the portable profile on macOS.

```sh
npm run install:ci
npm run dev -- --hostname 127.0.0.1 --port 5173
npm run typecheck
npm test
```

Local `.env.local`: `PORTAL_MODE=demo` and `APP_ORIGIN=http://127.0.0.1:5173`. Missing mode defaults to live, never to a concealed demo fallback. `Explore preview` creates an isolated synthetic Mentor account. Real invitations use independent email/password credentials.

Schemas are `db/auth-schema.ts` and `db/mentor-schema.ts`, re-exported by `db/schema.ts`. `npm run db:generate` generates append-only Drizzle migrations. Apply each migration once locally with generated `dist/server/wrangler.json` and `.wrangler/state`; hosting applies production migrations separately. Never rewrite an applied migration.

## Accounts and permissions

See `AUTH-CONTRACT.md`. Passwords use salted PBKDF2-SHA256, sessions are persistent and revocable, and all POSTs enforce origin/CSRF. Only the server maps accounts to stable SharePoint Mentor User IDs. Minimal administrators invite/revoke accounts; they cannot impersonate a Mentor through the data API.

First administrator setup requires a random `SETUP_TOKEN` of at least 32 characters in runtime secrets. It is unnecessary for ordinary demo exploration. Remove it after bootstrap. No invitation emails are sent automatically; an administrator can copy an activation link. Public visitor access is not enabled by the initial private deployment.

## Data boundary

`POST /api/mentor` accepts a fixed operation enum, validated payload and optional idempotency key. Actor IDs, credentials, arbitrary URLs/lists/queries and roles are never browser-controlled. Retries retain their original idempotency key and request reference; uncertain live writes require reconciliation. Ordinary reads/saves are synchronous, while redemption acknowledgement is distinct from approval or fulfillment.

Live server configuration: `MENTOR_BRIDGE_KEY` plus `MENTOR_READ_URL`, `MENTOR_ATTENDANCE_URL`, `MENTOR_REPORT_URL`, `MENTOR_EXPENSE_URL`, `MENTOR_ATTACHMENT_URL`, `MENTOR_PROFILE_URL`, `MENTOR_REDEEM_URL`, `MENTOR_TICKET_URL`. Each adapter revalidates active Mentor access and record ownership. Never place these values in browser code or the hosting manifest.

## Publishing

Reuse the Site project ID and logical bindings in `.openai/hosting.json`. The main task owns registration, runtime secrets, source publishing and deployment. Keep this initial Site owner-private until visitor sharing and live-data activation have been reviewed. Signed URLs and original exported packages remain outside public assets and source control.
