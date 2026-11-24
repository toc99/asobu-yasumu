// Pure notification planning. Does not mutate play/rest/reward data.
import {effectivePausedMillis} from './pause-timing.js';
import {remainingVideoMs,recordedVideoMillis} from './video-cycle-policy.js';
import {pokemonName} from './pokedex-data.js';
import {EVOLUTION_TARGETS,evolutionStage} from './evolution-data.js';
export const MIN=60000, DAY=86400000, JST=32400000;
export const TYPES=Object.freeze({
 gameStart:'ゲーム開始',gameWarning:'ゲーム終了予告',gameDue:'ゲームのお知らせ時間',videoStart:'動画開始',
 videoWarning:'動画終了予告',videoDue:'動画のお知らせ時間',forgotten:'終了ボタンの確認',
 restStart:'休憩開始',restEnd:'休憩終了',bedtime:'就寝準備',pokemon:'ポケモン獲得・進化',
 activity:'チャレンジ承認',xp:'経験値獲得',level:'レベルアップ',evolveReady:'進化条件達成',
 allDone:'全11チャレンジ達成',generation:'新世代解放'
});
export const defaultConfig=()=>({enabled:false,bridgeUid:'',speaker:'',volume:35,gameMinutes:60,warningMinutes:5,
 forgottenMinutes:5,quietStart:'22:00',quietEnd:'07:00',bedtime:'21:00',
 types:Object.fromEntries(Object.keys(TYPES).map(k=>[k,['gameWarning','gameDue','videoWarning','videoDue','restEnd','forgotten','bedtime','pokemon','level','allDone'].includes(k)]))});
export const MAX_SPEAKERS=5, MAX_DISCOVERED=12;
export const ROUTE_TYPES=Object.freeze({...TYPES,manual:'テスト・手動通知'});
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const speakerIds=value=>{const ids=typeof value==='string'?value.split(','):value;return Array.isArray(ids)?[...new Set(ids.filter(x=>typeof x==='string'&&uuidPattern.test(x)))].slice(0,MAX_SPEAKERS):[];};
export function routeTargets(c,type){
 const defaults=speakerIds(c?.speakerIds),overrides=speakerIds(c?.routes?.[type]);
 const selected=overrides.length?overrides:defaults;
 return selected.length?selected.map(id=>({id,name:''})):c?.speaker?[{id:'',name:c.speaker}]:[];
}
export function knownSpeakers(rows){
 const seen=new Set(),out=[];
 for(const d of Array.isArray(rows)?rows:[]){
  if(!d||typeof d.id!=='string'||!uuidPattern.test(d.id)||seen.has(d.id)||typeof d.name!=='string'||!d.name.trim())continue;
  seen.add(d.id);out.push({id:d.id,name:d.name.trim().slice(0,100),online:d.online===true});
  if(out.length>=MAX_DISCOVERED)break;
 }
 return out;
}
export function deliverySummary(results){
 if(!results.length)return {result:'error',reason:'speaker_not_unique'};
 const sent=results.filter(r=>r.result==='sent').length;
 if(sent===results.length)return {result:'sent'};
 if(sent>0)return {result:'partial'};
 if(results.every(r=>r.result==='skipped'))return {result:'skipped',reason:results[0].reason};
 return {result:'error',reason:results.find(r=>r.result==='error')?.reason||'cast_error'};
}
export const stamp=x=>x?.toMillis?.()||0;
const minute=s=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s||'')?Number(s.slice(0,2))*60+Number(s.slice(3)):null;
const jstDay=t=>Math.floor((t+JST)/DAY)*DAY-JST;
export function quiet(c,t){const start=minute(c.quietStart),end=minute(c.quietEnd),m=(t-jstDay(t))/MIN;
 return start!==null&&end!==null&&start!==end&&(start<end?m>=start&&m<end:m>=start||m<end);}
function policy(s){const n=s?.nightPause||{},start=minute(n.start),end=minute(n.end);
 return n.enabled===true&&start!==null&&end!==null&&start>end?{start,end,enabledAt:Number(n.enabledAt)||0}:null;}
function win(t,p){const d=jstDay(t),m=(t-d)/MIN;
 return m<p.end?{paused:true,until:d+p.end*MIN}:m>=p.start?{paused:true,until:d+DAY+p.end*MIN}:{paused:false,until:d+p.start*MIN};}
