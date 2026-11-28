import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,timedEvents,MIN,routeTargets,eligibleNotice,ROUTE_TYPES} from '../google-home-policy.js';
import {validQueued,liveEvent,lifetime} from '../google-home-queue.js';
const start=Date.parse('2026-11-28T10:00:00+09:00');
const ts=n=>({toMillis:()=>n});
const c={...defaultConfig(),enabled:true,types:{...defaultConfig().types,gameElapsed:true,videoElapsed:true}};
const game={activeStart:start,startedAt:ts(start)};
const video={videoStartedAt:ts(start),videoDurationMinutes:30,cycleVideoUsedMs:25*MIN};
const elapsed=(p,n,cfg=c)=>timedEvents({older:p},{},cfg,start+n*MIN).filter(e=>e.type.endsWith('Elapsed'));
test('one milestone per actual session hour, not daily accumulation or configured deadline',()=>{
 for(const [p,type] of [[game,'gameElapsed'],[video,'videoElapsed']]){
  assert.equal(elapsed(p,59).length,0);
  const events=[60,120,180].map((n,i)=>{
   const [e]=elapsed(p,n);assert.equal(e.type,type);assert.equal(e.at,start+n*MIN);assert.match(e.text,new RegExp((i+1)+'時間'));return e;
  });
  assert.equal(new Set(events.map(e=>e.key)).size,3);
  assert.equal(elapsed(p,60.5)[0].key,events[0].key);
  assert.equal(elapsed(p,63).length,0);
  assert.equal(elapsed(p,181)[0].key,events[2].key);
 }
});
test('paused time excluded, no notification while paused, reset on finish or new mode',()=>{
 const paused={...game,pauseCount:1,pauseTotalMs:10*MIN,pauseStartedAt:null};
 assert.equal(elapsed(paused,60).length,0);
 assert.equal(elapsed(paused,70)[0].at,start+70*MIN);
 assert.equal(elapsed({...game,pauseCount:1,pauseStartedAt:ts(start+59*MIN)},70).length,0);
 const vp={...video,pauseCount:1,pauseTotalMs:10*MIN,pauseStartedAt:null};
 assert.equal(elapsed(vp,70)[0].type,'videoElapsed');
 assert.equal(elapsed({},120).length,0);
 assert.equal(elapsed({videoStartedAt:ts(start+60*MIN)},119).length,0);
});
test('independent switches, existing routes, quiet hours and stale queue protection',()=>{
 assert.equal(defaultConfig().types.gameElapsed,false);
 assert.equal(defaultConfig().types.videoElapsed,false);
 assert.ok(ROUTE_TYPES.gameElapsed&&ROUTE_TYPES.videoElapsed);
 assert.equal(elapsed(game,60,defaultConfig()).length,0);
 assert.equal(elapsed(video,60,{...c,types:{...c.types,videoElapsed:false}}).length,0);
 const [e]=elapsed(game,60),now=e.at;
 assert.equal(lifetime(e),120000);assert.ok(validQueued(e,now));
 assert.ok(liveEvent(e,c,{older:game},{},now));
 assert.equal(liveEvent(e,c,{older:{}},{},now),null);
 assert.equal(liveEvent(e,c,{older:video},{},now),null);
 assert.equal(liveEvent(e,c,{older:game},{},now+120001),null);
 assert.equal(liveEvent(e,{...c,types:{...c.types,gameElapsed:false}},{older:game},{},now),null);
 assert.equal(eligibleNotice(e,{...c,quietStart:'10:00',quietEnd:'12:00'},now,120000),false);
 const a='12345678-1234-1234-1234-123456789abc',b='22345678-1234-1234-1234-123456789abc';
 assert.equal(routeTargets({...c,speakerIds:[a],routes:{gameElapsed:b}},'gameElapsed')[0].id,b);
 assert.equal(routeTargets({...c,speakerIds:[a],routes:{gameElapsed:b}},'videoElapsed')[0].id,a);
});
