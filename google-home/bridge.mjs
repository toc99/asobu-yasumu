// Local Windows/Linux PC bridge. Uses Firebase client authentication, never Admin SDK.
import {initializeApp} from 'firebase/app';
import {getAuth,signInWithEmailAndPassword} from 'firebase/auth';
import {getFirestore,doc,collection,onSnapshot,query,orderBy,limit,getDocFromServer,setDoc,serverTimestamp,deleteDoc} from 'firebase/firestore';
import {firebaseConfig,householdId} from '../firebase-config.js';
import {defaultConfig,quiet,timedEvents,approvalEvents,rewardEvents,allDoneEvents,eligibleNotice,inventoryEvents,stamp,DAY,routeTargets,knownSpeakers,deliverySummary} from '../google-home-policy.js';
import {MAX_PENDING,validQueued,liveEvent,sortedQueue,batchFor,safeRetry,queueView,lifetime} from '../google-home-queue.js';
import {loadExtendedPokemonNames} from '../pokedex-data.js';
import {spawn} from 'node:child_process';
import {BRIDGE_VERSION,collectMonitor} from './monitor.mjs';
import {mkdirSync,readFileSync,writeFileSync,renameSync,appendFileSync,statSync,existsSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const stateDir=process.env.GH_STATE_DIR||path.join(here,'.local');
mkdirSync(stateDir,{recursive:true});
const statePath=path.join(stateDir,'delivery.json');
const logPath=path.join(stateDir,'bridge.log');
let saved={seen:{},history:[]};
try{saved=JSON.parse(readFileSync(statePath,'utf8'));}catch{}
if(!saved.seen||typeof saved.seen!=='object')saved.seen={};
if(!Array.isArray(saved.history))saved.history=[];
let discovered=knownSpeakers(saved.speakers).map(d=>({...d,online:false})),hosts=saved.hosts&&typeof saved.hosts==='object'?saved.hosts:{};
let lastScanRequest=0,scannedAt=0;
function persist(){
 const now=Date.now();saved.seen=Object.fromEntries(Object.entries(saved.seen).filter(([,at])=>now-at<3*DAY).slice(-3000));
 saved.history=saved.history.slice(0,20);
 saved.pending=[...pending.values()];saved.owner=uid;
 saved.inFlight=activeBatch?{at:Date.now(),types:activeBatch.batch.map(e=>e.type)}:null;
 writeFileSync(statePath+'.tmp',JSON.stringify(saved),{mode:0o600});renameSync(statePath+'.tmp',statePath);
}
const email=process.env.GH_EMAIL,password=process.env.GH_PASSWORD;
if(!email||!password)throw Error('GH_EMAIL and GH_PASSWORD are required in the local .env file.');
const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);
let login;
try{login=await signInWithEmailAndPassword(auth,email,password);}catch(e){log('Firebase authentication failed: '+(e.code||'auth error'));process.exit(2);}
const uid=login.user.uid;
const ref=(name,id)=>doc(db,'households',householdId,name,id);
const col=name=>collection(db,'households',householdId,name);
const configRef=ref('googleHome','config'),statusRef=ref('googleHome','status');
const profiles={},inventory={};let settings=null,cfg=null,onlineAt=0,state='unavailable',device='',playing=false,probing=false,lastProbe=0,stopped=false;
const pending=new Map(),freshDocs=new Set();
let activeBatch=null,lastStatus=0,statusDirty=true,statusWriting=false;const deleting=new Set();
for(const e of saved.owner===uid&&Array.isArray(saved.pending)?saved.pending:[])if(validQueued(e,Date.now())&&!saved.seen[e.key]&&pending.size<MAX_PENDING)pending.set(e.key,e);
if(saved.owner===uid&&Array.isArray(saved.inFlight?.types)&&saved.inFlight.types.length){saved.history.unshift({at:Date.now(),type:saved.inFlight.types[0],types:saved.inFlight.types.slice(0,4),result:'skipped',reason:'interrupted'});persist();}
function clearPending(){if(pending.size){for(const e of pending.values())terminal(e,'stale');persist();statusDirty=true;}}
function remember(e){saved.seen[e.key]=Date.now();}
function terminal(e,reason){pending.delete(e.key);remember(e);saved.history.unshift({at:Date.now(),type:e.type,result:'skipped',reason});statusDirty=true;}
function log(msg){
 const line=new Date().toISOString()+' '+msg;console.log(line);
 try{
  if(existsSync(logPath)&&statSync(logPath).size>1024*1024){rmSync(logPath+'.1',{force:true});renameSync(logPath,logPath+'.1');}
  appendFileSync(logPath,line+'\n',{encoding:'utf8',mode:0o600});
 }catch{console.error('Local log write failed.');}
}
const current=()=>cfg&&cfg.bridgeUid===uid&&cfg.enabled===true&&Date.now()-onlineAt<90000&&freshDocs.size===4;
function listen(target,key,cb){
 return onSnapshot(target,{includeMetadataChanges:true},snap=>{
  if(snap.metadata.fromCache||snap.metadata.hasPendingWrites){if(key)freshDocs.delete(key);return;}
  if(key)freshDocs.add(key);cb(snap);
 },e=>{onlineAt=0;freshDocs.clear();log('Firebase listener disconnected: '+e.code);process.exit(2);});
}
const unsub=[];
function push(e){
 if(!cfg||cfg.bridgeUid!==uid||!validQueued(e,Date.now())||!eligibleNotice(e,cfg,Date.now(),lifetime(e))||saved.seen[e.key]||pending.has(e.key))return false;
 if(pending.size>=MAX_PENDING){
  const candidates=sortedQueue([...pending.values(),e]),drop=candidates.at(-1);
  terminal(drop,'queue_full');
  if(drop.key===e.key){persist();return false;}
 }
 pending.set(e.key,{...e,queuedAt:Date.now()});persist();statusDirty=true;return true;
}
function readConfig(snap){
 const data=snap.exists()?snap.data():null;
 if(!data||data.bridgeUid!==uid){onlineAt=0;clearPending();cfg=null;return;}
 const base=defaultConfig(),old=cfg;cfg={...base,...data,types:{...base.types,...data.types}};
 if(!cfg.enabled){clearPending();state='disabled';}
 if(old?.speaker!==cfg.speaker||JSON.stringify(old?.speakerIds)!==JSON.stringify(cfg.speakerIds)){lastProbe=0;device='';state=cfg.enabled?'unavailable':'disabled';}
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
  if(before&&after&&after.version!==before.version)
   for(const e of inventoryEvents(id,before,after,profiles[id],stamp(after.updatedAt)))push(e);
 }));
}
loadExtendedPokemonNames().catch(()=>{});
let rewardBaseline=false,approvalBaseline=false;
unsub.push(listen(query(col('rewards'),orderBy('claimedAt','desc'),limit(40)),null,s=>{
 if(!rewardBaseline){rewardBaseline=true;return;}
 for(const ch of s.docChanges().filter(x=>x.type==='added')){
  for(const e of rewardEvents(ch.doc.id,ch.doc.data(),profiles))push(e);
 }
}));
unsub.push(listen(query(col('activityRequests'),orderBy('reviewedAt','desc'),limit(40)),null,s=>{
 if(!approvalBaseline){approvalBaseline=true;return;}
 for(const ch of s.docChanges())for(const e of approvalEvents(ch.doc.id,ch.doc.data(),profiles))push(e);
 for(const e of allDoneEvents(s.docs.map(d=>d.data()),profiles))push(e);
}));
// Each manual request has its own document. Delete only after durable admission or terminal discard.
unsub.push(listen(query(col('googleHomeCommands'),orderBy('at','desc'),limit(40)),null,s=>{
 for(const d of s.docs){
  if(deleting.has(d.id))continue;
  const r=d.data(),e={type:'manual',key:'manual:'+d.id,at:stamp(r.at),text:r.text};
  if(!cfg||cfg.bridgeUid!==uid)continue;
  if(validQueued(e,Date.now())&&cfg.enabled&&!saved.seen[e.key]&&!pending.has(e.key)){
   push(e);
   if(!pending.has(e.key)&&!saved.seen[e.key])continue;
  }else if(!saved.seen[e.key]&&!pending.has(e.key)){
   terminal(e,'stale');persist();
  }
  deleting.add(d.id);deleteDoc(d.ref).catch(()=>log('Manual queue acknowledgement failed.')).finally(()=>deleting.delete(d.id));
 }
}));
const castReasons=new Set(['muted','media_busy','other_app','status_unavailable','speaker_not_unique','tts_failed','tts_duration','receiver_no_start','receiver_no_finish','cast_error','timeout','process_error']);
const safeReason=value=>castReasons.has(value)?value:'cast_error';
function cast(op,text='',manual=false,target={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.GH_PYTHON||'python',['-X','utf8',path.join(here,'cast.py')],{cwd:here,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let out='',err='',done=false;
  const timeout=setTimeout(()=>{child.kill();if(!done){done=true;resolve({result:'error',reason:'timeout'});}},180000);
  child.stdout.on('data',d=>{out+=d;if(out.length>16000)child.kill();});
  child.stderr.on('data',d=>{err+=d;if(err.length>16000)child.kill();});
  child.on('error',e=>{clearTimeout(timeout);if(!done){done=true;resolve({result:'error',reason:'process_error'});}});
  child.on('close',code=>{clearTimeout(timeout);if(done)return;done=true;
   try{const result=JSON.parse(out);
    // Only numeric / enumerated diagnostic fields, never URLs, message text or credentials.
    if(op==='speak'&&result.diagnostics){
     const d=result.diagnostics,trace={};
     if(d.audioFormat==='mp3')trace.audioFormat=d.audioFormat;
     for(const k of ['httpGets','httpHeads','httpRanges','httpBytesSent','httpErrors','audioBytes','audioSeconds','loadFailed'])if(Number.isFinite(d[k]))trace[k]=d[k];
     for(const k of ['receiverReady','loadAcknowledged','playbackStarted'])if(typeof d[k]==='boolean')trace[k]=d[k];
     if(['default','idle','other'].includes(d.initialApp))trace.initialApp=d.initialApp;
     if(['IDLE','PLAYING','BUFFERING','PAUSED','UNKNOWN','LOADING'].includes(d.finalState))trace.finalState=d.finalState;
     const idleReasons=['FINISHED','CANCELLED','INTERRUPTED','ERROR',''];
     const states=['IDLE','PLAYING','BUFFERING','PAUSED','UNKNOWN','LOADING'];
     if(idleReasons.includes(d.idleReason))trace.idleReason=d.idleReason;
     if(Array.isArray(d.mediaEvents))trace.mediaEvents=d.mediaEvents.slice(0,20).map(e=>({state:states.includes(e.state)?e.state:'UNKNOWN',idleReason:idleReasons.includes(e.idleReason)?e.idleReason:'UNKNOWN',matching:e.matching===true}));
     log('Cast playback diagnostics: '+JSON.stringify(trace));
    }
    if(code!==0)resolve({result:'error',reason:safeReason(result.reason)});else resolve(result);}
   catch(e){resolve({result:'error',reason:'process_error'});}
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({op,speaker:target.name||cfg.speaker,speakerId:target.id||'',volume:cfg.volume,text,manual,hosts:[...new Set([hosts[target.id],process.env.GH_CAST_HOST,...Object.values(hosts)].filter(Boolean))].slice(0,20),lanIp:process.env.GH_LAN_IP||''}));
 });
}
async function status(){
 if(!cfg||Date.now()-onlineAt>90000||statusWriting)return;
 statusWriting=true;statusDirty=false;lastStatus=Date.now();
 const base={updatedAt:serverTimestamp(),bridgeUid:uid,state:cfg.enabled?state:'disabled',device:device.slice(0,100),history:saved.history.slice(0,20),speakers:discovered,scannedAt,queue:queueView([...pending.values()],activeBatch,Date.now())};
 try{
  let monitor=null;try{monitor=collectMonitor(stateDir);}catch{log('Local monitor sample unavailable.');}
  if(monitor)try{await setDoc(statusRef,{...base,monitor});}catch(e){if(e.code!=='permission-denied')throw e;await setDoc(statusRef,base);log('Monitor not accepted; legacy status published.');}
  else await setDoc(statusRef,base);
 }catch(e){statusDirty=true;log('Status update failed: '+e.code);}finally{statusWriting=false;}
}
async function maybeScan(){
 if(!cfg||playing||probing||pending.size||Date.now()-onlineAt>90000)return;
 const requested=stamp(cfg.scanRequestedAt);
 if(Date.now()-lastProbe<300000&&requested<=lastScanRequest)return;
 if(Date.now()-lastProbe<10000)return;
 probing=true;lastProbe=Date.now();lastScanRequest=requested;
 try{
  const r=await cast('scan');
  if(r.result!=='ready')throw Error('scan failed');
  const rows=knownSpeakers((r.speakers||[]).map(d=>({...d,online:true})));
  const online=new Set(rows.map(d=>d.id));
  discovered=knownSpeakers([...rows,...discovered.filter(d=>!online.has(d.id)).map(d=>({...d,online:false}))]);
  const nextHosts={};
  for(const d of discovered){
   const h=(r.speakers||[]).find(x=>x.id===d.id)?.host||hosts[d.id];
   if(typeof h==='string'&&h.length<=100)nextHosts[d.id]=h;
  }
  hosts=nextHosts;saved.speakers=discovered;saved.hosts=hosts;persist();
  scannedAt=Date.now();
  const selected=routeTargets(cfg,'manual');
  const available=selected.filter(t=>discovered.some(d=>d.online&&(t.id?d.id===t.id:d.name===t.name)));
  device=available.map(t=>discovered.find(d=>t.id?d.id===t.id:d.name===t.name)?.name||t.name).join(' / ');
  state=available.length?'ready':'unavailable';
  log('Speaker discovery: '+rows.length+' available');
 }catch{state='unavailable';log('Speaker discovery failed.');}
 finally{probing=false;void status();}
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
  // A slow speaker scan must not delay cloud health refresh or the heartbeat.
  if(statusDirty||Date.now()-lastStatus>=60000)void status();
  void maybeScan();
 }catch(e){onlineAt=0;freshDocs.clear();state='error';log('Cloud connection unavailable: '+(e.code||'connection error'));}
 finally{if(!stopped)setTimeout(health,60000);}
}
async function deliver(){
 if(playing||probing||!current()||!settings||!profiles.older||!profiles.younger)return;
 const now=Date.now();
 let changed=false;for(const e of pending.values())if(!liveEvent(e,cfg,profiles,settings,now)){terminal(e,'stale');changed=true;}
 if(changed)persist();
 const first=sortedQueue(pending.values())[0];
 if(!first)return;
 // Allow related reward listeners a brief collection window; manual and time-critical notices are immediate.
 if(['pokemon','activity','xp','level','evolveReady','allDone','generation'].includes(first.type)&&now-(first.queuedAt||first.at)<2000)return;
 const selected=batchFor(first,pending.values(),cfg),batch=selected.batch;
 const targets=routeTargets(cfg,first.type),results=[];
 const targetKey=JSON.stringify(targets.map(t=>t.id||'name:'+t.name).sort());
 // Claim before invoking Cast: interrupted in-flight audio is never replayed on restart.
 for(const e of batch){pending.delete(e.key);remember(e);}
 activeBatch=selected;playing=true;state='busy';persist();statusDirty=true;
 try{
  for(const target of targets){
   const name=discovered.find(d=>d.id===target.id)?.name||target.name||'未検出のスピーカー';
   const currentBatch=()=>batch.map(e=>liveEvent(e,cfg,profiles,settings,Date.now())).filter(e=>e&&JSON.stringify(routeTargets(cfg,e.type).map(t=>t.id||'name:'+t.name).sort())===targetKey);
   const speak=async()=>{
    const live=currentBatch();
    if(!current()||!live.length)return {result:'skipped',reason:'stale'};
    const text=batchFor(live[0],live,cfg).text;
    return cast('speak',text,first.type==='manual',target);
   };
   try{
    let r=await speak();
    if(safeRetry(r)&&current()&&currentBatch().length){await new Promise(resolve=>setTimeout(resolve,1500));r=await speak();}
    const result=r.result==='sent'?'sent':r.result==='skipped'?'skipped':'error';
    results.push({name:String(r.device||name).slice(0,100),result,...(result==='sent'?{}:{reason:r.reason==='stale'?'stale':safeReason(r.reason)})});
   }catch{results.push({name,result:'error',reason:'cast_error'});}
  }
  const summary=deliverySummary(results),result=summary.result,reason=summary.reason;
  state=result==='sent'||result==='partial'||result==='skipped'?'ready':'error';
  device=results.filter(r=>r.result==='sent').map(r=>r.name).join(' / ')||device;
  log('Notification result: '+batch.map(e=>e.type).join('+')+' '+result+' ('+results.filter(r=>r.result==='sent').length+'/'+results.length+')');
  saved.history.unshift({at:Date.now(),type:first.type,types:batch.map(e=>e.type),result,...(reason?{reason}:{}),targets:results});
 }finally{activeBatch=null;playing=false;persist();statusDirty=true;}
}
function pump(){
 if(stopped)return;
 try{
  let expired=false;for(const e of pending.values())if(!validQueued(e,Date.now())){terminal(e,'stale');expired=true;}
  if(expired)persist();
  if(current()&&settings&&profiles.older&&profiles.younger){
   for(const e of timedEvents(profiles,settings,cfg))push(e);
   if(cfg.command?.id)push({type:'manual',key:'manual:'+cfg.command.id,at:stamp(cfg.command.at),text:cfg.command.text});
   if(!playing&&!probing){
    if(pending.size)void deliver().catch(()=>{log('Queue delivery failed.');process.exit(2);});
    else if(cfg&&stamp(cfg.scanRequestedAt)>lastScanRequest)void maybeScan();
   }
  }
  if((statusDirty&&Date.now()-lastStatus>=5000)||Date.now()-lastStatus>=60000)void status();
 }catch{log('Queue processing failed.');process.exit(2);}
 if(!stopped)setTimeout(pump,1000);
}
process.on('SIGINT',()=>{stopped=true;unsub.forEach(f=>f());process.exit(0);});
process.on('SIGTERM',()=>{stopped=true;unsub.forEach(f=>f());process.exit(0);});
log('Google Home bridge '+BRIDGE_VERSION+' Linux/Windows notification queue and monitoring; waiting for authorized configuration.');
void health();void pump();
