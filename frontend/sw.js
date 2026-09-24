// The service worker: keeps what someone has already seen readable when the
// network is gone. Registered by pwa.js from every page.
//
// ---- Strategy: network first, for everything ----
//
// Every page, script, stylesheet and API read goes to the network, and the
// cache is consulted only when that fails. Files here keep their names when
// their contents change (/app.js is always /app.js), and the project promises
// that an edit in frontend/ shows on a plain refresh (CLAUDE.md). A
// cache-first worker would break that promise: it would go on serving the
// copy stored at install until the worker itself changed. Online, this worker
// only keeps a copy of what passes through; freshness is still decided by
// the HTTP cache and the server's ETags (no-cache, 304s) exactly as without
// it. Offline, pages come from the cache, and a page never visited gets
// offline.html.
//
// ---- What is cached, and why none of it is private ----
//
//   - the app shell (PRECACHE) and every same-origin static file as fetched,
//     which are the same bytes for every visitor;
//   - pages as navigated to, /tree.html?id=N included: the server fills the
//     tree's public title and description into its <head>, and nothing about
//     the visitor (treeForPage() in server.js);
//   - GET /api/trees and GET /api/trees/:id, which are public and the same
//     for everyone (reading needs no account: CLAUDE.md, "Accounts").
//
// Who is signed in reaches none of it. That is only ever read from
// /api/auth/me, and nothing under /api/auth/ is cached here; the server
// marks every response that depends on the session, or sets a cookie,
// "private, no-store", which this worker refuses to store. So signing out
// has nothing to clear, and the next person on a shared computer can't be
// shown the last one's account. (Set-Cookie itself is invisible to a worker —
// Fetch strips it from every response script can see — which is why the
// no-store rule is the one relied on.)
//
// Never cached: /api/auth/* and every other /api/ path but the two reads
// above; non-GET requests, which aren't even intercepted; responses marked
// no-store or private; anything but a plain same-origin 200 (errors,
// redirects, opaque responses); anything with Vary: *.

// Bump when a file leaves PRECACHE, so the old shell is dropped rather than
// kept beside the new one. Any change to this file makes browsers install it
// again (and re-run the precache); the bump is only about what to delete.
const VERSION = 'v1';
const PREFIX = 'skilltrees-';
const SHELL = `${PREFIX}shell-${VERSION}`;
// Pages and API reads outlive shell versions — dropping every tree someone
// kept for offline because a script changed would be a poor trade. Their own
// suffix changes only if what is stored in them changes shape.
const PAGES = `${PREFIX}pages-v1`;
const DATA = `${PREFIX}data-v1`;
const CURRENT = [SHELL, PAGES, DATA];

// Pages and API reads each keep the most recent this many; the shell is a
// fixed list. Every tree opened would otherwise add two entries for good.
const MAX_ENTRIES = 50;

const OFFLINE_PAGE = '/offline.html';

// The app shell, fetched when the worker installs. addAll() is all or
// nothing, so every entry must exist (tests/api/pwa.test.js checks); a new
// page script belongs here too (CLAUDE.md). The pages are the ones that work
// offline: the homepage (with the tree list below), the viewer, which opens
// files from disk and needs no server at all, and the offline page. Not
// account.html — signing in needs the server, and offline.html says so more
// honestly than a form that can only fail — and not a bare /tree.html, which
// is a new draft and sends a signed-out visitor to account.html.
const PRECACHE = [
  '/',
  '/viewer.html',
  OFFLINE_PAGE,
  '/style.css',
  '/theme.js',
  '/pwa.js',
  '/layout.js',
  '/a11y.js',
  '/app.js',
  '/tree.js',
  '/viewer.js',
  '/fonts/inter-latin.woff2',
  '/favicon.svg',
  '/favicon.svg?v=2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/manifest.webmanifest',
];

// Public data worth having before the first page that uses it is visited
// under this worker: the homepage's tree list. Best effort — a failure here
// doesn't stop the install.
const PRECACHE_DATA = ['/api/trees'];

// Pages that are useless without the server: offline.html instead, even if
// a copy exists.
const NETWORK_ONLY_PAGES = new Set(['/account.html']);

// The two API reads kept for offline: the tree list and one tree. Not
// /api/trees/:id/export or anything else under /api/.
function isPublicRead(url) {
  return url.pathname === '/api/trees' || /^\/api\/trees\/\d+$/.test(url.pathname);
}

// Whether a response may be kept. A private cache is allowed to store
// "private" responses (RFC 9111 §5.2.2.7), but on this site private means
// "about one person's session", so this cache keeps out of them too.
function storable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic' || response.redirected) return false;
  const cacheControl = (response.headers.get('Cache-Control') || '').toLowerCase();
  if (/(^|[\s,])(no-store|private)(?=$|[\s,=])/.test(cacheControl)) return false;
  // Cache.put() refuses Vary: * outright (Service Workers, Cache.put step 5).
  if ((response.headers.get('Vary') || '').includes('*')) return false;
  return true;
}

