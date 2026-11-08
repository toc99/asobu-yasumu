import {firebaseConfig, householdId} from './firebase-config.js';

const $ = id => document.getElementById(id);
const rolePage = document.body.dataset.role;
const isParentPage = rolePage === 'parent';
const ids = ['older','younger'];
const palette = ['sis','bro'];
const MIN = 60000, DAY = 86400000, JST_OFFSET = 9 * 60 * MIN;
const version = 'v3.6.0';
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
const defaultSettings = () => ({devices:{sw1:'Switch',sw2:'Switch2'},reminderMinutes:60,videoLimitMinutes:30,nightPause:{enabled:false,start:'22:00',end:'07:00',startMinutes:1320,endMinutes:420,enabledAt:0}});
const playerBase = (id) => ({name:id==='older'?'子ども1':'子ども2',birthDate:'',gender:'neutral',activeStart:0,deviceId:null,startedAt:null,endedAt:null,restStart:0,restUntil:0,manualRestUntil:0,manualRestMinutes:0,manualRestSetAt:null,manualRestSetBy:'',manualRestSetRole:'',lastDuration:0,lastSessionId:'',nightResumeAt:null,nightResumeWindowEnd:0,videoStartedAt:null,videoDurationMinutes:0,updatedAt:null});
const model = {profiles:{},settings:defaultSettings(),sessions:[],presence:null,fromCache:true,ready:false,receivedAt:0,historyExtra:null,profilesServerConfirmed:false,settingsServerConfirmed:false,auditLogs:[],reportSessions:[],reportLoaded:false,reportFromCache:true,reportTruncated:false};
let firebase, authApi, dbApi, auth, db, uid, role, paths, cleanups=[], busy=false, pendingStart=null, pendingEnd=null, editingId=null, lastSettingsHash='', historiesLastLoaded=0;
let selectedDay=dayStart(Date.now()), historyTab='home', toastHandle=null, familyInitialized=false, pendingManual=null;
let pendingCorrection=null, reconnecting=null, retryAfterError=false, authCheckBusy=false, refreshing=false;

function toast(message){const box=$('toast');box.textContent=message;box.classList.add('show');clearTimeout(toastHandle);toastHandle=setTimeout(()=>box.classList.remove('show'),4200);}
function isTransient(e){return ['unavailable','deadline-exceeded'].includes(e?.code)||/client is offline|network-request-failed|network error|offline|failed to fetch/i.test(String(e?.message||''));}
function errorText(e){return e?.code==='permission-denied'?'アクセス権限がありません。Firestore Rulesとmembers設定を確認してください。':e?.code?.startsWith('auth/')?'ログインに失敗しました。メールアドレスとパスワードを確認してください。':String(e?.message||e);}
function hasConfig(){return !Object.values(firebaseConfig).some(x=>!x||String(x).includes('REPLACE_')) && householdId && /^[a-z0-9-]{3,50}$/.test(householdId);}
function canOperate(){return !!uid && !!model.ready && !!model.profilesServerConfirmed && !!model.settingsServerConfirmed && navigator.onLine;}
function stampMillis(stamp){return stamp?.toMillis?.()||0;}
function undoKind(p, now=Date.now()){
  if(!p||!canOperate()||isParentPage)return null;
  if(p.activeStart>0 && stampMillis(p.startedAt)>0 && now-stampMillis(p.startedAt)>=0 && now-stampMillis(p.startedAt)<30000) return 'start';
  if(p.activeStart===0 && p.lastSessionId && stampMillis(p.endedAt)>0 && now-stampMillis(p.endedAt)>=0 && now-stampMillis(p.endedAt)<30000) return 'end';
  return null;
}
// 夜間待ち時間の持ち越し。計算の基準時刻はJST（夏時間なし）。
function clockMinute(value){
  if(typeof value!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))return null;
  const [h,m]=value.split(':').map(Number);return h*60+m;
}
function pausePolicy(){
  const obj=model.settings?.nightPause||{};
  const start=clockMinute(obj.start),end=clockMinute(obj.end);
  if(obj.enabled!==true||start===null||end===null||start<=end)return null;
  return {start,end,enabledAt:Math.max(0,Number(obj.enabledAt)||0)};
}
function nightWindow(t,policy){
  const day=Math.floor((t+JST_OFFSET)/DAY)*DAY-JST_OFFSET;
  const minute=(t-day)/MIN;
  if(minute<policy.end)return {paused:true,until:day+policy.end*MIN};
  if(minute>=policy.start)return {paused:true,until:day+DAY+policy.end*MIN};
  return {paused:false,until:day+policy.start*MIN};
}
function isNightPaused(now=Date.now(),policy=pausePolicy()){
  return !!policy && now>=policy.enabledAt && nightWindow(now,policy).paused;
}
// 子どもごとに、当夜の夜間停止だけを「いまから消化」に切り替える。
// Firestoreの時刻を使い、他の夜や前倒し前の時間には遡及させない。
function nightResumeMillis(p){return stampMillis(p?.nightResumeAt);}
function resumedForWindow(p,t,policy=pausePolicy()){
  if(!policy || !p)return false;
  const start=nightResumeMillis(p),end=Number(p.nightResumeWindowEnd)||0;
  if(!start||!end||start<policy.enabledAt||t<start||t>=end)return false;
  const w=nightWindow(t,policy);
  return w.paused && w.until===end && nightWindow(start,policy).paused
    && nightWindow(start,policy).until===end;
}
function resumedThisNight(p,now=Date.now(),policy=pausePolicy()){
  return resumedForWindow(p,now,policy);
}
function eligibleSlice(t,policy,resumeAt=0,resumeWindowEnd=0){
  const win=nightWindow(t,policy);
  if(!win.paused)return {eligible:true,until:win.until};
  const matching=resumeAt>0&&resumeWindowEnd===win.until
    && nightWindow(resumeAt,policy).paused&&nightWindow(resumeAt,policy).until===win.until;
  if(!matching)return {eligible:false,until:win.until};
  if(t<resumeAt)return {eligible:false,until:Math.min(win.until,resumeAt)};
  return {eligible:true,until:win.until};
}
function canEarlyResume(p,now=Date.now()){
  const policy=pausePolicy();
  if(isParentPage||!p||p.activeStart>0||!canOperate()||!policy||!isNightPaused(now,policy))return false;
  if(resumedThisNight(p,now,policy))return false;
  return waitingRemaining(p,now)>0;
}
function hasNightResumeRuleConfig(){
  const cfg=model.settings?.nightPause;
  const policy=pausePolicy();
  return !!policy&&Number.isInteger(cfg.startMinutes)&&Number.isInteger(cfg.endMinutes)
    && cfg.startMinutes===policy.start&&cfg.endMinutes===policy.end;
}
// 消化対象時間だけを進める。ページを閉じても、同じ開始時刻・時間帯から同じ終了予定を再現できる。
function advanceEligible(start,duration,policy=pausePolicy(),resumeAt=0,resumeWindowEnd=0){
  if(!(duration>0))return start;
  if(!policy)return start+duration;
  let t=start,left=duration;
  for(let i=0;left>0&&i<2000;i++){
    if(t<policy.enabledAt){const step=Math.min(left,policy.enabledAt-t);left-=step;t+=step;continue;}
    const window=eligibleSlice(t,policy,resumeAt,resumeWindowEnd);
    if(!window.eligible){t=window.until;continue;}
    const step=Math.min(left,window.until-t);
    if(step<=0)throw Error('夜間時間帯の計算に失敗しました');
    left-=step;t+=step;
  }
  if(left>0)throw Error('待ち時間が長すぎます');
  return t;
}
function eligibleElapsed(start,end,policy=pausePolicy(),resumeAt=0,resumeWindowEnd=0){
  if(!(end>start))return 0;
  if(!policy)return end-start;
  let t=start,result=0;
  for(let i=0;t<end&&i<2000;i++){
    if(t<policy.enabledAt){const next=Math.min(end,policy.enabledAt);result+=next-t;t=next;continue;}
    const window=eligibleSlice(t,policy,resumeAt,resumeWindowEnd),next=Math.min(end,window.until);
    if(window.eligible)result+=next-t;
    t=next;
  }
  return result;
}
function normalRestEnd(p){
  const raw=Number(p?.restUntil)||0,start=Number(p?.restStart)||0;
  const policy=pausePolicy();
  if(!policy||raw<=start||raw<=policy.enabledAt)return raw;
  return Math.max(raw,advanceEligible(start,raw-start,policy,nightResumeMillis(p),Number(p?.nightResumeWindowEnd)||0));
}
function displayTimeRange(){const p=pausePolicy();return p?`${model.settings.nightPause.start}〜${model.settings.nightPause.end}`:'';}
function renderNightPolicy(){const e=$('night-policy');if(!e)return;
  const p=pausePolicy();
  e.classList.toggle('hidden',!p);
  if(p)e.textContent=`夜間持ち越し：${displayTimeRange()}は原則として待ち時間が減りません${isNightPaused()?'／子ども別に前倒し再開できます':''}`;
}
function auditRef(){return dbApi.doc(dbApi.collection(db,'households',householdId,'auditLogs'));}
function appendAudit(writer,action,childId,before,after,sessionId=''){
  const truncate=v=>String(v??'').slice(0,300);
  writer.set(auditRef(),{action,childId,actorUid:uid,actorRole:role,createdAt:dbApi.serverTimestamp(),
    before:truncate(before),after:truncate(after),sessionId:sessionId||''});
}
const AUDIT_ACTIONS={start:'ゲーム開始',end:'ゲーム終了',undo_start:'開始取り消し',undo_end:'終了取り消し',
  manual_set:'手動待ち時間の設定',manual_clear:'手動待ち時間の解除',night_resume:'夜間の前倒し再開',forgotten_end:'終了忘れ修正',
  history_edit:'履歴修正',settings_update:'保護者設定の変更',family_init:'家族の初期化',video_start:'動画視聴開始',video_stop:'動画視聴終了'};
