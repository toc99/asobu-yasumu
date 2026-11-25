import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const rules=read('../firestore.rules'),app=read('../app.js'),notes=read('../release-notes.js');
test('night resume permission route precedes expensive general profile validators',()=>{
  const profileRules=rules.slice(rules.indexOf('match /profiles/{playerId}'));
  const early=profileRules.indexOf('validKidNightResume(h, playerId)');
  const general=profileRules.indexOf('validKidFavoriteTeamUpdate()');
  assert.ok(early>=0 && general>early);
  assert.match(rules,/prev\.get\('videoStartedAt',null\) == null\s*&& inConfiguredNight\(h,now\)/);
});
test('night resume keeps audit, morning-only and anti-shortening validation',()=>{
  assert.match(app,/appendAudit\(tx,'night_resume'/);
  assert.match(rules,/localMillisOfDay\(now\) >= 18000000/);
  assert.match(rules,/next\.manualRestUntil >= manualExpected - 30000/);
  assert.match(rules,/prev\.get\('nightResumeWindowEnd',0\) != morning/);
});
test('both app entry points are versioned and release notes are updated',()=>{
  for(const path of ['../index.html','../parent.html','../sw.js']){
    assert.match(read(path),/3\.25\.1/);
  }
  assert.match(notes,/APP_VERSION = 'v3\.25\.1'/);
});
