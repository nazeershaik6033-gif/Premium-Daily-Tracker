// Notification-only service worker — no fetch interception to avoid breaking script loading

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('periodicsync', e => {
  if(e.tag==='expense-reminder') e.waitUntil(triggerReminder());
});

async function triggerReminder(){
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  if(clients.length>0){clients[0].postMessage({type:'REMINDER_TICK'});return}
  return self.registration.showNotification('💰 Expense Reminder',{
    body:"Time to log today's expenses! Tap to open.",
    tag:'daily-reminder',
    requireInteraction:false,
    actions:[{action:'open',title:'Open App'},{action:'dismiss',title:'Dismiss'}]
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if(e.action==='dismiss')return;
  e.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cls=>{
      for(const c of cls){if('focus' in c)return c.focus()}
      return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('message', e => {
  if(e.data?.type==='SKIP_WAITING') self.skipWaiting();
  if(e.data?.type==='SHOW_REMINDER'){
    self.registration.showNotification(e.data.title||'💰 Expense Reminder',{
      body:e.data.body||"Time to log today's expenses!",
      tag:e.data.tag||'daily-reminder',
      requireInteraction:false,
      actions:[{action:'open',title:'Open App'}]
    });
  }
});
