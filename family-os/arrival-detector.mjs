// Prototype: pure geofence detection only. No live data access, storage or audio.
export function distanceMeters(a,b){
 const rad=Math.PI/180, dlat=(b.lat-a.lat)*rad,dlon=(b.lng-a.lng)*rad;
 const h=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2;
 return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}

export function validateConfig(c){
 const point=p=>p&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180;
 const clock=s=>typeof s==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
 if(!c||typeof c.enabled!=='boolean'||typeof c.vehicleId!=='string'||!c.vehicleId||c.vehicleId.length>120||
 !Array.isArray(c.slots)||!c.slots.length||c.slots.length>2||
 !Number.isInteger(c.maxAgeMs)||c.maxAgeMs<5000||c.maxAgeMs>120000||
 !Number.isInteger(c.confirmations)||c.confirmations<1||c.confirmations>2||
 !Array.isArray(c.excludedDates)||c.excludedDates.some(d=>typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)))throw Error('invalid configuration');
 const ids=new Set();
 for(const s of c.slots){
 if(!s||!['morning','afternoon'].includes(s.id)||ids.has(s.id)||typeof s.enabled!=='boolean'||!clock(s.start)||!clock(s.end)||s.start>=s.end||
 !point(s.point)||!Number.isFinite(s.radius)||s.radius<50||s.radius>1500||
 !Number.isFinite(s.exitMargin)||s.exitMargin<20||s.exitMargin>500||
 typeof s.text!=='string'||!s.text.trim()||s.text.length>160)throw Error('invalid slot');
 ids.add(s.id);
 }
 if(c.slots.length===2&&c.slots[0].start<c.slots[1].end&&c.slots[1].start<c.slots[0].end)throw Error('overlapping slots');
 return c;
}

export function evaluateArrival(c,previous,sample,now){
 validateConfig(c);
 if(!Number.isFinite(now)||now<=0)throw Error('invalid clock');
 const jst=new Date(now+9*3600000),day=jst.toISOString().slice(0,10),time=jst.toISOString().slice(11,16);
 const slot=c.slots.find(s=>s.enabled&&s.start<=time&&time<s.end);
 if(!c.enabled||jst.getUTCDay()===0||jst.getUTCDay()===6||c.excludedDates.includes(day)||!slot)
 return {state:null,event:null,status:'inactive'};
 const key=day+':'+slot.id;
 const state=previous?.key===key?{...previous}:{key,armed:false,insideCount:0,lastObservedAt:0,notified:false};
 if(state.notified)return {state,event:null,status:'already_notified'};
 const point=p=>p&&Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180;
 if(!sample||sample.vehicleId!==c.vehicleId||!point(sample)||!Number.isFinite(sample.observedAt)||sample.observedAt>now+5000||now-sample.observedAt>c.maxAgeMs)
 return {state:{...state,insideCount:0},event:null,status:'unavailable'};
 if(sample.observedAt<=state.lastObservedAt)return {state,event:null,status:'unchanged'};
 if(sample.observedAt-state.lastObservedAt>c.maxAgeMs){state.armed=false;state.insideCount=0;}
 state.lastObservedAt=sample.observedAt;
 const d=distanceMeters(slot.point,sample);
 if(d>=slot.radius+slot.exitMargin){state.armed=true;state.insideCount=0;}
 else if(d<=slot.radius&&state.armed){state.insideCount++;}
 else state.insideCount=0;
 if(state.insideCount>=c.confirmations){
 state.notified=true;
 return {state,event:{type:'busApproach',key:'busApproach:'+key,at:now,text:slot.text},status:'detected'};
 }
 return {state,event:null,status:state.armed?'armed':'waiting_for_outside'};
}
