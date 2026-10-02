# Mentor Portal custom NPM route

This isolated route serves only `https://mentor-portal.com`, using the existing private upstream `http://172.30.253.1:13100` and existing certificate 29. The DNS proxy and USSO provider/application configuration are managed separately.

The route uses NPM's documented custom includes. `http_top.conf` receives only the Mentor log-format include; `http.conf` receives the server include **after existing hosts**. This NPM instance relies on implicit default-server ordering, so placing the Mentor server blocks at the top would change unmatched-host behavior. Existing shared include content is backed up and preserved, and generated NPM host files and its database are not modified.

The HTTP listener redirects to the literal canonical HTTPS host. Both servers have the exact apex `server_name`, with no wildcard/default-server flag. HTTPS references `/data/custom_ssl/npm-29/fullchain.pem` and its existing private-key path; no certificate private key is copied or printed. Official public Cloudflare Origin CA roots are included solely for chain and hostname verification.

The server-level trusted-address list contains only Cloudflare's published IPv4/IPv6 ranges. It overrides NPM's inherited trust in private networks. `CF-Connecting-IP` is accepted only from those trusted peers; direct requests cannot set their client IP through that header. Forwarded host, scheme and port are overwritten with canonical values; X-Real-IP, X-Forwarded-For and CF-Connecting-IP are overwritten with the resulting trusted socket/client IP. The original Forwarded header is removed. Proxy read/send timeouts are 110 seconds for the backend's 85-second write budget, and automatic upstream retries are disabled.

## Callback log handling

`mentor_portal_path` logs only time, client IP, method, normalized path, response/upstream status, sizes and timings. It never includes request queries, raw request lines, Referer or User-Agent. Nginx error messages cannot be formatted to redact query strings, so this dedicated vhost sends error output to `/dev/null` at `crit`; the exact `/api/auth/usso/callback` location repeats that policy explicitly. The safe access log remains available for HTTP/upstream failure diagnosis. The callback always receives `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, including error responses.

## Applying and verifying

The installer runs only on `ubuntu_Blog_new`, checks the existing data mount and certificate hostname/chain, refuses existing apex or partial Mentor routes, creates a root-only backup, preserves all generated host files, validates the complete Nginx configuration, and only then performs a graceful Nginx reload. It never restarts the NPM container. On syntax/reload failure it restores only bytes still matching its own write and preserves failed owned files in the backup.

Use `curl --cacert ... --resolve mentor-portal.com:443:127.0.0.1` **inside the NPM container** for origin checks. Do not use `-k`/`--insecure`; Cloudflare Origin CA is deliberately separate from public browser trust. Validate HTTP redirect, health, callback response headers, synthetic callback-query absence from logs, and rejection of forged client-IP headers. No real authorization code/state or user account is used in these checks.

Backups are under `/var/backups/mentor-reverse-proxy/20261003-mentor-proxy-v1` on the edge. Rollback should restore only the two changed include files from that backup (or remove them if their `.absent` marker exists), archive the owned `mentor-portal` directory, run `nginx -t`, then reload Nginx. Inspect for newer shared-include changes before restoration. Do not modify the NPM database, generated host configurations or other applications.

Current validation evidence is in `outputs/mentor-editing-usso-20261003/proxy-status.json` in the workspace.

References: [supported NPM custom includes](https://nginxproxymanager.com/advanced-config/#custom-nginx-configurations), [Cloudflare IPv4 ranges](https://www.cloudflare.com/ips-v4/), [Cloudflare IPv6 ranges](https://www.cloudflare.com/ips-v6/), [Origin CA roots and trust](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/), [NGINX trusted real-IP sources](https://nginx.org/en/docs/http/ngx_http_realip_module.html).
