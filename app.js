import {firebaseConfig, householdId} from './firebase-config.js';
import {POKEMON_NAMES,POKEDEX_TOTAL,officialPokedexUrl,pokemonNoFromClaim,pokemonName,loadExtendedPokemonNames} from './pokedex-data.js';

const $ = id => document.getElementById(id);
const rolePage = document.body.dataset.role;
const isParentPage = rolePage === 'parent';
const ids = ['older','younger'];
const palette = ['sis','bro'];
const MIN = 60000, DAY = 86400000, JST_OFFSET = 9 * 60 * MIN;
const version = 'v3.12.1';
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
const model = {profiles:{},settings:defaultSettings(),sessions:[],presence:null,fromCache:true,ready:false,receivedAt:0,historyExtra:null,profilesServerConfirmed:false,settingsServerConfirmed:false,auditLogs:[],reportSessions:[],reportLoaded:false,reportFromCache:true,reportTruncated:false,rewards:[],rewardsLoaded:false,rewardsServerConfirmed:false,activityRequests:[],activityLoaded:false,activityServerConfirmed:false,bonusGrants:[],bonusLoaded:false,bonusServerConfirmed:false};
let firebase, authApi, dbApi, auth, db, uid, role, paths, cleanups=[], busy=false, pendingStart=null, pendingEnd=null, editingId=null, lastSettingsHash='', historiesLastLoaded=0;
let selectedDay=dayStart(Date.now()), historyTab='home', toastHandle=null, familyInitialized=false, pendingManual=null;
// v3.12.0 UI state: no Firestore write, shared selection across the collection views.
let focusChild='older', parentFocusChild='older', kidView='time', parentView='home';
let playerRenderSignature='', playerRenderedAt=0, dashboardRenderedAt=0;
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
  if(isParentPage||!p||p.activeStart>0||videoStartedMillis(p)>0||!canOperate()||!policy||!isNightPaused(now,policy))return false;
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

/* v3.12.1: 夜間の持ち越し休憩を、既存の時間計算を変えずに可視化する。 */
function nightCarryoverInfo(p,now=Date.now()){
  const policy=pausePolicy();
  if(!policy||!p||p.activeStart>0||videoStartedMillis(p)>0||waitingRemaining(p,now)<=0)return null;
  const start=Number(p.restStart)||0,rawEnd=Number(p.restUntil)||0;
  const normalCarry=start>=policy.enabledAt&&rawEnd>start&&normalWaitRemaining(p,now)>0
    && normalRestEnd(p)>rawEnd+1000;
  const manualStart=stampMillis(p.manualRestSetAt),manualMinutes=Number(p.manualRestMinutes)||0;
  const manualCarry=manualStart>=policy.enabledAt&&manualMinutes>0&&manualWaitRemaining(p,now)>0
    && Number(p.manualRestUntil)>manualStart+manualMinutes*MIN+1000;
  if(!normalCarry&&!manualCarry)return null;
  const remain=brief(waitingRemaining(p,now)),end=dateTime(restEnd(p));
  const paused=isNightPaused(now,policy),resumed=resumedThisNight(p,now,policy);
  if(paused&&!resumed){
    const morning=nightWindow(now,policy).until;
    return {phase:'paused',message:'🌙 夜間停止中（休憩を翌朝へ持ち越し）：残り '+remain+' ／ '+dateTime(morning)+' から消化再開 ／ 次の利用 '+end};
  }
  if(paused&&resumed){
    return {phase:'resumed',message:'🌅 夜間停止を前倒し解除・休憩消化中：残り '+remain+' ／ 次の利用 '+end};
  }
  const nextStop=nightWindow(now,policy).until;
  const futureCarry=restEnd(p)>nextStop&&now<nextStop &&
    ((normalCarry&&start>=now-DAY&&start<nextStop)||(manualCarry&&manualStart>=now-DAY&&manualStart<nextStop));
  if(futureCarry)return {phase:'scheduled',message:'🌙 今夜の休憩は翌朝へ持ち越し予定：残り '+remain+' ／ 次の利用 '+end};
  return {phase:'resumed',message:'🌅 前夜からの持ち越し休憩を消化中：残り '+remain+' ／ 次の利用 '+end};
}

