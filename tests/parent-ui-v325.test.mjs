import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const app=read('app.js'),parent=read('parent.html'),kid=read('index.html'),feedback=read('feedback.js');
function simulate(name,next,keys,panelAttr,overview,back,extra){
 const node=key=>({dataset:{[panelAttr]:key},hidden:false,open:true,classList:{toggle(c,v){this.owner.hidden=v},add(c){this.owner.hidden=true}}});
 const nodes=Object.fromEntries([overview,back,...extra].map(id=>[id,node()]));
 const panels=keys.map(node);
 for(const n of [...Object.values(nodes),...panels])n.classList.owner=n;
 const ctx={isParentPage:true,$:id=>nodes[id],document:{querySelectorAll:()=>panels}};
 vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('function '+name+'('),app.indexOf('function '+next+'(')),ctx);
 for(const key of ['overview',...keys,'overview']){
   vm.runInContext(name+'('+JSON.stringify(key)+')',ctx);
   assert.equal(nodes[overview].hidden,key!=='overview');
   assert.equal(nodes[back].hidden,key==='overview');
   for(const panel of panels)assert.equal(panel.hidden,panel.dataset[panelAttr]!==key);
   if(nodes['parent-management'])assert.equal(nodes['parent-management'].hidden,key==='overview');
 }
}
test('action and records subviews reveal exactly the selected existing panel',()=>{
 simulate('setParentActionSection','setParentReportSection',['bonus','release','honesty'],'actionPanel','parent-actions-overview','parent-actions-back',['parent-actions-menu','parent-management']);
 simulate('setParentReportSection','setParentMoreSection',['day','week','calendar','weekly'],'reportPanel','parent-reports-overview','parent-reports-back',['parent-focus-toolbar']);
});
test('pending actions are not hidden in occasional controls; reviewed records remain reachable',()=>{
 assert.ok(parent.indexOf('id="retro-report-admin"')<parent.indexOf('id="parent-management"'));
 assert.match(parent,/<details class="parent-fold"><summary>対応済みの活動/);
 assert.match(parent,/<details class="parent-fold"><summary>対応済みの申告/);
 assert.match(app,/root.innerHTML=pending.map\(retroHtml\)/);
 assert.match(app,/retro-reviewed-list/);
 assert.match(app,/retro-threshold/);
});
test('parent navigation preserves unique operational IDs and child navigation is unchanged',()=>{
 for(const id of ['players','activity-approvals','retro-report-list','bonus-admin','pokemon-release-admin','honesty-admin','feedback-parent-list','week-chart','history-date','history-list','effort-calendar-grid','weekly-report','audit-panel','gh-test','settings-form','pokemon-collection']){
   assert.equal(parent.split('id="'+id+'"').length,2,id);
 }
 assert.doesNotMatch(kid,/data-action-section|data-report-section|parent-feedback-tabs/);
 assert.match(feedback,/parentFilters.scope==='needs'\?needsParent\(r\)/);
 assert.match(app,/data-home-actions/);
 assert.match(app,/opened.has\(id\)/);
});
