import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {collection,doc,runTransaction,serverTimestamp,setDoc,Timestamp,updateDoc} from 'firebase/firestore';

const min=60_000;
const projectId='demo-asobu-v316';
const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  test('Firestore Rules integration requires emulators:exec',{skip:true},()=>{});
} else {
  const environment=await initializeTestEnvironment({
    projectId,firestore:{host:'127.0.0.1',port:8080,rules}
  });
  after(async()=>environment.cleanup());
  const kid=environment.authenticatedContext('kid-user');
  const parent=environment.authenticatedContext('parent-user');

  async function seed(h,profile){
    await environment.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'members','kid-user'),{role:'kid'});
      await setDoc(doc(db,'households',h,'members','parent-user'),{role:'parent'});
      await setDoc(doc(db,'households',h,'settings','main'),{videoLimitMinutes:30});
      await setDoc(doc(db,'households',h,'profiles','older'),{
        activeStart:0,deviceId:null,startedAt:null,endedAt:null,videoStartedAt:null,
        videoDurationMinutes:0,restStart:0,restUntil:0,manualRestUntil:0,
        pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,cycleUsedMs:0,
        lastDuration:0,lastSessionId:'',updatedAt:Timestamp.fromMillis(Date.now()),
        ...profile
      });
    });
  }
  const profileRef=(db,h)=>doc(db,'households',h,'profiles','older');
  const sessionRef=(db,h)=>doc(collection(db,'households',h,'sessions'));
  const auditRef=(db,h)=>doc(collection(db,'households',h,'auditLogs'));
  function writeAudit(tx,db,h,action,sid=''){
    tx.set(auditRef(db,h),{
      action,childId:'older',actorUid:'kid-user',actorRole:'kid',
      createdAt:serverTimestamp(),before:'test',after:'test',sessionId:sid
    });
  }
  async function stopVideo(h,pauseCount=0,pauseMs=0){
    const db=kid.firestore(),ref=profileRef(db,h),session=sessionRef(db,h);
    return runTransaction(db,async tx=>{
      const snap=await tx.get(ref);
      const start=snap.data().videoStartedAt.toMillis(),end=Date.now();
      const dur=end-start-pauseMs;
      tx.update(ref,{
        videoStartedAt:null,videoDurationMinutes:0,endedAt:null,
        restStart:end,restUntil:end+dur,lastDuration:dur,lastSessionId:session.id,
        pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,updatedAt:serverTimestamp()
      });
      tx.set(session,{
        childId:'older',start,end,duration:dur,activityType:'video',deviceId:'video',
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false,pauseMs,pauseCount
      });
      writeAudit(tx,db,h,'video_stop',session.id);
    });
  }
  test('regular video can end without first pausing',async()=>{
    const now=Date.now(),h='video-zero';
    await seed(h,{videoStartedAt:Timestamp.fromMillis(now-5*min)});
    await assertSucceeds(stopVideo(h));
  });
  test('a legacy zero-pause video can end even when obsolete pauseTotalMs remains',async()=>{
    const now=Date.now(),h='video-legacy-zero';
    await seed(h,{videoStartedAt:Timestamp.fromMillis(now-5*min),pauseCount:0,pauseTotalMs:3*min});
    await assertSucceeds(stopVideo(h,0,0));
  });
  test('a video previously paused can also end',async()=>{
    const now=Date.now(),h='video-paused';
    await seed(h,{videoStartedAt:Timestamp.fromMillis(now-5*min),pauseCount:1,pauseTotalMs:min});
    await assertSucceeds(stopVideo(h,1,min));
  });
  test('kid cannot silently shorten mandatory rest',async()=>{
    const now=Date.now(),h='rest-tamper';
    await seed(h,{restStart:now-2*min,restUntil:now+10*min});
    await assertFails(updateDoc(profileRef(kid.firestore(),h),{restUntil:now,updatedAt:serverTimestamp()}));
  });
  test('kid cannot grant their own rest exception',async()=>{
    const now=Date.now(),h='exception-no-grant';
    await seed(h,{restStart:now-2*min,restUntil:now+10*min});
    await assertFails(updateDoc(profileRef(kid.firestore(),h),{
      restException:{state:'offered',debtMs:10*min,reason:'friend',maxMinutes:30,expiresAt:now+10*min},
      updatedAt:serverTimestamp()
    }));
  });
  test('parent grants a one-time exception, kid activates it; a second activation is denied',async()=>{
    const now=Date.now(),h='exception-approved',pref=profileRef(parent.firestore(),h);
    await seed(h,{restStart:now-2*min,restUntil:now+10*min});
    await assertSucceeds(updateDoc(pref,{
      restException:{state:'offered',reason:'friend',debtMs:10*min,maxMinutes:30,
        grantedAt:serverTimestamp(),expiresAt:now+10*min},
      updatedAt:serverTimestamp()
    }));
    const db=kid.firestore(),ref=profileRef(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data();
      tx.update(ref,{activeStart:Date.now(),deviceId:'sw1',startedAt:serverTimestamp(),endedAt:null,
        restException:{...p.restException,state:'active',startedAt:serverTimestamp()},
        updatedAt:serverTimestamp()});
      writeAudit(tx,db,h,'start');
    }));
    await assertFails(updateDoc(ref,{restException:{state:'offered'},updatedAt:serverTimestamp()}));
  });
  test('game to video transition carries use time, final video end sums both sessions into rest',async()=>{
    const now=Date.now(),h='mode-switch-cycle',start=now-5*min;
    await seed(h,{activeStart:start,deviceId:'sw1',startedAt:Timestamp.fromMillis(start)});
    const db=kid.firestore(),ref=profileRef(db,h),transition=sessionRef(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data(),end=Date.now(),dur=end-p.activeStart;
      tx.update(ref,{
        activeStart:0,deviceId:null,startedAt:null,endedAt:null,
        videoStartedAt:serverTimestamp(),videoDurationMinutes:30,
        pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,
        cycleUsedMs:dur,lastSwitchSessionId:transition.id,updatedAt:serverTimestamp()
      });
      tx.set(transition,{childId:'older',start:p.activeStart,end,duration:dur,activityType:'game',
        deviceId:'sw1',transition:true,exceptionPlay:false,pauseMs:0,pauseCount:0,
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false});
      writeAudit(tx,db,h,'mode_switch',transition.id);
    }));
    // Wait just long enough to represent the next activity and satisfy 1s minimum.
    // A 2s delay is intentionally confined to this emulator integration case.
    await new Promise(resolve=>setTimeout(resolve,1300));
    const finish=sessionRef(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data();
      const end=Date.now(),start=p.videoStartedAt.toMillis(),dur=end-start,total=p.cycleUsedMs+dur;
      tx.update(ref,{
        videoStartedAt:null,videoDurationMinutes:0,endedAt:null,
        restStart:end,restUntil:end+total,lastDuration:total,lastSessionId:finish.id,
        cycleUsedMs:0,pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,updatedAt:serverTimestamp()
      });
      tx.set(finish,{childId:'older',start,end,duration:dur,activityType:'video',deviceId:'video',
        cycleFinal:true,exceptionPlay:false,pauseMs:0,pauseCount:0,
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false});
      writeAudit(tx,db,h,'video_stop',finish.id);
    }));
  });

  test('parent-granted special play ends with the old rest debt plus new use, not a waived rest',async()=>{
    const now=Date.now(),h='exception-finish',remaining=20*min;
    await seed(h,{restStart:now-2*min,restUntil:now+remaining});
    await assertSucceeds(updateDoc(profileRef(parent.firestore(),h),{
      restException:{state:'offered',reason:'friend',debtMs:remaining,maxMinutes:30,
        grantedAt:serverTimestamp(),expiresAt:Date.now()+10*min},
      updatedAt:serverTimestamp()
    }));
    const db=kid.firestore(),ref=profileRef(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data();
      tx.update(ref,{
        activeStart:Date.now(),deviceId:'sw1',startedAt:serverTimestamp(),endedAt:null,
        restException:{...p.restException,state:'active',startedAt:serverTimestamp()},
        updatedAt:serverTimestamp()
      });
      writeAudit(tx,db,h,'start');
    }));
    await new Promise(resolve=>setTimeout(resolve,1200));
    const session=sessionRef(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data(),end=Date.now(),duration=end-p.activeStart;
      const endRest=Math.max(p.restUntil,end+duration+p.restException.debtMs);
      tx.update(ref,{
        activeStart:0,deviceId:null,startedAt:null,endedAt:serverTimestamp(),
        restStart:end,restUntil:endRest,lastDuration:duration,lastSessionId:session.id,
        cycleUsedMs:0,
        restException:{...p.restException,state:'used',finishedAt:serverTimestamp()},
        pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,updatedAt:serverTimestamp()
      });
      tx.set(session,{
        childId:'older',start:p.activeStart,end,duration,activityType:'game',deviceId:'sw1',
        cycleFinal:true,exceptionPlay:true,pauseMs:0,pauseCount:0,
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false
      });
      writeAudit(tx,db,h,'end',session.id);
    }));
    // The same period must not create a routine Pokémon game reward.
    const updated=await import('firebase/firestore').then(({getDoc})=>getDoc(ref));
    assert.equal(updated.data().restException.state,'used');
    assert.ok(updated.data().restUntil>Date.now()+remaining-5_000);
  });
  test('video to game transition and final game end preserve total use',async()=>{
    const now=Date.now(),h='video-to-game-cycle';
    await seed(h,{videoStartedAt:Timestamp.fromMillis(now-3*min),videoDurationMinutes:30});
    const db=kid.firestore(),ref=profileRef(db,h),transition=sessionRef(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data(),start=p.videoStartedAt.toMillis(),end=Date.now(),dur=end-start;
      tx.update(ref,{
        videoStartedAt:null,videoDurationMinutes:0,activeStart:end,
        deviceId:'sw1',startedAt:serverTimestamp(),endedAt:null,
        pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,
        cycleUsedMs:dur,lastSwitchSessionId:transition.id,updatedAt:serverTimestamp()
      });
      tx.set(transition,{
        childId:'older',start,end,duration:dur,activityType:'video',deviceId:'video',
        transition:true,exceptionPlay:false,pauseMs:0,pauseCount:0,
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false
      });
      writeAudit(tx,db,h,'mode_switch',transition.id);
    }));
    await new Promise(resolve=>setTimeout(resolve,1200));
    const finish=sessionRef(db,h);
    await assertSucceeds(runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data(),end=Date.now(),dur=end-p.activeStart;
      const total=dur+p.cycleUsedMs;
      tx.update(ref,{
        activeStart:0,deviceId:null,startedAt:null,endedAt:serverTimestamp(),
        restStart:end,restUntil:end+total,lastDuration:total,lastSessionId:finish.id,
        cycleUsedMs:0,pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,updatedAt:serverTimestamp()
      });
      tx.set(finish,{
        childId:'older',start:p.activeStart,end,duration:dur,activityType:'game',
        deviceId:'sw1',cycleFinal:true,exceptionPlay:false,pauseMs:0,pauseCount:0,
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false
      });
      writeAudit(tx,db,h,'end',finish.id);
    }));
  });
}