function renderAudit(){const node=$('audit-list');if(!node)return;
  const entries=model.auditLogs;
  node.innerHTML=entries.length?entries.map(a=>{
    const created=stampMillis(a.createdAt);
    const who=a.actorRole==='parent'?'保護者':'子ども用iPad';
    const target=ids.includes(a.childId)?playerLabel(a.childId):'家族全体';
    return `<div class="audit-entry"><div class="audit-head"><strong>${safe(AUDIT_ACTIONS[a.action]||a.action)} · ${safe(target)}</strong><span>${created?safe(new Date(created).toLocaleString('ja-JP')):'日時確認中'} · ${who}</span></div><div class="audit-values"><span>変更前：${safe(a.before||'—')}</span><span>変更後：${safe(a.after||'—')}</span></div></div>`;
  }).join(''):'<p class="empty">v3.4導入後の操作履歴はまだありません。</p>';
}
function restEnd(p){return Math.max(normalRestEnd(p),p?.manualRestUntil||0);}
function normalWaitRemaining(p, now=Date.now()){
  const raw=Number(p?.restUntil)||0,start=Number(p?.restStart)||0,policy=pausePolicy();
  if(!policy||raw<=start||raw<=policy.enabledAt)return Math.max(0,raw-now);
  return Math.max(0,(raw-start)-eligibleElapsed(start,now,policy,nightResumeMillis(p),Number(p?.nightResumeWindowEnd)||0));
}
function manualWaitRemaining(p, now=Date.now()){
  const until=Number(p?.manualRestUntil)||0;
  if(until<=now)return 0;
  const started=stampMillis(p.manualRestSetAt),policy=pausePolicy();
  // Older v3.3 manual waits retain their already recorded end time.
  if(!policy||!started||started<policy.enabledAt)return until-now;
  const minutes=Number(p.manualRestMinutes)||0;
  if(minutes<=0)return until-now;
  return Math.max(0,Math.min(until-now,minutes*MIN-eligibleElapsed(started,now,policy,nightResumeMillis(p),Number(p?.nightResumeWindowEnd)||0)));
}
function waitingRemaining(p,now=Date.now()){
  return Math.max(normalWaitRemaining(p,now),manualWaitRemaining(p,now));
}
function status(p,now=Date.now()){if(!p)return 'unknown';return p.activeStart>0?'playing':restEnd(p)>now?'resting':'ready';}
function gameDuration(p,now=Date.now()){return p?.activeStart>0?Math.max(0,now-p.activeStart):0;}
function summaryFor(p,now=Date.now()){const s=status(p,now);return s==='playing'?gameDuration(p,now):s==='resting'?waitingRemaining(p,now):0;}
function todayTotal(child,now=Date.now()){
  const a=dayStart(now),b=addDays(a,1);let total=model.sessions.reduce((sum,s)=>sum+(s.childId===child?overlap(s.start,s.end,a,b):0),0);
  const p=model.profiles[child];if(p?.activeStart>0)total+=overlap(p.activeStart,now,a,b);return total;
}
function playerLabel(id){
  const name=String(model.profiles[id]?.name||'').trim();
  // v3.0初期値の続柄を画面から除去。利用者が入力したその他の名前は維持。
  if(!name||name==='お姉ちゃん'||name==='弟くん')return id==='older'?'子ども1':'子ども2';
  return name;
}
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

