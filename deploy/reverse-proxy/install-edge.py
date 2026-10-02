#!/usr/bin/env python3
"""Apply only the reviewed Mentor custom includes; no NPM database operations."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
CONTAINER = "nginxproxymanager-app-1"
EXPECTED_DATA = Path("/home/ubuntu/data/docker_data/nginxproxymanager/data")
LABEL = "20261003-mentor-proxy-v1"
BACKUP = Path("/var/backups/mentor-reverse-proxy") / LABEL


def run(*args, capture=False):
    return subprocess.run(args, check=True, text=True, capture_output=capture)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write(path, data):
    temporary = path.with_name(path.name + ".mentor-new")
    prior_stat = path.stat() if path.exists() else None
    with temporary.open("xb") as f:
        f.write(data)
    os.chmod(temporary, prior_stat.st_mode & 0o777 if prior_stat else 0o644)
    if prior_stat:
        os.chown(temporary, prior_stat.st_uid, prior_stat.st_gid)
    os.replace(temporary, path)


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run as root on the existing edge host")
    os.umask(0o077)
    mount = run("docker", "inspect", CONTAINER, "--format",
                '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', capture=True).stdout.strip()
    if Path(mount) != EXPECTED_DATA:
        raise RuntimeError("Unexpected data mount; inspect before applying")
    custom = EXPECTED_DATA / "nginx/custom"
    owned = custom / "mentor-portal"
    if BACKUP.exists() or owned.exists():
        raise RuntimeError("Existing or partial Mentor proxy setup; inspect before changing it")
    run("docker", "exec", CONTAINER, "nginx", "-t")
    # Public roots only. Certificate key contents are never read by this script.
    ca = HERE / "ca/cloudflare-origin-ca.pem"
    fullchain = EXPECTED_DATA / "custom_ssl/npm-29/fullchain.pem"
    run("openssl", "verify", "-CAfile", str(ca), "-verify_hostname", "mentor-portal.com", str(fullchain))
    routes = {}
    for folder in ("proxy_host", "redirection_host", "default_host", "dead_host"):
        for path in sorted((EXPECTED_DATA / "nginx" / folder).glob("*.conf")):
            routes[str(path)] = digest(path)
            # Exact apex names only; existing subdomains are independent.
            for line in path.read_text().splitlines():
                if line.strip().startswith("server_name "):
                    names = line.strip().removeprefix("server_name ").rstrip(";").split()
                    if "mentor-portal.com" in names or ".mentor-portal.com" in names:
                        raise RuntimeError("Existing apex route found; no overwrite permitted")
    before = {}
    after = {}
    for target, source in ((custom / "http_top.conf", HERE / "http_top.append.conf"),
                           (custom / "http.conf", HERE / "http.append.conf")):
        prior = target.read_bytes() if target.exists() else None
        if prior and b"/mentor-portal/" in prior:
            raise RuntimeError("Existing Mentor include found; inspect before changing it")
        before[target] = prior
        after[target] = (prior or b"") + (b"\n" if prior and not prior.endswith(b"\n") else b"") + source.read_bytes()
    BACKUP.mkdir(parents=True, mode=0o700)
    os.chmod(BACKUP, 0o700)
    for target, prior in before.items():
        if prior is None:
            (BACKUP / (target.name + ".absent")).write_text("Absent before Mentor route installation.\n")
        else:
            shutil.copy2(target, BACKUP / target.name)
    identity = run("docker", "inspect", CONTAINER, "--format", '{{.Id}} {{.State.StartedAt}} {{.State.Pid}}', capture=True).stdout.strip()
    (BACKUP / "unrelated-route-sha256.json").write_text(json.dumps(routes, indent=2) + "\n")
    (BACKUP / "container-before.metadata").write_text(identity + "\n")
    custom.mkdir(parents=True, exist_ok=True, mode=0o755)
    shutil.copytree(HERE / "mentor-portal", owned)
    shutil.copy2(ca, owned / "cloudflare-origin-ca.pem")
    for p in owned.iterdir():
        os.chmod(p, 0o644)
    try:
        for target, content in after.items():
            if (target.read_bytes() if target.exists() else None) != before[target]:
                raise RuntimeError("Shared include changed concurrently")
            atomic_write(target, content)
        run("docker", "exec", CONTAINER, "nginx", "-t")
        run("docker", "exec", CONTAINER, "nginx", "-s", "reload")
    except Exception:
        # Only undo bytes that still exactly match this installation's write.
        for target, content in after.items():
            if target.exists() and target.read_bytes() == content:
                prior = before[target]
                if prior is None:
                    target.unlink()
                else:
                    atomic_write(target, prior)
        shutil.move(str(owned), str(BACKUP / "failed-owned-config"))
        run("docker", "exec", CONTAINER, "nginx", "-t")
        raise
    for filename, previous_hash in routes.items():
        if digest(Path(filename)) != previous_hash:
            raise RuntimeError("An unrelated route changed during deployment; inspect")
    current = run("docker", "inspect", CONTAINER, "--format", '{{.Id}} {{.State.StartedAt}} {{.State.Pid}}', capture=True).stdout.strip()
    if current != identity:
        raise RuntimeError("Container identity/start changed during deployment")
    print(json.dumps({"status": "installed-and-nginx-reloaded", "backup": str(BACKUP),
                      "preservedUnrelatedRouteCount": len(routes), "containerIdentityUnchanged": True,
                      "httpTopPreviouslyPresent": before[custom / "http_top.conf"] is not None,
                      "httpLatePreviouslyPresent": before[custom / "http.conf"] is not None,
                      "ownedDirectory": str(owned)}, indent=2))


if __name__ == "__main__":
    main()
