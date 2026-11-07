import {firebaseConfig, householdId} from './firebase-config.js';

const $ = id => document.getElementById(id);
const rolePage = document.body.dataset.role;
const isParentPage = rolePage === 'parent';
const ids = ['older','younger'];
const palette = ['sis','bro'];
const MIN = 60000, DAY = 86400000;
const version = 'v3.1.0';
const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const hms = ms => { const s=Math.max(0, Math.floor(ms/1000));return `${pad(Math.floor(s/3600))}:${pad(Math.floor(s/60)%60)}:${pad(s%60)}`; };
const brief = ms => {const m=Math.floor(Math.max(0,ms)/MIN);return m>=60?`${Math.floor(m/60)}時間${m%60?`${m%60}分`:''}`:m>0?`${m}分`: `${Math.max(0,Math.floor(ms/1000))}秒`;};
const clock = t => new Date(t).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
const dateTime = t => new Date(t).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const dateKey = t => {const d=new Date(t);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;};
const dayStart = t => {const d=new Date(t);d.setHours(0,0,0,0);return d.getTime();};
const addDays = (t,n) => {const d=new Date(t);d.setDate(d.getDate()+n);return d.getTime();};
const dateInput = t => {const d=new Date(t);return `${dateKey(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;};
const overlap = (s,e,a,b) => Math.max(0, Math.min(e,b)-Math.max(s,a));
const defaultSettings = () => ({devices:{sw1:'Switch',sw2:'Switch2'},reminderMinutes:60});
const playerBase = (id) => ({name:id==='older'?'お姉ちゃん':'弟くん',birthDate:'',gender:'neutral',activeStart:0,deviceId:null,restStart:0,restUntil:0,lastDuration:0,lastSessionId:'',updatedAt:null});
const model = {profiles:{},settings:defaultSettings(),sessions:[],presence:null,fromCache:true,ready:false,receivedAt:0,historyExtra:null};
let firebase, authApi, dbApi, auth, db, uid, role, paths, cleanups=[], busy=false, pendingStart=null, pendingEnd=null, editingId=null, lastSettingsHash='', historiesLastLoaded=0;
let selectedDay=dayStart(Date.now()), historyTab='home', toastHandle=null, familyInitialized=false;

function toast(message){const box=$('toast');box.textContent=message;box.classList.add('show');clearTimeout(toastHandle);toastHandle=setTimeout(()=>box.classList.remove('show'),4200);}
function errorText(e){return e?.code==='permission-denied'?'アクセス権限がありません。Firestore Rulesとmembers設定を確認してください。':e?.code?.startsWith('auth/')?'ログインに失敗しました。メールアドレスとパスワードを確認してください。':String(e?.message||e);}
function hasConfig(){return !Object.values(firebaseConfig).some(x=>!x||String(x).includes('REPLACE_')) && householdId && /^[a-z0-9-]{3,50}$/.test(householdId);}
function status(p,now=Date.now()){if(!p)return 'unknown';return p.activeStart>0?'playing':(p.restUntil||0)>now?'resting':'ready';}
function deviceName(id){return model.settings.devices?.[id]||({sw1:'Switch',sw2:'Switch2'}[id]||'Switch');}
function gameDuration(p,now=Date.now()){return p?.activeStart>0?Math.max(0,now-p.activeStart):0;}
function summaryFor(p,now=Date.now()){const s=status(p,now);return s==='playing'?gameDuration(p,now):s==='resting'?Math.max(0,p.restUntil-now):0;}
function todayTotal(child,now=Date.now()){
  const a=dayStart(now),b=addDays(a,1);let total=model.sessions.reduce((sum,s)=>sum+(s.childId===child?overlap(s.start,s.end,a,b):0),0);
  const p=model.profiles[child];if(p?.activeStart>0)total+=overlap(p.activeStart,now,a,b);return total;
}
function playerLabel(id){return model.profiles[id]?.name||playerBase(id).name;}
function validBirthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 9999) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    && value <= dateKey(Date.now());
}
function ageOf(profile, now = Date.now()) {
  const dob = profile?.birthDate;
  if (!validBirthDate(dob)) return null;
  const [year, month, day] = dob.split('-').map(Number);
  const today = dateKey(now).split('-').map(Number);
  return today[0] - year - (today[1] < month || (today[1] === month && today[2] < day) ? 1 : 0);
}
function displayIds() {
  // Both birth dates must be known; otherwise preserve existing positions.
  if (!ids.every(id => validBirthDate(model.profiles[id]?.birthDate))) return ids;
  return [...ids].sort((a, b) =>
    model.profiles[a].birthDate.localeCompare(model.profiles[b].birthDate)
    || ids.indexOf(a) - ids.indexOf(b));
}
function themeFor(profile) {
  return profile?.gender === 'female' ? 'sis' : profile?.gender === 'male' ? 'bro' : 'neutral';
}
function symbolFor(profile) {
  return profile?.gender === 'female' ? '🌸' : profile?.gender === 'male' ? '🚀' : '⭐';
}
function familyRole(id) {
  const gender = model.profiles[id]?.gender;
  const older = displayIds()[0] === id;
  if (gender === 'female') return older ? '姉' : '妹';
  if (gender === 'male') return older ? '兄' : '弟';
  return older ? '年上' : '年下';
}
function currentDateTick(){const now=Date.now();$('clock').textContent=clock(now);$('today-date').textContent=new Date(now).toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'short'});}
function renderSync(){const node=$('sync-indicator'),last=$('last-sync');if(!node)return;
  const online=navigator.onLine;
  let text='クラウド接続済み',cls='ok';
  if(!online||model.fromCache){text='接続確認中／キャッシュ表示';cls='warn'}
  if(!model.ready){text='データ読み込み中';cls='pending'}
  node.className=`signal ${cls}`;node.textContent=text;
  if(isParentPage){
    const t=model.presence?.lastSeenAt?.toMillis?.()||0;
    const diff=t?Date.now()-t:Infinity;
    last.textContent=t?`iPad最終接続：${dateTime(t)}（${diff<150000?'最近接続あり': '接続未確認'}）`:'iPadの接続情報なし';
  }else{
    const p=model.receivedAt;last.textContent=p?`受信：${clock(p)}`:'クラウド待機中';
  }
}
function renderAlerts(now=Date.now()){
  const alerts=[];
  if(isParentPage){
    const t=model.presence?.lastSeenAt?.toMillis?.()||0;
    if(!t||now-t>150000)alerts.push('<div class="alert stale">iPadの接続を現在確認できません。表示中のゲーム時間は、最後に届いた開始情報からの推定値です。</div>');
  }
  for(const id of ids){const p=model.profiles[id];if(p?.activeStart>0&&now-p.activeStart>=(model.settings.reminderMinutes||60)*MIN){alerts.push(`<div class="alert">⚠️ ${safe(p.name)}：${model.settings.reminderMinutes}分以上ゲーム中です。終了ボタンの押し忘れがないか確認してください。</div>`);}}
  $('alerts').innerHTML=alerts.join('');
}
function renderPlayers(now=Date.now()){
  if(!model.ready)return;
  $('players').innerHTML=displayIds().map((id,i)=>{
    const p=model.profiles[id]||playerBase(id),st=status(p,now),elapsed=gameDuration(p,now),left=Math.max(0,p.restUntil-now),restDuration=Math.max(1,p.restUntil-(p.restStart||0));
    const title=st==='playing'?'ゲーム中':st==='resting'?'休憩中':'スタートOK';
    const mainTitle=st==='playing'?'ゲームをはじめてから':st==='resting'?'つぎまで、あと':'ゲームができるよ！';
    const sub=st==='playing'?'じぶんで終わる時間をきめよう':st==='resting'?`${dateTime(p.restUntil)}から遊べる`:'じぶんのタイミングでスタート！';
    const detail=st==='playing'?`いま終わると ${brief(elapsed)} 休憩 ／ 次は ${dateTime(now+elapsed)}から`:
      st==='resting'?`${brief(p.lastDuration)} あそんだので、同じだけ休憩中`:(p.lastDuration>0?'前の休憩はおわったよ':'最初のゲームをはじめよう');
    const progress=st==='resting'?Math.min(100,(now-p.restStart)/restDuration*100):100;
    const actions=isParentPage?'':`<button class="action ${st==='playing'?'stop':''}" data-action="${st==='playing'?'end':'start'}" data-child="${id}" ${st==='resting'||busy||!navigator.onLine?'disabled':''}>${st==='playing'?'🛑 ゲームをおわる':st==='resting'?'💤 おやすみ中':'▶️ ゲームをはじめる'}</button>`;
    const device=p.activeStart>0?`🎮 ${safe(deviceName(p.deviceId))} であそんでいます`:'🎮 Switch / Switch2';
    const today=todayTotal(id,now),count=model.sessions.filter(s=>s.childId===id&&s.end>=dayStart(now)).length;
    const age = ageOf(p, now);
    const subtitle = `${age === null ? '年齢未設定' : `${age}さい`}・${familyRole(id)}`;
    return `<article class="player ${themeFor(p)}"><div class="player-head"><div><div class="player-name"><span class="emoji">${symbolFor(p)}</span>${safe(p.name)}</div><div class="player-sub">${safe(subtitle)}</div></div><span class="pill ${st}">${title}</span></div>
      <div class="big-time"><div class="caption">${mainTitle}</div><div class="digits">${hms(summaryFor(p,now))}</div><div class="detail">${safe(sub)}</div></div>
      <div class="progress"><i style="width:${progress.toFixed(1)}%"></i></div><div class="forecast"><strong>${st==='playing'?'⏰ いま終わったら':st==='resting'?'⌛ 前に遊んだ時間':'✨ じぶんでじかんを決めよう'}</strong><div class="forecast-line">${safe(detail)}</div>${st==='playing'?'<small>あと5分あそぶと、次の開始も10分おそくなるよ</small>':''}</div>
      <div class="player-device">${device}</div>${actions}<div class="mini"><div>今日のゲーム<strong>${brief(today)}</strong></div><div>今日おわった回数<strong>${count}回</strong></div></div></article>`;
  }).join('');
}
function renderDevices(){
  $('devices').innerHTML=['sw1','sw2'].map(id=>{const players=ids.filter(k=>model.profiles[k]?.activeStart>0&&model.profiles[k]?.deviceId===id);
   return `<div class="device-tile ${players.length?'busy':''}"><div><strong>🎮 ${safe(deviceName(id))}</strong><small>${players.length?`${players.length}人がゲーム中`:'いまはあいているよ'}</small></div><div>${players.length?players.map(p=>`<div class="device-person">${safe(playerLabel(p))}</div>`).join(''):'<span class="device-person">空き</span>'}</div></div>`;
  }).join('');
}
function weekData(now=Date.now()){
  const today=dayStart(now),days=Array.from({length:7},(_,i)=>addDays(today,i-6));
  const totals=days.map(d=>displayIds().map(id=>{
    const end=addDays(d,1);let sum=model.sessions.reduce((a,s)=>a+(s.childId===id?overlap(s.start,s.end,d,end):0),0);
    const p=model.profiles[id];if(p?.activeStart>0)sum+=overlap(p.activeStart,now,d,end);return sum;
  }));return {days,totals};
}
function renderWeek(){if(!$('week-chart'))return;const {days,totals}=weekData();const max=Math.max(15*MIN,...totals.flat());
  const ordered = displayIds();
  $('week-chart').innerHTML=`<div class="chart-legend">${ordered.map(id=>`<span><i class="dot ${themeFor(model.profiles[id])}"></i>${safe(playerLabel(id))}</span>`).join('')}</div>` + days.map((d,i)=>{
    const label=new Date(d).toLocaleDateString('ja-JP',{month:'numeric',day:'numeric',weekday:'short'}),t=totals[i];
    return `<div class="week-row"><div class="week-label">${label}</div><div class="week-bars">${t.map((v,j)=>`<div class="track"><div class="fill ${themeFor(model.profiles[ordered[j]])}" style="width:${(v/max*100).toFixed(1)}%"></div></div>`).join('')}</div><div class="week-total">${brief(t[0]+t[1])}</div></div>`;
  }).join('');
}
function daySessions(){const start=selectedDay,end=addDays(start,1);const arr=[...model.sessions];const now=Date.now();for(const id of ids){const p=model.profiles[id];if(p?.activeStart>0)arr.push({sid:'active-'+id,childId:id,start:p.activeStart,end:now,duration:now-p.activeStart,deviceId:p.deviceId,ongoing:true});}
  if(model.historyExtra && model.historyExtra.day===selectedDay){for(const s of model.historyExtra.items){if(!arr.some(x=>x.sid===s.sid))arr.push(s);}}
  return arr.filter(s=>overlap(s.start,s.end,start,end)>0).sort((a,b)=>b.start-a.start);
}
function renderHistory(){const target=$('history-list');if(!target)return;const sessions=daySessions(),start=selectedDay,end=addDays(start,1);
 $('history-date').value=dateKey(start);
 const frac=t=>Math.min(100,Math.max(0,(t-start)/(end-start)*100));
 const lines=displayIds().map((id,i)=>{const segs=sessions.filter(s=>s.childId===id).map(s=>`<i class="tseg ${themeFor(model.profiles[id])}" title="${safe(dateTime(s.start))}〜${safe(dateTime(s.end))}" style="left:${frac(s.start).toFixed(2)}%;width:${Math.max(.1,frac(s.end)-frac(s.start)).toFixed(2)}%"></i>`).join('');return `<div class="tlrow"><span>${safe(playerLabel(id))}</span><div class="tlbar">${segs}</div></div>`;}).join('');
 $('timeline').innerHTML=`<div class="tlaxis"><span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>24時</span></div><div class="timeline-people">${lines}</div>`;
 target.innerHTML=sessions.length?sessions.map(s=>`<div class="history-entry"><div><strong>${safe(playerLabel(s.childId))} · ${safe(deviceName(s.deviceId))}</strong><small>${dateTime(s.start)} 〜 ${s.ongoing?'現在':dateTime(s.end)} ${s.edited?'（修正済み）':''}</small></div><div class="right-entry"><strong>${brief(s.duration)}</strong>${isParentPage&&!s.ongoing?`<button class="btn outline" data-edit="${safe(s.sid)}">修正</button>`:''}</div></div>`).join(''):'<div class="empty">この日はまだゲームのきろくがありません</div>';
}
function render(now=Date.now()){
 currentDateTick();renderSync();if(!model.ready)return;renderAlerts(now);renderPlayers(now);renderDevices();
 if(isParentPage){if(Math.floor(now/1000)%5===0){renderWeek();renderHistory();}}
 else if(historyTab==='history'&&Math.floor(now/1000)%5===0){renderWeek();renderHistory();}
}
function setReady(){model.ready=ids.every(id=>model.profiles[id]);$('init-panel')?.classList.toggle('hidden',model.ready);render();if(model.ready){renderWeek();renderHistory();}}
function showApp(){ $('login-screen').classList.add('hidden');$('app-screen').classList.remove('hidden');}
function showLogin(){ $('login-screen').classList.remove('hidden');$('app-screen').classList.add('hidden');}
function listenerError(e){console.error(e);model.fromCache=true;toast(errorText(e));renderSync();}
function disconnect(){cleanups.forEach(fn=>{try{fn();}catch{}});cleanups=[];model.profiles={};model.sessions=[];model.presence=null;model.ready=false;}
function setSettingsForm(){if(!isParentPage)return;const hash=JSON.stringify({profiles:ids.map(i=>({name:model.profiles[i]?.name,birthDate:model.profiles[i]?.birthDate,gender:model.profiles[i]?.gender})),settings:model.settings});if(hash===lastSettingsHash)return;
 if(document.activeElement?.closest?.('#settings-form'))return;
  for (const id of ids) {
    $('name-'+id).value=playerLabel(id);
    $('birth-'+id).value=model.profiles[id]?.birthDate||'';
    $('gender-'+id).value=['female','male','neutral'].includes(model.profiles[id]?.gender) ? model.profiles[id].gender : 'neutral';
    $('birth-'+id).max=dateKey(Date.now());
  }
  $('device-sw1').value=deviceName('sw1');$('device-sw2').value=deviceName('sw2');$('reminder').value=String(model.settings.reminderMinutes||60);lastSettingsHash=hash;
}
function listen(){
 cleanups.push(dbApi.onSnapshot(dbApi.collection(db,'households',householdId,'profiles'),{includeMetadataChanges:true},snap=>{
   for(const doc of snap.docs)model.profiles[doc.id]=doc.data();model.fromCache=snap.metadata.fromCache;model.receivedAt=Date.now();setReady();setSettingsForm();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(dbApi.doc(db,'households',householdId,'settings','main'),{includeMetadataChanges:true},snap=>{
   if(snap.exists())model.settings={...defaultSettings(),...snap.data()};model.fromCache=snap.metadata.fromCache;model.receivedAt=Date.now();render();setSettingsForm();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(dbApi.query(dbApi.collection(db,'households',householdId,'sessions'),dbApi.orderBy('end','desc'),dbApi.limit(500)),snap=>{
   model.sessions=snap.docs.map(d=>({...d.data(),sid:d.id}));model.historyExtra=null;renderWeek();renderHistory();render();
 },listenerError));
 if(isParentPage){cleanups.push(dbApi.onSnapshot(dbApi.doc(db,'households',householdId,'presence','ipad'),snap=>{model.presence=snap.exists()?snap.data():null;renderSync();},listenerError));}
}
function refProfile(id){return dbApi.doc(db,'households',householdId,'profiles',id)}
function refSettings(){return dbApi.doc(db,'households',householdId,'settings','main')}
function sessionsRef(){return dbApi.collection(db,'households',householdId,'sessions')}
function ensureOnline(){if(!navigator.onLine)throw Error('インターネット接続が必要です。通信を確認してから操作してください。');}
async function runLocked(fn){if(busy)return;busy=true;try{ensureOnline();await fn();}catch(e){console.error(e);toast(errorText(e));}finally{busy=false;render();}}
async function startPlay(id,deviceId){return runLocked(async()=>{
  const now=Date.now();await dbApi.runTransaction(db,async tx=>{
    const ref=refProfile(id),snap=await tx.get(ref);if(!snap.exists())throw Error('家族データが見つかりません');const p=snap.data();
    if(p.activeStart>0)throw Error('すでにゲーム中です。');if(now<(p.restUntil||0))throw Error('まだ休憩中です。');
    tx.update(ref,{activeStart:now,deviceId,updatedAt:dbApi.serverTimestamp()});
  });$('device-dialog').close();toast(`${playerLabel(id)}：ゲームをスタート！`);
 });
}
async function endPlay(id){return runLocked(async()=>{
  const sidRef=dbApi.doc(sessionsRef());const now=Date.now();
  const duration=await dbApi.runTransaction(db,async tx=>{
    const ref=refProfile(id),snap=await tx.get(ref);if(!snap.exists())throw Error('家族データがありません');const p=snap.data();
    if(!p.activeStart)throw Error('すでに終了しています');const dur=Math.max(1000,now-p.activeStart);
    if(dur>7*DAY)throw Error('7日以上計測されています。保護者が開始時刻を確認してください。');
    tx.update(ref,{activeStart:0,deviceId:null,restStart:now,restUntil:now+dur,lastDuration:dur,lastSessionId:sidRef.id,updatedAt:dbApi.serverTimestamp()});
    tx.set(sidRef,{childId:id,start:p.activeStart,end:now,duration:dur,deviceId:p.deviceId||'sw1',createdAt:dbApi.serverTimestamp(),createdBy:uid,edited:false});
    return dur;
  });$('end-dialog').close();toast(`おつかれさま！ ${brief(duration)}の休憩スタート`);
 });
}
function chooseStart(id){const p=model.profiles[id];if(!p||p.activeStart||Date.now()<(p.restUntil||0))return toast('まだ休憩中だよ');pendingStart=id;
 $('device-title').textContent=`${p.name}：どのSwitchであそぶ？`;
 $('device-buttons').innerHTML=['sw1','sw2'].map(d=>{const players=ids.filter(i=>model.profiles[i]?.deviceId===d&&model.profiles[i]?.activeStart>0);return `<button class="device-select" data-device="${d}">🎮 ${safe(deviceName(d))}<span>${players.length?`${safe(players.map(i=>playerLabel(i)).join('・'))}といっしょに遊ぶ`:'いま、あいてるよ！'}</span></button>`;}).join('');$('device-dialog').showModal();
}
function chooseEnd(id){const p=model.profiles[id];if(!p?.activeStart)return;pendingEnd=id;const now=Date.now(),t=now-p.activeStart;
 $('end-confirm-text').innerHTML=`<div>${safe(p.name)}が遊んだ時間：<strong>${brief(t)}</strong></div><div>これから休憩：<strong>${brief(t)}</strong></div><div>つぎに遊べるのは：<strong>${dateTime(now+t)}</strong></div>`;$('end-dialog').showModal();}
async function initFamily(){await runLocked(async()=>{const b=dbApi.writeBatch(db);b.set(refSettings(),{...defaultSettings(),createdAt:dbApi.serverTimestamp()});for(const id of ids)b.set(refProfile(id),{...playerBase(id),updatedAt:dbApi.serverTimestamp()});await b.commit();toast('家族データを作成しました');});}
async function saveSettings(event){event.preventDefault();await runLocked(async()=>{
  const names=ids.map(id=>$('name-'+id).value.trim());
  const births=ids.map(id=>$('birth-'+id).value);
  const genders=ids.map(id=>$('gender-'+id).value);
  const devices={sw1:$('device-sw1').value.trim(),sw2:$('device-sw2').value.trim()};
  if(!names.every(Boolean)||!Object.values(devices).every(Boolean))throw Error('名前を入力してください');
  if(!births.every(validBirthDate))throw Error('生年月日を正しく入力してください（未来の日付は登録できません）。');
  if(!genders.every(g=>['female','male','neutral'].includes(g)))throw Error('性別を選択してください。');
 const b=dbApi.writeBatch(db);ids.forEach((id,i)=>b.update(refProfile(id),{name:names[i].slice(0,12),birthDate:births[i],gender:genders[i],updatedAt:dbApi.serverTimestamp()}));b.set(refSettings(),{devices,reminderMinutes:Number($('reminder').value)||60,updatedAt:dbApi.serverTimestamp()},{merge:true});await b.commit();toast('設定を保存しました');
 });}
async function editHistory(event){event.preventDefault();const sid=editingId;if(!sid)return;
 const a=new Date($('edit-start').value).getTime(),b=new Date($('edit-end').value).getTime();const orig=model.sessions.find(x=>x.sid===sid)||model.historyExtra?.items?.find(x=>x.sid===sid);
 if(!orig||!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b>Date.now()+MIN||b-a>7*DAY){return toast('開始・終了日時を確認してください');}
 if(model.sessions.some(s=>s.sid!==sid&&s.childId===orig.childId&&overlap(a,b,s.start,s.end)>0))return toast('他のプレイ履歴と重なっています');
 await runLocked(async()=>{
  await dbApi.runTransaction(db,async tx=>{
    const sessionRef=dbApi.doc(sessionsRef(),sid),profRef=refProfile(orig.childId);
    const snap=await tx.get(sessionRef),pSnap=await tx.get(profRef);if(!snap.exists()||!pSnap.exists())throw Error('更新対象が見つかりません');
    const existing=snap.data(),p=pSnap.data();
    tx.update(sessionRef,{start:a,end:b,duration:b-a,edited:true,updatedAt:dbApi.serverTimestamp()});
    if(p.activeStart===0&&p.lastSessionId===sid){tx.update(profRef,{restStart:b,restUntil:b+(b-a),lastDuration:b-a,updatedAt:dbApi.serverTimestamp()});}
  });$('edit-dialog').close();toast('記録と休憩時間を修正しました');
 });
}
async function editOpen(sid){const s=model.sessions.find(x=>x.sid===sid)||model.historyExtra?.items?.find(x=>x.sid===sid);if(!s)return;
 editingId=sid;$('edit-title').textContent=`${playerLabel(s.childId)}のきろくを修正`;$('edit-start').value=dateInput(s.start);$('edit-end').value=dateInput(s.end);$('edit-dialog').showModal();
}
async function loadSelectedDay(){const begin=selectedDay,end=addDays(begin,1);try{
  const q=dbApi.query(sessionsRef(),dbApi.where('end','>=',begin),dbApi.where('end','<',end),dbApi.orderBy('end','desc'),dbApi.limit(400));
  const docs=await dbApi.getDocs(q);model.historyExtra={day:begin,items:docs.docs.map(d=>({...d.data(),sid:d.id}))};renderHistory();
 }catch(e){toast('過去の履歴取得に失敗しました：'+errorText(e));}}
function download(filename,blob){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function exportData(format){try{const result=await dbApi.getDocs(sessionsRef()),sessions=result.docs.map(d=>({...d.data(),sid:d.id,createdAt:undefined,updatedAt:undefined}));
 if(format==='json'){const data={version:3,exportedAt:new Date().toISOString(),householdId,profiles:model.profiles,settings:model.settings,sessions};download(`asobu-yasumu-v3-${dateKey(Date.now())}.json`,new Blob([JSON.stringify(data,(k,v)=>['createdAt','updatedAt'].includes(k)?undefined:v,2)],{type:'application/json'}));}
 else {const csv=v=>{let s=String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;};const rows=[['子ども','本体','開始日時','終了日時','ゲーム時間(秒)','修正済み'],...sessions.map(s=>[playerLabel(s.childId),deviceName(s.deviceId),new Date(s.start).toLocaleString('ja-JP'),new Date(s.end).toLocaleString('ja-JP'),Math.round(s.duration/1000),s.edited?'はい':'いいえ'])];download(`asobu-yasumu-v3-${dateKey(Date.now())}.csv`,new Blob(['\ufeff'+rows.map(row=>row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));}
 toast('バックアップを保存しました');
 }catch(e){toast(errorText(e));}}
async function importV2(file){if(!file)return;await runLocked(async()=>{
 if(file.size>8*1024*1024)throw Error('8MB以下のJSONを選択してください');const source=JSON.parse(await file.text());if(source.version!==2||!Array.isArray(source.sessions)||!Array.isArray(source.children))throw Error('v2のJSONバックアップではありません');
 const existing=await dbApi.getDocs(dbApi.query(sessionsRef(),dbApi.limit(1)));if(!existing.empty)throw Error('クラウドに履歴があるため、二重登録防止のため取り込みを中止しました');
 if(ids.some(id=>model.profiles[id]?.activeStart>0))throw Error('ゲーム中は移行できません。終了後に実行してください');
 const n=source.sessions.length;if(!confirm(`v2のプレイ履歴 ${n}件をクラウドに取り込みますか？\n既存の子どもの状態・休憩時間も復元します。`))return;
 const data=source.sessions.filter(s=>ids.includes(s.childId)&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start);
 for(let i=0;i<data.length;i+=200){const b=dbApi.writeBatch(db);for(let j=i;j<Math.min(i+200,data.length);j++){const s=data[j];b.set(dbApi.doc(sessionsRef(),`legacy-${j}-${s.end}`),{childId:s.childId,start:s.start,end:s.end,duration:s.end-s.start,deviceId:['sw1','sw2'].includes(s.deviceId)?s.deviceId:'sw1',createdAt:dbApi.serverTimestamp(),createdBy:uid,edited:!!s.edited});}await b.commit();}
 const b=dbApi.writeBatch(db);for(let i=0;i<2;i++){
   const o=source.children[i]||{},id=ids[i];
   const recent=data.map((session,j)=>({session,j})).filter(x=>x.session.childId===id).sort((a,b)=>b.session.end-a.session.end)[0];
   const lastSessionId=recent?`legacy-${recent.j}-${recent.session.end}`:'';
   b.update(refProfile(id),{name:String(o.name||playerLabel(id)).slice(0,12),activeStart:0,deviceId:null,restStart:Number.isFinite(o.restStart)?o.restStart:0,restUntil:Number.isFinite(o.restUntil)?o.restUntil:0,lastDuration:Number.isFinite(o.lastDuration)?o.lastDuration:0,lastSessionId,updatedAt:dbApi.serverTimestamp()});
 }
 if(Array.isArray(source.devices)&&source.devices.length===2){b.update(refSettings(),{devices:{sw1:source.devices[0].name?.includes('①')?'Switch':(source.devices[0].name||'Switch'),sw2:source.devices[1].name?.includes('②')?'Switch2':(source.devices[1].name||'Switch2')}});}
 await b.commit();toast(`v2履歴 ${data.length}件を取り込みました。`);
 });}
async function heartbeat(){if(isParentPage||!uid||!document.visibilityState||document.visibilityState!=='visible'||!navigator.onLine)return;
 try{await dbApi.setDoc(dbApi.doc(db,'households',householdId,'presence','ipad'),{lastSeenAt:dbApi.serverTimestamp(),device:'ipad'}, {merge:true});}catch(e){console.warn('heartbeat',e);}
}
function initUiEvents(){
 $('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='接続中…';try{await authApi.signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value);$('password').value='';}catch(err){$('login-error').textContent=errorText(err);}});
 $('logout').addEventListener('click',async()=>{await authApi.signOut(auth);});
 document.addEventListener('click',e=>{
   const btn=e.target.closest('button');if(!btn)return;
   if(btn.hasAttribute('data-close')){btn.closest('dialog')?.close();return;}
   if(btn.dataset.action==='start')chooseStart(btn.dataset.child);
   if(btn.dataset.action==='end')chooseEnd(btn.dataset.child);
   if(btn.dataset.device&&pendingStart)startPlay(pendingStart,btn.dataset.device);
   if(btn.dataset.edit)editOpen(btn.dataset.edit);
 });
 document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close();}));
 $('confirm-end')?.addEventListener('click',()=>pendingEnd&&endPlay(pendingEnd));
 $('init-family')?.addEventListener('click',initFamily);
 $('settings-form')?.addEventListener('submit',saveSettings);
 $('edit-form')?.addEventListener('submit',editHistory);
 $('export-json')?.addEventListener('click',()=>exportData('json'));
 $('export-csv')?.addEventListener('click',()=>exportData('csv'));
 $('import-v2-file')?.addEventListener('change',e=>{importV2(e.target.files?.[0]);e.target.value='';});
 $('history-date').value=dateKey(selectedDay);$('history-date').max=dateKey(Date.now());
 $('history-date').addEventListener('change',e=>{const d=new Date(e.target.value+'T00:00:00').getTime();if(!Number.isFinite(d)||d>dayStart(Date.now()))return;selectedDay=d;model.historyExtra=null;renderHistory();loadSelectedDay();});
 $('tab-home')?.addEventListener('click',()=>{historyTab='home';$('history').classList.add('hidden');$('tab-home').classList.add('subnav-active');$('tab-history').classList.remove('subnav-active');});
 $('tab-history')?.addEventListener('click',()=>{historyTab='history';$('history').classList.remove('hidden');$('tab-home').classList.remove('subnav-active');$('tab-history').classList.add('subnav-active');renderWeek();renderHistory();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){heartbeat();render();}});
 window.addEventListener('online',()=>{heartbeat();render();});window.addEventListener('offline',render);
}
async function startFirebase(){
  if(!hasConfig()){$('setup-warning').innerHTML='Firebase設定が未入力です。Windowsで <code>firebase-config.js</code> を設定し、READMEの手順で公開してください。<br>この状態ではクラウドの利用状況は表示されません。';$('setup-warning').classList.remove('hidden');$('login-form').querySelector('button').disabled=true;return;}
  try{
   const v='12.19.0';const [fb,au,fs]=await Promise.all([
     import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
     import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
     import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`)]);
   firebase=fb;authApi=au;dbApi=fs;
   const app=fb.initializeApp(firebaseConfig);auth=au.getAuth(app);db=fs.initializeFirestore(app,{experimentalForceLongPolling:true});
   initUiEvents();
   au.onAuthStateChanged(auth,async user=>{
     disconnect();if(!user){uid=null;showLogin();return;}
     uid=user.uid;
     try{
       const member=await fs.getDoc(fs.doc(db,'households',householdId,'members',uid));
       if(!member.exists())throw Error('このアカウントの家族メンバー登録がありません。Firebaseのmembers設定を確認してください。');
       role=member.data().role;
       if(!['parent','kid'].includes(role))throw Error('役割の設定が正しくありません。');
       if(isParentPage&&role!=='parent')throw Error('この画面は保護者アカウント専用です。');
       if(!isParentPage&&role!=='kid')throw Error('この画面はiPad専用アカウントでログインしてください。');
       $('login-error').textContent='';showApp();listen();if(!isParentPage){heartbeat();}
     }catch(e){$('login-error').textContent=errorText(e);showLogin();await au.signOut(auth);}
   });
   if(!isParentPage){setInterval(heartbeat,60000);}
   setInterval(render,1000);render();
   if('serviceWorker' in navigator && !isParentPage && location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }catch(e){console.error(e);$('setup-warning').textContent='Firebase SDKに接続できません。インターネット接続、ブラウザ設定、設定ファイルを確認してください。 '+errorText(e);$('setup-warning').classList.remove('hidden');}
}
currentDateTick();setInterval(currentDateTick,1000);
startFirebase();
