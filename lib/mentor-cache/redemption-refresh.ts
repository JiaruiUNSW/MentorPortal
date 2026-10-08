import type { Principal } from '../runtime';
import { MentorError, safeError } from '../mentor-data/errors';
import { requireMentor } from '../mentor-data/validation';
import { cacheConfig, duration, hasUnsettledRedemptions, REDEMPTION_REFRESH_INTERVAL_MS, SOURCE_AUTH_DENIALS, syncLimits } from './config';
import { boundedSnapshot, collectRedemptionStatus, sourceReader } from './source';
import { activeAccount, claimLease, denyAccountCache, LostLease, publishRedemptionStatus, recordRedemptionRefreshFailure, releaseLease, snapshotFor, stateFor } from './store';
import type { CacheBindings, CacheConfig, PrivateSnapshot, SnapshotRow, SyncOptions, SyncResult, SyncState } from './types';

function privateSnapshot(row: SnapshotRow | null): PrivateSnapshot | null {
  if (!row) return null;
  try {
    const value=JSON.parse(row.snapshot_json) as PrivateSnapshot;
    return value.schemaVersion===1&&value.bootstrap&&value.profile&&value.balance&&Array.isArray(value.groups)&&Array.isArray(value.transactions)&&Array.isArray(value.redemptions)?value:null;
  } catch {return null;}
}
function fullRequired(row: SnapshotRow | null, state: SyncState, config: CacheConfig, now: number) {
  return !row || state.authorization_state!=='authorized' || state.next_private_sync_at<=now || row.invalidation_version!==state.invalidation_version || now>=Math.min(row.refresh_after,row.synced_at+config.privateTtlMs,row.hard_expires_at,row.synced_at+config.hardAgeMs);
}

/** A background financial refresh. It never refreshes the profile/group source age. */
export async function refreshRedemptionStatus(bindings:CacheBindings,principal:Principal,options:SyncOptions={}):Promise<SyncResult> {
  const result=(status:SyncResult['status'],errorCode?:string,needsFullSync=false):SyncResult=>({accountId:principal.accountId,mentorUserId:principal.mentorUserId,status,namespaces:['private'],refreshKind:'redemption_status',...(errorCode?{errorCode}:{}),...(needsFullSync?{needsFullSync:true}:{})});
  requireMentor(principal,'live');
  const config=cacheConfig(bindings),now=options.now??Date.now;
  if(!config.enabled)return result('disabled');
  if(bindings.PORTAL_MODE==='demo')return result('not_allowed');
  if(!await activeAccount(bindings,principal)){await denyAccountCache(bindings.DB,principal,now(),now()+config.privateTtlMs,'MENTOR_FORBIDDEN');return result('denied','MENTOR_FORBIDDEN');}
  const previous=await stateFor(bindings.DB,principal);
  if(previous?.authorization_state==='denied')return result('denied','MENTOR_FORBIDDEN');
  if(!previous||previous.next_redemption_sync_at===null||previous.next_redemption_sync_at>now())return result('not_due');
  const row=await snapshotFor(bindings.DB,principal,'private');
  if(fullRequired(row,previous,config,now())||!privateSnapshot(row))return result('not_due',undefined,true);
  const leaseMs=duration(options.leaseMs,120_000,1000,3_600_000),spacing=duration(options.minimumRequestIntervalMs,1100,0,60_000),retry=duration(options.retryDelayMs,15*60_000,1000,3_600_000);
  const lease=await claimLease(bindings.DB,principal,now(),leaseMs);
  if(!lease)return result('busy');
  try {
    const current=await snapshotFor(bindings.DB,principal,'private'),snapshot=privateSnapshot(current);
    if(fullRequired(current,lease.state,config,now())||!snapshot){await releaseLease(bindings.DB,principal,lease,now());return result('not_due',undefined,true);}
    if(lease.state.next_redemption_sync_at===null||lease.state.next_redemption_sync_at>now()){await releaseLease(bindings.DB,principal,lease,now());return result('not_due');}
    if(!hasUnsettledRedemptions(snapshot.redemptions)){
      await bindings.DB.prepare('UPDATE mentor_cache_sync_state SET next_redemption_sync_at=NULL WHERE account_id=? AND mentor_user_id=? AND lease_token=?').bind(principal.accountId,principal.mentorUserId,lease.token).run();
      await releaseLease(bindings.DB,principal,lease,now());return result('not_due');
    }
    const limits=syncLimits(options);limits.maxRequests=Math.min(limits.maxRequests,1+2*limits.maxPages);
    const source=sourceReader(bindings,principal,lease,options,limits,leaseMs,spacing);
    const financial=await collectRedemptionStatus(source,limits),finished=now();
    if(fullRequired(current,lease.state,config,finished)){await releaseLease(bindings.DB,principal,lease,finished);return result('not_due',undefined,true);}
    const updated:PrivateSnapshot={...snapshot,...financial,bootstrap:{...snapshot.bootstrap,balance:financial.balance},redemptionStatusSyncedAt:finished};
    boundedSnapshot(updated,limits.maxSnapshotBytes);
    if(!await publishRedemptionStatus(bindings.DB,principal,lease,current!,updated,finished)){
      // Only the still-current token can delay its own retry; a newer owner keeps its schedule.
      await recordRedemptionRefreshFailure(bindings.DB,principal,lease,finished,finished+REDEMPTION_REFRESH_INTERVAL_MS,'VERSION_CONFLICT');
      return result('superseded');
    }
    return {...result('synced'),syncedAt:new Date(finished).toISOString()};
  } catch(error) {
    if(error instanceof LostLease){await recordRedemptionRefreshFailure(bindings.DB,principal,lease,now(),now()+retry,'VERSION_CONFLICT');return result('superseded');}
    const safe=safeError(error);
    if(error instanceof MentorError&&SOURCE_AUTH_DENIALS.has(error.code)){await denyAccountCache(bindings.DB,principal,now(),now()+config.privateTtlMs,safe.code);return result('denied',safe.code);}
    await recordRedemptionRefreshFailure(bindings.DB,principal,lease,now(),now()+retry,safe.code);
    return result('failed',safe.code);
  }
}
