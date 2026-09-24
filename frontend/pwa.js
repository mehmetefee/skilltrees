// Registers the service worker (sw.js), which keeps the pages and trees
// someone has already seen readable offline. Loaded with `defer` from every
// page's <head>, after trusted-types.js.
//
// After the page's own load, so the worker's first install — which fetches
// the whole app shell — never competes with what the page needs first.
// Nothing here is required for the site to work: without service worker
// support (or with it blocked, as some private modes do) this does nothing.
(function () {
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    // The script URL is a Trusted Types sink, and pages require trusted
    // values: a plain '/sw.js' would be refused with a TypeError. The
    // service-worker-url policy (trusted-types.js) vouches for this one URL.
    //
    // updateViaCache: 'none' — check for a new worker, and for anything it
    // imports, straight from the server rather than the HTTP cache. sw.js is
    // served no-cache anyway; this makes the intent explicit.
    const script = SkillTreeTrustedTypes.serviceWorkerURL('/sw.js');
    navigator.serviceWorker.register(script, { scope: '/', updateViaCache: 'none' }).catch((e) => {
      // Not worth an error in the console: the site works the same without
      // it, only not offline.
      console.info('Offline support is unavailable:', e.message);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
