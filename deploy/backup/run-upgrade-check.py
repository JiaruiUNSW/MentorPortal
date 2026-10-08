"""Validate reviewed upgrade/rollback images against an isolated verified backup copy."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

parser=argparse.ArgumentParser()
for name in ['candidate-tag','candidate-id','candidate-config-id','rollback-tag','rollback-id','rollback-config-id']:parser.add_argument('--'+name,required=True)
args=parser.parse_args()
HERE=Path(__file__).resolve().parent
STATUS=HERE.parents[1].parent/'outputs/mentor-editing-usso-20261003/backup-status.json'
status=json.loads(STATUS.read_text())
if status.get('status')!='verified':raise SystemExit('A verified backup is required')
expected_migrations=sorted(path.name for path in (HERE.parents[1]/'drizzle').glob('*.sql'))
if not expected_migrations or any(not re.fullmatch(r'\d{4}_[A-Za-z0-9_]+\.sql',name) for name in expected_migrations):raise SystemExit('Invalid migration inventory')
context={'backupPath':status['backupPath'],'expectedMigrations':expected_migrations,'candidate':{'tag':args.candidate_tag,'id':args.candidate_id,'configDigest':args.candidate_config_id},'rollback':{'tag':args.rollback_tag,'id':args.rollback_id,'configDigest':args.rollback_config_id}}
for key in ['candidate','rollback']:
    if not re.fullmatch(r'mentor-portal:[A-Za-z0-9._-]+',context[key]['tag']) or any(not re.fullmatch(r'sha256:[a-f0-9]{64}',context[key][field]) for field in ['id','configDigest']):raise SystemExit('Invalid reviewed image reference')
program='CONTEXT = '+repr(context)+'\n'+(HERE/'upgrade-check-remote.py').read_text()
result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','service-manager','sudo -n python3 -'],input=program,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:check=json.loads(result.stdout.strip())
except (ValueError,TypeError):check={'status':'failed','detailsSuppressed':True}
if result.returncode:check['status']='failed'
status['upgradeRollbackCheck']=check
fd=os.open(str(STATUS),os.O_WRONLY|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as handle:json.dump(status,handle,indent=2);handle.write('\n')
print(json.dumps(check))
raise SystemExit(0 if check.get('status')=='verified' else 1)
