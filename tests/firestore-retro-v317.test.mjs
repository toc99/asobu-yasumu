import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {collection,doc,getDoc,getDocs,runTransaction,serverTimestamp,setDoc,Timestamp,updateDoc} from 'firebase/firestore';

const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
const projectId='demo-asobu-v316';
if(!process.env.FIRESTORE_EMULATOR_HOST){
  test('Firestore Rules retro integration requires emulator',{skip:true},()=>{});
}else{
  const env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8080,rules}});
  after(async()=>env.cleanup());
  const kid=env.authenticatedContext('kid-user'),parent=env.authenticatedContext('parent-user');
  const ref=(db,h)=>doc(db,'households',h,'profiles','older');
  const report=(db,h,id)=>doc(db,'households',h,'retroReports',id);
  async function seed(h,profile={}){
    await env.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'members','kid-user'),{role:'kid'});
      await setDoc(doc(db,'households',h,'members','parent-user'),{role:'parent'});
      await setDoc(ref(db,h),{
        activeStart:0,deviceId:null,startedAt:null,endedAt:null,
        videoStartedAt:null,restStart:0,restUntil:0,manualRestUntil:0,
        lastDuration:0,lastSessionId:'',updatedAt:Timestamp.fromMillis(Date.now()),...profile
      });
    });
  }
  function audit(tx,db,h,action,reportId){
    tx.set(doc(collection(db,'households',h,'auditLogs')),{action,childId:'older',
      actorUid:'kid-user',actorRole:'kid',createdAt:serverTimestamp(),
      before:'old',after:'new',sessionId:reportId});
  }
  async function kidBackdate(h,reportId,source='self'){
    const db=kid.firestore(),pRef=ref(db,h),rRef=report(db,h,reportId);
    await runTransaction(db,async tx=>{
      const p=await tx.get(pRef),now=Date.now(),start=now-180000;
      assert.ok(p.exists());
      tx.update(pRef,{
        activeStart:start,deviceId:'sw1',startedAt:serverTimestamp(),endedAt:null,
        retroReportId:reportId,retroReportStartedAt:serverTimestamp(),updatedAt:serverTimestamp()
      });
      tx.set(rRef,{childId:'older',source,reportedBy:'kid-user',reportedAt:serverTimestamp(),
        sessionStartedAt:serverTimestamp(),actualStartMs:start,
        reviewStatus:'pending',reviewedAt:null,reviewedBy:'',penaltyEventId:''});
      audit(tx,db,h,'start_backdated',reportId);
    });
  }
  test('self-reported backdate creates one validated declaration',async()=>{
    const h='retro-self';await seed(h);
    await assertSucceeds(kidBackdate(h,'self-one'));
    const d=(await getDoc(report(parent.firestore(),h,'self-one'))).data();
    assert.equal(d.source,'self');assert.equal(d.reviewStatus,'pending');
  });
  test('another correction to the same play does not create a second incident',async()=>{
    const h='retro-repeat';await seed(h);await assertSucceeds(kidBackdate(h,'same-play'));
    const db=kid.firestore(),pRef=ref(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(pRef),newStart=snap.data().activeStart-60000;
      tx.update(pRef,{activeStart:newStart,updatedAt:serverTimestamp()});
      audit(tx,db,h,'start_corrected','same-play');
    }));
    const docs=await getDocs(collection(parent.firestore(),'households',h,'retroReports'));
    assert.equal(docs.size,1);
  });
  test('child cannot mark themselves as counted or alter the source',async()=>{
    const h='retro-tamper';await seed(h);await assertSucceeds(kidBackdate(h,'secure-self'));
    await assertFails(updateDoc(report(kid.firestore(),h,'secure-self'),{
      reviewStatus:'counted',reviewedBy:'kid-user',reviewedAt:serverTimestamp()
    }));
    await assertFails(updateDoc(report(kid.firestore(),h,'secure-self'),{source:'prompted'}));
  });
  test('parent explicitly confirms or excuses a notice',async()=>{
    const h='retro-parent';await seed(h);await assertSucceeds(kidBackdate(h,'review-me','prompted'));
    const r=report(parent.firestore(),h,'review-me');
    await assertSucceeds(updateDoc(r,{reviewStatus:'counted',reviewedBy:'parent-user',reviewedAt:serverTimestamp()}));
    await assertSucceeds(updateDoc(r,{reviewStatus:'excused',reviewedBy:'parent-user',reviewedAt:serverTimestamp()}));
    assert.equal((await getDoc(r)).data().reviewStatus,'excused');
  });
  test('retrospective start without its linked declaration is denied',async()=>{
    const h='retro-untracked';await seed(h);
    await assertFails(updateDoc(ref(kid.firestore(),h),{
      activeStart:Date.now()-180000,deviceId:'sw1',startedAt:serverTimestamp(),
      endedAt:null,updatedAt:serverTimestamp()
    }));
  });

  test('three reviewed notices settle atomically with exactly one released Pokémon',async()=>{
    const h='retro-release-three',now=Date.now(),ids=['n1','n2','n3'];
    await seed(h,{pokemonLastReleaseEventId:'',favoriteTeam:[1,0,0,0,0]});
    await env.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'pokemonInventory','older'),{
        owned:{'1':'reward-one'},reserved:{},seen:{'1':true},version:1,
        buddyId:'reward-one',updatedAt:Timestamp.fromMillis(now)
      });
      await setDoc(doc(db,'households',h,'rewards','reward-one'),{
        childId:'older',pokemonNo:1,revoked:false
      });
      for(const [i,id] of ids.entries()){
        const at=Timestamp.fromMillis(now-(3-i)*60000);
        await setDoc(report(db,h,id),{
          childId:'older',source:'prompted',reportedBy:'kid-user',reportedAt:at,
          sessionStartedAt:at,actualStartMs:at.toMillis()-10000,reviewStatus:'counted',
          reviewedAt:at,reviewedBy:'parent-user',penaltyEventId:''
        });
      }
    });
    const db=parent.firestore(),pRef=ref(db,h),invRef=doc(db,'households',h,'pokemonInventory','older');
    const rewardRef=doc(db,'households',h,'rewards','reward-one');
    const event=doc(collection(db,'households',h,'pokemonReleases'));
    const reports=ids.map(id=>report(db,h,id));
    await assertSucceeds(runTransaction(db,async tx=>{
      const [p,inv,reward,...records]=await Promise.all([
        tx.get(pRef),tx.get(invRef),tx.get(rewardRef),...reports.map(r=>tx.get(r))
      ]);
      assert.ok(p.exists()&&inv.exists()&&reward.exists()&&records.every(r=>r.exists()));
      tx.update(invRef,{owned:{},version:2,buddyId:'',updatedAt:serverTimestamp()});
      tx.update(rewardRef,{revoked:true,revokedReason:'released',revokedAt:serverTimestamp(),
        revokedBy:'parent-user',releaseEventId:event.id});
      tx.set(event,{
        childId:'older',createdBy:'parent-user',createdAt:serverTimestamp(),reason:'retro_three_notices',
        triggerReports:ids,rewardIds:['reward-one'],pokemon:[{rewardId:'reward-one',no:1,name:'sample'}],count:1
      });
      for(const r of reports)tx.update(r,{penaltyEventId:event.id});
      tx.update(pRef,{
        pokemonLastReleaseEventId:event.id,updatedAt:serverTimestamp(),
        favoriteTeam:[0,0,0,0,0],teamUpdatedAt:serverTimestamp()
      });
      tx.set(doc(collection(db,'households',h,'auditLogs')),{
        action:'pokemon_release',childId:'older',actorUid:'parent-user',actorRole:'parent',
        createdAt:serverTimestamp(),before:'3 confirmed notices',after:'one released',
        sessionId:event.id
      });
    }));
    assert.equal((await getDoc(rewardRef)).data().revoked,true);
    assert.equal((await getDoc(invRef)).data().version,2);
    assert.ok((await Promise.all(reports.map(r=>getDoc(r)))).every(snap=>snap.data().penaltyEventId===event.id));
  });
}
