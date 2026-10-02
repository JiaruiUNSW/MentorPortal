"""Run the reviewed, secret-free backup program on the fixed service-manager host."""
import json
import os
from pathlib import Path
import subprocess

HERE=Path(__file__).resolve().parent
PROJECT=HERE.parents[1]
STATUS=PROJECT.parent/'outputs/mentor-editing-usso-20261003/backup-status.json'
node_source=(HERE/'online-backup.mjs').read_text()
program='NODE_SOURCE = '+repr(node_source)+'\n'+(HERE/'remote-backup.py').read_text()
result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','service-manager','sudo -n python3 -'],input=program,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
    status=json.loads(result.stdout.strip())
except (ValueError,TypeError):
    status={'status':'failed','detailsSuppressed':True}
if result.returncode != 0:
    status['status']='failed'
STATUS.parent.mkdir(parents=True,exist_ok=True)
fd=os.open(str(STATUS),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as handle:
    json.dump(status,handle,indent=2);handle.write('\n')
os.chmod(str(STATUS),0o600)
print(json.dumps(status))
raise SystemExit(0 if status.get('status')=='verified' else 1)
