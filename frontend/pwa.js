// Registers the service worker (sw.js), which keeps the pages and trees
// someone has already seen readable offline. Loaded with `defer` from every
// page's <head>.
//
// After the page's own load, so the worker's first install — which fetches
// the whole app shell — never competes with what the page needs first.
// Nothing here is required for the site to work: without service worker
// support (or with it blocked, as some private modes do) this does nothing.
(function () {
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    // updateViaCache: 'none' — check for a new worker, and for anything it
    // imports, straight from the server rather than the HTTP cache. sw.js is
    // served no-cache anyway; this makes the intent explicit.
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((e) => {
      // Not worth an error in the console: the site works the same without
      // it, only not offline.
      console.info('Offline support is unavailable:', e.message);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
