"""Executed as root over SSH. NODE_SOURCE is injected by run-backup.py, never a secret."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess

ROOT = Path('/opt/mentor-portal')
VOLUME = 'mentor-portal_portal-data'
CONTAINERS = ['mentor-portal-web-1', 'mentor-portal-sync-1']
os.umask(0o077)
PHASE = 'deployment-guards'
BACKUP_DIRECTORY = None
SAFE_CHILD_FAILURE = None

def run(*args, **kwargs):
    global SAFE_CHILD_FAILURE
    result = subprocess.run(list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)
    if result.returncode != 0:
        for line in result.stderr.splitlines():
            try:
                child=json.loads(line)
                if child.get('event')=='mentor_backup_failed' and child.get('detailsSuppressed') is True:
                    SAFE_CHILD_FAILURE={key:child[key] for key in ['event','phase','code'] if key in child}
            except (ValueError,TypeError):
                pass
        raise RuntimeError('A backup prerequisite or subprocess failed')
    return result.stdout.strip()

def runtime_flags(container):
    script = "console.log(JSON.stringify({nodeVersion:process.version,uid:process.getuid(),gid:process.getgid(),mode:process.env.PORTAL_MODE,dataDir:process.env.DATA_DIR,origin:process.env.APP_ORIGIN,writeFlag:process.env.MENTOR_LIVE_WRITES_ENABLED===undefined?'unset':process.env.MENTOR_LIVE_WRITES_ENABLED==='false'?'false':process.env.MENTOR_LIVE_WRITES_ENABLED==='true'?'true':'invalid'}))"
    flags = json.loads(run('docker','exec',container,'node','-e',script))
    if flags['writeFlag'] not in ['false', 'unset'] or flags['mode'] != 'live' or flags['dataDir'] != '/data':
        raise RuntimeError('Live write/mode/data-path guard failed')
    return flags

def private_env_flag():
    # Select only this public switch. No complete env file or other variable is read into Python.
    result = subprocess.run(['grep','-E','^MENTOR_LIVE_WRITES_ENABLED=',str(ROOT/'secrets/portal.env')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    if result.returncode not in [0,1]:
        raise RuntimeError('Cannot check the private write switch')
    lines = result.stdout.strip().splitlines()
    if not lines:
        return 'unset'
    if len(lines) != 1 or lines[0].split('=',1)[1].strip().strip('"\'') != 'false':
        raise RuntimeError('The private write switch is not disabled')
    return 'false'

def deployment_metadata():
    release = (ROOT/'current').resolve(strict=True)
    if release.parent != ROOT/'releases':
        raise RuntimeError('Unexpected current release path')
    result = {'releasePath':str(release),'releaseName':release.name,'volume':VOLUME,'privateEnvWriteFlag':private_env_flag(),'containers':{}}
    for container in CONTAINERS:
        data = run('docker','inspect','--format','{{.Id}}\n{{.Image}}\n{{.Config.Image}}\n{{.State.StartedAt}}\n{{.State.Running}}',container).splitlines()
        if len(data) != 5 or data[4] != 'true':
            raise RuntimeError('A portal container is not running')
        mounted = run('docker','inspect','--format','{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}',container)
        if mounted != VOLUME:
            raise RuntimeError('Unexpected data volume')
        result['containers'][container] = {'containerId':data[0],'imageId':data[1],'imageTag':data[2],'startedAt':data[3],'runtime':runtime_flags(container)}
    if len({item['imageId'] for item in result['containers'].values()}) != 1:
        raise RuntimeError('Web and sync images do not match')
    files = [release/name for name in ['compose.yaml','Dockerfile','package.json','package-lock.json']]
    files += sorted((release/'drizzle').glob('*.sql'))
    result['publicReleaseFiles'] = [{'path':str(path.relative_to(release)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size} for path in files if path.is_file() and not path.is_symlink()]
    return result

def write_private(path, value):
    fd = os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as handle:
        json.dump(value,handle,indent=2);handle.write('\n');handle.flush();os.fsync(handle.fileno())

def main():
    global PHASE, BACKUP_DIRECTORY
    if os.geteuid() != 0:
        raise RuntimeError('Root is required for private backup directory creation')
    before = deployment_metadata()
    parent = ROOT/'backups'
    if parent.exists() and parent.is_symlink():
        raise RuntimeError('Backup root cannot be a symlink')
    parent.mkdir(mode=0o700,exist_ok=True)
    if stat.S_IMODE(parent.stat().st_mode) != 0o700:
        raise RuntimeError('Existing backup root must already be private')
    data_path=Path(run('docker','volume','inspect',VOLUME,'--format','{{.Mountpoint}}'))
    estimated=sum(path.stat().st_size for path in [data_path/'portal.sqlite',data_path/'portal.sqlite-wal'] if path.exists())
    estimated+=sum(path.stat().st_size for path in (data_path/'objects').iterdir() if path.is_file())
    if shutil.disk_usage(parent).free < estimated*4+256*1024*1024:
        raise RuntimeError('Insufficient free space for capture and isolated restore')
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    directory = parent/timestamp
    directory.mkdir(mode=0o700)
    BACKUP_DIRECTORY = str(directory)
    runtime = before['containers'][CONTAINERS[0]]['runtime']
    uid,gid = runtime['uid'],runtime['gid']
    os.chown(str(directory),uid,gid)
    node_file=directory/'online-backup.mjs'
    node_file.write_text(NODE_SOURCE)
    os.chmod(str(node_file),0o600);os.chown(str(node_file),uid,gid)
    write_private(directory/'deployment-metadata.json',before)
    os.chown(str(directory/'deployment-metadata.json'),uid,gid)
    public = directory/'public-release-metadata'
    public.mkdir(mode=0o700)
    for item in before['publicReleaseFiles']:
        target=public/item['path'];target.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
        shutil.copyfile(Path(before['releasePath'])/item['path'],target);os.chmod(str(target),0o600)
    image=before['containers'][CONTAINERS[0]]['imageId']
    # Label only this new private backup directory. Never relabel the live named volume.
    base=['docker','run','--rm','--network','none','--read-only','--user',str(uid)+':'+str(gid),'--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','--volume',str(directory)+':/backup:Z']
    PHASE = 'synthetic-runtime-self-test'
    self_test=json.loads(run(*(base+[image,'node','/backup/online-backup.mjs','--self-test'])))
    PHASE = 'online-capture-and-restore-verification'
    summary=json.loads(run(*(base+['--mount','type=volume,src='+VOLUME+',dst=/source,readonly',image,'node','/backup/online-backup.mjs'])))
    PHASE = 'final-deployment-and-migration-guards'
    after=deployment_metadata()
    if before != after:
        raise RuntimeError('Deployment or live-write guard changed during backup')
    manifest_path=directory/'manifest.json'
    manifest=json.loads(manifest_path.read_text())
    applied={row['name']:row['sha256'] for row in manifest['sourceSnapshot']['migrations']}
    available={Path(item['path']).name:item['sha256'] for item in before['publicReleaseFiles'] if item['path'].startswith('drizzle/')}
    if not applied or any(available.get(name) != checksum for name,checksum in applied.items()):
        raise RuntimeError('Restored migration history does not match the current release')
    manifest.update({'status':'verified','deploymentGuardUnchanged':True,'migrationsMatchRelease':True,'runtimeSelfTest':self_test,'environmentSecretsCopied':False,'productionRestored':False})
    temporary=directory/'manifest.final.json'
    write_private(temporary,manifest);os.replace(str(temporary),str(manifest_path));os.chmod(str(manifest_path),0o600)
    for name in ['portal.sqlite','objects.tar.gz','manifest.json']:
        if stat.S_IMODE((directory/name).stat().st_mode) != 0o600:
            raise RuntimeError('A backup artifact is not private')
    # Only counts, booleans, public versions and the private path leave this host.
    print(json.dumps(dict(summary,status='verified',backupPath=str(directory),manifestPath=str(manifest_path),release=before['releaseName'],imageTag=before['containers'][CONTAINERS[0]]['imageTag'],migrations=list(applied),deploymentGuardUnchanged=True,migrationsMatchRelease=True,permissionsVerified=True,productionRestored=False,environmentSecretsCopied=False)))

try:
    main()
except Exception:
    print(json.dumps({'status':'failed','phase':PHASE,'backupPath':BACKUP_DIRECTORY,'childFailure':SAFE_CHILD_FAILURE,'detailsSuppressed':True}))
    raise SystemExit(1)
