import test from 'node:test';
import assert from 'node:assert/strict';
import {effectivePausedMillis} from '../pause-timing.js';

const now = 1_800_000_000_000;
const timestamp = t => ({toMillis: () => t});
const wallMs = 15 * 60_000;
const duration = (profile, start, end) => Math.max(0, end - start - effectivePausedMillis(profile,end));

test('ordinary video end: no pause state', () => {
  assert.equal(effectivePausedMillis({},now),0);
  assert.equal(duration({},now-wallMs,now),wallMs);
});
test('legacy zero-pause profile ignores residual pauseTotalMs', () => {
  const legacy = {pauseCount:0,pauseTotalMs:10*60_000,pauseStartedAt:null};
  assert.equal(effectivePausedMillis(legacy,now),0);
  assert.equal(duration(legacy,now-wallMs,now),wallMs);
});
test('initial profile without pause fields behaves as unpaused', () => {
  const p = {pauseStartedAt:null,pauseTotalMs:undefined,pauseCount:undefined};
  assert.equal(duration(p,now-wallMs,now),wallMs);
});
test('a currently paused video subtracts accumulated and ongoing pause', () => {
  const profile={pauseCount:2,pauseTotalMs:60_000,pauseStartedAt:timestamp(now-2*60_000)};
  assert.equal(effectivePausedMillis(profile,now),3*60_000);
  assert.equal(duration(profile,now-wallMs,now),12*60_000);
});
test('resumed video subtracts the accumulated pause only', () => {
  const profile={pauseCount:1,pauseTotalMs:90_000,pauseStartedAt:null};
  assert.equal(effectivePausedMillis(profile,now),90_000);
  assert.equal(duration(profile,now-wallMs,now),wallMs-90_000);
});
test('future pause timestamps never produce negative paused duration', () => {
  const profile={pauseCount:1,pauseTotalMs:30_000,pauseStartedAt:timestamp(now+30_000)};
  assert.equal(effectivePausedMillis(profile,now),30_000);
});
test('zero pause count does not inherit a dangling pause timestamp', () => {
  const profile={pauseCount:0,pauseTotalMs:30_000,pauseStartedAt:timestamp(now-60_000)};
  assert.equal(effectivePausedMillis(profile,now),0);
});
test('a subsequent clean video session does not inherit prior pause', () => {
  const prev={pauseCount:3,pauseTotalMs:180_000,pauseStartedAt:null};
  const fresh={...prev,pauseCount:0,pauseTotalMs:0,pauseStartedAt:null};
  assert.equal(duration(fresh,now-wallMs,now),wallMs);
});