export function restDeadline(p,settings){const start=Number(p?.restStart)||0,raw=Number(p?.restUntil)||0,n=policy(settings);
 let end=raw;
 if(n&&raw>start&&raw>n.enabledAt){
  let t=start,left=raw-start;
  for(let i=0;left>0&&i<2000;i++){
   if(t<n.enabledAt){const step=Math.min(left,n.enabledAt-t);t+=step;left-=step;continue;}
   const w=win(t,n),resume=stamp(p.nightResumeAt);
   const resumed=w.paused&&resume>0&&Number(p.nightResumeWindowEnd)===w.until&&win(resume,n).paused&&win(resume,n).until===w.until;
   if(w.paused&&!resumed){t=w.until;continue;}
   if(w.paused&&t<resume){t=Math.min(w.until,resume);continue;}
   const step=Math.min(left,w.until-t);if(step<=0)return 0;t+=step;left-=step;
  }
  if(left>0)return 0;
  end=Math.max(raw,t);
 }
 return Math.max(end,Number(p?.manualRestUntil)||0);
}
export function label(id,p){const n=String(p?.name||'').trim();return n&&n!=='お姉ちゃん'&&n!=='弟くん'?n:(id==='older'?'子ども1':'子ども2');}
const when=t=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'numeric',minute:'numeric',month:'numeric',day:'numeric'}).format(t);
export function timedEvents(profiles,settings,c,now=Date.now()){
 const out=[];
 function add(type,key,at,text,grace=45000){
  if(c.types?.[type]&&at>0&&now>=at&&now-at<grace)out.push({type,key:type+':'+key,at,text});
 }
 for(const [id,p] of Object.entries(profiles)){
  if(!p)continue;const name=label(id,p),game=Number(p.activeStart)||0,video=stamp(p.videoStartedAt),start=game||video;
  if(start){
   const mode=game?'game':'video',word=game?'ゲーム':'動画',session=id+':'+(game?(stamp(p.startedAt)||game):video);
   const paused=stamp(p.pauseStartedAt)>0;
   const v=Number(p.videoDurationMinutes),limit=Number.isInteger(v)&&v>=1&&v<=240?v:30;
   const gm=Math.min(Number(c.gameMinutes)||60,p.restException?.state==='active'?(Number(p.restException.maxMinutes)||60):240);
   const duration=game?gm*MIN:remainingVideoMs(limit,recordedVideoMillis(p));
   const due=start+duration+effectivePausedMillis(p,now);
   add(mode+'Start',session,game?(stamp(p.startedAt)||start):start,name+'、'+word+'を開始したよ。',30000);
   if(!paused){
    const warn=Number(c.warningMinutes)*MIN;
    if(duration>warn)add(mode+'Warning',session,due-warn,name+'、'+word+'のお知らせ時間まであと'+c.warningMinutes+'分だよ。');
    add(mode+'Due',session,due,name+'、'+word+'のお知らせ時間だよ。終わる準備をしよう。');
    add('forgotten',session,due+Number(c.forgottenMinutes)*MIN,name+'、まだ'+word+'の記録が続いているよ。終わっていたらiPadで終了してね。');
   }
  }else{
   const due=restDeadline(p,settings),startRest=Number(p.restStart)||0;
   if(due>now&&startRest>0&&p.lastSessionId)add('restStart',id+':'+p.lastSessionId,startRest,name+'、休憩が始まったよ。終了予定は'+when(due)+'だよ。');
   // Use the actual recomputed deadline, not raw restUntil. Do not imply permission to start a new session.
   if(due>0)add('restEnd',id+':'+due,due,name+'、休憩の時間が終わったよ。iPadで利用状況を確認してね。');
  }
 }
 const bedtime=minute(c.bedtime);
 if(bedtime!==null)add('bedtime',String(jstDay(now)),jstDay(now)+bedtime*MIN,'そろそろ寝る準備をしよう。',60000);
 return out;
}
export function rewardEvent(id,r,profiles){
 if(!r||r.revoked||!r.pokemonNo||!['older','younger'].includes(r.childId)||r.kind==='evolution_restore')return null;
 const n=label(r.childId,profiles[r.childId]),species=pokemonName(Number(r.pokemonNo));
 return {type:'pokemon',key:'reward:'+id,at:stamp(r.claimedAt),text:r.kind==='evolution'?n+'、相棒が'+species+'に進化したよ！':n+'、'+species+'をゲットしたよ！'};
}
const activities={study:'勉強',reading:'読書',exercise:'運動',helping:'お手伝い',cleaning:'片付け',creating:'ものづくり',practicing:'練習',trying:'新しいことへの挑戦',persevering:'最後まで頑張ること',outingCalm:'お出かけ',upstairs21:'夜9時までに2階に上がること'};
export function approvalEvents(id,r,profiles){
 if(r?.status!=='approved'||!['older','younger'].includes(r.childId))return [];
 const n=label(r.childId,profiles[r.childId]),at=stamp(r.reviewedAt),xp=Number(r.slotNo)>5?(r.awardedXp===5?5:2):10;
 return [{type:'activity',key:'approval:'+id,at,text:n+'、'+(activities[r.activityKind]||'チャレンジ')+'が承認されたよ！'},
  {type:'xp',key:'xp:'+id,at,text:n+'、相棒の経験値が'+xp+'ポイント増えたよ。'}];
}
// All eleven current activities must be approved on the same reward day.
export function allDoneEvents(rows,profiles){
 const groups=new Map();
 for(const r of rows){
  if(r?.status!=='approved'||!['older','younger'].includes(r.childId)||!Number.isInteger(r.dayIndex)||!Object.hasOwn(activities,r.activityKind))continue;
  const key=r.childId+':'+r.dayIndex,group=groups.get(key)||[];group.push(r);groups.set(key,group);
 }
 const out=[];
 for(const [key,group] of groups){
  if(new Set(group.map(r=>r.activityKind)).size!==Object.keys(activities).length)continue;
  const id=group[0].childId,at=Math.max(...group.map(r=>stamp(r.reviewedAt)));
  if(at>0)out.push({type:'allDone',key:'all:'+key,at,text:label(id,profiles[id])+'、今日の11チャレンジを全部達成したね！'});
 }
 return out;
}
export function rewardEvents(id,r,profiles){
 const out=[],pokemon=rewardEvent(id,r,profiles);
 if(pokemon)out.push(pokemon);
 if(r?.kind==='rest_completed'&&!r.revoked&&['older','younger'].includes(r.childId))
  out.push({type:'xp',key:'game-xp:'+id,at:stamp(r.claimedAt),text:label(r.childId,profiles[r.childId])+'、ゲームと休憩のごほうびで相棒の経験値を5ポイント獲得したよ。'});
 return out;
}
export function eligibleNotice(e,c,now=Date.now(),maxAge=60000){
 if(!e||!Number.isFinite(e.at)||e.at<=0||e.at>now+10000||now-e.at>maxAge||c?.enabled!==true)return false;
 return e.type==='manual'||(c.types?.[e.type]===true&&!quiet(c,now));
}
const unlock=[30,60,100,150,220,300,400,500];
export function inventoryEvents(id,before,after,profile,at){
 if(!before||!after)return [];
 const out=[],n=label(id,profile),uid=after.buddyId,old=Number(before.experience?.[uid])||0,xp=Number(after.experience?.[uid])||0;
 const key=id+':'+after.version;
 if(uid&&uid===before.buddyId&&xp>old){
  const level=Math.min(99,1+Math.floor(xp/20));
  if(level>Math.min(99,1+Math.floor(old/20)))out.push({type:'level',key:'level:'+key,at,text:n+'、相棒がレベル'+level+'になったよ！'});
  const no=Number(Object.keys(after.owned||{}).find(k=>after.owned[k]===uid));
  const max=[151,251,386,493,649,721,809,905,1025][unlock.filter(x=>Object.keys(after.seen||{}).length>=x).length];
  if((EVOLUTION_TARGETS[no]||[]).some(to=>{const needed=evolutionStage(to)>=3?180:80;return old<needed&&xp>=needed&&to<=max&&!after.owned?.[to]&&!after.reserved?.[to];}))
   out.push({type:'evolveReady',key:'evolve:'+key,at,text:n+'、相棒が進化できるようになったよ！'});
 }
 const oldCount=Object.keys(before.seen||{}).length,count=Object.keys(after.seen||{}).length;
 for(let i=0;i<unlock.length;i++)if(oldCount<unlock[i]&&count>=unlock[i])out.push({type:'generation',key:'generation:'+id+':'+i,at,text:n+'、第'+(i+2)+'世代のポケモンが解放されたよ！'});
 return out;
}
