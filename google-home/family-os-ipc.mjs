import {createServer} from 'node:net';
import {chmodSync,lstatSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validRequest(r,now=Date.now()){
 return !!r&&Number.isSafeInteger(r.expiresAt)&&r.expiresAt>now&&r.expiresAt<=now+120000&&
 (r.op==='scan'||(r.op==='speak'&&typeof r.speakerId==='string'&&uuid.test(r.speakerId)&&Number.isInteger(r.volume)&&r.volume>=5&&r.volume<=80&&typeof r.text==='string'&&r.text.trim().length>0&&r.text.length<=160));
}
function safeResponse(r){
 if(r?.result==='ready')return {result:'ready',speakers:(Array.isArray(r.speakers)?r.speakers:[]).filter(s=>s&&typeof s.id==='string'&&uuid.test(s.id)&&typeof s.name==='string').slice(0,12).map(s=>({id:s.id,name:s.name.slice(0,100)}))};
 const reasons=['bridge_unavailable','bridge_busy','expired','quiet','muted','media_busy','other_app','status_unavailable','speaker_not_unique','tts_failed','tts_duration','receiver_no_start','receiver_no_finish','cast_error','timeout','process_error'];
 return {result:['sent','skipped','error'].includes(r?.result)?r.result:'error',...(r?.result==='sent'?{}:{reason:reasons.includes(r?.reason)?r.reason:'cast_error'})};
}
export function startFamilySocket(socketPath,dispatch,onError=()=>{}){
 // This function is invoked only by the lifetime-flock-protected bridge.
 // Same Unix user is the trust boundary; never expose on TCP.
 let server;try{
  const dir=lstatSync(dirname(socketPath));
  if(!dir.isDirectory()||(dir.mode&0o077)!==0||dir.uid!==process.getuid())throw Error('unsafe socket directory');
  try{const old=lstatSync(socketPath);if(!old.isSocket()||old.uid!==process.getuid())throw Error('unsafe socket path');unlinkSync(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}
  let active=0;
  server=createServer(sock=>{
   if(active>=8){sock.destroy();return;}active++;sock.once('close',()=>active--);sock.on('error',()=>{});sock.setEncoding('utf8');
   let data='',handled=false;sock.setTimeout(5000,()=>{if(!handled)sock.destroy();});
   sock.on('data',async chunk=>{
    if(handled)return;data+=chunk;if(Buffer.byteLength(data)>4096){sock.destroy();return;}
    if(!data.includes('\n'))return;handled=true;sock.setTimeout(0);
    let r;try{r=JSON.parse(data.trim());}catch{}
    if(!validRequest(r)){sock.end(JSON.stringify({result:'skipped',reason:'expired'})+'\n');return;}
    try{const result=await dispatch(r);sock.end(JSON.stringify(safeResponse(result))+'\n');}
    catch{sock.end(JSON.stringify({result:'error',reason:'cast_error'})+'\n');}
   });
  });
  server.on('error',onError);server.listen(socketPath,()=>{try{chmodSync(socketPath,0o600);}catch{server.close();onError();}});
  return server;
 }catch{onError();return undefined;}
}
