// Local Windows PC bridge. Uses Firebase client authentication, never Admin SDK.
import {initializeApp} from 'firebase/app';
import {getAuth,signInWithEmailAndPassword} from 'firebase/auth';
import {getFirestore,doc,collection,onSnapshot,query,orderBy,limit,getDocFromServer,setDoc,serverTimestamp} from 'firebase/firestore';
import {firebaseConfig,householdId} from '../firebase-config.js';
import {defaultConfig,quiet,timedEvents,approvalEvents,rewardEvent,inventoryEvents,label,stamp,DAY} from '../google-home-policy.js';
import {loadExtendedPokemonNames} from '../pokedex-data.js';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const stateDir=process.env.GH_STATE_DIR||path.join(here,'.local');
mkdirSync(stateDir,{recursive:true});
const statePath=path.join(stateDir,'delivery.json');
let saved={seen:{},history:[]};
try{saved=JSON.parse(readFileSync(statePath,'utf8'));}catch{}
if(!saved.seen||typeof saved.seen!=='object')saved.seen={};
if(!Array.isArray(saved.history))saved.history=[];
function persist(){
 const now=Date.now();saved.seen=Object.fromEntries(Object.entries(saved.seen).filter(([,at])=>now-at<3*DAY).slice(-3000));
 saved.history=saved.history.slice(0,20);
 writeFileSync(statePath+'.tmp',JSON.stringify(saved),{mode:0o600});renameSync(statePath+'.tmp',statePath);
}
const email=process.env.GH_EMAIL,password=process.env.GH_PASSWORD;
if(!email||!password)throw Error('GH_EMAIL and GH_PASSWORD are required in the local .env file.');
const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);
const login=await signInWithEmailAndPassword(auth,email,password);
const uid=login.user.uid;
const ref=(name,id)=>doc(db,'households',householdId,name,id);
const col=name=>collection(db,'households',householdId,name);
const configRef=ref('googleHome','config'),statusRef=ref('googleHome','status');
const profiles={},inventory={};let settings=null,cfg=null,onlineAt=0,state='unavailable',device='',playing=false,probing=false,lastProbe=0,stopped=false;
const pending=new Map(),freshDocs=new Set();
function log(msg){console.log(new Date().toISOString(),msg);}
const current=()=>cfg&&cfg.bridgeUid===uid&&cfg.enabled===true&&Date.now()-onlineAt<90000&&freshDocs.size===4;
function listen(target,key,cb){
 return onSnapshot(target,{includeMetadataChanges:true},snap=>{
  if(snap.metadata.fromCache||snap.metadata.hasPendingWrites){if(key)freshDocs.delete(key);return;}
  if(key)freshDocs.add(key);cb(snap);
 },e=>{onlineAt=0;freshDocs.clear();pending.clear();log('Firebase listener disconnected: '+e.code);process.exit(2);});
}
const unsub=[];
function push(e){
 if(!e||!e.at||Date.now()-e.at>60000||!current()||saved.seen[e.key]||pending.has(e.key))return;
 if(e.type!=='manual'&&(!cfg.types?.[e.type]||quiet(cfg,Date.now())))return;
 pending.set(e.key,e);
}
function readConfig(snap){
 const data=snap.exists()?snap.data():null;
 if(!data||data.bridgeUid!==uid){onlineAt=0;pending.clear();cfg=null;return;}
 const base=defaultConfig(),old=cfg;cfg={...base,...data,types:{...base.types,...data.types}};
 if(!cfg.enabled){pending.clear();state='disabled';}
 if(old?.speaker!==cfg.speaker){lastProbe=0;device='';state=cfg.enabled?'unavailable':'disabled';}
 if(cfg.enabled&&cfg.command?.id)push({type:'manual',key:'manual:'+cfg.command.id,at:stamp(cfg.command.at),text:cfg.command.text});
}
const first=await getDocFromServer(configRef);readConfig(first);
if(!cfg)throw Error('Register this dedicated Firebase Auth UID in the parent Google Home settings first.');
onlineAt=Date.now();
unsub.push(listen(configRef,'config',readConfig));
unsub.push(listen(ref('settings','main'),'settings',s=>settings=s.data()||{}));
for(const id of ['older','younger']){
 unsub.push(listen(ref('profiles',id),'profile:'+id,s=>profiles[id]=s.exists()?s.data():null));
 unsub.push(listen(ref('pokemonInventory',id),null,s=>{
  const before=inventory[id],after=s.exists()?s.data():null;inventory[id]=after;
  if(current()&&before&&after&&after.version!==before.version)
   for(const e of inventoryEvents(id,before,after,profiles[id],stamp(after.updatedAt)))push(e);
 }));
}
loadExtendedPokemonNames().catch(()=>{});
let rewardBaseline=false,approvalBaseline=false;
unsub.push(listen(query(col('rewards'),orderBy('claimedAt','desc'),limit(40)),null,s=>{
 if(!rewardBaseline){rewardBaseline=true;return;}
 for(const ch of s.docChanges().filter(x=>x.type==='added')){
  const r=ch.doc.data();push(rewardEvent(ch.doc.id,r,profiles));
  if(r.kind==='rest_completed'&&!r.revoked)push({type:'xp',key:'game-xp:'+ch.doc.id,at:stamp(r.claimedAt),text:label(r.childId,profiles[r.childId])+'、ゲームと休憩のごほうびで相棒の経験値を5ポイント獲得したよ。'});
 }
}));
unsub.push(listen(query(col('activityRequests'),orderBy('reviewedAt','desc'),limit(40)),null,s=>{
 if(!approvalBaseline){approvalBaseline=true;return;}
 for(const ch of s.docChanges())for(const e of approvalEvents(ch.doc.id,ch.doc.data(),profiles))push(e);
 const groups=new Map();for(const d of s.docs){const r=d.data();if(r.status!=='approved')continue;
  const k=r.childId+':'+r.dayIndex,a=groups.get(k)||[];a.push(r);groups.set(k,a);}
 for(const [k,rows] of groups)if(new Set(rows.map(r=>r.activityKind)).size===11){
  const id=rows[0].childId;push({type:'allDone',key:'all:'+k,at:Math.max(...rows.map(r=>stamp(r.reviewedAt))),text:label(id,profiles[id])+'、今日の11チャレンジを全部達成したね！'});
 }
}));
function cast(op,text=''){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.GH_PYTHON||'python',[path.join(here,'cast.py')],{cwd:here,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let out='',err='',done=false;
  const timeout=setTimeout(()=>{child.kill();if(!done){done=true;reject(Error('Cast timeout'));}},90000);
  child.stdout.on('data',d=>{out+=d;if(out.length>16000)child.kill();});
  child.stderr.on('data',d=>{err+=d;if(err.length>16000)child.kill();});
  child.on('error',e=>{clearTimeout(timeout);if(!done){done=true;reject(e);}});
  child.on('close',code=>{clearTimeout(timeout);if(done)return;done=true;
   try{const result=JSON.parse(out);if(code!==0&&result.result!=='skipped')throw Error(result.error||'Cast failed');resolve(result);}
   catch(e){reject(Error('Cast failed: '+(e.message||'unknown')));}
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({op,speaker:cfg.speaker,volume:cfg.volume,text,host:process.env.GH_CAST_HOST||'',lanIp:process.env.GH_LAN_IP||''}));
 });
}
async function status(){
 if(!cfg||Date.now()-onlineAt>90000)return;
 try{await setDoc(statusRef,{updatedAt:serverTimestamp(),bridgeUid:uid,state:cfg.enabled?state:'disabled',device,history:saved.history.slice(0,20)});}catch(e){log('Status update failed: '+e.code);}
}
async function health(){
 if(stopped)return;
 try{
  const s=await getDocFromServer(configRef);
  readConfig(s);if(!cfg)return;onlineAt=Date.now();
  // Authoritative reads ensure stale cached profiles are not used for timed notices.
  const docs=await Promise.all([getDocFromServer(ref('settings','main')),...['older','younger'].map(id=>getDocFromServer(ref('profiles',id)))]);
  settings=docs[0].data()||{};profiles.older=docs[1].data()||null;profiles.younger=docs[2].data()||null;
  freshDocs.add('config');freshDocs.add('settings');freshDocs.add('profile:older');freshDocs.add('profile:younger');
  if(cfg.enabled&&!playing&&!probing&&Date.now()-lastProbe>300000){
   probing=true;lastProbe=Date.now();try{const result=await cast('probe');device=result.device||'';state=result.result==='ready'?'ready':'unavailable';}
   catch{state='unavailable';device='';}finally{probing=false;}
  }
  await status();
 }catch(e){onlineAt=0;freshDocs.clear();pending.clear();state='error';log('Cloud connection unavailable: '+(e.code||'connection error'));}
 finally{if(!stopped)setTimeout(health,60000);}
}
async function pump(){
 if(stopped)return;
 if(current()&&settings&&profiles.older&&profiles.younger){
  for(const e of timedEvents(profiles,settings,cfg))push(e);
  if(cfg.command?.id)push({type:'manual',key:'manual:'+cfg.command.id,at:stamp(cfg.command.at),text:cfg.command.text});
  for(const [key,e] of pending)if(Date.now()-e.at>60000)pending.delete(key);
  if(!playing&&!probing&&pending.size){
   const [key,e]=pending.entries().next().value;pending.delete(key);
   if(!saved.seen[key]&&(e.type==='manual'||(cfg.types?.[e.type]&&!quiet(cfg,Date.now())))){
    // Persist before playback to prevent repeated speech after an interruption/crash.
    saved.seen[key]=Date.now();persist();playing=true;state='busy';
    let result='error';
    try{
     const r=await cast('speak',String(e.text).slice(0,160));result=r.result==='sent'?'sent':r.result==='skipped'?'skipped':'error';
     device=r.device||device;state=result==='sent'||result==='skipped'?'ready':'error';
    }catch(e){state='error';log('Speaker playback failed.');}
    saved.history.unshift({at:Date.now(),type:e.type,result});persist();playing=false;
    void status();
   }
  }
 }else pending.clear();
 if(!stopped)setTimeout(pump,1000);
}
process.on('SIGINT',()=>{stopped=true;unsub.forEach(f=>f());process.exit(0);});
process.on('SIGTERM',()=>{stopped=true;unsub.forEach(f=>f());process.exit(0);});
log('Google Home bridge started; waiting for authorized configuration.');
void health();void pump();
