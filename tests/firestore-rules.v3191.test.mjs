import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {collection,doc,getDoc,runTransaction,serverTimestamp,setDoc,Timestamp} from 'firebase/firestore';

// Rules use the real emulator clock. Verify the morning window when the CI clock permits it.
const MIN=60_000, DAY=86_400_000, JST=9*60*MIN;
const minuteOfDay=()=>Math.floor((((Date.now()+JST)%DAY)+DAY)%DAY/MIN);
const currentMinute=minuteOfDay();
const morningTestable=currentMinute>=300 && currentMinute<=1260;

if(!process.env.FIRESTORE_EMULATOR_HOST){
  test('night-resume Firestore integration requires emulators:exec',{skip:true},()=>{});
}else{
  const env=await initializeTestEnvironment({
    projectId:'demo-asobu-v316',
    firestore:{host:'127.0.0.1',port:8080,
      rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}
  });
  after(async()=>env.cleanup());
  const kid=env.authenticatedContext('kid-user');
  const endMinute=currentMinute+30;
  const morningAt=now=>Math.floor((now+JST)/DAY)*DAY-JST+endMinute*MIN;
  async function seed(h,profile={}){
    const now=Date.now(),morning=morningAt(now);
    await env.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'members','kid-user'),{role:'kid'});
      await setDoc(doc(db,'households',h,'settings','main'),{
        nightPause:{enabled:true,start:'22:00',
          end:`${String(Math.floor(endMinute/60)).padStart(2,'0')}:${String(endMinute%60).padStart(2,'0')}`,
          startMinutes:1320,endMinutes:endMinute,enabledAt:now-DAY}
      });
      await setDoc(doc(db,'households',h,'profiles','older'),{
        activeStart:0,videoStartedAt:null,restStart:now-30*MIN,
        restUntil:morning+40*MIN,manualRestUntil:morning+30*MIN,
        nightResumeAt:null,nightResumeWindowEnd:0,
        updatedAt:Timestamp.fromMillis(now-60_000),...profile
      });
    });
  }
  async function resume(h,maliciousShortening=0){
    const db=kid.firestore(),ref=doc(db,'households',h,'profiles','older');
    return runTransaction(db,async tx=>{
      const snap=await tx.get(ref),p=snap.data(),now=Date.now();
      const morning=morningAt(now);
      const stoppedTime=Math.max(0,morning-now);
      const manual=p.manualRestUntil>morning?p.manualRestUntil-stoppedTime:p.manualRestUntil;
      tx.update(ref,{nightResumeAt:serverTimestamp(),nightResumeWindowEnd:morning,
        manualRestUntil:Math.round(manual-maliciousShortening),updatedAt:serverTimestamp()});
      tx.set(doc(collection(db,'households',h,'auditLogs')),{
        action:'night_resume',childId:'older',actorUid:'kid-user',actorRole:'kid',
        createdAt:serverTimestamp(),before:'夜間停止中',after:'いまから消化再開',sessionId:''
      });
    });
  }
  test('朝5時以降の子どもの休憩消化再開を監査記録と同時に許可する',
    {skip:!morningTestable},async()=>{
      const h='v3191-morning-resume';await seed(h);
      await assertSucceeds(resume(h));
      const p=(await getDoc(doc(kid.firestore(),'households',h,'profiles','older'))).data();
      assert.ok(p.nightResumeAt instanceof Timestamp);
      assert.equal(p.nightResumeWindowEnd,morningAt(Date.now()));
      await assertFails(resume(h)); // 同じ夜間枠で二度解除はできない
    });
  test('動画視聴中の前倒し再開を拒否する',
    {skip:!morningTestable},async()=>{
      const h='v3191-night-video-active';
      await seed(h,{videoStartedAt:Timestamp.fromMillis(Date.now()-2*MIN)});
      await assertFails(resume(h));
    });
  test('前倒し再開を利用した手動休憩の5分短縮を拒否する',
    {skip:!morningTestable},async()=>{
      const h='v3191-night-tamper';await seed(h);
      await assertFails(resume(h,5*MIN));
    });
}
