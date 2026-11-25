import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('Google Home checkboxes use compact scoped dimensions and inline tappable labels',()=>{
 const css=read('style.css'),html=read('parent.html'),ui=read('google-home-ui.js');
 const rule=css.match(/#google-home-panel \.gh-check-row input\[type="checkbox"\] \{([^}]+)\}/)?.[1];
 assert.ok(rule);for(const property of ['width','height','min-width','min-height','max-width','max-height'])assert.match(rule,new RegExp('(?:^|[;\\s])'+property+':16px;'));
 assert.match(css,/#google-home-panel \.gh-check-row \{\s*display:flex;\s*align-items:center;/);
 assert.match(html,/<label class="gh-check-row"><input id="gh-enabled" type="checkbox"\/>/);
 assert.equal((ui.match(/line\.className='gh-check-row'/g)||[]).length,2);
 assert.match(css,/@media\(pointer:coarse\)\{#google-home-panel \.gh-check-row\{min-height:44px/);
});