// v3.5: 週間レポートは完了済みの7日間を対象にし、途中の「今日」を含めない。
const REPORT_LIMIT = 1500;
function reportRange(now=Date.now()) {
  const end=dayStart(now);
  return {before:addDays(end,-14),start:addDays(end,-7),end};
}
function reportStats(id) {
  const {before,start,end}=reportRange();
  const sessions=model.reportSessions.filter(s=>s.childId===id && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end>s.start).sort((a,b)=>a.start-b.start || a.end-b.end);
  const days=Array.from({length:7},(_,i)=>addDays(start,i));
  const daily=days.map(d=>sessions.reduce((total,s)=>total+overlap(s.start,s.end,d,addDays(d,1)),0));
  const total=daily.reduce((a,b)=>a+b,0);
  const priorDays=Array.from({length:7},(_,i)=>addDays(before,i));
  const prevTotal=priorDays.reduce((sum,d)=>sum+sessions.reduce((a,s)=>a+overlap(s.start,s.end,d,addDays(d,1)),0),0);
  const completed=sessions.filter(s=>s.end>=start && s.end<end);
  // 休憩間隔の「記録上の比較」。夜間停止・保護者修正・端末外のゲームは監査できない。
  let checked=0,passed=0;
  for(let i=1;i<sessions.length;i++){
    const s=sessions[i],prev=sessions[i-1];
    if(s.start<start||s.start>=end || prev.end> s.start || prev.end < before)continue;
    checked++;
    if(s.start>=prev.end+(prev.end-prev.start))passed++;
  }
  // sessions.createdBy は当該アプリの子ども/保護者アカウントのUID。
  // 旧版データ移行時に保護者が作成した履歴は「子ども自身の終了」に数えない。
  const selfEnded=completed.filter(s=>typeof s.createdBy==='string' && s.createdBy.length>0 && (isParentPage ? s.createdBy!==uid : s.createdBy===uid)).length;
  const badges=[
    {icon:'🌟',title:'じぶんでおしまい',description:'子ども画面から1回終了',earned:selfEnded>=1},
    {icon:'🏅',title:'おしまい上手',description:'子ども画面から3回終了',earned:selfEnded>=3},
    {icon:'🌱',title:'やすむ名人',description:'記録上、休憩間隔を3回守れた',earned:passed>=3}
  ];
  return {total,prevTotal,average:total/7,daily,days,completed:completed.length,checked,passed,selfEnded,badges};
}
function reportDelta(now,prev){
  if(prev===0)return now===0?'前週と同じ':'前週の記録なし';
  const p=Math.round((now-prev)/prev*100);
  return `${p>0?'+':''}${p}%`;
}
function renderReport(){
  const node=$('weekly-report');if(!node)return;
  if(!model.reportLoaded){node.innerHTML='<p class="empty">週間レポートを読み込み中…</p>';return;}
  const range=reportRange();
  const header=`<p class="report-note">${safe(dateKey(range.start))}〜${safe(dateKey(range.end-DAY))}の確定記録（今日のプレイは明日の集計から反映）</p>`;
  const cards=displayIds().map(id=>{
    const stats=reportStats(id);
    const theme=themeFor(model.profiles[id]);
    const pct=stats.checked?Math.round(stats.passed/stats.checked*100):null;
    const dayBars=stats.daily.map((v,i)=>{
      const pctBar=Math.max(0,Math.min(100,v/(Math.max(...stats.daily,30*MIN))*100));
      const label=new Date(stats.days[i]).toLocaleDateString('ja-JP',{month:'numeric',day:'numeric'});
      return `<div class="report-day"><span>${safe(label)}</span><div class="report-track"><i class="${theme}" style="width:${pctBar.toFixed(1)}%"></i></div><span>${safe(brief(v))}</span></div>`;
    }).join('');
    const badges=stats.badges.map(b=>`<div class="badge-item ${b.earned?'earned':'locked'}" aria-label="${safe(b.title)}・${b.earned?'達成':'未達成'}"><span aria-hidden="true">${b.earned?b.icon:'○'}</span><strong>${safe(b.title)}</strong><small>${safe(b.description)}${b.earned?' · 達成':''}</small></div>`).join('');
    return `<article class="report-card ${theme}"><h3>${safe(symbolFor(model.profiles[id]))} ${safe(playerLabel(id))}</h3>
      <div class="report-metrics"><div><small>7日間の合計</small><strong>${safe(brief(stats.total))}</strong></div><div><small>1日平均（7日割）</small><strong>${safe(brief(stats.average))}</strong></div><div><small>前週比</small><strong>${safe(reportDelta(stats.total,stats.prevTotal))}</strong></div></div>
      <div class="report-subtitle">日別プレイ時間</div><div class="report-days">${dayBars}</div>
      <div class="report-subtitle">記録上の休憩間隔</div><p class="report-compliance">${pct===null?'比較できる連続記録がありません':`${stats.passed}/${stats.checked}回（${pct}%）`}</p>
      <div class="report-subtitle">今週のバッジ</div><div class="report-badges">${badges}</div></article>`;
  }).join('');
  node.innerHTML=header+`<div class="report-grid">${cards}</div>`+
    `<p class="tiny report-caveat">集計はアプリに記録された履歴に基づきます。休憩間隔は「直前のゲーム時間と同じ長さを空けたか」の参考値です。夜間停止・保護者による変更や、ゲーム機本体の実利用までは判定しません。${model.reportFromCache?'（通信が不安定なため保存済みデータを表示中）':''}${model.reportTruncated?'（取得上限に達したため集計が不完全な可能性があります）':''}</p>`;
}
// v3.5: iPadでアプリを開いている間に使える画面通知＋音＋任意のOS通知。
// Web Pushサーバーがないため、アプリを閉じた状態への通知は保証しない。
const notifyKeys={enabled:'asobu.v35.notify.enabled',sound:'asobu.v35.notify.sound'};
function storedFlag(key,fallback=false){try{const v=localStorage.getItem(key);return v===null?fallback:v==='true';}catch{return fallback;}}
function saveFlag(key,value){try{localStorage.setItem(key,String(value));}catch{}}
let notifyEnabled=storedFlag(notifyKeys.enabled,false),notifySound=storedFlag(notifyKeys.sound,true);
let noticeAudio=null,noticeHideTimer=null;
const previousRest=new Map(),noticeDedup=new Set();
function initNotifySettings(){
  if(isParentPage)return;
  $('notify-enabled').checked=notifyEnabled;$('notify-sound').checked=notifySound;
  updateNotifyHelp();
}
function updateNotifyHelp(){
  const el=$('notify-help');if(!el)return;
  const granted=typeof Notification!=='undefined' && Notification.permission==='granted';
  const possible=typeof Notification!=='undefined' && typeof Notification.requestPermission==='function' && 'serviceWorker' in navigator;
  el.textContent=(!notifyEnabled?'お知らせはOFFです。':`画面内のお知らせはONです。${notifySound?'音も鳴らします。':'音は鳴らしません。'}`)+
    (granted?' 端末のシステム通知も許可されています（アプリ起動中のみ）。':possible?' 「システム通知を許可」は任意です。':' このブラウザーではシステム通知を使えません。')+
    ' iPadを閉じた状態や別アプリ使用中の通知は保証しません。';
  $('notify-permission').classList.toggle('hidden',!possible||granted);
}
function warmAudio(){
  if(!notifySound)return;
  try{
    const Ctor=window.AudioContext||window.webkitAudioContext;
    if(Ctor){noticeAudio=noticeAudio||new Ctor();noticeAudio.resume().catch(()=>{});}
  }catch(e){console.warn('audio warm-up',e);}
}
function playNoticeSound(){
  if(!notifySound||!noticeAudio||noticeAudio.state!=='running')return;
  try{
    const ctx=noticeAudio,t=ctx.currentTime;
    for(const [index,freq] of [660,880].entries()){
      const osc=ctx.createOscillator(),gain=ctx.createGain(),at=t+index*.19;
      osc.type='sine';osc.frequency.value=freq;
      gain.gain.setValueAtTime(0.0001,at);gain.gain.exponentialRampToValueAtTime(0.10,at+.025);gain.gain.exponentialRampToValueAtTime(0.0001,at+.17);
      osc.connect(gain);gain.connect(ctx.destination);osc.start(at);osc.stop(at+.18);
    }
  }catch(e){console.warn('notification sound',e);}
}
async function systemNotice(title,body,tag){
  if(typeof Notification==='undefined'||Notification.permission!=='granted'||!('serviceWorker' in navigator))return;
  try{const reg=await navigator.serviceWorker.ready;
    if(typeof reg.showNotification==='function')await reg.showNotification(title,{body,tag,icon:'./icon-192.png',badge:'./icon-192.png'});
  }catch(e){console.warn('system notification unavailable',e);}
}
function showRestNotice(title,body,tag){
  const panel=$('rest-notice');if(!panel)return;
  $('rest-notice-title').textContent=title;$('rest-notice-text').textContent=body;panel.classList.remove('hidden');
  clearTimeout(noticeHideTimer);noticeHideTimer=setTimeout(()=>panel.classList.add('hidden'),20000);
  playNoticeSound();systemNotice(title,body,tag);
}
function checkRestNotices(now=Date.now()){
  if(isParentPage||!model.ready||!canOperate()||document.hidden)return;
  for(const id of ids){
    const p=model.profiles[id];if(!p)continue;
    const due=restEnd(p),left=p.activeStart>0?0:waitingRemaining(p,now),resting=p.activeStart===0&&left>0;
    const prev=previousRest.get(id);const current={due,left,resting};
    previousRest.set(id,current);
    if(!notifyEnabled||!prev||!prev.resting||prev.due!==due)continue;
    let kind=null,title='',body='';
    if(prev.left>0 && !resting && left===0 && now-due>=0 && now-due<=60000){kind='end';title=`${playerLabel(id)}：休憩おわり！`;body='ゲームをはじめてもいいよ。';}
    else if(resting&&prev.left>MIN&&left<=MIN){kind='1m';title=`${playerLabel(id)}：あと1分`;body='もうすぐ休憩がおわるよ。';}
    else if(resting&&prev.left>5*MIN&&left<=5*MIN){kind='5m';title=`${playerLabel(id)}：あと5分`;body='あと少し、ゆっくり休もう。';}
    if(!kind)continue;
    const key=`${id}|${due}|${kind}`;
    if(noticeDedup.has(key))continue;
    noticeDedup.add(key);showRestNotice(title,body,`asobu-${key}`);
  }
}

function currentDateTick(){const now=Date.now();$('clock').textContent=clock(now);$('today-date').textContent=new Date(now).toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'short'});}
function renderSync(){const node=$('sync-indicator'),last=$('last-sync');if(!node)return;
  const online=navigator.onLine;
  let text='クラウド接続済み',cls='ok';
  if(!online){text='オフライン：操作を停止中';cls='warn'}
  else if(!model.profilesServerConfirmed||!model.settingsServerConfirmed){text='再接続中：最新状態を確認中';cls='warn'}
  if(!model.ready){text='データ読み込み中';cls='pending'}
  $('retry-connect')?.classList.toggle('hidden',!!model.profilesServerConfirmed&&!!model.settingsServerConfirmed&&online);
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
  for(const id of ids){const p=model.profiles[id];if(p?.activeStart>0&&now-p.activeStart>=(model.settings.reminderMinutes||60)*MIN){alerts.push(`<div class="alert">⚠️ ${safe(playerLabel(id))}：${model.settings.reminderMinutes}分以上ゲーム中です。終了ボタンの押し忘れがないか確認してください。</div>`);}}
  $('alerts').innerHTML=alerts.join('');
}
// 動画タイマーはゲーム時間・通常休憩とは独立。Firestoreのサーバー時刻で開始を記録。
// iPadでYouTubeを開いている間のお知らせは、別途iPad標準の「タイマーを開始」ショートカットを使用する。
const VIDEO_SHORTCUT_NAME = 'あそぶやすむ動画タイマー';
function videoStartedMillis(p){return stampMillis(p?.videoStartedAt);}
function videoLimitOf(p){const n=Number(p?.videoDurationMinutes);return Number.isInteger(n)&&n>=1&&n<=240?n:30;}
function videoDueMillis(p){const start=videoStartedMillis(p);return start?start+videoLimitOf(p)*MIN:0;}
function videoShortcutUrl(minutes){
  const n=Math.max(1,Math.min(240,Math.floor(Number(minutes)||30)));
  return `shortcuts://run-shortcut?name=${encodeURIComponent(VIDEO_SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(String(n))}`;
}
function renderVideoAction(id,p,now=Date.now()){
  const start=videoStartedMillis(p),minutes=videoLimitOf(p),due=videoDueMillis(p),active=!!start;
  if(!active){
    return `<div class="video-box"><div class="video-head">📺 動画を見る <small>お知らせ：${Number(model.settings.videoLimitMinutes)||30}分</small></div>`+
      (isParentPage?'<p class="video-note">動画の開始状況はiPadから記録されます。</p>':
       `<button type="button" class="btn video-start" data-video-start="${id}" ${p.activeStart>0||busy||!canOperate()?'disabled':''}>▶️ 動画を見る</button>`)+
      '</div>';
  }
  const remaining=Math.max(0,due-now),overdue=now>=due;
  const label=overdue?'時間になったよ！':`あと ${hms(remaining)}`;
  const nativeAction=!isParentPage&&!overdue?`<a class="btn video-shortcut" href="${safe(videoShortcutUrl(Math.max(1,Math.ceil(remaining/MIN))))}" aria-label="iPadの標準タイマーを残り${Math.max(1,Math.ceil(remaining/MIN))}分で設定する">🔔 iPadの通知タイマーをセット</a>`:'';
  const stopAction=!isParentPage?`<button type="button" class="btn outline video-stop" data-video-stop="${id}" ${busy||!canOperate()?'disabled':''}>⏹️ 動画をおわる</button>`:'';
  return `<div class="video-box ${overdue?'video-overdue':''}"><div class="video-head">📺 動画を見ているよ <small>${minutes}分のお知らせ</small></div>`+
    `<div class="video-countdown">${safe(label)}</div>`+
    (overdue?'<p class="video-note">お知らせ時間になりました。動画を終えるか保護者に相談してね。</p>':'')+
    (isParentPage?'':`<p class="video-note">YouTubeを開いている間に知らせるには、下のボタンからiPad標準タイマーを起動してね。</p>`)+
    `<div class="video-actions">${nativeAction}${stopAction}</div></div>`;
}
const videoNoticeSent = new Set();
function checkVideoNotices(now=Date.now()){
  if(isParentPage||!model.ready||!canOperate()||document.hidden)return;
  for(const id of ids){
    const p=model.profiles[id],due=videoDueMillis(p);
    if(!due||now<due)continue;
    const key=`${id}|${due}`;
    if(videoNoticeSent.has(key))continue;
    const storageKey=`asobu.v36.video.lastNotice.${id}`;
    let previous='';try{previous=localStorage.getItem(storageKey)||'';}catch{}
    videoNoticeSent.add(key);
    if(previous===key)continue;
    try{localStorage.setItem(storageKey,key);}catch{}
    showRestNotice(`${playerLabel(id)}：動画の時間だよ！`,`${videoLimitOf(p)}分になりました。動画をいったん終わろう。`,`video-${id}-${due}`);
  }
}
async function startVideo(id){return runLocked(async()=>{
  if(!ids.includes(id))throw Error('対象の子どもが不正です。');
  warmAudio();
  const ref=refProfile(id);
  const startedMinutes=await dbApi.runTransaction(db,async tx=>{
    const [snap,settingsSnap]=await Promise.all([tx.get(ref),tx.get(refSettings())]);
    if(!snap.exists())throw Error('子どものデータが見つかりません。');
    const p=snap.data();
    if(p.activeStart>0)throw Error('ゲーム中は動画タイマーを開始できません。');
    if(videoStartedMillis(p)>0)throw Error('すでに動画を見ています。');
    const configured=Number(settingsSnap.exists()?settingsSnap.data().videoLimitMinutes:30)||30;
    if(!Number.isInteger(configured)||configured<1||configured>240)throw Error('保護者設定の動画時間が正しくありません。');
    tx.update(ref,{videoStartedAt:dbApi.serverTimestamp(),videoDurationMinutes:configured,updatedAt:dbApi.serverTimestamp()});
    appendAudit(tx,'video_start',id,'動画視聴なし',`${configured}分の動画タイマーを開始`);
    return configured;
  });
  toast(`動画タイマーを開始しました（${startedMinutes}分）。iPadの通知タイマーもセットしてください。`);
});}
async function stopVideo(id){return runLocked(async()=>{
  if(!ids.includes(id))throw Error('対象の子どもが不正です。');
  const ref=refProfile(id);
  await dbApi.runTransaction(db,async tx=>{
    const snap=await tx.get(ref);if(!snap.exists())throw Error('子どものデータが見つかりません。');
    const p=snap.data();if(!videoStartedMillis(p))throw Error('動画タイマーは開始されていません。');
    const minutes=Math.max(0,Math.round((Date.now()-videoStartedMillis(p))/MIN));
    tx.update(ref,{videoStartedAt:null,videoDurationMinutes:0,updatedAt:dbApi.serverTimestamp()});
    appendAudit(tx,'video_stop',id,`${videoLimitOf(p)}分設定・視聴中`,`${minutes}分で終了`);
  });
  toast('動画タイマーを終了しました。iPad標準タイマーを設定していたら、そちらも停止してください。');
});}

