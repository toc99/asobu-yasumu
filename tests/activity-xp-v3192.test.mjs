import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
const app=read('app.js'),rules=read('firestore.rules');
const notes=read('release-notes.js'),sw=read('sw.js');

test('later activity awards 5 XP, initial activities stay 10 XP and games stay 5 XP',()=>{
  assert.match(app,/const ACTIVITY_EXTRA_XP = 5;/);
  assert.match(app,/const BUDDY_XP_PER_ACTIVITY=10, BUDDY_XP_PER_GAME=5/);
  assert.match(app,/buddyXpUpdate\(inventory,ACTIVITY_EXTRA_XP\)/);
  assert.match(app,/awardedXp:ACTIVITY_EXTRA_XP/);
  assert.match(app,/6件目以降は相棒5 XP/);
});

test('approved historical requests display original 2 XP while pending/new display 5 XP',()=>{
  assert.match(app,/const ACTIVITY_LEGACY_EXTRA_XP = 2;/);
  assert.match(app,/function activityXpAmount\(request\)/);
  assert.match(app,/request\?\.status==='approved'/);
  assert.match(app,/Number\(request\.awardedXp\)===ACTIVITY_EXTRA_XP\?ACTIVITY_EXTRA_XP:ACTIVITY_LEGACY_EXTRA_XP/);
  assert.match(app,/activityXpAmount\(r\)/);
  assert.match(app,/activityXpAmount\(req\)/);
  assert.doesNotMatch(app,/相棒 \+2 XP|相棒2 XP|あいぼうに \+2 XP/);
});

test('Firestore XP credit matches the approval record and supports old cached clients',()=>{
  assert.match(rules,/let xpGrant = next\.keys\(\)\.hasAny\(\['awardedXp'\]\) \? 5 : 2/);
  assert.match(rules,/validInventoryXpCredit\(h,prev\.childId,xpGrant\)/);
  assert.match(rules,/next\.get\('awardedXp',0\) == 5/);
  assert.match(rules,/next\.diff\(prev\)\.affectedKeys\(\)\.hasOnly\(\['status','reviewedAt','reviewedBy','awardedXp'\]\)/);
});

test('release notes and service worker identify v3.21.2',()=>{
  assert.match(notes,/APP_VERSION = 'v3\.21\.2'/);
  assert.match(notes,/version:'v3\.19\.2',title:'6件目以降/);
  assert.match(sw,/asobu-yasumu-v3-21-2-google-home/);
  for(const f of ['index.html','parent.html','app.js'])
    assert.match(read(f),/3\.21\.2/);
});
