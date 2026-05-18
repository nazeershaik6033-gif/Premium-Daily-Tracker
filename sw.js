const CACHE = 'etp-cache-v1';
const REMINDER_TAG = 'expense-reminder';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./','./index.html','./manifest.json'])).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if(e.request.method!=='GET')return;
  e.respondWith(caches.match(e.request).then(r=>{
    const fresh=fetch(e.request).then(res=>{if(res&&res.status===200){const c2=res.clone();caches.open(CACHE).then(c=>c.put(e.request,c2))}return res}).catch(()=>null);
    return r||fresh;
  }));
});

self.addEventListener('periodicsync', e => {
  if(e.tag===REMINDER_TAG) e.waitUntil(triggerReminder());
});

async function triggerReminder(){
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  if(clients.length>0){
    clients[0].postMessage({type:'REMINDER_TICK'});
    return;
  }
  return self.registration.showNotification('💰 Expense Reminder',{
    body:"Time to log today's expenses! Tap to open.",
    icon:'./manifest-icon.png',
    badge:'./manifest-icon.png',
    tag:'daily-reminder',
    requireInteraction:false,
    actions:[{action:'open',title:'Open App'},{action:'dismiss',title:'Dismiss'}]
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if(e.action==='dismiss')return;
  e.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
      for(const c of clients){if('focus' in c)return c.focus()}
      return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('message', e => {
  if(e.data?.type==='SKIP_WAITING') self.skipWaiting();
  if(e.data?.type==='SHOW_REMINDER'){
    self.registration.showNotification('💰 Expense Reminder',{
      body:e.data.body||"Time to log today's expenses!",
      icon:'./manifest-icon.png',
      tag:'daily-reminder',
      requireInteraction:false,
      actions:[{action:'open',title:'Open App'}]
    });
  }
});
