#!/usr/bin/env python3
"""Bounded synthetic routing/TLS/log probes. No real credentials or SSO codes."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import time

CONTAINER = "nginxproxymanager-app-1"
DATA = Path("/home/ubuntu/data/docker_data/nginxproxymanager/data")
CA = "/data/nginx/custom/mentor-portal/cloudflare-origin-ca.pem"
CODE = "MENTOR_PROXY_TEST_CODE_20261003"
STATE = "MENTOR_PROXY_TEST_STATE_20261003"
REFERRER = "MENTOR_PROXY_TEST_REFERRER_20261003"


def probe(url, *, tls=False, headers=()):
    command = ["docker", "exec", CONTAINER, "curl", "--silent", "--show-error", "--max-time", "20",
               "--output", "/dev/null", "--dump-header", "-",
               "--write-out", "\nMENTOR_PROBE %{http_code} %{ssl_verify_result}\n"]
    if tls:
        command += ["--cacert", CA, "--resolve", "mentor-portal.com:443:127.0.0.1"]
    elif url.startswith("http://mentor-portal.com"):
        command += ["--resolve", "mentor-portal.com:80:127.0.0.1"]
    for header in headers:
        command += ["--header", header]
    result = subprocess.run(command + [url], capture_output=True, text=True, check=True)
    response_headers = {}
    code = None
    tls_result = None
    for line in result.stdout.splitlines():
        if line.startswith("MENTOR_PROBE "):
            _, code, tls_result = line.split()
        elif ":" in line:
            name, value = line.split(":", 1)
            if name.lower() in ("location", "cache-control", "referrer-policy"):
                response_headers[name.lower()] = value.strip()
    assert code is not None
    return {"httpStatus": int(code), "tlsVerifyResult": int(tls_result), "headers": response_headers}


def main():
    access = DATA / "logs/mentor-portal_access.log"
    fallback = DATA / "logs/fallback_error.log"
    starts = {path: path.stat().st_size if path.exists() else 0 for path in (access, fallback)}
    upstream = probe("http://172.30.253.1:13100/api/health")
    assert upstream["httpStatus"] == 200
    redirect = probe("http://mentor-portal.com/api/health?probe=canonical")
    assert redirect["httpStatus"] == 308
    assert redirect["headers"]["location"] == "https://mentor-portal.com/api/health?probe=canonical"
    health = probe("https://mentor-portal.com/api/health", tls=True, headers=(
        "X-Forwarded-Host: untrusted.invalid", "X-Forwarded-Proto: http",
        "X-Real-IP: 203.0.113.42", "X-Forwarded-For: 203.0.113.42", "CF-Connecting-IP: 203.0.113.42"))
    assert health["httpStatus"] == 200 and health["tlsVerifyResult"] == 0
    callback = probe("https://mentor-portal.com/api/auth/usso/callback?code=" + CODE + "&state=" + STATE,
                     tls=True, headers=("Referer: https://mentor-portal.com/api/auth/usso/callback?code=" + REFERRER,))
    assert callback["tlsVerifyResult"] == 0
    assert callback["headers"].get("cache-control") == "no-store"
    assert callback["headers"].get("referrer-policy") == "no-referrer"
    assert CODE not in callback["headers"].get("location", "")
    assert STATE not in callback["headers"].get("location", "")
    time.sleep(0.3)
    chunks = {}
    for path, offset in starts.items():
        if not path.exists():
            chunks[path] = ""
            continue
        with path.open("rb") as f:
            f.seek(offset)
            chunks[path] = f.read().decode("utf-8", errors="replace")
        assert all(marker not in chunks[path] for marker in (CODE, STATE, REFERRER)), "Synthetic query/referrer appeared in log"
    records = [json.loads(line) for line in chunks[access].splitlines() if line.startswith("{")]
    callbacks = [r for r in records if r.get("path") == "/api/auth/usso/callback" and r.get("client") == "127.0.0.1"]
    healths = [r for r in records if r.get("path") == "/api/health" and r.get("client") == "127.0.0.1" and r.get("status") == 200]
    assert callbacks and healths
    assert not any(r.get("client") == "203.0.113.42" for r in records)
    allowed = {"time", "client", "method", "path", "status", "bytes", "duration", "upstream_status", "upstream_duration"}
    assert all(set(r) == allowed for r in records)
    print(json.dumps({"upstreamHealthHttp": upstream["httpStatus"], "httpRedirect": redirect,
        "originHttpsHealthHttp": health["httpStatus"], "originTlsVerifyResult": health["tlsVerifyResult"],
        "callbackSyntheticProbe": callback,
        "callbackQueryAndReferrerAbsentFromAccessAndFallbackErrorLog": True,
        "callbackPathOnlyAccessRecordObserved": True, "forgedClientIpIgnored": True,
        "observedDirectProbeClient": "127.0.0.1", "safeAccessLogFields": sorted(allowed),
        "realCredentialsOrSsoCodesUsed": False, "tlsInsecureBypassUsed": False}, indent=2))


if __name__ == "__main__":
    main()
