// Service worker: offline support + reminder notifications.
//
// Caching rules
// - The page (navigations, index.html): network first, so an online open always gets the latest
//   build. The cached copy is used only when the network fails or takes longer than 6 s.
// - Versioned libraries from CDNs (React, Recharts, SheetJS) and Google Fonts: cache first.
// - Other same-origin files (icons, manifest): served from cache, refreshed in the background.
// - Everything else (AI APIs, Google Drive, …) is not touched.

const CACHE = 'etp-shell-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/prop-types/15.8.1/prop-types.min.js',
  'https://unpkg.com/recharts@2.10.4/umd/Recharts.min.js',
  'https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js',
];
const CACHE_FIRST_HOSTS = ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.sheetjs.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // One failed file must not stop the others (or the install).
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await Promise.all(LIBS.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('etp-shell-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const okToCache = r => r && (r.ok || r.type === 'opaque');

async function networkFirstPage(req) {
  const c = await caches.open(CACHE);
  const net = fetch(req).then(res => {
    if (res.ok) c.put('index.html', res.clone());
    return res;
  });
  try {
    return await Promise.race([
      net,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
    ]);
  } catch (err) {
    const hit = (await c.match('index.html')) || (await c.match('./'));
    if (hit) return hit;
    return net; // nothing cached yet: keep waiting for the network
  }
}

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (okToCache(res)) c.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, e) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const scopePath = new URL(self.registration.scope).pathname;
  if (req.mode === 'navigate' || (sameOrigin && (url.pathname === scopePath || url.pathname.endsWith('/index.html')))) {
    e.respondWith(networkFirstPage(req));
  } else if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(req));
  } else if (sameOrigin && !url.pathname.endsWith('/sw.js')) {
    e.respondWith(staleWhileRevalidate(req, e));
  }
});

// ---- Reminders ----

self.addEventListener('periodicsync', e => {
  if (e.tag === 'expense-reminder') e.waitUntil(triggerReminder());
});

async function triggerReminder() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length > 0) { clients[0].postMessage({ type: 'REMINDER_TICK' }); return; }
  return self.registration.showNotification('💰 Expense Reminder', {
    body: "Time to log today's expenses! Tap to open.",
    tag: 'daily-reminder',
    requireInteraction: false,
    actions: [{ action: 'open', title: 'Open App' }, { action: 'dismiss', title: 'Dismiss' }],
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      for (const c of cls) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'SHOW_REMINDER') {
    self.registration.showNotification(e.data.title || '💰 Expense Reminder', {
      body: e.data.body || "Time to log today's expenses!",
      tag: e.data.tag || 'daily-reminder',
      requireInteraction: false,
      actions: [{ action: 'open', title: 'Open App' }],
    });
  }
});
