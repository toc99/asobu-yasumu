import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAuthorizedPokemonInventories} from '../backup-data.js';

test('only explicitly allowed older/younger documents are requested', async () => {
  const gets = [], lists = [];
  const dbApi = {
    doc: (...parts) => parts.join('/'),
    getDoc: async path => {
      gets.push(path);
      const id = path.split('/').at(-1);
      return {id, exists: () => true, data: () => ({version:2, owned:{}})};
    },
    getDocs: async path => {lists.push(path); throw Error('unrestricted list must not run');}
  };
  const docs=await loadAuthorizedPokemonInventories(dbApi,'db','house123',['older','younger']);
  assert.deepEqual(gets,[
    'db/households/house123/pokemonInventory/older',
    'db/households/house123/pokemonInventory/younger'
  ]);
  assert.deepEqual(lists,[]);
  assert.deepEqual(docs.map(x=>x.childId),['older','younger']);
});

test('missing inventory doc is omitted without changing the child list', async () => {
  const dbApi={
    doc:(...parts)=>parts.join('/'),
    getDoc:async path=>{
      const id=path.split('/').at(-1);
      return {id,exists:()=>id==='older',data:()=>({version:1})};
    }
  };
  const docs=await loadAuthorizedPokemonInventories(dbApi,'db','home',['older','younger']);
  assert.deepEqual(docs,[{version:1,childId:'older'}]);
});

test('permission errors propagate rather than silently producing an incomplete full backup', async () => {
  const dbApi={
    doc:(...parts)=>parts.join('/'),
    getDoc:async()=>{throw Object.assign(Error('denied'),{code:'permission-denied'});}
  };
  await assert.rejects(loadAuthorizedPokemonInventories(dbApi,'db','home',['older','younger']),
    err=>err.code==='permission-denied');
});
