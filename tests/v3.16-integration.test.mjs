import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const app=read('app.js'),rules=read('firestore.rules'),index=read('index.html'),parent=read('parent.html');
test('ordinary and paused video both use zero-or-positive pause fields and one Rules validator',()=>{
  assert.match(app,/createdBy:uid,edited:false,pauseMs,pauseCount/);
  assert.match(rules,/d\.pauseCount == 0 \? d\.pauseMs == 0 :/);
  assert.match(rules,/function validKidPausedVideoEnd/);
});
test('night banner is hidden unless there is actual carryover',()=>{
  assert.match(app,/e\.classList\.toggle\('hidden',entries\.length===0\)/);
  assert.doesNotMatch(app,/夜間持ち越し設定：\$\{displayTimeRange\(\)\}/);
});
test('special rest and switch endpoints guarded by limited profile fields',()=>{
  for(const helper of ['validKidExceptionStart','validKidCycleSwitch','validKidCycleSwitchSession','validKidSpecialEnd','validKidSpecialSession'])
    assert.ok(rules.includes('function '+helper+'('));
  assert.match(rules,/hasAny\(\['lastSwitchSessionId'\]\)/);
  assert.match(rules,/specialRestDebt\(prev\)/);
  assert.match(rules,/session\.data\.get\('exceptionPlay',false\) == false/);
});
test('kids cannot issue parent exception grants and UI controls are role-specific',()=>{
  assert.match(app,/if\(!isParentPage\|\|!ids\.includes\(id\)\|\|!canOperate\(\)\)return;/);
  assert.match(app,/async function grantRestException/);
  assert.match(app,/async function switchUseMode/);
  assert.match(app,/data-switch-mode/);
  assert.match(parent,/id="parent-dashboard-cards"/);
  assert.match(index,/id="players"/);
});
