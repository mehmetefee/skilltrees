// Trusted Types policies: the only place a page makes one. Loaded first, as a
// plain (parser-blocking) script, by every page — ahead of anything that
// could need a policy, whether that script is deferred or not.
//
// Every page is served with (pageCsp() in server.js)
//
//   require-trusted-types-for 'script'; trusted-types service-worker-url
//
// which is W3C Trusted Types: the DOM XSS sinks — innerHTML, outerHTML,
// insertAdjacentHTML, document.write, DOMParser, createContextualFragment, a
// script's src or text, eval and string timers, a worker's or service
// worker's script URL — refuse a plain string and take only a value made by
// a policy the header names. A policy made under any other name, or a second
// time under the same one (the header has no 'allow-duplicates'), throws. So
// this file runs once per page, and every name here is in the header.
//
// There is no HTML policy, on purpose. Every page builds its markup as nodes
// (buildElement() and buildSvgElement() in app.js): text goes in as text and
// is never parsed, so there is no string of markup for a policy to vouch
// for, and a policy that isn't there can't be talked into anything.
//
// And never a policy named "default". The browser hands a default policy
// every plain string that reaches any sink, so it becomes a sanitizer that
// has to guess what each string is for — enforcement turned back into a
// filter. Each policy here has one job, and its callers ask for it by name.
(function () {
  'use strict';

  // A browser without Trusted Types lets sinks take strings, as they always
  // did. The same rules still run there: a "policy" is then the rules object
  // itself, whose create* methods check the value and return the string, so
  // a caller asking for something it shouldn't fails alike in every browser.
  const factory =
    window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function'
      ? window.trustedTypes
      : { createPolicy: (name, rules) => Object.freeze({ ...rules }) };

  // service-worker-url: navigator.serviceWorker.register() takes a
  // TrustedScriptURL (Service Workers, "register"), and pwa.js is the one
  // caller. Exactly /sw.js, compared as a string — not resolved, not a
  // prefix, nothing a query or a second slash could spell its way around.
  // A worker script decides what every page on the origin gets back from
  // the network, so this is the last URL to be generous about.
  const SERVICE_WORKER_SCRIPT = '/sw.js';
  const serviceWorkerPolicy = factory.createPolicy('service-worker-url', {
    createScriptURL(url) {
      if (url !== SERVICE_WORKER_SCRIPT) {
        throw new TypeError(`service-worker-url accepts only ${SERVICE_WORKER_SCRIPT}.`);
      }
      return url;
    },
  });

  // Read-only on window, so no later script can swap a policy out from under
  // the pages that call it.
  Object.defineProperty(window, 'SkillTreeTrustedTypes', {
    value: Object.freeze({
      serviceWorkerURL: (url) => serviceWorkerPolicy.createScriptURL(url),
    }),
  });
})();
