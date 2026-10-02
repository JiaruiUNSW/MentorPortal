# Dedicated Authentik USSO provider

This directory provisions only the Mentor Portal OIDC application on the existing Authentik instance reached through `ubuntu_Blog_new`. The inspected instance runs `ghcr.io/goauthentik/server:2026.5.3`; its official administrative entrypoint is `sudo docker exec -i authentik-server-1 ak shell`. No browser token or existing application's client secret is used.

## Reviewed configuration

| Setting | Value |
| --- | --- |
| Application slug / provider name | `mentor-portal` / `Mentor Portal` |
| Public Portal origin | `https://mentor-portal.com` |
| Issuer | `https://login.jiarui.academy/application/o/mentor-portal/` |
| Callback | `https://mentor-portal.com/api/auth/usso/callback`, strict match, one authorization callback |
| Client / grant | Confidential; only `authorization_code` |
| Token authentication | Portal uses `client_secret_basic`; discovery must advertise it |
| PKCE / signature | S256 / RS256 |
| Subject / issuer modes | `user_uuid` / `per_provider` |
| Scope mappings | Only the managed default `openid`, `profile`, `email` mappings |
| Authentication | Existing `default-authentication-flow`, preserving its LDAP/MFA stages |
| Consent | Existing `default-provider-authorization-explicit-consent` |
| Invalidation | Existing `default-provider-invalidation-flow` |
| Signing key | Existing RSA certificate `35403c72-9006-4f5e-969c-d3692862d478`, verified before creation |
| Application tile | Initially hidden while Portal activation is completed separately |

`provision-authentik.py` runs an atomic Django transaction protected by a provider-specific PostgreSQL advisory lock. It creates the provider and application together, validates the signing key and exact scope mappings, and refuses unexpected same-slug/same-name objects. A rerun verifies the exact previously created objects and private credential record; it does not rotate secrets or update other applications. Authentik 2026.5.3's optional nullable encryption/backchannel keys have `blank=False`; these two intentionally unset fields are excluded from `full_clean` only after their nullable state is checked.

## Provision on the edge host

Place `provision-edge.sh` and `provision-authentik.py` together in a root-owned directory on `ubuntu_Blog_new`, then run the wrapper as root:

```sh
sudo bash /root/mentor-portal-usso/provision-edge.sh --apply
```

The wrapper uses the official `ak shell` administrative surface. It prints only fixed diagnostic fields and reviewed public configuration. Credentials are generated with `secrets`, never placed in command arguments, and stored in:

- Host: `/root/mentor-portal-usso/client-credentials.json` — directory `0700`, file `0600`, owner root.
- Container staging: `/run/mentor-portal-usso/client-credentials.json` — the same private permissions.

The JSON contains this provider's own `client_id` and `client_secret`, its object IDs, fixed issuer/callback and an ownership marker. Keep it out of the checkout, status reports, terminal output and logs. If an operation fails after private-file persistence but before database commit, the next run refuses the mismatch; inspect the bounded target state instead of deleting or overwriting the credential record blindly.

For the source Portal configuration, transfer the private file only through a controlled authenticated SSH/SFTP stream or approved secret store into a private destination, then merge values without printing them. The provisioning script does not transfer credentials to `service-manager` or change the Portal environment. Do not run `cat` on this file in a shared terminal or tool output, and do not use IssueMesh credentials.

## Verify public metadata

```sh
python3 deploy/usso/verify-discovery.py
```

If the operator machine's Python CA store is unavailable or incomplete, the same public script can run on the edge host with its normal system trust store:

```sh
ssh ubuntu_Blog_new 'python3 -' < deploy/usso/verify-discovery.py
```

The verifier requires HTTPS certificate and hostname validation, refuses redirects, limits response size, checks the exact issuer, same-origin endpoints, S256, RS256, Basic client authentication, three scopes and public RSA JWKS. It never sends credentials or mints a token.

Authentik 2026.5.3's discovery document advertises installation-wide `grant_types_supported`. That list can include refresh, implicit, client credentials and password grants even though this provider's native `grant_types` is exactly `['authorization_code']`. The installed authorize and token handlers check the provider-specific list before granting access; assess the native setting together with discovery, not the advertised global list alone.

## Enable in Mentor Portal separately

After the reviewed application build is deployed and the dedicated credentials have been transferred privately, configure:

```dotenv
APP_ORIGIN=https://mentor-portal.com
MENTOR_USSO_ENABLED=true
MENTOR_USSO_ISSUER=https://login.jiarui.academy/application/o/mentor-portal/
MENTOR_USSO_CLIENT_ID=<this provider's private client_id>
MENTOR_USSO_CLIENT_SECRET=<this provider's private client_secret>
```

Use the exact callback above. Do not request `offline_access`; the provider has no corresponding scope mapping or refresh-token grant. Reverse-proxy access logs must omit callback query strings, and application logs must not include codes, state, ID/access tokens or secrets. This provisioning step does not deploy or restart Mentor Portal.

Users keep their existing Portal accounts and password login. They sign in once with their Portal password, choose **Link USSO** in **Your account** (or **Account access** for administrators), then authenticate through USSO. The callback requires the original Portal session and creates an explicit issuer/subject-to-account mapping. Directory membership or a matching email alone never grants Portal access; SharePoint `User.ID` and the account role remain unchanged.

## Manual disable / rollback

1. Set `MENTOR_USSO_ENABLED=false` in the Portal's private runtime configuration and recreate only the web service through its normal reviewed deployment procedure.
2. Verify that password login still works and new USSO starts are disabled. Existing Portal sessions keep their normal local lifetime/revocation behavior; changing the flag does not revoke every session.
3. Retain the dedicated Authentik objects, private credentials and Portal mapping rows for audit and recovery. If removing the newly created IdP application/provider is required later, verify their recorded IDs first and remove only those objects through Authentik administration. Do not delete the shared RSA key, default flows, LDAP sources, users, global settings or any IssueMesh object.

Public provider creation/discovery verification does not prove a completed user login or account link. Those remain separate interactive checks after Portal activation.

Primary reference: [Authentik OAuth 2.0 provider documentation](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/).
