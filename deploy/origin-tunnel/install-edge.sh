#!/bin/sh
# Run as root on the existing NPM edge host. Input is the NEW PUBLIC key only.
# No public firewall, Docker, NPM, DNS, application or IssueMesh changes occur.
set -eu
umask 077

[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
template_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
setup_label=${1:?Pass the unique backup label}
public_key_file=${2:?Pass the new Mentor public key file}
case "$setup_label" in *[!A-Za-z0-9_-]*|'') exit 2 ;; esac
backup_dir=/var/backups/mentor-origin-tunnel/"$setup_label"
key_dir=/etc/mentor-portal-tunnel
dropin=/etc/ssh/sshd_config.d/91-mentor-portal-tunnel.conf

! getent passwd mentor_origin_tunnel >/dev/null || { echo 'Edge account already exists; inspect.' >&2; exit 3; }
! getent group mentor_origin_tunnel >/dev/null || { echo 'Edge group already exists; inspect.' >&2; exit 3; }
[ ! -e "$key_dir" ] && [ ! -e "$dropin" ] && [ ! -e "$backup_dir" ]
[ -z "$(ss -H -lnt 'sport = :13100')" ] || { echo 'Port13100 is already in use.' >&2; exit 4; }
[ "$(docker network inspect issuemesh_npm_origin --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}')" = '172.30.253.0/29 172.30.253.1' ]
sshd -t
ssh-keygen -lf "$public_key_file" >/dev/null
[ "$(awk 'NR==1 {print $1}' "$public_key_file")" = ssh-ed25519 ]
[ "$(awk 'END {print NR}' "$public_key_file")" -eq 1 ]

install -d -m 0700 "$backup_dir"
cp -a /etc/ssh/sshd_config "$backup_dir/sshd_config"
cp -a /etc/ssh/sshd_config.d "$backup_dir/sshd_config.d"
printf '%s\n' 'Edge account, group, authorized-key directory and Mentor sshd drop-in were absent.' > "$backup_dir/preexisting-state.txt"
docker inspect nginxproxymanager-app-1 --format '{{.Id}} {{.State.StartedAt}} {{.State.Pid}}' > "$backup_dir/npm-before.metadata"
sha256sum /etc/ssh/sshd_config.d/90-issuemesh-tunnel.conf > "$backup_dir/issuemesh-dropin-before.sha256"
useradd --system --user-group --create-home --home-dir /var/lib/mentor-origin-tunnel --shell /usr/sbin/nologin mentor_origin_tunnel
passwd -l mentor_origin_tunnel >/dev/null
install -d -o root -g root -m 0755 "$key_dir"
{
    printf '%s ' 'from="140.238.205.237",no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc,permitlisten="172.30.253.1:13100"'
    cat "$public_key_file"
} > "$key_dir/authorized_keys"
chown root:root "$key_dir/authorized_keys"
chmod 0644 "$key_dir/authorized_keys"
install -o root -g root -m 0644 "$template_dir/edge/sshd-mentor-portal-tunnel.conf" "$dropin"

# Leave SSH running with its previous configuration if the new config is invalid.
if ! sshd -t; then
    mv "$dropin" "$backup_dir/rejected-mentor-dropin.conf"
    echo 'New SSH configuration rejected; no reload performed.' >&2
    exit 5
fi
effective=$(sshd -T -C user=mentor_origin_tunnel,host=service-manager,addr=140.238.205.237)
for expected in \
    'authenticationmethods publickey' \
    'pubkeyauthentication yes' \
    'passwordauthentication no' \
    'kbdinteractiveauthentication no' \
    'allowtcpforwarding remote' \
    'allowstreamlocalforwarding no' \
    'gatewayports clientspecified' \
    'permitlisten 172.30.253.1:13100' \
    'permitopen none' \
    'x11forwarding no' \
    'allowagentforwarding no' \
    'permittty no' \
    'permituserrc no' \
    'maxsessions 0' \
    'authorizedkeysfile /etc/mentor-portal-tunnel/authorized_keys'; do
    if ! printf '%s\n' "$effective" | grep -Fx "$expected" >/dev/null; then
        mv "$dropin" "$backup_dir/rejected-effective-policy.conf"
        echo 'Effective SSH policy mismatch; no reload performed.' >&2
        exit 6
    fi
done
printf '%s\n' "$effective" | grep -E '^(authenticationmethods|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication|allowtcpforwarding|allowstreamlocalforwarding|gatewayports|permitlisten|permitopen|x11forwarding|allowagentforwarding|permittty|permituserrc|maxsessions|authorizedkeysfile) ' > "$backup_dir/mentor-effective-policy.metadata"
systemctl reload ssh.service
sha256sum --check "$backup_dir/issuemesh-dropin-before.sha256"
printf 'edge_prepared=true\nbackup=%s\n' "$backup_dir"
