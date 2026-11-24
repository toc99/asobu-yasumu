import {defaultConfig,TYPES,stamp} from './google-home-policy.js';
export function setupGoogleHome({dbApi,db,householdId,toast}){
 const root=document.getElementById('google-home-panel');if(!root)return {start(){},stop(){}};
 const configRef=dbApi.doc(db,'households',householdId,'googleHome','config');
 const statusRef=dbApi.doc(db,'households',householdId,'googleHome','status');
 const form=root.querySelector('form'),get=id=>root.querySelector('#gh-'+id);
 const fields=['bridgeUid','speaker','volume','gameMinutes','warningMinutes','forgottenMinutes','quietStart','quietEnd','bedtime'];
 const numeric=new Set(['volume','gameMinutes','warningMinutes','forgottenMinutes']);
 const switches=get('types');for(const [key,label] of Object.entries(TYPES)){
   const line=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.name=key;
   line.append(input,document.createTextNode(' '+label));switches.append(line);
 }
 let cfg=defaultConfig(),status=null,subs=[],dirty=false,ready=false,active=false,timer=null;
 function fill(c){
  get('enabled').checked=c.enabled;for(const name of fields)get(name).value=c[name];
  for(const input of switches.querySelectorAll('input'))input.checked=c.types?.[input.name]===true;
 }
 function setButtons(){form.querySelectorAll('button').forEach(b=>b.disabled=!ready);get('send').disabled=!ready||dirty||!cfg.enabled;get('test').disabled=!ready||dirty||!cfg.enabled;}
 function renderStatus(){
  const age=Date.now()-stamp(status?.updatedAt);
  const fresh=!!status&&status.bridgeUid===cfg.bridgeUid&&age>=-30000&&age<150000;
  const labels={ready:'接続確認済み',unavailable:'スピーカー未検出',busy:'再生中',disabled:'通知停止中',error:'エラー'};
  get('state').textContent=!ready?'設定読み込み中':!fresh?'連携PC未接続（または停止中）':(labels[status.state]||'不明')+(status.device?' / '+status.device:'');
  const list=get('history');list.replaceChildren();
  for(const h of (fresh&&Array.isArray(status.history)?status.history:[]).slice(0,20)){
   if(!h||typeof h!=='object')continue;
   const li=document.createElement('li');li.textContent=new Date(Number(h.at)||0).toLocaleString('ja-JP')+' '+(TYPES[h.type]|| (h.type==='manual'?'テスト・手動通知':'通知'))+'：'+({sent:'送信済み',error:'失敗',skipped:'スキップ'}[h.result]||'不明');list.append(li);
  }
  if(!list.childElementCount){const li=document.createElement('li');li.textContent='通知履歴なし';list.append(li);}
 }
 function stop(){active=false;ready=false;dirty=false;subs.forEach(fn=>fn());subs=[];clearInterval(timer);timer=null;cfg=defaultConfig();status=null;fill(cfg);renderStatus();setButtons();}
 function start(){
  if(active)return;active=true;
  subs.push(dbApi.onSnapshot(configRef,{includeMetadataChanges:true},s=>{
    if(!active||s.metadata.fromCache||s.metadata.hasPendingWrites)return;
    const base=defaultConfig(),data=s.exists()?s.data():{};cfg={...base,...data,types:{...base.types,...data.types}};
    ready=true;if(!dirty)fill(cfg);setButtons();renderStatus();
  },()=>{ready=false;get('state').textContent='設定を取得できません。Firestoreルールを確認してください。';setButtons();}));
  subs.push(dbApi.onSnapshot(statusRef,s=>{if(active&&!s.metadata.fromCache){status=s.exists()?s.data():null;renderStatus();}},()=>{status=null;renderStatus();}));
  timer=setInterval(renderStatus,15000);
 }
 form.addEventListener('input',()=>{dirty=true;setButtons();});
 form.addEventListener('submit',async e=>{
  e.preventDefault();if(!ready)return;
  const data={enabled:get('enabled').checked,types:{}};
  for(const name of fields)data[name]=numeric.has(name)?Number(get(name).value):get(name).value.trim();
  for(const i of switches.querySelectorAll('input'))data.types[i.name]=i.checked;
  if(data.enabled&&(!data.bridgeUid||!data.speaker))return toast('連携専用UIDとスピーカー名が必要です。');
  try{
   await dbApi.setDoc(configRef,data,{merge:true});cfg={...cfg,...data};dirty=false;fill(cfg);setButtons();toast('Google Home設定を保存しました。');
  }catch(e){toast('Google Home設定の保存に失敗しました。');}
 });
 async function send(text){
  text=String(text||'').trim();if(!ready||dirty||!cfg.enabled||!text||text.length>160)return;
  if(!confirm('指定したGoogle Homeから読み上げます。よろしいですか？'))return;
  try{
   await dbApi.updateDoc(configRef,{command:{id:crypto.randomUUID(),text,at:dbApi.serverTimestamp()}});
   toast('音声通知を依頼しました。結果は接続状態・履歴で確認してください。');
  }catch(e){toast('通知依頼に失敗しました。');}
 }
 get('test').addEventListener('click',()=>send('あそぶ・やすむのGoogle Home連携テストです。'));
 get('send').addEventListener('click',()=>send(get('message').value));
 fill(cfg);setButtons();return {start,stop};
}
