const CACHE='asobu-yasumu-v3-13-0-20261114';
const FILES=['./','./index.html','./parent.html','./style.css?v=3.13.0','./app.js?v=3.13.0','./firebase-config.js','./pokedex-data.js','./evolution-data.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('asobu-yasumu')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin)return;
  if(e.request.mode==='navigate'||u.pathname.endsWith('firebase-config.js')){e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));return}
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const c=r.clone();caches.open(CACHE).then(cache=>cache.put(e.request,c)).catch(()=>{})}return r}).catch(()=>caches.match(e.request)));
});

// v3.5: フォアグラウンドで表示したシステム通知をタップするとアプリを開く。
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(
  self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const existing=list.find(client=>client.url.startsWith(self.registration.scope)&&'focus' in client);
    return existing?existing.focus():self.clients.openWindow('./');
  })
);});
