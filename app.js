(() => {
  'use strict';
  const KEY = 'asobu-yasumu-v2';
  const LEGACY_KEY = 'game-rest-2026-v1';
  const DAY = 86400000;
  const $ = id => document.getElementById(id);
  const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const pad = num => String(num).padStart(2, '0');
  const clock = date => new Date(date).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
  const dateClock = date => new Date(date).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const short = millis => {const seconds=Math.max(0,Math.ceil(millis/1000)),minutes=Math.floor(seconds/60);if(minutes===0)return `${seconds}秒`;const hours=Math.floor(minutes/60),mins=minutes%60;return hours?`${hours}時間${mins?`${mins}分`:''}`:`${minutes}分${seconds%60?`${pad(seconds%60)}秒`:''}`};
  const countDown = millis => {const s=Math.max(0,Math.ceil(millis/1000));return `${pad(Math.floor(s/3600))}:${pad(Math.floor(s/60)%60)}:${pad(s%60)}`};
  const dayStart = timestamp => {const d=new Date(timestamp);d.setHours(0,0,0,0);return d.getTime()};
  const nextDay = timestamp => {const d=new Date(timestamp);d.setHours(0,0,0,0);d.setDate(d.getDate()+1);return d.getTime()};
  const dateKey = timestamp => {const d=new Date(timestamp);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`};
  const dateInput = timestamp => {const d=new Date(timestamp);return `${dateKey(timestamp)}T${pad(d.getHours())}:${pad(d.getMinutes())}`};
  const parseTime = value => {const n=new Date(value).getTime();return Number.isFinite(n)?n:NaN};
  const hash = str => {let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return String(h>>>0)};
  const newSid = () => `s-${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
  const base = () => ({version:2,children:[
    {id:'older',name:'上の子',activeStart:null,deviceId:null,restStart:0,restUntil:0,lastDuration:0},
    {id:'younger',name:'下の子',activeStart:null,deviceId:null,restStart:0,restUntil:0,lastDuration:0}
  ],devices:[{id:'sw1',name:'Switch ①'},{id:'sw2',name:'Switch ②'}],sessions:[],pinHash:null,reminderMinutes:60});
  function safeState(obj) {
    if(!obj||obj.version!==2||!Array.isArray(obj.children)||obj.children.length!==2||!Array.isArray(obj.devices)||obj.devices.length!==2||!Array.isArray(obj.sessions)||obj.sessions.length>20000) throw Error('invalid data');
    const result=base();
    for(let i=0;i<2;i++){
      const c=obj.children[i],d=obj.devices[i];
      if(!c||typeof c.name!=='string'||typeof d?.name!=='string')throw Error('invalid children');
      const id=i===0?'older':'younger';
      result.children[i]={id,name:c.name.slice(0,12)||result.children[i].name,activeStart:Number.isFinite(c.activeStart)?c.activeStart:null,deviceId:['sw1','sw2'].includes(c.deviceId)?c.deviceId:null,restStart:Number.isFinite(c.restStart)?c.restStart:0,restUntil:Number.isFinite(c.restUntil)?c.restUntil:0,lastDuration:Number.isFinite(c.lastDuration)?c.lastDuration:0};
      if(result.children[i].activeStart===null)result.children[i].deviceId=null;
      if(result.children[i].activeStart!==null&&!result.children[i].deviceId)result.children[i].deviceId='sw1';
      result.devices[i].name=d.name.slice(0,18)||result.devices[i].name;
    }
    result.sessions=obj.sessions.map((s,i)=>{
      if(!s||!['older','younger'].includes(s.childId)||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start>=s.end)throw Error('invalid session');
      return {sid:String(s.sid||`old-${i}`).slice(0,80),childId:s.childId,start:s.start,end:s.end,duration:s.end-s.start,deviceId:['sw1','sw2'].includes(s.deviceId)?s.deviceId:'sw1',edited:!!s.edited};
    });
    result.pinHash=typeof obj.pinHash==='string'?obj.pinHash:null;
    result.reminderMinutes=[15,30,45,60,90,120].includes(Number(obj.reminderMinutes))?Number(obj.reminderMinutes):60;
    return result;
  }
  function migrateV1(obj) {
    if(!obj||obj.version!==1||!Array.isArray(obj.children)||obj.children.length!==2||!Array.isArray(obj.sessions))throw Error('not legacy');
    const migrated=base();
    migrated.children.forEach((c,i)=>{
      const old=obj.children[i];
      c.name=typeof old.name==='string'?old.name.slice(0,12):c.name;
      c.activeStart=Number.isFinite(old.start)?old.start:null;
      c.deviceId=c.activeStart!==null?'sw1':null;
      c.restStart=Number.isFinite(old.restStart)?old.restStart:0;
      c.restUntil=Number.isFinite(old.restUntil)?old.restUntil:0;
      c.lastDuration=Number.isFinite(old.lastPlay)?old.lastPlay:0;
    });
    migrated.sessions=obj.sessions.filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start).map((s,i)=>({sid:`v1-${i}-${s.end}`,childId:s.id==='younger'?'younger':'older',start:s.start,end:s.end,duration:s.end-s.start,deviceId:'sw1',edited:false}));
    migrated.pinHash=typeof obj.pinHash==='string'?obj.pinHash:null;
    return migrated;
  }
  let state;
  function load() {
    try {const raw=localStorage.getItem(KEY);if(raw)return safeState(JSON.parse(raw));}catch(err){console.warn('v2 read error',err)}
    try {const raw=localStorage.getItem(LEGACY_KEY);if(raw){const m=migrateV1(JSON.parse(raw));localStorage.setItem(KEY,JSON.stringify(m));return m;}}catch(err){console.warn('v1 migration error',err)}
    return base();
  }
  let toastTimer;
  function toast(message) {const node=$('toast');node.textContent=message;node.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('show'),3800)}
  function save() {
    try {localStorage.setItem(KEY,JSON.stringify(state));$('save-status').textContent='保存済み';return true;}
    catch(err){$('save-status').textContent='保存に失敗しました';toast('保存に失敗しました。空き容量やプライベートモードを確認してください');return false;}
  }
  state=load();
  let selectedChild=null, endingChild=null, editing=null, historyDay=dayStart(Date.now()), activeTab='home';
  function childBy(id){return state.children.find(c=>c.id===id)}
  function deviceBy(id){return state.devices.find(d=>d.id===id)}
  function activeOn(id){return state.children.filter(c=>c.activeStart!==null&&c.deviceId===id)}
  function status(c, now=Date.now()){return c.activeStart!==null?'playing':now<c.restUntil?'resting':'ready'}
  function gameMs(c,now=Date.now()){return c.activeStart===null?0:Math.max(0,now-c.activeStart)}
  function overlap(start,end,begin,finish){return Math.max(0,Math.min(end,finish)-Math.max(start,begin))}
  function totalIn(c,begin,end,now=Date.now()){
    let sum=0;for(const s of state.sessions){if(s.childId===c.id)sum+=overlap(s.start,s.end,begin,end)}
    if(c.activeStart!==null)sum+=overlap(c.activeStart,now,begin,end);
    return sum;
  }
  function newestSessionFor(id){return state.sessions.filter(s=>s.childId===id).sort((a,b)=>b.end-a.end)[0]||null}
  function canStart(c,now=Date.now()){return c.activeStart===null&&now>=c.restUntil}
  function renderClock(now){$('now-time').textContent=clock(now);$('now-date').textContent=new Date(now).toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'short'})}
  function createCard(c,index,now){
    const st=status(c,now),elapsed=gameMs(c,now),restLeft=Math.max(0,c.restUntil-now),restDuration=Math.max(1,c.restUntil-c.restStart);
    const bg=index===1?'green':'',device=c.deviceId?deviceBy(c.deviceId):null;
    const profile=index===0
      ? {emoji:'🚀',tag:'チャレンジモード',ready:'ミッションスタートOK',rest:'パワーチャージ中',playing:'バトル中'}
      : {emoji:'🌈',tag:'マイペースモード',ready:'スタートOK',rest:'ひとやすみ中',playing:'プレイ中'};
    let title,number,sub,prog,forecastLabel,forecastValue,forecastNote,actionLabel,footer,ribbon;
    if(st==='playing'){
      title='ゲームを始めてから';number=countDown(elapsed);sub='好きなタイミングで終わってOK';prog=100;
      forecastLabel='いま終わったら…';forecastValue=`休憩 ${short(elapsed)} ｜ つぎは ${dateClock(now+elapsed)} から`;
      forecastNote='あと5分つづけると、つぎに遊べる時間も5分のびるよ';
      actionLabel='🛑 ゲームを終わる';footer=elapsed>=state.reminderMinutes*60000?'長く遊んでいるよ。終わったらボタンを押そう！':'終わるときは、かならずこのボタンを押してね';
      ribbon='🎮 いまプレイ中';
    } else if(st==='resting'){
      title='つぎまで、あとこれだけ';number=countDown(restLeft);sub=`${dateClock(c.restUntil)} から遊べる`;prog=Math.min(100,Math.max(0,(now-c.restStart)/restDuration*100));
      forecastLabel='前回のゲーム';forecastValue=`${short(c.lastDuration)} 遊んだ → 同じ時間休憩`;
      forecastNote='休憩が終わると、ボタンがまた押せるようになるよ';actionLabel='⏳ 休憩がおわるまで';footer='ちがう遊びやおてつだいの時間にしてもOK';
      ribbon='💤 ひとやすみ';
    } else {
      title='いま、ゲームを始められるよ';number='00:00:00';sub='じぶんのタイミングでスタート！';prog=100;
      forecastLabel='前回のゲーム';forecastValue=c.lastDuration?`${short(c.lastDuration)} 遊んで、休憩もかんりょう！`:'今日のゲームを始めよう';forecastNote='遊ぶSwitchは、始めるときに選べます';actionLabel='▶️ ゲームを始める';footer='終わるときもボタンを押して、じぶんの時間をきろくしよう';
      ribbon='⭐ スタートOK';
    }
    const today=totalIn(c,dayStart(now),nextDay(now),now);
    return `<article class="child-card ${bg} ${st==='playing'?'playing':''}" data-child-card="${c.id}">
      <div class="card-ribbon">${ribbon}</div>
      <div class="head"><div class="child-person"><div class="avatar">${profile.emoji}</div><div class="child-name-wrap"><div class="child-name">${htmlEscape(c.name)}</div><div class="child-tag">${profile.tag}</div></div></div><div class="status ${st}">${st==='playing'?profile.playing:st==='resting'?profile.rest:profile.ready}</div></div>
      <div class="main-time"><div class="time-title">${title}</div><div class="time-value">${number}</div><div class="time-sub">${sub}</div></div>
      <div class="progress" aria-label="休憩の進み具合"><div class="progress-fill" style="width:${prog.toFixed(1)}%"></div></div>
      <div class="forecast"><div class="forecast-label">${forecastLabel}</div><div class="forecast-value">${forecastValue}</div><div class="forecast-note">${forecastNote}</div></div>
      <div class="device-name">${device?`🎮 ${htmlEscape(device.name)} でプレイ中`:'🎯 どのSwitchで遊ぶか、スタート時にえらべます'}</div>
      <button class="child-action ${st==='playing'?'stop':''}" data-action="${st==='playing'?'ask-end':'ask-start'}" data-child="${c.id}" ${st==='resting'?'disabled':''}>${actionLabel}</button>
      <div class="card-footer">${footer}</div>
      <div class="mini-stats"><span>今日のプレイ <strong>${short(today)}</strong></span><span>今日の終了 <strong>${state.sessions.filter(s=>s.childId===c.id&&s.end>=dayStart(now)&&s.end<nextDay(now)).length}回</strong></span></div>
      </article>`;
  }
  function renderHome(now=Date.now()){
    if(activeTab!=='home')return;
    $('children-grid').innerHTML=state.children.map((c,i)=>createCard(c,i,now)).join('');
    $('consoles-grid').innerHTML=state.devices.map(d=>{
      const occupants=activeOn(d.id);return `<div class="console ${occupants.length?'busy':''}"><div><div class="console-title">🎮 ${htmlEscape(d.name)}</div><div class="console-desc">${occupants.length?`${occupants.length}人がゲーム中`:'今はあいています'}</div></div><div class="console-occupants">${occupants.length?occupants.map(c=>`<span class="person-pill ${c.id==='younger'?'green':''}">${htmlEscape(c.name)}</span>`).join(''):'<span class="subtle">空き</span>'}</div></div>`;
    }).join('');
    $('alerts').innerHTML=state.children.filter(c=>c.activeStart!==null&&gameMs(c,now)>=state.reminderMinutes*60000).map(c=>`<div class="alert">⚠ ${htmlEscape(c.name)}は${state.reminderMinutes}分以上プレイ中です。終了ボタンを押し忘れていないかな？</div>`).join('');
  }
  function getDayAt(baseStamp,offset){const d=new Date(baseStamp);d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return d.getTime()}
  function renderWeek(now=Date.now()){
    const first=getDayAt(now,-6),days=Array.from({length:7},(_,i)=>getDayAt(first,i));
    const rows=days.map(d=>({d,totals:state.children.map(c=>totalIn(c,d,nextDay(d),now))}));
    const max=Math.max(15*60000,...rows.flatMap(r=>r.totals));
    $('week-chart').innerHTML=rows.map((r,i)=>{
      const day=new Date(r.d).toLocaleDateString('ja-JP',{month:'numeric',day:'numeric',weekday:'short'});
      return `<div class="week-day"><span class="week-day-label">${day}${i===6?' 今日':''}</span><div class="week-bars">${r.totals.map((ms,k)=>`<div class="week-track"><div class="week-fill ${k?'green':'blue'}" style="width:${(ms/max*100).toFixed(2)}%"></div></div>`).join('')}</div><span class="week-day-total">${short(r.totals[0]+r.totals[1])}</span></div>`;
    }).join('');
    const totals=state.children.map((c,i)=>rows.reduce((sum,r)=>sum+r.totals[i],0));
    $('legend-older').textContent=state.children[0].name;$('legend-younger').textContent=state.children[1].name;
    $('week-summary').innerHTML=state.children.map((c,i)=>`<span>${htmlEscape(c.name)}：<strong>${short(totals[i])}</strong></span>`).join('');
  }
  function renderTimeline(now=Date.now()){
    const begin=historyDay,end=nextDay(begin);
    $('history-date').value=dateKey(begin);$('next-day').disabled=begin>=dayStart(now);
    const sessions=state.sessions.map(s=>({...s,isCurrent:false}));
    for(const c of state.children){if(c.activeStart!==null&&now>c.activeStart)sessions.push({sid:`ongoing-${c.id}`,childId:c.id,start:c.activeStart,end:now,duration:now-c.activeStart,deviceId:c.deviceId,edited:false,isCurrent:true})}
    const matches=sessions.filter(s=>overlap(s.start,s.end,begin,end)>0);
    const frac=value=>Math.max(0,Math.min(100,(value-begin)/(end-begin)*100));
    $('day-timeline').innerHTML=`<div class="timeline-hours"><span>0時</span><span>6時</span><span>12時</span><span>18時</span><span>24時</span></div>`+state.children.map((c,i)=>{
      const segs=matches.filter(s=>s.childId===c.id).map(s=>`<div class="segment ${i?'green':''}" title="${htmlEscape(dateClock(s.start))}〜${htmlEscape(dateClock(s.end))}" style="left:${frac(Math.max(s.start,begin)).toFixed(2)}%;width:${Math.max(.2,frac(Math.min(s.end,end))-frac(Math.max(s.start,begin))).toFixed(2)}%"></div>`).join('');
      return `<div class="timeline-line"><div class="timeline-label">${htmlEscape(c.name)}</div><div class="timeline-track">${segs}</div></div>`;
    }).join('');
    if(!matches.length){$('history-list').innerHTML='<div class="empty">この日はまだプレイ記録がありません</div>';return;}
    $('history-list').innerHTML=matches.sort((a,b)=>b.start-a.start).map(s=>{
      const c=childBy(s.childId),d=deviceBy(s.deviceId);const restUntil=s.end+s.duration;
      return `<div class="history-item"><div class="history-dot ${c.id==='younger'?'green':''}"></div><div class="history-main"><strong>${htmlEscape(c.name)} ・ ${htmlEscape(d?.name||'Switch ①')}${s.isCurrent?' ・ プレイ中':''}</strong>${dateClock(s.start)}〜${s.isCurrent?'現在':dateClock(s.end)}${s.edited?' · 修正済み':''}</div><div class="history-values"><strong>${short(s.duration)}</strong>${s.isCurrent?'終了後に同じ時間休憩':`休憩は${dateClock(restUntil)}まで`}</div></div>`;
    }).join('');
  }
  function update(now=Date.now()){
    renderClock(now);
    if(activeTab==='home')renderHome(now);
    else if(activeTab==='history'){
      // 週別集計と履歴は2秒ごと・画面復帰時に描画する
      if(Math.floor(now/1000)%2===0){renderWeek(now);renderTimeline(now)}
    }
  }
  function setTab(tab){activeTab=tab;document.querySelectorAll('.tab[data-tab]').forEach(b=>{const on=b.dataset.tab===tab;b.classList.toggle('active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});$('view-home').classList.toggle('hidden',tab!=='home');$('view-history').classList.toggle('hidden',tab!=='history');update();if(tab==='history'){renderWeek();renderTimeline()}}
  function askStart(id){const c=childBy(id),now=Date.now();if(!c||!canStart(c,now)){toast('まだ休憩中か、すでにゲーム中です');return}selectedChild=id;$('choose-title').textContent=`${c.name}：どのSwitchで遊ぶ？`;$('choose-text').textContent='空いている本体を選ぶか、もう1人が使っている本体で一緒に遊べます。';$('device-choices').innerHTML=state.devices.map(d=>{
    const occupants=activeOn(d.id),joining=occupants.length>0;
    return `<button class="device-choice ${joining?'join':''}" data-action="choose-device" data-device="${d.id}"><strong>🎮 ${htmlEscape(d.name)}</strong><span>${joining?`${htmlEscape(occupants.map(x=>x.name).join('・'))}と同じ本体で遊ぶ`:'空いている本体で遊ぶ'}</span></button>`;
  }).join('');$('choose-dialog').showModal()}
  function begin(id,deviceId){
    const c=childBy(id),now=Date.now();if(!c||!deviceBy(deviceId)||!canStart(c,now)){toast('開始できません。休憩状態を確認してください');return}
    c.activeStart=now;c.deviceId=deviceId;if(!save()){c.activeStart=null;c.deviceId=null;return}
    $('choose-dialog').close();renderHome(now);toast(`${c.name}：ゲームを開始しました`);
  }
  function askEnd(id){const c=childBy(id);if(!c||c.activeStart===null)return;endingChild=id;const now=Date.now(),played=gameMs(c,now);$('end-title').textContent=`${c.name}：ゲームを終わる？`;$('end-summary').innerHTML=`<div class="end-summary-line"><span>いままで遊んだ時間</span><strong>${short(played)}</strong></div><div class="end-summary-line"><span>これから休む時間</span><strong>${short(played)}</strong></div><div class="end-summary-line"><span>次に遊べる時刻</span><strong>${dateClock(now+played)}</strong></div>`;$('end-dialog').showModal()}
  function finish(id){const c=childBy(id);if(!c||c.activeStart===null)return;const now=Date.now(),duration=Math.max(1,now-c.activeStart),session={sid:newSid(),childId:c.id,start:c.activeStart,end:now,duration,deviceId:c.deviceId||'sw1',edited:false};
    state.sessions.push(session);c.activeStart=null;c.deviceId=null;c.restStart=now;c.restUntil=now+duration;c.lastDuration=duration;
    if(!save()){state.sessions.pop();c.activeStart=session.start;c.deviceId=session.deviceId;c.restStart=0;c.restUntil=0;return}
    $('end-dialog').close();endingChild=null;renderHome(now);toast(`${c.name}：${short(duration)}の休憩が始まりました`);
  }
  function getPin(){
    if(!state.pinHash){const pin=prompt('保護者用PINを初期登録してください（数字4〜8桁）');if(pin===null)return false;if(!/^\d{4,8}$/.test(pin)){toast('数字4〜8桁で入力してください');return false}const again=prompt('確認のため、同じPINをもう一度入力してください');if(pin!==again){toast('PINが一致しません');return false}state.pinHash=hash(pin);save();return true}
    const pin=prompt('保護者用PINを入力してください');if(pin===null)return false;
    if(hash(pin)!==state.pinHash){toast('PINが違います');return false}return true;
  }
  function parentOpen(){if(!getPin())return;state.children.forEach((c,i)=>$(`parent-name-${i}`).value=c.name);state.devices.forEach((d,i)=>$(`device-name-${i}`).value=d.name);$('reminder-minutes').value=String(state.reminderMinutes);$('new-pin').value='';renderAdminEditors();$('parent-dialog').showModal()}
  function renderAdminEditors(){
    const playing=state.children.filter(c=>c.activeStart!==null);
    $('active-edits').innerHTML=playing.length?playing.map(c=>`<div class="edit-row"><span class="edit-row-main"><strong>${htmlEscape(c.name)}：現在ゲーム中</strong><small>${dateClock(c.activeStart)} から開始（${htmlEscape(deviceBy(c.deviceId)?.name||'Switch')}）</small></span><button class="small-outline" data-action="edit-active" data-child="${c.id}">修正</button></div>`).join(''):'<div class="subtle">現在ゲーム中の記録はありません。</div>';
    const recent=[...state.sessions].sort((a,b)=>b.end-a.end).slice(0,25);
    $('session-edits').innerHTML=recent.length?recent.map(s=>{const c=childBy(s.childId);return `<div class="edit-row"><span class="edit-row-main"><strong>${htmlEscape(c.name)}：${short(s.duration)}</strong><small>${dateClock(s.start)}〜${dateClock(s.end)}（${htmlEscape(deviceBy(s.deviceId)?.name||'Switch')}）</small></span><button class="small-outline" data-action="edit-session" data-sid="${htmlEscape(s.sid)}">修正</button></div>`}).join(''):'<div class="subtle">まだプレイ記録がありません。</div>';
  }
  function saveSettings(){const names=state.children.map((_,i)=>$(`parent-name-${i}`).value.trim()),devices=state.devices.map((_,i)=>$(`device-name-${i}`).value.trim());if([...names,...devices].some(s=>!s)){toast('名前を入力してください');return}const pin=$('new-pin').value.trim();if(pin&&!/^\d{4,8}$/.test(pin)){toast('新しいPINは数字4〜8桁です');return}
    state.children.forEach((c,i)=>c.name=names[i].slice(0,12));state.devices.forEach((d,i)=>d.name=devices[i].slice(0,18));state.reminderMinutes=Number($('reminder-minutes').value)||60;if(pin)state.pinHash=hash(pin);
    if(save()){$('parent-dialog').close();update();toast('保護者設定を保存しました')}
  }
  function startEdit(type,key){editing={type,key};let start,end,title,note;
    if(type==='active'){const c=childBy(key);if(!c||c.activeStart===null)return;start=c.activeStart;title=`${c.name}：開始時刻を修正`;note='終了ボタンの押し忘れは「ゲームを終了」したあと、履歴を修正できます。誤って開始した場合は下の取消ボタンを使ってください。';$('edit-end-wrap').classList.add('hidden');$('cancel-active').classList.remove('hidden')}
    else {const s=state.sessions.find(s=>s.sid===key);if(!s)return;start=s.start;end=s.end;title=`${childBy(s.childId).name}：プレイ履歴を修正`;note='直近のプレイを修正すると、休憩終了時刻も修正後のプレイ時間から再計算します。過去の古い記録の修正は、現在の休憩には影響しません。';$('edit-end-wrap').classList.remove('hidden');$('cancel-active').classList.add('hidden')}
    $('edit-title').textContent=title;$('edit-start').value=dateInput(start);$('edit-end').value=end?dateInput(end):'';$('edit-note').textContent=note;$('parent-dialog').close();$('edit-dialog').showModal();
  }
  function editValidForChild(childId,start,end,excludeSid,excludeActive){
    if(end<=start||end>Date.now()+60000||start<0)return false;
    const old=state.sessions.filter(s=>s.childId===childId&&s.sid!==excludeSid);
    if(old.some(s=>overlap(start,end,s.start,s.end)>0))return false;
    const c=childBy(childId);if(c.activeStart!==null&&!excludeActive&&overlap(start,end,c.activeStart,Date.now())>0)return false;
    return true;
  }
  function saveEdit(){if(!editing)return;const start=parseTime($('edit-start').value),end=editing.type==='active'?Date.now():parseTime($('edit-end').value);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){toast('終了は開始より後の時刻にしてください');return}
    if(editing.type==='active'){
      const c=childBy(editing.key);if(!c||c.activeStart===null)return;
      if(!editValidForChild(c.id,start,end,null,true)){toast('ほかのプレイ記録と時間が重なるか、未来の時刻です');return}
      c.activeStart=start;
    }else{
      const s=state.sessions.find(s=>s.sid===editing.key);if(!s)return;
      if(!editValidForChild(s.childId,start,end,s.sid,false)){toast('ほかのプレイ記録と時間が重なるか、未来の時刻です');return}
      s.start=start;s.end=end;s.duration=end-start;s.edited=true;
      const c=childBy(s.childId),last=newestSessionFor(c.id);
      if(c.activeStart===null&&last?.sid===s.sid){c.restStart=end;c.restUntil=end+s.duration;c.lastDuration=s.duration}
    }
    if(save()){$('edit-dialog').close();editing=null;renderHome();renderWeek();renderTimeline();toast('プレイ時間を修正しました')}
  }
  function cancelActive(){if(!editing||editing.type!=='active')return;const c=childBy(editing.key);if(!c)return;if(!confirm(`${c.name}の「ゲーム中」の記録を取り消します。よろしいですか？`))return;c.activeStart=null;c.deviceId=null;if(save()){$('edit-dialog').close();editing=null;renderHome();toast('誤開始の記録を取り消しました')}}
  function download(text,name,mime){const blob=new Blob([text],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000)}
  function exportJSON(){download(JSON.stringify({...state,pinHash:null},null,2),`asobu-yasumu-backup-${dateKey(Date.now())}.json`,'application/json')}
  function csvEscape(val){let s=String(val??'');if(/^[=+@\-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
  function exportCSV(){const rows=[['子ども','本体','開始日時','終了日時','プレイ時間(秒)','修正済み'],...state.sessions.map(s=>[childBy(s.childId)?.name||'',deviceBy(s.deviceId)?.name||'',new Date(s.start).toLocaleString('ja-JP'),new Date(s.end).toLocaleString('ja-JP'),Math.round(s.duration/1000),s.edited?'はい':'いいえ'])];download('\ufeff'+rows.map(r=>r.map(csvEscape).join(',')).join('\r\n'),`asobu-yasumu-history-${dateKey(Date.now())}.csv`,'text/csv;charset=utf-8')}
  async function importJSON(file){if(!file)return;if(file.size>3*1024*1024){toast('3MB以下のファイルを選んでください');return}try{
      const incoming=safeState(JSON.parse(await file.text()));if(!confirm('このiPadの現在の記録を、読み込んだJSONで置き換えます。実行しますか？'))return;
      incoming.pinHash=state.pinHash;state=incoming;if(!save())return;$('parent-dialog').close();setTab('home');toast('バックアップを復元しました');
    }catch(err){toast('復元に失敗しました。v2のJSONか確認してください')}
  }
  function resetAll(){if(state.children.some(c=>c.activeStart!==null)){toast('ゲーム中は全削除できません。終了してから実行してください');return}if(prompt('すべての履歴・設定を消去します。確認のため「全削除」と入力してください')!=='全削除')return;const old=state;state=base();if(!save()){state=old;return}$('parent-dialog').close();setTab('home');toast('全データを削除しました')}
  function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close());editing=null;selectedChild=null;endingChild=null}
  document.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;const a=button.dataset.action;
    if(a==='ask-start')askStart(button.dataset.child);
    else if(a==='choose-device'&&selectedChild)begin(selectedChild,button.dataset.device);
    else if(a==='ask-end')askEnd(button.dataset.child);
    else if(a==='confirm-end'&&endingChild)finish(endingChild);
    else if(a==='close-dialog')closeDialogs();
    else if(a==='save-parent')saveSettings();
    else if(a==='edit-active')startEdit('active',button.dataset.child);
    else if(a==='edit-session')startEdit('session',button.dataset.sid);
    else if(a==='save-edit')saveEdit();
    else if(a==='cancel-active')cancelActive();
    else if(a==='export-json')exportJSON();
    else if(a==='export-csv')exportCSV();
    else if(a==='import-json')$('import-file').click();
    else if(a==='reset')resetAll();
    else if(a==='prev-day'){historyDay=getDayAt(historyDay,-1);renderTimeline()}
    else if(a==='next-day'&&historyDay<dayStart(Date.now())){historyDay=getDayAt(historyDay,1);renderTimeline()}
  });
  document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog)closeDialogs()}));
  document.querySelectorAll('.tab[data-tab]').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
  $('open-parent').addEventListener('click',parentOpen);
  $('history-date').addEventListener('change',event=>{const day=parseTime(`${event.target.value}T00:00:00`);if(!Number.isFinite(day)||day>dayStart(Date.now())){toast('未来の日付は表示できません');$('history-date').value=dateKey(historyDay);return}historyDay=dayStart(day);renderTimeline()});
  $('import-file').addEventListener('change',async event=>{await importJSON(event.target.files?.[0]);event.target.value=''});
  window.addEventListener('storage',event=>{if(event.key===KEY&&event.newValue){try{state=safeState(JSON.parse(event.newValue));update();if(activeTab==='history'){renderWeek();renderTimeline()}}catch(err){console.warn('storage update ignored',err)}}});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)update()});
  setTab('home');setInterval(()=>update(),1000);
  if('serviceWorker' in navigator && location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('offline cache unavailable',err));
})();
