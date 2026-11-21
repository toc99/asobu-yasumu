import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyEvolutionRecoveryCandidates} from '../evolution-recovery.js';
test('旧進化連鎖の元2匹だけを検出',()=>{
 const state={owned:{'3':'original'},reserved:{},seen:{'1':true,'2':true,'3':true},
   evolutionLog:{original:[{from:1,to:2},{from:2,to:3}]}};
 assert.deepEqual(legacyEvolutionRecoveryCandidates(state).map(x=>x.no),[1,2]);
});
test('別の所持・予約済み・逃走したものは復元候補にしない',()=>{
 const state={owned:{'2':'active','1':'another'},reserved:{'4':'request'},
   seen:{'1':true,'2':true,'3':true,'4':true},
   evolutionLog:{active:[{from:1,to:2},{from:4,to:2}],released:[{from:3,to:4}]}};
 assert.deepEqual(legacyEvolutionRecoveryCandidates(state),[]);
});
test('復元後に逃がしたポケモンはもう復元しない',()=>{
 const state={owned:{'3':'original'},reserved:{},seen:{'1':true,'2':true,'3':true},
   evolutionLog:{original:[{from:1,to:2},{from:2,to:3}]}};
 assert.deepEqual(legacyEvolutionRecoveryCandidates(state,1025,[1]).map(c=>c.no),[2]);
});
