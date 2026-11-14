// v3.13.4 — family feedback (kid requests / bug reports / parent review).
// Isolated from game sessions, rewards and the existing application state.
export function setupFeedback({dbApi,db,householdId,canOperate,playerLabel}){
  const $=id=>document.getElementById(id);
  const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const types={feature:'こんなきのうがほしい',bug:'うごかない・こまった'};
  const kidStatuses={new:'まだみていない',reviewing:'かくにんちゅう',planned:'たいおうよてい',done:'たいおうずみ',declined:'こんかいは みおくり'};
  const parentStatuses={new:'未確認',reviewing:'確認中',planned:'対応予定',done:'対応済み',declined:'見送り'};
  const stamp=x=>x?.toMillis?.()||0;
  const displayDate=t=>new Date(t).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const collection=()=>dbApi.collection(db,'households',householdId,'feedbackReports');
  let uid='',role='',child='older',reports=[],loaded=false,loadError='',unsubscribe=null,sending=false,saving=false;
  const verify=()=>{
    if(!uid||!navigator.onLine||!canOperate())throw Error('クラウドへの接続を確認してから操作してください。');
  };
  const errorText=err=>err?.code==='permission-denied'?'送信権限がありません。Firestore Rulesの更新を確認してください。':String(err?.message||err);
  function render(){
    const kidList=$('feedback-kid-list'),parentList=$('feedback-parent-list');
    if(!kidList&&!parentList)return;
    if($('feedback-child-name'))$('feedback-child-name').textContent=playerLabel(child);
    if(kidList){
      if(loadError){kidList.textContent=loadError;}
      else if(!loaded){kidList.textContent='おくった こえを よみこみちゅう…';}
      else{
        const own=reports.filter(r=>r.childId===child).slice(0,20);
        kidList.innerHTML=own.length?own.map(r=>{
          const when=stamp(r.createdAt);
          return '<article class="feedback-item"><div class="feedback-item-head"><strong>'+safe(r.title)+'</strong><span class="feedback-state">'+safe(kidStatuses[r.status]||'かくにんちゅう')+'</span></div>'+
            '<small>'+safe(types[r.type]||r.type)+' ・ '+(when?safe(displayDate(when)):'送信中')+'</small>'+
            '<p class="feedback-description">'+safe(r.description)+'</p>'+
            (r.parentReply?'<p class="feedback-reply">おうちのひとから：'+safe(r.parentReply)+'</p>':'')+'</article>';
        }).join(''):'<p class="empty">まだ おくった こえはないよ。</p>';
      }
    }
    if(parentList){
      if($('feedback-open-count'))$('feedback-open-count').textContent='未確認 '+reports.filter(r=>r.status==='new').length+'件';
      if(loadError){parentList.textContent=loadError;}
      else if(!loaded){parentList.textContent='報告を読み込み中…';}
      else{
        const ordered=reports.slice().sort((a,b)=>(a.status==='new'?0:1)-(b.status==='new'?0:1)||stamp(b.createdAt)-stamp(a.createdAt));
        parentList.innerHTML=ordered.length?ordered.map(r=>{
          const options=Object.entries(parentStatuses).map(([value,label])=>'<option value="'+value+'"'+(r.status===value?' selected':'')+'>'+label+'</option>').join('');
          const when=stamp(r.createdAt);
          return '<article class="feedback-item" data-feedback-report="'+safe(r.reportId)+'"><div class="feedback-item-head"><strong>'+safe(r.title)+'</strong><span class="feedback-state">'+safe(parentStatuses[r.status]||'確認中')+'</span></div>'+
            '<small>'+safe(playerLabel(r.childId))+' ・ '+safe(types[r.type]||r.type)+' ・ '+(when?safe(displayDate(when)):'送信中')+'</small>'+
            '<p class="feedback-description">'+safe(r.description)+'</p>'+
            '<div class="feedback-review"><label>対応状況<select data-feedback-status>'+options+'</select></label>'+
            '<label>子どもへの返事（任意・300文字以内）<textarea rows="2" maxlength="300" data-feedback-reply>'+safe(r.parentReply||'')+'</textarea></label>'+
            '<button type="button" class="btn outline" data-feedback-save="'+safe(r.reportId)+'">対応内容を保存</button></div></article>';
        }).join(''):'<p class="empty">まだ機能の要望・バグ報告はありません。</p>';
      }
    }
  }
  async function submit(e){
    e.preventDefault();
    if(role!=='kid'||sending)return;
    const type=$('feedback-type').value,title=$('feedback-title').value.trim(),description=$('feedback-description').value.trim();
    const status=$('feedback-submit-message'),button=$('feedback-submit');
    if(!Object.hasOwn(types,type)||title.length<2||title.length>60||description.length<2||description.length>1000){
      status.textContent='タイトルと ないようを かくにんしてね。';return;
    }
    sending=true;button.disabled=true;status.textContent='おくっているよ…';
    try{
      verify();
      await dbApi.setDoc(dbApi.doc(collection()),{childId:child,type,title,description,status:'new',
        parentReply:'',reviewedBy:'',reviewedAt:null,createdBy:uid,createdAt:dbApi.serverTimestamp()});
      $('feedback-form').reset();
      status.textContent='おくれたよ！ おうちのひとに とどいたよ。';
    }catch(err){console.error('feedback submit',err);status.textContent='おくれなかったよ。'+errorText(err);}
    finally{sending=false;button.disabled=false;}
  }
  async function save(reportId){
    if(role!=='parent'||saving)return;
    const row=reports.find(r=>r.reportId===reportId);
    const card=Array.from(document.querySelectorAll('[data-feedback-report]')).find(e=>e.dataset.feedbackReport===reportId);
    if(!row||!card)return;
    const status=card.querySelector('[data-feedback-status]').value;
    const reply=card.querySelector('[data-feedback-reply]').value.trim();
    if(!Object.hasOwn(parentStatuses,status)||reply.length>300)return;
    if(row.status===status&&(row.parentReply||'')===reply){alert('変更はありません。');return;}
    const button=card.querySelector('[data-feedback-save]');saving=true;button.disabled=true;
    try{
      verify();
      await dbApi.updateDoc(dbApi.doc(collection(),reportId),{status,parentReply:reply,reviewedBy:uid,reviewedAt:dbApi.serverTimestamp()});
      alert('対応内容を保存しました。');
    }catch(err){console.error('feedback review',err);alert(errorText(err));}
    finally{saving=false;if(button.isConnected)button.disabled=false;}
  }
  $('feedback-form')?.addEventListener('submit',submit);
  $('feedback-parent-list')?.addEventListener('click',e=>{
    const button=e.target.closest('button[data-feedback-save]');
    if(button)save(button.dataset.feedbackSave);
  });
  function stop(){
    if(unsubscribe){unsubscribe();unsubscribe=null;}
    uid='';role='';reports=[];loaded=false;loadError='';render();
  }
  function start(memberUid,memberRole){
    stop();uid=memberUid;role=memberRole;
    unsubscribe=dbApi.onSnapshot(dbApi.query(collection(),dbApi.orderBy('createdAt','desc'),dbApi.limit(100)),{includeMetadataChanges:true},snap=>{
      reports=snap.docs.map(d=>({...d.data(),reportId:d.id}));
      loaded=true;loadError='';render();
    },err=>{
      console.warn('feedback listener',err);
      loaded=false;loadError='報告を読み込めません。Firestore Rulesを確認してください。';render();
    });
  }
  function setChild(id){if(['older','younger'].includes(id)){child=id;render();}}
  return {start,stop,setChild};
}
