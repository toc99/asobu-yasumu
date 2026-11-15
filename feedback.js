// v3.15.0 — 家族のいけんばこ：双方向チケット、子ども了承でアーカイブ、保護者限定の物理削除。
// Existing feedbackReports documents (v3.13.4) remain readable without data migration.
// Conversation messages live in the same document so removing a ticket removes its conversation.
export function setupFeedback({dbApi,db,householdId,canOperate,playerLabel,toast}){
  const $=id=>document.getElementById(id);
  const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const types={feature:'ほしいきのう',bug:'こまったこと'};
  const parentStatuses={new:'未確認',reviewing:'確認中',planned:'対応予定',done:'対応済み',declined:'見送り'};
  const kidStatuses={new:'まだみていない',reviewing:'おはなしちゅう',planned:'たいおうよてい',done:'たいおうずみ（かくにんしてね）',declined:'みおくり（かくにんしてね）'};
  const maxMessages=100;
  const stamp=x=>x?.toMillis?.()||0;
  const displayDate=t=>new Date(t).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const collection=()=>dbApi.collection(db,'households',householdId,'feedbackReports');
  const ticketRef=id=>dbApi.doc(collection(),id);
  const archived=r=>r.closed===true;
  const dateOf=r=>stamp(r.lastActivityAt)||stamp(r.reviewedAt)||stamp(r.createdAt);
  const needsParent=r=>!archived(r)&&(r.status==='new'||r.needsParentReply===true);
  const isPendingChild=r=>!archived(r)&&(r.status==='done'||r.status==='declined');
  let uid='',role='',child='older',reports=[],loaded=false,loadError='',unsubscribe=null,busy=false,kidShowArchive=false;
  let parentFilters={scope:'active',child:'all',type:'all',status:'all',keyword:''};
  const verify=()=>{
    if(!uid||!navigator.onLine||!canOperate())throw Error('クラウドへの接続を確認してから操作してください。');
  };
  const errorText=err=>err?.code==='permission-denied'?'アクセス権限がありません。Firestore Rules v3.15.0の反映を確認してください。':String(err?.message||err);
  function options(map,value){return Object.entries(map).map(([k,label])=>'<option value="'+safe(k)+'"'+(value===k?' selected':'')+'>'+safe(label)+'</option>').join('');}
  function preserveDrafts(root){
    const result={open:new Set(),drafts:new Map()};
    if(!root)return result;
    for(const card of root.querySelectorAll('[data-feedback-ticket]')){
      if(card.open)result.open.add(card.dataset.feedbackTicket);
      const field=card.querySelector('[data-feedback-message]');
      if(field&&field.value)result.drafts.set(card.dataset.feedbackTicket,field.value);
    }
    return result;
  }
  function messagesHtml(r,forParent){
    const items=[];
    items.push('<div class="feedback-bubble kid"><span>こども・さいしょのこえ</span><p>'+safe(r.description)+'</p></div>');
    if(r.parentReply)items.push('<div class="feedback-bubble parent"><span>保護者・これまでの返事</span><p>'+safe(r.parentReply)+'</p></div>');
    const msgs=Array.isArray(r.messages)?r.messages:[];
    for(const m of msgs){
      const fromParent=m.authorRole==='parent';
      const when=Number(m.postedAtMs)>0?displayDate(Number(m.postedAtMs)):'日時確認中';
      items.push('<div class="feedback-bubble '+(fromParent?'parent':'kid')+'"><span>'+
        (fromParent?'保護者':safe(playerLabel(r.childId)))+' ・ '+safe(when)+'</span><p>'+safe(m.text)+'</p></div>');
    }
    return items.join('');
  }
  function ticketHtml(r,forParent,preserved){
    const id=safe(r.reportId),when=stamp(r.createdAt);
    const status=(forParent?parentStatuses:kidStatuses)[r.status]||'かくにんちゅう';
    const closed=archived(r),pending=isPendingChild(r),awaiting=needsParent(r);
    const open=preserved.open.has(r.reportId)?' open':'';
    const draft=safe(preserved.drafts.get(r.reportId)||'');
    const count=Array.isArray(r.messages)?r.messages.length:0;
    const header='<summary class="feedback-ticket-head"><span class="feedback-ticket-main"><strong>'+safe(r.title)+'</strong>'+
      '<small>'+safe(playerLabel(r.childId))+' ・ '+safe(types[r.type]||r.type)+' ・ '+
      (when?safe(displayDate(when)):'日時確認中')+' ・ 返信'+count+'件</small></span>'+
      '<span class="feedback-ticket-state '+(closed?'is-closed':awaiting?'needs-parent':'')+'">'+
      safe(closed?'完了・保管済み':status)+'</span></summary>';
    const thread='<div class="feedback-thread" aria-label="チケットのやり取り">'+messagesHtml(r,forParent)+'</div>';
    const maxed=count>=maxMessages;
    const reply=closed?'<p class="tiny">このチケットは保管済みです。新しいやり取りはできません。</p>':
      '<form class="feedback-message-form" data-feedback-message-form="'+id+'"><label>'+
      (forParent?'子どもへの返信':'おうちのひとに へんじを おくる')+
      '<textarea data-feedback-message rows="2" minlength="1" maxlength="500" placeholder="'+
      (forParent?'確認した内容や次の対応を伝える':'わかったことや ききたいことを かこう')+
      '" required'+(maxed||busy?' disabled':'')+'>'+draft+'</textarea></label>'+
      '<button class="btn primary" type="submit"'+(maxed||busy?' disabled':'')+'>'+
      (forParent?'返信を送る':'へんじを おくる')+'</button>'+
      (maxed?'<p class="tiny">このチケットは返信の上限（100件）です。新しいチケットで続けてください。</p>':'')+'</form>';
    let controls='';
    if(forParent){
      controls='<div class="feedback-ticket-controls"><label>対応状況 <select data-feedback-status'+(busy?' disabled':'')+'>'+
        options(parentStatuses,r.status)+'</select></label>'+
        '<button class="btn outline" type="button" data-feedback-status-save="'+id+'"'+(busy?' disabled':'')+'>状態を保存</button>'+
        '<button class="btn outline feedback-delete" type="button" data-feedback-delete="'+id+'"'+(busy?' disabled':'')+'>完全に削除</button></div>';
      if(pending)controls+='<p class="feedback-awaiting">子どもの「これでOK」を待っています。了承までは通常一覧に残ります。</p>';
      if(closed)controls+='<p class="tiny">子どもが了承して保管済みです。状態を「確認中」などへ変更すると再開できます。</p>';
    }else if(pending){
      controls='<div class="feedback-child-decision"><p>'+(
        r.status==='done'?'おうちのひとが「たいおうずみ」にしたよ。これで いいかな？':'おうちのひとが「みおくり」にしたよ。これで いいかな？'
      )+'</p><button class="btn primary" type="button" data-feedback-accept="'+id+'"'+(busy?' disabled':'')+'>これで OK！ とじる</button>'+
      '<small>まだ はなしたいときは、したの へんじから おくってね。</small></div>';
    }
    return '<details class="feedback-ticket" data-feedback-ticket="'+id+'"'+open+'>'+header+
      '<div class="feedback-ticket-body">'+thread+controls+reply+'</div></details>';
  }
  function render(){
    const kidList=$('feedback-kid-list'),parentList=$('feedback-parent-list');
    if($('feedback-child-name'))$('feedback-child-name').textContent=playerLabel(child);
    const pendingCount=reports.filter(needsParent).length;
    if($('feedback-open-count'))$('feedback-open-count').textContent='要確認 '+pendingCount+'件';
    if(kidList){
      const prev=preserveDrafts(kidList);
      if(loadError)kidList.textContent=loadError;
      else if(!loaded)kidList.textContent='おくった こえを よみこみちゅう…';
      else{
        const own=reports.filter(r=>r.childId===child&&archived(r)===kidShowArchive).sort((a,b)=>dateOf(b)-dateOf(a));
        const kidToggle=$('feedback-kid-archive-toggle');
        if(kidToggle){kidToggle.textContent=kidShowArchive?'やりとりちゅうに もどる':'おわった いけんを みる';kidToggle.setAttribute('aria-pressed',String(kidShowArchive));}
        if($('feedback-kid-summary'))$('feedback-kid-summary').textContent=kidShowArchive?'おわった いけん '+own.length+'けん':'いま おはなししている いけん '+own.length+'けん';
        kidList.innerHTML=own.length?own.map(r=>ticketHtml(r,false,prev)).join(''):
          '<p class="empty">'+(kidShowArchive?'おわった いけんは まだないよ。':'いま おはなししている いけんは ないよ。')+'</p>';
      }
    }
    if(parentList){
      const prev=preserveDrafts(parentList);
      if(loadError)parentList.textContent=loadError;
      else if(!loaded)parentList.textContent='チケットを読み込み中…';
      else{
        const filtered=reports.filter(r=>
          (parentFilters.scope==='all'||(parentFilters.scope==='archived'?archived(r):!archived(r)))&&
          (parentFilters.child==='all'||r.childId===parentFilters.child)&&
          (parentFilters.type==='all'||r.type===parentFilters.type)&&
          (parentFilters.status==='all'||r.status===parentFilters.status)&&
          (!parentFilters.keyword||(
            (r.title+' '+r.description+' '+(r.parentReply||'')+' '+(Array.isArray(r.messages)?r.messages.map(m=>m.text).join(' '):''))
              .toLocaleLowerCase('ja-JP').includes(parentFilters.keyword.toLocaleLowerCase('ja-JP')))));
        filtered.sort((a,b)=>Number(needsParent(b))-Number(needsParent(a))||dateOf(b)-dateOf(a));
        if($('feedback-parent-summary'))$('feedback-parent-summary').textContent='表示 '+filtered.length+'件 / 全'+reports.length+'件（要確認 '+pendingCount+'件）';
        parentList.innerHTML=filtered.length?filtered.map(r=>ticketHtml(r,true,prev)).join(''):'<p class="empty">条件に合うチケットはありません。</p>';
      }
    }
  }
  async function submit(e){
    e.preventDefault();
    if(role!=='kid'||busy)return;
    const type=$('feedback-type').value,title=$('feedback-title').value.trim(),description=$('feedback-description').value.trim();
    const status=$('feedback-submit-message'),button=$('feedback-submit');
    if(!Object.hasOwn(types,type)||title.length<2||title.length>60||description.length<2||description.length>1000){
      status.textContent='タイトルと ないようを かくにんしてね。';return;
    }
    busy=true;button.disabled=true;status.textContent='おくっているよ…';
    try{
      verify();
      // Retain legacy creation schema so existing reports do not require migration.
      await dbApi.setDoc(dbApi.doc(collection()),{childId:child,type,title,description,status:'new',
        parentReply:'',reviewedBy:'',reviewedAt:null,createdBy:uid,createdAt:dbApi.serverTimestamp()});
      $('feedback-form').reset();status.textContent='おくれたよ！ おうちのひとに とどいたよ。';
    }catch(err){console.error('feedback submit',err);status.textContent='おくれなかったよ。'+errorText(err);}
    finally{busy=false;button.disabled=false;}
  }
  async function sendMessage(reportId,form){
    const text=(form.querySelector('[data-feedback-message]')?.value||'').trim();
    if(busy||!text||text.length>500||!['kid','parent'].includes(role))return;
    busy=true;const button=form.querySelector('button[type="submit"]');if(button)button.disabled=true;
    try{
      verify();
      await dbApi.runTransaction(db,async tx=>{
        const ref=ticketRef(reportId),snap=await tx.get(ref);
        if(!snap.exists())throw Error('チケットは削除されています。');
        const d=snap.data(),old=Array.isArray(d.messages)?d.messages:[];
        if(d.closed===true)throw Error('終了したチケットには返信できません。');
        if(old.length>=maxMessages)throw Error('返信数が上限に達しました。');
        const msg={text,authorRole:role,authorUid:uid,postedAtMs:Date.now()};
        const update={messages:[...old,msg],lastActivityAt:dbApi.serverTimestamp(),needsParentReply:role==='kid'};
        if(role==='kid'&&['done','declined'].includes(d.status))update.status='reviewing';
        if(role==='parent'){update.reviewedBy=uid;update.reviewedAt=dbApi.serverTimestamp();if(d.status==='new')update.status='reviewing';}
        tx.update(ref,update);
      });
      if(form.isConnected)form.querySelector('[data-feedback-message]').value='';
      toast(role==='parent'?'返信を送りました。':'おうちのひとに へんじを おくったよ。');
    }catch(err){console.error('feedback message',err);toast(errorText(err));}
    finally{busy=false;if(button?.isConnected)button.disabled=false;}
  }
  async function saveStatus(reportId,card){
    if(role!=='parent'||busy)return;
    const row=reports.find(r=>r.reportId===reportId),next=card?.querySelector('[data-feedback-status]')?.value;
    if(!row||!Object.hasOwn(parentStatuses,next))return;
    if(row.status===next){toast('状態は変わっていません。');return;}
    busy=true;
    try{
      verify();
      const patch={status:next,needsParentReply:false,reviewedBy:uid,
        reviewedAt:dbApi.serverTimestamp(),lastActivityAt:dbApi.serverTimestamp()};
      if(row.closed===true){patch.closed=false;patch.closedAt=null;patch.closedBy='';}
      await dbApi.updateDoc(ticketRef(reportId),patch);
      toast(['done','declined'].includes(next)?'状態を保存しました。子どもの了承を待ちます。':'対応状況を更新しました。');
    }catch(err){console.error('feedback status',err);toast(errorText(err));}
    finally{busy=false;}
  }
  async function acknowledge(reportId){
    if(role!=='kid'||busy)return;
    const row=reports.find(r=>r.reportId===reportId);
    if(!row||!isPendingChild(row))return;
    if(!confirm('「'+row.title+'」を おわりに しても いい？\nおわった いけんから いつでも みられるよ。'))return;
    busy=true;
    try{
      verify();
      await dbApi.runTransaction(db,async tx=>{
        const ref=ticketRef(reportId),snap=await tx.get(ref);
        if(!snap.exists())throw Error('このチケットは見つかりません。');
        const d=snap.data();
        if(d.closed===true||!['done','declined'].includes(d.status))throw Error('状態が変わりました。画面を確認してください。');
        tx.update(ref,{closed:true,closedAt:dbApi.serverTimestamp(),closedBy:uid,
          needsParentReply:false,lastActivityAt:dbApi.serverTimestamp()});
      });
      toast('おわった いけんに しまったよ。');
    }catch(err){console.error('feedback accept',err);toast(errorText(err));}
    finally{busy=false;}
  }
  async function removeTicket(reportId){
    if(role!=='parent'||busy)return;
    const row=reports.find(r=>r.reportId===reportId);if(!row)return;
    if(!confirm('「'+row.title+'」を返信も含めて完全に削除します。\n取り消せません。続けますか？'))return;
    const confirmation=prompt('完全削除する場合だけ「削除」と入力してください。');
    if(confirmation!=='削除')return;
    busy=true;
    try{verify();await dbApi.deleteDoc(ticketRef(reportId));toast('チケットと返信を完全に削除しました。');}
    catch(err){console.error('feedback delete',err);toast(errorText(err));}
    finally{busy=false;}
  }
  $('feedback-form')?.addEventListener('submit',submit);
  $('feedback-kid-archive-toggle')?.addEventListener('click',()=>{kidShowArchive=!kidShowArchive;render();});
  $('feedback-kid-list')?.addEventListener('submit',e=>{const form=e.target.closest('[data-feedback-message-form]');if(form){e.preventDefault();sendMessage(form.dataset.feedbackMessageForm,form);}});
  $('feedback-kid-list')?.addEventListener('click',e=>{const button=e.target.closest('[data-feedback-accept]');if(button)acknowledge(button.dataset.feedbackAccept);});
  $('feedback-parent-list')?.addEventListener('submit',e=>{const form=e.target.closest('[data-feedback-message-form]');if(form){e.preventDefault();sendMessage(form.dataset.feedbackMessageForm,form);}});
  $('feedback-parent-list')?.addEventListener('click',e=>{
    const status=e.target.closest('[data-feedback-status-save]'),del=e.target.closest('[data-feedback-delete]');
    if(status)saveStatus(status.dataset.feedbackStatusSave,status.closest('[data-feedback-ticket]'));
    if(del)removeTicket(del.dataset.feedbackDelete);
  });
  for(const [field,key] of [['feedback-filter-scope','scope'],['feedback-filter-child','child'],
    ['feedback-filter-type','type'],['feedback-filter-status','status'],['feedback-filter-keyword','keyword']]){
    $(field)?.addEventListener(key==='keyword'?'input':'change',e=>{parentFilters[key]=key==='keyword'?e.target.value.trim():e.target.value;render();});
  }
  $('feedback-filter-reset')?.addEventListener('click',()=>{
    parentFilters={scope:'active',child:'all',type:'all',status:'all',keyword:''};
    for(const [id,key] of [['feedback-filter-scope','scope'],['feedback-filter-child','child'],
      ['feedback-filter-type','type'],['feedback-filter-status','status'],['feedback-filter-keyword','keyword']])
      if($(id))$(id).value=parentFilters[key];
    render();
  });
  function stop(){
    if(unsubscribe){unsubscribe();unsubscribe=null;}
    uid='';role='';reports=[];loaded=false;loadError='';kidShowArchive=false;render();
  }
  function start(memberUid,memberRole){
    stop();uid=memberUid;role=memberRole;
    unsubscribe=dbApi.onSnapshot(dbApi.query(collection(),dbApi.orderBy('createdAt','desc')),
      {includeMetadataChanges:true},snap=>{
        reports=snap.docs.map(d=>({...d.data(),reportId:d.id}));
        loaded=true;loadError='';render();
      },err=>{
        console.warn('feedback listener',err);
        loaded=false;loadError='チケットを読み込めません。Firestore Rulesと通信状態を確認してください。';render();
      });
  }
  function setChild(id){if(['older','younger'].includes(id)){child=id;render();}}
  return {start,stop,setChild};
}
