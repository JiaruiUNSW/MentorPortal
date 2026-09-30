# Mentor Portal implementation contract

Scope follows the current published Power Apps v548 source inventory at ../outputs/mentor-scope-20260930/feature-inventory.json. Seven Mentor modules only. App-owned invitation accounts are an explicit user requirement; do not replace them with Entra or ChatGPT login. The initial hosted release is owner-private, with isolated, clearly labelled synthetic preview data. Public availability and live SharePoint bridge activation are separate reviewable steps.

## Shared backend boundaries

- Runtime helpers: lib/runtime.ts exports getBindings(), getRawDb(), getPortalMode() and Principal. Missing PORTAL_MODE defaults to live (fail closed), never to a working demo that could conceal an integration error.
- Authentication worker exports requireSession(request: Request): Promise<Principal> and requireAdmin(request: Request): Promise<Principal> from lib/auth.ts. Cookie sessions are independent of Power Apps. Mutation origin/CSRF protection is required.
- Client data API: POST /api/mentor with {operation, payload, idempotencyKey?}. Browser cannot supply actor/userId, target URL, list or arbitrary query. Server authenticates first and constructs the bridge envelope.
- Flow envelope: {schemaVersion:'1.0', requestId, operation, actor:{userId:principal.mentorUserId,portalAccountId:principal.accountId}, payload, idempotencyKey?}. Server-only X-Mentor-Bridge-Key; each flow revalidates current User.Valid/IsRead and record ownership.
- Flow/data response: {schemaVersion:'1.0', requestId, ok, data?, error?:{code,message,retryable}, replayed?}. Read lists use {items,nextCursor}; group detail {group,mentees,reports,expenses,tasks}; profile {profile,choices}; reward {reward,options}.
- Auth JSON: {user:Principal|null, mode:'demo'|'live', csrfToken?:string}; unauthenticated requests return 401. Auth worker documents exact input/response details in AUTH-CONTRACT.md promptly.
- Demo state must persist in D1, uploaded bytes in R2. No in-memory or localStorage source of truth. Demo operations must never call real Flow URLs. Live mode must reject unconfigured endpoints rather than silently succeeding or using fixtures.
- Data worker owns db/mentor-schema.ts and auth worker owns db/auth-schema.ts. Main agent owns db/schema.ts to re-export both and generates migrations after schema work lands. Every raw D1 prepare() receives one statement; batches coordinate multiple statements.
- No credentials, SAS URLs, real personal data, or exported production packages in this Site repository. Source evidence remains outside the Site checkout.

## Work ownership

- Frontend worker: app UI pages, app/layout.tsx, app/globals.css, components/mentor/**, public/favicon.svg. Preserve installed shared UI primitives.
- Authentication worker: lib/auth.ts, lib/auth/**, db/auth-schema.ts, app/api/auth/**, app/api/admin/**, AUTH-CONTRACT.md, focused authentication tests.
- Data worker: lib/contracts.ts, lib/flow-bridge.ts, lib/mentor-data/**, db/mentor-schema.ts, app/api/mentor/**, app/api/files/** and focused data tests.
- Main agent: setup, manifest, runtime helper, schema composition/migrations, shared integration, security review, browser QA and private hosting.
- Flow worker: external staging folder outputs/mentor-web-build/power-automate; main integrates only sanitized contracts/templates.

The user explicitly requested multi-agent implementation. This instruction takes precedence over the Sites skill's default preference to delegate only assets/research. Only the main agent operates Site registration, source publishing, runtime secrets and deployment.
