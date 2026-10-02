#!/bin/sh
# Run as root on service-manager from this reviewed template directory.
# Preparation only: the separate activate step starts the service after the
# public key and restricted Match User policy have been installed on the edge.
set -eu
umask 077

[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
template_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
setup_label=${1:?Pass a unique backup label}
case "$setup_label" in *[!A-Za-z0-9_-]*|'') exit 2 ;; esac
backup_dir=/var/backups/mentor-origin-tunnel/"$setup_label"
tunnel_dir=/etc/mentor-portal/origin-tunnel
trusted_hosts=/etc/issuemesh/origin-tunnel/known_hosts
expected_host_key=SHA256:dulOB6cefMtO70ia4vZ5k7Lma9XLbN9+i31YJu3dTWo

# Refuse to overwrite any partial or existing Mentor installation.
! getent passwd mentor-origin >/dev/null || { echo 'Source account already exists; inspect.' >&2; exit 3; }
! getent group mentor-origin >/dev/null || { echo 'Source group already exists; inspect.' >&2; exit 3; }
[ ! -e "$tunnel_dir" ]
[ ! -e /etc/systemd/system/mentor-portal-origin-tunnel.service ]
[ ! -e /usr/local/libexec/mentor-portal-origin-tunnel ]
[ ! -e "$backup_dir" ]
[ -r "$trusted_hosts" ]
[ "$(ssh-keygen -lf "$trusted_hosts" | awk '{print $2}')" = "$expected_host_key" ]
systemctl is-active --quiet issuemesh-origin-tunnel.service

install -d -m 0700 "$backup_dir"
printf '%s\n' 'Source account, group, key directory, wrapper and unit were absent before this installation.' > "$backup_dir/preexisting-state.txt"
cp -a "$trusted_hosts" "$backup_dir/trusted-known_hosts.public"
systemctl show issuemesh-origin-tunnel.service --property=MainPID --property=ActiveEnterTimestamp --property=NRestarts > "$backup_dir/issuemesh-before.metadata"
useradd --system --user-group --create-home --home-dir /var/lib/mentor-origin --shell /sbin/nologin mentor-origin
passwd -l mentor-origin >/dev/null
install -d -o root -g mentor-origin -m 0750 "$tunnel_dir"
ssh-keygen -q -t ed25519 -N '' -C mentor-portal-origin-tunnel@service-manager -f "$tunnel_dir/id_ed25519"
chown mentor-origin:mentor-origin "$tunnel_dir/id_ed25519"
chmod 0400 "$tunnel_dir/id_ed25519"
chown root:root "$tunnel_dir/id_ed25519.pub"
chmod 0644 "$tunnel_dir/id_ed25519.pub"
install -o root -g mentor-origin -m 0440 "$trusted_hosts" "$tunnel_dir/known_hosts"
install -o root -g mentor-origin -m 0440 "$template_dir/service-manager/ssh_config" "$tunnel_dir/ssh_config"
install -o root -g root -m 0555 "$template_dir/service-manager/mentor-portal-origin-tunnel-wrapper" /usr/local/libexec/mentor-portal-origin-tunnel
install -o root -g root -m 0644 "$template_dir/service-manager/mentor-portal-origin-tunnel.service" /etc/systemd/system/mentor-portal-origin-tunnel.service
if command -v restorecon >/dev/null 2>&1; then
    restorecon -RF "$tunnel_dir" /usr/local/libexec/mentor-portal-origin-tunnel /etc/systemd/system/mentor-portal-origin-tunnel.service
fi
systemd-analyze verify /etc/systemd/system/mentor-portal-origin-tunnel.service
systemctl daemon-reload
ssh-keygen -lf "$tunnel_dir/id_ed25519.pub"
printf 'source_prepared=true\nbackup=%s\n' "$backup_dir"
