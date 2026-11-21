import test from 'node:test';
import assert from 'node:assert/strict';
import {canResumeInMorning} from '../early-resume-policy.js';
import {projectNextPlayableTime} from '../cycle-policy.js';
const min=60000;
const at=(day,time)=>Date.parse(day+'T'+time+':00+09:00');
test('前夜押下と深夜押下は不可、翌朝5時から終了まで可能',()=>{
  for(const t of ['22:00','23:59'])assert.equal(canResumeInMorning(at('2026-11-21',t),420),false,t);
  for(const t of ['00:00','04:59'])assert.equal(canResumeInMorning(at('2026-11-22',t),420),false,t);
  for(const t of ['05:00','05:59','06:59'])assert.equal(canResumeInMorning(at('2026-11-22',t),420),true,t);
  assert.equal(canResumeInMorning(at('2026-11-22','07:00'),420),false);
  assert.equal(canResumeInMorning(at('2026-11-22','05:30'),360),true);
  assert.equal(canResumeInMorning(at('2026-11-22','06:00'),360),false);
});
test('ゲーム・動画の終了予想は利用時間、切替、特例、手動待ちを含む',()=>{
  const now=Date.now(),plain=(start,ms)=>start+ms;
  assert.equal(projectNextPlayableTime(now,30*min,0,0,0,0,plain),now+30*min);
  assert.equal(projectNextPlayableTime(now,10*min,20*min,0,0,0,plain),now+30*min);
  assert.equal(projectNextPlayableTime(now,10*min,20*min,0,0,15*min,plain),now+45*min);
  assert.equal(projectNextPlayableTime(now,10*min,0,now+60*min,0,0,plain),now+60*min);
  assert.equal(projectNextPlayableTime(now,10*min,0,0,now+70*min,0,plain),now+70*min);
  assert.equal(projectNextPlayableTime(now,10*min,0,0,0,0,(start,ms)=>start+ms+60*min),now+70*min);
});
