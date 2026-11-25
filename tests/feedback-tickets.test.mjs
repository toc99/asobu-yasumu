import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const file = name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const source=file('feedback.js');
const rules=file('firestore.rules');
const child=file('index.html');
const parent=file('parent.html');
const app=file('app.js');
const style=file('style.css');
const notes=file('release-notes.js');

test('parent feedback is a dedicated fifth tab and remains reachable from home',()=>{
  assert.match(parent,/data-parent-view="feedback"/);
  assert.match(parent,/id="parent-pane-feedback"/);
  assert.match(parent,/id="feedback-admin"/);
  assert.match(parent,/data-focus-target="feedback-admin" data-parent-view="feedback"/);
  assert.match(app,/PARENT_VIEWS=\['home','actions','feedback','reports','more','updates'\]/);
  const nav=parent.match(/id="parent-primary-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav);
  assert.equal((nav[1].match(/<button/g)||[]).length,5);
});

test('status, issuer, type, scope and keyword filters are available',()=>{
  for(const id of ['scope','child','status','type','keyword','reset'])
    assert.match(parent,new RegExp('id="feedback-filter-'+id+'"'));
  assert.match(source,/parentFilters=\{scope:'active',child:'all',type:'all',status:'all',keyword:''\}/);
  assert.match(parent,/value="archived"/);
  assert.match(parent,/value="all">すべて/);
});

test('child must accept a done/declined ticket before it disappears from active list',()=>{
  assert.match(child,/id="feedback-kid-archive-toggle"/);
  assert.match(source,/const archived=r=>r\.closed===true/);
  assert.match(source,/const isPendingChild=r=>!archived\(r\)&&\(r\.status==='done'\|\|r\.status==='declined'\)/);
  assert.match(source,/data-feedback-accept/);
  assert.match(source,/closed:true,closedAt:dbApi\.serverTimestamp\(\),closedBy:uid/);
  assert.match(rules,/function validKidFeedbackAck\(\)/);
  assert.match(rules,/prev\.status in \['done','declined'\]/);
  assert.match(rules,/next\.closed == true && next\.closedAt == request\.time/);
});

test('replies use an append-only transaction and retain existing legacy replies',()=>{
  assert.match(source,/runTransaction\(db,async tx=>/);
  assert.match(source,/messages:\[\.\.\.old,msg\]/);
  assert.match(source,/if\(r\.parentReply\)/);
  assert.match(source,/if\(d\.closed===true\)throw/);
  assert.match(rules,/function validFeedbackAppendedMessage\(roleName\)/);
  assert.match(rules,/after\.size\(\) == before\.size\(\)\+1/);
  assert.match(rules,/after == before\.concat\(\[message\]\)/);
  assert.match(rules,/message\.authorUid == request\.auth\.uid/);
  assert.match(rules,/message\.text\.size\(\) <= 500/);
  assert.match(rules,/before\.size\(\) < 100/);
});

test('only a parent can physically delete a ticket and its in-document conversation',()=>{
  assert.match(rules,/match \/feedbackReports\/\{reportId\} \{[\s\S]*allow delete: if isParent\(h\);/);
  assert.match(source,/role!=='parent'\|\|busy/);
  assert.match(source,/prompt\('完全削除する場合だけ「削除」と入力してください。'\)/);
  assert.match(source,/await dbApi\.deleteDoc\(ticketRef\(reportId\)\)/);
  assert.doesNotMatch(source,/feedbackMessages/);
});

test('parent message can reopen from a proposed resolution; archive reopens by parent status',()=>{
  assert.match(source,/if\(role==='kid'&&\['done','declined'\]\.includes\(d\.status\)\)update\.status='reviewing'/);
  assert.match(source,/if\(row\.closed===true\)\{patch\.closed=false;patch\.closedAt=null;patch\.closedBy='';\}/);
  assert.match(rules,/validKidFeedbackMessage\(\) \|\| validKidFeedbackAck\(\)/);
  assert.match(rules,/validParentFeedbackMessage\(\) \|\| validParentFeedbackStatus\(\)/);
});

test('migration is unnecessary and original ticket creation remains compatible',()=>{
  assert.match(source,/parentReply:'',reviewedBy:'',reviewedAt:null,createdBy:uid,createdAt:dbApi\.serverTimestamp\(\)/);
  assert.match(rules,/request\.resource\.data\.keys\(\)\.hasOnly\(\[\s*'childId','type','title','description','status'/);
  assert.match(source,/Array\.isArray\(r\.messages\)\?r\.messages:\[\]/);
  assert.match(source,/const archived=r=>r\.closed===true/);
  assert.match(source,/dbApi\.orderBy\('createdAt','desc'\)/);
});

test('release, navigation and PWA cache agree on v3.24.0',()=>{
  assert.match(notes,/APP_VERSION = 'v3\.24\.0'/);
  assert.match(child,/v3\.24\.0/);
  assert.match(parent,/v3\.24\.0/);
  assert.match(app,/feedback\.js\?v=3\.24\.0/);
  assert.match(file('sw.js'),/asobu-yasumu-v3-24-0/);
  assert.match(style,/ui-primary-nav\.parent-nav\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
});
