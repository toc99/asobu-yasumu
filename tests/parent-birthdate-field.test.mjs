import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const css=read('style.css');
const parent=read('parent.html');
const notes=read('release-notes.js');

test('both children retain native date-picker fields',()=>{
  for(const id of ['birth-older','birth-younger'])
    assert.match(parent,new RegExp('id="'+id+'"[^>]*type="date"'));
});
test('parent date input has a zero minimum and maximum 100% width',()=>{
  const block=css.match(/body\[data-role="parent"\] #settings-form input\[type="date"\]\s*\{([^}]*)\}/);
  assert.ok(block,'parent-specific date field rule exists');
  for(const rule of ['box-sizing:border-box','width:100%','min-width:0','max-width:100%'])
    assert.ok(block[1].includes(rule),'missing '+rule);
});
test('date field label can shrink within a grid and remains a real date input',()=>{
  assert.match(css,/body\[data-role="parent"\] #settings-form \.child-settings label\s*\{\s*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/input\[type="date"\]::-webkit-date-and-time-value\s*\{\s*min-width:0;/);
});
test('release version and stylesheet cache match v3.28.0',()=>{
  assert.match(notes,/APP_VERSION = 'v3\.28\.0'/);
  assert.match(parent,/style\.css\?v=3\.28\.0/);
  assert.match(read('sw.js'),/asobu-yasumu-v3-28-0-hourly-play/);
});