function displayTimeRange(){const p=pausePolicy();return p?`${model.settings.nightPause.start}〜${model.settings.nightPause.end}`:'';}
function renderNightPolicy(){const e=$('night-policy');if(!e)return;
  const p=pausePolicy();e.classList.toggle('hidden',!p);
  if(!p)return;
  const entries=ids.map(id=>({id,info:nightCarryoverInfo(model.profiles[id])})).filter(x=>x.info);
  if(entries.length){
    e.classList.add('night-policy-carryover');
    e.innerHTML='<strong>🌙 夜間休憩の持ち越し</strong>'+entries.map(x=>'<p>'+safe(playerLabel(x.id))+'：'+safe(x.info.message)+'</p>').join('')+'<small>夜間停止の設定 '+safe(displayTimeRange())+'</small>';
  }else{
    e.classList.remove('night-policy-carryover');
    e.textContent=`夜間持ち越し設定：${displayTimeRange()}は原則として待ち時間が減りません${isNightPaused()?'／子ども別に前倒し再開できます':''}`;
  }
}
function auditRef(){return dbApi.doc(dbApi.collection(db,'households',householdId,'auditLogs'));}
function appendAudit(writer,action,childId,before,after,sessionId=''){
  const truncate=v=>String(v??'').slice(0,300);
  writer.set(auditRef(),{action,childId,actorUid:uid,actorRole:role,createdAt:dbApi.serverTimestamp(),
    before:truncate(before),after:truncate(after),sessionId:sessionId||''});
}
const AUDIT_ACTIONS={start:'ゲーム開始',end:'ゲーム終了',undo_start:'開始取り消し',undo_end:'終了取り消し',
  manual_set:'手動待ち時間の設定',manual_clear:'手動待ち時間の解除',activity_request:'報酬申請',activity_approve:'報酬承認',activity_reject:'報酬却下',night_resume:'夜間の前倒し再開',forgotten_end:'終了忘れ修正',
  history_edit:'履歴修正',settings_update:'保護者設定の変更',family_init:'家族の初期化',video_start:'動画視聴開始',video_stop:'動画視聴終了',pokemon_claim:'ポケモンをゲット',cheat_confirm:'ズル確認・休憩修正',cheat_honest:'正直な申告・休憩修正',cheat_restore:'誤判定の解除'};
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
function status(p,now=Date.now()){if(!p)return 'unknown';return p.activeStart>0?'playing':videoStartedMillis(p)>0?'watching':restEnd(p)>now?'resting':'ready';}
function gameDuration(p,now=Date.now()){return p?.activeStart>0?Math.max(0,now-p.activeStart):0;}
function summaryFor(p,now=Date.now()){const s=status(p,now);return s==='playing'?gameDuration(p,now):s==='watching'?Math.max(0,now-videoStartedMillis(p)):s==='resting'?waitingRemaining(p,now):0;}
function todayTotal(child,now=Date.now()){
  const a=dayStart(now),b=addDays(a,1);let total=model.sessions.reduce((sum,s)=>sum+(s.childId===child?overlap(s.start,s.end,a,b):0),0);
  const p=model.profiles[child];if(p?.activeStart>0)total+=overlap(p.activeStart,now,a,b);
  const videoStart=videoStartedMillis(p);if(videoStart>0)total+=overlap(videoStart,now,a,b);return total;
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
// v3.11.5: 1台のiPadに2人を並べて表示するため、年齢による見た目の変更は子ども単位。
// ゲーム・休憩・報酬の判定とFirestore上の値には一切影響を与えない。
const JUNIOR_MAX_AGE = 7;
const JUNIOR_ACTIVITIES = Object.freeze({
  study:{icon:'✏️',label:'べんきょうを した'},
  reading:{icon:'📖',label:'ほんを よんだ'},
  exercise:{icon:'🏃',label:'からだを うごかした'},
  helping:{icon:'🧹',label:'おてつだいを した'},
  cleaning:{icon:'🧺',label:'おかたづけを した'},
  creating:{icon:'🎨',label:'なにかを つくった'},
  practicing:{icon:'🎵',label:'れんしゅうを した'},
  trying:{icon:'🌟',label:'あたらしい ことに ちょうせん'},
  persevering:{icon:'💪',label:'さいごまで がんばった'},
  kindness:{icon:'🤝',label:'だれかを たすけた'},
  upstairs21:{icon:'🏠',label:'よる9じまでに 2かいへ あがる'}
});
function ageModeFor(profile,now=Date.now()){
  const age=ageOf(profile,now);
  return age!==null&&age>=0&&age<=JUNIOR_MAX_AGE?'junior':'standard';
}
function ageModeForChild(id,now=Date.now()){
  return ageModeFor(model.profiles[id],now);
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
  const videoTotal=sessions.reduce((a,s)=>a+(s.activityType==='video'?overlap(s.start,s.end,start,end):0),0);
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
  const selfEnded=completed.filter(s=>s.activityType!=='video' && typeof s.createdBy==='string' && s.createdBy.length>0 && (isParentPage ? s.createdBy!==uid : s.createdBy===uid)).length;
  const badges=[
    {icon:'🌟',title:'じぶんでおしまい',description:'子ども画面から1回終了',earned:selfEnded>=1},
    {icon:'🏅',title:'おしまい上手',description:'子ども画面から3回終了',earned:selfEnded>=3},
    {icon:'🌱',title:'やすむ名人',description:'記録上、休憩間隔を3回守れた',earned:passed>=3}
  ];
  return {total,videoTotal,gameTotal:total-videoTotal,prevTotal,average:total/7,daily,days,completed:completed.length,checked,passed,selfEnded,badges};
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
      <div class="report-metrics"><div><small>7日間の合計</small><strong>${safe(brief(stats.total))}</strong></div><div><small>1日平均（7日割）</small><strong>${safe(brief(stats.average))}</strong></div><div><small>前週比</small><strong>${safe(reportDelta(stats.total,stats.prevTotal))}</strong></div></div><div class="report-breakdown">ゲーム ${safe(brief(stats.gameTotal))} ／ 動画 ${safe(brief(stats.videoTotal))}</div>
      <div class="report-subtitle">日別の合計利用時間</div><div class="report-days">${dayBars}</div>
      <div class="report-subtitle">記録上の休憩間隔</div><p class="report-compliance">${pct===null?'比較できる連続記録がありません':`${stats.passed}/${stats.checked}回（${pct}%）`}</p>
      <div class="report-subtitle">今週のバッジ</div><div class="report-badges">${badges}</div></article>`;
  }).join('');
  node.innerHTML=header+`<div class="report-grid">${cards}</div>`+
    `<p class="tiny report-caveat">集計はアプリに記録された履歴に基づきます。休憩間隔は「直前のゲームまたは動画の利用時間と同じ長さを空けたか」の参考値です。夜間停止・保護者による変更や、ゲーム機本体の実利用までは判定しません。${model.reportFromCache?'（通信が不安定なため保存済みデータを表示中）':''}${model.reportTruncated?'（取得上限に達したため集計が不完全な可能性があります）':''}</p>`;
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

// v3.7: 公式ずかん連携型のコレクション。獲得ドキュメントに画像・ポケモン名は保存しない。
const POKEMON_DAY_MS=86400000, POKEMON_JST_MS=32400000;
function rewardDayIndex(now=Date.now()){return Math.floor((now+POKEMON_JST_MS)/POKEMON_DAY_MS);}
function rewardDocumentId(id,day=rewardDayIndex()){return `${id}_${day}`;}
function rewardRef(id,day=rewardDayIndex()){return dbApi.doc(db,'households',householdId,'rewards',rewardDocumentId(id,day));}

// v3.9: 世代別解放。従来の151匹の記録は図鑑番号を固定して保存し直さない。
const GENERATIONS = Object.freeze([
  {name:'第1世代',end:151,needed:0},
  {name:'第2世代',end:251,needed:30},
  {name:'第3世代',end:386,needed:60},
  {name:'第4世代',end:493,needed:100},
  {name:'第5世代',end:649,needed:150},
  {name:'第6世代',end:721,needed:220},
  {name:'第7世代',end:809,needed:300},
  {name:'第8世代',end:905,needed:400},
  {name:'第9世代',end:1025,needed:500}
]);
// v3.10: 10種類の活動。子ども・日付ごとに活動報酬は最大3匹（仮獲得を含む）。
const ACTIVITY_KINDS = Object.freeze({
  study:'勉強した', reading:'本を読んだ', exercise:'体を動かした',
  helping:'お手伝いした', cleaning:'片付けた', creating:'何かを作った',
  practicing:'練習した', trying:'新しいことに挑戦した', persevering:'最後まで頑張った', kindness:'誰かを助けた', upstairs21:'よる9時までに2階に上がる'
});
const ACTIVITY_DAILY_MAX = 3;
const UPSTAIRS_ACTIVITY_ID='upstairs21';
function upstairsBeforeDeadline(now=Date.now()){
  return ((now+JST_OFFSET)%DAY)<21*60*MIN;
}
const activitySlotId = (id,day,slot) => `${id}_${day}_${slot}`;
const activitySlotRef = (id,day,slot) => dbApi.doc(db,'households',householdId,'activitySlots',activitySlotId(id,day,slot));
function dailyRequests(id,day=rewardDayIndex()){
  return model.activityRequests.filter(r=>r.childId===id && r.dayIndex===day);
}
function dailyActivityActive(id,day=rewardDayIndex()){
  return dailyRequests(id,day).filter(r=>r.status==='pending'||r.status==='approved').length;
}
// 仮獲得も予約済みと見なし、同じポケモンが出にくいようにする。
// 本日の確定・仮獲得は競合する可能性があるため、承認時に重複の最終確認も行う。
function provisionalPokemonFor(id,requestId,alsoReserved=[]){
  const owned=new Set(pokemonMapFor(id).keys());
  for(const r of model.activityRequests){
    if(r.childId===id && r.status==='pending' && Number.isInteger(r.candidateNo))owned.add(r.candidateNo);
  }
  for(const no of alsoReserved)if(Number.isInteger(no)&&no>0)owned.add(no);
  const max=GENERATIONS[generationFor(pokemonMapFor(id).size)].end;
  const pool=[];for(let no=1;no<=max;no++)if(!owned.has(no))pool.push(no);
  return pool.length?pool[hashReward(requestId)%pool.length]:1+hashReward(requestId)%POKEDEX_TOTAL;
}

// v3.11.2: parent-confirmed early finish reporting. Rules enforce the same guards.
function rewardSuspended(p,now=Date.now()){
  return Number(p?.rewardSuspendedUntil||0)>now;
}
function rewardSuspensionText(p,now=Date.now()){
  return rewardSuspended(p,now)?`あたらしい ポケモンは ${dateTime(Number(p.rewardSuspendedUntil))}まで おやすみ`:' ';
}
function honestCorrectionAllowed(s){return !!s&&(s.edited!==true || s.correctionKind==='honest');}
function rewardClaims(id){return model.rewards.filter(r=>r.childId===id);}
function activityRequestId(id,kind,day=rewardDayIndex()){return `${id}_${day}_${kind}`;}
function activityRef(id,kind,day=rewardDayIndex()){
  return dbApi.doc(db,'households',householdId,'activityRequests',activityRequestId(id,kind,day));
}
function activityRewardRef(requestId){return dbApi.doc(db,'households',householdId,'rewards',`activity_${requestId}`);}
function claimIdOf(c){return c.rewardId||`${c.childId}_${c.dayIndex}`;}
function claimOrder(a,b){
  return stampMillis(a.claimedAt)-stampMillis(b.claimedAt)
    || claimIdOf(a).localeCompare(claimIdOf(b));
}
function generationFor(count){
  return GENERATIONS.reduce((acc,g,i)=>count>=g.needed?i:acc,0);
}
function hashReward(value){
  let hash=2166136261;
  for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619)>>>0;
  return hash>>>0;
}
// 旧版の獲得結果を保持。v3.9以降は「まだ持っていない番号」からだけ選ぶ。
// 図鑑の表示はクライアント側で確定済みのサーバー記録を同順に再計算する。
function assignedPokemon(id,additional=[]){
  const docs=[...rewardClaims(id),...additional].sort(claimOrder);
  const result=new Map(), owned=new Set();
  for(const c of docs){
    const rewardId=claimIdOf(c);
    let no;
    if(c.catalogVersion===3 && Number.isInteger(c.pokemonNo)) {
      no=c.pokemonNo;
    }else if(c.catalogVersion===2){
      const gen=generationFor(owned.size),max=GENERATIONS[gen].end;
      const candidates=[];
      for(let i=1;i<=max;i++)if(!owned.has(i))candidates.push(i);
      if(candidates.length){no=candidates[hashReward(rewardId)%candidates.length];}
      else {
        // 全1025匹をコンプリートした場合だけ重複を許す。
        no=1+hashReward(rewardId)%POKEDEX_TOTAL;
      }
    }else{
      no=pokemonNoFromClaim(c); // v3.7-v3.8の従来結果を保存
    }
    result.set(rewardId,no);
    owned.add(no);
  }
  return result;
}
function pokemonMapFor(id){
  // 取り消し済みの報酬も割当て順には残す。後から取得したポケモンの番号がずれないようにする。
  const counts=new Map(),assigned=assignedPokemon(id);
  for(const claim of rewardClaims(id)){
    if(claim.revoked===true)continue;
    const no=assigned.get(claimIdOf(claim));
    if(Number.isInteger(no))counts.set(no,(counts.get(no)||0)+1);
  }
  return counts;
}
// v3.11.6: 5匹編成のマイチーム。プロフィールの独立フィールドのみ更新し、報酬処理は変更しない。
const TEAM_SIZE=5;
let favoriteTeamChild='older', editingTeamSlot=null;
function teamFromProfile(profile){
  const raw=Array.isArray(profile?.favoriteTeam)?profile.favoriteTeam:[];
  const seen=new Set();
  return Array.from({length:TEAM_SIZE},(_,i)=>{
    const no=raw[i];
    if(!Number.isInteger(no)||no<1||no>POKEDEX_TOTAL||seen.has(no))return 0;
    seen.add(no);return no;
  });
}
function effectiveTeamFor(id,profile=model.profiles[id]){
  const owned=pokemonMapFor(id);
  // ズル判定によって取り消された報酬はチームから非表示にする。保存した編成は消さない。
  return teamFromProfile(profile).map(no=>no&&owned.has(no)?no:0);
}
function teamAfterSelection(team,slot,no){
  if(!Number.isInteger(slot)||slot<0||slot>=TEAM_SIZE||!Number.isInteger(no)||no<0||no>POKEDEX_TOTAL)
    throw Error('チームの選択が正しくありません。');
  const next=[...team];
  if(next.length!==TEAM_SIZE)throw Error('チームの人数が正しくありません。');
  const previous=next.indexOf(no);
  if(no===0){next[slot]=0;return next;}
  // すでにチーム内にいるポケモンを選ぶと、その枠と位置を入れ替える。
  if(previous>=0&&previous!==slot)next[previous]=next[slot];
  next[slot]=no;
  return next;
}
function renderFavoriteTeam(){
  const stage=$('team-stage'),selector=$('team-child'),info=$('team-status');
  if(!stage||!selector||!info)return;
  if(!ids.includes(favoriteTeamChild))favoriteTeamChild='older';
  for(const option of selector.options)if(ids.includes(option.value))option.textContent=playerLabel(option.value);
  if(selector.value!==favoriteTeamChild)selector.value=favoriteTeamChild;
  if(!model.ready||!model.rewardsLoaded){stage.innerHTML='<p class="empty">チームをよみこみ中…</p>';info.textContent='ずかんのデータを かくにん中…';return;}
  const id=favoriteTeamChild,team=effectiveTeamFor(id),count=team.filter(Boolean).length;
  const junior=!isParentPage&&ageModeForChild(id)==='junior';
  const canEdit=!isParentPage&&canOperate()&&model.rewardsServerConfirmed&&!busy;
  $('favorite-team')?.classList.toggle('age-junior',junior);
  $('favorite-team')?.classList.toggle('team-bro',id==='younger');
  info.textContent=`${playerLabel(id)}の チーム　${count} / ${TEAM_SIZE}ひき`;
  stage.innerHTML=team.map((no,i)=>{
    const leader=i===0,role=leader?'リーダー':`メンバー ${i+1}`;
    const name=no?pokemonName(no):'あいている ばしょ';
    const hue=no?(no*37+40)%360:215;
    const inside=`<span class="team-slot-top"><span class="team-role">${leader?'★ ':''}${role}</span><span class="team-order">${pad(i+1)}</span></span>`+
       `<span class="team-portrait" style="--team-hue:${hue}"><span class="team-orb" aria-hidden="true"><i></i></span></span>`+
       `<strong class="team-pokemon-name">${safe(name)}</strong>`+
       `<span class="team-pokemon-number">${no?'No.'+String(no).padStart(4,'0'):'＋ えらぶ'}</span>`+
       (!isParentPage?`<span class="team-slot-action">${no?(junior?'いれかえる':'いれかえ'):(junior?'ここに いれる':'なかまを えらぶ')}</span>`:'');
    const className=`team-slot ${leader?'team-leader':''} ${no?'team-occupied':'team-empty'} ${junior?'team-junior':''}`;
    return isParentPage?`<article class="${className}" aria-label="${safe(role)} ${safe(name)}">${inside}</article>`:
      `<button type="button" class="${className}" data-team-slot="${i}" aria-label="${safe(role)}：${safe(name)} をいれかえる" ${canEdit?'':'disabled'}>${inside}</button>`;
  }).join('');
  if(!isParentPage){
    const note=count===0?'まずは すきな ポケモンを えらんで チームを つくろう！':
      count===TEAM_SIZE?'5ひき そろったよ！ いつでも いれかえられるよ。':'あいている ばしょを おして なかまを ふやそう！';
    info.textContent+='　・　'+note;
  }
}
function teamSearchKey(value){
  // 6歳児も入力しやすいように、ひらがな・カタカナ・全角数字を同じ条件で検索する。
  return String(value??'').normalize('NFKC').toLowerCase()
    .replace(/[\u3041-\u3096]/g,c=>String.fromCharCode(c.charCodeAt(0)+0x60));
}
function renderTeamPicker(){
  const dialog=$('team-picker'),list=$('team-choice-list');
  if(!dialog||!dialog.open||!list||editingTeamSlot===null)return;
  const id=favoriteTeamChild,team=effectiveTeamFor(id),current=team[editingTeamSlot],owned=[...pokemonMapFor(id).keys()].sort((a,b)=>a-b);
  const q=teamSearchKey($('team-search').value.trim());
  const options=owned.filter(no=>!q||teamSearchKey(pokemonName(no)).includes(q)||String(no).includes(q)).slice(0,80);
  $('team-picker-title').textContent=`${editingTeamSlot===0?'リーダー':`${editingTeamSlot+1}ばんめの なかま`}を えらぼう`;
  $('team-picker-caption').textContent=`ゲットした ${owned.length}しゅるいから えらべるよ。${q?'':' なまえで さがすことも できるよ。'}`;
  $('team-remove').disabled=!current||busy;
  const inTeam=new Set(team.filter(Boolean));
  list.innerHTML=options.length?options.map(no=>{
    const selected=no===current,assigned=inTeam.has(no);
    return `<button type="button" class="team-choice ${selected?'selected':''}" data-team-pick="${no}" ${busy?'disabled':''}>`+
      `<span class="team-choice-icon" aria-hidden="true">${selected?'★':'●'}</span><span class="team-choice-text"><strong>${safe(pokemonName(no))}</strong><small>No.${String(no).padStart(4,'0')} ${selected?'・いま えらんでいる':assigned?'・チームに いる':''}</small></span>`+
      `<span class="team-choice-arrow">${selected?'✓':'＋'}</span></button>`;
  }).join(''):'<p class="empty">みつからなかったよ。べつの なまえで さがしてね。</p>';
  if(owned.length>80&&!q)list.innerHTML+='<p class="tiny">たくさん いるから 80ひきずつ ひょうじしているよ。なまえで さがしてね。</p>';
}
function openTeamPicker(slot){
  if(isParentPage||!Number.isInteger(slot)||slot<0||slot>=TEAM_SIZE)return;
  if(!canOperate()||!model.rewardsServerConfirmed)return toast('チームの最新データを確認中です。');
  if(pokemonMapFor(favoriteTeamChild).size===0)return toast('まずはポケモンをゲットしてね！');
  editingTeamSlot=slot;
  $('team-search').value='';$('team-picker').showModal();renderTeamPicker();
}
async function saveTeamChoice(no){
  if(isParentPage||editingTeamSlot===null||busy)return;
  const id=favoriteTeamChild,slot=editingTeamSlot;
  if(no!==0&&!pokemonMapFor(id).has(no))return toast('ゲットしたポケモンだけえらべるよ。');
  await runLocked(async()=>{
    if(!model.rewardsServerConfirmed)throw Error('クラウドの図鑑データを確認中です。');
    let changed=false;
    await dbApi.runTransaction(db,async tx=>{
      const ref=refProfile(id),snap=await tx.get(ref);
      if(!snap.exists())throw Error('子どものデータが見つかりません。');
      const before=effectiveTeamFor(id,snap.data());
      const next=teamAfterSelection(before,slot,no);
      if(next.every((n,i)=>n===before[i]))return;
      tx.update(ref,{favoriteTeam:next,teamUpdatedAt:dbApi.serverTimestamp()});changed=true;
    });
    $('team-picker')?.close();editingTeamSlot=null;
    toast(changed?no===0?'チームから はずしたよ！':'マイチームを かえたよ！':'このポケモンは もう チームに いるよ！');
  });
}
function lastSessionFor(id){
  const p=model.profiles[id];
  return model.sessions.find(s=>s.sid===p?.lastSessionId && s.childId===id) || null;
}
function claimEligibility(id,now=Date.now()){
  const p=model.profiles[id];
  if(!p || !model.rewardsLoaded)return {ok:false,label:'図鑑を読み込み中'};
  if(rewardSuspended(p,now))return {ok:false,label:rewardSuspensionText(p,now)};
  const day=rewardDayIndex(now);
  // 1日1回のゲーム報酬。勉強・読書・運動の獲得は別枠。
  if(model.rewards.some(r=>r.childId===id && r.kind==='rest_completed' && r.dayIndex===day)
     || Number(p.rewardLastDayIndex)===day)
    return {ok:false,label:'きょうのゲーム報酬はゲット済み'};
  const s=lastSessionFor(id);
  if(!s || !s.sid || s.activityType==='video')return {ok:false,label:'ゲームと休憩を守ったらチャレンジ'};
  if(s.sid===p.rewardLastSessionId||s.sid===p.rewardBlockedSessionId)return {ok:false,label:'このゲームのごほうびは おやすみ'};
  if(s.createdBy!==uid || !honestCorrectionAllowed(s) || s.duration<MIN || s.end<now-2*DAY)
    return {ok:false,label:'次のゲームと休憩でチャレンジ'};
  if(p.activeStart>0||videoStartedMillis(p)>0)return {ok:false,label:'ゲーム・動画を終えてからチャレンジ'};
  if(waitingRemaining(p,now)>0)return {ok:false,label:'おやすみを守ったらゲット！'};
  if(!canOperate()||!model.rewardsServerConfirmed)return {ok:false,label:'クラウドを確認中'};
  return {ok:true,label:'ポケモンをゲット！'};
}
function rewardActionFor(id,now=Date.now()){
  const state=claimEligibility(id,now),junior=!isParentPage&&ageModeForChild(id,now)==='junior';
  const caption=junior?'🎁 ゲームと おやすみの ごほうび':'🎁 ゲーム・休憩のごほうび';
  const claimLabel=junior?'ポケモンを ゲット！':'ポケモンをゲット！';
  const simpleMessages={
    '図鑑を読み込み中':'ずかんを よんでいるよ',
    'きょうのゲーム報酬はゲット済み':'きょうの ポケモンは もう もらったよ',
    'ゲームと休憩を守ったらチャレンジ':'ゲームを やめて、おやすみ したら もらえるよ',
    'このゲームのごほうびは おやすみ':'こんかいの ポケモンは おやすみ',
    '次のゲームと休憩でチャレンジ':'つぎの ゲームの あとに チャレンジ！',
    'ゲーム・動画を終えてからチャレンジ':'ゲームや どうがを やめてからね',
    'おやすみを守ったらゲット！':'おやすみ が おわったら ゲット！',
    'クラウドを確認中':'つながるのを まってね'
  };
  const stateLabel=junior?(simpleMessages[state.label]||state.label):state.label;
  return `<div class="pokemon-reward-action"><span>${caption}</span>${!isParentPage && state.ok
    ? `<button class="btn pokemon-claim" data-pokemon-claim="${id}" ${busy?'disabled':''}>${claimLabel}</button>`
    : `<small>${safe(stateLabel)}</small>`}</div>`;
}
function renderPokedex(){
  const target=$('pokedex-grid');if(!target)return;
  const select=$('pokedex-child'),filter=$('pokedex-filter');
  if(!ids.includes(select.value))select.value=displayIds()[0];
  for(const option of select.options)if(ids.includes(option.value))option.textContent=playerLabel(option.value);
  if(!model.rewardsLoaded){target.innerHTML='<p class="empty">図鑑を読み込み中…</p>';return;}
  const id=select.value,allClaims=rewardClaims(id),claims=allClaims.filter(c=>c.revoked!==true),map=pokemonMapFor(id);
  if(!isParentPage)$('pokemon-collection')?.classList.toggle('age-junior',ageModeForChild(id)==='junior');
  const unique=map.size,duplicates=claims.length-unique;
  const genIndex=generationFor(unique),max=GENERATIONS[genIndex].end;
  $('pokedex-summary').textContent=`あつめた種類：${unique} / ${POKEDEX_TOTAL}匹　・　ゲットした回数：${claims.length}回　・　重複：${duplicates}回${allClaims.length>claims.length?`　・　対象外：${allClaims.length-claims.length}件`:''}`;
  $('pokedex-progress').style.width=`${(unique/POKEDEX_TOTAL*100).toFixed(2)}%`;
  const next=GENERATIONS[genIndex+1];
  $('pokedex-milestone').textContent=next
    ? `${GENERATIONS[genIndex].name}まで解放中（No.001〜${max}）。次の${next.name}まであと${Math.max(0,next.needed-unique)}種類`
    : '第9世代まで解放中！ 全1,025匹を目指そう';
  const currentFilter=filter.value;
  const entries=[];
  // 初期描画負荷を抑えるため、全件表示でも現在解放中の番号まで。
  for(let no=1;no<=max;no++){
    const count=map.get(no)||0;
    if(currentFilter==='owned'&&!count)continue;
    const name=pokemonName(no),label=`No.${String(no).padStart(4,'0')}`;
    if(count)entries.push(`<a class="pokedex-entry caught" href="${officialPokedexUrl(no)}" target="_blank" rel="noopener noreferrer" aria-label="${safe(name)}：公式ずかんで見る"><span class="pokedex-number">${label}</span><span class="pokedex-mark">★</span><strong>${safe(name)}</strong>${count>1?`<small>${count}回ゲット</small>`:'<small>公式ずかんを見る</small>'}</a>`);
    else entries.push(`<div class="pokedex-entry locked" aria-label="${label} 未発見"><span class="pokedex-number">${label}</span><span class="pokedex-mark">？</span><strong>？？？</strong><small>まだ見つけていない</small></div>`);
  }
  target.innerHTML=entries.join('')||'<p class="empty">まだポケモンをゲットしていません。ゲームの休憩や今日のチャレンジでゲットしよう！</p>';
  renderProvisionalPokedex(id);
  $('pokedex-note').textContent=(model.rewardsServerConfirmed?'図鑑データはクラウドで同期しています。':'オフラインまたは同期確認中のため、獲得操作は停止しています。')
    +' 新しいポケモンの日本語名は外部データから読み込むため、通信環境によっては番号のみ表示されます。';
}
function renderProvisionalPokedex(id){
  const root=$('pokedex-provisional');if(!root)return;
  const pending=model.activityRequests.filter(r=>r.childId===id&&r.status==='pending');
  if(!pending.length){root.innerHTML='';return;}
  root.innerHTML='<h3>⏳ 仮ゲット（保護者の確認待ち）</h3><div class="provisional-grid">'+pending.map(r=>{
    const no=Number(r.candidateNo),pokemon=Number.isInteger(no)&&no>0?`${safe(pokemonName(no))}（No.${String(no).padStart(4,'0')}）`:'ポケモンは承認時に決まります';
    return `<div class="provisional-card"><strong>${pokemon}</strong><small>${safe(ACTIVITY_KINDS[r.activityKind]||r.activityKind)}・確認待ち</small><small>まだ正式な図鑑には入りません</small></div>`;
  }).join('')+'</div>';
}
function announcePokemon(id,number,isDuplicate){
  const dialog=$('pokemon-result');if(!dialog)return;
  $('pokemon-result-title').textContent=`${playerLabel(id)}、${isDuplicate?'また会えたね！':'新しいポケモンをゲット！'}`;
  $('pokemon-result-name').textContent=pokemonName(number);
  $('pokemon-result-number').textContent=`全国図鑑 No.${String(number).padStart(4,'0')}`;
  $('pokemon-result-link').href=officialPokedexUrl(number);
  if(!dialog.open)dialog.showModal();
}
async function claimPokemon(id){
  if(isParentPage||!ids.includes(id))return;
  const initial=claimEligibility(id);
  if(!initial.ok)return toast(initial.label);
  await runLocked(async()=>{
    const day=rewardDayIndex(),ref=refProfile(id),reward=rewardRef(id,day);
    const result=await dbApi.runTransaction(db,async tx=>{
      const pSnap=await tx.get(ref),rewardSnap=await tx.get(reward);
      if(!pSnap.exists())throw Error('プロフィールを取得できません。');
      if(rewardSnap.exists())throw Error('きょうのポケモンはもうゲット済みです。');
      const p=pSnap.data(),sid=p.lastSessionId;
      if(!sid||sid===p.rewardLastSessionId || sid===p.rewardBlockedSessionId || rewardSuspended(p) || Number(p.rewardLastDayIndex)===day || p.activeStart>0 || videoStartedMillis(p)>0)
        throw Error('このゲーム記録ではゲットできません。');
      const sSnap=await tx.get(dbApi.doc(sessionsRef(),sid));
      if(!sSnap.exists())throw Error('ゲームの記録を確認できません。');
      const s=sSnap.data(),now=Date.now();
      if(s.childId!==id||s.activityType==='video'||s.createdBy!==uid||!honestCorrectionAllowed(s)||s.duration<MIN||s.end<now-2*DAY)
        throw Error('この記録は獲得の対象外です。次のゲーム終了後に挑戦してください。');
      if(waitingRemaining(p,now)>0 || now<s.end+s.duration)
        throw Error('休憩時間が終わるまで待ってください。');
      tx.update(ref,{rewardLastSessionId:sid,rewardLastDayIndex:day,updatedAt:dbApi.serverTimestamp()});
      tx.set(reward,{childId:id,sessionId:sid,dayIndex:day,claimedBy:uid,claimedAt:dbApi.serverTimestamp(),kind:'rest_completed',catalogVersion:2});
      appendAudit(tx,'pokemon_claim',id,'本日は未獲得','ポケモンをゲット',sid);
      return {childId:id,sessionId:sid,dayIndex:day,kind:'rest_completed',catalogVersion:2,rewardId:rewardDocumentId(id,day),claimedAt:{toMillis:()=>Date.now()}};
    });
    const number=assignedPokemon(id,[result]).get(result.rewardId),duplicate=pokemonMapFor(id).has(number);
    announcePokemon(id,number,duplicate);
  });
}
// v3.11.1 F06: 保護者が1回付与した権利を、子どもが1回だけ確定獲得する。
// アカウント/データの不正操作は Firestore Rules で防止する。
function bonusCollection(){return dbApi.collection(db,'households',householdId,'bonusGrants');}
function bonusGrantRef(grantId){return dbApi.doc(bonusCollection(),grantId);}
function bonusRewardRef(grantId){return dbApi.doc(db,'households',householdId,'rewards',`bonus_${grantId}`);}
function availableBonusGrants(childId){
  return model.bonusGrants.filter(g=>g.childId===childId&&g.status==='available')
    .sort((a,b)=>stampMillis(a.grantedAt)-stampMillis(b.grantedAt)||a.grantId.localeCompare(b.grantId));
}
function renderBonuses(){
  const child=$('bonus-child-list'),admin=$('bonus-admin-list');
  if(!child&&!admin)return;
  const target=child||admin;
  if(!model.ready||!model.bonusLoaded||!model.rewardsLoaded){
    target.innerHTML='<p class="empty">特別ボーナスを確認中…</p>';return;
  }
  if(child){
    child.innerHTML=displayIds().filter(id=>id===focusChild).map(id=>{
      const count=availableBonusGrants(id).length,junior=ageModeForChild(id)==='junior';
      const message=junior?(count?`🎁 あと ${count}かい もらえるよ`:'いまは プレゼントなし'):(count?`🎁 受け取り待ち ${count}匹分`:'いまはプレゼントなし');
      return `<div class="bonus-person ${junior?'age-junior':''}"><div class="bonus-person-info"><strong>${safe(playerLabel(id))}</strong><span>${message}</span></div>`+
        (count?`<button type="button" class="btn primary" data-bonus-claim="${id}" ${busy||rewardSuspended(model.profiles[id])||!canOperate()||!model.bonusServerConfirmed||!model.rewardsServerConfirmed?'disabled':''}>${junior?'🎉 ポケモンを もらう！':'🎉 ポケモンを1匹ゲット！'}</button>`:'<small>おうちの人から届くのを楽しみにしてね</small>')+
        '</div>';
    }).join('');
  }else if(admin){
    admin.innerHTML=displayIds().map(id=>{
      const pending=availableBonusGrants(id).length;
      const recent=model.bonusGrants.filter(g=>g.childId===id&&g.status==='claimed')
        .sort((a,b)=>stampMillis(b.claimedAt)-stampMillis(a.claimedAt))[0];
      const last=recent&&stampMillis(recent.claimedAt)?`最後の受け取り：${dateTime(stampMillis(recent.claimedAt))}`:'受け取り履歴なし';
      return `<div class="bonus-person"><div class="bonus-person-info"><strong>${safe(playerLabel(id))}</strong><span>未受け取り ${pending}匹分　/　${safe(last)}</span></div>`+
        `<button type="button" class="btn primary" data-bonus-grant="${id}" ${busy||!canOperate()||!model.bonusServerConfirmed?'disabled':''}>🎁 特別ボーナスを1回付与</button></div>`;
    }).join('');
  }
}
async function grantSpecialBonus(id){
  if(!isParentPage||!ids.includes(id)||busy)return;
  if(!model.bonusServerConfirmed)return toast('ボーナスの最新状態を確認中です。');
  const outstanding=availableBonusGrants(id).length;
  const msg=`${playerLabel(id)}にポケモン1匹分の特別ボーナスを贈りますか？`+
    (outstanding?`\nすでに未受け取りが${outstanding}匹分あります。`:'')+
    '\n付与後の取り消しはできません。';
  if(!confirm(msg))return;
  await runLocked(async()=>{
    const ref=dbApi.doc(bonusCollection());
    await dbApi.setDoc(ref,{childId:id,status:'available',grantedBy:uid,grantedAt:dbApi.serverTimestamp()});
    toast(`${playerLabel(id)}へ特別ボーナスを1匹分プレゼントしました！`);
  });
}
async function claimSpecialBonus(id){
  if(isParentPage||!ids.includes(id)||busy)return;
  if(!model.bonusServerConfirmed||!model.rewardsServerConfirmed)return toast('クラウドの最新状態を確認中です。');
  if(rewardSuspended(model.profiles[id]))return toast(rewardSuspensionText(model.profiles[id]));
  const grant=availableBonusGrants(id)[0];
  if(!grant)return toast('受け取れる特別ボーナスはありません。');
  await runLocked(async()=>{
    const grantRef=bonusGrantRef(grant.grantId),rewardRef=bonusRewardRef(grant.grantId);
    const oldOwned=pokemonMapFor(id);
    const result=await dbApi.runTransaction(db,async tx=>{
      const [grantSnap,rewardSnap]=await Promise.all([tx.get(grantRef),tx.get(rewardRef)]);
      if(!grantSnap.exists()||grantSnap.data().status!=='available'||grantSnap.data().childId!==id)
        throw Error('特別ボーナスはすでに受け取り済みか、対象が異なります。');
      if(rewardSnap.exists())throw Error('この特別ボーナスはすでにゲット済みです。');
      const pSnap=await tx.get(refProfile(id));
      if(!pSnap.exists()||rewardSuspended(pSnap.data()))throw Error('いまはポケモンを受け取れません。');
      tx.update(grantRef,{status:'claimed',claimedBy:uid,claimedAt:dbApi.serverTimestamp(),rewardId:rewardRef.id});
      tx.set(rewardRef,{childId:id,grantId:grant.grantId,sessionId:'',dayIndex:rewardDayIndex(),
        kind:'special_bonus',claimedBy:uid,claimedAt:dbApi.serverTimestamp(),catalogVersion:2});
      return {childId:id,grantId:grant.grantId,sessionId:'',dayIndex:rewardDayIndex(),
        kind:'special_bonus',catalogVersion:2,rewardId:rewardRef.id,claimedAt:{toMillis:()=>Date.now()}};
    });
    // realtime listener が先に反映した場合も二重カウントしない。
    const extra=model.rewards.some(r=>r.rewardId===result.rewardId)?[]:[result];
    const no=assignedPokemon(id,extra).get(result.rewardId);
    if(!Number.isInteger(no))throw Error('獲得済みですが、図鑑の計算に失敗しました。画面を更新してください。');
    announcePokemon(id,no,oldOwned.has(no));
  });
}
// v3.11 F02: JSTの申請日を基準にする「がんばりカレンダー」。全件既存購読を再利用。
function calendarNowMonth(now=Date.now()){
  const d=new Date(now+JST_OFFSET);return {year:d.getUTCFullYear(),month:d.getUTCMonth()};
}
const calendarInitial=calendarNowMonth();
let effortCalendarYear=calendarInitial.year,effortCalendarMonth=calendarInitial.month;
let effortCalendarChild='older',effortCalendarDay=rewardDayIndex();
function effortDayIndex(year,month,day){return Math.floor(Date.UTC(year,month,day)/DAY);}
function effortCalendarMonthShift(delta){
  const date=new Date(Date.UTC(effortCalendarYear,effortCalendarMonth+delta,1));
  effortCalendarYear=date.getUTCFullYear();effortCalendarMonth=date.getUTCMonth();
  const current=calendarNowMonth();
  if(effortCalendarYear>current.year||(effortCalendarYear===current.year&&effortCalendarMonth>current.month)){
    effortCalendarYear=current.year;effortCalendarMonth=current.month;
  }
  effortCalendarDay=effortDayIndex(effortCalendarYear,effortCalendarMonth,1);
  renderEffortCalendar();
}
function effortCalendarRows(id,day){
  return model.activityRequests.filter(r=>r.childId===id&&r.dayIndex===day)
    .sort((a,b)=>stampMillis(a.requestedAt)-stampMillis(b.requestedAt));
}
function renderEffortCalendar(){
  const grid=$('effort-calendar-grid'),detail=$('effort-calendar-detail');if(!grid||!detail)return;
  const selector=$('effort-calendar-child');
  if(!ids.includes(effortCalendarChild))effortCalendarChild=displayIds()[0];
  for(const option of selector.options)if(ids.includes(option.value))option.textContent=playerLabel(option.value);
  if(selector.value!==effortCalendarChild)selector.value=effortCalendarChild;
  if(!isParentPage)$('activity-calendar')?.classList.toggle('age-junior',ageModeForChild(effortCalendarChild)==='junior');
  $('effort-calendar-month').textContent=`${effortCalendarYear}年${effortCalendarMonth+1}月`;
  const current=calendarNowMonth();
  $('effort-calendar-next').disabled=effortCalendarYear>=current.year&&effortCalendarMonth>=current.month;
  if(!model.activityLoaded){grid.innerHTML='<p class="empty">活動記録を読み込み中…</p>';detail.innerHTML='';return;}
  const today=rewardDayIndex();
  const days=new Date(Date.UTC(effortCalendarYear,effortCalendarMonth+1,0)).getUTCDate();
  const first=new Date(Date.UTC(effortCalendarYear,effortCalendarMonth,1)).getUTCDay();
  const rows=[];const records=[];
  for(let d=1;d<=days;d++){
    const day=effortDayIndex(effortCalendarYear,effortCalendarMonth,d);
    const items=effortCalendarRows(effortCalendarChild,day);
    const approved=items.filter(r=>r.status==='approved').length;
    const pending=items.filter(r=>r.status==='pending').length;
    records.push({day,approved,pending});
    rows.push(`<button type="button" class="effort-day ${effortCalendarDay===day?'selected':''} ${day===today?'today':''}" data-effort-day="${day}" aria-pressed="${effortCalendarDay===day}" ${day>today?'disabled':''} aria-label="${d}日：承認済み${approved}件、確認待ち${pending}件"><span class="effort-day-number">${d}</span><span class="effort-day-symbols">${approved?`<span class="effort-approved" aria-label="承認済み">✓${approved}</span>`:''}${pending?`<span class="effort-pending" aria-label="承認待ち">◷${pending}</span>`:''}</span></button>`);
  }
  grid.innerHTML='<div class="effort-weekdays">'+['日','月','火','水','木','金','土'].map(x=>`<span>${x}</span>`).join('')+'</div>'+
    `<div class="effort-days">${Array.from({length:first},()=>'<span class="effort-blank" aria-hidden="true"></span>').join('')}${rows.join('')}</div>`;
  const approvedDays=records.filter(d=>d.approved>0).length;
  const approvedTotal=records.reduce((sum,r)=>sum+r.approved,0);
  const pendingTotal=records.reduce((sum,r)=>sum+r.pending,0);
  $('effort-calendar-summary').textContent=`承認済みの活動 ${approvedTotal}件 / がんばった日 ${approvedDays}日 / 確認待ち ${pendingTotal}件`;
  const selected=effortCalendarDay;
  const selectedDayNumber=new Date(selected*DAY).getUTCDate();
  const selectedRows=effortCalendarRows(effortCalendarChild,selected);
  const assigned=(model.rewardsLoaded&&selectedRows.some(r=>r.status==='approved'))?assignedPokemon(effortCalendarChild):null;
  detail.innerHTML=`<h3>${effortCalendarMonth+1}月${selectedDayNumber}日のチャレンジ</h3>`+
    (selectedRows.length?`<div class="effort-details">${selectedRows.map(r=>{
      const label=r.status==='approved'?'承認済み':r.status==='pending'?'確認待ち':'見送り';
      const statusClass=r.status==='approved'?'approved':r.status==='pending'?'pending':'rejected';
      let pokemon='';
      const no=r.status==='pending'?Number(r.candidateNo):r.status==='approved'?assigned?.get(`activity_${r.requestId}`):null;
      if(Number.isInteger(no)&&no>=1&&no<=POKEDEX_TOTAL){
        const name=`${safe(pokemonName(no))}（No.${String(no).padStart(4,'0')}）`;
        pokemon=r.status==='approved'?`<a href="${officialPokedexUrl(no)}" target="_blank" rel="noopener noreferrer">${name}を公式ずかんで見る</a>`:`<span>仮ゲット：${name}</span>`;
      }
      return `<div class="effort-detail-row"><span><strong>${safe(ACTIVITY_KINDS[r.activityKind]||r.activityKind)}</strong>${pokemon?`<small>${pokemon}</small>`:''}</span><span class="effort-status ${statusClass}">${label}</span></div>`;
    }).join('')}</div>`:'<p class="tiny">この日の活動申請はありません。</p>');
}

function requestFor(id,kind,day=rewardDayIndex()){
  return model.activityRequests.find(r=>r.childId===id&&r.activityKind===kind&&r.dayIndex===day);
}
function renderActivities(){
  const root=$('activity-rewards');if(!root)return;
  // 監視データ更新時に、子どもが開いた/閉じたパネルの状態を維持する。
  const existing=root.querySelectorAll('details.activity-person');
  const hasExisting=existing.length>0;
  const expanded=new Set([...root.querySelectorAll('details.activity-person[open]')].map(el=>el.dataset.child));
  if(!model.ready||!model.activityLoaded||!model.rewardsLoaded){root.innerHTML='<p class="empty">ごほうびを読み込み中…</p>';return;}
  root.innerHTML=displayIds().filter(id=>isParentPage||id===focusChild).map(id=>{
    const junior=!isParentPage&&ageModeForChild(id)==='junior';
    const used=dailyActivityActive(id),remaining=Math.max(0,ACTIVITY_DAILY_MAX-used);
    const actions=Object.entries(ACTIVITY_KINDS).map(([kind,name])=>{
      const req=requestFor(id,kind),number=Number(req?.candidateNo);
      const label=Number.isInteger(number)&&number>0?`${pokemonName(number)}（No.${String(number).padStart(4,'0')}）`:'';
      const retry=req?.status==='rejected';
      const alreadyDone=!!req&&!retry;
      const suspended=rewardSuspended(model.profiles[id]);
      const status=junior
        ?(req?.status==='approved'?'できた！ ポケモン ゲット！':retry?'もういちど できたら おくれるよ':req?'おうちのひとの かくにんまち':'まだ おくってないよ')
        :(req?.status==='approved'?'承認済み・正式ゲット':retry?'見送り・もういちど できたら 申請できるよ':req?'仮ゲット・保護者の確認待ち':'申請できます');
      const detail=req?.status==='pending'&&label?`<span class="provisional-label">⏳ ${safe(label)}を仮ゲット！</span>`:'';
      const deadlinePassed=kind===UPSTAIRS_ACTIVITY_ID&&!upstairsBeforeDeadline();
      const unavailable=alreadyDone||deadlinePassed||remaining===0||suspended||!canOperate()||!model.activityServerConfirmed||!model.rewardsServerConfirmed||busy;
      const buttonLabel=junior
        ?(alreadyDone?'もう おくったよ':suspended?'いまは おやすみ':deadlinePassed?'9じを すぎたよ':remaining===0?'きょうは おわり':retry?'もういちど できた！':'できた！ おくる')
        :(alreadyDone?'申請済み':suspended?'ごほうびおやすみ中':deadlinePassed?'受付は21:00まで':remaining===0?'本日上限':retry?'もういちど できた！申請':'できた！申請');
      const display=junior?(JUNIOR_ACTIVITIES[kind]||{icon:'⭐',label:name}):null;
      if(junior)return `<div class="activity-item activity-junior-item"><div class="activity-junior-icon" aria-hidden="true">${display.icon}</div><div class="activity-junior-text"><strong>${safe(display.label)}</strong><small>${safe(status)}</small>${detail}</div><button type="button" class="btn outline" data-activity-request="${id}:${kind}" ${unavailable?'disabled':''}>${buttonLabel}</button></div>`;
      return `<div class="activity-item"><span><strong>${safe(name)}</strong><small>${status}</small>${detail}</span>${!isParentPage?`<button class="btn outline" data-activity-request="${id}:${kind}" ${unavailable?'disabled':''}>${buttonLabel}</button>`:''}</div>`;
    }).join('');
    const opened=!isParentPage||expanded.has(id)||(!hasExisting&&junior);
    const summary=junior?`<strong>${safe(playerLabel(id))} 🌱 やさしい がめん</strong><span>きょうの できた：${used} / ${ACTIVITY_DAILY_MAX}　あと ${remaining}かい</span>`:`<strong>${safe(playerLabel(id))}</strong><span>きょうの活動：${used} / ${ACTIVITY_DAILY_MAX}枠　・　残り${remaining}枠</span>`;
    const note=junior?'できた ことを おくろう。おうちのひとが かくにん するよ。みおくりの あとは、もういちど できたら おくれるよ。':'1日3枠まで。仮ゲット中も1枠使います。「見送り」はもう一度活動すれば同じ日に再申請できます。';
    return `<details class="activity-person ${junior?'age-junior':''}" data-child="${id}" ${opened?'open':''}><summary>${summary}</summary><p class="tiny">${note}</p><div class="${junior?'activity-junior-grid':'activity-standard-list'}">${actions}</div></details>`;
  }).join('');
}
// v3.11 F04: 現行の承認トランザクションを変えず、一覧の視認性と子ども別フィルターを改善。
let approvalFilter='all';
function renderApprovals(){
  const root=$('activity-approvals');if(!root||!isParentPage)return;
  if(!model.activityLoaded){root.innerHTML='<p class="empty">申請を読み込み中…</p>';return;}
  const all=model.activityRequests;
  const pendingAll=all.filter(r=>r.status==='pending');
  const count=pendingAll.length;
  const countEl=$('approval-pending-count');if(countEl)countEl.textContent=`未承認 ${count}件`;
  const topCount=$('approval-jump-count');if(topCount)topCount.textContent=`${count}件`;
  const select=$('approval-filter');
  if(select){for(const option of select.options)if(ids.includes(option.value))option.textContent=playerLabel(option.value);
    if(select.value!==approvalFilter)select.value=approvalFilter;}
  const matches=r=>approvalFilter==='all'||r.childId===approvalFilter;
  const pending=pendingAll.filter(matches).sort((a,b)=>stampMillis(a.requestedAt)-stampMillis(b.requestedAt));
  const recent=all.filter(r=>r.status!=='pending'&&matches(r))
    .sort((a,b)=>stampMillis(b.reviewedAt)-stampMillis(a.reviewedAt)).slice(0,8);
  const requests=[...pending,...recent];
  const staleCount=pendingAll.filter(r=>stampMillis(r.requestedAt)>0 && Date.now()-stampMillis(r.requestedAt)>=DAY).length;
  const summary=$('approval-filter-summary');if(summary)summary.textContent=
    `全員の確認待ち ${count}件${staleCount?`（うち24時間以上 ${staleCount}件）`:''}。表示中 ${pending.length}件。`;
  root.innerHTML=(requests.length?requests.map(r=>{
    const kind=ACTIVITY_KINDS[r.activityKind]||r.activityKind;
    const when=stampMillis(r.requestedAt)?dateTime(stampMillis(r.requestedAt)):'日時確認中';
    const overdue=r.status==='pending'&&stampMillis(r.requestedAt)>0&&Date.now()-stampMillis(r.requestedAt)>=DAY;
    const no=Number(r.candidateNo);
    const pokemon=r.status==='pending'&&Number.isInteger(no)&&no>0?`<small class="provisional-label">⏳ 仮ゲット：${safe(pokemonName(no))}（No.${String(no).padStart(4,'0')}）</small>`:'';
    return `<div class="approval-item ${overdue?'approval-overdue':''}"><div class="approval-copy"><strong>${safe(playerLabel(r.childId))}：${safe(kind)}</strong><small>${safe(when)} 申請・${r.status==='pending'?'確認待ち':r.status==='approved'?'承認済み':'見送り'}</small>${overdue?'<span class="approval-overdue-label">24時間以上確認待ち</span>':''}${pokemon}</div>${r.status==='pending'?`<div class="approval-buttons"><button class="btn primary" data-activity-review="${safe(r.requestId)}:approve" ${busy||rewardSuspended(model.profiles[r.childId])?'disabled':''}>正式にゲット</button><button class="btn outline" data-activity-review="${safe(r.requestId)}:reject" ${busy?'disabled':''}>見送る</button></div>`:''}</div>`;
  }).join(''):'<p class="empty">この条件に該当する申請はありません。</p>');
}
async function requestActivity(id,kind){
  if(isParentPage||!ids.includes(id)||!Object.hasOwn(ACTIVITY_KINDS,kind))return;
  if(kind===UPSTAIRS_ACTIVITY_ID&&!upstairsBeforeDeadline())return toast('21時までに2階に上がるチャレンジは、本日21:00で受付終了しました。');
  if(!model.activityServerConfirmed||!model.rewardsServerConfirmed)return toast('クラウド接続を確認してください。');
  if(rewardSuspended(model.profiles[id]))return toast(rewardSuspensionText(model.profiles[id]));
  const existing=requestFor(id,kind);
  if(existing&&existing.status!=='rejected')return toast('今日はこの項目をすでに申請しています。');
  if(dailyActivityActive(id)>=ACTIVITY_DAILY_MAX)return toast('今日の活動ごほうびは3匹までです。');
  const junior=ageModeForChild(id)==='junior';
  const activityName=junior?(JUNIOR_ACTIVITIES[kind]?.label||ACTIVITY_KINDS[kind]):ACTIVITY_KINDS[kind];
  const prompt=junior
    ?`${playerLabel(id)}：${activityName}？\nほんとうに できたら、おうちのひとに おくろう！\n「OK」を おしてね。`
    :existing?.status==='rejected'
      ?`${playerLabel(id)}：「${ACTIVITY_KINDS[kind]}」をもう一度やった？\nできたなら、もう一度申請してポケモンを仮ゲットしよう！`
      :`${playerLabel(id)}：${ACTIVITY_KINDS[kind]}を頑張ったことを申請して、ポケモンを仮ゲットしますか？`;
  if(!confirm(prompt))return;
  await runLocked(async()=>{
    const day=rewardDayIndex(),rid=activityRequestId(id,kind,day),ref=activityRef(id,kind,day);
    let candidate=0;
    await dbApi.runTransaction(db,async tx=>{
      if(kind===UPSTAIRS_ACTIVITY_ID&&!upstairsBeforeDeadline())throw Error('21時を過ぎたので、今日の申請はできません。');
      const snapshots=await Promise.all([tx.get(ref),...[1,2,3].map(n=>tx.get(activitySlotRef(id,day,n)))]);
      const oldRequest=snapshots[0].exists()?snapshots[0].data():null;
      if(oldRequest && oldRequest.status!=='rejected')throw Error('今日はすでにこの項目を申請しています。');
      if(oldRequest && (oldRequest.childId!==id || oldRequest.activityKind!==kind || oldRequest.dayIndex!==day))
        throw Error('申請履歴と対象の活動が一致しません。');
      // 旧v3.9の申請が残る移行日のみ、画面に表示される既存申請数も加味する。
      if(dailyActivityActive(id,day)>=ACTIVITY_DAILY_MAX)throw Error('本日の活動報酬は3匹までです。');
      const available=[1,2,3].find(n=>!snapshots[n].exists()||snapshots[n].data().requestId==='');
      if(!available)throw Error('きょうの活動報酬は3枠すべて使用中です。');
      const otherReserved=snapshots.slice(1).map(s=>s.exists()&&s.data().requestId?s.data().candidateNo:0);
      candidate=provisionalPokemonFor(id,rid,otherReserved);
      // 見送り済みドキュメントは再利用する。set(上書き)により以前のreviewedAt/reviewedByを消去し、
      // 新しい申請日時・仮ゲット番号・空き枠に差し替える。Firestore Rulesはrejected→pendingのみ許可。
      tx.set(ref,{childId:id,activityKind:kind,dayIndex:day,status:'pending',requestedBy:uid,requestedAt:dbApi.serverTimestamp(),slotNo:available,candidateNo:candidate});
      tx.set(activitySlotRef(id,day,available),{childId:id,dayIndex:day,slotNo:available,requestId:rid,candidateNo:candidate,updatedAt:dbApi.serverTimestamp()});
      appendAudit(tx,'activity_request',id,oldRequest?'見送り・再挑戦':'未申請','仮ゲット・承認待ち',rid);
    });
    toast(`${pokemonName(candidate)}を仮ゲット！ 保護者の承認で正式ゲットになります。`);
    // 反映はFirestoreのスナップショットを待つ（承認前に正式図鑑へ入れない）。
  });
}
async function reviewActivity(requestId,action){
  if(!isParentPage||!['approve','reject'].includes(action))return;
  const req=model.activityRequests.find(r=>r.requestId===requestId);
  if(!req||req.status!=='pending')return;
  if(action==='approve'&&rewardSuspended(model.profiles[req.childId]))return toast('ポケモン獲得停止中です。停止が終わってから承認してください。');
  const label=`${playerLabel(req.childId)}の${ACTIVITY_KINDS[req.activityKind]||req.activityKind}`;
  if(action==='approve'&&req.activityKind===UPSTAIRS_ACTIVITY_ID&&!confirm('21時までに実際に2階に上がったことを確認しましたか？'))return;
  if(!confirm(`${label}を${action==='approve'?'承認して仮ゲットを正式獲得にし':'見送りにし、仮ゲットを取り消し'}ますか？`))return;
  await runLocked(async()=>{
    const requestRef=dbApi.doc(db,'households',householdId,'activityRequests',requestId),rewardRef=activityRewardRef(requestId);
    const doc=await dbApi.runTransaction(db,async tx=>{
      const snap=await tx.get(requestRef),oldReward=await tx.get(rewardRef);
      if(!snap.exists()||snap.data().status!=='pending'||oldReward.exists())throw Error('この申請はすでに処理されています。');
      const d=snap.data(),hasSlot=Number.isInteger(d.slotNo)&&d.slotNo>=1&&d.slotNo<=3;
      const slotRef=hasSlot?activitySlotRef(d.childId,d.dayIndex,d.slotNo):null;
      const slotSnap=slotRef?await tx.get(slotRef):null;
      if(hasSlot&&(!slotSnap.exists()||slotSnap.data().requestId!==requestId))throw Error('申請枠の状態が不一致です。');
      tx.update(requestRef,{status:action==='approve'?'approved':'rejected',reviewedAt:dbApi.serverTimestamp(),reviewedBy:uid});
      if(action==='approve'){
        const fixed=Number.isInteger(d.candidateNo)&&d.candidateNo>=1&&d.candidateNo<=POKEDEX_TOTAL;
        tx.set(rewardRef,{childId:d.childId,dayIndex:d.dayIndex,kind:'activity',activityKind:d.activityKind,
          sourceRequestId:requestId,sessionId:'',claimedBy:uid,claimedAt:dbApi.serverTimestamp(),catalogVersion:fixed?3:2,
          ...(fixed?{pokemonNo:d.candidateNo}:{})});
      }else if(hasSlot){
        tx.update(slotRef,{requestId:'',candidateNo:0,updatedAt:dbApi.serverTimestamp()});
      }
      appendAudit(tx,action==='approve'?'activity_approve':'activity_reject',d.childId,'仮ゲット・申請中',action==='approve'?'正式獲得':'見送り・仮ゲット取消',requestId);
      return {...d,rewardId:`activity_${requestId}`,catalogVersion:Number.isInteger(d.candidateNo)?3:2,pokemonNo:d.candidateNo,kind:'activity',claimedAt:{toMillis:()=>Date.now()}};
    });
    if(action==='approve'){
      const no=assignedPokemon(doc.childId,[doc]).get(doc.rewardId);
      toast(`${label}を承認しました。${pokemonName(no)}を正式ゲット！`);
    }else toast(`${label}を見送りにしました。仮ゲットは取り消しました。`);
  });
}
// v3.11.2 事実確認は必ず保護者。未確認のズル判定や子どもからの報酬削除はしない。
let honestyPendingChild=null;
const CHEAT_RESET_WINDOW=30*DAY;
function recentCheatCount(p,now=Date.now()){
  return Number(p?.cheatLastAt||0)>0 && now-Number(p.cheatLastAt)<=CHEAT_RESET_WINDOW
    ?Math.max(0,Number(p.cheatStrikeCount)||0):0;
}
function lastCorrectableSession(id){
  const p=model.profiles[id];
  if(!p||p.activeStart!==0||videoStartedMillis(p)>0||!p.lastSessionId)return null;
  return model.sessions.find(s=>s.childId===id&&s.sid===p.lastSessionId&&s.activityType!=='video')||null;
}
function preciseDateInput(t){
  const d=new Date(t);
  return `${dateKey(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function renderHonestyAdmin(){
  const node=$('honesty-admin-list');if(!node||!isParentPage)return;
  if(!model.ready){node.innerHTML='<p class="empty">記録を読み込み中…</p>';return;}
  node.innerHTML=displayIds().map(id=>{
    const p=model.profiles[id],s=lastCorrectableSession(id),blocked=rewardSuspended(p);
    const previous=Number(p.cheatStrikeCount)||0;
    const count=recentCheatCount(p);
    const canApply=!!s&&s.edited!==true&&Number.isFinite(s.end)&&s.end<=Date.now()&&canOperate();
    const canRestore=!!s&&p.cheatLastSessionId===s.sid && !!p.cheatPenaltyPrevious;
    const note=!s?'最後のゲーム終了履歴がありません。':
      `最後の終了申告：${dateTime(s.end)} ／ ${brief(s.duration)}${s.edited?'（確認・修正済み）':''}`;
    return `<div class="honesty-person"><div class="honesty-person-info"><strong>${safe(playerLabel(id))}</strong>`+
      `<small>${safe(note)}</small><small>直近30日以内の確認件数：${count}回${previous!==count?'（カウント期間外はリセット）':''}`+
      `${blocked?` ／ 新規獲得停止：${safe(dateTime(Number(p.rewardSuspendedUntil)))}まで`:''}</small></div>`+
      `<div class="honesty-person-actions"><button type="button" class="btn outline" data-honesty-open="${id}" ${busy||!canApply?'disabled':''}>終了申告を確認・修正</button>`+
      `${canRestore?`<button type="button" class="btn secondary" data-honesty-restore="${id}" ${busy||!canOperate()?'disabled':''}>直前の判定を解除</button>`:''}</div></div>`;
  }).join('');
}
function updateHonestyImpact(){
  const el=$('honesty-impact');if(!el)return;
  const id=honestyPendingChild,p=model.profiles[id];
  if(!p)return;
  const cheating=$('honesty-kind').value==='cheat';
  const repeat=recentCheatCount(p)+1>=2;
  el.textContent=cheating?
    `このゲームのごほうびは無効。${repeat?'確認が2回目以降のため、新しいポケモンの獲得を24時間停止します。':'今回が初回なので24時間停止はしません。'}`:
    '自分から正直に申告した場合は、休憩時間の修正だけ行います。新しいペナルティはありません。';
}
function openHonestyDialog(id){
  if(!isParentPage||!ids.includes(id)||!canOperate())return;
  const s=lastCorrectableSession(id);
  if(!s||s.edited||s.end>=Date.now())return toast('修正対象の最新ゲーム終了記録がありません。');
  honestyPendingChild=id;
  $('honesty-title').textContent=`${playerLabel(id)}：終了申告の確認`;
  $('honesty-last-info').textContent=`アプリ上の終了：${dateTime(s.end)}。実際にSwitchを止めてから、正しい終了時刻を入力してください。`;
  $('honesty-actual-end').value=preciseDateInput(Date.now());
  $('honesty-actual-end').min=preciseDateInput(s.end+1000);
  $('honesty-actual-end').max=preciseDateInput(Date.now()+30000);
  $('honesty-kind').value='cheat';$('honesty-verified').checked=false;
  updateHonestyImpact();$('honesty-dialog').showModal();
}
async function saveHonestyCorrection(event){
  event.preventDefault();
  const id=honestyPendingChild,actual=new Date($('honesty-actual-end').value).getTime(),kind=$('honesty-kind').value;
  if(!isParentPage||!ids.includes(id)||!['cheat','honest'].includes(kind)||!$('honesty-verified').checked)return;
  if(!Number.isFinite(actual))return toast('実際の終了時刻を確認してください。');
  const message=kind==='cheat'?'ズルを確認した内容で、今回の報酬を無効にします。':'正直な申告として休憩時間だけ修正します。';
  if(!confirm(`${playerLabel(id)}：${message}\nこの操作を確定しますか？`))return;
  await runLocked(async()=>{
    const result=await dbApi.runTransaction(db,async tx=>{
      const profRef=refProfile(id),pSnap=await tx.get(profRef);
      if(!pSnap.exists())throw Error('プロフィールがありません。');
      const p=pSnap.data(),sid=p.lastSessionId;
      if(p.activeStart!==0||videoStartedMillis(p)>0||!sid)throw Error('終了申告後の最新ゲーム記録だけ確認できます。');
      const sessionRef=dbApi.doc(sessionsRef(),sid),sSnap=await tx.get(sessionRef);
      if(!sSnap.exists())throw Error('終了履歴を取得できません。');
      const s=sSnap.data(),now=Date.now();
      if(s.childId!==id||s.activityType==='video'||s.edited===true||!Number.isFinite(s.start)||!Number.isFinite(s.end))
        throw Error('この履歴はすでに修正済みか対象外です。');
      if(actual<s.end+1000||actual>now+30000||actual-s.start>7*DAY)
        throw Error('実際の終了は、申告より後の日時、かつ現在時刻以前を入力してください。');
      const duration=actual-s.start,until=actual+duration;
      if(duration<=0)throw Error('終了時刻が開始時刻より前です。');
      const gameRewardId=p.rewardLastSessionId===sid && Number.isInteger(p.rewardLastDayIndex)
        ?rewardDocumentId(id,p.rewardLastDayIndex):'';
      const gameRewardRef=gameRewardId?dbApi.doc(db,'households',householdId,'rewards',gameRewardId):null;
      const gameRewardSnap=gameRewardRef?await tx.get(gameRewardRef):null;
      const canRevoke=kind==='cheat'&&gameRewardSnap?.exists()&&gameRewardSnap.data().kind==='rest_completed'
        && gameRewardSnap.data().sessionId===sid&&gameRewardSnap.data().revoked!==true;
      const lastCount=recentCheatCount(p,now),nextCount=lastCount+1;
      const suspended=kind==='cheat'&&nextCount>=2;
      const previous={
        restStart:p.restStart||0,restUntil:p.restUntil||0,lastDuration:p.lastDuration||0,
        blockedSessionId:p.rewardBlockedSessionId||'',rewardSuspendedUntil:Number(p.rewardSuspendedUntil)||0,
        cheatStrikeCount:Number(p.cheatStrikeCount)||0,cheatLastAt:Number(p.cheatLastAt)||0,
        cheatLastSessionId:p.cheatLastSessionId||'',
        sessionEnd:s.end,sessionDuration:s.duration,sessionEdited:s.edited===true,
        sessionCorrectionKind:s.correctionKind||'',revokedRewardId:canRevoke?gameRewardId:''
      };
      tx.update(sessionRef,{end:actual,duration,edited:true,correctionKind:kind,updatedAt:dbApi.serverTimestamp()});
      const updates={restStart:actual,restUntil:until,lastDuration:duration,updatedAt:dbApi.serverTimestamp()};
      if(kind==='cheat'){
        Object.assign(updates,{
          rewardBlockedSessionId:sid,
          rewardSuspendedUntil:suspended?Math.max(Number(p.rewardSuspendedUntil)||0,now+DAY):Number(p.rewardSuspendedUntil)||0,
          cheatStrikeCount:nextCount,cheatLastAt:now,cheatLastSessionId:sid,
          cheatPenaltyPrevious:previous
        });
      }
      tx.update(profRef,updates);
      if(canRevoke)tx.update(gameRewardRef,{revoked:true,revokedAt:dbApi.serverTimestamp(),revokedBy:uid});
      appendAudit(tx,kind==='cheat'?'cheat_confirm':'cheat_honest',id,
        `終了申告 ${dateTime(s.end)}`,`実終了 ${dateTime(actual)}、${kind==='cheat'?(suspended?'獲得24時間停止':'今回の報酬無効'):'自己申告・休憩のみ修正'}`,sid);
      return {suspended,revoked:canRevoke,kind};
    });
    $('honesty-dialog').close();honestyPendingChild=null;
    toast(result.kind==='honest'?'正直な申告として休憩時間を修正しました。':
      result.suspended?'休憩を修正し、新しいポケモンを24時間停止しました。':'休憩を修正し、このゲームの報酬を無効にしました。');
  });
}
async function restoreHonestyDecision(id){
  if(!isParentPage||!ids.includes(id)||!canOperate())return;
  const p=model.profiles[id];
  if(!p?.cheatPenaltyPrevious||!p.cheatLastSessionId||p.cheatLastSessionId!==p.lastSessionId)return;
  if(!confirm(`${playerLabel(id)}の直前のズル判定・休憩修正を取り消しますか？\n最新のゲーム履歴が変わっていない場合に限ります。`))return;
  await runLocked(async()=>{
    await dbApi.runTransaction(db,async tx=>{
      const profRef=refProfile(id),pSnap=await tx.get(profRef);
      if(!pSnap.exists())throw Error('プロフィールがありません。');
      const current=pSnap.data(),prev=current.cheatPenaltyPrevious,sid=current.cheatLastSessionId;
      if(!prev||sid!==current.lastSessionId||current.activeStart!==0||videoStartedMillis(current)>0)
        throw Error('最新の記録が変わったため、自動解除できません。');
      const sessionRef=dbApi.doc(sessionsRef(),sid),sSnap=await tx.get(sessionRef);
      if(!sSnap.exists()||sSnap.data().correctionKind!=='cheat')throw Error('解除対象のズル判定が見つかりません。');
      const rewardRefToRestore=prev.revokedRewardId?dbApi.doc(db,'households',householdId,'rewards',prev.revokedRewardId):null;
      const rewardSnap=rewardRefToRestore?await tx.get(rewardRefToRestore):null;
      if(rewardRefToRestore&&(!rewardSnap?.exists()||rewardSnap.data().revoked!==true))
        throw Error('獲得履歴が変わっているため自動解除できません。');
      const sessionPatch={end:prev.sessionEnd,duration:prev.sessionDuration,edited:prev.sessionEdited,updatedAt:dbApi.serverTimestamp(),
        correctionKind:prev.sessionCorrectionKind||dbApi.deleteField()};
      tx.update(sessionRef,sessionPatch);
      tx.update(profRef,{
        restStart:prev.restStart,restUntil:prev.restUntil,lastDuration:prev.lastDuration,
        rewardBlockedSessionId:prev.blockedSessionId,rewardSuspendedUntil:prev.rewardSuspendedUntil,
        cheatStrikeCount:prev.cheatStrikeCount,cheatLastAt:prev.cheatLastAt,cheatLastSessionId:prev.cheatLastSessionId,
        cheatPenaltyPrevious:dbApi.deleteField(),updatedAt:dbApi.serverTimestamp()
      });
      if(rewardRefToRestore)tx.update(rewardRefToRestore,{revoked:false,restoredAt:dbApi.serverTimestamp(),restoredBy:uid});
      appendAudit(tx,'cheat_restore',id,'直前のズル判定','誤判定を解除・元の記録に復元',sid);
    });
    toast(`${playerLabel(id)}の直前の判定を解除しました。`);
  });
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
// v3.8: 動画視聴も画面利用時間として履歴に保存し、終了時に同時間の休憩を設定。
// iPadでYouTubeを開いている間のお知らせは、別途iPad標準の「タイマーを開始」ショートカットを使用する。
const VIDEO_SHORTCUT_NAME = 'あそぶやすむ動画タイマー';
function videoStartedMillis(p){const ms=stampMillis(p?.videoStartedAt);return ms>0?Math.floor(ms):0;}
function videoLimitOf(p){const n=Number(p?.videoDurationMinutes);return Number.isInteger(n)&&n>=1&&n<=240?n:30;}
function videoDueMillis(p){const start=videoStartedMillis(p);return start?start+videoLimitOf(p)*MIN:0;}
function videoShortcutUrl(minutes){
  const n=Math.max(1,Math.min(240,Math.floor(Number(minutes)||30)));
  return `shortcuts://run-shortcut?name=${encodeURIComponent(VIDEO_SHORTCUT_NAME)}&input=text&text=${encodeURIComponent(String(n))}`;
}
function renderVideoAction(id,p,now=Date.now()){
  const start=videoStartedMillis(p),minutes=videoLimitOf(p),due=videoDueMillis(p),active=!!start;
  const junior=!isParentPage&&ageModeForChild(id,now)==='junior';
  if(!active){
    if(isParentPage)return '';
    return `<div class="video-box"><div class="video-head">${junior?'📺 どうがを みる':'📺 動画を見る'} <small>${junior?'おしらせ':'お知らせ'}：${Number(model.settings.videoLimitMinutes)||30}分</small></div>`+
      (isParentPage?'<p class="video-note">動画も利用時間に加算。終了後は同じ長さだけ休みます。</p>':
       `<button type="button" class="btn video-start" data-video-start="${id}" ${p.activeStart>0||waitingRemaining(p,now)>0||busy||!canOperate()?'disabled':''}>${junior?'▶️ どうがを みる':'▶️ 動画を見る'}</button>`)+
      '</div>';
  }
  const remaining=Math.max(0,due-now),overdue=now>=due;
  const label=overdue?'時間になったよ！':`あと ${hms(remaining)}`;
  const nativeAction=!isParentPage&&!overdue?`<a class="btn video-shortcut" href="${safe(videoShortcutUrl(Math.max(1,Math.ceil(remaining/MIN))))}" aria-label="iPadの標準タイマーを残り${Math.max(1,Math.ceil(remaining/MIN))}分で設定する">🔔 iPadの通知タイマーをセット</a>`:'';
  const stopAction=!isParentPage?`<button type="button" class="btn outline video-stop" data-video-stop="${id}" ${busy||!canOperate()?'disabled':''}>${junior?'⏹️ どうがを やめたよ':'⏹️ 動画をおわる'}</button>`:'';
  return `<div class="video-box ${overdue?'video-overdue':''}"><div class="video-head">${junior?'📺 どうがを みているよ':'📺 動画を見ているよ'} <small>${minutes}分の${junior?'おしらせ':'お知らせ'}</small></div>`+
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
    if(waitingRemaining(p,Date.now())>0)throw Error('まだ休憩中です。動画を見る前に休憩を終えてください。');
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
  const ref=refProfile(id),sidRef=dbApi.doc(sessionsRef());
  const duration=await dbApi.runTransaction(db,async tx=>{
    const snap=await tx.get(ref);if(!snap.exists())throw Error('子どものデータが見つかりません。');
    const p=snap.data(),start=videoStartedMillis(p),end=Date.now();
    if(!start)throw Error('動画タイマーは開始されていません。');
    const dur=end-start;
    if(dur<1000)throw Error('開始から1秒以上経過してから終了してください。');
    if(dur>7*DAY)throw Error('動画視聴が7日を超えています。保護者が記録を確認してください。');
    // 既存の休憩が残る特殊なケースでも、待ち時間を短くしない。
    const until=Math.max(Number(p.restUntil)||0,end+dur);
    tx.update(ref,{videoStartedAt:null,videoDurationMinutes:0,endedAt:null,
      restStart:end,restUntil:until,lastDuration:dur,lastSessionId:sidRef.id,updatedAt:dbApi.serverTimestamp()});
    tx.set(sidRef,{childId:id,start,end,duration:dur,activityType:'video',deviceId:'video',
      createdAt:dbApi.serverTimestamp(),createdBy:uid,edited:false});
    appendAudit(tx,'video_stop',id,`${videoLimitOf(p)}分設定・視聴中`,
      `${brief(dur)}視聴／${brief(dur)}の休憩を開始`,sidRef.id);
    return dur;
  });
  toast(`動画を終了しました。${brief(duration)}の休憩を開始します。iPad標準タイマーは必要なら停止してください。`);
});}

function renderPlayers(now=Date.now()){
  if(!model.ready)return;
  const keepOpen=new Set([...$('players').querySelectorAll('details[data-player-tools][open]')].map(el=>el.dataset.playerTools));
  $('players').innerHTML=displayIds().map((id,i)=>{
    const p=model.profiles[id]||playerBase(id),st=status(p,now),elapsed=gameDuration(p,now),until=restEnd(p);
    const junior=!isParentPage&&ageModeFor(p,now)==='junior';
    const manualControlling=(p.manualRestUntil||0)>Math.max(normalRestEnd(p),now);
    const restStart=manualControlling?(p.manualRestSetAt?.toMillis?.()||now):(p.restStart||now);
    const restDuration=Math.max(1,manualControlling ? (p.manualRestMinutes||1)*MIN : (p.lastDuration||1));
    const title=st==='playing'?'ゲーム中':st==='watching'?'動画視聴中':st==='resting'?'休憩中':'利用OK';
    const juniorTitle=st==='playing'?'🎮 あそんでる':st==='watching'?'📺 どうがちゅう':st==='resting'?'💤 おやすみ':'✨ あそべるよ';
    const mainTitle=st==='playing'?'ゲームをはじめてから':st==='watching'?'動画を見はじめてから':st==='resting'?'つぎまで、あと':'ゲームも動画もできるよ！';
    const sub=st==='playing'?'じぶんで終わる時間をきめよう':st==='watching'?'動画を終えたら、同じ時間休もう':st==='resting'?`${dateTime(until)}から遊べる${manualControlling?'（手動設定）':''}`:'じぶんのタイミングでスタート！';
    const detail=st==='playing'?`いま終わると ${brief(elapsed)} 休憩 ／ 次は ${dateTime(advanceEligible(now,elapsed))}から`:
      st==='watching'?`いま終わると ${brief(Math.max(0,now-videoStartedMillis(p)))} の休憩が必要`:
      st==='resting'?(manualControlling?'手動で設定した待ち時間だよ':`${brief(p.lastDuration)} 利用したので、同じだけ休憩中`):(p.lastDuration>0?'前の休憩はおわったよ':'最初のゲームをはじめよう');
    const juniorMainTitle=st==='playing'?'あそんでいる じかん':st==='watching'?'どうがを みている じかん':st==='resting'?'あと これだけ おやすみ':'いまは あそべるよ！';
    const juniorSub=st==='playing'?'おわる ときは、ゲームも とめよう':st==='watching'?'どうがを おわったら おやすみ':st==='resting'?'おわったら また あそべるよ':'じぶんで じかんを まもろう！';
    const juniorDetail=st==='playing'?`いま やめたら ${brief(elapsed)} おやすみ`:
      st==='watching'?`いま やめたら ${brief(Math.max(0,now-videoStartedMillis(p)))} おやすみ`:
      st==='resting'?`あと ${brief(waitingRemaining(p,now))} おやすみ`:'ゲームを はじめられるよ！';
    const progress=st==='resting'?Math.min(100,Math.max(0,eligibleElapsed(restStart,now,manualControlling && restStart < (pausePolicy()?.enabledAt||0) ? null : pausePolicy(),nightResumeMillis(p),Number(p.nightResumeWindowEnd)||0)/restDuration*100)):100;
    const actionText=junior?(st==='playing'?'🛑 ゲームを やめたよ':st==='watching'?'📺 どうがを みているよ':st==='resting'?'💤 いまは おやすみ':'▶️ ゲームを はじめる'):(st==='playing'?'🛑 ゲームをおわる':st==='watching'?'🎬 動画を視聴中':st==='resting'?'💤 おやすみ中':'▶️ ゲームをはじめる');
    const actions=isParentPage?'':`<button class="action ${st==='playing'?'stop':''}" data-action="${st==='playing'?'end':'start'}" data-child="${id}" ${st==='resting'||st==='watching'||busy||!canOperate()?'disabled':''}>${actionText}</button>`;
    const recordTime=p.manualRestSetAt?.toMillis?.()||0;
    const recordText=recordTime?`最後の手動操作：${p.manualRestSetRole==='parent'?'保護者':'子ども用画面'}・${dateTime(recordTime)}・${p.manualRestUntil>0?`${p.manualRestMinutes||0}分の設定`:'解除'}`:'手動待ち時間の設定履歴なし';
    const manualAction=`<button class="btn outline manual-open" data-manual="${id}" ${p.activeStart>0||videoStartedMillis(p)>0||busy||!canOperate()?'disabled':''}>⏳ 待ち時間を手動で設定</button>`;
    const earlyPossible=canEarlyResume(p,now);
    const nightAction=!isParentPage&&earlyPossible
      ? `<button class="btn early-resume-action" data-night-resume="${id}" ${busy||!canOperate()||!hasNightResumeRuleConfig()?'disabled':''}>☀️ いまから休憩の消化を再開</button><p class="early-resume-hint">夜間の停止だけを解除。残りの休憩時間はそのまま守ろう。</p>${!hasNightResumeRuleConfig()?'<p class="early-resume-hint">保護者画面で夜間停止設定を一度保存してください。</p>':''}`
      : (!isParentPage&&resumedThisNight(p,now)&&waitingRemaining(p,now)>0?'<p class="early-resume-hint early-active">☀️ 今夜は休憩時間を消化中</p>':'');
    const videoAction=renderVideoAction(id,p,now);
    const undo=undoKind(p,now);
    const undoAction=undo?`<button class="btn outline undo-action" data-undo="${id}" ${busy||!canOperate()?'disabled':''}>↩️ まちがえた！ あと${Math.max(1,Math.ceil((30000-(now-stampMillis(undo==='start'?p.startedAt:p.endedAt)))/1000))}秒</button>`:'';
    const correction=isParentPage&&st==='playing'&&!!$('correct-dialog')?`<button class="btn outline correction-action" data-correct="${id}" ${busy||!canOperate()?'disabled':''}>終了忘れを修正</button>`:'';
    const pokemonReward=rewardActionFor(id,now);
    const carry=nightCarryoverInfo(p,now);
    const carryBadge=carry?`<div class="night-carryover-badge night-carryover-${carry.phase}" role="status">${safe(carry.message)}</div>`:'';
    const penaltyBanner=rewardSuspended(p,now)?`<p class="penalty-notice" role="status">⚠️ ${safe(rewardSuspensionText(p,now))}。まえに ゲットした ポケモンは なくならないよ。</p>`:'';
    const today=todayTotal(id,now),count=model.sessions.filter(s=>s.childId===id&&s.end>=dayStart(now)).length;
    const gameToday=model.sessions.reduce((sum,s)=>sum+(s.childId===id && s.activityType!=='video'?overlap(s.start,s.end,dayStart(now),addDays(dayStart(now),1)):0),0)+(p.activeStart>0?overlap(p.activeStart,now,dayStart(now),addDays(dayStart(now),1)):0);
    const videoToday=Math.max(0,today-gameToday);
    const age = ageOf(p, now);
    const subtitle = age === null ? '年齢未設定' : `${age}さい`;
    return `<article class="player ${themeFor(p)} ${junior?'age-junior':''} ${!isParentPage&&id===focusChild?'ui-player-focused':''}" data-player-id="${id}" data-age-mode="${junior?'junior':'standard'}"><div class="player-head"><div><div class="player-name"><span class="emoji">${symbolFor(p)}</span>${safe(playerLabel(id))}</div><div class="player-sub">${safe(subtitle)}${junior?' · 🌱 やさしい がめん':''}</div></div><span class="pill ${st}">${junior?juniorTitle:title}</span></div>
      <div class="big-time"><div class="caption">${junior?juniorMainTitle:mainTitle}</div><div class="digits">${hms(summaryFor(p,now))}</div><div class="detail">${safe(junior?juniorSub:sub)}</div></div>
      <div class="progress"><i style="width:${progress.toFixed(1)}%"></i></div><div class="forecast"><strong>${junior?'⏰ じかんの おやくそく':st==='playing'?'⏰ いま終わったら':st==='watching'?'📺 いま終わったら':st==='resting'?'⌛ 前の利用時間':'✨ じぶんでじかんを決めよう'}</strong><div class="forecast-line">${safe(junior?juniorDetail:detail)}</div>${!junior&&st==='playing'?'<small>あと5分あそぶと、休憩時間も5分増えるよ</small>':''}</div>
      <div class="player-primary-actions">${actions}${videoAction}</div>${carryBadge}${undoAction}${penaltyBanner}${pokemonReward}
      <details class="player-tools" data-player-tools="${id}" ${keepOpen.has(id)?'open':''}>
        <summary>⏳ 待ち時間の調整・その他の操作</summary>
        <div class="player-tools-content">${manualAction}${nightAction}${correction}<div class="manual-info">${safe(recordText)}${p.manualRestUntil>now?`<strong>手動設定の残り：${brief(manualWaitRemaining(p,now))}</strong>`:''}</div></div>
      </details><div class="mini screen-summary"><div>今日の合計<strong>${brief(today)}</strong></div><div>ゲーム<strong>${brief(gameToday)}</strong></div><div>動画<strong>${brief(videoToday)}</strong></div><div>今日の終了<strong>${count}回</strong></div></div></article>`;
  }).join('');
}
function weekData(now=Date.now()){
  const today=dayStart(now),days=Array.from({length:7},(_,i)=>addDays(today,i-6));
  const totals=days.map(d=>displayIds().map(id=>{
    const end=addDays(d,1);let sum=model.sessions.reduce((a,s)=>a+(s.childId===id?overlap(s.start,s.end,d,end):0),0);
    const p=model.profiles[id];if(p?.activeStart>0)sum+=overlap(p.activeStart,now,d,end);
    const vs=videoStartedMillis(p);if(vs>0)sum+=overlap(vs,now,d,end);return sum;
  }));return {days,totals};
}
function renderWeek(){if(!$('week-chart'))return;const {days,totals}=weekData();const max=Math.max(15*MIN,...totals.flat());
  const ordered = displayIds();
  $('week-chart').innerHTML=`<div class="chart-legend">${ordered.map(id=>`<span><i class="dot ${themeFor(model.profiles[id])}"></i>${safe(playerLabel(id))}</span>`).join('')}</div>` + days.map((d,i)=>{
    const label=new Date(d).toLocaleDateString('ja-JP',{month:'numeric',day:'numeric',weekday:'short'}),t=totals[i];
    return `<div class="week-row"><div class="week-label">${label}</div><div class="week-bars">${t.map((v,j)=>`<div class="track"><div class="fill ${themeFor(model.profiles[ordered[j]])}" style="width:${(v/max*100).toFixed(1)}%"></div></div>`).join('')}</div><div class="week-total">${brief(t[0]+t[1])}</div></div>`;
  }).join('');
}
function daySessions(){const start=selectedDay,end=addDays(start,1);const arr=[...model.sessions];const now=Date.now();for(const id of ids){const p=model.profiles[id];if(p?.activeStart>0)arr.push({sid:'active-'+id,childId:id,start:p.activeStart,end:now,duration:now-p.activeStart,deviceId:p.deviceId,ongoing:true});
  const vs=videoStartedMillis(p);if(vs>0)arr.push({sid:'video-active-'+id,childId:id,start:vs,end:now,duration:now-vs,activityType:'video',ongoing:true});}
  if(model.historyExtra && model.historyExtra.day===selectedDay){for(const s of model.historyExtra.items){if(!arr.some(x=>x.sid===s.sid))arr.push(s);}}
  return arr.filter(s=>overlap(s.start,s.end,start,end)>0).sort((a,b)=>b.start-a.start);
}
function renderHistory(){const target=$('history-list');if(!target)return;const sessions=daySessions(),start=selectedDay,end=addDays(start,1);
 $('history-date').value=dateKey(start);
 const frac=t=>Math.min(100,Math.max(0,(t-start)/(end-start)*100));
 const lines=displayIds().map((id,i)=>{const segs=sessions.filter(s=>s.childId===id).map(s=>`<i class="tseg ${themeFor(model.profiles[id])}" title="${safe(dateTime(s.start))}〜${safe(dateTime(s.end))}" style="left:${frac(s.start).toFixed(2)}%;width:${Math.max(.1,frac(s.end)-frac(s.start)).toFixed(2)}%"></i>`).join('');return `<div class="tlrow"><span>${safe(playerLabel(id))}</span><div class="tlbar">${segs}</div></div>`;}).join('');
 $('timeline').innerHTML=`<div class="tlaxis"><span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>24時</span></div><div class="timeline-people">${lines}</div>`;
 target.innerHTML=sessions.length?sessions.map(s=>`<div class="history-entry"><div><strong>${s.activityType==='video'?'📺 動画':'🎮 ゲーム'} · ${safe(playerLabel(s.childId))}</strong><small>${dateTime(s.start)} 〜 ${s.ongoing?'現在':dateTime(s.end)} ${s.edited?'（修正済み）':''}</small></div><div class="right-entry"><strong>${brief(s.duration)}</strong>${isParentPage&&!s.ongoing?`<button class="btn outline" data-edit="${safe(s.sid)}">修正</button>`:''}</div></div>`).join(''):'<div class="empty">この日はまだゲームのきろくがありません</div>';
}
// v3.12.0 UI navigation: changing tabs never mutates rewards, sessions or Firestore.
const KID_VIEWS=['time','challenge','pokemon','more'];
const PARENT_VIEWS=['home','actions','reports','more'];
const VIEW_CAPTIONS={time:'ゲームも どうがも じぶんで じかんを まもろう',challenge:'きょう できたことを おくってみよう',pokemon:'ポケモンを あつめて マイチームを つくろう',more:'きろくと おしらせを かくにんしよう'};
function revealNavigation(){
  const nav=$(isParentPage?'parent-primary-nav':'kid-primary-nav');
  if(nav&&typeof nav.scrollIntoView==='function')nav.scrollIntoView({behavior:'auto',block:'start'});
}
function setKidView(view,scroll=true){
  if(isParentPage||!KID_VIEWS.includes(view))return;
  kidView=view;historyTab=view==='more'?'history':'home';
  for(const v of KID_VIEWS)$('kid-pane-'+v)?.classList.toggle('hidden',v!==view);
  document.querySelectorAll('[data-kid-view]').forEach(button=>{
    const active=button.dataset.kidView===view;
    button.classList.toggle('is-active',active);
    button.setAttribute('aria-current',active?'page':'false');
  });
  const caption=$('kid-view-caption');if(caption)caption.textContent=VIEW_CAPTIONS[view];
  if(view==='more'&&model.ready){renderWeek();renderHistory();}
  if(scroll)revealNavigation();
}
function setParentView(view,scroll=true,targetId=''){
  if(!isParentPage||!PARENT_VIEWS.includes(view))return;
  parentView=view;
  for(const v of PARENT_VIEWS)$('parent-pane-'+v)?.classList.toggle('hidden',v!==view);
  document.querySelectorAll('[data-parent-view]').forEach(button=>{
    if(!button.classList.contains('ui-nav-button'))return;
    const active=button.dataset.parentView===view;
    button.classList.toggle('is-active',active);
    button.setAttribute('aria-current',active?'page':'false');
  });
  if(view==='reports'&&model.ready){renderWeek();renderHistory();}
  if(view==='home')renderParentDashboard();
  if(scroll){
    if(targetId){const target=$(targetId);if(target){const details=target.closest('details');if(details)details.open=true;target.scrollIntoView({behavior:'auto',block:'start'});}else revealNavigation();}
    else revealNavigation();
  }
}
function setFocusChild(id,syncApprovals=true){
  if(!ids.includes(id))return;
  if((isParentPage?parentFocusChild:focusChild)!==id&&$('team-picker')?.open){ // A picker must not silently switch to the other child's Pokémon.
    $('team-picker').close();editingTeamSlot=null;
  }
  if(isParentPage)parentFocusChild=id;else focusChild=id;
  favoriteTeamChild=id;effortCalendarChild=id;
  for(const selectId of ['team-child','effort-calendar-child','pokedex-child','parent-focus-child']){
    const el=$(selectId);if(!el)continue;
    for(const option of el.options)if(ids.includes(option.value))option.textContent=playerLabel(option.value);
    el.value=id;
  }
  const heading=$('kid-focus-name');if(heading)heading.textContent=`${playerLabel(id)}の チャレンジと ポケモン`;
  if(!isParentPage)document.querySelectorAll('#players [data-player-id]').forEach(card=>card.classList.toggle('ui-player-focused',card.dataset.playerId===id));
  document.querySelectorAll('[data-focus-child]').forEach(button=>{
    button.textContent=playerLabel(button.dataset.focusChild);
    button.setAttribute('aria-pressed',String(button.dataset.focusChild===id));
  });
  // Parent approvals default to all; switching the global child selector sets a focused filter.
  if(isParentPage){if(syncApprovals)approvalFilter=id;renderApprovals();}
  renderActivities();renderBonuses();renderFavoriteTeam();renderEffortCalendar();renderPokedex();renderKidSpotlight();
}
function renderKidSpotlight(){
  const box=$('kid-spotlight-message');if(!box||!model.ready)return;
  const id=focusChild,p=model.profiles[id];
  if(!model.bonusLoaded||!model.rewardsLoaded){box.textContent='ポケモンのごほうびを かくにん中…';return;}
  const count=availableBonusGrants(id).length;
  const waiting=model.activityRequests.filter(x=>x.childId===id&&x.status==='pending').length;
  const result=claimEligibility(id);
  const pieces=[];
  if(count)pieces.push(`とくべつボーナス ${count}ひき`);
  if(result.ok)pieces.push('ゲームのポケモンを ゲットできるよ');
  if(waiting)pieces.push(`チャレンジ ${waiting}けん かくにんまち`);
  box.textContent=pieces.length?pieces.join('　・　'):'きょうも じぶんのペースで たのしもう！';
}
function renderParentDashboard(now=Date.now()){
  if(!isParentPage||!$('parent-dashboard-cards'))return;
  const container=$('parent-dashboard-cards');
  const pending=model.activityRequests.filter(a=>a.status==='pending');
  const stale=pending.filter(a=>stampMillis(a.requestedAt)>0&&now-stampMillis(a.requestedAt)>=DAY).length;
  const total=pending.length;
  $('parent-action-summary').textContent=!model.activityLoaded?'チャレンジの申請状況を確認中…':total?`チャレンジの承認待ち ${total}件${stale?`（24時間以上 ${stale}件）`:''}`:'今のところ承認待ちはありません';
  $('dashboard-sync-status').textContent=canOperate()?'クラウド確認済み':'通信・同期を確認中';
  if(!model.ready){container.innerHTML='<p class="empty">家族の情報を読み込み中…</p>';return;}
  container.innerHTML=ids.map(id=>{
    const p=model.profiles[id]||playerBase(id),st=status(p,now);
    const names={playing:'ゲーム中',watching:'動画中',resting:'休憩中',ready:'あそべる'};
    const state=names[st]||'確認中';
    const detail=st==='resting'?`残り ${brief(waitingRemaining(p,now))}`:st==='playing'?`開始から ${brief(gameDuration(p,now))}`:st==='watching'?`開始から ${brief(now-videoStartedMillis(p))}`:'ゲーム・動画を開始できます';
    const carry=nightCarryoverInfo(p,now);
    return `<article class="ui-person-summary ${id}"><strong>${safe(playerLabel(id))}</strong><span class="ui-person-state ${st}">${state}</span><small>${safe(detail)}</small>${carry?`<small class="night-carryover-summary">${safe(carry.message)}</small>`:''}<small>今日の合計 ${brief(todayTotal(id,now))}</small></article>`;
  }).join('');
}
function playerLayoutSignature(now=Date.now()){
  if(!model.ready)return '';
  return JSON.stringify({online:canOperate(),busy,day:rewardDayIndex(now),kids:ids.map(id=>{
    const p=model.profiles[id]||{};
    return [id,status(p,now),ageModeFor(p,now),p.activeStart,videoStartedMillis(p),videoDueMillis(p)<=now,
      p.restUntil,p.restStart,p.lastDuration,p.manualRestUntil,p.manualRestMinutes,
      p.lastSessionId,p.rewardLastDayIndex,p.rewardBlockedSessionId,p.rewardLastSessionId,
      p.rewardSuspendedUntil,stampMillis(p.updatedAt),
      undoKind(p,now),canEarlyResume(p,now),nightCarryoverInfo(p,now)?.phase||'',claimEligibility(id,now).label];
  })});
}
function updatePlayerTimes(now=Date.now()){
  for(const id of ids){
    const p=model.profiles[id],card=document.querySelector(`[data-player-id="${id}"]`);
    if(!p||!card)continue;
    const st=status(p,now),junior=!isParentPage&&ageModeFor(p,now)==='junior';
    const digits=card.querySelector('.big-time .digits');
    if(digits)digits.textContent=hms(summaryFor(p,now));
    const line=card.querySelector('.forecast-line');
    if(line){
      if(junior){line.textContent=st==='playing'?`いま やめたら ${brief(gameDuration(p,now))} おやすみ`:st==='watching'?`いま やめたら ${brief(now-videoStartedMillis(p))} おやすみ`:st==='resting'?`あと ${brief(waitingRemaining(p,now))} おやすみ`:'ゲームを はじめられるよ！';}
      else{line.textContent=st==='playing'?`いま終わると ${brief(gameDuration(p,now))} 休憩 ／ 次は ${dateTime(advanceEligible(now,gameDuration(p,now)))}から`:st==='watching'?`いま終わると ${brief(now-videoStartedMillis(p))} の休憩が必要`:st==='resting'?((p.manualRestUntil||0)>Math.max(normalRestEnd(p),now)?'手動で設定した待ち時間だよ':`${brief(p.lastDuration)} 利用したので、同じだけ休憩中`):(p.lastDuration>0?'前の休憩はおわったよ':'最初のゲームをはじめよう');}
    }
    const prog=card.querySelector('.progress i');
    if(prog){
      let progress=100;
      if(st==='resting'){
        const manual=(p.manualRestUntil||0)>Math.max(normalRestEnd(p),now);
        const start=manual?(p.manualRestSetAt?.toMillis?.()||now):(p.restStart||now);
        const duration=Math.max(1,manual?(p.manualRestMinutes||1)*MIN:(p.lastDuration||1));
        progress=Math.min(100,Math.max(0,eligibleElapsed(start,now,manual&&start<(pausePolicy()?.enabledAt||0)?null:pausePolicy(),nightResumeMillis(p),Number(p.nightResumeWindowEnd)||0)/duration*100));
      }
      prog.style.width=progress.toFixed(1)+'%';
    }
    const video=card.querySelector('.video-countdown');
    if(video){const remaining=Math.max(0,videoDueMillis(p)-now);video.textContent=remaining>0?`あと ${hms(remaining)}`:'時間になったよ！';}
    const undo=card.querySelector('button.undo-action');
    const kind=undoKind(p,now);
    if(undo&&kind){const sec=Math.max(1,Math.ceil((30000-(now-stampMillis(kind==='start'?p.startedAt:p.endedAt)))/1000));undo.textContent=`↩️ まちがえた！ あと${sec}秒`;}
  }
}

function render(now=Date.now()){
  // Timer labels update each second. Big cards and hidden panes are not reconstructed unnecessarily.
  if(isParentPage&&Math.floor(now/1000)%30===0)renderHonestyAdmin();
  renderNightPolicy();renderSync();if(!model.ready)return;
  if(Math.floor(now/1000)%5===0)renderAlerts(now);
  const signature=playerLayoutSignature(now);
  if(signature!==playerRenderSignature||now-playerRenderedAt>=30000||!$('players')?.querySelector('.player')){
    renderPlayers(now);playerRenderSignature=signature;playerRenderedAt=now;
  }
  updatePlayerTimes(now);
  if(isParentPage){
    if(Math.floor(now/1000)%10===0){renderParentDashboard(now);}
    if(parentView==='reports'&&Math.floor(now/1000)%10===0){renderWeek();renderHistory();}
  }else if(kidView==='more'&&Math.floor(now/1000)%10===0){renderWeek();renderHistory();}
  checkRestNotices(now);checkVideoNotices(now);
}
function setReady(){model.ready=ids.every(id=>model.profiles[id]);$('init-panel')?.classList.toggle('hidden',model.ready);render();renderReport();renderPokedex();renderFavoriteTeam();renderActivities();renderApprovals();renderBonuses();renderHonestyAdmin();renderKidSpotlight();renderParentDashboard();if(model.ready){renderWeek();renderHistory();setFocusChild(isParentPage?parentFocusChild:focusChild,false);}}
function showApp(){ $('login-screen').classList.add('hidden');$('app-screen').classList.remove('hidden');if(isParentPage)setParentView(parentView,false);else setKidView(kidView,false);}
function showLogin(){ $('login-screen').classList.remove('hidden');$('app-screen').classList.add('hidden');}
function listenerError(e){
  console.error('Firestore listener',e);
  model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;retryAfterError=true;
  toast('クラウドの接続が切れました。再接続して最新状態を確認してください。');render();
}
function unsubscribeListeners(){cleanups.forEach(fn=>{try{fn();}catch{}});cleanups=[];}
function disconnect(){unsubscribeListeners();model.profiles={};model.sessions=[];model.presence=null;model.ready=false;model.profilesServerConfirmed=false;model.settingsServerConfirmed=false;model.auditLogs=[];model.reportSessions=[];model.reportLoaded=false;model.reportFromCache=true;model.reportTruncated=false;model.rewards=[];model.rewardsLoaded=false;model.rewardsServerConfirmed=false;model.activityRequests=[];model.activityLoaded=false;model.activityServerConfirmed=false;model.bonusGrants=[];model.bonusLoaded=false;model.bonusServerConfirmed=false;previousRest.clear();if($('team-picker')?.open)$('team-picker').close();editingTeamSlot=null;renderFavoriteTeam();renderBonuses();retryAfterError=false;renderReport();}
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
   const profiles={};for(const doc of snap.docs)profiles[doc.id]=doc.data();model.profiles=profiles;model.fromCache=snap.metadata.fromCache;model.profilesServerConfirmed=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites&&navigator.onLine;model.receivedAt=Date.now();setReady();setSettingsForm();renderEffortCalendar();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(dbApi.doc(db,'households',householdId,'settings','main'),{includeMetadataChanges:true},snap=>{
   model.settings=snap.exists()?{...defaultSettings(),...snap.data()}:defaultSettings();
   model.settingsServerConfirmed=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites&&navigator.onLine;model.receivedAt=Date.now();render();setSettingsForm();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(dbApi.collection(db,'households',householdId,'rewards'),{includeMetadataChanges:true},snap=>{
   model.rewards=snap.docs.map(d=>({...d.data(),rewardId:d.id}));
   model.rewardsLoaded=true;model.rewardsServerConfirmed=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites&&navigator.onLine;
   renderPokedex();renderFavoriteTeam();renderPlayers();renderEffortCalendar();renderBonuses();renderKidSpotlight();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(bonusCollection(),{includeMetadataChanges:true},snap=>{
   model.bonusGrants=snap.docs.map(d=>({...d.data(),grantId:d.id}));
   model.bonusLoaded=true;model.bonusServerConfirmed=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites&&navigator.onLine;
   renderBonuses();renderKidSpotlight();
 },listenerError));
 cleanups.push(dbApi.onSnapshot(dbApi.collection(db,'households',householdId,'activityRequests'),{includeMetadataChanges:true},snap=>{
   model.activityRequests=snap.docs.map(d=>({...d.data(),requestId:d.id}));
   model.activityLoaded=true;model.activityServerConfirmed=!snap.metadata.fromCache&&!snap.metadata.hasPendingWrites;
   renderActivities();renderApprovals();renderPokedex();renderEffortCalendar();renderKidSpotlight();renderParentDashboard();
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
async function runLocked(fn){if(busy)return;busy=true;renderBonuses();try{ensureOnline();await fn();}catch(e){console.error(e);toast(errorText(e));}finally{busy=false;renderBonuses();render();}}
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
 $('end-confirm-text').innerHTML=`<div>${safe(playerLabel(id))}が遊んだ時間：<strong>${brief(t)}</strong></div><div>これから休憩：<strong>${brief(t)}</strong></div><div>つぎに遊べるのは：<strong>${dateTime(now+t)}</strong></div>`;$('finish-actually-stopped').checked=false;$('confirm-end').disabled=true;$('end-dialog').showModal();}

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
 if(format==='json'){const auditSnap=await dbApi.getDocs(dbApi.collection(db,'households',householdId,'auditLogs'));const auditLogs=auditSnap.docs.map(d=>({...d.data(),createdAtIso:stampMillis(d.data().createdAt)?new Date(stampMillis(d.data().createdAt)).toISOString():null,logId:d.id}));const rewardsSnap=await dbApi.getDocs(dbApi.collection(db,'households',householdId,'rewards'));const rewards=rewardsSnap.docs.map(d=>({...d.data(),rewardId:d.id,claimedAtIso:stampMillis(d.data().claimedAt)?new Date(stampMillis(d.data().claimedAt)).toISOString():null}));const requestSnap=await dbApi.getDocs(dbApi.collection(db,'households',householdId,'activityRequests'));const activityRequests=requestSnap.docs.map(d=>({...d.data(),requestId:d.id}));const slotSnap=await dbApi.getDocs(dbApi.collection(db,'households',householdId,'activitySlots'));const activitySlots=slotSnap.docs.map(d=>({...d.data(),slotId:d.id}));const bonusSnap=await dbApi.getDocs(bonusCollection());const bonusGrants=bonusSnap.docs.map(d=>({...d.data(),grantId:d.id}));const data={version:4,appVersion:version,exportedAt:new Date().toISOString(),householdId,profiles:model.profiles,settings:model.settings,sessions,auditLogs,rewards,activityRequests,activitySlots,bonusGrants};download(`asobu-yasumu-v3-${dateKey(Date.now())}.json`,new Blob([JSON.stringify(data,(k,v)=>['createdAt','updatedAt'].includes(k)?undefined:v,2)],{type:'application/json'}));}
 else {const csv=v=>{let s=String(v??'');if(/^[=+@\-]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;};const rows=[['子ども','区分','開始日時','終了日時','利用時間(秒)','修正済み'],...sessions.map(s=>[playerLabel(s.childId),s.activityType==='video'?'動画':'ゲーム',new Date(s.start).toLocaleString('ja-JP'),new Date(s.end).toLocaleString('ja-JP'),Math.round(s.duration/1000),s.edited?'はい':'いいえ'])];download(`asobu-yasumu-v3-${dateKey(Date.now())}.csv`,new Blob(['\ufeff'+rows.map(row=>row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));}
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
   if(btn.dataset.focusChild){setFocusChild(btn.dataset.focusChild);return;}
   if(btn.dataset.kidView){setKidView(btn.dataset.kidView);return;}
   if(btn.dataset.parentView){setParentView(btn.dataset.parentView,true,btn.dataset.focusTarget);return;}
   if(btn.dataset.action==='start')chooseStart(btn.dataset.child);
   if(btn.dataset.action==='end')chooseEnd(btn.dataset.child);
   if(btn.dataset.pokemonClaim)claimPokemon(btn.dataset.pokemonClaim);
   if(btn.dataset.teamSlot!==undefined)openTeamPicker(Number(btn.dataset.teamSlot));
   if(btn.dataset.teamPick!==undefined)saveTeamChoice(Number(btn.dataset.teamPick));
   if(btn.dataset.honestyOpen)openHonestyDialog(btn.dataset.honestyOpen);
   if(btn.dataset.honestyRestore)restoreHonestyDecision(btn.dataset.honestyRestore);
   if(btn.dataset.bonusGrant)grantSpecialBonus(btn.dataset.bonusGrant);
   if(btn.dataset.bonusClaim)claimSpecialBonus(btn.dataset.bonusClaim);
   if(btn.dataset.activityRequest){const [id,kind]=btn.dataset.activityRequest.split(':');requestActivity(id,kind);}
   if(btn.dataset.activityReview){const [rid,action]=btn.dataset.activityReview.split(':');reviewActivity(rid,action);}
   if(btn.dataset.effortDay){effortCalendarDay=Number(btn.dataset.effortDay);renderEffortCalendar();}
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
 $('effort-calendar-child')?.addEventListener('change',e=>{if(ids.includes(e.target.value))setFocusChild(e.target.value);});
  $('effort-calendar-prev')?.addEventListener('click',()=>effortCalendarMonthShift(-1));
  $('effort-calendar-next')?.addEventListener('click',()=>effortCalendarMonthShift(1));
  $('approval-filter')?.addEventListener('change',e=>{approvalFilter=e.target.value;if(ids.includes(e.target.value))setFocusChild(e.target.value);else renderApprovals();});
  $('honesty-kind')?.addEventListener('change',updateHonestyImpact);
  $('honesty-form')?.addEventListener('submit',saveHonestyCorrection);
  $('honesty-dialog')?.addEventListener('close',()=>{honestyPendingChild=null;});
  $('team-child')?.addEventListener('change',e=>{if(ids.includes(e.target.value))setFocusChild(e.target.value);});
 $('team-search')?.addEventListener('input',renderTeamPicker);
 $('team-remove')?.addEventListener('click',()=>saveTeamChoice(0));
 $('team-picker')?.addEventListener('close',()=>{editingTeamSlot=null;});
 $('parent-focus-child')?.addEventListener('change',e=>{if(ids.includes(e.target.value))setFocusChild(e.target.value);});
 $('pokedex-child')?.addEventListener('change',e=>{if(ids.includes(e.target.value))setFocusChild(e.target.value);});
 $('pokedex-filter')?.addEventListener('change',renderPokedex);
 $('finish-actually-stopped')?.addEventListener('change',e=>{$('confirm-end').disabled=!e.target.checked;});
 $('confirm-end')?.addEventListener('click',()=>{if(!$('finish-actually-stopped')?.checked)return;pendingEnd&&endPlay(pendingEnd);});
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
 // The old in-page history tab is now the lightweight 'そのほか・きろく' pane.
 if(isParentPage){setParentView(parentView,false);setFocusChild(parentFocusChild,false);}else{setKidView(kidView,false);setFocusChild(focusChild,false);}
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
    // 停止期限が経過したらFirestoreの更新なしでも報酬ボタンを自動で再表示する。
    setInterval(()=>{if(uid&&model.ready){renderBonuses();renderApprovals();renderActivities();}},60000);
    setInterval(()=>{if(uid&&navigator.onLine&&(!model.profilesServerConfirmed||!model.settingsServerConfirmed)&&!reconnecting&&!authCheckBusy)recheckConnection();},15000);
    setInterval(()=>{if(uid&&model.ready&&navigator.onLine&&reportPeriodKey&&reportPeriodKey!==dateKey(Date.now()))subscribeReport();},60000);
    render();
   if('serviceWorker' in navigator && !isParentPage && location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }catch(e){console.error(e);$('setup-warning').textContent='Firebase SDKに接続できません。インターネット接続、ブラウザ設定、設定ファイルを確認してください。 '+errorText(e);$('setup-warning').classList.remove('hidden');}
}
currentDateTick();setInterval(currentDateTick,1000);
startFirebase();

loadExtendedPokemonNames().then(()=>{renderPokedex();renderFavoriteTeam();renderTeamPicker();}).catch(()=>{});
