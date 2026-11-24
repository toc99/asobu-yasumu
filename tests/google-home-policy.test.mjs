import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,timedEvents,restDeadline,quiet,approvalEvents,inventoryEvents,MIN} from '../google-home-policy.js';
const ts=n=>({toMillis:()=>n});
const at=Date.parse('2026-11-23T15:00:00+09:00');
const cfg=()=>({...defaultConfig(),enabled:true,types:Object.fromEntries(Object.keys(defaultConfig().types).map(k=>[k,true]))});
test('game warnings follow configured time and pause accounting',()=>{
 const c=cfg(),p={activeStart:at,startedAt:ts(at),pauseCount:1,pauseTotalMs:5*MIN,pauseStartedAt:null};
 assert.ok(timedEvents({older:p},{},c,at+60*MIN).some(x=>x.type==='gameWarning'));
 assert.ok(timedEvents({older:p},{},c,at+65*MIN).some(x=>x.type==='gameDue'));
 assert.ok(!timedEvents({older:{...p,pauseStartedAt:ts(at+59*MIN)}},{},c,at+65*MIN).some(x=>x.type==='gameDue'));
});
test('video deadline honors accumulated video time',()=>{
 const p={videoStartedAt:ts(at),videoDurationMinutes:30,cycleVideoUsedMs:20*MIN};
 assert.ok(timedEvents({older:p},{},cfg(),at+10*MIN).some(x=>x.type==='videoDue'));
});
test('night carryover rest deadline and manual override',()=>{
 const t=Date.parse('2026-11-23T21:50:00+09:00');
 const s={nightPause:{enabled:true,start:'22:00',end:'07:00',enabledAt:0}};
 assert.equal(restDeadline({restStart:t,restUntil:t+30*MIN},s),Date.parse('2026-11-24T07:20:00+09:00'));
 assert.equal(restDeadline({restStart:t,restUntil:t+5*MIN,manualRestUntil:t+10*MIN},s),t+10*MIN);
 assert.equal(quiet(cfg(),Date.parse('2026-11-24T06:00:00+09:00')),true);
});
test('historical XP stays 2, new award 5',()=>{
 const r={status:'approved',childId:'older',slotNo:6,reviewedAt:ts(at)};
 assert.match(approvalEvents('a',r,{})[1].text,/2ポイント/);
 assert.match(approvalEvents('a',{...r,awardedXp:5},{})[1].text,/5ポイント/);
});
test('level up generated only for same buddy on XP increase',()=>{
 const before={buddyId:'a',experience:{a:19},owned:{1:'a'},seen:{1:true},version:1};
 const after={...before,experience:{a:20},version:2};
 assert.equal(inventoryEvents('older',before,after,{},at)[0].type,'level');
});
