import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('アプリ・共通モジュールのJS構文が正しい',()=>{
  for(const path of ['../app.js','../cycle-policy.js','../early-resume-policy.js','../evolution-recovery.js','../release-notes.js']){
    const file=fileURLToPath(new URL(path,import.meta.url));
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    assert.equal(result.status,0,path+'\n'+result.stderr);
  }
});
