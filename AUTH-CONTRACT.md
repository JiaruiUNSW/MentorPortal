# Invitation account API

These are app-owned accounts. The first release runs in owner-private `demo` mode. Demo accounts and invitations cannot authenticate in `live` mode. No endpoint sends email or contacts SharePoint.

## Browser integration

Call `GET /api/auth/session` on startup with same-origin credentials. An authenticated response is `200 {user: Principal, mode, csrfToken}`. An unauthenticated response is `401 {user:null, mode, csrfToken, error:{code:"UNAUTHENTICATED",message}}`; the CSRF token is still usable for login, demo login, activation and setup. A storage/configuration failure is `503`, not an unauthenticated/demo fallback.

Session responses also include `readOnly:boolean` and `redeemEnabled:boolean`. `readOnly` follows the global live-write switch; `redeemEnabled` is an independent maintenance capability and is false only when `MENTOR_REDEEM_ENABLED=false`. A redemption requires both an editable session and `redeemEnabled !== false`. Unset/true retains the existing behavior, including compatibility with an older response that omits the field. Refresh the session or page after changing runtime settings; the server always enforces the current setting before accepting a redemption.

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

Session lifetime is 7 days for Mentors and 12 hours for administrators. Passwords, invitation tokens and session tokens are never stored in plaintext. Password hashing uses standard PBKDF2-HMAC-SHA256, 600,000 iterations, a fresh 192-bit salt and 256-bit result. WebCrypto is preferred; only its explicit hosted-Workers iteration-limit error uses the same standard algorithm from pinned `@noble/hashes`. The existing stored-hash format and work factor remain unchanged. Other cryptographic failures are not downgraded or retried with weaker parameters. D1 holds password hashes and SHA-256 invitation/session token hashes. Rate limits are persistent D1 counters for source IP and, for login, normalized email; no in-memory limit is treated as an authorization boundary. The source IP comes only from Cloudflare's generated header when request runtime metadata is present; untrusted forwarding headers are ignored.

Verification: `npm test` runs local Workers and a real D1 implementation using the generated production migrations. The hosted iteration-limit suite injects the production native error only in its test Worker and independently checks the hash against Node PBKDF2. Tests need permission to bind a local loopback listener. The suite does not contact the hosted site, send mail or create real invitations. After deployment, a login with a random nonexistent synthetic identity exercises password computation without creating an account or session; expect `401 INVALID_CREDENTIALS`, with only normal rate-limit counter updates. Runtime diagnostic logs contain fixed codes and numeric KDF parameters, not raw errors or credentials.

## USSO redirect sign-in

The existing portal-password routes and stored password hashes remain available. USSO uses a dedicated Authentik OIDC application and its own client secret. It never creates accounts, links identities by email, changes Mentor mappings, or imports directory roles. A verified `(issuer, sub)` is explicitly linked to an existing portal `accountId`; all permissions and SharePoint `User.ID` values still come from `auth_accounts`.

Session JSON additionally contains `usso: {enabled:boolean, linked:boolean}`. No provider secret, subject, token or internal endpoint is included. The login page shows **Sign in with USSO** only when configured in live mode. An authenticated Mentor links from the existing **Your account** dialog; administrators link from **Account access**. An unmapped identity is instructed to sign in once with its portal password and link from the authenticated account.

| Route | Input | Success |
| --- | --- | --- |
| `POST /api/auth/usso/start` | `{intent:"login"|"link"}` with ordinary Origin and CSRF headers | `200 {authorizationUrl}`; browser navigates to this server-generated URL. Linking additionally requires an authenticated portal session. |
| `GET /api/auth/usso/callback` | Provider's query-mode authorization response | `303` to `/` for Mentors or `/manage` for administrators, with a new ordinary portal session cookie. Linking adds only `?usso=linked`. |

Register the exact callback `https://mentor-portal.com/api/auth/usso/callback` for the dedicated Mentor provider. The server always derives the callback from configured `APP_ORIGIN` plus this fixed path. There is no client-selected redirect, return URL or issuer.

Runtime settings are `MENTOR_USSO_ENABLED=true`, `MENTOR_USSO_ISSUER`, `MENTOR_USSO_CLIENT_ID` and the secret `MENTOR_USSO_CLIENT_SECRET`. The intended issuer is `https://login.jiarui.academy/application/o/mentor-portal/`. Configure a confidential client with `client_secret_basic`, Authorization Code, PKCE S256, query response mode, and an RSA signing key issuing **RS256** ID tokens. Scopes are only `openid profile email`. Discovery must return the exact issuer, S256 and RS256 support; authorization, token and JWKS endpoints must be HTTPS on that issuer's origin. Do not reuse another application's client secret.

Each authorization attempt gets a random state, nonce and PKCE verifier. SQLite retains a ten-minute transaction; state and its browser cookie are hashed, and the transient nonce/verifier are deleted when the matching callback is consumed. The separate transaction cookie is HttpOnly, Secure and SameSite=Lax (with an isolated loopback development name). A `DELETE ... RETURNING` claim makes the callback single-use. Invalid callbacks cannot consume another browser's transaction or clear its active transaction cookie.

Linking binds the transaction to both the originating portal account and its exact session-token hash. The callback rechecks that session before and after the token exchange, and the mapping insert itself requires the active original session. Unique issuer/subject and issuer/account constraints prevent stealing or replacing another link. Authentik's login prompt is requested for linking. Unlinking or replacing mappings is outside this initial self-service flow.

The server exchanges the code with the stored PKCE verifier and validates state, nonce, issuer, audience, expiry and the RS256 signature using discovered JWKS. `openid-client` non-repudiation checks are explicitly enabled so direct TLS token exchange also performs signature validation. Access, refresh and ID tokens are neither stored nor sent to the frontend. Portal logout revokes the local session; it does not log users out of their other USSO applications.

Callback failures redirect only to `/login?usso=<fixed-result>` using `unmapped`, `link-conflict`, `link-session-expired`, `expired`, `unavailable` or `failed`. Provider errors, tokens, codes, state and arbitrary descriptions never enter that URL or application logs. Reverse-proxy access logs must omit callback query strings. `tests/auth.usso.test.ts` uses local synthetic accounts and a simulated provider with independent RSA signing and actual OIDC/JWKS validation; it makes no production requests.
