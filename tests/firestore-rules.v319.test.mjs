import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,runTransaction,serverTimestamp,Timestamp,getDoc} from 'firebase/firestore';
const MIN=60000;

if(!process.env.FIRESTORE_EMULATOR_HOST){
  test('v3.19 Firestore integration requires emulators:exec',{skip:true},()=>{});
}else{
  const env=await initializeTestEnvironment({
    projectId:'demo-asobu-v316',
    firestore:{host:'127.0.0.1',port:8080,rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}
  });
  after(async()=>env.cleanup());
  const kid=env.authenticatedContext('kid-user'),parent=env.authenticatedContext('parent-user');

  async function seed(h,profile){
    await env.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'members','kid-user'),{role:'kid'});
      await setDoc(doc(db,'households',h,'members','parent-user'),{role:'parent'});
      await setDoc(doc(db,'households',h,'settings','main'),{videoLimitMinutes:30});
      await setDoc(doc(db,'households',h,'profiles','older'),{
        activeStart:0,deviceId:null,startedAt:null,endedAt:null,
        videoStartedAt:null,videoDurationMinutes:0,restStart:0,restUntil:0,
        manualRestUntil:0,cycleUsedMs:0,cycleVideoUsedMs:0,
        pauseStartedAt:null,pauseCount:0,pauseTotalMs:0,
        lastSwitchSessionId:'',lastSessionId:'',lastDuration:0,
        ...profile
      });
    });
  }
  async function switchGameToVideo(h,usedVideoMs){
    const t=Date.now(),start=t-5*MIN;
    await seed(h,{activeStart:start,deviceId:'sw1',startedAt:Timestamp.fromMillis(start),
      cycleUsedMs:usedVideoMs,cycleVideoUsedMs:usedVideoMs});
    const db=kid.firestore(),ref=doc(db,'households',h,'profiles','older'),sid='switch-game-video';
    return runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data(),end=Date.now(),duration=end-p.activeStart;
      tx.update(ref,{
        activeStart:0,deviceId:null,startedAt:null,endedAt:null,
        videoStartedAt:serverTimestamp(),videoDurationMinutes:30,
        pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,
        cycleUsedMs:p.cycleUsedMs+duration,cycleVideoUsedMs:usedVideoMs,
        lastSwitchSessionId:sid,updatedAt:serverTimestamp()
      });
      tx.set(doc(db,'households',h,'sessions',sid),{
        childId:'older',start:p.activeStart,end,duration,activityType:'game',deviceId:'sw1',
        transition:true,exceptionPlay:false,pauseMs:0,pauseCount:0,
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false
      });
    });
  }

  test('動画30分使用済みのゲーム→動画切替をFirestoreで拒否する',async()=>{
    await assertFails(switchGameToVideo('v319-video-exhausted',30*MIN));
  });
  test('動画20分使用済みならゲーム→動画切替を許可する',async()=>{
    await assertSucceeds(switchGameToVideo('v319-video-remaining',20*MIN));
    const data=(await getDoc(doc(kid.firestore(),'households','v319-video-remaining','profiles','older'))).data();
    assert.equal(data.cycleVideoUsedMs,20*MIN);
    assert.equal(data.videoDurationMinutes,30);
  });

  async function switchVideoToGame(h,undercount=false){
    const t=Date.now(),started=t-5*MIN;
    await seed(h,{videoStartedAt:Timestamp.fromMillis(started),videoDurationMinutes:30});
    const db=kid.firestore(),ref=doc(db,'households',h,'profiles','older'),sid='switch-video-game';
    return runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data(),start=p.videoStartedAt.toMillis(),end=Date.now(),duration=end-start;
      tx.update(ref,{
        videoStartedAt:null,videoDurationMinutes:0,activeStart:end,deviceId:'sw1',
        startedAt:serverTimestamp(),endedAt:null,pauseStartedAt:null,pauseTotalMs:0,pauseCount:0,
        cycleUsedMs:duration,cycleVideoUsedMs:undercount?0:duration,
        lastSwitchSessionId:sid,updatedAt:serverTimestamp()
      });
      tx.set(doc(db,'households',h,'sessions',sid),{
        childId:'older',start,end,duration,activityType:'video',deviceId:'video',
        transition:true,exceptionPlay:false,pauseMs:0,pauseCount:0,
        createdAt:serverTimestamp(),createdBy:'kid-user',edited:false
      });
    });
  }
  test('動画→ゲーム切替で使用済み動画時間を保持する',async()=>{
    await assertSucceeds(switchVideoToGame('v319-video-carry'));
    const data=(await getDoc(doc(kid.firestore(),'households','v319-video-carry','profiles','older'))).data();
    assert.ok(data.cycleVideoUsedMs>=5*MIN);
    assert.equal(data.cycleUsedMs,data.cycleVideoUsedMs);
  });
  test('動画利用時間を少なく申告する改ざんを拒否する',async()=>{
    await assertFails(switchVideoToGame('v319-video-tamper',true));
  });

  test('通常休憩を保護者は短縮できるが、子どもの直接短縮は拒否する',async()=>{
    const h='v319-parent-override',now=Date.now();
    await seed(h,{restStart:now,restUntil:now+30*MIN,manualRestUntil:now+30*MIN});
    const path=['households',h,'profiles','older'];
    const update=async (ctx,actor)=>{
      const db=ctx.firestore();
      return runTransaction(db,async tx=>{
        const ref=doc(db,...path),snap=await tx.get(ref),p=snap.data(),at=Date.now();
        tx.update(ref,{restStart:at,restUntil:at+20*MIN,manualRestUntil:0,manualRestMinutes:0,
          restOverrideMinutes:20,restOverrideAt:serverTimestamp(),updatedAt:serverTimestamp()});
        tx.set(doc(db,'households',h,'auditLogs','override-'+actor),{
          action:'rest_override',childId:'older',actorUid:actor,actorRole:actor==='parent-user'?'parent':'kid',
          createdAt:serverTimestamp(),before:'残り30分',after:'残り20分',sessionId:''
        });
      });
    };
    await assertFails(update(kid,'kid-user'));
    await assertSucceeds(update(parent,'parent-user'));
    const changed=(await getDoc(doc(parent.firestore(),...path))).data();
    assert.equal(changed.manualRestUntil,0);
    assert.equal(changed.restOverrideMinutes,20);
    assert.ok(changed.restUntil-changed.restStart===20*MIN);
  });
}
