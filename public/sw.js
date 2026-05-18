// public/sw.js — NovaSentinel Service Worker
// Provides offline situational awareness by caching:
//   - The app shell (HTML, CSS, JS bundles)
//   - Most recent TLE catalogue fetch
//   - Most recent CDM fetch
//
// Cache strategy:
//   - App shell: Cache-first (static assets never change without a new hash)
//   - TLE/CDM data: Network-first with fallback to stale cache
//     (stale data is better than no data for operational awareness)
//
// Install: automatically registered in src/main.js

const CACHE_VERSION    = 'novasentinel-v1';
const APP_SHELL_CACHE  = `${CACHE_VERSION}-shell`;
const DATA_CACHE       = `${CACHE_VERSION}-data`;

// App shell assets (Vite produces content-hashed filenames)
const APP_SHELL_URLS = [
  '/',
  '/index.html',
];

// Network domains whose responses should be cached as TLE/CDM data
const DATA_ORIGINS = [
  'celestrak.org',
  'www.space-track.org',
];

// ── Install: pre-cache app shell ────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(cache => {
      console.log('[SW] Pre-caching app shell');
      return cache.addAll(APP_SHELL_URLS).catch(err => {
        console.warn('[SW] Pre-cache failed (expected in dev):', err.message);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: delete old cache versions ────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('novasentinel-') && k !== APP_SHELL_CACHE && k !== DATA_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: route requests ────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const isDataRequest = DATA_ORIGINS.some(o => url.hostname === o || url.hostname.endsWith(o));

  if (isDataRequest) {
    // Network-first: try fresh data, fall back to cache
    event.respondWith(networkFirst(event.request));
  } else {
    // Cache-first: serve bundled app assets from cache
    event.respondWith(cacheFirst(event.request));
  }
});

// ── Strategies ──────────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — app shell not cached', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      // Cache data with a timestamp header for staleness tracking
      const headers  = new Headers(response.headers);
      headers.set('x-sw-cached-at', new Date().toISOString());
      const stamped  = new Response(await response.clone().blob(), {
        status: response.status,
        headers,
      });
      cache.put(request, stamped);
    }
    return response;
  } catch {
    // Network failed — serve stale data if available
    const cached = await caches.match(request);
    if (cached) {
      const cachedAt = cached.headers.get('x-sw-cached-at');
      console.warn(`[SW] Offline — serving stale TLE/CDM data from ${cachedAt}`);
      return cached;
    }
    return new Response(JSON.stringify({ error: 'Offline, no cached data available' }), {
      status:  503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
