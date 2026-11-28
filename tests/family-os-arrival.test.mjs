import {test} from 'node:test';
import assert from 'node:assert/strict';
import {distanceMeters,validateConfig,evaluateArrival} from '../family-os/arrival-detector.mjs';
const base=1795993800000;
const config={"enabled":true,"vehicleId":"synthetic","maxAgeMs":30000,"confirmations":2,"excludedDates":[],"slots":[{"id":"morning","enabled":true,"start":"08:00","end":"09:00","point":{"lat":0,"lng":0},"radius":200,"exitMargin":50,"text":"バスが近づいています。"}]};
const sample=(lat,t,vehicleId='synthetic')=>({vehicleId,lat,lng:0,observedAt:t});
const cases=[
["distance zero",()=>distanceMeters({lat:0,lng:0},{lat:0,lng:0})===0],
["distance 1 degree",()=>Math.abs(distanceMeters({lat:0,lng:0},{lat:1,lng:0})-111195)<2],
["first inside does not notify",()=>!evaluateArrival(config,null,sample(.001,base),base).event],
["wrong vehicle rejected",()=>evaluateArrival(config,null,sample(.004,base,'wrong'),base).status==='unavailable'],
["old timestamp rejected",()=>evaluateArrival(config,null,sample(.004,base-31000),base).status==='unavailable'],
["future timestamp rejected",()=>evaluateArrival(config,null,sample(.004,base+6000),base).status==='unavailable'],
["disabled",()=>evaluateArrival({...config,enabled:false},null,null,base).status==='inactive'],
["outside hours",()=>evaluateArrival(config,null,null,base+3600000).status==='inactive'],
["weekend",()=>evaluateArrival(config,null,null,base-86400000).status==='inactive'],
["excluded date",()=>evaluateArrival({...config,excludedDates:['2026-11-30']},null,null,base).status==='inactive'],
["two fresh inside samples and restart dedup",()=>{
  const a=evaluateArrival(config,null,sample(.004,base),base);
  const b=evaluateArrival(config,a.state,sample(.001,base+10000),base+10000);
  const duplicate=evaluateArrival(config,b.state,sample(.001,base+10000),base+11000);
  const c=evaluateArrival(config,duplicate.state,sample(.0009,base+20000),base+20000);
  const d=evaluateArrival(config,JSON.parse(JSON.stringify(c.state)),sample(.0008,base+25000),base+25000);
  return a.status==='armed'&&!b.event&&!duplicate.event&&c.event?.type==='busApproach'&&!d.event&&d.status==='already_notified';
 }],
["long observation gap disarms",()=>{
  const a=evaluateArrival(config,null,sample(.004,base),base);
  return evaluateArrival(config,a.state,sample(.001,base+35000),base+35000).status==='waiting_for_outside';
 }],
["invalid radius rejected",()=>{try{validateConfig({...config,slots:[{...config.slots[0],radius:0}]});return false}catch{return true}}],
["overlapping slots rejected",()=>{try{validateConfig({...config,slots:[config.slots[0],{...config.slots[0],id:'afternoon'}]});return false}catch{return true}}]
];
for(const [name,fn] of cases)test(name,()=>assert.equal(fn(),true));
