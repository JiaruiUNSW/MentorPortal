"""Only an isolated copy of a verified backup is mounted; CONTEXT is injected locally."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import time
import uuid

os.umask(0o077)
phase='backup-and-image-guards'
containers=[]
scratch=None

def run(*args):
    result=subprocess.run(list(args),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    if result.returncode:
        raise RuntimeError('Isolated validation command failed')
    return result.stdout.strip()

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write_private(path,value):
    fd=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as handle:
        json.dump(value,handle,indent=2);handle.write('\n');handle.flush();os.fsync(handle.fileno())

STATS="""
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/data/portal.sqlite',{readOnly:true,timeout:5000,allowExtension:false});
try{
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw Error('integrity');
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('foreign-key');
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  if(names.some(name=>!/^[A-Za-z0-9_]+$/.test(name)))throw Error('schema');
  const tableCounts=Object.fromEntries(names.map(name=>[name,Number(db.prepare('SELECT COUNT(*) AS count FROM "'+name+'"').get().count)]));
  const migrations=db.prepare('SELECT name FROM _portal_migrations ORDER BY name').all().map(row=>row.name);
  const activeAccounts=Number(db.prepare("SELECT COUNT(*) AS count FROM auth_accounts WHERE status='active'").get().count);
  const pilotCache=Object.fromEntries(['private','catalog'].map(namespace=>[namespace,Number(db.prepare("SELECT COUNT(*) AS count FROM mentor_cache_snapshots s JOIN auth_accounts a ON a.id=s.account_id AND a.mentor_user_id=s.mentor_user_id WHERE s.mentor_user_id=1 AND s.namespace=? AND a.status='active' AND a.mode='live' AND a.role='mentor'").get(namespace).count)]));
  console.log(JSON.stringify({integrityCheck:'ok',foreignKeyViolations:0,tableCounts,migrations,activeAccounts,pilotCache}));
}finally{db.close();}
"""
HEALTH="""
try{const response=await fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(1500)});if(response.status!==200)process.exitCode=1;else console.log(JSON.stringify({httpStatus:response.status}));}catch{process.exitCode=1;}
"""

def check_image(image, image_id, directory, baseline, suffix, uid, gid):
    name='mentor-backup-check-'+suffix+'-'+uuid.uuid4().hex[:10]
    args=['docker','run','--detach','--pull','never','--name',name,'--network','none','--read-only','--user',str(uid)+':'+str(gid),'--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','--volume',str(directory)+':/data:Z']
    settings={'PORTAL_MODE':'live','MENTOR_LIVE_WRITES_ENABLED':'false','MENTOR_CACHE_ENABLED':'true','MENTOR_SYNC_ALLOWED_USER_IDS':'1','APP_ORIGIN':'https://backup-canary.invalid','TRUST_PROXY':'false','MENTOR_USSO_ENABLED':'false','HOSTNAME':'127.0.0.1','PORT':'3000','DATA_DIR':'/data','MIGRATIONS_DIR':'/app/drizzle'}
    for key,value in settings.items():args+=['--env',key+'='+value]
    args += [image_id,'node','server.js']
    run(*args);containers.append(name)
    healthy=False
    for attempt in range(20):
        result=subprocess.run(['docker','exec',name,'node','--input-type=module','-e',HEALTH],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        if result.returncode==0:
            healthy=True;break
        time.sleep(0.5)
    if not healthy:raise RuntimeError('Isolated readiness did not become healthy')
    result=json.loads(run('docker','exec',name,'node','--input-type=module','-e',STATS))
    expected=sorted(baseline['sourceSnapshot']['tableCounts'])
    for table in expected:
        if table!='_portal_migrations' and result['tableCounts'].get(table)!=baseline['sourceSnapshot']['tableCounts'][table]:
            raise RuntimeError('Existing table counts changed during migration/startup')
    required=['0003_usso_identity.sql','0004_mentor_resource_locks.sql']
    if len(result['migrations'])!=5 or any(name not in result['migrations'] for name in required):
        raise RuntimeError('Expected feature migrations were not applied')
    if result['activeAccounts']!=baseline['validation']['activeAccounts'] or result['pilotCache']!=baseline['validation']['pilotCache']:
        raise RuntimeError('Account or pilot cache counts changed')
    result.update({'imageTag':image,'dockerImageId':image_id,'dockerImageIdKind':'docker inspect .Id; OCI manifest-list digest on this daemon','readinessHttpStatus':200,'existingTableCountsPreserved':True})
    run('docker','stop','--time','10',name);run('docker','rm',name);containers.remove(name)
    return result

try:
    if os.geteuid()!=0:raise RuntimeError('Private backup validation requires root')
    directory=Path(CONTEXT['backupPath'])
    if directory.is_symlink() or directory.parent!=Path('/opt/mentor-portal/backups') or not directory.is_dir():raise RuntimeError('Unexpected backup directory')
    baseline=json.loads((directory/'manifest.json').read_text())
    if baseline.get('status')!='verified':raise RuntimeError('The source backup was not verified')
    for artifact in baseline['artifacts'].values():
        if digest(directory/artifact['file'])!=artifact['sha256']:raise RuntimeError('Backup artifact checksum changed')
    for key in ['candidate','rollback']:
        if run('docker','image','inspect','--format','{{.Id}}',CONTEXT[key]['tag'])!=CONTEXT[key]['id']:raise RuntimeError('The requested image does not match its reviewed digest')
    scratch=directory/('.upgrade-check-'+uuid.uuid4().hex)
    scratch.mkdir(mode=0o700)
    data=scratch/'data';data.mkdir(mode=0o700)
    shutil.copyfile(directory/'portal.sqlite',data/'portal.sqlite');os.chmod(str(data/'portal.sqlite'),0o600)
    run('tar','--extract','--gzip','--file',str(directory/'objects.tar.gz'),'--directory',str(data),'--no-same-owner','--no-same-permissions')
    runtime=baseline['deployment']['containers']['mentor-portal-web-1']['runtime'];uid,gid=runtime['uid'],runtime['gid']
    for root,dirs,files in os.walk(data):
        os.chown(root,uid,gid);os.chmod(root,0o700)
        for name in files:os.chown(os.path.join(root,name),uid,gid);os.chmod(os.path.join(root,name),0o600)
    phase='candidate-migration-and-readiness'
    candidate=check_image(CONTEXT['candidate']['tag'],CONTEXT['candidate']['id'],data,baseline,'candidate',uid,gid)
    phase='rollback-on-migrated-copy'
    rollback=check_image(CONTEXT['rollback']['tag'],CONTEXT['rollback']['id'],data,baseline,'rollback',uid,gid)
    candidate['configDigestFromBuildReceipt']=CONTEXT['candidate']['configDigest']
    rollback['configDigestFromBuildReceipt']=CONTEXT['rollback']['configDigest']
    if candidate['tableCounts']!=rollback['tableCounts']:raise RuntimeError('Rollback changed restored table counts')
    for artifact in baseline['artifacts'].values():
        if digest(directory/artifact['file'])!=artifact['sha256']:raise RuntimeError('Original backup artifacts changed')
    report={'status':'verified','finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate':candidate,'rollback':rollback,'networkDisabled':True,'productionVolumeMounted':False,'liveEnvironmentUsed':False,'realUserLoginAttempted':False,'originalBackupUnchanged':True,'scope':'Readiness, SQLite integrity, migration history and aggregate counts only; no login or business operation.'}
    report_path=directory/('upgrade-rollback-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'.json')
    write_private(report_path,report)
    public={**report,'candidate':{k:v for k,v in candidate.items() if k not in ['dockerImageId','configDigestFromBuildReceipt']},'rollback':{k:v for k,v in rollback.items() if k not in ['dockerImageId','configDigestFromBuildReceipt']},'reportPath':str(report_path)}
    print(json.dumps(public))
except Exception:
    print(json.dumps({'status':'failed','phase':phase,'detailsSuppressed':True}))
    raise SystemExit(1)
finally:
    for name in containers:
        subprocess.run(['docker','rm','--force',name],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if scratch is not None:shutil.rmtree(scratch)
