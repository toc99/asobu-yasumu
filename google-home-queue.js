// Notification queue policy. No network or game-data writes.
import {eligibleNotice,routeTargets,timedEvents} from './google-home-policy.js';
export const MAX_PENDING=100;
const limits={manual:120000,gameStart:30000,videoStart:30000,gameWarning:45000,videoWarning:45000,gameDue:120000,videoDue:120000,gameElapsed:120000,videoElapsed:120000,forgotten:90000,restStart:45000,restEnd:180000,bedtime:120000};
const ranks={manual:0,gameDue:1,videoDue:1,forgotten:1,bedtime:1,gameWarning:2,videoWarning:2,gameElapsed:2,videoElapsed:2,restEnd:2,gameStart:3,videoStart:3,restStart:3};
const rewardTypes=new Set(['pokemon','activity','xp','level','evolveReady','allDone','generation']);
export const lifetime=e=>limits[e.type]??180000;
export const priority=e=>ranks[e.type]??4;
export const scheduled=e=>Object.hasOwn(limits,e.type)&&e.type!=='manual';
export function liveEvent(e,c,profiles,settings,now){
 if(!eligibleNotice(e,c,now,lifetime(e)))return null;
 if(!scheduled(e))return e;
 const live=timedEvents(profiles,settings,c,now,lifetime(e)+1).find(x=>x.key===e.key);
 // Pause, corrected deadline, undo, or mode switch invalidates the original notice.
 if(!live||Math.abs(live.at-e.at)>1000)return null;
 if((e.type==='gameWarning'||e.type==='videoWarning')&&now>=live.at+c.warningMinutes*60000)return null;
 return {...e,text:live.text};
}
export function sortedQueue(entries){return [...entries].sort((a,b)=>priority(a)-priority(b)||a.at-b.at||a.key.localeCompare(b.key));}
export function validQueued(e,now){
 return !!e&&typeof e.key==='string'&&e.key.length<=200&&typeof e.text==='string'&&e.text.length>0&&e.text.length<=160&&
 (Object.hasOwn(limits,e.type)||rewardTypes.has(e.type))&&Number.isFinite(e.at)&&e.at>0&&e.at<=now+10000&&now-e.at<=lifetime(e);
}
const routeKey=(c,e)=>JSON.stringify(routeTargets(c,e.type).map(t=>t.id||'name:'+t.name).sort());
export function batchFor(first,entries,c){
 const batch=[first];let text=first.text;
 if(!rewardTypes.has(first.type)||!first.childId)return {batch,text};
 for(const e of sortedQueue(entries)){
  if(batch.length>=4||e.key===first.key||!rewardTypes.has(e.type)||e.childId!==first.childId||Math.abs(e.at-first.at)>5000||routeKey(c,e)!==routeKey(c,first))continue;
  const phrase=e.text.startsWith(first.text.split('、')[0]+'、')?e.text.slice(e.text.indexOf('、')+1):e.text;
  if((text+' '+phrase).length>160)continue;
  batch.push(e);text+=' '+phrase;
 }
 return {batch,text};
}
// Only discovery failure occurs before a media LOAD; ambiguous playback failures never retry.
export const safeRetry=r=>r?.result==='error'&&r.reason==='speaker_not_unique';
export function queueView(entries,active,now){
 return {version:1,waiting:entries.length,active:active?active.batch.length:0,types:sortedQueue(entries).slice(0,10).map(e=>e.type),activeTypes:active?active.batch.map(e=>e.type):[],at:now};
}
