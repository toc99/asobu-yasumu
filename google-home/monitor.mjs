// Local telemetry only; no credentials, IP addresses, SSIDs or raw journal.
import os from 'node:os';
import {readFileSync,readdirSync,statfsSync} from 'node:fs';
export const BRIDGE_VERSION='v3.26.0';
const read=p=>readFileSync(p,'utf8').trim();
const bounded=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const jstDay=ms=>new Date(ms+9*3600000).toISOString().slice(0,10);
export function normalizeWatchdog(data,now=Date.now()){
 const empty={watchdog:'unknown',wifi:'unknown',recoveryDay:'',attempts:0,successes:0,failures:0,events:[]};
 if(!data||!bounded(data.observedAt,now-180000,now+30000))return empty;
 const watchdog=['active','inactive','unknown'].includes(data.watchdog)?data.watchdog:'unknown';
 const wifi=['connected','disconnected','unknown'].includes(data.wifi)?data.wifi:'unknown';
 if(data.recoveryDay!==jstDay(now)||!['attempts','successes','failures'].every(k=>bounded(data[k],0,1440)))return {...empty,watchdog,wifi};
 const events=(Array.isArray(data.events)?data.events:[]).filter(e=>e&&['start','success','failure','blocked','recovered'].includes(e.kind)&&bounded(e.at,now-86400000,now+30000)&&jstDay(e.at)===data.recoveryDay).sort((a,b)=>b.at-a.at).slice(0,5).map(e=>({at:e.at,kind:e.kind}));
 return {watchdog,wifi,recoveryDay:data.recoveryDay,attempts:data.attempts,successes:data.successes,failures:data.failures,events};
}
function cpuTemp(){
 if(os.platform()!=='linux')return null;
 const candidates=[];
 try{for(const d of readdirSync('/sys/class/hwmon')){
  const base='/sys/class/hwmon/'+d;if(!['coretemp','k10temp','zenpower'].includes(read(base+'/name')))continue;
  for(const f of readdirSync(base).filter(f=>/^temp[0-9]+_input$/.test(f))){
   const v=Math.round(Number(read(base+'/'+f))/100);if(bounded(v,-100,1500))candidates.push(v);
  }
 }}catch{}
 if(!candidates.length)try{for(const d of readdirSync('/sys/class/thermal').filter(x=>x.startsWith('thermal_zone'))){
  const base='/sys/class/thermal/'+d;if(!['x86_pkg_temp','cpu-thermal','cpu_thermal'].includes(read(base+'/type')))continue;
  const v=Math.round(Number(read(base+'/temp'))/100);if(bounded(v,-100,1500))candidates.push(v);
 }}catch{}
 return candidates.length?Math.max(...candidates):null;
}
export function collectMonitor(stateDir,now=Date.now()){
 let watchdog=null;try{watchdog=JSON.parse(read('/run/asobu-monitor/status.json'));}catch{}
 let diskPercent=null;try{const s=statfsSync(stateDir);if(s.blocks>0)diskPercent=Math.max(0,Math.min(100,Math.round(100*(1-s.bavail/s.blocks))));}catch{}
 const platform=['linux','win32','darwin'].includes(os.platform())?os.platform():'other';
 return {version:1,bridgeVersion:BRIDGE_VERSION,host:os.hostname().replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,64)||'unknown',platform,observedAt:now,uptimeSec:Math.max(0,Math.min(315360000,Math.floor(os.uptime()))),cpuTempDeciC:cpuTemp(),memPercent:Math.max(0,Math.min(100,Math.round(100*(1-os.freemem()/os.totalmem())))),diskPercent,...normalizeWatchdog(watchdog,now)};
}
