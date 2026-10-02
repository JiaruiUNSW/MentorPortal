import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { backup, DatabaseSync } from 'node:sqlite';

process.umask(0o077);
let phase='initialization';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileDigest = file => digest(readFileSync(file));
function privateWrite(path, value) { writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600}); }
function counts(db) {
  const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  if(tables.some(name=>!/^[A-Za-z0-9_]+$/.test(name)))throw new Error('Unexpected database table identifier');
  return Object.fromEntries(tables.map(name=>[name,Number(db.prepare('SELECT COUNT(*) AS count FROM "'+name+'"').get().count)]));
}
function inspect(db) {
  const checks=db.prepare('PRAGMA integrity_check').all();
  if(checks.length!==1||Object.values(checks[0])[0]!=='ok')throw new Error('Database integrity validation failed');
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Database foreign key validation failed');
  const tableCounts=counts(db);
  const activeAccounts=Number(db.prepare("SELECT COUNT(*) AS count FROM auth_accounts WHERE status='active'").get().count);
  const activePilotAccounts=Number(db.prepare("SELECT COUNT(*) AS count FROM auth_accounts WHERE status='active' AND mode='live' AND role='mentor' AND mentor_user_id=1").get().count);
  const pilotCache=Object.fromEntries(['private','catalog'].map(namespace=>[namespace,Number(db.prepare("SELECT COUNT(*) AS count FROM mentor_cache_snapshots s JOIN auth_accounts a ON a.id=s.account_id AND a.mentor_user_id=s.mentor_user_id WHERE s.mentor_user_id=1 AND s.namespace=? AND a.status='active' AND a.mode='live' AND a.role='mentor'").get(namespace).count)]));
  if(!activeAccounts||!activePilotAccounts||!pilotCache.private||!pilotCache.catalog)throw new Error('Required account or pilot cache is absent');
  return {integrityCheck:'ok',foreignKeyViolations:0,tableCounts,activeAccounts,activePilotAccounts,pilotCache};
}
function inventory(directory) {
  const root=lstatSync(directory);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Invalid object directory');
  return readdirSync(directory).sort().map(name=>{
    if(!/^(?:[a-f0-9]{64}\.object|\.upload-[a-f0-9-]{36})$/.test(name))throw new Error('Unexpected object filename');
    const file=join(directory,name),st=lstatSync(file,{bigint:true});
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1n)throw new Error('Unsafe object entry');
    return {name,size:Number(st.size),mtimeNs:String(st.mtimeNs),sha256:fileDigest(file)};
  });
}
function contentInventory(items) { return items.map(({name,size,sha256})=>({name,size,sha256})); }
async function capture(sourcePath,destination) {
  if(lstatSync(sourcePath).isSymbolicLink()||!lstatSync(sourcePath).isFile())throw new Error('Invalid source database');
  const db=new DatabaseSync(sourcePath,{readOnly:true,timeout:5000,allowExtension:false});
  try {
    db.exec('PRAGMA query_only=ON; BEGIN;');
    const tableCounts=counts(db); // Pins a read snapshot; the backup API includes committed WAL pages.
    const pinnedAt=new Date().toISOString();
    const migrations=db.prepare('SELECT name,sha256,applied_at FROM _portal_migrations ORDER BY name').all().map(row=>({...row}));
    const pages=await backup(db,destination,{rate:512});
    db.exec('ROLLBACK');
    return {pinnedAt,pages,tableCounts,migrations};
  } finally {db.close();}
}
function normalizeBackup(path) {
  chmodSync(path,0o600);
  const db=new DatabaseSync(path,{timeout:5000,allowExtension:false});
  try {db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');}finally{db.close();}
}
async function main() {
  const output='/backup',source='/source',startedAt=new Date().toISOString();
  assert.equal(statSync(output).mode&0o777,0o700);
  const objectBefore=inventory(join(source,'objects'));
  const databaseFile=join(output,'portal.sqlite');
  phase='sqlite-online-backup';
  const captured=await capture(join(source,'portal.sqlite'),databaseFile);
  phase='backup-normalization';
  normalizeBackup(databaseFile);
  const archive=join(output,'objects.tar.gz');
  phase='object-archive';
  execFileSync('tar',['--create','--gzip','--file',archive,'--directory',source,'--','objects'],{stdio:'pipe'});
  chmodSync(archive,0o600);
  const objectAfter=inventory(join(source,'objects'));
  assert.deepEqual(objectAfter,objectBefore,'Object storage changed during the backup');
  const restored=mkdtempSync(join(output,'.restore-check-'));chmodSync(restored,0o700);
  let validation;
  try {
    phase='isolated-restore-validation';
    const restoredDatabase=join(restored,'portal.sqlite');
    copyFileSync(databaseFile,restoredDatabase,constants.COPYFILE_EXCL);chmodSync(restoredDatabase,0o600);
    execFileSync('tar',['--extract','--gzip','--file',archive,'--directory',restored,'--no-same-owner','--no-same-permissions'],{stdio:'pipe'});
    assert.deepEqual(contentInventory(inventory(join(restored,'objects'))),contentInventory(objectBefore),'Restored object content differs');
    const db=new DatabaseSync(restoredDatabase,{readOnly:true,timeout:5000,allowExtension:false});
    try {validation=inspect(db);assert.deepEqual(validation.tableCounts,captured.tableCounts,'Restored table counts differ from the pinned source snapshot');}finally{db.close();}
    assert.equal(fileDigest(restoredDatabase),fileDigest(databaseFile),'Restored database bytes differ');
  } finally {rmSync(restored,{recursive:true,force:true});}
  const manifest={schemaVersion:1,status:'captured_and_restore_verified',startedAt,finishedAt:new Date().toISOString(),nodeVersion:process.version,
    method:'node:sqlite.backup, pinned read-only source connection, committed WAL included',sourceMountedReadOnly:true,networkDisabled:true,
    sourceSnapshot:captured,validation,objects:{files:objectBefore.length,bytes:objectBefore.reduce((n,item)=>n+item.size,0),unchangedDuringCapture:true,restoredMatches:true,entries:objectBefore},
    artifacts:{database:{file:'portal.sqlite',bytes:statSync(databaseFile).size,sha256:fileDigest(databaseFile)},objects:{file:'objects.tar.gz',bytes:statSync(archive).size,sha256:fileDigest(archive)}},
    deployment:JSON.parse(readFileSync(join(output,'deployment-metadata.json'),'utf8'))};
  privateWrite(join(output,'manifest.json'),manifest);
  for(const file of ['portal.sqlite','objects.tar.gz','manifest.json'])assert.equal(statSync(join(output,file)).mode&0o777,0o600);
  console.log(JSON.stringify({status:manifest.status,nodeVersion:process.version,integrityCheck:validation.integrityCheck,tableCounts:validation.tableCounts,activeAccounts:validation.activeAccounts,activePilotAccounts:validation.activePilotAccounts,pilotCache:validation.pilotCache,objectCount:objectBefore.length,objectStorageStable:true,restoreVerified:true}));
}
async function selfTest() {
  phase='synthetic-wal-self-test';
  const directory=mkdtempSync('/tmp/mentor-backup-self-test-');chmodSync(directory,0o700);
  const writer=new DatabaseSync(join(directory,'source.sqlite'));
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER PRIMARY KEY);');
    for(let i=0;i<10;i++)writer.prepare('INSERT INTO fixture VALUES (?)').run(i);
    const source=new DatabaseSync(join(directory,'source.sqlite'),{readOnly:true});
    try {
      source.exec('BEGIN');assert.equal(source.prepare('SELECT COUNT(*) AS n FROM fixture').get().n,10);
      let concurrentWrite=false;
      await backup(source,join(directory,'backup.sqlite'),{rate:1,progress:()=>{if(!concurrentWrite){writer.prepare('INSERT INTO fixture VALUES (?)').run(10);concurrentWrite=true;}}});
      source.exec('ROLLBACK');assert.equal(writer.prepare('SELECT COUNT(*) AS n FROM fixture').get().n,11);
    }finally{source.close();}
    normalizeBackup(join(directory,'backup.sqlite'));
    const restored=new DatabaseSync(join(directory,'backup.sqlite'),{readOnly:true});
    try {assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM fixture').get().n,10);assert.equal(Object.values(restored.prepare('PRAGMA integrity_check').get())[0],'ok');}finally{restored.close();}
    execFileSync('tar',['--version'],{stdio:'pipe'});
    console.log(JSON.stringify({selfTest:'passed',nodeVersion:process.version,onlineWalSnapshot:true,sourceRowsAfter:11,restoredRows:10,integrityCheck:'ok'}));
  }finally{writer.close();rmSync(directory,{recursive:true,force:true});}
}
try {if(process.argv.includes('--self-test'))await selfTest();else await main();}
catch(error) {console.error(JSON.stringify({event:'mentor_backup_failed',phase,code:typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'VALIDATION_FAILED',detailsSuppressed:true}));process.exitCode=1;}
