import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedVideoMillis,remainingVideoMs,nextVideoUseMs} from '../video-cycle-policy.js';
import {totalCycleUseMs,restEndWithDebt} from '../cycle-policy.js';
const min=60000;

test('動画20分→ゲーム→動画は残り10分しかない',()=>{
  let video=recordedVideoMillis({});
  video=nextVideoUseMs(video,20*min,true); // video -> game
  const cycle=totalCycleUseMs(20*min,10*min); // game 10 minutes
  video=nextVideoUseMs(video,10*min,false); // game -> video, allowance unchanged
  assert.equal(video,20*min);
  assert.equal(remainingVideoMs(30,video),10*min);
  assert.equal(cycle,30*min);
});

test('動画30分→ゲーム→動画はブロック。休憩の時間にはゲーム分も入る',()=>{
  const video=nextVideoUseMs(0,30*min,true);
  assert.equal(remainingVideoMs(30,video),0);
  assert.equal(remainingVideoMs(30,video+min),0);
  assert.equal(restEndWithDebt(0,100000,30*min,10*min),100000+40*min);
  assert.equal(recordedVideoMillis({cycleVideoUsedMs:0}),0); // cycle reset after final stop
  assert.equal(remainingVideoMs(30,0),30*min);
});

test('動画を何度切り替えても累積し、次の表示は残り枠で計算する',()=>{
  const video=nextVideoUseMs(nextVideoUseMs(0,12*min,true),18*min,true);
  assert.equal(video,30*min);
  assert.equal(remainingVideoMs(30,video),0);
  assert.equal(remainingVideoMs(30,20*min+30000),9*min+30000);
});

test('不正な残り時間や利用時間を受け入れない',()=>{
  assert.throws(()=>remainingVideoMs(0,0),RangeError);
  assert.throws(()=>remainingVideoMs(30,-1),RangeError);
  assert.throws(()=>nextVideoUseMs(0,-1,true),RangeError);
});
