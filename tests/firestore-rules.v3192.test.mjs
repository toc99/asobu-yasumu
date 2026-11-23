import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {collection,doc,getDoc,runTransaction,serverTimestamp,setDoc,Timestamp} from 'firebase/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  test('v3.19.2 activity XP authorization requires the Firestore emulator',{skip:true},()=>{});
} else {
  const environment=await initializeTestEnvironment({
    projectId:'demo-asobu-v316',firestore:{host:'127.0.0.1',port:8080,
      rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}
  });
  after(async()=>environment.cleanup());
  const parent=environment.authenticatedContext('parent-user');
  const DAY=86_400_000, JST=32_400_000;
  const day=()=>Math.floor((Date.now()+JST)/DAY);

  async function seed(h,{withBuddy=true}={}){
    const requestId=`older_${day()}_creating`;
    await environment.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'members','parent-user'),{role:'parent'});
      await setDoc(doc(db,'households',h,'members','kid-user'),{role:'kid'});
      await setDoc(doc(db,'households',h,'profiles','older'),{rewardSuspendedUntil:0});
      await setDoc(doc(db,'households',h,'activityRequests',requestId),{
        childId:'older',activityKind:'creating',dayIndex:day(),status:'pending',
        requestedBy:'kid-user',requestedAt:Timestamp.now(),slotNo:6,candidateNo:0
      });
      await setDoc(doc(db,'households',h,'activitySlots',`older_${day()}_6`),{
        childId:'older',dayIndex:day(),slotNo:6,requestId,candidateNo:0,
        updatedAt:Timestamp.now()
      });
      await setDoc(doc(db,'households',h,'pokemonInventory','older'),{
        owned:{'25':'reward_original'},reserved:{},seen:{'25':true},version:1,
        updatedAt:Timestamp.now(),buddyId:withBuddy?'reward_original':'',
        experience:withBuddy?{reward_original:40}:{},bankedXp:0,evolutionLog:{}
      });
    });
    return requestId;
  }

  async function approve(h,requestId,amount,{awardField=true,withBuddy=true}={}){
    const db=parent.firestore();
    const invRef=doc(db,'households',h,'pokemonInventory','older');
    const requestRef=doc(db,'households',h,'activityRequests',requestId);
    const auditRef=doc(collection(db,'households',h,'auditLogs'));
    return runTransaction(db,async tx=>{
      const [invSnap,reqSnap]=await Promise.all([tx.get(invRef),tx.get(requestRef)]);
      const inv=invSnap.data();
      assert.equal(reqSnap.data().status,'pending');
      tx.update(invRef,{
        version:inv.version+1,updatedAt:serverTimestamp(),
        ...(withBuddy?{experience:{reward_original:40+amount},bankedXp:0}
          :{experience:{},bankedXp:amount})
      });
      tx.update(requestRef,{
        status:'approved',reviewedBy:'parent-user',reviewedAt:serverTimestamp(),
        ...(awardField?{awardedXp:5}:{})
      });
      tx.set(auditRef,{
        action:'activity_approve',childId:'older',actorUid:'parent-user',
        actorRole:'parent',createdAt:serverTimestamp(),
        before:'チャレンジ申請',after:'相棒 +5 XP',sessionId:requestId
      });
    });
  }

  test('6th challenge credits exactly 5 XP to selected buddy and records award',async()=>{
    const h='v3192-five-buddy',rid=await seed(h);
    await assertSucceeds(approve(h,rid,5));
    const db=parent.firestore();
    const inv=(await getDoc(doc(db,'households',h,'pokemonInventory','older'))).data();
    const req=(await getDoc(doc(db,'households',h,'activityRequests',rid))).data();
    assert.equal(inv.experience.reward_original,45);
    assert.equal(req.awardedXp,5);
  });

  test('6th challenge credits 5 banked XP when no buddy is selected',async()=>{
    const h='v3192-five-banked',rid=await seed(h,{withBuddy:false});
    await assertSucceeds(approve(h,rid,5,{withBuddy:false}));
    const inv=(await getDoc(doc(parent.firestore(),'households',h,'pokemonInventory','older'))).data();
    assert.equal(inv.bankedXp,5);
  });

  test('cached pre-3.19.2 clients can still approve 2 XP with no award field',async()=>{
    const h='v3192-legacy-two',rid=await seed(h);
    await assertSucceeds(approve(h,rid,2,{awardField:false}));
    const db=parent.firestore();
    const inv=(await getDoc(doc(db,'households',h,'pokemonInventory','older'))).data();
    const req=(await getDoc(doc(db,'households',h,'activityRequests',rid))).data();
    assert.equal(inv.experience.reward_original,42);
    assert.equal(req.awardedXp,undefined);
  });

  test('mismatched XP and recorded award are denied',async()=>{
    const variants=[['two-with-new-record',2,true],['six-with-new-record',6,true],
      ['new-five-without-record',5,false]];
    for(const [key,amount,awardField] of variants){
      const h='v3192-reject-'+key,rid=await seed(h);
      await assertFails(approve(h,rid,amount,{awardField}));
    }
  });
}
