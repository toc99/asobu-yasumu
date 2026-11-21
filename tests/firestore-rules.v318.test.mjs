import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,runTransaction,serverTimestamp,setDoc,Timestamp,getDoc} from 'firebase/firestore';

if(!process.env.FIRESTORE_EMULATOR_HOST){
  test('v3.18 Firestore integration requires emulators:exec',{skip:true},()=>{});
}else{
  const environment=await initializeTestEnvironment({
    projectId:'demo-asobu-v316',firestore:{host:'127.0.0.1',port:8080,
      rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}
  });
  after(async()=>environment.cleanup());
  const kid=environment.authenticatedContext('kid-user');
  async function seed(h){
    await environment.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'members','kid-user'),{role:'kid'});
      await setDoc(doc(db,'households',h,'pokemonInventory','older'),{
        owned:{'1':'reward_original'},reserved:{},seen:{'1':true},
        version:1,updatedAt:Timestamp.fromMillis(Date.now()),
        buddyId:'reward_original',experience:{reward_original:80},evolutionLog:{},bankedXp:0
      });
    });
  }
  async function evolve(h,keepOriginal=true){
    const db=kid.firestore(),invRef=doc(db,'households',h,'pokemonInventory','older');
    const rid='evolution_ABCDEFGHIJKLMNOPQRST',rewardRef=doc(db,'households',h,'rewards',rid);
    return runTransaction(db,async tx=>{
      const snap=await tx.get(invRef),p=snap.data();
      tx.update(invRef,{
        owned:keepOriginal?{...p.owned,'2':rid}:{'2':rid},
        reserved:{},seen:{...p.seen,'2':true},version:p.version+1,updatedAt:serverTimestamp(),
        buddyId:rid,experience:{reward_original:80,[rid]:80},
        evolutionLog:{reward_original:[{from:1,to:2,at:Date.now()}]},bankedXp:0
      });
      tx.set(rewardRef,{childId:'older',kind:'evolution',sourceRewardId:'reward_original',
        fromPokemonNo:1,catalogVersion:3,pokemonNo:2,claimedAt:serverTimestamp(),claimedBy:'kid-user'});
    });
  }
  test('進化前と進化後を両方所持する更新を許可する',async()=>{
    const h='v318-evo-preserve';await seed(h);
    await assertSucceeds(evolve(h));
    const result=await getDoc(doc(kid.firestore(),'households',h,'pokemonInventory','older'));
    assert.equal(result.data().owned['1'],'reward_original');
    assert.equal(result.data().owned['2'],'evolution_ABCDEFGHIJKLMNOPQRST');
  });
  test('進化前を削除する更新と進化報酬の同時作成は拒否',async()=>{
    const h='v318-evo-reject';await seed(h);
    await assertFails(evolve(h,false));
  });
  test('保護者だけが、過去の進化元を保持したまま復元できる',async()=>{
    const h='v318-evo-legacy-restore';await seed(h);
    await environment.withSecurityRulesDisabled(async ctx=>{
      const db=ctx.firestore();
      await setDoc(doc(db,'households',h,'pokemonInventory','older'),{
        owned:{'2':'reward_original'},reserved:{},seen:{'1':true,'2':true},
        version:1,updatedAt:Timestamp.fromMillis(Date.now()),
        buddyId:'reward_original',experience:{reward_original:100},
        evolutionLog:{reward_original:[{from:1,to:2,at:Date.now()}]},bankedXp:0
      });
      await setDoc(doc(db,'households',h,'rewards','reward_original'),{
        childId:'older',kind:'rest_completed',revoked:false
      });
    });
    async function restore(db){
      const invRef=doc(db,'households',h,'pokemonInventory','older'),
        rewardRef=doc(db,'households',h,'rewards','evo_restore_ABCDEFGHIJKLMNOPQRST');
      return runTransaction(db,async tx=>{
        const snap=await tx.get(invRef),p=snap.data();
        tx.update(invRef,{owned:{...p.owned,'1':'evo_restore_ABCDEFGHIJKLMNOPQRST'},
          version:p.version+1,updatedAt:serverTimestamp()});
        tx.set(rewardRef,{childId:'older',kind:'evolution_restore',sourceRewardId:'reward_original',
          catalogVersion:3,pokemonNo:1,claimedAt:serverTimestamp(),claimedBy:'parent-user'});
      });
    }
    await assertFails(restore(kid.firestore()));
    await assertSucceeds(restore(environment.authenticatedContext('parent-user').firestore()));
    const docSnap=await getDoc(doc(kid.firestore(),'households',h,'pokemonInventory','older'));
    assert.equal(docSnap.data().owned['1'],'evo_restore_ABCDEFGHIJKLMNOPQRST');
    assert.equal(docSnap.data().owned['2'],'reward_original');
  });
}
