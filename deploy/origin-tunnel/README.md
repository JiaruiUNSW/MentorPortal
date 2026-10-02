# Mentor Portal private origin tunnel

This tunnel gives the existing Nginx Proxy Manager container a private route to the Mentor Portal app. It changes no public port, Docker network, NPM process, DNS, application environment or IssueMesh configuration.

| Purpose | Value |
| --- | --- |
| Source SSH alias | `service-manager` (`opc@140.238.205.237`) |
| Source app target | `127.0.0.1:3100` |
| Source locked service account | `mentor-origin` |
| Source systemd unit | `mentor-portal-origin-tunnel.service` |
| Edge SSH alias | `ubuntu_Blog_new` (`ubuntu@54.206.250.179`) |
| Edge locked tunnel account | `mentor_origin_tunnel` |
| New private listener | `172.30.253.1:13100` |
| Existing NPM container | `nginxproxymanager-app-1`, `172.30.253.2` |
| Existing Docker network | `issuemesh_npm_origin`, `172.30.253.0/29` |
| Unchanged IssueMesh listener | `172.30.253.1:18080` |

The edge permits this account to authenticate only with its dedicated public key, received from the source. It accepts reverse TCP forwarding on exactly the new private listener and denies session channels, PTY, agent, X11, user RC and Unix-socket forwarding. The key also restricts the connection's source address to `140.238.205.237`. The SSH private key is generated and remains on `service-manager`; only its public counterpart is transferred.

The source copies the already trusted **public** known-hosts file from `/etc/issuemesh/origin-tunnel/known_hosts` and checks its ED25519 fingerprint against `SHA256:dulOB6cefMtO70ia4vZ5k7Lma9XLbN9+i31YJu3dTWo`. The edge public host-key fingerprint was independently compared. Strict host checking is enabled, host-key updates are disabled, and no `ssh-keyscan` or trust-on-first-use fallback is used.

## Installation boundaries

`install-source.sh LABEL` prepares the new source user, key, SSH config, wrapper and systemd unit but does not start it. `install-edge.sh LABEL PUBLIC_KEY_FILE` backs up the current SSH configuration, creates the distinct edge account and root-owned public-key file, validates the full configuration and effective Match User policy, then reloads SSH. Both scripts refuse to overwrite an existing or partial Mentor installation. Inspect before any repair or repeat run.

Backups remain on each host under `/var/backups/mentor-origin-tunnel/LABEL` (root-only). The source backup contains no private key or app environment. Edge backups contain SSH configuration, not private host keys or application credentials.

Once the edge is ready, the deliberate activation command is:

```sh
sudo systemctl enable --now mentor-portal-origin-tunnel.service
```

`Restart=always`, network startup ordering and `multi-user.target` enablement provide service persistence. Verification includes an explicit restart of **this new unit only** and another NPM-container health request. A machine reboot is not required or performed.

## Verification and rollback

Check the new unit's active/enabled status using allowlisted `systemctl show` properties. Confirm the exact private binding with `ss`; no `0.0.0.0:13100`, `[::]:13100` or public-address binding is acceptable. From the existing NPM container, request `http://172.30.253.1:13100/api/health`. Confirm the old listener remains present, its source unit PID/start time is unchanged, and the NPM container ID/PID/start time is unchanged. Do not print app environment files, whole credential-bearing units or private keys during checks.

To roll back the new tunnel, first run `sudo systemctl disable --now mentor-portal-origin-tunnel.service` on the source. Archive the Mentor-specific unit, wrapper and configuration rather than deleting the private key. On the edge, archive only `/etc/ssh/sshd_config.d/91-mentor-portal-tunnel.conf`, run `sudo sshd -t`, then reload `ssh.service` if validation passes. Retain the root-only backups and locked accounts until cleanup is explicitly needed. Do not restore or replace the whole SSH config tree over subsequent unrelated changes, and do not touch `90-issuemesh-tunnel.conf` or its listener.

The current deployment evidence is recorded in `outputs/mentor-editing-usso-20261003/tunnel-status.json` in the Mentor Portal Development workspace.

OpenSSH references: [reverse forwarding and PermitListen](https://man.openbsd.org/sshd_config), [host-key verification](https://man.openbsd.org/ssh_config#StrictHostKeyChecking).
