import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
const kid = read('index.html');
const parent = read('parent.html');
const script = read('app.js');
const css = read('style.css');
const release = read('release-notes.js');
const sw = read('sw.js');

test('the kid primary nav contains five accessible destinations including records',()=>{
  const nav=kid.match(/<nav[^>]*id="kid-primary-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav,'kid primary navigation is present');
  assert.equal((nav[1].match(/<button\b/g)||[]).length,5);
  for (const view of ['time','challenge','pokemon','feedback','more'])
    assert.match(nav[1],new RegExp('data-kid-view="'+view+'"'));
  assert.match(nav[0],/aria-label="子ども画面のメニュー"/);
});

test('five columns override legacy four-column nav ID selector',()=>{
  assert.ok(css.lastIndexOf('#kid-primary-nav{grid-template-columns:repeat(5')>
    css.lastIndexOf('#kid-primary-nav{grid-template-columns:repeat(4'));
});

test('the activity explanation reflects five Pokemon lotteries, not the former three limit',()=>{
  assert.doesNotMatch(kid,/活動報酬は1人1日3匹まで/);
  assert.match(kid,/さいしょの5けんは ポケモン/);
  assert.match(kid,/6けんめからは あいぼう/);
  assert.match(script,/const ACTIVITY_POKEMON_MAX = 5;/);
  assert.match(script,/activityOrder\(a\)-activityOrder\(b\)/);
});

test('child next-action text responds to each state without automatically controlling Switch',()=>{
  assert.match(kid,/id="kid-next-action"/);
  assert.match(kid,/Switchを じどうで とめないよ/);
  assert.match(script,/function renderKidNextAction\(now=Date\.now\(\)\)/);
  for (const state of ['playing','watching','resting'])
    assert.ok(script.includes("st==='"+state+"'"),'state '+state+' present');
  assert.match(script,/if\(!isParentPage\)renderKidNextAction\(now\);/);
});

test('parent frequent actions are visible and occasional actions are collapsed',()=>{
  assert.match(parent,/id="activity-section"/);
  assert.match(parent,/id="feedback-admin"/);
  assert.match(parent,/<details class="ui-management-group" id="parent-management">/);
  assert.match(parent,/id="bonus-admin"/);
  assert.match(parent,/id="pokemon-release-admin"/);
  assert.match(script,/view==='home'\|\|view==='actions'/);
});

test('backup tools clearly distinguish private full export and minimal activity analysis',()=>{
  assert.match(parent,/活動実績JSON（分析用）/);
  assert.match(parent,/全体バックアップ（JSON）/);
  assert.match(parent,/データを保存する/);
  assert.match(parent,/活動実績JSONには氏名・生年月日を含みません/);
});

test('release and service worker use the same v3.19.2',()=>{
  assert.match(release,/APP_VERSION = 'v3\.19\.2'/);
  assert.match(kid,/v3\.19\.2/);
  assert.match(parent,/v3\.19\.2/);
  assert.match(sw,/asobu-yasumu-v3-19-2/);
  assert.match(sw,/style\.css\?v=3\.19\.2/);
  assert.match(sw,/app\.js\?v=3\.19\.2/);
});

test('records tab prioritizes play history over release notes',()=>{
  const recordsStart=kid.indexOf('id="kid-pane-more"');
  const history=kid.indexOf('id="history"',recordsStart);
  const release=kid.indexOf('class="card release-notes-shortcut"',recordsStart);
  assert.ok(recordsStart>=0&&history>recordsStart&&release>history);
});

test('parent settings and exports appear before the large Pokédex',()=>{
  const settingsStart=parent.indexOf('id="parent-pane-more"');
  const settings=parent.indexOf('⚙️ 家族の設定',settingsStart);
  const pokedex=parent.indexOf('id="pokemon-collection"',settingsStart);
  assert.ok(settingsStart>=0&&settings>settingsStart&&pokedex>settings);
});