// Keeps the newest MAX_ENTRIES. A Cache lists its entries oldest first, and
// put() replaces an entry by removing it and appending the new one, so the
// front of keys() is what was fetched longest ago.
async function trim(cacheName) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - MAX_ENTRIES;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function store(cacheName, request, response) {
  if (!storable(response)) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    if (cacheName !== SHELL) await trim(cacheName);
  } catch (e) {
    // Quota, or a body that failed part-way: the page already has its
    // answer, and the cache is only ever a fallback.
  }
}

// Vary: Accept-Encoding and Vary: Cookie name headers a script-made request
// never carries (the browser adds them on the way out), and only public
// responses are stored, so matching ignores Vary rather than miss on it.
async function lookup(request, cacheNames) {
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
  }
  return undefined;
}

async function offlinePage() {
  return (await lookup(OFFLINE_PAGE, [SHELL])) || Response.error();
}

// A navigation. Always answered here, never left to the browser's own
// fallback: with navigation preload on, the browser has already sent the
// request, and a second one would be sent if this worker declined to answer
// — twice for an OAuth callback, whose flow is single use. So even /api/
// navigations (a sign-in callback, an export link) are answered, with the
// preloaded response, and simply not stored.
async function navigate(event, url) {
  const request = event.request;
  const keep = !url.pathname.startsWith('/api/') && !NETWORK_ONLY_PAGES.has(url.pathname);
  try {
    const response = (await event.preloadResponse) || (await fetch(request));
    if (keep) event.waitUntil(store(PAGES, request, response.clone()));
    return response;
  } catch (e) {
    // The network failed outright (offline, server down) — not an HTTP
    // error, which is an answer and goes through above.
    const cached = keep ? await lookup(request, [PAGES, SHELL]) : undefined;
    return cached || offlinePage();
  }
}

async function networkFirst(event, cacheName) {
  const request = event.request;
  try {
    const response = await fetch(request);
    if (response.status === 404 || response.status === 410) {
      // Gone from the server (a deleted tree): gone from here too, so it
      // doesn't reappear the next time the network is down.
      event.waitUntil(caches.open(cacheName).then((cache) => cache.delete(request, { ignoreVary: true })));
    } else {
      event.waitUntil(store(cacheName, request, response.clone()));
    }
    return response;
  } catch (e) {
    const cached = await lookup(request, [cacheName]);
    if (cached) return cached;
    throw e; // what the page would have got with no worker at all
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      // cache: 'no-cache' revalidates with the server rather than trusting
      // whatever the HTTP cache holds, so a new worker precaches what is
      // current.
      await shell.addAll(PRECACHE.map((url) => new Request(url, { cache: 'no-cache' })));
      await Promise.all(
        PRECACHE_DATA.map(async (url) => {
          try {
            const request = new Request(url, { cache: 'no-cache' });
            await store(DATA, request, await fetch(request));
          } catch (e) {
            // best effort
          }
        })
      );
      // A new version takes over at once rather than waiting for every tab
      // to close. Safe here because nothing is served cache-first: a page
      // loaded under the old worker keeps working under the new one.
      await self.skipWaiting();
    })()
  );
});

// The pages open when the worker first takes control were fetched before
// it existed, so none of them went through it. Keep a copy of each (and of
// the tree it shows) now, so the tree someone arrived on through a shared
// link is readable offline too, not only the ones opened after.
async function keepOpenPages() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(
    windows.map(async (client) => {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin) return;
      if (url.pathname.startsWith('/api/') || NETWORK_ONLY_PAGES.has(url.pathname)) return;
      url.hash = '';
      try {
        const page = new Request(url.href);
        await store(PAGES, page, await fetch(page));
        const id = url.pathname === '/tree.html' && /^\d+$/.test(url.searchParams.get('id') || '')
          ? url.searchParams.get('id')
          : null;
        if (id) {
          const data = new Request(`/api/trees/${id}`);
          await store(DATA, data, await fetch(data));
        }
      } catch (e) {
        // best effort
      }
    })
  );
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Navigation preload: the browser starts a navigation's request while
      // this worker is still starting up, instead of after. Pure speed —
      // navigate() uses the response it produces.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith(PREFIX) && !CURRENT.includes(n)).map((n) => caches.delete(n))
      );
      await self.clients.claim();
      await keepOpenPages();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Writes go straight to the network, untouched — as if there were no
  // worker at all. (Navigation preload only ever covers GET navigations.)
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event, url));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    // /api/auth/* and everything else not listed: not intercepted, never
    // stored.
    if (isPublicRead(url)) event.respondWith(networkFirst(event, DATA));
    return;
  }
  event.respondWith(networkFirst(event, SHELL));
});
