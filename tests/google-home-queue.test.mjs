import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {defaultConfig,timedEvents,MIN} from '../google-home-policy.js';
import {MAX_PENDING,lifetime,validQueued,sortedQueue,liveEvent,batchFor,safeRetry,queueView} from '../google-home-queue.js';
const at=Date.parse('2026-11-25T15:00:00+09:00');
const ts=t=>({toMillis:()=>t});
const cfg=()=>({...defaultConfig(),enabled:true,speaker:'Living',types:Object.fromEntries(Object.keys(defaultConfig().types).map(k=>[k,true]))});
const e=(type,key,childId='older',time=at,text='子ども1、通知です。')=>({type,key,childId,at:time,text});
test('manual, due, warnings, start, then rewards; FIFO within rank',()=>{
 const events=[e('pokemon','p'),e('gameStart','s'),e('videoWarning','w'),e('manual','m2','',at+1),e('gameDue','d'),e('manual','m1')];
 assert.deepEqual(sortedQueue(events).map(x=>x.key),['m1','m2','d','w','s','p']);
 assert.equal(MAX_PENDING,100);
});
test('each notification has a finite expiry; malformed and stale entries are rejected',()=>{
 for(const type of ['manual','gameWarning','gameDue','restEnd','pokemon']){
  const n=e(type,type);assert.equal(validQueued(n,at+lifetime(n)),true);assert.equal(validQueued(n,at+lifetime(n)+1),false);
 }
 assert.equal(validQueued(e('unknown','x'),at),false);
 assert.equal(validQueued(e('manual','m','',at,'x'.repeat(161)),at),false);
});
test('late timed notification remains valid within its own lifetime, but a stopped or paused game cancels it',()=>{
 const p={activeStart:at-60*MIN,startedAt:ts(at-60*MIN)},c=cfg();
 const due=timedEvents({older:p},{},c,at).find(x=>x.type==='gameDue');
 assert.ok(due);
 assert.ok(liveEvent(due,c,{older:p},{},at+65000));
 assert.equal(liveEvent(due,c,{older:{...p,activeStart:0}},{},at+65000),null);
 assert.equal(liveEvent(due,c,{older:{...p,pauseStartedAt:ts(at+1000)}},{},at+65000),null);
 assert.equal(liveEvent(due,{...c,gameMinutes:65},{older:p},{},at+65000),null);
 assert.equal(liveEvent(due,{...c,types:{...c.types,gameDue:false}},{older:p},{},at+1000),null);
});
test('quiet hours and global disable apply immediately; manual bypasses quiet only',()=>{
 const c=cfg(),night=Date.parse('2026-11-25T23:00:00+09:00');
 assert.equal(liveEvent(e('pokemon','p','older',night),c,{}, {},night),null);
 assert.ok(liveEvent(e('manual','m','',night),c,{}, {},night));
 assert.equal(liveEvent(e('manual','m','',night),{...c,enabled:false},{},{},night),null);
});
test('group only nearby rewards for same child and identical speaker set, max four and 160 chars',()=>{
 const a='12345678-1234-1234-1234-123456789abc',b='22345678-1234-1234-1234-123456789abc';
 const c={...cfg(),speakerIds:[a,b],routes:{xp:[b,a].join(','),generation:b}};
 const first=e('activity','a','older',at,'子ども1、勉強が承認されたよ！');
 const events=[first,e('xp','x','older',at+1000,'子ども1、経験値10ポイント。'),e('level','l','younger'),e('generation','g'),e('pokemon','old','older',at-6000),e('manual','m'),e('allDone','long','older',at,'あ'.repeat(160))];
 const result=batchFor(first,events,c);
 assert.deepEqual(result.batch.map(x=>x.key),['a','x']);
 assert.equal(result.text,'子ども1、勉強が承認されたよ！ 経験値10ポイント。');
 assert.equal(batchFor(events[5],events,c).batch.length,1);
 assert.equal(batchFor(first,[first,...Array.from({length:8},(_,i)=>e('level','l'+i))],cfg()).batch.length,4);
});
test('only discovery failures can retry; playback errors, muted, and ambiguous timeout never retry',()=>{
 assert.equal(safeRetry({result:'error',reason:'speaker_not_unique'}),true);
 for(const reason of ['receiver_no_start','receiver_no_finish','timeout','cast_error','media_busy','muted','process_error'])assert.equal(safeRetry({result:'error',reason}),false);
 assert.equal(safeRetry({result:'skipped',reason:'speaker_not_unique'}),false);
});
test('queue status does not expose message text or child identities',()=>{
 const first=e('manual','m','',at,'private message');
 const q=queueView([first,e('pokemon','p')],{batch:[e('activity','a'),e('xp','x')]},at);
 assert.deepEqual(q,{version:1,waiting:2,active:2,types:['manual','pokemon'],activeTypes:['activity','xp'],at});
 assert.ok(!JSON.stringify(q).includes('private'));
});
test('bridge capture loop is independent of playback and UI submits unique command documents',()=>{
 const bridge=readFileSync(new URL('../google-home/bridge.mjs',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../google-home-ui.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../parent.html',import.meta.url),'utf8');
 assert.match(bridge,/function pump\(\)/);
 assert.match(bridge,/void deliver\(\)\.catch/);
 assert.match(bridge,/saved\.pending=\[\.\.\.pending\.values\(\)\]/);
 assert.match(bridge,/for\(const e of batch\)\{pending\.delete\(e\.key\);remember\(e\);\}/);
 assert.match(ui,/'googleHomeCommands',id/);
 assert.match(html,/id="gh-queue-state"/);
});
