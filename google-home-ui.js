import {defaultConfig,TYPES,stamp,ROUTE_TYPES,speakerIds,knownSpeakers,MAX_SPEAKERS,normalizeClock,compactRoutes} from './google-home-policy.js?v=3.26.0';
import {monitorView,selectMonitor,deliveryStats,duration,jstDay} from './google-home-monitor.js?v=3.26.0';
const reasons={muted:'スピーカーがミュート中',media_busy:'音楽・動画の再生または一時停止中',other_app:'別のCastアプリが使用中（状態を確認できない）',status_unavailable:'スピーカーの状態を取得できない',speaker_not_unique:'指定したスピーカーが見つからない、または同名の機器が複数ある',tts_failed:'日本語音声生成に失敗',tts_duration:'音声の長さが範囲外',receiver_no_start:'スピーカーで音声再生が開始されない',receiver_no_finish:'音声再生完了を確認できない',cast_error:'Cast通信または音声配信エラー',timeout:'処理タイムアウト',process_error:'Pythonの実行または応答エラー',stale:'通知の有効時間切れ・設定変更',queue_full:'待機上限に達したためスキップ',interrupted:'再生中に連携PCが停止したため再送なし'};
export function setupGoogleHome({dbApi,db,householdId,toast}){
 const root=document.getElementById('google-home-panel');if(!root)return {start(){},stop(){}};
 const configRef=dbApi.doc(db,'households',householdId,'googleHome','config');
 const statusRef=dbApi.doc(db,'households',householdId,'googleHome','status');
 const monitorRef=dbApi.doc(db,'households',householdId,'googleHome','monitor');
 const form=root.querySelector('form'),get=id=>root.querySelector('#gh-'+id);
 const fields=['bridgeUid','speaker','volume','gameMinutes','warningMinutes','forgottenMinutes','quietStart','quietEnd','bedtime'];
 const numeric=new Set(['volume','gameMinutes','warningMinutes','forgottenMinutes']);
 const switches=get('types');for(const [key,label] of Object.entries(TYPES)){
   const line=document.createElement('label'),input=document.createElement('input');line.className='gh-check-row';input.type='checkbox';input.name=key;
   const caption=document.createElement('span');caption.textContent=label;line.append(input,caption);switches.append(line);
 }
 let cfg=defaultConfig(),status=null,subs=[],dirty=false,ready=false,active=false,timer=null;
 let draftIds=[],draftRoutes={},saving=false,sending=false,statusFromServer=false,monitorDoc=null,monitorFromServer=false;
 const queueReady=()=>status?.bridgeUid===cfg.bridgeUid&&status?.queue?.version===1&&Date.now()-stamp(status.updatedAt)>=-30000&&Date.now()-stamp(status.updatedAt)<150000;
 const typeLabel=t=>ROUTE_TYPES[t]||'通知';
 const times=new Set(['quietStart','quietEnd','bedtime']);
 const bounds={volume:[5,80],gameMinutes:[1,240],warningMinutes:[1,30],forgottenMinutes:[1,30]};
 const fieldLabels={volume:'通知音量',gameMinutes:'ゲームのお知らせ時間',warningMinutes:'終了予告',forgottenMinutes:'終了押し忘れの確認',quietStart:'静音開始時刻',quietEnd:'静音終了時刻',bedtime:'就寝準備時刻'};
 function errorMessage(e){const code=String(e?.code||'unknown').replace(/^firestore\//,'');return ({'permission-denied':'保存権限または設定値の検証で拒否されました','unavailable':'通信できません','unauthenticated':'ログイン状態を確認してください','invalid-argument':'設定値が不正です','deadline-exceeded':'通信がタイムアウトしました'})[code]||'通信・保存エラー（'+(/^[a-z-]{1,50}$/.test(code)?code:'unknown')+'）';}
 function saveMessage(text){get('save-result').textContent=text;toast(text);}
 const routeType=get('route-type');
 for(const [type,label] of Object.entries(ROUTE_TYPES)){
  const option=document.createElement('option');option.value=type;option.textContent=label;routeType.append(option);
 }
 function speakerRows(){
  const list=knownSpeakers(status?.bridgeUid===cfg.bridgeUid?status.speakers:[]),ids=new Set(list.map(x=>x.id));
  for(const id of [...draftIds,...Object.values(draftRoutes).flat()])if(!ids.has(id)){ids.add(id);list.push({id,name:'未検出の機器 ('+id.slice(0,8)+')',online:false});}
  return list;
 }
 function renderChoices(){
  const rows=speakerRows();
  function render(container,selected,change){
   container.replaceChildren();
   if(!rows.length){container.textContent='連携PCで機器を検出してください。';return;}
   for(const d of rows){
    const line=document.createElement('label'),input=document.createElement('input');line.className='gh-check-row';
    input.type='checkbox';input.checked=selected.includes(d.id);
    input.disabled=!ready||(!input.checked&&selected.length>=MAX_SPEAKERS);
    const caption=document.createElement('span');caption.textContent=d.name+(d.online?'':'（未検出）');line.append(input,caption);
    input.addEventListener('change',()=>{
     const next=input.checked?[...selected,d.id]:selected.filter(x=>x!==d.id);
     change(speakerIds(next));dirty=true;renderChoices();setButtons();
    });container.append(line);
   }
  }
  const type=routeType.value;
  render(get('speakers'),draftIds,ids=>draftIds=ids);
  render(get('route-speakers'),draftRoutes[type]||[],ids=>draftRoutes[type]=ids);
  const count=Object.values(draftRoutes).filter(ids=>ids.length).length;
  get('route-summary').textContent=count?count+'種類に個別の通知先を設定中。選択なしは共通設定。':'すべて共通の通知先を使用します。';
  const t=Number(status?.scannedAt)||0;
  get('scan-state').textContent=t&&status?.bridgeUid===cfg.bridgeUid?'最終検出 '+new Date(t).toLocaleString('ja-JP')+' ／ '+rows.filter(d=>d.online).length+'台検出':'連携PCからの検出結果待ち';
 }
 routeType.addEventListener('change',renderChoices);
 get('scan').addEventListener('click',async()=>{
  if(!ready||!cfg.bridgeUid)return toast('先に連携設定を保存してください。');
  try{await dbApi.updateDoc(configRef,{scanRequestedAt:dbApi.serverTimestamp()});toast('スピーカーの再検出を依頼しました。');}
  catch{toast('再検出の依頼に失敗しました。');}
 });

 function fill(c){
  get('enabled').checked=c.enabled;for(const name of fields)get(name).value=c[name];
  for(const input of switches.querySelectorAll('input'))input.checked=c.types?.[input.name]===true;
  draftIds=speakerIds(c.speakerIds);draftRoutes=Object.fromEntries(Object.keys(ROUTE_TYPES).map(k=>[k,speakerIds(c.routes?.[k])]));renderChoices();
 }
 function setButtons(){form.querySelectorAll('button').forEach(b=>b.disabled=!ready||saving);get('send').disabled=!ready||dirty||saving||sending||!cfg.enabled||!queueReady();get('test').disabled=!ready||dirty||saving||sending||!cfg.enabled||!queueReady();get('scan').disabled=!ready||saving||!cfg.bridgeUid;}
 function renderMonitor(){
  const now=Date.now(),v=monitorView(status?{...status,monitor:undefined}:null,cfg.bridgeUid,{now,ready,server:statusFromServer});
  const m=v.connection==='online'?(monitorFromServer?selectMonitor(monitorDoc,cfg.bridgeUid,now):null)||selectMonitor(status,cfg.bridgeUid,now):null;
  const labels={loading:'確認中',unconfigured:'未設定',unknown:'確認不可',offline:'オフライン',online:'オンライン'};
  const put=(id,text)=>{get('monitor-'+id).textContent=text;};
  const connection=get('monitor-connection');connection.textContent=labels[v.connection];connection.dataset.connection=v.connection;
  put('note',v.connection==='unknown'?'この端末からサーバー状態を確認できません。':v.connection==='online'&&!m?'連携PCは稼働中です。詳細監視は未取得です。連携PC v3.26.1と監視情報の送信状態を確認してください。':v.connection==='offline'?'最終取得時点の情報です。連携PCまたは通信経路を確認してください。':!cfg.enabled&&v.connection==='online'?'連携PCは稼働中・音声通知は設定で停止中です。':'');
  const currentStatus=ready&&statusFromServer&&status?.bridgeUid===cfg.bridgeUid?status:null;
  const history=Array.isArray(currentStatus?.history)?currentStatus.history:[];
  const stats=deliveryStats(history),fmt=t=>new Date(t).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
  put('last',v.age===null?'—':Math.floor(v.age/1000)+'秒前');
  put('host',m?m.host+' ('+m.platform+')':'—');put('version',m?.bridgeVersion||'—');
  put('uptime',m?duration(m.uptimeSec):'—');
  const detected=knownSpeakers(currentStatus?.speakers||[]).filter(d=>d.online).length;
  put('speakers',currentStatus?.scannedAt?detected+'台（'+fmt(currentStatus.scannedAt)+'）':'—');
  put('rate',stats.rate===null?'—':stats.rate+'%（'+stats.sent+'/'+(stats.sent+stats.error)+'台分）');
  put('wifi',({connected:'接続',disconnected:'切断',unknown:'未取得'})[m?.wifi]||'—');
  put('watchdog',({active:'有効',inactive:'停止',unknown:'未取得'})[m?.watchdog]||'—');
  const today=m?.recoveryDay===jstDay(now);
  put('recovery',today?m.successes+'回':'—');put('counts',today?'試行 '+m.attempts+'回 ／ 成功 '+m.successes+'回 ／ 失敗 '+m.failures+'回':'当日分のログ未取得（Linux側の監視連携を確認）');
  put('temp',Number.isInteger(m?.cpuTempDeciC)?(m.cpuTempDeciC/10).toFixed(1)+' ℃':'—');
  put('memory',Number.isInteger(m?.memPercent)?m.memPercent+'%':'—');put('disk',Number.isInteger(m?.diskPercent)?m.diskPercent+'%':'—');
  const events=get('monitor-events');events.replaceChildren();
  const add=(list,label)=>{const li=document.createElement('li');li.textContent=label;list.append(li);};
  const names={start:'復旧開始',success:'復旧成功',failure:'復旧失敗',blocked:'ハードウェアブロック',recovered:'通信回復'};
  for(const e of today&&Array.isArray(m.events)?m.events:[])add(events,fmt(e.at)+' '+(names[e.kind]||'不明'));
  if(!events.children.length)add(events,today?'記録なし':'未取得');
  const delivery=get('monitor-delivery');delivery.replaceChildren();
  for(const h of history.slice(0,5)){
   if(!h||typeof h!=='object')continue;
   const target=Array.isArray(h.targets)?h.targets.filter(t=>t&&typeof t==='object').map(t=>t.name+'：'+({sent:'成功',error:'失敗',skipped:'スキップ'}[t.result]||'不明')+(reasons[t.reason]?'（'+reasons[t.reason]+'）':'')).join(' ／ '):'';
   add(delivery,fmt(Number(h.at)||0)+' '+typeLabel(h.type)+'：'+({sent:'成功',partial:'一部成功',error:'失敗',skipped:'スキップ'}[h.result]||'不明')+(target?' ／ '+target:''));
  }
  if(!delivery.children.length)add(delivery,'通知履歴なし');
 }
 function renderStatus(){
  renderMonitor();
  const age=Date.now()-stamp(status?.updatedAt);
  const fresh=!!status&&status.bridgeUid===cfg.bridgeUid&&age>=-30000&&age<150000;
  const labels={ready:'通知先検出済み',unavailable:'スピーカー未検出',busy:'再生中',disabled:'通知停止中',error:'エラー'};
  get('state').textContent=!ready?'設定読み込み中':!fresh?'連携PC未接続（または停止中）':(labels[status.state]||'不明')+(status.device?' / '+status.device:'');
  const q=queueReady()?status.queue:null;
  get('queue-state').textContent=q?'待機中 '+q.waiting+'件 ／ 処理中 '+q.active+'件':'連携PC v3.22.0以降の接続を確認してください。';
  get('queue-active').textContent=q&&q.activeTypes?.length?'処理中：'+q.activeTypes.map(typeLabel).join('・'):'';
  const waiting=get('queue-waiting');waiting.replaceChildren();
  if(q)for(const type of q.types||[]){const li=document.createElement('li');li.textContent=typeLabel(type);waiting.append(li);}
  get('queue-more').textContent=q&&q.waiting>(q.types?.length||0)?'ほか '+(q.waiting-q.types.length)+'件':'';
  setButtons();
  const list=get('history');list.replaceChildren();
  for(const h of (status?.bridgeUid===cfg.bridgeUid&&Array.isArray(status.history)?status.history:[]).slice(0,20)){
   if(!h||typeof h!=='object')continue;
   const li=document.createElement('li');li.textContent=new Date(Number(h.at)||0).toLocaleString('ja-JP')+' '+(Array.isArray(h.types)&&h.types.length>1?h.types.map(typeLabel).join('・')+'（まとめ通知）':typeLabel(h.type))+'：'+({sent:'送信済み',partial:'一部成功',error:'失敗',skipped:'スキップ'}[h.result]||'不明')+(h.reason&&reasons[h.reason]?'（'+reasons[h.reason]+'）':'');if(Array.isArray(h.targets)){const details=document.createElement('div');details.className='tiny';details.textContent=h.targets.map(t=>t.name+'：'+({sent:'成功',error:'失敗',skipped:'スキップ'}[t.result]||'不明')+(reasons[t.reason]?'（'+reasons[t.reason]+'）':'')).join(' ／ ');li.append(details);}list.append(li);
  }
  renderChoices();
  if(!list.childElementCount){const li=document.createElement('li');li.textContent='通知履歴なし';list.append(li);}
 }
 function stop(){active=false;ready=false;dirty=false;saving=false;get('save-result').textContent='';subs.forEach(fn=>fn());subs=[];clearInterval(timer);timer=null;cfg=defaultConfig();status=null;statusFromServer=false;monitorDoc=null;monitorFromServer=false;fill(cfg);renderStatus();setButtons();}
 function start(){
  if(active)return;active=true;
  subs.push(dbApi.onSnapshot(configRef,{includeMetadataChanges:true},s=>{
    if(!active||s.metadata.fromCache||s.metadata.hasPendingWrites)return;
    const base=defaultConfig(),data=s.exists()?s.data():{};cfg={...base,...data,types:{...base.types,...data.types}};
    ready=true;if(!dirty)fill(cfg);setButtons();renderStatus();
  },()=>{ready=false;get('state').textContent='設定を取得できません。Firestoreルールを確認してください。';setButtons();}));
  subs.push(dbApi.onSnapshot(statusRef,{includeMetadataChanges:true},s=>{if(!active)return;statusFromServer=!s.metadata.fromCache&&!s.metadata.hasPendingWrites;if(statusFromServer)status=s.exists()?s.data():null;renderStatus();},()=>{statusFromServer=false;status=null;renderStatus();}));
  subs.push(dbApi.onSnapshot(monitorRef,{includeMetadataChanges:true},s=>{if(!active)return;monitorFromServer=!s.metadata.fromCache&&!s.metadata.hasPendingWrites;if(monitorFromServer)monitorDoc=s.exists()?s.data():null;renderStatus();},()=>{monitorFromServer=false;monitorDoc=null;renderStatus();}));
  timer=setInterval(renderStatus,15000);
 }
 form.addEventListener('input',e=>{if(e.target===routeType)return;dirty=true;setButtons();});
 form.addEventListener('submit',async e=>{
  e.preventDefault();if(!ready||saving)return;
  const data={enabled:get('enabled').checked,types:{},speakerIds:speakerIds(draftIds),routes:compactRoutes(draftRoutes)};
  for(const name of fields){
   const raw=get(name).value.trim();
   if(numeric.has(name)){
    const value=Number(raw),[min,max]=bounds[name];
    if(!raw||!Number.isInteger(value)||value<min||value>max)return saveMessage(fieldLabels[name]+'は'+min+'〜'+max+'の整数を入力してください。');
    data[name]=value;
   }else if(times.has(name)){
    const value=normalizeClock(raw);
    if(value===null)return saveMessage(fieldLabels[name]+'を確認してください。');
    data[name]=value;
   }else data[name]=raw;
  }
  for(const i of switches.querySelectorAll('input'))data.types[i.name]=i.checked;
  if(data.enabled&&(!data.bridgeUid||(!data.speaker&&!data.speakerIds.length)))return saveMessage('連携専用UIDと共通の通知先が必要です。');
  saving=true;get('save-result').textContent='保存中…';setButtons();
  try{
   // Replace only these top-level fields; do not merge stale per-type routes or touch command/scan timestamps.
   await dbApi.setDoc(configRef,data,{mergeFields:Object.keys(data)});
   cfg={...cfg,...data};dirty=false;fill(cfg);saveMessage('Google Home設定を保存しました。');
  }catch(e){saveMessage('Google Home設定の保存に失敗：'+errorMessage(e));}
  finally{saving=false;setButtons();}
 });
 async function send(text){
  text=String(text||'').trim();if(!ready||dirty||saving||sending||!cfg.enabled||!text||text.length>160)return;
  if(!queueReady())return toast('連携PCをv3.22.0以降へ更新してください。');
  if(!confirm('指定したGoogle Homeに音声通知を依頼します。再生中の音楽などが停止する場合があります。よろしいですか？'))return;
  sending=true;setButtons();
  try{
   const id=crypto.randomUUID();
   await dbApi.setDoc(dbApi.doc(db,'households',householdId,'googleHomeCommands',id),{text,at:dbApi.serverTimestamp()});
   toast('音声通知を受け付けました。待機状況と履歴を確認してください。');
  }catch(e){toast('通知依頼に失敗：'+errorMessage(e));}
  finally{sending=false;setButtons();}
 }
 get('test').addEventListener('click',()=>send('あそぶ・やすむのGoogle Home連携テストです。'));
 get('send').addEventListener('click',()=>send(get('message').value));
 fill(cfg);setButtons();return {start,stop};
}
