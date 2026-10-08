import { fail } from './errors';
import type { Claim } from './store';
import { asyncResourceGuard, type AsyncExecution } from './async-guards';

export async function acquireResourceLocks(db:D1Database,claim:Claim,keys:string[],expiresAt:number,execution?:AsyncExecution):Promise<string[]> {
  const sorted=[...new Set(keys)].sort(),now=Date.now(),r=claim.row;
  for(const key of sorted) {
    const queue=asyncResourceGuard(execution);
    const result=await db.prepare(`INSERT INTO mentor_resource_locks (resource_key,request_id,owner_account_id,lease_token,lease_expires_at,state,updated_at) SELECT ?,?,?,?,?,'pending',? WHERE ${queue.sql} ON CONFLICT(resource_key) DO UPDATE SET request_id=excluded.request_id,owner_account_id=excluded.owner_account_id,lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,state='pending',updated_at=excluded.updated_at WHERE ((mentor_resource_locks.state='pending' AND mentor_resource_locks.lease_expires_at<=?) OR (mentor_resource_locks.request_id=? AND mentor_resource_locks.owner_account_id=? AND mentor_resource_locks.state='dispatched' AND ?)) AND ${queue.sql}`).bind(key,r.request_id,r.account_id,claim.lease,expiresAt,now,key,...queue.args,now,r.request_id,r.account_id,claim.resumingUpstreamPending?1:0,key,...queue.args).run();
    if(result.meta.changes!==1) {
      // Acquisition never waits while holding a subset of resources, so lock cycles cannot deadlock.
      if(claim.resumingUpstreamPending)await db.prepare("UPDATE mentor_resource_locks SET state='uncertain' WHERE request_id=? AND owner_account_id=? AND lease_token=? AND state='pending'").bind(r.request_id,r.account_id,claim.lease).run();
      else await db.prepare("DELETE FROM mentor_resource_locks WHERE request_id=? AND owner_account_id=? AND lease_token=? AND state='pending'").bind(r.request_id,r.account_id,claim.lease).run();
      const row=await db.prepare('SELECT state,request_id,lease_expires_at FROM mentor_resource_locks WHERE resource_key=?').bind(key).first<{state:string;request_id:string;lease_expires_at:number}>();
      if(row?.state==='uncertain'||(row?.state==='dispatched'&&row.lease_expires_at<=now)) fail('PARTIAL_WRITE','An earlier change to this record needs reconciliation before another write.',409,false,row.request_id);
      fail('REQUEST_IN_PROGRESS','Another change to this record is still running. Retry this request with the same key.',409,true);
    }
  }
  return sorted;
}
export async function renewResourceLocks(db:D1Database,claim:Claim,keys:string[],expiresAt:number):Promise<void> {
  if(!keys.length)return;
  const now=Date.now(),r=claim.row;
  const result=await db.prepare("UPDATE mentor_resource_locks SET lease_expires_at=?,updated_at=? WHERE request_id=? AND owner_account_id=? AND lease_token=? AND state IN ('pending','dispatched') AND lease_expires_at>?").bind(expiresAt,now,r.request_id,r.account_id,claim.lease,now).run();
  if(result.meta.changes!==keys.length)fail('PARTIAL_WRITE','The record write lock changed. Keep this request reference for reconciliation.',409,false,r.request_id);
}
export async function markResourceDispatch(db:D1Database,claim:Claim,keys:string[]):Promise<void> {
  if(!keys.length)return;
  const now=Date.now(),r=claim.row;
  const result=await db.prepare("UPDATE mentor_resource_locks SET state='dispatched',updated_at=? WHERE request_id=? AND owner_account_id=? AND lease_token=? AND state='pending' AND lease_expires_at>?").bind(now,r.request_id,r.account_id,claim.lease,now).run();
  if(result.meta.changes!==keys.length)fail('PARTIAL_WRITE','The record write lock changed before dispatch.',409,false,r.request_id);
}
export async function finishResourceLocks(db:D1Database,claim:Claim,outcome:'complete'|'safe_failure'|'uncertain'|'pending'):Promise<void> {
  const r=claim.row;
  if(outcome==='complete') {
    // Also permits a confirmed success replay to finish interrupted lock cleanup.
    await db.prepare("DELETE FROM mentor_resource_locks WHERE request_id=? AND owner_account_id=? AND EXISTS (SELECT 1 FROM mentor_requests WHERE account_id=? AND mode='live' AND idempotency_key=? AND state='succeeded')").bind(r.request_id,r.account_id,r.account_id,r.idempotency_key).run();
  } else if(outcome==='safe_failure') {
    await db.prepare('DELETE FROM mentor_resource_locks WHERE request_id=? AND owner_account_id=? AND lease_token=?').bind(r.request_id,r.account_id,claim.lease).run();
  } else {
    await db.prepare('UPDATE mentor_resource_locks SET state=?,updated_at=? WHERE request_id=? AND owner_account_id=? AND lease_token=?').bind(outcome==='pending'?'dispatched':'uncertain',Date.now(),r.request_id,r.account_id,claim.lease).run();
  }
}
