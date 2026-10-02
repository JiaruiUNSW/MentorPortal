#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ "${1:-}" != "--apply" || "$(id -u)" != 0 ]]; then
  echo 'Run as root on ubuntu_Blog_new: bash provision-edge.sh --apply' >&2
  exit 2
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
private_directory=/root/mentor-portal-usso
container_directory=/run/mentor-portal-usso
container=authentik-server-1

if [[ -L "$private_directory" ]]; then
  echo 'Refusing a symbolic-link credential directory.' >&2
  exit 1
fi
install -d -m 0700 "$private_directory"
docker exec -u 0 "$container" sh -c 'umask 077; test ! -L /run/mentor-portal-usso; mkdir -p /run/mentor-portal-usso; chmod 0700 /run/mentor-portal-usso'

if [[ -e "$private_directory/client-credentials.json" ]]; then
  python3 - "$private_directory/client-credentials.json" <<'PY'
import os,stat,sys
value=os.lstat(sys.argv[1])
if not stat.S_ISREG(value.st_mode) or stat.S_IMODE(value.st_mode)!=0o600 or value.st_uid!=0 or value.st_nlink!=1:
    raise SystemExit('Private credentials have unsafe ownership or permissions.')
PY
  if docker exec -u 0 "$container" test -e "$container_directory/client-credentials.json"; then
    # Compare through a private temporary file; never send credential contents to the terminal.
    temporary="$(mktemp "$private_directory/.existing.XXXXXX")"
    trap 'rm -f -- "$temporary"' EXIT
    docker cp "$container:$container_directory/client-credentials.json" "$temporary"
    if ! cmp -s "$private_directory/client-credentials.json" "$temporary"; then
      echo 'Existing host and container credentials differ; refusing to overwrite either.' >&2
      exit 1
    fi
    rm -f -- "$temporary"
    trap - EXIT
  else
    docker cp "$private_directory/client-credentials.json" "$container:$container_directory/client-credentials.json"
  fi
fi

docker cp "$script_directory/provision-authentik.py" "$container:$container_directory/provision-authentik.py"
docker exec -u 0 "$container" chmod 0600 "$container_directory/provision-authentik.py"

# Capture framework bootstrap chatter in memory. Only the reviewed public JSON
# status event is printed, even if a future framework error contains secret data.
python3 - "$container" "$container_directory/provision-authentik.py" <<'PY'
import json,subprocess,sys
completed=subprocess.run(['docker','exec','-u','0','-e','AUTHENTIK_LOG_LEVEL=error',sys.argv[1],'ak','shell','--verbosity','0','-c',"exec(compile(open("+repr(sys.argv[2])+",'rb').read(),'<mentor-usso-provision>','exec'))"],capture_output=True,text=True)
records=[]
for line in completed.stdout.splitlines():
    try:
        event=json.loads(line)
    except (ValueError,TypeError):
        continue
    if event.get('event') in ('mentor_usso_provider_status','mentor_usso_provider_error'):
        records.append(event)
for event in records:
    print(json.dumps(event))
if completed.returncode or not any(event.get('event')=='mentor_usso_provider_status' for event in records):
    print(json.dumps({'event':'mentor_usso_provider_error','code':'AUTHENTIK_PROVISIONING_DID_NOT_COMPLETE'}))
    raise SystemExit(1)
PY

if [[ ! -e "$private_directory/client-credentials.json" ]]; then
  temporary="$(mktemp "$private_directory/.credentials.XXXXXX")"
  trap 'rm -f -- "$temporary"' EXIT
  docker cp "$container:$container_directory/client-credentials.json" "$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -n "$temporary" "$private_directory/client-credentials.json"
  trap - EXIT
fi

python3 - "$private_directory/client-credentials.json" <<'PY'
import os,stat,sys,json
record=os.lstat(sys.argv[1])
if not stat.S_ISREG(record.st_mode) or stat.S_IMODE(record.st_mode)!=0o600 or record.st_uid!=0 or record.st_nlink!=1:
    raise SystemExit('Private credential export was not safely persisted.')
print(json.dumps({'event':'mentor_usso_private_file_ready','path':sys.argv[1],'owner_uid':record.st_uid,'mode':'0600','directory_mode':'0700'}))
PY
