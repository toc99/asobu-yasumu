import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
const read=path=>readFileSync(new URL('../'+path,import.meta.url));
const txt=path=>read(path).toString('utf8');
const sw=txt('sw.js');
function crc32(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0;}
function verifyPng(path,n){
 const b=read(path);assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 const idat=[];let pos=8,ended=false;
 while(pos<b.length){const len=b.readUInt32BE(pos),type=b.toString('ascii',pos+4,pos+8),data=b.subarray(pos+8,pos+8+len);assert.equal(crc32(b.subarray(pos+4,pos+8+len)),b.readUInt32BE(pos+8+len));
 if(type==='IHDR'){assert.equal(data.readUInt32BE(0),n);assert.equal(data.readUInt32BE(4),n);assert.equal(data[8],8);assert.equal(data[9],2);}
 if(type==='IDAT')idat.push(data);
 if(type==='IEND')ended=true;
 pos+=12+len;}
 assert.equal(pos,b.length);assert.ok(ended);
 const raw=inflateSync(Buffer.concat(idat));assert.equal(raw.length,n*(1+3*n));
 for(let j=0;j<n;j++)assert.equal(raw[j*(1+3*n)],1);
}
test('child and parent have distinct install identities, launch URLs and iOS icons',()=>{
 for(const [role,html,manifest] of [['kid','index.html','manifest.webmanifest'],['parent','parent.html','parent.webmanifest']]){
 const page=txt(html),m=JSON.parse(txt(manifest));
 assert.equal(m.id,'./'+html);assert.equal(m.start_url,'./'+html);assert.equal(m.scope,'./');assert.equal(m.display,'standalone');
 assert.ok(page.includes('href="'+manifest+'?v=3.26.0" rel="manifest"'));
 assert.ok(page.includes('href="icon-'+role+'-v3251-180.png" rel="apple-touch-icon" sizes="180x180"'));
 assert.ok(sw.includes('./'+manifest+'?v=3.26.0'));
 assert.deepEqual(m.icons.map(i=>i.sizes),['192x192','512x512']);
 for(const n of [180,192,512]){const p='icon-'+role+'-v3251-'+n+'.png';verifyPng(p,n);assert.ok(sw.includes('./'+p));if(n!==180)assert.ok(m.icons.some(i=>i.src===p));}
 }
 assert.notDeepEqual(read('icon-kid-v3251-180.png'),read('icon-parent-v3251-180.png'));
 assert.notEqual(JSON.parse(txt('manifest.webmanifest')).short_name,JSON.parse(txt('parent.webmanifest')).short_name);
});