function renderPlayers(now=Date.now()){
  if(!model.ready)return;
  $('players').innerHTML=displayIds().map((id,i)=>{
    const p=model.profiles[id]||playerBase(id),st=status(p,now),elapsed=gameDuration(p,now),until=restEnd(p);
    const manualControlling=(p.manualRestUntil||0)>Math.max(normalRestEnd(p),now);
    const restStart=manualControlling?(p.manualRestSetAt?.toMillis?.()||now):(p.restStart||now);
    const restDuration=Math.max(1,manualControlling ? (p.manualRestMinutes||1)*MIN : (p.lastDuration||1));
    const title=st==='playing'?'ゲーム中':st==='resting'?'休憩中':'スタートOK';
    const mainTitle=st==='playing'?'ゲームをはじめてから':st==='resting'?'つぎまで、あと':'ゲームができるよ！';
    const sub=st==='playing'?'じぶんで終わる時間をきめよう':st==='resting'?`${dateTime(until)}から遊べる${manualControlling?'（手動設定）':''}`:'じぶんのタイミングでスタート！';
    const detail=st==='playing'?`いま終わると ${brief(elapsed)} 休憩 ／ 次は ${dateTime(advanceEligible(now,elapsed))}から`:
      st==='resting'?(manualControlling?'手動で設定した待ち時間だよ':`${brief(p.lastDuration)} あそんだので、同じだけ休憩中`):(p.lastDuration>0?'前の休憩はおわったよ':'最初のゲームをはじめよう');
    const progress=st==='resting'?Math.min(100,Math.max(0,eligibleElapsed(restStart,now,manualControlling && restStart < (pausePolicy()?.enabledAt||0) ? null : pausePolicy(),nightResumeMillis(p),Number(p.nightResumeWindowEnd)||0)/restDuration*100)):100;
    const actions=isParentPage?'':`<button class="action ${st==='playing'?'stop':''}" data-action="${st==='playing'?'end':'start'}" data-child="${id}" ${st==='resting'||videoStartedMillis(p)>0||busy||!canOperate()?'disabled':''}>${st==='playing'?'🛑 ゲームをおわる':videoStartedMillis(p)>0?'🎬 動画視聴中':st==='resting'?'💤 おやすみ中':'▶️ ゲームをはじめる'}</button>`;
    const recordTime=p.manualRestSetAt?.toMillis?.()||0;
    const recordText=recordTime?`最後の手動操作：${p.manualRestSetRole==='parent'?'保護者':'子ども用画面'}・${dateTime(recordTime)}・${p.manualRestUntil>0?`${p.manualRestMinutes||0}分の設定`:'解除'}`:'手動待ち時間の設定履歴なし';
    const manualAction=`<button class="btn outline manual-open" data-manual="${id}" ${p.activeStart>0||busy||!canOperate()?'disabled':''}>⏳ 待ち時間を手動で設定</button>`;
    const earlyPossible=canEarlyResume(p,now);
    const nightAction=!isParentPage&&earlyPossible
      ? `<button class="btn early-resume-action" data-night-resume="${id}" ${busy||!canOperate()||!hasNightResumeRuleConfig()?'disabled':''}>☀️ いまから休憩の消化を再開</button><p class="early-resume-hint">夜間の停止だけを解除。残りの休憩時間はそのまま守ろう。</p>${!hasNightResumeRuleConfig()?'<p class="early-resume-hint">保護者画面で夜間停止設定を一度保存してください。</p>':''}`
      : (!isParentPage&&resumedThisNight(p,now)&&waitingRemaining(p,now)>0?'<p class="early-resume-hint early-active">☀️ 今夜は休憩時間を消化中</p>':'');
    const videoAction=renderVideoAction(id,p,now);
    const undo=undoKind(p,now);
    const undoAction=undo?`<button class="btn outline undo-action" data-undo="${id}" ${busy||!canOperate()?'disabled':''}>↩️ まちがえた！ あと${Math.max(1,Math.ceil((30000-(now-stampMillis(undo==='start'?p.startedAt:p.endedAt)))/1000))}秒</button>`:'';
    const correction=isParentPage&&st==='playing'&&!!$('correct-dialog')?`<button class="btn outline correction-action" data-correct="${id}" ${busy||!canOperate()?'disabled':''}>終了忘れを修正</button>`:'';
    const today=todayTotal(id,now),count=model.sessions.filter(s=>s.childId===id&&s.end>=dayStart(now)).length;
    const age = ageOf(p, now);
    const subtitle = age === null ? '年齢未設定' : `${age}さい`;
    return `<article class="player ${themeFor(p)}"><div class="player-head"><div><div class="player-name"><span class="emoji">${symbolFor(p)}</span>${safe(playerLabel(id))}</div><div class="player-sub">${safe(subtitle)}</div></div><span class="pill ${st}">${title}</span></div>
      <div class="big-time"><div class="caption">${mainTitle}</div><div class="digits">${hms(summaryFor(p,now))}</div><div class="detail">${safe(sub)}</div></div>
      <div class="progress"><i style="width:${progress.toFixed(1)}%"></i></div><div class="forecast"><strong>${st==='playing'?'⏰ いま終わったら':st==='resting'?'⌛ 前に遊んだ時間':'✨ じぶんでじかんを決めよう'}</strong><div class="forecast-line">${safe(detail)}</div>${st==='playing'?'<small>あと5分あそぶと、休憩時間も5分増えるよ</small>':''}</div>
      ${actions}${videoAction}${undoAction}${correction}${manualAction}${nightAction}<div class="manual-info">${safe(recordText)}${p.manualRestUntil>now?`<strong>手動設定の残り：${brief(manualWaitRemaining(p,now))}</strong>`:''}</div><div class="mini"><div>今日のゲーム<strong>${brief(today)}</strong></div><div>今日おわった回数<strong>${count}回</strong></div></div></article>`;
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
 target.innerHTML=sessions.length?sessions.map(s=>`<div class="history-entry"><div><strong>${safe(playerLabel(s.childId))}</strong><small>${dateTime(s.start)} 〜 ${s.ongoing?'現在':dateTime(s.end)} ${s.edited?'（修正済み）':''}</small></div><div class="right-entry"><strong>${brief(s.duration)}</strong>${isParentPage&&!s.ongoing?`<button class="btn outline" data-edit="${safe(s.sid)}">修正</button>`:''}</div></div>`).join(''):'<div class="empty">この日はまだゲームのきろくがありません</div>';
}
function render(now=Date.now()){
 currentDateTick();renderNightPolicy();renderSync();if(!model.ready)return;renderAlerts(now);renderPlayers(now);checkRestNotices(now);checkVideoNotices(now);
 if(isParentPage){if(Math.floor(now/1000)%5===0){renderWeek();renderHistory();}}
 else if(historyTab==='history'&&Math.floor(now/1000)%5===0){renderWeek();renderHistory();}
}
function setReady(){model.ready=ids.every(id=>model.profiles[id]);$('init-panel')?.classList.toggle('hidden',model.ready);render();renderReport();if(model.ready){renderWeek();renderHistory();}}
function showApp(){ $('login-screen').classList.add('hidden');$('app-screen').classList.remove('hidden');}
function showLogin(){ $('login-screen').classList.remove('hidden');$('app-screen').classList.add('hidden');}
function listenerError(e){
  console.error('Firestore listener',e);
  model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;retryAfterError=true;
  toast('クラウドの接続が切れました。再接続して最新状態を確認してください。');render();
}
function unsubscribeListeners(){cleanups.forEach(fn=>{try{fn();}catch{}});cleanups=[];}
function disconnect(){unsubscribeListeners();model.profiles={};model.sessions=[];model.presence=null;model.ready=false;model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;model.auditLogs=[];model.reportSessions=[];model.reportLoaded=false;model.reportFromCache=true;model.reportTruncated=false;previousRest.clear();retryAfterError=false;renderReport();}
async function recheckConnection(){
  if(!navigator.onLine){model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;render();return;}
  if(reconnecting)return reconnecting;
  if(!uid||!db)return;
  reconnecting=(async()=>{
    if(!cleanups.length){await authorizeCurrentUser();return;}
    model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;render();
    try{
      if(retryAfterError){unsubscribeListeners();retryAfterError=false;listen();}
      const expectedUid=uid;
      const [snap,settingSnap]=await Promise.all([
        dbApi.getDocsFromServer(dbApi.collection(db,'households',householdId,'profiles')),
        dbApi.getDocFromServer(refSettings())
      ]);
      if(uid!==expectedUid)return;
      model.settings=settingSnap.exists()?{...defaultSettings(),...settingSnap.data()}:defaultSettings();
      model.settingsServerConfirmed=!settingSnap.metadata.hasPendingWrites;
      const next={};for(const doc of snap.docs)next[doc.id]=doc.data();
      model.profiles=next;model.profilesServerConfirmed=!snap.metadata.hasPendingWrites;
      model.fromCache=false;model.receivedAt=Date.now();
      setReady();setSettingsForm();render();
    }catch(e){model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;retryAfterError=true;console.warn('recheck',e);render();toast('最新データを確認できません。通信回復後に「接続を再確認」を押してください。');}
  })();
  try{return await reconnecting;}finally{reconnecting=null;}
}
function setSettingsForm(){if(!isParentPage)return;const hash=JSON.stringify({profiles:ids.map(i=>({name:model.profiles[i]?.name,birthDate:model.profiles[i]?.birthDate,gender:model.profiles[i]?.gender})),settings:model.settings});if(hash===lastSettingsHash)return;
 if(document.activeElement?.closest?.('#settings-form'))return;
  for (const id of ids) {
    $('name-'+id).value=playerLabel(id);
    $('birth-'+id).value=model.profiles[id]?.birthDate||'';
    $('gender-'+id).value=['female','male','neutral'].includes(model.profiles[id]?.gender) ? model.profiles[id].gender : 'neutral';
    $('birth-'+id).max=dateKey(Date.now());
  }
  $('reminder').value=String(model.settings.reminderMinutes||60);$('video-limit').value=String(model.settings.videoLimitMinutes||30);
  const policy=model.settings.nightPause||defaultSettings().nightPause;
  $('night-enabled').checked=policy.enabled===true;
  $('night-start').value=policy.start||'22:00';$('night-end').value=policy.end||'07:00';
  lastSettingsHash=hash;
}
let reportUnsubscribe=null,reportPeriodKey='';
function subscribeReport(){
  if(!dbApi||!db||!uid)return;
  if(reportUnsubscribe){reportUnsubscribe();reportUnsubscribe=null;}
  reportPeriodKey=dateKey(Date.now());
  model.reportLoaded=false;renderReport();
  reportUnsubscribe=dbApi.onSnapshot(dbApi.query(dbApi.collection(db,'households',householdId,'sessions'),dbApi.where('end','>=',reportRange().before),dbApi.orderBy('end','desc'),dbApi.limit(REPORT_LIMIT)),{includeMetadataChanges:true},snap=>{
    model.reportSessions=snap.docs.map(d=>({...d.data(),sid:d.id}));model.reportLoaded=true;model.reportFromCache=snap.metadata.fromCache;model.reportTruncated=snap.size>=REPORT_LIMIT;renderReport();
  },e=>{console.warn('report listener',e);model.reportLoaded=false;renderReport();});
}
function listen(){
 cleanups.push(dbApi.onSnapshot(dbApi.collection(db,'households',householdId,'profiles'),{includeMetadataChanges:true},snap=>{
   const profiles={};for(const doc of snap.docs)profiles[doc.id]=doc.data();model.profiles=profiles;model.fromCache=snap.metadata.fromCache;model.profilesServerConfirmed=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites&&navigator.onLine;model.receivedAt=Date.now();setReady();setSettingsForm();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(dbApi.doc(db,'households',householdId,'settings','main'),{includeMetadataChanges:true},snap=>{
   model.settings=snap.exists()?{...defaultSettings(),...snap.data()}:defaultSettings();
   model.settingsServerConfirmed=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites&&navigator.onLine;model.receivedAt=Date.now();render();setSettingsForm();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(dbApi.query(dbApi.collection(db,'households',householdId,'sessions'),dbApi.orderBy('end','desc'),dbApi.limit(500)),snap=>{
   model.sessions=snap.docs.map(d=>({...d.data(),sid:d.id}));model.historyExtra=null;renderWeek();renderHistory();render();
 },listenerError));
 subscribeReport();
 cleanups.push(()=>{if(reportUnsubscribe){reportUnsubscribe();reportUnsubscribe=null;}reportPeriodKey='';});
 if(isParentPage){
   cleanups.push(dbApi.onSnapshot(dbApi.doc(db,'households',householdId,'presence','ipad'),snap=>{model.presence=snap.exists()?snap.data():null;renderSync();},listenerError));
   cleanups.push(dbApi.onSnapshot(dbApi.query(dbApi.collection(db,'households',householdId,'auditLogs'),dbApi.orderBy('createdAt','desc'),dbApi.limit(100)),snap=>{model.auditLogs=snap.docs.map(d=>({...d.data(),logId:d.id}));renderAudit();},listenerError));
 }
}
function refProfile(id){return dbApi.doc(db,'households',householdId,'profiles',id)}
function refSettings(){return dbApi.doc(db,'households',householdId,'settings','main')}
function sessionsRef(){return dbApi.collection(db,'households',householdId,'sessions')}
function ensureOnline(){if(!navigator.onLine)throw Error('インターネット接続が必要です。通信を確認してから操作してください。');if(!canOperate())throw Error('クラウドの最新状態を確認中です。再接続後に操作してください。');}
async function runLocked(fn){if(busy)return;busy=true;try{ensureOnline();await fn();}catch(e){console.error(e);toast(errorText(e));}finally{busy=false;render();}}
async function startPlay(id,deviceId){return runLocked(async()=>{
  const now=Date.now();await dbApi.runTransaction(db,async tx=>{
    const ref=refProfile(id),snap=await tx.get(ref);if(!snap.exists())throw Error('家族データが見つかりません');const p=snap.data();
    if(videoStartedMillis(p)>0)throw Error('動画視聴中です。先に動画を終了してください。');
    if(p.activeStart>0)throw Error('すでにゲーム中です。');if(now<restEnd(p))throw Error('まだ待ち時間が残っています。');
    tx.update(ref,{activeStart:now,deviceId,startedAt:dbApi.serverTimestamp(),endedAt:null,updatedAt:dbApi.serverTimestamp()});
    appendAudit(tx,'start',id,'ゲーム可能','ゲーム開始');
  });toast(`${playerLabel(id)}：ゲームをスタート！`);
 });
}
async function endPlay(id){return runLocked(async()=>{
  const sidRef=dbApi.doc(sessionsRef());const now=Date.now();
  const duration=await dbApi.runTransaction(db,async tx=>{
    const ref=refProfile(id),snap=await tx.get(ref);if(!snap.exists())throw Error('家族データがありません');const p=snap.data();
    if(!p.activeStart)throw Error('すでに終了しています');if(now-p.activeStart<1000)throw Error('開始から1秒以上経過してから終了してください。');const dur=now-p.activeStart;
    if(dur>7*DAY)throw Error('7日以上計測されています。保護者が開始時刻を確認してください。');
    tx.update(ref,{activeStart:0,deviceId:null,startedAt:null,endedAt:dbApi.serverTimestamp(),restStart:now,restUntil:now+dur,lastDuration:dur,lastSessionId:sidRef.id,updatedAt:dbApi.serverTimestamp()});
    tx.set(sidRef,{childId:id,start:p.activeStart,end:now,duration:dur,deviceId:p.deviceId||'sw1',createdAt:dbApi.serverTimestamp(),createdBy:uid,edited:false,
      undoPrevious:{restStart:p.restStart||0,restUntil:p.restUntil||0,lastDuration:p.lastDuration||0,lastSessionId:p.lastSessionId||'',startedAt:p.startedAt||null}});
    appendAudit(tx,'end',id,'ゲーム中',`${brief(dur)}プレイ／通常の休憩 ${brief(dur)}`,sidRef.id);
    return dur;
  });$('end-dialog').close();toast(`おつかれさま！ ${brief(duration)}の休憩スタート`);
 });
}
function chooseStart(id){
  const p=model.profiles[id];
  if(!p||p.activeStart||Date.now()<restEnd(p))return toast('まだ休憩中だよ');
  if(videoStartedMillis(p)>0)return toast('動画を見ている間はゲームを開始できません。');
  startPlay(id,'sw1'); // 旧データ・Firestoreルールとの互換性のため固定値を保持（画面には表示しない）。
}
function chooseEnd(id){const p=model.profiles[id];if(!p?.activeStart)return;pendingEnd=id;const now=Date.now(),t=now-p.activeStart;
 $('end-confirm-text').innerHTML=`<div>${safe(playerLabel(id))}が遊んだ時間：<strong>${brief(t)}</strong></div><div>これから休憩：<strong>${brief(t)}</strong></div><div>つぎに遊べるのは：<strong>${dateTime(now+t)}</strong></div>`;$('end-dialog').showModal();}

// 30秒以内の誤操作取り消し。終了取り消しは履歴削除とプロフィール復元を同一transactionで実行する。
async function undoRecent(id){
  if(isParentPage||!ids.includes(id)||!undoKind(model.profiles[id]))return;
  if(!confirm(`${playerLabel(id)}の直前の操作を取り消しますか？\n30秒を過ぎると取り消せません。`))return;
  await runLocked(async()=>{
    const mode=await dbApi.runTransaction(db,async tx=>{
      const ref=refProfile(id),pSnap=await tx.get(ref);
      if(!pSnap.exists())throw Error('子どものデータがありません。');
      const p=pSnap.data(),now=Date.now();
      if(p.activeStart>0){
        const at=stampMillis(p.startedAt);
        if(!at||now-at<0||now-at>=30000)throw Error('開始から30秒を過ぎたため、取り消せません。');
        tx.update(ref,{activeStart:0,deviceId:null,startedAt:null,endedAt:null,updatedAt:dbApi.serverTimestamp()});
        appendAudit(tx,'undo_start',id,'ゲーム中','開始前の状態に戻した');
        return 'start';
      }
      const at=stampMillis(p.endedAt);
      if(!at||now-at<0||now-at>=30000||!p.lastSessionId)throw Error('終了から30秒を過ぎたため、取り消せません。');
      const sessionRef=dbApi.doc(sessionsRef(),p.lastSessionId),sSnap=await tx.get(sessionRef);
      if(!sSnap.exists())throw Error('取り消す履歴が見つかりません。');
      const s=sSnap.data(),u=s.undoPrevious;
      if(!u||s.childId!==id||s.createdBy!==uid||stampMillis(s.createdAt)!==at||s.edited)throw Error('この履歴は取り消し対象ではありません。');
      tx.update(ref,{
        activeStart:s.start,deviceId:s.deviceId,startedAt:u.startedAt||null,endedAt:null,
        restStart:u.restStart,restUntil:u.restUntil,lastDuration:u.lastDuration,
        lastSessionId:u.lastSessionId,updatedAt:dbApi.serverTimestamp()
      });
      tx.delete(sessionRef);
      appendAudit(tx,'undo_end',id,'終了済み・休憩中','終了を取り消してゲーム中に復元',p.lastSessionId);
      return 'end';
    });
    toast(mode==='start'?'ゲーム開始を取り消しました':'終了を取り消しました。ゲーム時間の計測を続けます');
  });
}

function openCorrection(id){
  if(!isParentPage||!ids.includes(id)||!canOperate())return;
  const p=model.profiles[id];if(!p?.activeStart)return;
  pendingCorrection=id;
  $('correct-title').textContent=`${playerLabel(id)}の終了忘れを修正`;
  $('correct-start').textContent=`ゲーム開始：${dateTime(p.activeStart)}`;
  $('correct-end').value=dateInput(Date.now());
  $('correct-end').min=dateInput(p.activeStart+1000);
  $('correct-end').max=dateInput(Date.now());
  $('correct-dialog').showModal();
}
async function correctForgottenEnd(event){
  event.preventDefault();
  const id=pendingCorrection;
  if(!isParentPage||!ids.includes(id))return;
  const end=new Date($('correct-end').value).getTime();
  if(!Number.isFinite(end))return toast('終了時刻を入力してください。');
  if(!confirm(`${playerLabel(id)}の実際の終了時刻を ${dateTime(end)} に修正しますか？`))return;
  await runLocked(async()=>{
    const sidRef=dbApi.doc(sessionsRef());
    const duration=await dbApi.runTransaction(db,async tx=>{
      const ref=refProfile(id),snap=await tx.get(ref);
      if(!snap.exists())throw Error('家族データが見つかりません。');
      const p=snap.data(),now=Date.now();
      if(!(p.activeStart>0))throw Error('すでに終了済みです。最新状態をご確認ください。');
      if(end<=p.activeStart||end>now||end-p.activeStart>7*DAY)throw Error('終了時刻は開始後〜現在まで、かつ7日以内で入力してください。');
      const dur=end-p.activeStart;
      tx.update(ref,{activeStart:0,deviceId:null,startedAt:null,endedAt:null,restStart:end,restUntil:end+dur,lastDuration:dur,lastSessionId:sidRef.id,updatedAt:dbApi.serverTimestamp()});
      tx.set(sidRef,{childId:id,start:p.activeStart,end,duration:dur,deviceId:p.deviceId||'sw1',createdAt:dbApi.serverTimestamp(),createdBy:uid,edited:true,correctionReason:'終了忘れ（保護者修正）'});
      appendAudit(tx,'forgotten_end',id,`${dateTime(p.activeStart)}からゲーム中`,`${dateTime(end)}に終了・${brief(dur)}休憩`,sidRef.id);
      return dur;
    });
    $('correct-dialog').close();pendingCorrection=null;
    toast(`終了時刻を修正しました（プレイ ${brief(duration)}）。休憩時刻も再計算済みです。`);
  });
}

// 夜間停止中の本人操作：残量を変えず、当夜の残りの停止時間だけ消化を開始。
// 通常の休憩は原記録を維持し、既に計算済みの手動期限だけは短縮量を保存する。
async function resumeNightEarly(id){
  if(!ids.includes(id)||isParentPage)return;
  const initial=model.profiles[id];
  if(!canEarlyResume(initial))return toast('前倒し再開できる待ち時間がありません。');
  if(!hasNightResumeRuleConfig())return toast('保護者画面で夜間停止の設定を一度保存してください。');
  if(!confirm(`${playerLabel(id)}：夜間の停止をいま解除して、残りの休憩時間の消化を進めますか？\n休憩そのものは短くなりません。`))return;
  await runLocked(async()=>{
    const result=await dbApi.runTransaction(db,async tx=>{
      const ref=refProfile(id),snap=await tx.get(ref);
      if(!snap.exists())throw Error('子どものデータがありません。');
      const p=snap.data(),now=Date.now(),policy=pausePolicy();
      if(!canEarlyResume(p,now)||!policy)throw Error('前倒し再開できる待ち時間がありません。');
      const window=nightWindow(now,policy),oldManual=Number(p.manualRestUntil)||0;
      const stoppedTime=Math.max(0,window.until-now);
      // 手動待ち時間は夜間停止を含んだ予定時刻で保存済みなので、
      // 停止解除で消化可能となった時間だけ期限を前倒しする。
      const newManual=oldManual>window.until?oldManual-stoppedTime:oldManual;
      tx.update(ref,{
        nightResumeAt:dbApi.serverTimestamp(),nightResumeWindowEnd:window.until,
        manualRestUntil:Math.round(newManual),updatedAt:dbApi.serverTimestamp()
      });
      appendAudit(tx,'night_resume',id,`夜間停止中／残り${brief(waitingRemaining(p,now))}`,
        `いまから消化再開／残り${brief(waitingRemaining(p,now))}`);
      return waitingRemaining(p,now);
    });
    toast(`${playerLabel(id)}：休憩の消化を再開しました。残り${brief(result)}です。`);
  });
}

// 手動待ち時間は通常の休憩時間とは別に保持する。子どもは延長のみ、保護者は短縮・解除可能。
function openManualWait(id){
  const p=model.profiles[id];
  if(!ids.includes(id)||!p)return;
  if(p.activeStart>0)return toast('ゲーム中は待ち時間を変更できません。');
  pendingManual=id;
  $('manual-title').textContent=`${playerLabel(id)}の待ち時間を設定`;
  $('manual-current').textContent=`いまの待ち時間：${waitingRemaining(p)>0?brief(waitingRemaining(p)):'なし'} ／ 通常の休憩：${normalWaitRemaining(p)>0?brief(normalWaitRemaining(p)):'なし'}`;
  $('manual-minutes').value='30';
  $('manual-policy').textContent=isParentPage
    ?'今からの残り待ち時間を指定します。通常の休憩が長ければ、その休憩は維持されます。'
    :'今からの待ち時間を追加・延長できます。今より短くすることはできません。';
  $('manual-clear').classList.toggle('hidden',!isParentPage);
  updateManualPreview();
  $('manual-dialog').showModal();
}
function updateManualPreview(){
  if(!pendingManual)return;
  const n=Number($('manual-minutes').value);
  const out=$('manual-preview');
  if(!Number.isInteger(n)||n<1||n>1440){out.textContent='1〜1,440分の整数を入力してください。';return;}
  const p=model.profiles[pendingManual];
  if(!p)return;
  const proposed=advanceEligible(Date.now(),n*MIN,pausePolicy(),nightResumeMillis(p),Number(p.nightResumeWindowEnd)||0);
  const manualUntil=isParentPage?proposed:Math.max(proposed,p.manualRestUntil||0,restEnd(p));
  const effectiveUntil=Math.max(manualUntil,normalRestEnd(p));
  const now=Date.now(),sample={...p,manualRestUntil:manualUntil,manualRestMinutes:n,manualRestSetAt:{toMillis:()=>now}};
  const remaining=isParentPage?Math.max(normalWaitRemaining(p,now),manualWaitRemaining(sample,now)):Math.max(waitingRemaining(p,now),manualWaitRemaining(sample,now));
  out.textContent=`保存後の待ち時間：あと${brief(remaining)}（${dateTime(effectiveUntil)}に再開予定）`; 
}
async function saveManualWait(event){
  event.preventDefault();
  const id=pendingManual,n=Number($('manual-minutes').value);
  if(!id||!ids.includes(id))return;
  if(!Number.isInteger(n)||n<1||n>1440)return toast('待ち時間は1〜1,440分の整数で入力してください。');
  await runLocked(async()=>{
    const until=await dbApi.runTransaction(db,async tx=>{
      const ref=refProfile(id),snap=await tx.get(ref);
      if(!snap.exists())throw Error('子どものデータがありません。');
      const p=snap.data();
      if(p.activeStart>0)throw Error('ゲーム中は待ち時間を設定できません。');
      const proposed=advanceEligible(Date.now(),n*MIN,pausePolicy(),nightResumeMillis(p),Number(p.nightResumeWindowEnd)||0);
      if(role==='kid' && proposed<=restEnd(p))
        throw Error('今の待ち時間より短く設定することはできません。延長する時間を入力してください。');
      const newUntil=role==='parent'?proposed:Math.max(proposed,p.manualRestUntil||0,restEnd(p));
      tx.update(ref,{
        manualRestUntil:newUntil,manualRestMinutes:n,
        manualRestSetAt:dbApi.serverTimestamp(),manualRestSetBy:uid,manualRestSetRole:role,
        updatedAt:dbApi.serverTimestamp()
      });
      appendAudit(tx,'manual_set',id,p.manualRestUntil?dateTime(p.manualRestUntil):'未設定',`${n}分設定／${dateTime(newUntil)}まで`);
      return Math.max(newUntil,normalRestEnd(p));
    });
    $('manual-dialog').close();pendingManual=null;
    toast(`${playerLabel(id)}：${dateTime(until)}まで待ち時間を設定しました`);
  });
}
async function clearManualWait(){
  if(!isParentPage||role!=='parent'||!pendingManual)return;
  const id=pendingManual;
  if(!confirm(`${playerLabel(id)}の手動待ち時間を解除しますか？\nゲーム終了後の通常の休憩は残ります。`))return;
  await runLocked(async()=>{
    await dbApi.runTransaction(db,async tx=>{
      const ref=refProfile(id),snap=await tx.get(ref);
      if(!snap.exists())throw Error('子どものデータがありません。');
      if(snap.data().activeStart>0)throw Error('ゲーム中は変更できません。');
      tx.update(ref,{
        manualRestUntil:0,manualRestMinutes:0,
        manualRestSetAt:dbApi.serverTimestamp(),manualRestSetBy:uid,manualRestSetRole:'parent',
        updatedAt:dbApi.serverTimestamp()
      });
      appendAudit(tx,'manual_clear',id,snap.data().manualRestUntil?dateTime(snap.data().manualRestUntil):'未設定','手動待ち時間を解除');
    });
    $('manual-dialog').close();pendingManual=null;
    toast('手動待ち時間を解除しました（通常の休憩は維持します）');
  });
}

async function initFamily(){await runLocked(async()=>{const b=dbApi.writeBatch(db);b.set(refSettings(),{...defaultSettings(),createdAt:dbApi.serverTimestamp()});for(const id of ids)b.set(refProfile(id),{...playerBase(id),updatedAt:dbApi.serverTimestamp()});appendAudit(b,'family_init','all','未作成','家族データを作成');await b.commit();toast('家族データを作成しました');});}
async function saveSettings(event){event.preventDefault();await runLocked(async()=>{
  const names=ids.map(id=>$('name-'+id).value.trim());
  const births=ids.map(id=>$('birth-'+id).value);
  const genders=ids.map(id=>$('gender-'+id).value);
  if(!names.every(Boolean))throw Error('名前を入力してください');
  const videoLimitMinutes=Number($('video-limit').value);
  if(!Number.isInteger(videoLimitMinutes)||videoLimitMinutes<1||videoLimitMinutes>240)throw Error('動画のお知らせ時間は1〜240分で設定してください。');
  if(!births.every(validBirthDate))throw Error('生年月日を正しく入力してください（未来の日付は登録できません）。');
  if(!genders.every(g=>['female','male','neutral'].includes(g)))throw Error('性別を選択してください。');
 const enabled=$('night-enabled').checked,start=$('night-start').value,end=$('night-end').value;
  const a=clockMinute(start),z=clockMinute(end);
  if(a===null||z===null||a<=z)throw Error('夜間時間帯は日付をまたぐように入力してください（例：22:00〜07:00）。');
  const oldPause=model.settings.nightPause||defaultSettings().nightPause;
  const changed=oldPause.enabled!==enabled||oldPause.start!==start||oldPause.end!==end;
  const nightPause={enabled,start,end,startMinutes:a,endMinutes:z,enabledAt:enabled?(changed?Date.now():(oldPause.enabledAt||Date.now())):0};
  const oldDesc=`夜間 ${oldPause.enabled?'ON':'OFF'} ${oldPause.start||'22:00'}〜${oldPause.end||'07:00'}`;
  const newDesc=`夜間 ${enabled?'ON':'OFF'} ${start}〜${end}／動画タイマー${videoLimitMinutes}分`;
  const b=dbApi.writeBatch(db);
  ids.forEach((id,i)=>b.update(refProfile(id),{name:names[i].slice(0,12),birthDate:births[i],gender:genders[i],updatedAt:dbApi.serverTimestamp()}));
  b.set(refSettings(),{reminderMinutes:Number($('reminder').value)||60,videoLimitMinutes,nightPause,updatedAt:dbApi.serverTimestamp()},{merge:true});
  appendAudit(b,'settings_update','all',oldDesc,newDesc);
  await b.commit();toast('設定を保存しました');
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
    appendAudit(tx,'history_edit',orig.childId,`${dateTime(existing.start)}〜${dateTime(existing.end)}`,`${dateTime(a)}〜${dateTime(b)}`,sid);
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
 if(format==='json'){const auditSnap=await dbApi.getDocs(dbApi.collection(db,'households',householdId,'auditLogs'));const auditLogs=auditSnap.docs.map(d=>({...d.data(),createdAtIso:stampMillis(d.data().createdAt)?new Date(stampMillis(d.data().createdAt)).toISOString():null,logId:d.id}));const data={version:3,appVersion:version,exportedAt:new Date().toISOString(),householdId,profiles:model.profiles,settings:model.settings,sessions,auditLogs};download(`asobu-yasumu-v3-${dateKey(Date.now())}.json`,new Blob([JSON.stringify(data,(k,v)=>['createdAt','updatedAt'].includes(k)?undefined:v,2)],{type:'application/json'}));}
 else {const csv=v=>{let s=String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;};const rows=[['子ども','開始日時','終了日時','ゲーム時間(秒)','修正済み'],...sessions.map(s=>[playerLabel(s.childId),new Date(s.start).toLocaleString('ja-JP'),new Date(s.end).toLocaleString('ja-JP'),Math.round(s.duration/1000),s.edited?'はい':'いいえ'])];download(`asobu-yasumu-v3-${dateKey(Date.now())}.csv`,new Blob(['\ufeff'+rows.map(row=>row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));}
 toast('バックアップを保存しました');
 }catch(e){toast(errorText(e));}}
async function exportAuditCsv(){
 if(!isParentPage)return;
 try{
  const q=dbApi.query(dbApi.collection(db,'households',householdId,'auditLogs'),dbApi.orderBy('createdAt','desc'),dbApi.limit(1000));
  const docs=await dbApi.getDocs(q);
  const esc=v=>{let s=String(v??'');if(/^[=+@\\-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  const rows=[['日時','操作','対象','操作アカウント','UID','変更前','変更後','履歴ID'],
   ...docs.docs.map(doc=>{const a=doc.data();return [stampMillis(a.createdAt)?new Date(stampMillis(a.createdAt)).toLocaleString('ja-JP'):'',
    AUDIT_ACTIONS[a.action]||a.action,ids.includes(a.childId)?playerLabel(a.childId):'家族全体',a.actorRole,a.actorUid,a.before,a.after,a.sessionId];})];
  download(`asobu-yasumu-audit-${dateKey(Date.now())}.csv`,new Blob(['\ufeff'+rows.map(row=>row.map(esc).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  toast('操作履歴CSVを保存しました（最新1,000件まで）');
 }catch(e){console.error(e);toast(errorText(e));}
}
async function heartbeat(){if(isParentPage||!uid||!document.visibilityState||document.visibilityState!=='visible'||!canOperate())return;
 try{await dbApi.setDoc(dbApi.doc(db,'households',householdId,'presence','ipad'),{lastSeenAt:dbApi.serverTimestamp(),device:'ipad'}, {merge:true});}catch(e){console.warn('heartbeat',e);}
}
function initUiEvents(){
 $('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='接続中…';try{await authApi.signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value);$('password').value='';}catch(err){$('login-error').textContent=errorText(err);}});
 $('logout').addEventListener('click',async()=>{await authApi.signOut(auth);});
 if(!isParentPage){
   $('notify-enabled')?.addEventListener('change',e=>{notifyEnabled=e.target.checked;saveFlag(notifyKeys.enabled,notifyEnabled);warmAudio();updateNotifyHelp();});
   $('notify-sound')?.addEventListener('change',e=>{notifySound=e.target.checked;saveFlag(notifyKeys.sound,notifySound);warmAudio();updateNotifyHelp();});
   $('notify-test')?.addEventListener('click',()=>{warmAudio();showRestNotice('お知らせのテスト','アプリを開いている間は、お知らせを表示できます。','asobu-test');});
   $('rest-notice-close')?.addEventListener('click',()=>{$('rest-notice').classList.add('hidden');});
   $('notify-permission')?.addEventListener('click',async()=>{try{const permission=await Notification.requestPermission();updateNotifyHelp();toast(permission==='granted'?'通知を許可しました。':'システム通知は許可されていません。');}catch(e){updateNotifyHelp();toast('この環境ではシステム通知を利用できません。');}});
   initNotifySettings();
 }
 document.addEventListener('click',e=>{
   const btn=e.target.closest('button');if(!btn)return;
   if(btn.hasAttribute('data-close')){btn.closest('dialog')?.close();return;}
   if(btn.dataset.action==='start')chooseStart(btn.dataset.child);
   if(btn.dataset.action==='end')chooseEnd(btn.dataset.child);
   if(btn.dataset.videoStart)startVideo(btn.dataset.videoStart);
   if(btn.dataset.videoStop)stopVideo(btn.dataset.videoStop);
   if(btn.dataset.edit)editOpen(btn.dataset.edit);
   if(btn.dataset.manual)openManualWait(btn.dataset.manual);
   if(btn.dataset.undo)undoRecent(btn.dataset.undo);
   if(btn.dataset.correct)openCorrection(btn.dataset.correct);
   if(btn.dataset.nightResume)resumeNightEarly(btn.dataset.nightResume);
   if(btn.dataset.preset){$('manual-minutes').value=btn.dataset.preset;updateManualPreview();}
 });
 document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close();}));
 $('confirm-end')?.addEventListener('click',()=>pendingEnd&&endPlay(pendingEnd));
  $('manual-form')?.addEventListener('submit',saveManualWait);
  $('manual-minutes')?.addEventListener('input',updateManualPreview);
  $('manual-clear')?.addEventListener('click',clearManualWait);
  $('manual-dialog')?.addEventListener('close',()=>{pendingManual=null;});
  $('correct-form')?.addEventListener('submit',correctForgottenEnd);
  $('correct-dialog')?.addEventListener('close',()=>{pendingCorrection=null;});
  $('retry-connect')?.addEventListener('click',()=>recheckConnection());
  $('export-audit')?.addEventListener('click',exportAuditCsv);
  $('retry-login')?.addEventListener('click',()=>authorizeCurrentUser());
 $('init-family')?.addEventListener('click',initFamily);
 $('settings-form')?.addEventListener('submit',saveSettings);
 $('edit-form')?.addEventListener('submit',editHistory);
 $('export-json')?.addEventListener('click',()=>exportData('json'));
 $('export-csv')?.addEventListener('click',()=>exportData('csv'));

 $('history-date').value=dateKey(selectedDay);$('history-date').max=dateKey(Date.now());
 $('history-date').addEventListener('change',e=>{const d=new Date(e.target.value+'T00:00:00').getTime();if(!Number.isFinite(d)||d>dayStart(Date.now()))return;selectedDay=d;model.historyExtra=null;renderHistory();loadSelectedDay();});
 $('tab-home')?.addEventListener('click',()=>{historyTab='home';$('history').classList.add('hidden');$('tab-home').classList.add('subnav-active');$('tab-history').classList.remove('subnav-active');});
 $('tab-history')?.addEventListener('click',()=>{historyTab='history';$('history').classList.remove('hidden');$('tab-home').classList.remove('subnav-active');$('tab-history').classList.add('subnav-active');renderWeek();renderHistory();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;render();recheckConnection().then(heartbeat);}});
 window.addEventListener('online',()=>{model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;render();recheckConnection().then(heartbeat);});
  window.addEventListener('offline',()=>{model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;render();});
}
async function authorizeCurrentUser(){
  if(authCheckBusy||!auth?.currentUser||!dbApi||!db)return;
  authCheckBusy=true;
  const user=auth.currentUser;
  $('login-error').textContent='接続中…';
  try{
    const member=await dbApi.getDocFromServer(dbApi.doc(db,'households',householdId,'members',user.uid));
    if(auth.currentUser?.uid!==user.uid)return;
    if(!member.exists())throw Error('このアカウントの家族メンバー登録がありません。Firebaseのmembers設定を確認してください。');
    const memberRole=member.data().role;
    if(!['parent','kid'].includes(memberRole))throw Error('役割の設定が正しくありません。');
    if(isParentPage&&memberRole!=='parent')throw Error('この画面は保護者アカウント専用です。');
    if(!isParentPage&&memberRole!=='kid')throw Error('この画面はiPad専用アカウントでログインしてください。');
    role=memberRole;uid=user.uid;
    $('login-error').textContent='';$('retry-login')?.classList.add('hidden');showApp();
    if(!cleanups.length)listen();
    if(!isParentPage)heartbeat();
  }catch(e){
    if(auth.currentUser?.uid!==user.uid)return;
    $('login-error').textContent=isTransient(e)?'通信が不安定です。接続後に「再接続する」を押してください。':errorText(e);
    showLogin();
    if(isTransient(e)){$('retry-login')?.classList.remove('hidden');}
    else { $('retry-login')?.classList.add('hidden');await authApi.signOut(auth); }
  }finally{authCheckBusy=false;}
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
   au.onAuthStateChanged(auth,user=>{
     disconnect();if(!user){uid=null;role=null;showLogin();return;}
     uid=user.uid;authorizeCurrentUser();
   });
   if(!isParentPage){setInterval(heartbeat,60000);}
    setInterval(render,1000);
    setInterval(()=>{if(uid&&navigator.onLine&&(!model.profilesServerConfirmed||!model.settingsServerConfirmed)&&!reconnecting&&!authCheckBusy)recheckConnection();},15000);
    setInterval(()=>{if(uid&&model.ready&&navigator.onLine&&reportPeriodKey&&reportPeriodKey!==dateKey(Date.now()))subscribeReport();},60000);
    render();
   if('serviceWorker' in navigator && !isParentPage && location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }catch(e){console.error(e);$('setup-warning').textContent='Firebase SDKに接続できません。インターネット接続、ブラウザ設定、設定ファイルを確認してください。 '+errorText(e);$('setup-warning').classList.remove('hidden');}
}
currentDateTick();setInterval(currentDateTick,1000);
startFirebase();
