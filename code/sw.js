// GEO Restock service worker — offline caching of app shell, catalog, and images.
const CACHE = 'geo-restock-v1';
const SHELL = ['./', './index.html', './GeothermParts.json'];

// On install: cache the shell + catalog, then pre-cache every part image.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL).catch(() => {});
    try {
      const res = await fetch('./GeothermParts.json', { cache: 'no-store' });
      const parts = await res.json();
      const urls = [...new Set(parts.map(p => p['Image Path']).filter(Boolean))];
      // cache images individually so one failure doesn't abort the batch
      await Promise.all(urls.map(u =>
        fetch(u, { mode: 'no-cors' }).then(r => cache.put(u, r)).catch(() => {})
      ));
    } catch (err) { /* offline or catalog missing — runtime caching will fill in */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

// Cache-first for shell, catalog, and images; everything else hits the network
// (Firebase realtime traffic is never cached). Falls back to cache when offline.
// Manual / weekly refresh: page posts {type:'REFRESH'} → re-pull catalog + images.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'REFRESH') {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch('./GeothermParts.json', { cache: 'no-store' });
        if (res && res.ok) {
          await cache.put('./GeothermParts.json', res.clone());
          const parts = await res.json();
          const urls = [...new Set(parts.map(p => p['Image Path']).filter(Boolean))];
          await Promise.all(urls.map(u =>
            fetch(u, { mode: 'no-cors' }).then(r => cache.put(u, r)).catch(() => {})
          ));
        }
      } catch (err) { /* offline */ }
      const cs = await self.clients.matchAll();
      cs.forEach(c => c.postMessage({ type: 'REFRESHED' }));
    })());
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const isShell = SHELL.some(s => url.pathname.endsWith(s.replace('./', '/')) || url.pathname.endsWith(s.replace('./', '')));
  const isImage = /raw\.githubusercontent\.com/.test(url.host) || /\.(jpg|jpeg|png|webp|gif)$/i.test(url.pathname);

  if (isShell || isImage) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) {
        // refresh in the background when online
        fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); }).catch(() => {});
        return hit;
      }
      try {
        const r = await fetch(req, isImage ? { mode: 'no-cors' } : {});
        if (r) cache.put(req, r.clone());
        return r;
      } catch (err) {
        return hit || Response.error();
      }
    })());
  }
});
