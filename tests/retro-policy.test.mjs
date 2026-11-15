import test from 'node:test';
import assert from 'node:assert/strict';
import {sameRetroSession,unresolvedNotices,availablePenalty,RETRO_WINDOW_MS} from '../retro-policy.js';
const clock=v=>({toMillis:()=>v});
const t=1_800_000_000_000;
const rec=(id,child,when,status='counted',penaltyEventId='')=>({
  reportId:id,childId:child,reviewStatus:status,penaltyEventId,reviewedAt:clock(when)
});
test('a self report does not count until a parent explicitly confirms it',()=>{
  const items=[rec('r1','older',t-1000,'pending'),rec('r2','older',t-2000,'acknowledged')];
  assert.equal(unresolvedNotices(items,'older',t).length,0);
});
test('3 independent parent-reviewed notices in 30 days trigger one decision',()=>{
  const items=[rec('r1','older',t-3),rec('r2','older',t-2),rec('r3','older',t-1)];
  assert.equal(availablePenalty(items,'older',t).length,3);
  assert.equal(unresolvedNotices(items,'younger',t).length,0);
});
test('a settled or expired notice does not count',()=>{
  const items=[rec('r1','older',t-RETRO_WINDOW_MS-1),rec('r2','older',t-1000,'counted','release123'),
    rec('r3','older',t-900,'excused'),rec('r4','older',t-800,'counted')];
  assert.deepEqual(unresolvedNotices(items,'older',t).map(x=>x.reportId),['r4']);
});
test('retrospective corrections for the same session are deduplicated',()=>{
  const p={startedAt:clock(t-100),retroReportStartedAt:clock(t-100),retroReportId:'one'};
  assert.equal(sameRetroSession(p),true);
  assert.equal(sameRetroSession({...p,startedAt:clock(t+1)}),false);
});
