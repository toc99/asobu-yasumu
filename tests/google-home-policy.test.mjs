import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,timedEvents,restDeadline,quiet,approvalEvents,inventoryEvents,rewardEvents,allDoneEvents,eligibleNotice,MIN,routeTargets,knownSpeakers,deliverySummary,speakerIds} from '../google-home-policy.js';
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

test('game start, warning, due and forgotten use same session and no stale replay',()=>{
 const p={activeStart:at,startedAt:ts(at)},c=cfg(),profiles={older:p};
 for(const [offset,type] of [[0,'gameStart'],[55,'gameWarning'],[60,'gameDue'],[65,'forgotten']]){
  const event=timedEvents(profiles,{},c,at+offset*MIN).find(e=>e.type===type);
  assert.ok(event,type);assert.ok(eligibleNotice(event,c,at+offset*MIN));
 }
 assert.ok(!timedEvents(profiles,{},c,at+62*MIN).some(e=>e.type==='gameDue'));
 assert.ok(!timedEvents({older:{...p,activeStart:0}}, {},c,at+65*MIN).some(e=>e.type==='forgotten'));
});
test('video start and warning honor existing cycle usage',()=>{
 const p={videoStartedAt:ts(at),videoDurationMinutes:30,cycleVideoUsedMs:20*MIN};
 const profiles={younger:p},c=cfg();
 assert.ok(timedEvents(profiles,{},c,at).some(e=>e.type==='videoStart'));
 assert.ok(timedEvents(profiles,{},c,at+5*MIN).some(e=>e.type==='videoWarning'));
 assert.ok(timedEvents(profiles,{},c,at+10*MIN).some(e=>e.type==='videoDue'));
});
test('rest start and finish respect manual wait and revised deadline',()=>{
 const c=cfg(),p={restStart:at,restUntil:at+5*MIN,manualRestUntil:at+8*MIN,lastSessionId:'s'};
 assert.ok(timedEvents({older:p},{},c,at).some(e=>e.type==='restStart'));
 assert.ok(!timedEvents({older:p},{},c,at+5*MIN).some(e=>e.type==='restEnd'));
 assert.ok(timedEvents({older:p},{},c,at+8*MIN).some(e=>e.type==='restEnd'));
 const night=Date.parse('2026-11-23T21:50:00+09:00'),resume=Date.parse('2026-11-24T06:00:00+09:00'),end=Date.parse('2026-11-24T07:00:00+09:00');
 const settings={nightPause:{enabled:true,start:'22:00',end:'07:00',enabledAt:0}};
 assert.equal(restDeadline({restStart:night,restUntil:night+30*MIN,nightResumeAt:ts(resume),nightResumeWindowEnd:end},settings),resume+20*MIN);
});
test('bedtime once per JST day; quiet and per-type switch gate only automatic notifications',()=>{
 const c=cfg(),bed=Date.parse('2026-11-23T21:00:00+09:00'),late=Date.parse('2026-11-23T22:10:00+09:00');
 assert.ok(timedEvents({}, {},c,bed).some(e=>e.type==='bedtime'));
 const event={type:'bedtime',at:late};
 assert.equal(eligibleNotice(event,c,late),false);
 assert.equal(eligibleNotice({...event,type:'manual'},c,late),true);
 assert.equal(eligibleNotice({...event,type:'manual'},c,late+61000),false);
 assert.equal(eligibleNotice({type:'bedtime',at:bed},{...c,types:{...c.types,bedtime:false}},bed),false);
 assert.equal(eligibleNotice({type:'manual',at:bed},{...c,enabled:false},bed),false);
});
test('game reward and activity approval generate XP and Pokemon only for valid records',()=>{
 const r={kind:'rest_completed',childId:'older',pokemonNo:1,claimedAt:ts(at)};
 assert.deepEqual(rewardEvents('r',r,{}).map(e=>e.type),['pokemon','xp']);
 assert.deepEqual(rewardEvents('r',{...r,revoked:true},{}),[]);
 assert.deepEqual(rewardEvents('r',{...r,childId:'unknown'},{}),[]);
 const approval={childId:'older',status:'approved',activityKind:'study',slotNo:1,reviewedAt:ts(at)};
 assert.deepEqual(approvalEvents('a',approval,{}).map(e=>e.type),['activity','xp']);
 assert.deepEqual(approvalEvents('a',{...approval,status:'pending'},{}),[]);
});
test('all eleven approved activities must be on same reward day and child',()=>{
 const kinds=['study','reading','exercise','helping','cleaning','creating','practicing','trying','persevering','outingCalm','upstairs21'];
 const rows=kinds.map(activityKind=>({childId:'older',dayIndex:1,activityKind,status:'approved',reviewedAt:ts(at)}));
 assert.equal(allDoneEvents(rows,{}).length,1);
 assert.equal(allDoneEvents([...rows.slice(0,10),{...rows[10],activityKind:'kindness'}],{}).length,0);
 assert.equal(allDoneEvents([...rows.slice(0,10),{...rows[10],dayIndex:2}],{}).length,0);
 assert.equal(allDoneEvents([...rows.slice(0,10),{...rows[10],childId:'younger'}],{}).length,0);
});
test('inventory triggers evolution readiness and generation unlock from actual thresholds',()=>{
 const seen=Object.fromEntries(Array.from({length:29},(_,i)=>[i+1,true]));
 const before={buddyId:'a',experience:{a:79},owned:{1:'a'},reserved:{},seen,version:1};
 const after={...before,experience:{a:80},seen:{...seen,30:true},version:2};
 const types=inventoryEvents('older',before,after,{},at).map(e=>e.type);
 assert.ok(types.includes('level'));assert.ok(types.includes('evolveReady'));assert.ok(types.includes('generation'));
});

test('UUID routes replace common targets; legacy name remains fallback',()=>{
 const a='12345678-1234-1234-1234-123456789abc',b='22345678-1234-1234-1234-123456789abc';
 const c={speaker:'Living',speakerIds:[a,a,b,'invalid'],routes:{bedtime:b,manual:''}};
 assert.deepEqual(routeTargets(c,'gameDue').map(x=>x.id),[a,b]);
 assert.deepEqual(routeTargets(c,'bedtime').map(x=>x.id),[b]);
 assert.deepEqual(routeTargets(c,'manual').map(x=>x.id),[a,b]);
 assert.deepEqual(routeTargets({speaker:'Living'},'manual'),[{id:'',name:'Living'}]);
 assert.deepEqual(routeTargets({},'manual'),[]);
 assert.equal(speakerIds(Array.from({length:6},(_,i)=>i+a.slice(1))).length,5);
 assert.deepEqual(knownSpeakers([{id:a,name:'Living',online:true,host:'secret'},{id:a,name:'Duplicate'},{id:b,name:'Bedroom',online:false}]),[{id:a,name:'Living',online:true},{id:b,name:'Bedroom',online:false}]);
});
test('delivery result is partial if only some selected targets succeed',()=>{
 assert.deepEqual(deliverySummary([{result:'sent'},{result:'error',reason:'cast_error'}]),{result:'partial'});
 assert.deepEqual(deliverySummary([{result:'sent'},{result:'sent'}]),{result:'sent'});
 assert.deepEqual(deliverySummary([{result:'skipped',reason:'muted'}]),{result:'skipped',reason:'muted'});
 assert.equal(deliverySummary([]).result,'error');
});
