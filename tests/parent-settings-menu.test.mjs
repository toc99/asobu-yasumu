import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const fn=app.slice(app.indexOf('function setParentMoreSection('),app.indexOf('function setParentView('));
test('settings menu shows only the selected section, preserves nodes, and returns to overview',()=>{
  const node=(section)=>({dataset:{morePanel:section},hidden:false,open:true,classList:{toggle(name,value){assert.equal(name,'hidden');this.owner.hidden=value;}}});
  const nodes=Object.fromEntries(['parent-settings-menu','parent-more-overview','parent-settings-back','google-home-panel','parent-focus-toolbar'].map(id=>[id,node()]));
  const panels=['family','export','google','manual','audit'].map(node);
  for(const n of [...Object.values(nodes),...panels])n.classList.owner=n;
  const ctx={isParentPage:true,$:id=>nodes[id],document:{querySelectorAll:()=>panels}};
  vm.createContext(ctx);vm.runInContext(fn,ctx);
  for(const section of ['family','export','google','manual','audit','overview']){
    vm.runInContext('setParentMoreSection('+JSON.stringify(section)+')',ctx);
    assert.equal(nodes['parent-settings-menu'].open,false);
    assert.equal(nodes['parent-more-overview'].hidden,section!=='overview');
    assert.equal(nodes['parent-settings-back'].hidden,section==='overview');
    assert.equal(nodes['google-home-panel'].hidden,!['google','manual'].includes(section));
    assert.equal(nodes['parent-focus-toolbar'].hidden,section!=='overview');
    for(const panel of panels)assert.equal(panel.hidden,panel.dataset.morePanel!==section);
  }
});
