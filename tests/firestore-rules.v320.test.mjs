import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,collection,query,orderBy,limit,getDoc,getDocs,setDoc,updateDoc,serverTimestamp,Timestamp} from 'firebase/firestore';
import {defaultConfig} from '../google-home-policy.js';
if(!process.env.FIRESTORE_EMULATOR_HOST){
 test('Google Home security integration requires Firestore emulator',{skip:true},()=>{});
}else{
 const env=await initializeTestEnvironment({projectId:'demo-asobu-v316',firestore:{host:'127.0.0.1',port:8080,rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
 after(()=>env.cleanup());
 const h='v320-google-home';
 const parent=env.authenticatedContext('parent-user').firestore(),kid=env.authenticatedContext('kid-user').firestore();
 const bridge=env.authenticatedContext('speaker-user').firestore(),other=env.authenticatedContext('other-user').firestore();
 const d=(db,col,id)=>doc(db,'households',h,col,id);
 const config=(db)=>d(db,'googleHome','config');
 const setup={...defaultConfig(),enabled:true,bridgeUid:'speaker-user',speaker:'Living Room'};
 test('only parent can configure a dedicated speaker and it cannot modify family records',async()=>{
  await env.withSecurityRulesDisabled(async ctx=>{
   const db=ctx.firestore();
   await setDoc(d(db,'members','parent-user'),{role:'parent'});
   await setDoc(d(db,'members','kid-user'),{role:'kid'});
   await setDoc(d(db,'profiles','older'),{activeStart:0});
   await setDoc(d(db,'settings','main'),{});
   await setDoc(d(db,'pokemonInventory','older'),{version:1,owned:{},reserved:{},seen:{}});
   await setDoc(d(db,'rewards','a'),{claimedAt:Timestamp.now()});
   await setDoc(d(db,'activityRequests','a'),{reviewedAt:Timestamp.now()});
   await setDoc(d(db,'feedbackReports','private'),{description:'private'});
  });
  await assertFails(setDoc(config(kid),setup));
  await assertSucceeds(setDoc(config(parent),setup));
  await assertFails(setDoc(config(parent),{...setup,volume:100}));
  await assertSucceeds(getDoc(config(bridge)));
  await assertFails(getDoc(config(kid)));
  await assertFails(getDoc(config(other)));
  await assertSucceeds(getDoc(d(bridge,'profiles','older')));
  await assertSucceeds(getDoc(d(bridge,'settings','main')));
  await assertSucceeds(getDoc(d(bridge,'pokemonInventory','older')));
  await assertFails(getDocs(collection(bridge,'households',h,'profiles')));
  await assertFails(getDoc(d(bridge,'feedbackReports','private')));
  await assertFails(updateDoc(d(bridge,'profiles','older'),{activeStart:1}));
  await assertFails(updateDoc(d(bridge,'settings','main'),{videoLimitMinutes:1}));
  await assertFails(updateDoc(d(bridge,'pokemonInventory','older'),{version:2}));
  await assertFails(updateDoc(config(bridge),{enabled:false}));
  await assertSucceeds(getDocs(query(collection(bridge,'households',h,'rewards'),orderBy('claimedAt','desc'),limit(40))));
  await assertSucceeds(getDocs(query(collection(bridge,'households',h,'activityRequests'),orderBy('reviewedAt','desc'),limit(40))));
  await assertFails(getDocs(collection(bridge,'households',h,'rewards')));
  await assertFails(getDocs(query(collection(bridge,'households',h,'activityRequests'),limit(41))));
  const status={updatedAt:serverTimestamp(),bridgeUid:'speaker-user',state:'ready',device:'Living Room',history:[]};
  await assertSucceeds(setDoc(d(bridge,'googleHome','status'),status));
  await assertSucceeds(getDoc(d(parent,'googleHome','status')));
  await assertFails(setDoc(d(kid,'googleHome','status'),status));
  await assertSucceeds(updateDoc(config(parent),{command:{id:'abc',text:'テスト',at:serverTimestamp()}}));
  await assertSucceeds(updateDoc(config(parent),{volume:40}));
  await assertSucceeds(updateDoc(config(parent),{enabled:false,bridgeUid:''}));
  await assertFails(getDoc(d(bridge,'profiles','older')));
  await assertFails(setDoc(d(bridge,'googleHome','status'),status));
 });
}
