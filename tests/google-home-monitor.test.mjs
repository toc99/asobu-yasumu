import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {monitorView,selectMonitor,deliveryStats,duration,jstDay} from '../google-home-monitor.js';
import {collectMonitor,normalizeWatchdog,BRIDGE_VERSION} from '../google-home/monitor.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const now=Date.parse('2026-11-26T03:00:00Z'),uid='bridge',status={bridgeUid:uid,updatedAt:now,monitor:{version:1,observedAt:now}};
test('server heartbeat has strict three minute expiry and ignores wrong UID, cache and stale payload',()=>{
 assert.equal(monitorView(status,uid,{now}).connection,'online');
 assert.equal(monitorView(status,uid,{now:now+179999}).connection,'online');
 assert.equal(monitorView(status,uid,{now:now+180000}).connection,'offline');
 assert.equal(monitorView(status,'another',{now}).connection,'offline');
 assert.equal(monitorView(status,uid,{now,server:false}).connection,'unknown');
 assert.equal(monitorView({...status,monitor:{version:1,observedAt:now-180001}},uid,{now}).connection,'offline');
 assert.equal(monitorView({...status,monitor:undefined},uid,{now}).connection,'online');
 assert.equal(monitorView({...status,updatedAt:{toMillis:()=>now}},uid,{now}).connection,'online');
});
test('independent monitor requires matching UID and fresh server and sample timestamps',()=>{
 assert.equal(selectMonitor(status,uid,now)?.version,1);
 assert.equal(selectMonitor(status,'other',now),null);
 assert.equal(selectMonitor(status,uid,now+180000),null);
 assert.equal(selectMonitor({...status,monitor:{version:1,observedAt:now-180001}},uid,now),null);
});
test('notification rates use target-level deliveries, excluding deliberate skips',()=>{
 assert.deepEqual(deliveryStats([{targets:[{result:'sent'},{result:'sent'},{result:'error'},{result:'skipped'}]},{result:'error'}]),{sent:2,error:1,skipped:1,rate:67});
 assert.equal(deliveryStats([{targets:[{result:'skipped'}]}]).rate,null);
 assert.equal(duration(90061),'1日 1時間 1分');
});
test('watchdog metrics discard stale samples, wrong day and unrecognized raw log fields',()=>{
 const d={observedAt:now,recoveryDay:jstDay(now),watchdog:'active',wifi:'connected',attempts:1,successes:1,failures:0,events:[{at:now,kind:'success',raw:'private'},{at:now,kind:'raw'},{at:now-86400000,kind:'start'}]};
 assert.deepEqual(normalizeWatchdog(d,now),{watchdog:'active',wifi:'connected',recoveryDay:'2026-11-26',attempts:1,successes:1,failures:0,events:[{at:now,kind:'success'}]});
 assert.equal(normalizeWatchdog({...d,observedAt:now-180001},now).watchdog,'unknown');
 assert.equal(normalizeWatchdog({...d,recoveryDay:'2026-11-25'},now).recoveryDay,'');
 const m=collectMonitor(process.cwd());assert.equal(m.bridgeVersion,BRIDGE_VERSION);assert.ok(m.uptimeSec>=0);assert.ok(m.memPercent>=0&&m.memPercent<=100);assert.match(m.host,/^[a-zA-Z0-9._-]{1,64}$/);
});
test('monitor is written independently and collector only reads bounded local data',()=>{
 const bridge=read('google-home/bridge.mjs'),ui=read('google-home-ui.js'),html=read('parent.html'),sw=read('sw.js'),collector=read('google-home/collect-monitor.py');
 assert.match(bridge,/setDoc\(statusRef,base\)/);
 assert.match(bridge,/setDoc\(monitorRef,\{updatedAt:serverTimestamp\(\),bridgeUid:uid,monitor:collectMonitor\(stateDir\)\}\)/);
 assert.match(bridge,/Date\.now\(\)-lastMonitor>=60000/);
 assert.match(ui,/onSnapshot\(monitorRef/);
 assert.match(ui,/includeMetadataChanges:true/);
 for(const id of ['connection','host','version','last','uptime','speakers','rate','wifi','watchdog','recovery','temp','memory','disk','events','delivery','counts','note'])assert.ok(html.includes('id="gh-monitor-'+id+'"'),id);
 assert.match(sw,/google-home-monitor\.js\?v=3\.27\.1/);
 assert.match(collector,/os\.replace\(temp,OUT\)/);assert.match(collector,/home-wifi-watchdog\.service/);
 assert.doesNotMatch(collector,/rfkill|networkctl|netplan|systemctl','restart/);
 const python=spawnSync('python3',['-c','import ast,sys; ast.parse(sys.stdin.read())'],{input:collector,encoding:'utf8'});if(!python.error)assert.equal(python.status,0,python.stderr);
});
