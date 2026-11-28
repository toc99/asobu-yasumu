import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseParentIdentities,parentNameFor,parentDisplayName,isParentIdentity} from '../parent-identities.js';
const raw={fatherUid:'father',motherUid:'mother',effectiveFrom:{toMillis:()=>1000}};
const d=parseParentIdentities(raw);
test('both parents are distinguished by UID after the activation timestamp',()=>{
  assert.equal(parentNameFor(d,'father',1000),'お父さん');
  assert.equal(parentNameFor(d,'mother',1001),'お母さん');
  assert.equal(parentDisplayName(d,'mother'),'お母さん');
  assert.equal(isParentIdentity(d,'father'),true);
  assert.equal(isParentIdentity(d,'mother'),true);
  assert.equal(isParentIdentity(d,'kid'),false);
});
test('old records, unknown actors and bad configuration remain generic',()=>{
  for(const uid of ['father','mother'])assert.equal(parentNameFor(d,uid,999),'保護者');
  assert.equal(parentNameFor(d,'kid',2000),'保護者');
  assert.equal(parentNameFor(d,'father',NaN),'保護者');
  assert.equal(parentNameFor(null,'father',2000),'保護者');
  assert.equal(parseParentIdentities({...raw,motherUid:'father'}),null);
  assert.equal(parseParentIdentities({...raw,effectiveFrom:undefined}),null);
});
test('approval, feedback and audit render the verified actor UID without changing record schemas',()=>{
  const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
  assert.match(read('app.js'),/parentName\(r.reviewedBy,stampMillis\(r.reviewedAt\)\)/);
  assert.match(read('app.js'),/parentName\(a.actorUid,created\)/);
  assert.match(read('feedback.js'),/parentName\(m.authorUid\)/);
  assert.match(read('app.js'),/parentName:actorUid=>parentDisplayName\(parentIdentities,actorUid\)/);
  assert.doesNotMatch(read('feedback.js'),/parentName\(m.authorUid,/);
  assert.match(read('sw.js'),/parent-identities\.js\?v=3\.28\.0/);
});

test('feedback account labels are independent of activation date or message timestamp',()=>{
  for(const [uid,label] of [['father','お父さん'],['mother','お母さん'],['unknown','保護者'],['','保護者']]){
    assert.equal(parentDisplayName(d,uid),label);
  }
  assert.equal(parentDisplayName(null,'father'),'保護者');
});
