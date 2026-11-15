import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const css=read('style.css'),parent=read('parent.html'),kid=read('index.html');
const app=read('app.js'),notes=read('release-notes.js'),sw=read('sw.js');

test('parent page uses a viewport-sized document with no sideways document overflow',()=>{
  assert.match(css,/body\[data-role="parent"\]\s*\{\s*min-width:0;\s*overflow-x:clip;/);
  assert.match(css,/body\[data-role="parent"\]\s+\.container[\s\S]*?\{\s*min-width:0;\s*max-width:100%;/);
  assert.match(css,/body\[data-role="parent"\]\s+\.topinner[\s\S]*?\{\s*min-width:0;\s*max-width:100%;/);
});
test('five parent navigation tabs fit within zero-min-width grid tracks',()=>{
  assert.match(parent,/id="parent-primary-nav"/);
  assert.match(css,/body\[data-role="parent"\]\s+\.ui-primary-nav\.parent-nav\s*\{\s*width:100%;\s*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css,/body\[data-role="parent"\]\s+\.ui-primary-nav\.parent-nav\s+\.ui-nav-button[\s\S]*?min-width:0;/);
});
test('dynamic rest-exception buttons and dashboard content may wrap',()=>{
  assert.match(css,/body\[data-role="parent"\]\s+\.ui-person-summary button,/);
  assert.match(css,/body\[data-role="parent"\]\s+\.ui-dashboard-alert p\s*\{\s*overflow-wrap:anywhere;\s*white-space:normal;/);
  assert.match(app,/data-rest-exception-grant/);
});
test('app, manifest, release note and service worker use v3.17.0',()=>{
  assert.match(notes,/APP_VERSION = 'v3\.17\.0'/);
  assert.match(parent,/style\.css\?v=3\.17\.0/);
  assert.match(kid,/style\.css\?v=3\.17\.0/);
  assert.match(app,/release-notes\.js\?v=3\.17\.0/);
  assert.match(sw,/asobu-yasumu-v3-17-0/);
});
