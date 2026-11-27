import test,{after} from 'node:test';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,updateDoc,Timestamp} from 'firebase/firestore';
if(!process.env.FIRESTORE_EMULATOR_HOST){test('parent directory security requires emulator',{skip:true},()=>{});}else{
 const env=await initializeTestEnvironment({projectId:'demo-asobu-v316',firestore:{host:'127.0.0.1',port:8080,rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
 after(()=>env.cleanup());
 const h='v327-identity';const ref=(db,col,id)=>doc(db,'households',h,col,id);
 const directory=db=>ref(db,'settings','parentIdentities');
 test('both parents and kid may read the directory; no client may change it; outsider cannot read',async()=>{
  await env.withSecurityRulesDisabled(async ctx=>{
   const db=ctx.firestore();
   for(const [uid,role] of [['father','parent'],['mother','parent'],['kid','kid']])await setDoc(ref(db,'members',uid),{role});
   await setDoc(directory(db),{fatherUid:'father',motherUid:'mother',effectiveFrom:Timestamp.now()});
   await setDoc(ref(db,'settings','main'),{});
  });
  for(const uid of ['father','mother','kid']){
   const db=env.authenticatedContext(uid).firestore();
   await assertSucceeds(getDoc(directory(db)));
   await assertFails(updateDoc(directory(db),{fatherUid:'kid'}));
   if(uid!=='kid')await assertSucceeds(updateDoc(ref(db,'settings','main'),{videoLimitMinutes:30}));
  }
  await assertFails(getDoc(directory(env.authenticatedContext('outsider').firestore())));
  await assertFails(getDoc(directory(env.unauthenticatedContext().firestore())));
 });
}
