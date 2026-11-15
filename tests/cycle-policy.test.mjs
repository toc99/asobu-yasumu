import test from 'node:test';
import assert from 'node:assert/strict';
import {totalCycleUseMs,restEndWithDebt} from '../cycle-policy.js';

const at=1_800_000_000_000;
const min=60_000;
test('game then video then game counts all segments once',()=>{
  const first=totalCycleUseMs(0,10*min);
  const second=totalCycleUseMs(first,15*min);
  assert.equal(second,25*min);
  assert.equal(restEndWithDebt(0,at,second,5*min),at+30*min);
});
test('rest exception does not erase unserved rest: 20 old + 30 new -> 50',()=>{
  assert.equal(restEndWithDebt(at+15*min,at,0,30*min,20*min),at+50*min);
});
test('exception and mode switch preserve the same rest debt',()=>{
  assert.equal(restEndWithDebt(at+2*min,at,10*min,15*min,40*min),at+65*min);
});
test('previous raw rest end cannot be shortened',()=>{
  assert.equal(restEndWithDebt(at+80*min,at,5*min,10*min,20*min),at+80*min);
});
test('negative use and negative debt are rejected',()=>{
  assert.throws(()=>totalCycleUseMs(-1,0),RangeError);
  assert.throws(()=>restEndWithDebt(0,at,0,0,-1),RangeError);
});
