// Pure parent-view helpers. Never treat a cached or stale sample as online.
const ms=t=>typeof t?.toMillis==='function'?t.toMillis():typeof t==='number'?t:0;
export const ONLINE_MS=180000;
export const jstDay=t=>new Date(t+9*3600000).toISOString().slice(0,10);
export function monitorView(status,uid,{now=Date.now(),ready=true,server=true}={}){
 if(!ready)return {connection:'loading',monitor:null,age:null};
 if(!uid)return {connection:'unconfigured',monitor:null,age:null};
 if(!server)return {connection:'unknown',monitor:null,age:null};
 if(!status||status.bridgeUid!==uid)return {connection:'offline',monitor:null,age:null};
 const age=now-ms(status.updatedAt),m=status.monitor?.version===1?status.monitor:null;
 const fresh=age>=-30000&&age<ONLINE_MS&&(!m||(Number.isFinite(m.observedAt)&&now-m.observedAt>=-30000&&now-m.observedAt<ONLINE_MS));
 return {connection:fresh?'online':'offline',monitor:m,age:Math.max(0,age),fresh};
}
export function deliveryStats(history){
 const out={sent:0,error:0,skipped:0};
 for(const h of (Array.isArray(history)?history:[]).slice(0,20))for(const t of Array.isArray(h?.targets)?h.targets:[])if(t?.result==='sent'||t?.result==='error'||t?.result==='skipped')out[t.result]++;
 const denominator=out.sent+out.error;
 return {...out,rate:denominator?Math.round(100*out.sent/denominator):null};
}
export function duration(seconds){
 if(!Number.isFinite(seconds)||seconds<0)return '—';
 const m=Math.floor(seconds/60),d=Math.floor(m/1440),h=Math.floor(m%1440/60);
 return (d?d+'日 ':'')+h+'時間 '+m%60+'分';
}
