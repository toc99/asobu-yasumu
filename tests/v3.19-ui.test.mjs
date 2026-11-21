import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const app=read('app.js'),rules=read('firestore.rules'),parent=read('parent.html'),kid=read('index.html');
test('ゲーム→動画の再開では残り動画枠を確認する',()=>{
  assert.match(app,/videoCycleRemaining\(current\)<=0/);
  assert.match(app,/videoCycleRemaining\(p,Number\(settingsSnap\.data\(\)\?\.videoLimitMinutes\)\|\|30\)<=0/);
  assert.match(app,/cycleVideoUsedMs:nextVideoUseMs/);
  assert.match(app,/videoDueMillis\(p,now=Date\.now\(\)\).*videoCycleRemaining\(p,videoLimitOf\(p\)\)/);
  assert.match(rules,/prev\.get\('cycleVideoUsedMs',0\)<configured\*60000/);
  assert.match(rules,/next\.get\('cycleVideoUsedMs',0\)==prev\.get\('cycleVideoUsedMs',0\)/);
});
test('サイクルの終了で動画枠をリセットする',()=>{
  assert.match(app,/cycleVideoUsedMs:0,\.\.\.\(special/);
  assert.match(app,/\(special\?\{cycleUsedMs:0,cycleVideoUsedMs:0/);
  assert.match(rules,/next\.get\('cycleUsedMs',0\)==0 && next\.get\('cycleVideoUsedMs',0\)==0/);
});
test('休憩上書きは保護者専用ダイアログで実行し利用履歴に触れない',()=>{
  assert.match(parent,/id="rest-override-dialog"/);
  assert.match(parent,/id="rest-override-minutes"/);
  assert.doesNotMatch(kid,/id="rest-override-dialog"/);
  assert.match(app,/if\(!isParentPage\|\|role!=='parent'\|\|!pendingRestOverride\)return;/);
  assert.match(app,/tx\.update\(ref,\{restStart:changedAt,restUntil:changedAt\+n\*MIN,/);
  assert.match(app,/manualRestUntil:0,manualRestMinutes:0/);
  assert.match(app,/appendAudit\(tx,'rest_override'/);
  assert.match(rules,/'rest_override'/);
});
