# Invitation account API

These are app-owned accounts. The first release runs in owner-private `demo` mode. Demo accounts and invitations cannot authenticate in `live` mode. No endpoint sends email or contacts SharePoint.

## Browser integration

Call `GET /api/auth/session` on startup with same-origin credentials. An authenticated response is `200 {user: Principal, mode, csrfToken}`. An unauthenticated response is `401 {user:null, mode, csrfToken, error:{code:"UNAUTHENTICATED",message}}`; the CSRF token is still usable for login, demo login, activation and setup. A storage/configuration failure is `503`, not an unauthenticated/demo fallback.

Keep `csrfToken` in component memory. For **every POST**, including `/api/mentor` reads, send `Content-Type: application/json`, `X-CSRF-Token: <latest token>`, and `credentials: "same-origin"`. Browsers provide `Origin`; it must match the configured application origin. Never send tokens in query strings. A successful login, demo login, activation or setup replaces the session and returns a new token. Fetch session again after `403 CSRF_INVALID`.

`Principal` is `{accountId:string,email:string,displayName:string,mentorUserId:number,role:"mentor"|"admin",mode:"demo"|"live"}`. Administrator accounts have `mentorUserId:0`; their permission is limited to invitation/account administration. They do not represent a Mentor and must not access Mentor records. Normal account mapping comes only from a server-stored administrator invitation.

Session and pre-login CSRF cookies are HttpOnly, SameSite=Lax, Path=/ and Secure on HTTPS. Production uses `__Host-` cookie names and no Domain attribute. Only HTTP loopback development uses separately named cookies without Secure. No browser storage contains passwords or session credentials. All auth responses are `Cache-Control: no-store`.

## Routes

| Route | JSON input | Success |
| --- | --- | --- |
| `GET /api/auth/session` | None | Session JSON above; 401 also seeds a pre-login CSRF token. |
| `POST /api/auth/login` | `{email,password}` | `200 {user,mode,csrfToken}` and session cookie. |
| `POST /api/auth/demo` | `{}` | Demo mode only: `200 {user,mode:"demo",csrfToken}`. An isolated D1 account named **Alex Morgan** is created; an existing valid demo Mentor session is reused. |
| `POST /api/auth/activate` | `{token,password}` | `201 {user,mode,csrfToken}`. Single-use invitation determines email, display name, mode and Mentor ID. |
| `POST /api/auth/logout` | `{}` | `200 {user:null,mode,csrfToken}`; current session revoked and cookie removed. |
| `POST /api/auth/setup` | `{setupToken,email,displayName,password}` | `201 {user,mode,csrfToken}`; creates the first minimal administrator for the current mode. |
| `GET /api/admin/accounts` | None | `200 {items:[{accountId,email,displayName,mentorUserId,role,mode,status,createdAt}],nextCursor:null}`. Latest 100 accounts in current mode. |
| `POST /api/admin/accounts/revoke` | `{accountId}` | `200 {ok:true}`. Disables a Mentor account and revokes all its sessions. Administrator accounts cannot be revoked here. |
| `GET /api/admin/invites` | None | `200 {items:[{inviteId,email,displayName,mentorUserId,mode,createdAt,expiresAt,acceptedAt,revokedAt}],nextCursor:null}`. Latest 100 invitations in current mode. |
| `POST /api/admin/invites` | `{email,displayName,mentorUserId,expiresInHours?}` | `201 {invite:{inviteId,email,displayName,mentorUserId,mode,expiresAt},activationUrl}`. Default 72 hours; maximum 168 hours. All invited accounts have role Mentor. Reissuing revokes older unused invitations for that email in the current mode. |
| `POST /api/admin/invites/revoke` | `{inviteId}` | `200 {ok:true}`. Revokes an unused invitation. |

All administrator routes require an active admin session. Activation links use `/activate#token=<token>` so the invitation secret is excluded from HTTP requests and referrers. `/activate` reads the fragment, removes it with `history.replaceState`, then submits it in the JSON body. Show/copy the returned activation URL only to the administrator; it is returned once and is not retrievable later. Do not automatically navigate an administrator into the invitation link.

Passwords accept 12–128 Unicode characters, including spaces, and cannot be whitespace-only. Emails are trimmed/lowercased and limited to 254 characters; names are 1–100 trimmed characters. Unrecognized JSON fields are rejected, including `role`, `mode`, `accountId` and Mentor mapping supplied to normal login/activation.

Errors use `{error:{code,message},mode}`. `400 VALIDATION_ERROR` is invalid input, `401 INVALID_CREDENTIALS` is a deliberately generic failed login, `401 UNAUTHENTICATED` is absent/expired/revoked/wrong-mode session, `403 ORIGIN_INVALID` or `CSRF_INVALID` is a rejected mutation, `403 ADMIN_REQUIRED` is insufficient permission, `403 SETUP_DENIED` is an incorrect setup token, `404 DEMO_UNAVAILABLE` hides demo login in live mode, `404 ACCOUNT_NOT_FOUND`/`INVITE_NOT_FOUND` is an unavailable revocation target, `409 SETUP_COMPLETE` is already bootstrapped, `409 ACCOUNT_EXISTS` is an existing email/mapping, `410 INVITE_INVALID` covers expired/revoked/used/unknown invitations, `413 BODY_TOO_LARGE` rejects bodies over 8 KiB, `415 CONTENT_TYPE_REQUIRED` requires JSON, `429 RATE_LIMITED` includes `Retry-After`, and `503 AUTH_UNAVAILABLE` is a configuration/storage/runtime failure. Do not display raw exception text.

## Runtime and backend integration

Required runtime binding: `DB`. `PORTAL_MODE` must explicitly be `demo` to permit previews; any other value is live. `APP_ORIGIN` should contain the exact HTTPS application origin (scheme and host, no path). When omitted, the platform-provided request URL determines the allowed origin; forwarded/host headers are never used. HTTP is accepted only for loopback development.

Optional secret: `SETUP_TOKEN`, a random value of at least 32 characters. Without it the setup route is unavailable. Supply it only through deployment secrets, never source/config/logs; remove it after bootstrap. Each mode can bootstrap once, atomically. The initial demo deployment does not require this secret for ordinary demo access.

`lib/auth.ts` exports `requireSession(request):Promise<Principal>`, `requireAdmin(request):Promise<Principal>`, `requireMutationProtection(request):Promise<void>`, `AuthError` (with `status`, `code`, optional `retryAfter`) and `authErrorResponse(error):Response`. The data API must authenticate and then call mutation protection before any POST operation, even logical reads. Session lookup always rechecks D1 revocation, account status and current mode.

Session lifetime is 7 days for Mentors and 12 hours for administrators. Passwords, invitation tokens and session tokens are never stored in plaintext. Password hashing uses standard WebCrypto PBKDF2-HMAC-SHA256, 600,000 iterations, a fresh 192-bit salt and 256-bit result. D1 holds password hashes and SHA-256 invitation/session token hashes. Rate limits are persistent D1 counters for source IP and, for login, normalized email; no in-memory limit is treated as an authorization boundary. The source IP comes only from Cloudflare's generated header when request runtime metadata is present; untrusted forwarding headers are ignored.

Verification: `node --experimental-strip-types --test tests/auth.integration.test.ts` runs a local Worker and real D1 implementation using the generated production migrations. Tests need permission to bind a local loopback listener. The suite does not contact the hosted site, send mail or create real invitations.
