import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
function extractCatalog(name){
  const rx=new RegExp('const '+name+' = Object\\.freeze\\((\\{[\\s\\S]*?\\})\\);');
  const match=app.match(rx);
  assert.ok(match,'catalog '+name+' present');
  return Function('return ('+match[1]+');')();
}
const junior=extractCatalog('JUNIOR_ACTIVITIES');
const standard=extractCatalog('ACTIVITY_KINDS');
const legacy=extractCatalog('LEGACY_ACTIVITY_KINDS');

test('exactly 11 active activities including new outing and excluding retired kindness',()=>{
  assert.equal(Object.keys(standard).length,11);
  assert.equal(standard.outingCalm,'お出かけの時に落ち着いて行動できた');
  assert.equal(Object.hasOwn(standard,'kindness'),false);
});

test('age 7 and younger see a short, accessible hiragana label',()=>{
  assert.equal(junior.outingCalm.label,'おでかけで おちついて すごせた');
  assert.equal(Object.keys(junior).length,11);
  assert.deepEqual(Object.keys(junior).sort(),Object.keys(standard).sort());
  assert.ok(app.includes('const JUNIOR_MAX_AGE = 7;'));
  assert.ok(app.includes("age<=JUNIOR_MAX_AGE?'junior':'standard'"));
});

test('retired kindness remains labelled correctly in history',()=>{
  assert.equal(legacy.kindness,'誰かを助けた');
  assert.ok(app.includes('function activityKindLabel(kind){return ACTIVITY_KINDS[kind]||LEGACY_ACTIVITY_KINDS[kind]||kind;}'));
  assert.ok(!Object.hasOwn(junior,'kindness'));
});

test('Firestore Rules permit outing but reject newly created kindness requests',()=>{
  assert.match(rules,/function validActivityKind\(kind\)[\s\S]*'kindness','outingCalm','upstairs21'/);
  assert.match(rules,/function validKidActivityRequest\(h, id\)[\s\S]*?d\.activityKind != 'kindness'/);
  assert.match(rules,/function validParentActivityReward\(h, rewardId\)[\s\S]*?validActivityKind\(d\.activityKind\)/);
});

test('reward and daily cap remain unchanged',()=>{
  assert.match(app,/const ACTIVITY_POKEMON_MAX = 5;/);
  assert.match(app,/const ACTIVITY_DAILY_MAX = Object\.keys\(ACTIVITY_KINDS\)\.length;/);
  assert.match(rules,/d\.slotNo in \[1,2,3,4,5,6,7,8,9,10,11\]/);
});
