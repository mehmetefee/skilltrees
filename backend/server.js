// Skill Tree backend — plain node:http + node:sqlite, no external dependencies
// (this environment's outbound network policy blocks the npm registry, so
// everything here is built on Node 22's built-ins).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { openDb } = require('./db/init');
const { hasControlChars, logSafe, stripControlChars } = require('./lib/text');
const oauth = require('./lib/oauth');
const meta = require('./lib/meta');
const {
  mediaType,
  isCompressible,
  negotiateEncoding,
  compress,
  etagOf,
  etagForCoding,
  ifNoneMatchHit,
  notModifiedSince,
  appendVary,
  problemBody,
  LruCache,
} = require('./lib/http');
const {
  treeToNotation,
  notationToRecords,
  checkImportable,
  slugify,
  LAYOUT_MODES,
  DEFAULT_LAYOUT,
} = require('./lib/notation');

const PORT = process.env.PORT || 3001;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// PUBLIC_ORIGIN, the site's external origin ("https://skilltrees.example"),
// reduced to a serialised origin, or null when unset or not a URL. Behind a
// proxy that rewrites Host it is the only way to know what browsers will put
// in Origin; unset, everything falls back to the Host header.
const CONFIGURED_ORIGIN = (() => {
  const raw = (process.env.PUBLIC_ORIGIN || '').trim();
  if (!raw) return null;
  try {
    const origin = new URL(raw).origin;
    if (origin !== 'null') return origin;
  } catch {
    // reported below
  }
  console.warn(`PUBLIC_ORIGIN "${logSafe(raw)}" is not an http(s) origin; ignoring it`);
  return null;
})();

const db = openDb();

// ---------- helpers ----------

// Where CSP violation reports go, under the name the Reporting-Endpoints
// header gives it. Same origin, so reports need no CORS and carry no
// third party's idea of what happened on our pages.
const REPORTS_PATH = '/api/reports';

// Permissions Policy (W3C): browser features this site never uses are
// switched off, so no bug, injected markup or embedded frame can reach for
// them. Every token here is one Chromium recognises (checked against 141);
// an unrecognised one costs a console warning on every page load, which is
// why two features that belong in spirit are left out:
//   - bluetooth: Chromium builds without Web Bluetooth (Linux) reject the
//     token. The API is prompt-gated and the CSP admits no third-party
//     script to prompt with, so omitting it costs little.
//   - web-share: the same, and its default allowlist is already 'self',
//     which is exactly what this list would have said.
// identity-credentials-get (FedCM) is left at its default ('self') on
// purpose: it is a sign-in API, and the sign-in work may want it.
// Privacy Sandbox features other than browsing-topics are left out because
// Chrome is retiring them; once it drops a token, the token starts
// producing the same warning. browsing-topics goes the same way when it does.
const PERMISSIONS_POLICY = [
  // sensors, devices, capture
  'accelerometer=()',
  'camera=()',
  'captured-surface-control=()',
  'display-capture=()',
  'gamepad=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
  // things a skill-tree page has no business doing
  'autoplay=()',
  'browsing-topics=()',
  'clipboard-read=()',
  'compute-pressure=()',
  'encrypted-media=()',
  'idle-detection=()',
  'local-fonts=()',
  'otp-credentials=()',
  'payment=()',
  'picture-in-picture=()',
  'screen-wake-lock=()',
  'storage-access=()',
  'window-management=()',
  // this origin only, never a frame: passkeys are coming, and copying a
  // link or going full screen are ordinary page behaviour
  'publickey-credentials-get=(self)',
  'publickey-credentials-create=(self)',
  'clipboard-write=(self)',
  'fullscreen=(self)',
].join(', ');

// The page CSP. 'unsafe-inline' for styles only: several pages carry style
// attributes. Scripts stay strict, which is what stops injected markup
// executing. Violations are reported (report-to for browsers with the
// Reporting API, report-uri for the rest; CSP3 says a browser that
// understands report-to ignores report-uri, so nothing arrives twice).
// upgrade-insecure-requests only on a secure request: on plain-http
// localhost it would rewrite every subresource to an https:// that isn't
// there.
function pageCsp(secure) {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'report-to csp-endpoint',
    `report-uri ${REPORTS_PATH}`,
  ];
  if (secure) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

// The service worker's CSP. A worker is governed by the policy delivered
// with its own script, not by the page that registered it (HTML Standard,
// "run a worker": the worker's policy container is initialised from its
// script's response). The policy every non-page response gets,
// default-src 'none', would therefore forbid the worker's own fetch() —
// every request it makes on a page's behalf, and the precache — so /sw.js
// alone gets this: same-origin fetches, nothing else. No script-src: it
// imports no scripts and evaluates no strings. Registering it needs nothing
// from the page's policy either: worker-src falls back to script-src 'self'.
const WORKER_CSP = [
  "default-src 'none'",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  `report-uri ${REPORTS_PATH}`,
].join('; ');

// Sent on every response: the dispatcher sets these before routing, so a
// response written any other way — a redirect built with res.writeHead, a
// route added later — carries them too. Studies of generated web code
// single these out as the thing that's routinely missing, and the login
// form is exactly the kind of page that suffers for it (framing it is a
// clickjacking attack). `req` is optional so older callers keep working;
// without it the secure-only headers are simply left to the dispatcher.
function securityHeaders(isHtml = false, req = null) {
  const secure = req ? isSecureRequest(req) : false;
  const headers = {
    'X-Content-Type-Options': 'nosniff', // don't let a .json be run as script
    'X-Frame-Options': 'DENY', // for browsers predating frame-ancestors
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Fetch Standard (CORP): no other site may load anything of ours as a
    // subresource — an <img> or <script> pointed at /api/auth/me is how
    // cross-site leaks start. Our own pages are same-origin, so lose nothing.
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Adobe's cross-domain policy files (Flash, Acrobat): none, anywhere.
    'X-Permitted-Cross-Domain-Policies': 'none',
    // Cross-Origin-Embedder-Policy is deliberately absent. It exists to
    // make a page cross-origin isolated so it can use SharedArrayBuffer and
    // precise timers, which nothing here does. It would not break the OAuth
    // redirects or passkeys (neither is an embedded subresource), but it
    // would add a second gate — after the CSP — that any future
    // cross-origin image, such as a provider's avatar, has to pass, and
    // buys no protection CORP and Origin-Agent-Cluster don't already.
  };
  // RFC 6797 §7.2: an HSTS host MUST NOT send the header over plain http
  // (browsers ignore it there anyway, §8.1). Over https, remember it for a
  // year so later plain-http visits are upgraded before they leave the
  // browser.
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  if (isHtml) {
    headers['Content-Security-Policy'] = pageCsp(secure);
    // The rest only mean anything on a document that runs script, which is
    // our pages and nothing else (every other response's CSP forbids script
    // outright), so they aren't repeated on every font and API call.
    //
    // HTML Standard: ask for an origin-keyed agent cluster (and so, in
    // Chromium, a process of our own rather than one shared site-wide).
    // This is the process-isolation half of cross-origin isolation, without
    // COEP's rules about what the page may embed.
    headers['Origin-Agent-Cluster'] = '?1';
    headers['Permissions-Policy'] = PERMISSIONS_POLICY;
    // Reporting API (W3C): names the endpoint the CSP's report-to uses.
    // Relative URLs resolve against the page, so this works on any host.
    headers['Reporting-Endpoints'] = `csp-endpoint="${REPORTS_PATH}"`;
  } else {
    headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  }
  return headers;
}

// Case-insensitive lookup in a plain headers object, since callers spell
// header names however they like.
function headerKey(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}

function headerValue(headers, name) {
  const key = headerKey(headers, name);
  return key === undefined ? undefined : headers[key];
}

function isGetLike(req) {
  return req.method === 'GET' || req.method === 'HEAD';
}

// Below this, compression costs more than it saves: the frame overhead eats
// most of the gain, and a small response fits in one packet either way.
const MIN_COMPRESS_BYTES = 1024;

// Memoised compressed bodies for static files, keyed by path, mtime, size
// and coding: a file compresses once per version and is then served from
// memory. Bounded so the memo can't grow past a few megabytes however many
// files or versions go through it.
const compressedCache = new LruCache({ maxEntries: 200, maxBytes: 8 * 1024 * 1024 });

// A conditional GET (RFC 9110 §13.1). If-None-Match wins: §13.1.3 says a
// recipient MUST ignore If-Modified-Since when If-None-Match is present.
function isNotModified(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match'];
  if (inm !== undefined) return ifNoneMatchHit(inm, etag);
  if (mtimeMs !== undefined) return notModifiedSince(req.headers['if-modified-since'], mtimeMs);
  return false;
}

// RFC 9110 §15.4.5: a 304 carries the fields a cache would update from a 200
// (ETag, Cache-Control, Expires, Vary, Content-Location, and Last-Modified to
// guide it) and nothing describing content it doesn't have. Vary and the
// security headers are already on `res` via setHeader, so they go out too —
// which matters, because a browser merges a 304's headers into the stored
// response, and the wrong CSP on a page's 304 would be the page's CSP from
// then on.
function sendNotModified(res, headers) {
  const keep = {};
  for (const name of ['ETag', 'Cache-Control', 'Expires', 'Content-Location', 'Last-Modified']) {
    const value = headerValue(headers, name);
    if (value !== undefined) keep[name] = value;
  }
  res.writeHead(304, keep);
  res.end();
}

// The one place a response body leaves the server. For a 200 to GET or HEAD
// it adds a strong ETag and answers a matching conditional request with 304;
// for compressible types it negotiates a content coding (RFC 9110 §12.5.3)
// and records the dependency in Vary. `opts.etag` supplies an already-known
// identity ETag and `opts.cacheKey` lets a static file's compressed bytes be
// reused. Never rejects: a response that fails halfway is logged and its
// connection dropped, because there is no status left to send.
async function sendRepresentation(req, res, status, body, headers, opts = {}) {
  // A handler that answers twice is a bug, but not one worth cutting off
  // the first, already-correct answer for.
  if (res.headersSent) {
    console.error(`Response for ${logSafe(req.url)} was already sent; dropped a second ${status}`);
    return;
  }
  try {
    const compressible = isCompressible(headerValue(headers, 'Content-Type'));
    if (compressible) appendVary(res, 'Accept-Encoding');
    let coding =
      compressible && body.length >= MIN_COMPRESS_BYTES
        ? negotiateEncoding(req.headers['accept-encoding'])
        : 'identity';

    const cacheControl = String(headerValue(headers, 'Cache-Control') || '');
    const validate = status === 200 && isGetLike(req) && !/\bno-store\b/.test(cacheControl);
    let baseTag = null;
    if (validate) {
      baseTag = opts.etag || etagOf(body);
      headers.ETag = etagForCoding(baseTag, coding);
      if (isNotModified(req, headers.ETag, opts.mtimeMs)) return sendNotModified(res, headers);
    }

    let out = body;
    if (coding !== 'identity') {
      try {
        const memoKey = opts.cacheKey ? `${opts.cacheKey}\0${coding}` : null;
        out = memoKey ? compressedCache.get(memoKey) : undefined;
        if (!out) {
          out = await compress(body, coding, { level: opts.cacheKey ? 'static' : 'dynamic' });
          if (memoKey) compressedCache.set(memoKey, out, out.length);
        }
        headers['Content-Encoding'] = coding;
      } catch (e) {
        // Compression is an optimisation: if it fails, the plain bytes are
        // still a correct answer — under the plain bytes' own ETag.
        console.error('Compression failed:', e);
        coding = 'identity';
        out = body;
        if (baseTag) headers.ETag = baseTag;
      }
    }

    if (res.headersSent || res.destroyed) return;
    headers['Content-Length'] = out.length;
    res.writeHead(status, headers);
    res.end(out);
  } catch (e) {
    console.error('Response failed:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Internal Server Error\n');
    } else {
      res.destroy();
    }
  }
}

// Cache-Control for API responses (RFC 9111 §5.2.2).
//   - Errors: no-store. A 404 is heuristically cacheable by default, and a
//     tree that was missing a moment ago may exist now.
//   - Anything to do with the session — /api/auth/*, or any response that
//     sets a cookie — private, no-store: it describes one person and must
//     never sit in a cache, shared or not.
//   - Other GETs: no-cache. Stored, but revalidated on every use; the ETag
//     makes that a 304 when nothing changed.
//   - Unsafe methods: no-store. Their responses aren't reused anyway; this
//     just says so.
function apiCacheControl(req, status, headers) {
  if (status >= 400) return 'no-store';
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath.startsWith('/api/auth/') || headerKey(headers, 'Set-Cookie') !== undefined) {
    return 'private, no-store';
  }
  return isGetLike(req) ? 'no-cache' : 'no-store';
}

// Throttled responses say when to come back (RFC 9110 §10.2.3) and which
// policy was hit, in the IETF RateLimit fields. Those are still an
// Internet-Draft (draft-ietf-httpapi-ratelimit-headers-11, May 2026): the
// syntax is Structured Fields, a policy is a String item with q (quota) and
// w (window, seconds), and RateLimit gives r (remaining) and t (seconds
// until the quota is back). Call sites don't know how far into the window
// they are, so the whole window is the honest upper bound — and the draft
// asks that Retry-After not point earlier than the end of that window.
function addRateLimitHeaders(headers) {
  let retry = headerValue(headers, 'Retry-After');
  if (retry === undefined) {
    retry = String(THROTTLE_WINDOW_SEC);
    headers['Retry-After'] = retry;
  }
  const seconds = /^\d+$/.test(String(retry))
    ? Number(retry)
    : Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000)) || THROTTLE_WINDOW_SEC;
  if (headerKey(headers, 'RateLimit-Policy') === undefined) {
    headers['RateLimit-Policy'] = `"attempts";q=${THROTTLE_MAX};w=${THROTTLE_WINDOW_SEC}`;
  }
  if (headerKey(headers, 'RateLimit') === undefined) {
    headers['RateLimit'] = `"attempts";r=0;t=${seconds}`;
  }
}

// Every JSON response. Errors (status >= 400) go out as RFC 9457 problem
// details, application/problem+json, with the { error, problems } members
// this API always had kept alongside — see problemBody() in lib/http.js.
// Returns a promise, but callers needn't await it: it never rejects.
function sendJson(res, status, data, extraHeaders = {}) {
  const req = res.req;
  const isProblem = status >= 400;
  const payload = isProblem ? problemBody(status, data) : data;
  const headers = {
    'Content-Type': isProblem ? 'application/problem+json' : 'application/json',
    ...extraHeaders,
  };
  if (headerKey(headers, 'Cache-Control') === undefined) {
    headers['Cache-Control'] = apiCacheControl(req, status, headers);
  }
  if (status === 429) addRateLimitHeaders(headers);
  // The one 503 we send is "every password slot is busy", which clears in
  // well under a second.
  if (status === 503 && headerKey(headers, 'Retry-After') === undefined) {
    headers['Retry-After'] = '1';
  }
  return sendRepresentation(req, res, status, Buffer.from(JSON.stringify(payload)), headers);
}

// Plain-text answers for the non-API paths (static files, security.txt):
// the status's own phrase, so every one of them reads the same way.
function sendText(res, status, headers = {}) {
  const body = Buffer.from((http.STATUS_CODES[status] || 'Error') + '\n');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

// Whether a request carries content (RFC 9112 §6.3): a Content-Length above
// zero, or any Transfer-Encoding.
function requestHasBody(req) {
  const len = req.headers['content-length'];
  if (len !== undefined) return Number(len) > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

const MAX_BODY_BYTES = 1e6;

// 413 (RFC 9110 §15.5.14), with Connection: close: the rest of an oversized
// body is not worth reading just to keep the connection open.
function bodyTooLarge(limit) {
  return Object.assign(new Error(`Request bodies are limited to ${limit} bytes.`), {
    statusCode: 413,
    headers: { Connection: 'close' },
  });
}

// The raw bytes of a request body, up to `limit`. A declared Content-Length
// over the limit is refused before a byte is read. One that turns out too
// large part-way stops being read; the request is not destroyed, because
// destroying it also destroyed the socket the 413 was meant to go out on.
function readRawBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.bodyRefused = true;
      return reject(bodyTooLarge(limit));
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      fn(value);
    };
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        req.bodyRefused = true;
        return finish(reject, bodyTooLarge(limit));
      }
      chunks.push(c);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks));
    const onError = (e) => finish(reject, e);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

// A JSON request body. The dispatcher has already refused any body that
// isn't declared application/json (415), so this only has to parse it.
async function readBody(req) {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    // A bad body is the caller's mistake, not a server fault.
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
  // Valid JSON that isn't an object (null, a number, an array) would make
  // every `body.field` read below either throw or behave oddly.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Request body must be a JSON object'), { statusCode: 400 });
  }
  return parsed;
}

function clean(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

// For a field that is one line: a title, a skill name, an author. Control
// characters come out, because these end up in log lines and in the
// operator's terminal, where an escape sequence rewrites what a person sees.
function cleanLine(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return stripControlChars(str).trim().slice(0, maxLen);
}

// For a field that is a paragraph. Newlines and tabs are part of the text;
// everything else in the control range is not.
function cleanText(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return stripControlChars(str, { keepWhitespace: true }).trim().slice(0, maxLen);
}


// ---------- accounts ----------
//
// Trees belong to the account that made them, and only that account can change
// them. Written against OWASP ASVS (V2 authentication, V3 session management)
// and NIST SP 800-63B, using only node:crypto so the zero-dependency property
// holds. The specific rules each measure comes from are noted inline.

// Over HTTPS the session cookie is __Host-skilltree_session, and only that
// name is accepted there. The prefix makes the browser refuse the cookie
// unless it was set Secure, from a secure page, with Path=/ and no Domain —
// so a sibling subdomain, or anyone on the network while the site is loaded
// over plain http, cannot plant a session cookie of their choosing (session
// fixation by cookie tossing). Reading the plain name as well would reopen
// exactly that door, which is why it is ignored on a secure request. Plain
// http (localhost development) can't carry the prefix and keeps the old name.
const SESSION_COOKIE = 'skilltree_session';
const SECURE_SESSION_COOKIE = '__Host-skilltree_session';

// NIST 800-63B 5.1.1.2: at least 8 characters, and accept long ones. The upper
// bound only exists so a huge body can't be turned into expensive hashing.
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 4096;

// Absolute and idle session lifetimes (ASVS V3.3).
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
// Enough to name a browser and a platform; real ones run 100-200 characters.
const MAX_USER_AGENT = 256;

// OWASP Password Storage Cheat Sheet's minimum scrypt configuration. Node's
// own default is N=2^14 (~16 MiB), which is well under it.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keyLen: 64, maxmem: 256 * 1024 * 1024 };
const scryptAsync = promisify(crypto.scrypt);
// Used to spend the same time hashing when the username doesn't exist.
const DUMMY_SALT = crypto.randomBytes(16);

// How many derivations may be in flight at once.
//
// scrypt runs on the libuv threadpool, which defaults to four threads and is
// shared with fs — including the fs.readFile that serves every page. Left
// uncapped, enough concurrent hashes pin every thread at 128 MiB each and the
// site stops answering at all: not just logins, but the static files too. Two
// leaves half the pool for everything else, and still allows a login every
// couple of hundred milliseconds, which is far more than this site needs.
// Past the cap a caller is told to come back rather than joining a queue that
// would make the wait worse for everyone.
const MAX_CONCURRENT_HASHES = 2;
let hashesInFlight = 0;

// Async rather than scryptSync: at this cost a hash takes a few hundred ms,
// and the sync version would stall every other request for that long.
async function derive(password, salt, keyLen, params) {
  if (hashesInFlight >= MAX_CONCURRENT_HASHES) {
    throw Object.assign(new Error('The server is busy. Please try again in a moment.'), {
      statusCode: 503,
    });
  }
  hashesInFlight++;
  try {
    return await scryptAsync(password, salt, keyLen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT.maxmem,
    });
  } finally {
    hashesInFlight--;
  }
}

// Stored self-describing, so the cost can be raised later without stranding
// existing passwords (they verify with the parameters they were made with).
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, SCRYPT.keyLen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// An account made through another provider has no password, and stores this
// in users.password_hash. A sentinel rather than NULL because the column is
// NOT NULL, and relaxing that in SQLite means rebuilding the table — the one
// migration this schema makes dangerous: sessions and trees both reference
// users, and with foreign keys on, DROP TABLE users deletes every session
// through ON DELETE CASCADE (and fails on trees). An empty string is never a
// valid scrypt record, so passwordMatches() refuses it on its own; the login
// route still spends a hash on it, for the same reason it does for unknown
// usernames.
const NO_PASSWORD = '';
const hasPassword = (row) => typeof row.password_hash === 'string' && row.password_hash !== NO_PASSWORD;

async function passwordMatches(password, stored) {
  if (stored === NO_PASSWORD) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const candidate = await derive(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  // Constant-time: a plain === leaks how much of the hash matched.
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// NIST 800-63B 5.1.1.2 requires refusing passwords that are known to be
// common. A full breach corpus needs a dependency and a data file; this is the
// head of the published lists, plus the giveaways specific to this site.
const COMMON_PASSWORDS = new Set([
  '123456', '123456789', '12345678', 'password', 'qwerty', 'qwerty123', '111111',
  '12345', 'abc123', '1234567', 'password1', 'password123', '1234567890', '123123',
  'iloveyou', 'admin', 'welcome', 'monkey', 'letmein', 'dragon', 'sunshine',
  'princess', 'football', 'baseball', 'superman', 'trustno1', 'whatever',
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'passw0rd', 'p@ssword', 'changeme',
  'skilltree', 'skilltrees', 'secret', 'letmein123',
]);

function passwordProblem(password, username) {
  if (password.length < MIN_PASSWORD) {
    return `Passwords need at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) {
    return 'That password is too long.';
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    return 'That password is one of the most commonly used ones. Please pick another.';
  }
  if (username && lowered.includes(username.toLowerCase())) {
    return 'Please pick a password that does not contain your username.';
  }
  if (new Set(password).size === 1) {
    return 'Please pick a password with more than one character repeated.';
  }
  return null;
}

// ASVS V2.2.1: limit consecutive failed attempts. Persisted in SQLite so a
// restart does not give attackers a fresh window.
//
// The counting happens *before* the password is checked, never after. With
// the increment on the far side of the deliberately slow scrypt, every
// request that arrived while a hash was running read the same pre-increment
// number: 500 simultaneous guesses all passed a limit of ten, because none of
// them had finished failing yet. node:sqlite is synchronous and there is no
// await inside noteAttempt(), so concurrent requests queue behind each other
// and each one sees the previous one's count.
const THROTTLE_MAX = 10;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_WINDOW_SEC = Math.floor(THROTTLE_WINDOW_MS / 1000);

function clientIp(req) {
  // Deliberately the socket address, not X-Forwarded-For: that header is
  // caller-supplied, so trusting it here would let anyone reset their own
  // limit. Behind a proxy this needs the proxy's real-IP handling instead.
  return req.socket.remoteAddress || 'unknown';
}

function throttled(key) {
  const row = db.prepare(
    `SELECT count FROM rate_limits
      WHERE key = ? AND first_at > datetime('now', ?)`
  ).get(key, `-${THROTTLE_WINDOW_SEC} seconds`);
  return row ? row.count >= THROTTLE_MAX : false;
}

// Counts this attempt and says whether it has gone past the limit. Call it
// before doing the expensive work the limit is meant to ration.
function overLimit(key) {
  return noteAttempt(key) > THROTTLE_MAX;
}

function noteAttempt(key) {
  const updated = db.prepare(
    `UPDATE rate_limits SET count = count + 1
      WHERE key = ? AND first_at > datetime('now', ?)`
  ).run(key, `-${THROTTLE_WINDOW_SEC} seconds`);
  if (updated.changes > 0) {
    return db.prepare('SELECT count FROM rate_limits WHERE key = ?').get(key).count;
  }
  db.prepare(
    `INSERT OR REPLACE INTO rate_limits (key, count, first_at)
     VALUES (?, 1, datetime('now'))`
  ).run(key);
  return 1;
}

// Takes back one attempt, without touching the ones before it. A successful
// login should not count against the address it came from — people sign in
// from shared addresses all day — but it must not wipe the failures already
// recorded there either, which is what made the old clear-on-success a way
// to spray guesses and then reset the counter with one login of your own.
function undoAttempt(key) {
  db.prepare(
    `UPDATE rate_limits SET count = count - 1
      WHERE key = ? AND count > 0 AND first_at > datetime('now', ?)`
  ).run(key, `-${THROTTLE_WINDOW_SEC} seconds`);
}

function recordFailure(key) {
  const updated = db.prepare(
    `UPDATE rate_limits SET count = count + 1
      WHERE key = ? AND first_at > datetime('now', ?)`
  ).run(key, `-${THROTTLE_WINDOW_SEC} seconds`);
  if (updated.changes === 0) {
    db.prepare(
      `INSERT OR REPLACE INTO rate_limits (key, count, first_at)
       VALUES (?, 1, datetime('now'))`
    ).run(key);
  }
}

function clearThrottle(key) {
  db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
}

function parseId(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// 256 bits of randomness, well past the 64 ASVS V3.2.2 asks for.
//
// Each session also gets what the account page's list of sessions shows
// (ASVS V3.3.4). public_id is the handle that list and "end this session"
// use: random and unrelated to the token, because anything derived from
// token_hash — even a prefix — hands out part of the lookup key, and the
// rowid would tell one account how many sessions everyone else has. The
// user agent is kept, cut short and with control characters out, only so a
// person can tell their own devices apart. It is caller-supplied and shown
// only to that caller's own account, as text.
//
// No IP address is stored, deliberately (GDPR Art. 5(1)(c), data
// minimisation). An address is personal data, and one per session would
// build a location history for every account that then has to be secured,
// exported and erased with it — to answer a question ("is that me?") the
// device name and the sign-in time already answer. Throttling needs the
// address only for the moment of the request, and the log line it goes to
// is the operator's, not the account's.
//
// `req` is optional so a caller that has none still gets a session; it then
// shows as an unknown device.
function startSession(userId, req = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, public_id, user_agent)
     VALUES (?, ?, datetime('now', ?), ?, ?)`
  ).run(
    hashToken(token),
    userId,
    `+${Math.floor(SESSION_ABSOLUTE_MS / 1000)} seconds`,
    crypto.randomBytes(16).toString('hex'),
    cleanLine(req && req.headers['user-agent'], MAX_USER_AGENT)
  );
  return token;
}

function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function sessionCookieName(req) {
  return isSecureRequest(req) ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

// The session token this request carries under the name its scheme allows.
function sessionToken(req) {
  return parseCookies(req)[sessionCookieName(req)] || null;
}

// HttpOnly so page scripts can't read it; Lax so it rides along with ordinary
// navigation but not with cross-site form posts, which is the CSRF vector;
// Secure whenever the connection can carry it (plain http on localhost can't).
// Path=/ and no Domain are what the __Host- prefix requires.
function sessionCookie(token, req) {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (isSecureRequest(req)) flags.push('Secure');
  const maxAge = token ? Math.floor(SESSION_ABSOLUTE_MS / 1000) : 0;
  return `${sessionCookieName(req)}=${token || ''}; ${flags.join('; ')}; Max-Age=${maxAge}`;
}

function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT sessions.token_hash, users.id, users.username
         FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
          AND sessions.expires_at > datetime('now')
          AND sessions.last_used_at > datetime('now', ?)`
    )
    .get(hashToken(token), `-${Math.floor(SESSION_IDLE_MS / 1000)} seconds`);
  if (!row) return null;

  // Keeps the idle window rolling. Only written once a minute so that reading
  // a page isn't a database write every time.
  db.prepare(
    `UPDATE sessions SET last_used_at = datetime('now')
      WHERE token_hash = ? AND last_used_at < datetime('now', '-60 seconds')`
  ).run(row.token_hash);

  return { id: row.id, username: row.username };
}

function purgeExpiredSessions() {
  db.prepare(
    `DELETE FROM sessions
      WHERE expires_at <= datetime('now')
         OR last_used_at <= datetime('now', ?)`
  ).run(`-${Math.floor(SESSION_IDLE_MS / 1000)} seconds`);

  // Clean up expired rate-limit entries.
  db.prepare(
    `DELETE FROM rate_limits WHERE first_at <= datetime('now', ?)`
  ).run(`-${THROTTLE_WINDOW_SEC} seconds`);

  // Sign-ins sent to a provider that never came back. The callback refuses
  // them anyway once expired; this only keeps the table from growing.
  db.prepare(`DELETE FROM oauth_flows WHERE expires_at <= datetime('now')`).run();
}

// Answers "may this request change this tree?", replying to the client itself
// when the answer is no. Returns null in that case, so callers just bail out.
function ownedTree(req, res, treeId) {
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(treeId);
  if (!tree) {
    sendJson(res, 404, { error: 'Tree not found' });
    return null;
  }
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Sign in to make changes.' });
    return null;
  }
  if (tree.user_id === null) {
    sendJson(res, 403, { error: 'This tree was made before accounts existed and is read-only.' });
    return null;
  }
  if (tree.user_id !== user.id) {
    sendJson(res, 403, { error: 'Only the account that made this tree can change it.' });
    return null;
  }
  return { tree, user };
}

// Same, for a request that acts on a skill or a link rather than a tree.
function ownedTreeOf(req, res, treeId) {
  return treeId == null ? (sendJson(res, 404, { error: 'Not found' }), null) : ownedTree(req, res, treeId);
}

// Detect whether adding an edge (skillId depends on prereqId) would create a
// cycle in the prerequisite graph of this tree. We walk backwards from
// prereqId through its own prerequisites; if we reach skillId, it's a cycle.
function wouldCreateCycle(treeId, skillId, prereqId) {
  if (skillId === prereqId) return true;
  const getPrereqs = db.prepare(
    'SELECT prereq_skill_id AS id FROM prereqs WHERE tree_id = ? AND skill_id = ?'
  );
  const seen = new Set();
  const stack = [prereqId];
  while (stack.length) {
    const current = stack.pop();
    if (current === skillId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const row of getPrereqs.all(treeId, current)) {
      stack.push(row.id);
    }
  }
  return false;
}

// ---------- route handlers ----------

const routes = [];
const JSON_BODY = ['application/json'];
// `options.accepts` lists the media types a route takes as a request body;
// the default is JSON. A body of any other type is refused with 415 before
// the handler runs (see unsupportedBody()).
function route(method, pattern, handler, options = {}) {
  // pattern like /api/trees/:id -> regex with named captures
  const paramNames = [];
  const regexStr = pattern.replace(/:[^/]+/g, (m) => {
    paramNames.push(m.slice(1));
    return '([^/]+)';
  });
  const regex = new RegExp(`^${regexStr}$`);
  routes.push({ method, regex, paramNames, handler, accepts: options.accepts || JSON_BODY });
}

// ---------- auth endpoints ----------

route('POST', '/api/auth/signup', async (req, res) => {
  if (throttled(`signup:${clientIp(req)}`)) {
    console.log(`[AUTH] signup throttled ip=${clientIp(req)}`);
    return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
  }

  const body = await readBody(req);
  const username = clean(body.username, 40);
  const password = typeof body.password === 'string' ? body.password : '';

  // Note what does and doesn't count towards the limit. Telling someone their
  // password is too short costs an attacker nothing and reveals nothing, so
  // counting it would only lock out people fumbling their own signup. Probing
  // which usernames are taken is the part worth rationing.
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username)) {
    return sendJson(res, 400, {
      error: 'Usernames are 3-40 characters, letters, numbers, dash or underscore.',
    });
  }
  const problem = passwordProblem(password, username);
  if (problem) {
    return sendJson(res, 400, { error: problem });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    recordFailure(`signup:${clientIp(req)}`);
    return sendJson(res, 409, { error: 'That username is taken.' });
  }

  // Everything that gets this far is about to spend a scrypt — 128 MiB and a
  // few hundred milliseconds of a threadpool thread — so this is the point
  // the limit has to count, not just the probes for taken usernames. A fresh
  // username every time used to reach the hash without touching any counter
  // at all, which made a 200-byte request worth a thousand times its weight
  // in server work. Rejections above this line still cost nothing and still
  // do not count: no hash has run for them.
  if (overLimit(`signup:${clientIp(req)}`)) {
    console.log(`[AUTH] signup throttled ip=${clientIp(req)}`);
    return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
  }

  const passwordHash = await hashPassword(password);

  // The check above can go stale while the (deliberately slow) hash runs, so
  // the UNIQUE constraint is what actually decides. Without this, two people
  // claiming a name at once would get a 500 instead of being told it's taken.
  let id;
  try {
    id = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash).lastInsertRowid;
  } catch (e) {
    recordFailure(`signup:${clientIp(req)}`);
    return sendJson(res, 409, { error: 'That username is taken.' });
  }

  console.log(`[AUTH] signup success user=${username} id=${id} ip=${clientIp(req)}`);
  sendJson(res, 201, { id, username }, { 'Set-Cookie': sessionCookie(startSession(id, req), req) });
});

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readBody(req);
  const username = clean(body.username, 40);
  const password = typeof body.password === 'string' ? body.password : '';

  // Throttled per address, and per account *within* an address (ASVS V2.2.1).
  //
  // The account key deliberately carries the address too. Keyed on the
  // username alone it was a weapon rather than a defence: the username is
  // supplied by whoever is asking, so ten junk attempts against a name read
  // off the public tree list locked the real owner out of their own account,
  // renewably, forever. Keying it per address keeps one address from working
  // through one account while leaving nobody able to lock out anyone else.
  // What that gives up is a limit on one account attacked from many addresses
  // at once; NIST 800-63B argues against account-wide lockout for exactly the
  // reason above, and the per-address count still rations each attacker.
  const ipKey = `login:${clientIp(req)}`;
  const userKey = `login-user:${username.toLowerCase()}:${clientIp(req)}`;
  // Counted now, before the hash below, so that requests arriving together
  // cannot all slip through on the same stale number.
  const overIp = overLimit(ipKey);
  const overUser = overLimit(userKey);
  if (overIp || overUser) {
    console.log(`[AUTH] login throttled ip=${clientIp(req)} user=${logSafe(username)}`);
    return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // An unknown username still pays for a hash. Returning early would make a
  // wrong-username reply noticeably faster than a wrong-password one, which
  // tells an attacker which accounts exist however careful the wording is.
  // An account with no password (made through GitHub, say) pays too, and
  // gets the same reply: otherwise the timing would say which accounts have
  // no password to guess, and the wording which ones exist.
  const ok =
    user && hasPassword(user)
      ? await passwordMatches(password, user.password_hash)
      : (await derive(password, DUMMY_SALT, SCRYPT.keyLen, SCRYPT), false);

  if (!ok) {
    // Already counted above; nothing to add here.
    console.log(`[AUTH] login failed ip=${clientIp(req)} user=${logSafe(username)}`);
    // Same message either way, for the same reason.
    return sendJson(res, 401, { error: 'Wrong username or password.' });
  }

  // This attempt succeeded, so it should not count against the address —
  // but the failures recorded before it still should. Clearing the address
  // key outright let an attacker who held one account of their own (and
  // signup hands those out freely) spray nine guesses at other people's
  // accounts, log in as themselves to zero the counter, and repeat without
  // limit. The account key, which is this person's own fumbling, is forgiven
  // in full.
  undoAttempt(ipKey);
  clearThrottle(userKey);
  console.log(`[AUTH] login success user=${user.username} id=${user.id} ip=${clientIp(req)}`);
  sendJson(
    res,
    200,
    { id: user.id, username: user.username },
    { 'Set-Cookie': sessionCookie(startSession(user.id, req), req) }
  );
});

route('POST', '/api/auth/logout', async (req, res) => {
  const user = currentUser(req);
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  console.log(`[AUTH] logout user=${user ? user.username : 'unknown'} ip=${clientIp(req)}`);
  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': sessionCookie(null, req),
    // W3C Clear Site Data: the browser drops this site's cookies as well as
    // the one named above — including a plain-named session cookie left over
    // from before the __Host- rename, and the flow cookie of a sign-in that
    // was never finished. "cookies" and nothing more: "storage" would also
    // wipe the tree the viewer keeps in sessionStorage, "cache" would throw
    // away every file for no gain, and "executionContexts" reloads every open
    // tab of the site — none of which signing out needs. Browsers act on it
    // only over HTTPS (and localhost); the Set-Cookie above still works
    // everywhere. It covers the whole registrable domain, so a deployment on
    // a subdomain of a domain shared with other apps should drop it.
    'Clear-Site-Data': '"cookies"',
  });
});

route('GET', '/api/auth/me', async (req, res) => {
  const user = currentUser(req);
  if (!user) return sendJson(res, 200, { user: null });
  // Whether a password is set, so the account page can say so; accounts made
  // through another provider have none until one is added.
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  sendJson(res, 200, { user: { ...user, has_password: hasPassword(row) } });
});

// ---------- sign-in through another provider (OAuth 2.0 / OpenID Connect) ----------
//
// "Continue with GitHub / Google / your SSO". This site is the client (the
// relying party); lib/oauth.js talks to the providers and this section owns
// what the browser and the database see: the flow state, the cookie binding
// a flow to the browser that started it, and which account an identity
// signs in to. Written against RFC 9700 (the OAuth 2.0 Security BCP) and the
// OAuth 2.1 draft, RFC 7636 (PKCE), RFC 9207 (iss), and OpenID Connect Core.
//
//   POST /api/auth/oauth/:provider/start     -> { authorization_url }
//   GET  /api/auth/oauth/:provider/callback  <- the provider sends the browser back here
//
// Start is a POST with a JSON body, not a link or a form, on purpose. A GET
// start would be a CSRF target the Origin check never sees: any page could
// start a "link" flow for a signed-in visitor. And a form that posts here and
// is answered with a redirect to github.com is blocked by CSP form-action
// 'self', which current browsers enforce across the redirect. So the page
// fetch()es the start and then navigates to the URL it gets back.

const OAUTH = oauth.configureProviders(process.env);

const OAUTH_FLOW_TTL_SEC = 10 * 60;
// A ceiling on unfinished sign-ins across every address. The per-address
// throttle rations one caller; this bounds what many addresses at once (one
// IPv6 prefix holds billions) can make the table hold.
const MAX_PENDING_OAUTH_FLOWS = 5000;

// The cookie that binds a flow to the browser that started it. Without it, a
// callback URL is a bearer credential: an attacker who starts a sign-in with
// their own account at the provider, stops before the last redirect and gets
// someone else's browser to open the callback URL, signs that person in as
// the attacker (login CSRF, RFC 9700 §4.7) — and whatever they then make is
// the attacker's to read. SameSite=Lax, not Strict: the callback is a
// cross-site top-level navigation from the provider, and a Strict cookie is
// not sent with it. __Host- over HTTPS for the same reason as the session.
const OAUTH_FLOW_COOKIE = 'skilltree_oauth';

function flowCookieName(req) {
  return isSecureRequest(req) ? `__Host-${OAUTH_FLOW_COOKIE}` : OAUTH_FLOW_COOKIE;
}

function flowCookie(value, req) {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (isSecureRequest(req)) flags.push('Secure');
  return `${flowCookieName(req)}=${value || ''}; ${flags.join('; ')}; Max-Age=${value ? OAUTH_FLOW_TTL_SEC : 0}`;
}

// A 303 See Other, for the callback. Its own small helper rather than a
// change to sendJson: this is the one route that answers with a navigation.
// no-store because the response sets a session cookie; the Referrer-Policy
// in securityHeaders() is what keeps the code and state in the callback URL
// out of the Referer of wherever the browser goes next (RFC 9700 §4.2.4).
function redirectTo(res, location, cookies = []) {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
    ...securityHeaders(),
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end();
}

// Where a sign-in may send someone afterwards: a path on this site, decided
// by resolving it rather than by pattern — the same rule as sameSitePath() in
// app.js, and checked again here because the browser's copy is only a
// convenience. A control character is refused outright (browsers strip tab
// and newline *after* any check, which is how "/\t/evil.example" becomes
// protocol-relative), as is anything starting "//" or "/\" .
function safeNextPath(next, fallback) {
  if (typeof next !== 'string' || next === '' || next.length > 2048) return fallback;
  if (hasControlChars(next)) return fallback;
  if (next[0] !== '/' || next[1] === '/' || next[1] === '\\') return fallback;
  const base = 'http://same-origin.invalid';
  let url;
  try {
    url = new URL(next, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  return url.pathname + url.search + url.hash;
}

// How many independent ways this account can still sign in, leaving out the
// identity `excludingIdentityId` when given. Removing a method is refused
// when this would reach zero. Only identities whose provider is configured
// right now count: one the operator has since switched off is not a way in.
// Passkeys, when they land, are one more term in this sum.
function signInMethodCount(userId, { excludingIdentityId = null } = {}) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user) return 0;
  let count = hasPassword(user) ? 1 : 0;
  const identities = db
    .prepare('SELECT id, issuer FROM user_identities WHERE user_id = ?')
    .all(userId);
  const liveIssuers = new Set([...OAUTH.providers.values()].map((p) => p.issuer));
  for (const identity of identities) {
    if (identity.id !== excludingIdentityId && liveIssuers.has(identity.issuer)) count++;
  }
  return count;
}

// A username for an account made through a provider: its login, preferred
// username or email local part, reduced to what signup accepts
// (^[a-zA-Z0-9_-]{3,40}$) and made unique — case-insensitively, since the
// column is NOCASE — with -2, -3, ... Synchronous from the check to the
// INSERT that follows it, so two sign-ins can't pick the same name between.
function usernameFor(hint) {
  let base = String(hint || '');
  const at = base.indexOf('@');
  if (at > 0) base = base.slice(0, at);
  base = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    // Leaves room for a "-999" suffix inside the 40-character limit.
    .slice(0, 36);
  if (base.length < 3) base = base ? `user-${base}` : 'user';

  const taken = db.prepare('SELECT 1 FROM users WHERE username = ?');
  if (!taken.get(base)) return base;
  for (let n = 2; n < 1000; n++) {
    if (!taken.get(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base.slice(0, 33)}-${crypto.randomBytes(3).toString('hex')}`;
}

route('GET', '/api/auth/providers', async (req, res) => {
  // toJSON() on a provider is { id, name }: no client id, no secret.
  sendJson(res, 200, [...OAUTH.providers.values()]);
});

route('POST', '/api/auth/oauth/:provider/start', async (req, res, params) => {
  const provider = OAUTH.providers.get(params.provider);
  if (!provider) return sendJson(res, 404, { error: 'That sign-in provider is not available.' });

  // Each start writes a row for an unauthenticated caller, so it is rationed
  // per address, counted before any work. A sign-in that completes gives its
  // count back (see the callback), the way a successful password login does.
  if (overLimit(`oauth-start:${clientIp(req)}`)) {
    console.log(`[AUTH] oauth start throttled provider=${provider.id} ip=${clientIp(req)}`);
    return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
  }

  const body = await readBody(req);
  const intent = body.intent === undefined ? 'login' : body.intent;
  if (intent !== 'login' && intent !== 'link') {
    return sendJson(res, 400, { error: 'intent must be "login" or "link".' });
  }

  // Linking attaches whatever account the provider returns to the account
  // signed in *now*, so it is only offered to someone signed in, and the
  // callback insists the same account is still signed in when it finishes.
  // A login flow never links, whoever is signed in: auto-linking there would
  // let an attacker who can complete a flow in someone's browser attach
  // their own provider account to that person's account and sign in as them.
  let linkUserId = null;
  if (intent === 'link') {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'Sign in first to connect another account.' });
    linkUserId = user.id;
  }
  const nextPath = safeNextPath(body.next, intent === 'link' ? '/account.html' : '/#browse');

  const pending = db
    .prepare(`SELECT COUNT(*) AS n FROM oauth_flows WHERE expires_at > datetime('now')`)
    .get().n;
  if (pending >= MAX_PENDING_OAUTH_FLOWS) {
    console.log(`[AUTH] oauth start refused: ${pending} flows pending ip=${clientIp(req)}`);
    return sendJson(res, 503, { error: 'Sign-in is busy. Please try again in a moment.' });
  }

  const state = oauth.randomToken();
  const browser = oauth.randomToken();
  const verifier = oauth.randomToken();
  const nonce = provider.kind === 'oidc' ? oauth.randomToken() : null;

  let authorizationUrl;
  try {
    authorizationUrl = await provider.authorizationUrl({
      state,
      codeChallenge: oauth.pkceChallenge(verifier),
      nonce,
    });
  } catch (e) {
    console.log(`[AUTH] oauth start failed provider=${provider.id} reason="${logSafe(e.message, 200)}"`);
    return sendJson(res, 503, { error: `Signing in with ${provider.name} is not available right now.` });
  }

  db.prepare(
    `INSERT INTO oauth_flows
       (state_hash, browser_hash, provider, code_verifier, nonce, intent, next_path, link_user_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  ).run(
    hashToken(state),
    hashToken(browser),
    provider.id,
    verifier,
    nonce,
    intent,
    nextPath,
    linkUserId,
    `+${OAUTH_FLOW_TTL_SEC} seconds`
  );

  sendJson(
    res,
    200,
    { authorization_url: authorizationUrl },
    { 'Set-Cookie': flowCookie(browser, req), 'Cache-Control': 'no-store' }
  );
});

route('GET', '/api/auth/oauth/:provider/callback', async (req, res, params) => {
  const query = new URLSearchParams(req.url.split('?')[1] || '');
  const clearFlow = flowCookie(null, req);
  const providerId = logSafe(params.provider, 20);
  let flow = null;

  // Every failure ends on the account page with one of a few fixed codes.
  // What actually went wrong goes to the log; nothing the provider sent is
  // ever reflected into the page.
  const fail = (code, reason) => {
    console.log(`[AUTH] oauth refused provider=${providerId} reason="${logSafe(reason, 200)}" ip=${clientIp(req)}`);
    let location = `/account.html?oauth_error=${encodeURIComponent(code)}`;
    if (flow && flow.intent === 'login') location += `&next=${encodeURIComponent(flow.next_path)}`;
    redirectTo(res, location, [clearFlow]);
  };

  const provider = OAUTH.providers.get(params.provider);
  if (!provider) return fail('unavailable', 'provider not configured');

  const state = query.get('state');
  if (!state || state.length > 512) return fail('expired', 'no state');

  // Single use: the row is taken out in the same statement that finds it, so
  // a replayed callback — or two arriving at once — finds nothing.
  flow = db
    .prepare(
      `DELETE FROM oauth_flows WHERE state_hash = ?
       RETURNING *, expires_at > datetime('now') AS live`
    )
    .get(hashToken(state));
  if (!flow) return fail('expired', 'unknown, used or tampered state');
  if (!flow.live) return fail('expired', 'flow expired');

  // Bound to the browser that started it: this is what stops login CSRF.
  const binding = parseCookies(req)[flowCookieName(req)];
  if (!binding || !oauth.safeEqual(hashToken(binding), flow.browser_hash)) {
    return fail('expired', 'flow cookie missing or from another browser');
  }

  // Each provider has its own callback path, and a flow started for one is
  // refused at another's. That separation is RFC 9700 §4.4.2's defence
  // against mix-up for providers that don't send `iss`, GitHub among them.
  if (flow.provider !== provider.id) return fail('failed', 'flow belongs to another provider');

  let meta;
  try {
    meta = await provider.metadata();
  } catch (e) {
    return fail('unavailable', e.message);
  }

  // RFC 9207: a provider that says it sends `iss` must send it, and whatever
  // `iss` arrives must be exactly the issuer this flow was sent to.
  const iss = query.get('iss');
  if (iss === null && meta.issParameterSupported) return fail('failed', 'iss missing');
  if (iss !== null && iss !== provider.issuer) return fail('failed', 'iss does not match the provider');

  const providerError = query.get('error');
  if (providerError !== null) {
    return fail(
      providerError === 'access_denied' ? 'cancelled' : 'failed',
      `provider returned error ${providerError.slice(0, 40)}`
    );
  }
  const code = query.get('code');
  if (!code || code.length > 2048) return fail('failed', 'no code');

  // The access token lives only inside this block: used for the profile
  // where the provider needs it (GitHub), then dropped. Nothing a provider
  // issues is stored.
  let identity;
  try {
    const tokens = await provider.exchangeCode(code, flow.code_verifier);
    identity = await provider.identify(tokens, { nonce: flow.nonce });
  } catch (e) {
    return fail(e instanceof oauth.OAuthError ? e.code : 'failed', e.message);
  }

  const displayName = cleanLine(identity.displayName, 120);
  const linked = db
    .prepare('SELECT id, user_id FROM user_identities WHERE issuer = ? AND subject = ?')
    .get(identity.issuer, identity.subject);

  // The start's throttle count is given back once a flow completes.
  const giveBackStart = () => undoAttempt(`oauth-start:${clientIp(req)}`);

  if (flow.intent === 'link') {
    const user = currentUser(req);
    if (!user || user.id !== flow.link_user_id) {
      return fail('link_session', 'the account that started linking is no longer signed in');
    }
    if (linked && linked.user_id !== user.id) {
      return fail('identity_taken', `identity already belongs to user id=${linked.user_id}`);
    }
    if (linked) {
      db.prepare('UPDATE user_identities SET display_name = ? WHERE id = ?').run(displayName, linked.id);
    } else {
      db.prepare(
        `INSERT INTO user_identities (user_id, provider, issuer, subject, display_name)
         VALUES (?, ?, ?, ?, ?)`
      ).run(user.id, provider.id, identity.issuer, identity.subject, displayName);
    }
    giveBackStart();
    console.log(`[AUTH] oauth linked provider=${provider.id} user=${user.username} id=${user.id} ip=${clientIp(req)}`);
    return redirectTo(res, flow.next_path, [clearFlow]);
  }

  // Signing in. A known identity is that account. An unknown one is a new
  // account — never an existing account that happens to share an email.
  let userId;
  let username;
  if (linked) {
    userId = linked.user_id;
    username = db.prepare('SELECT username FROM users WHERE id = ?').get(userId).username;
    db.prepare('UPDATE user_identities SET display_name = ? WHERE id = ?').run(displayName, linked.id);
  } else {
    username = usernameFor(identity.usernameHint);
    db.exec('BEGIN');
    try {
      userId = db
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(username, NO_PASSWORD).lastInsertRowid;
      db.prepare(
        `INSERT INTO user_identities (user_id, provider, issuer, subject, display_name)
         VALUES (?, ?, ?, ?, ?)`
      ).run(userId, provider.id, identity.issuer, identity.subject, displayName);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    console.log(`[AUTH] oauth signup provider=${provider.id} user=${logSafe(username)} id=${userId} ip=${clientIp(req)}`);
  }

  // A fresh session, exactly as a password login makes one — and the session
  // this browser had before, if any, is ended rather than left behind.
  const previous = sessionToken(req);
  if (previous) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(previous));
  const token = startSession(userId, req);
  giveBackStart();
  console.log(`[AUTH] oauth login success provider=${provider.id} user=${logSafe(username)} id=${userId} ip=${clientIp(req)}`);
  redirectTo(res, flow.next_path, [sessionCookie(token, req), clearFlow]);
});

route('GET', '/api/auth/identities', async (req, res) => {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Sign in to see your account.' });
  const rows = db
    .prepare(
      `SELECT id, provider, issuer, display_name, created_at FROM user_identities
        WHERE user_id = ? ORDER BY id`
    )
    .all(user.id);
  sendJson(
    res,
    200,
    rows.map(({ issuer, ...row }) => {
      const provider = OAUTH.providers.get(row.provider);
      return {
        ...row,
        provider_name: provider ? provider.name : row.provider,
        // Usable to sign in with right now: the provider is configured and
        // still the same issuer. The same rule signInMethodCount() counts by.
        enabled: !!provider && provider.issuer === issuer,
      };
    })
  );
});

route('DELETE', '/api/auth/identities/:id', async (req, res, params) => {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Sign in to change your account.' });
  const identityId = parseId(params.id);
  // Someone else's identity answers exactly like one that doesn't exist.
  const identity = identityId
    ? db.prepare('SELECT id, provider FROM user_identities WHERE id = ? AND user_id = ?').get(identityId, user.id)
    : null;
  if (!identity) return sendJson(res, 404, { error: 'No such connected account.' });

  // node:sqlite is synchronous and nothing here awaits, so the count and the
  // delete can't be split by another request removing a method in between.
  if (signInMethodCount(user.id, { excludingIdentityId: identity.id }) < 1) {
    return sendJson(res, 409, {
      error: 'This is the only way you can sign in. Add another one before disconnecting it.',
    });
  }
  db.prepare('DELETE FROM user_identities WHERE id = ?').run(identity.id);
  console.log(`[AUTH] oauth unlinked provider=${identity.provider} user=${user.username} id=${user.id} ip=${clientIp(req)}`);
  sendJson(res, 200, { ok: true });
});

// ---------- account management: password, sessions, deletion, export ----------
//
// What a signed-in person can do to their own account besides sign in:
//
//   POST   /api/auth/password                change the password, or set a first one
//   GET    /api/auth/sessions                every browser signed in to this account
//   DELETE /api/auth/sessions/:id            end one of them
//   POST   /api/auth/sessions/revoke-others  end all but this one
//   GET    /api/auth/account                 what the account page says about it
//   DELETE /api/auth/account                 erase the account and every tree it made
//   GET    /api/auth/export                  everything held about it, as one file
//
// Written against OWASP ASVS V2.1 (changing a password), V3.3 (ending
// sessions) and V3.7 (proving it's you again before a sensitive change),
// NIST SP 800-63B §5.1.1.2 (the signup rules apply to every new password),
// and the GDPR's rights of access and portability (Art. 15, 20) and erasure
// (Art. 17). Every password here is checked through the same derive() as a
// login — the same cost, the same cap on how many run at once — and every
// throttle counter moves before the hash, never after, for the reason the
// login route gives.

// How recently a session must have signed in to stand in for a password
// (ASVS V3.7.1). An account with no password — made through a provider — has
// nothing to type before a sensitive change, so what it shows instead is
// that this browser signed in within the last ten minutes. A session's
// created_at is that moment: signing in writes it, nothing else does, and
// rotateSession() keeps it. Ten minutes is time to sign in and go straight
// to the setting; a browser left signed in for a week, or a cookie lifted
// from one, is far outside it.
const RECENT_AUTH_SEC = 10 * 60;
const SIGN_IN_AGAIN =
  'For your security, sign in again first. This needs a sign-in from the last 10 minutes.';

// The session row a request is using: its age, and which row in the list is
// "this device". Only meaningful after currentUser() has accepted the token.
function currentSession(req) {
  const token = sessionToken(req);
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT token_hash, user_id, public_id,
                created_at > datetime('now', ?) AS recent
           FROM sessions WHERE token_hash = ?`
      )
      .get(`-${RECENT_AUTH_SEC} seconds`, hashToken(token)) || null
  );
}

// Who is asking and through which session, or null with the 401 already sent.
function accountRequest(req, res) {
  const user = currentUser(req);
  const session = user ? currentSession(req) : null;
  if (!user || !session) {
    sendJson(res, 401, { error: 'Sign in to manage your account.' });
    return null;
  }
  return { user, session };
}

// Whether the session that started a slow request is still there to finish
// it. A password check takes a few hundred milliseconds — time for the
// session to be ended from another device, or signed out in another tab —
// and a change asked for by a session that has since been ended must not
// land after it. Call it with nothing awaited between it and the writes.
function sessionStillLive(req, userId) {
  const user = currentUser(req);
  return user && user.id === userId ? currentSession(req) : null;
}

// Sessions that can still be used, most recently used first.
function liveSessions(userId) {
  return db
    .prepare(
      `SELECT token_hash, public_id, created_at, last_used_at, expires_at, user_agent
         FROM sessions
        WHERE user_id = ? AND expires_at > datetime('now') AND last_used_at > datetime('now', ?)
        ORDER BY last_used_at DESC, created_at DESC`
    )
    .all(userId, `-${Math.floor(SESSION_IDLE_MS / 1000)} seconds`);
}

// A new token for a session, and nothing else about it changed: the same row
// and id in the list, the same absolute expiry, and the same created_at —
// rotating is not signing in, so it must not restart the ten-minute window.
// The old token stops working in the same statement.
function rotateSession(tokenHash) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE sessions SET token_hash = ? WHERE token_hash = ?').run(hashToken(token), tokenHash);
  return token;
}

// Counts an attempt at `action` per address, and per account within that
// address — the login throttle's two keys, for the same reasons: counted
// before the hash so a burst can't all pass on one stale number, and the
// account key carries the address so nobody can use it to lock anyone else
// out. Returns the keys, and whether either is over its limit.
function countAccountAttempt(req, action, userId) {
  const keys = {
    ip: `${action}:${clientIp(req)}`,
    user: `${action}-user:${userId}:${clientIp(req)}`,
  };
  const overIp = overLimit(keys.ip);
  const overUser = overLimit(keys.user);
  return { keys, over: overIp || overUser };
}

function tooManyAttempts(res) {
  return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
}

// Changing the password (ASVS V2.1.5, V2.1.6), or setting a first one on an
// account made through a provider.
//
// With a password set, the current one is required: a session is only a
// cookie, and a cookie can be lifted from a shared computer or a leaked log
// — it should not be enough to take the account over for good. That makes
// this another place to guess the current password, so it is throttled like
// the login; it answers nothing the login doesn't already answer to anyone.
// Without a password there is nothing to ask for, and a recent sign-in
// stands in (RECENT_AUTH_SEC).
//
// Afterwards every other session of the account ends (ASVS V3.3.3): whoever
// knew the old password may be signed in somewhere, and changing it is
// exactly what someone does when they think so. This browser's session gets
// a fresh token, so a copy of the cookie taken before the change is dead too.
route('POST', '/api/auth/password', async (req, res) => {
  const signedIn = accountRequest(req, res);
  if (!signedIn) return;
  const { user, session } = signedIn;

  const body = await readBody(req);
  const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  const account = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  const hadPassword = hasPassword(account);

  if (hadPassword && !currentPassword) {
    return sendJson(res, 400, { error: 'Enter your current password.' });
  }
  if (!hadPassword && !session.recent) {
    return sendJson(res, 403, { error: SIGN_IN_AGAIN });
  }
  // The signup rules, the username check included. Refusals up to here cost
  // nothing and give nothing away, so they are not counted: the limit
  // rations guesses at the current password, not typos in the new one.
  const problem = passwordProblem(newPassword, user.username);
  if (problem) return sendJson(res, 400, { error: problem });
  if (hadPassword && newPassword === currentPassword) {
    return sendJson(res, 400, { error: 'Your new password must be different from your current one.' });
  }

  const attempt = countAccountAttempt(req, 'password-change', user.id);
  if (attempt.over) {
    console.log(`[AUTH] password change throttled user=${logSafe(user.username)} id=${user.id} ip=${clientIp(req)}`);
    return tooManyAttempts(res);
  }

  if (hadPassword && !(await passwordMatches(currentPassword, account.password_hash))) {
    console.log(`[AUTH] password change refused: wrong current password user=${logSafe(user.username)} id=${user.id} ip=${clientIp(req)}`);
    return sendJson(res, 401, { error: 'That is not your current password.' });
  }
  const newHash = await hashPassword(newPassword);

  // Nothing below awaits, so no other request can come between the checks
  // and the writes. The password is swapped only if it is still the one that
  // was checked, so of two changes racing each other, one wins and the other
  // is told — rather than the second silently undoing the first.
  const live = sessionStillLive(req, user.id);
  if (!live) {
    return sendJson(res, 401, { error: 'You were signed out before the new password was saved. Nothing was changed.' });
  }
  let token;
  let ended;
  db.exec('BEGIN');
  try {
    const swapped = db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
      .run(newHash, user.id, account.password_hash).changes;
    if (!swapped) {
      db.exec('ROLLBACK');
      return sendJson(res, 409, { error: 'Your password was changed somewhere else a moment ago. Reload the page and try again.' });
    }
    ended = db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .run(user.id, live.token_hash).changes;
    token = rotateSession(live.token_hash);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // As after a successful login: the address keeps the failures it had,
  // this person's own fumbling is forgiven.
  undoAttempt(attempt.keys.ip);
  clearThrottle(attempt.keys.user);
  console.log(
    `[AUTH] password changed user=${logSafe(user.username)} id=${user.id} ` +
      `first_password=${hadPassword ? 'no' : 'yes'} other_sessions_ended=${ended} ip=${clientIp(req)}`
  );
  sendJson(res, 200, { ok: true, other_sessions_ended: ended }, { 'Set-Cookie': sessionCookie(token, req) });
});

// Where this account is signed in (ASVS V3.3.4). The id is the session's
// public_id; token_hash never leaves the server, not even a prefix of it.
route('GET', '/api/auth/sessions', async (req, res) => {
  const signedIn = accountRequest(req, res);
  if (!signedIn) return;
  const { user, session } = signedIn;
  sendJson(
    res,
    200,
    liveSessions(user.id).map((row) => ({
      id: row.public_id,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      user_agent: row.user_agent,
      current: row.token_hash === session.token_hash,
    }))
  );
});

// Ending another browser's session needs a recent sign-in, which is ASVS
// V3.3.4's "having re-entered login credentials". Without it, a cookie
// stolen last week could end its owner's sessions as fast as they signed
// in — and with them the password change that would have ended the thief's
// (it checks its own session is still there before saving). With it, the
// owner, freshly signed in, can always end an old stolen session, and the
// stolen one can't end theirs. Ending your own session is signing out, and
// is never refused.
const SESSION_ID = /^[0-9a-f]{32}$/;

route('DELETE', '/api/auth/sessions/:id', async (req, res, params) => {
  const signedIn = accountRequest(req, res);
  if (!signedIn) return;
  const { user, session } = signedIn;
  // Another account's session answers exactly like one that doesn't exist.
  const target = SESSION_ID.test(params.id)
    ? db.prepare('SELECT token_hash FROM sessions WHERE public_id = ? AND user_id = ?').get(params.id, user.id)
    : null;
  if (!target) return sendJson(res, 404, { error: 'No such session.' });

  const isCurrent = target.token_hash === session.token_hash;
  if (!isCurrent && !session.recent) return sendJson(res, 403, { error: SIGN_IN_AGAIN });
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(target.token_hash);
  console.log(`[AUTH] session ended user=${logSafe(user.username)} id=${user.id} current=${isCurrent ? 'yes' : 'no'} ip=${clientIp(req)}`);
  sendJson(res, 200, { ok: true }, isCurrent ? { 'Set-Cookie': sessionCookie(null, req) } : {});
});

route('POST', '/api/auth/sessions/revoke-others', async (req, res) => {
  const signedIn = accountRequest(req, res);
  if (!signedIn) return;
  const { user, session } = signedIn;
  if (!session.recent) return sendJson(res, 403, { error: SIGN_IN_AGAIN });
  const ended = db
    .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(user.id, session.token_hash).changes;
  console.log(`[AUTH] other sessions ended user=${logSafe(user.username)} id=${user.id} count=${ended} ip=${clientIp(req)}`);
  sendJson(res, 200, { ok: true, ended });
});

// What the account page needs to say what deleting the account would take
// with it. The tree count is the account's own; nothing here is public.
route('GET', '/api/auth/account', async (req, res) => {
  const signedIn = accountRequest(req, res);
  if (!signedIn) return;
  const { user } = signedIn;
  const account = db.prepare('SELECT username, password_hash, created_at FROM users WHERE id = ?').get(user.id);
  const trees = db.prepare('SELECT COUNT(*) AS n FROM trees WHERE user_id = ?').get(user.id).n;
  sendJson(res, 200, {
    id: user.id,
    username: account.username,
    created_at: account.created_at,
    has_password: hasPassword(account),
    tree_count: trees,
  });
});

// Deleting the account (GDPR Art. 17, erasure) — and every tree it made.
//
// The trees go too, deliberately. They are what the person wrote, published
// under their name; erasure that left them up would keep the bulk of their
// personal data public while removing their ability to edit or delete it
// (only the owner can, and the owner would be gone). Handing them to nobody
// would make them read-only for ever, like the trees from before accounts.
// The page says how many trees will go and offers the export first, whose
// trees can each be imported again.
//
// Proof it's the owner, as for a password change: the password when there
// is one, otherwise a recent sign-in. Typing the username is the "yes, this
// account, on purpose" step; case-insensitive because usernames are (the
// column is NOCASE). A wrong username or a missing password is a typo, not a
// guess, and isn't counted; a wrong password is.
route('DELETE', '/api/auth/account', async (req, res) => {
  const signedIn = accountRequest(req, res);
  if (!signedIn) return;
  const { user, session } = signedIn;

  const body = await readBody(req);
  const confirmUsername = typeof body.confirm_username === 'string' ? body.confirm_username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const account = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  const hadPassword = hasPassword(account);

  if (confirmUsername.toLowerCase() !== user.username.toLowerCase()) {
    return sendJson(res, 400, { error: 'Type your username to confirm.' });
  }
  if (hadPassword && !password) {
    return sendJson(res, 400, { error: 'Enter your password to confirm.' });
  }
  if (!hadPassword && !session.recent) {
    return sendJson(res, 403, { error: SIGN_IN_AGAIN });
  }

  const attempt = countAccountAttempt(req, 'account-delete', user.id);
  if (attempt.over) {
    console.log(`[AUTH] account deletion throttled user=${logSafe(user.username)} id=${user.id} ip=${clientIp(req)}`);
    return tooManyAttempts(res);
  }
  if (hadPassword && !(await passwordMatches(password, account.password_hash))) {
    console.log(`[AUTH] account deletion refused: wrong password user=${logSafe(user.username)} id=${user.id} ip=${clientIp(req)}`);
    return sendJson(res, 401, { error: 'That password is not right.' });
  }
  if (!sessionStillLive(req, user.id)) {
    return sendJson(res, 401, { error: 'You were signed out before the account was deleted. Nothing was changed.' });
  }

  // One transaction: the trees (their skills and links follow through ON
  // DELETE CASCADE on tree_id), then the user. trees.user_id has no cascade
  // of its own — a plain reference, added by migration — so the trees must go
  // first or the user's row can't. Everything else that names a user
  // (sessions, user_identities, oauth_flows) is ON DELETE CASCADE, and a
  // test checks every reference to users is. A table added later without
  // one makes this fail as a whole and roll back, never half-delete.
  let deletedTrees;
  db.exec('BEGIN');
  try {
    deletedTrees = db.prepare('DELETE FROM trees WHERE user_id = ?').run(user.id).changes;
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  console.log(`[AUTH] account deleted user=${logSafe(user.username)} id=${user.id} trees=${deletedTrees} ip=${clientIp(req)}`);
  sendJson(res, 200, { ok: true, deleted_trees: deletedTrees }, {
    'Set-Cookie': sessionCookie(null, req),
    // W3C Clear Site Data. "cookies" for the same reasons as logout.
    // "storage" as well, unlike logout: the person asked for everything of
    // theirs to go, and what this site keeps in the browser — the viewer's
    // copy of a tree in sessionStorage, which may well be one of the trees
    // just deleted — is theirs. Not "cache": nothing personal is cached (the
    // API is no-store, the files are the same for everyone), and it would
    // only throw the fonts away. Not "executionContexts": the page that asked
    // is leaving for the homepage anyway, and reloading every other open tab
    // of the site is not the account's business. Acted on over HTTPS and
    // localhost only, and for the whole registrable domain — see logout.
    'Clear-Site-Data': '"cookies", "storage"',
  });
});

// Passkeys are being built separately: until they land there is no table,
// and when they do its columns are theirs to name. So the table is looked
// for, and only columns on this list are read — an id, a name, when it was
// made and last used. Never the public key, the credential id or the
// signature counter: none of it is a secret the way a password is, but none
// of it means anything to a person or anywhere else, which is what this
// export is for. Both lists are constants, so nothing a caller sends ends up
// in the SQL.
const PASSKEY_TABLES = ['passkeys', 'webauthn_credentials'];
const PASSKEY_EXPORT_COLUMNS = ['id', 'name', 'label', 'nickname', 'created_at', 'last_used_at', 'last_used'];

function passkeyMetadata(userId) {
  for (const table of PASSKEY_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes('user_id')) continue;
    const wanted = PASSKEY_EXPORT_COLUMNS.filter((c) => columns.includes(c));
    if (wanted.length === 0) continue;
    const order = wanted.includes('created_at') ? ' ORDER BY created_at' : '';
    return db.prepare(`SELECT ${wanted.join(', ')} FROM ${table} WHERE user_id = ?${order}`).all(userId);
  }
  return null;
}

// Everything this site holds about the account, as one JSON file (GDPR
// Art. 15, access; Art. 20, portability: "structured, commonly used and
// machine-readable"). Each tree is in the portable format of FORMAT.md,
// made by the same treeToNotation() as a single tree's export, so each one
// can be imported again as it is — here or anywhere that reads the format.
//
// Included: the account, its connected sign-ins (issuer and subject too —
// they are what links the account, and are personal data, but they sign
// nobody in on their own), its sessions (no token or hash of one) and its
// passkeys' names and dates. Left out: the password hash, and anything a
// provider issued (none of it is stored). Rationed per account, since a
// large account's export is real work; it is a GET so it can be a plain
// download, and a cross-site navigation to it only saves the visitor's own
// data onto their own machine.
route('GET', '/api/auth/export', async (req, res) => {
  const signedIn = accountRequest(req, res);
  if (!signedIn) return;
  const { user, session } = signedIn;
  if (overLimit(`account-export:${user.id}`)) {
    console.log(`[AUTH] data export throttled user=${logSafe(user.username)} id=${user.id} ip=${clientIp(req)}`);
    return tooManyAttempts(res);
  }

  const account = db.prepare('SELECT id, username, password_hash, created_at FROM users WHERE id = ?').get(user.id);
  const identities = db
    .prepare(
      `SELECT provider, issuer, subject, display_name, created_at
         FROM user_identities WHERE user_id = ? ORDER BY id`
    )
    .all(user.id)
    .map((row) => {
      const provider = OAUTH.providers.get(row.provider);
      return { ...row, provider_name: provider ? provider.name : row.provider };
    });
  const sessions = liveSessions(user.id).map((row) => ({
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    user_agent: row.user_agent,
    current: row.token_hash === session.token_hash,
  }));
  const passkeys = passkeyMetadata(user.id);

  const skillsOf = db.prepare('SELECT * FROM skills WHERE tree_id = ? ORDER BY id');
  const edgesOf = db.prepare('SELECT id, skill_id, prereq_skill_id FROM prereqs WHERE tree_id = ?');
  const trees = db
    .prepare('SELECT * FROM trees WHERE user_id = ? ORDER BY id')
    .all(user.id)
    .map((tree) => ({
      id: tree.id,
      created_at: tree.created_at,
      notation: treeToNotation(
        { tree, skills: skillsOf.all(tree.id), edges: edgesOf.all(tree.id) },
        { layout: tree.layout || DEFAULT_LAYOUT }
      ),
    }));

  const data = {
    format: 'skilltrees-account-export',
    version: 1,
    exported_at: db.prepare("SELECT datetime('now') AS now").get().now,
    about:
      'Everything Skill Trees holds about this account. Times are UTC. ' +
      'Each trees[].notation is a skill tree in the portable format (FORMAT.md) ' +
      'and can be imported again as it is.',
    account: {
      id: account.id,
      username: account.username,
      created_at: account.created_at,
      has_password: hasPassword(account),
    },
    identities,
    sessions,
    ...(passkeys ? { passkeys } : {}),
    trees,
  };

  console.log(`[AUTH] data export user=${logSafe(user.username)} id=${user.id} trees=${trees.length} ip=${clientIp(req)}`);
  // Usernames are already [A-Za-z0-9_-]; this only makes sure of it, since
  // the name goes into a header.
  const filename = `skilltrees-${account.username.replace(/[^A-Za-z0-9_-]/g, '-')}.json`;
  return sendRepresentation(req, res, 200, Buffer.from(JSON.stringify(data, null, 2) + '\n'), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
  });
});

route('GET', '/api/trees', async (req, res) => {
  const trees = db.prepare(`
    SELECT t.id, t.title, t.description, t.author, t.created_at, t.featured,
           (SELECT COUNT(*) FROM skills s WHERE s.tree_id = t.id) AS skill_count
    FROM trees t
    ORDER BY t.created_at DESC
  `).all();
  sendJson(res, 200, trees);
});

route('POST', '/api/trees', async (req, res) => {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Sign in to make a tree.' });

  const body = await readBody(req);
  const title = cleanLine(body.title, 120);
  const description = cleanText(body.description, 1000);
  const author = cleanLine(body.author, 80) || user.username;
  if (!title) return sendJson(res, 400, { error: 'title is required' });

  const result = db
    .prepare('INSERT INTO trees (title, description, author, user_id) VALUES (?, ?, ?, ?)')
    .run(title, description, author, user.id);
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(result.lastInsertRowid);
  console.log(`[TREE] created id=${tree.id} title="${logSafe(tree.title)}" user=${user.username} ip=${clientIp(req)}`);
  sendJson(res, 201, tree);
});

route('GET', '/api/trees/:id', async (req, res, params) => {
  const treeId = parseId(params.id);
  if (!treeId) return sendJson(res, 404, { error: 'Tree not found' });
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(treeId);
  if (!tree) return sendJson(res, 404, { error: 'Tree not found' });

  const skills = db.prepare('SELECT * FROM skills WHERE tree_id = ? ORDER BY id').all(treeId);
  const edges = db
    .prepare('SELECT id, skill_id, prereq_skill_id FROM prereqs WHERE tree_id = ?')
    .all(treeId);

  sendJson(res, 200, { ...tree, skills, edges });
});

// Title/description/author are edited in place on the tree page, so they are
// saved as they're typed rather than through a create form.
route('PATCH', '/api/trees/:id', async (req, res, params) => {
  const treeId = parseId(params.id);
  if (!treeId) return sendJson(res, 404, { error: 'Tree not found' });
  const owned = ownedTree(req, res, treeId);
  if (!owned) return;
  const { tree } = owned;

  const body = await readBody(req);
  // A blank title would leave the tree unfindable, so it keeps the old one.
  const title = body.title !== undefined ? cleanLine(body.title, 120) || tree.title : tree.title;
  const description =
    body.description !== undefined ? cleanText(body.description, 1000) : tree.description;
  const author =
    body.author !== undefined ? cleanLine(body.author, 80) || 'Anonymous' : tree.author;

  db.prepare('UPDATE trees SET title = ?, description = ?, author = ? WHERE id = ?').run(
    title,
    description,
    author,
    treeId
  );
  sendJson(res, 200, db.prepare('SELECT * FROM trees WHERE id = ?').get(treeId));
});

route('DELETE', '/api/trees/:id', async (req, res, params) => {
  const treeId = parseId(params.id);
  if (!treeId) return sendJson(res, 404, { error: 'Tree not found' });
  const owned = ownedTree(req, res, treeId);
  if (!owned) return;
  db.prepare('DELETE FROM trees WHERE id = ?').run(treeId);
  console.log(`[TREE] deleted id=${treeId} user=${owned.user.username} ip=${clientIp(req)}`);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/trees/:id/skills', async (req, res, params) => {
  const treeId = parseId(params.id);
  if (!treeId) return sendJson(res, 404, { error: 'Tree not found' });
  if (!ownedTree(req, res, treeId)) return;

  const body = await readBody(req);
  const name = cleanLine(body.name, 120);
  const description = cleanText(body.description, 1000);
  const pos_x = Number.isFinite(body.pos_x) ? body.pos_x : 0;
  const pos_y = Number.isFinite(body.pos_y) ? body.pos_y : 0;
  if (!name) return sendJson(res, 400, { error: 'name is required' });

  const result = db
    .prepare('INSERT INTO skills (tree_id, name, description, pos_x, pos_y) VALUES (?, ?, ?, ?, ?)')
    .run(treeId, name, description, pos_x, pos_y);
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(result.lastInsertRowid);
  sendJson(res, 201, skill);
});

route('PATCH', '/api/skills/:id', async (req, res, params) => {
  const skillId = parseId(params.id);
  if (!skillId) return sendJson(res, 404, { error: 'Skill not found' });
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  if (!skill) return sendJson(res, 404, { error: 'Skill not found' });
  if (!ownedTreeOf(req, res, skill.tree_id)) return;

  const body = await readBody(req);
  const pos_x = Number.isFinite(body.pos_x) ? body.pos_x : skill.pos_x;
  const pos_y = Number.isFinite(body.pos_y) ? body.pos_y : skill.pos_y;
  const name = body.name !== undefined ? cleanLine(body.name, 120) || skill.name : skill.name;
  const description =
    body.description !== undefined ? cleanText(body.description, 1000) : skill.description;

  db.prepare('UPDATE skills SET name = ?, description = ?, pos_x = ?, pos_y = ? WHERE id = ?').run(
    name,
    description,
    pos_x,
    pos_y,
    skillId
  );
  sendJson(res, 200, db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId));
});

route('DELETE', '/api/skills/:id', async (req, res, params) => {
  const skillId = parseId(params.id);
  if (!skillId) return sendJson(res, 404, { error: 'Skill not found' });
  const skill = db.prepare('SELECT tree_id FROM skills WHERE id = ?').get(skillId);
  if (!skill) return sendJson(res, 404, { error: 'Skill not found' });
  if (!ownedTreeOf(req, res, skill.tree_id)) return;

  db.prepare('DELETE FROM skills WHERE id = ?').run(skillId);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/trees/:id/prereqs', async (req, res, params) => {
  const treeId = parseId(params.id);
  if (!treeId) return sendJson(res, 404, { error: 'Tree not found' });
  if (!ownedTree(req, res, treeId)) return;

  const body = await readBody(req);
  const skillId = parseId(body.skill_id);
  const prereqId = parseId(body.prereq_skill_id);
  if (!skillId || !prereqId) {
    return sendJson(res, 400, { error: 'skill_id and prereq_skill_id must be valid skill IDs' });
  }

  const bothBelong = db
    .prepare('SELECT COUNT(*) AS n FROM skills WHERE tree_id = ? AND id IN (?, ?)')
    .get(treeId, skillId, prereqId);
  if (bothBelong.n !== 2) {
    return sendJson(res, 400, { error: 'Both skills must belong to this tree' });
  }

  if (wouldCreateCycle(treeId, skillId, prereqId)) {
    return sendJson(res, 400, { error: 'That link would create a cycle (a skill cannot depend on itself, directly or indirectly)' });
  }

  try {
    const result = db
      .prepare('INSERT INTO prereqs (tree_id, skill_id, prereq_skill_id) VALUES (?, ?, ?)')
      .run(treeId, skillId, prereqId);
    sendJson(res, 201, { id: result.lastInsertRowid, skill_id: skillId, prereq_skill_id: prereqId });
  } catch (e) {
    // UNIQUE constraint -> edge already exists
    sendJson(res, 409, { error: 'That prerequisite link already exists' });
  }
});

route('DELETE', '/api/prereqs/:id', async (req, res, params) => {
  const edgeId = parseId(params.id);
  if (!edgeId) return sendJson(res, 404, { error: 'Link not found' });
  const edge = db.prepare('SELECT tree_id FROM prereqs WHERE id = ?').get(edgeId);
  if (!edge) return sendJson(res, 404, { error: 'Link not found' });
  if (!ownedTreeOf(req, res, edge.tree_id)) return;

  db.prepare('DELETE FROM prereqs WHERE id = ?').run(edgeId);
  sendJson(res, 200, { ok: true });
});

// ---------- import / export (see FORMAT.md) ----------

// Builds the export response for a tree. `layout` overrides the tree's own
// mode; `positions` supplies coordinates the database doesn't have (the
// browser's current on-screen arrangement, since dragging is session-only).
function sendExport(res, treeId, { layout, positions } = {}) {
  const tree = db.prepare('SELECT * FROM trees WHERE id = ?').get(treeId);
  if (!tree) return sendJson(res, 404, { error: 'Tree not found' });

  const skills = db.prepare('SELECT * FROM skills WHERE tree_id = ? ORDER BY id').all(treeId);
  const edges = db
    .prepare('SELECT id, skill_id, prereq_skill_id FROM prereqs WHERE tree_id = ?')
    .all(treeId);

  const mode = LAYOUT_MODES.includes(layout) ? layout : tree.layout || DEFAULT_LAYOUT;
  const notation = treeToNotation({ tree, skills, edges }, { layout: mode, positions });

  const body = JSON.stringify(notation, null, 2) + '\n';
  const filename = (slugify(tree.title) || 'skill-tree') + '.json';

  // Through the shared sender, so a GET export gets an ETag and either
  // form is compressed on the wire. The decoded bytes are unchanged, which
  // is what the export -> import -> export round trip compares.
  return sendRepresentation(res.req, res, 200, Buffer.from(body), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': isGetLike(res.req) ? 'no-cache' : 'no-store',
  });
}

// Plain link form: exports using the tree's stored mode and coordinates.
// ?layout=auto|manual overrides the mode.
route('GET', '/api/trees/:id/export', async (req, res, params) => {
  const treeId = parseId(params.id);
  if (!treeId) return sendJson(res, 404, { error: 'Tree not found' });
  const query = new URLSearchParams((req.url.split('?')[1] || ''));
  sendExport(res, treeId, { layout: query.get('layout') });
});

// Same, but accepts the caller's current arrangement:
//   { layout: "manual", positions: { "<skillId>": { x, y }, ... } }
// The browser uses this so an export can capture dragging that was never
// saved to the database.
route('POST', '/api/trees/:id/export', async (req, res, params) => {
  const treeId = parseId(params.id);
  if (!treeId) return sendJson(res, 404, { error: 'Tree not found' });
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'Invalid request body.' });
  }
  sendExport(res, treeId, {
    layout: body.layout,
    positions: body.positions || null,
  });
});

route('POST', '/api/trees/import', async (req, res) => {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Sign in to import a tree.' });

  const importUserKey = `import-user:${user.id}`;
  const importIpKey = `import-ip:${clientIp(req)}`;
  // Counted up front, and counted once. Every import — accepted or refused —
  // costs a parse, a validation pass and a graph layout, so the attempt is
  // what the limit rations. Counting afterwards also left the same opening
  // the login throttle had: requests arriving together all read the count
  // from before any of them had finished.
  const overUser = overLimit(importUserKey);
  const overIp = overLimit(importIpKey);
  if (overUser || overIp) {
    console.log(`[IMPORT] throttled user=${user.username} id=${user.id} ip=${clientIp(req)}`);
    return sendJson(res, 429, { error: 'Too many import attempts. Try again in a few minutes.' });
  }

  let notation;
  try {
    notation = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'That is not valid JSON.', problems: [e.message] });
  }

  const problems = checkImportable(notation);
  if (problems.length > 0) {
    return sendJson(res, 400, {
      error: `That file has ${problems.length} problem${problems.length === 1 ? '' : 's'}.`,
      problems,
    });
  }

  const records = notationToRecords(notation);

  // All-or-nothing: a failure part way through must not leave a half-built
  // tree behind.
  db.exec('BEGIN');
  try {
    const treeId = db
      .prepare(
        'INSERT INTO trees (title, description, author, layout, user_id) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        records.tree.title,
        records.tree.description,
        records.tree.author,
        records.tree.layout,
        user.id
      ).lastInsertRowid;

    const insertSkill = db.prepare(
      'INSERT INTO skills (tree_id, name, description, pos_x, pos_y) VALUES (?, ?, ?, ?, ?)'
    );
    const idBySlug = new Map();
    for (const skill of records.skills) {
      const rowId = insertSkill.run(
        treeId,
        skill.name,
        skill.description,
        skill.pos_x,
        skill.pos_y
      ).lastInsertRowid;
      idBySlug.set(skill.slug, rowId);
    }

    const insertEdge = db.prepare(
      'INSERT INTO prereqs (tree_id, skill_id, prereq_skill_id) VALUES (?, ?, ?)'
    );
    for (const edge of records.edges) {
      insertEdge.run(treeId, idBySlug.get(edge.skillSlug), idBySlug.get(edge.prereqSlug));
    }

    db.exec('COMMIT');
    console.log(`[IMPORT] success id=${treeId} title="${logSafe(records.tree.title)}" user=${user.username} ip=${clientIp(req)}`);

    const created = db.prepare('SELECT * FROM trees WHERE id = ?').get(treeId);
    sendJson(res, 201, { ...created, skill_count: records.skills.length });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Import failed:', e);
    sendJson(res, 500, { error: 'Could not import that tree.', problems: [e.message] });
  }
});

// ---------- reports (CSP violations, via the Reporting API) ----------
//
// Browsers post here when a page breaks its Content-Security-Policy: the
// Reporting API (W3C) sends application/reports+json, an array of reports;
// browsers that only know CSP2's report-uri send application/csp-report,
// one { "csp-report": {...} } per violation. A violation is either a bug in
// our own markup or someone trying to inject some, and both are worth a line
// in the log. Nothing is stored.
//
// Reports ride the ordinary API checks. Chromium's report-uri posts carry
// Origin (our own), Sec-Fetch-Site: same-origin, Sec-Fetch-Mode: no-cors and
// Sec-Fetch-Dest: report, and no cookie (verified against Chromium 141);
// Reporting API uploads are made by the browser's network stack for the
// page's own origin. Either way they pass the Origin and Fetch Metadata
// checks, and nothing a cross-site page could forge would: both media types
// fall outside what a form or a no-cors fetch can send without a preflight.

const REPORT_MAX_BYTES = 64 * 1024;
const REPORT_TYPES = ['application/reports+json', 'application/csp-report', 'application/json'];
// How many reports from one upload get a log line each. A batch can hold
// dozens of copies of the same violation; the rest are counted, not printed.
const REPORT_LOG_LINES = 5;

// A URL from a report, reduced to origin and path for the log. Query strings
// are dropped because the page that tripped the policy may carry something
// private in its own — an OAuth callback's ?code=, for one.
function reportUrl(value) {
  if (typeof value !== 'string' || value === '') return '-';
  try {
    const url = new URL(value);
    return url.origin === 'null' ? url.protocol : url.origin + url.pathname;
  } catch {
    // CSP keywords ('inline', 'eval', 'self') aren't URLs.
    return value.split(/[?#]/)[0];
  }
}

// Both formats, reduced to the fields worth logging. Returns null for
// anything that is neither.
function normaliseReports(parsed) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(parsed)) {
    return parsed.filter(isObject).map((r) => {
      const body = isObject(r.body) ? r.body : {};
      return {
        type: r.type,
        directive: body.effectiveDirective || body.violatedDirective,
        blocked: body.blockedURL,
        document: body.documentURL || r.url,
        disposition: body.disposition,
      };
    });
  }
  if (isObject(parsed) && isObject(parsed['csp-report'])) {
    const c = parsed['csp-report'];
    return [
      {
        type: 'csp-violation',
        directive: c['effective-directive'] || c['violated-directive'],
        blocked: c['blocked-uri'],
        document: c['document-uri'],
        disposition: c.disposition,
      },
    ];
  }
  return null;
}

route(
  'POST',
  REPORTS_PATH,
  async (req, res) => {
    // Counted before the body is read, like every other limit here. A page
    // with a genuine violation produces a handful of reports, not dozens.
    if (overLimit(`report:${clientIp(req)}`)) {
      return sendJson(res, 429, { error: 'Too many reports. Try again later.' });
    }
    const raw = await readRawBody(req, REPORT_MAX_BYTES);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return sendJson(res, 400, { error: 'Reports must be JSON.' });
    }
    const reports = normaliseReports(parsed);
    if (!reports) return sendJson(res, 400, { error: 'That is not a report.' });

    for (const r of reports.slice(0, REPORT_LOG_LINES)) {
      console.log(
        `[REPORT] ${logSafe(r.type || 'unknown', 40)}` +
          ` directive=${logSafe(r.directive || '-', 40)}` +
          ` blocked=${logSafe(reportUrl(r.blocked))}` +
          ` document=${logSafe(reportUrl(r.document))}` +
          ` disposition=${logSafe(r.disposition || '-', 20)}` +
          ` ip=${clientIp(req)}`
      );
    }
    if (reports.length > REPORT_LOG_LINES) {
      console.log(`[REPORT] ...and ${reports.length - REPORT_LOG_LINES} more ip=${clientIp(req)}`);
    }
    res.writeHead(204);
    res.end();
  },
  { accepts: REPORT_TYPES }
);

// ---------- /.well-known/security.txt (RFC 9116) ----------
//
// Tells security researchers how to reach whoever runs this copy of the
// site. Served only when SECURITY_CONTACT is set, because Contact is the one
// field the RFC makes mandatory, and a made-up address is worse than none.
//
//   SECURITY_CONTACT  one or more URIs, comma-separated (mailto:, https:,
//                     tel:); a bare address gets mailto: added
//   SECURITY_POLICY   optional https:// URL of a disclosure policy
//   PUBLIC_ORIGIN     the site's external origin; adds Canonical when https

const SECURITY_TXT_PATH = '/.well-known/security.txt';
// §2.5.5 recommends an Expires less than a year ahead, so a file nobody
// maintains goes stale visibly. Ours is regenerated from configuration on
// every request, so it can't go stale; 180 days, counted from the start of
// the current UTC day so the body (and its ETag) holds still for a day.
const SECURITY_TXT_DAYS = 180;

// Values from the environment, checked once. RFC 9116 §2.5.3: a Contact is a
// URI, and a web one MUST be https. Anything else is warned about at startup
// and left out rather than published.
function securityTxtConfig() {
  const clean = (v) => (v || '').trim();
  const contacts = [];
  for (const raw of clean(process.env.SECURITY_CONTACT).split(',')) {
    const value = raw.trim();
    if (!value) continue;
    const uri = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : value.includes('@') ? `mailto:${value}` : null;
    let ok = false;
    try {
      ok = uri !== null && !hasControlChars(uri) && ['mailto:', 'https:', 'tel:'].includes(new URL(uri).protocol);
    } catch {
      ok = false;
    }
    if (ok) contacts.push(uri);
    else console.warn(`[SECURITY.TXT] ignoring SECURITY_CONTACT entry "${logSafe(value)}": use mailto:, https: or tel:`);
  }

  let policy = null;
  const rawPolicy = clean(process.env.SECURITY_POLICY);
  if (rawPolicy) {
    try {
      if (new URL(rawPolicy).protocol === 'https:' && !hasControlChars(rawPolicy)) policy = rawPolicy;
    } catch {
      policy = null;
    }
    if (!policy) console.warn('[SECURITY.TXT] ignoring SECURITY_POLICY: it must be an https:// URL');
  }

  // Canonical (§2.5.2) names where the file officially lives; web URIs in
  // it MUST be https, so a plain-http origin (local development) gets none.
  const canonical =
    CONFIGURED_ORIGIN && CONFIGURED_ORIGIN.startsWith('https://')
      ? CONFIGURED_ORIGIN + SECURITY_TXT_PATH
      : null;
  return { contacts, policy, canonical };
}

const SECURITY_TXT = securityTxtConfig();

function securityTxtBody(now = new Date()) {
  if (SECURITY_TXT.contacts.length === 0) return null;
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expires = new Date(day + SECURITY_TXT_DAYS * 24 * 60 * 60 * 1000);
  const lines = SECURITY_TXT.contacts.map((c) => `Contact: ${c}`);
  // §2.5.5: an RFC 3339 date-time.
  lines.push(`Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  lines.push('Preferred-Languages: en');
  if (SECURITY_TXT.canonical) lines.push(`Canonical: ${SECURITY_TXT.canonical}`);
  if (SECURITY_TXT.policy) lines.push(`Policy: ${SECURITY_TXT.policy}`);
  return lines.join('\n') + '\n';
}

const READ_ONLY_ALLOW = 'GET, HEAD, OPTIONS';

// For a generated resource that only reads: OPTIONS says what it allows
// (RFC 9110 §9.3.7), anything else but GET/HEAD is 405 with Allow
// (§15.5.6). Returns true when it has answered.
function answeredReadOnly(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: READ_ONLY_ALLOW });
    res.end();
    return true;
  }
  if (!isGetLike(req)) {
    sendText(res, 405, { Allow: READ_ONLY_ALLOW, ...(requestHasBody(req) ? { Connection: 'close' } : {}) });
    return true;
  }
  return false;
}

function serveSecurityTxt(req, res) {
  const body = securityTxtBody();
  if (body === null) return sendText(res, 404);
  if (answeredReadOnly(req, res)) return;
  // §3: text/plain with charset=utf-8.
  return sendRepresentation(req, res, 200, Buffer.from(body), {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
}

// ---------- robots.txt, the sitemap, and the other well-known URLs ----------
//
// Generated rather than static, because each depends on PUBLIC_ORIGIN or on
// the database. The text itself comes from lib/meta.js; these only choose
// between it and a 404, and send it through sendRepresentation like
// everything else (ETag, 304, compression, HEAD).

// RFC 9309. Present whatever the configuration: without PUBLIC_ORIGIN it
// just has no Sitemap line.
function serveRobotsTxt(req, res) {
  if (answeredReadOnly(req, res)) return;
  return sendRepresentation(req, res, 200, Buffer.from(meta.robotsTxt(CONFIGURED_ORIGIN)), {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
}

// sitemaps.org. Every <loc> must be an absolute URL, and the only trustworthy
// source of one is PUBLIC_ORIGIN — Host is whatever the requester sent, and
// a sitemap built from it would let anyone file our pages under their own
// domain in whatever crawler fetched it. Unset, there is no sitemap: 404.
// Newest trees first, so if the protocol's 50,000-URL cap is ever reached it
// is long-known pages that drop out, not the ones a crawler has yet to find.
function serveSitemap(req, res) {
  if (!CONFIGURED_ORIGIN) return sendText(res, 404);
  if (answeredReadOnly(req, res)) return;
  const trees = db
    .prepare('SELECT id, created_at FROM trees ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(meta.MAX_SITEMAP_URLS - 1);
  return sendRepresentation(req, res, 200, Buffer.from(meta.sitemapXml(CONFIGURED_ORIGIN, trees)), {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
}

// W3C "A Well-Known URL for Changing Passwords": a password manager that
// knows someone's password is weak or leaked sends them here. The spec asks
// for a temporary redirect (302, 303 or 307) to the real page, and forbids
// serving the page at the well-known URL itself (RFC 8615 §1.1). A relative
// Location is fine (RFC 9110 §10.2.2), so this works on any host.
const CHANGE_PASSWORD_PAGE = '/account.html#account-password';

function serveChangePassword(req, res) {
  if (answeredReadOnly(req, res)) return;
  res.writeHead(302, { Location: CHANGE_PASSWORD_PAGE, 'Cache-Control': 'no-cache', 'Content-Length': 0 });
  res.end();
}

// W3C "A Well-Known URL for Relying Party Passkey Endpoints": 200 and
// application/json, never a redirect (the spec says so outright). Its URLs
// have to be absolute (see passkeyEndpoints() in lib/meta.js), so without
// PUBLIC_ORIGIN there is nothing correct to say: 404.
function servePasskeyEndpoints(req, res) {
  if (!CONFIGURED_ORIGIN) return sendText(res, 404);
  if (answeredReadOnly(req, res)) return;
  return sendRepresentation(req, res, 200, Buffer.from(JSON.stringify(meta.passkeyEndpoints(CONFIGURED_ORIGIN))), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  });
}

// Paths answered by code rather than by a file, checked before the static
// files. Exact matches on the raw path.
const GENERATED = new Map([
  [SECURITY_TXT_PATH, serveSecurityTxt],
  ['/.well-known/change-password', serveChangePassword],
  ['/.well-known/passkey-endpoints', servePasskeyEndpoints],
  ['/robots.txt', serveRobotsTxt],
  ['/sitemap.xml', serveSitemap],
]);

// ---------- static file serving (frontend) ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Cache-Control per file (RFC 9111 §5.2.2).
//
// Fonts are named for their contents, so a stale copy is not a risk worth a
// revalidation on every page load: a year, immutable.
//
// Everything else — pages, scripts, stylesheets, the favicon — is no-cache:
// kept, but revalidated on every use. Their names don't change when their
// contents do (/app.js is always /app.js), so a max-age would keep serving
// the old script after an edit, and a refresh would not show it; this server
// reads files from disk per request precisely so that it does. The ETag makes
// the revalidation a 304 of a couple of hundred bytes. The favicon used to be
// no-store, which re-downloaded it on every load; the pages already bust it
// with ?v=N when it changes, and no-cache gets the same freshness for a 304.
//
// The service worker (/sw.js) is no-cache like any script, which is also
// what the Service Workers spec wants: an update check must see the current
// file, and browsers cap a worker script's max-age at 24 hours anyway.
function staticCacheControl(ext) {
  return ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache';
}

// The one script that gets a CSP of its own (WORKER_CSP).
const SERVICE_WORKER_PATH = '/sw.js';

// Files whose type their extension doesn't settle. The speculation rules
// file is JSON, but a browser only accepts a rule set fetched through the
// Speculation-Rules header when it is served as
// application/speculationrules+json (HTML Standard, speculative loading).
const SPECULATION_RULES_PATH = '/speculationrules.json';
const TYPE_BY_PATH = {
  [SPECULATION_RULES_PATH]: 'application/speculationrules+json',
};

// A page's bytes depend on its file and on PUBLIC_ORIGIN (the absolute URLs
// filled into its <head>), and the second can only change with a restart. So
// the page was last modified no later than whichever is newer — which keeps
// If-Modified-Since honest for crawlers that send only that.
const STARTED_AT_MS = Date.now();

// The tree a tree page is showing, for the metadata in its <head>: the row,
// how many skills it has, and the first few names (JSON-LD's `teaches`).
// The id is read exactly as tree.js reads it (the first `id` parameter);
// anything that isn't a tree gets null, and with it the generic page — the
// script then says "not found" as it always has. Public data only: nothing
// here depends on who is asking, which is what lets the service worker
// cache the result (see frontend/sw.js).
function treeForPage(url) {
  const q = url.indexOf('?');
  if (q === -1) return null;
  const treeId = parseId(new URLSearchParams(url.slice(q + 1)).get('id'));
  if (!treeId) return null;
  const tree = db
    .prepare('SELECT id, title, description, author, created_at FROM trees WHERE id = ?')
    .get(treeId);
  if (!tree) return null;
  const skillCount = db.prepare('SELECT COUNT(*) AS n FROM skills WHERE tree_id = ?').get(treeId).n;
  const skillNames = db
    .prepare('SELECT name FROM skills WHERE tree_id = ? ORDER BY id LIMIT ?')
    .all(treeId, meta.MAX_TAUGHT)
    .map((r) => r.name);
  return { tree, skillCount, skillNames };
}

// Strong ETags for static files, keyed by path + mtime + size, so a file is
// hashed once per version rather than once per request. A 304 then needs
// only a stat: the file isn't read at all. For a page it is the ETag (and
// length) of the page as sent, markers filled in — the same for every
// request while the file and the configuration stay the same. A page
// showing a tree is never memoised; see serveStatic().
const etagCache = new LruCache({ maxEntries: 500, maxBytes: Infinity });

// Resources every page needs before it can paint: the stylesheet, and the
// Latin face of Inter that the stylesheet asks for only once it has been
// parsed. A font preload needs `crossorigin` — fonts are always fetched in
// CORS mode, and a preload made without it isn't reused.
const PRELOAD_STYLE = '</style.css>; rel=preload; as=style';
const PRELOAD_FONT = '</fonts/inter-latin.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin';

async function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  try {
    filePath = decodeURIComponent(filePath);
  } catch (e) {
    return sendText(res, 400);
  }
  // No control character can be part of a real filename here, and one of them
  // is a weapon: fs.readFile validates its path *synchronously*, so a decoded
  // NUL ("/%00") throws rather than calling back — out of this function, out
  // of the async listener, and into an unhandled rejection that ends the
  // process. Refusing the whole class costs nothing and closes that door.
  if (hasControlChars(filePath)) {
    return sendText(res, 400);
  }
  if (filePath === '/') filePath = '/index.html';
  const fullPath = path.normalize(path.join(FRONTEND_DIR, filePath));

  // Note the separator: a bare startsWith(FRONTEND_DIR) would also accept a
  // sibling directory whose name merely starts the same way ("frontend-keys"),
  // which is a traversal out of the served tree.
  if (fullPath !== FRONTEND_DIR && !fullPath.startsWith(FRONTEND_DIR + path.sep)) {
    return sendText(res, 403);
  }

  // Opened once and read through the same handle, so the stat that picks
  // the ETag and the bytes that go out describe the same file even if it is
  // replaced in between.
  let file;
  try {
    file = await fs.promises.open(fullPath, 'r');
  } catch (e) {
    return sendText(res, 404);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return sendText(res, 404);

    // The path names a file, so a wrong method is 405 rather than 404
    // (RFC 9110 §15.5.6), and says what would have worked.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: READ_ONLY_ALLOW });
      return res.end();
    }
    if (!isGetLike(req)) {
      return sendText(res, 405, {
        Allow: READ_ONLY_ALLOW,
        ...(requestHasBody(req) ? { Connection: 'close' } : {}),
      });
    }

    const ext = path.extname(fullPath);
    const isHtml = ext === '.html';
    // The file's own path under frontend/, whatever spelling reached it
    // ("/./sw.js" is /sw.js), for the handful of files treated specially.
    const pagePath = '/' + path.relative(FRONTEND_DIR, fullPath).split(path.sep).join('/');
    // Set on the response rather than passed to writeHead, so a 304 carries
    // the page's own CSP too: a browser folds a 304's headers into the copy
    // it stored, and the dispatcher's default is the API's default-src 'none'.
    for (const [k, v] of Object.entries(securityHeaders(isHtml, req))) res.setHeader(k, v);
    if (pagePath === SERVICE_WORKER_PATH) res.setHeader('Content-Security-Policy', WORKER_CSP);

    // tree.html?id=N names its tree in its <head> (title, description, Open
    // Graph, JSON-LD). That makes the page's bytes depend on the database,
    // so it skips the memo below, and has no Last-Modified: the tree has no
    // modification time to give it (TODO.md), and the file's would let an
    // If-Modified-Since answer 304 to a tree renamed since. Its ETag is a
    // hash of the page as sent, so a rename is a new ETag all the same.
    const treeMeta = pagePath === '/tree.html' ? treeForPage(req.url) : null;

    const headers = {
      'Content-Type': TYPE_BY_PATH[pagePath] || MIME[ext] || 'application/octet-stream',
      'Cache-Control': staticCacheControl(ext),
    };
    const modifiedMs = isHtml ? Math.max(stat.mtimeMs, STARTED_AT_MS) : stat.mtimeMs;
    if (!treeMeta) headers['Last-Modified'] = new Date(modifiedMs).toUTCString();
    if (isHtml) {
      // The same preload on the 200, for the benefit of anything that reads
      // it there — a CDN that turns a page's Link headers into its own Early
      // Hints, or a browser the 103 never reached. The font only: the
      // stylesheet is in the first bytes of every page anyway, and
      // preloading it from the page's own response made Chromium 141 fetch
      // it twice and warn that the preload went unused.
      headers.Link = PRELOAD_FONT;
      // Speculation Rules (HTML Standard): the rule set that lets the
      // browser prefetch a tree page someone is about to open. A header
      // rather than an inline <script type="speculationrules">, which the
      // CSP would have to allow with 'inline-speculation-rules'.
      headers['Speculation-Rules'] = `"${SPECULATION_RULES_PATH}"`;
    }

    const versionKey = `${fullPath}\0${stat.mtimeMs}\0${stat.size}`;
    const compressible = isCompressible(headers['Content-Type']);
    if (compressible) appendVary(res, 'Accept-Encoding');
    // The coding sendRepresentation() will choose for a body of this length.
    const codingFor = (length) =>
      compressible && length >= MIN_COMPRESS_BYTES ? negotiateEncoding(req.headers['accept-encoding']) : 'identity';

    // Answer a conditional request from the memo, without reading the file.
    const memo = treeMeta ? undefined : etagCache.get(versionKey);
    if (memo) {
      const tag = etagForCoding(memo.etag, codingFor(memo.length));
      if (isNotModified(req, tag, modifiedMs)) return sendNotModified(res, { ...headers, ETag: tag });
    }

    // RFC 8297 Early Hints: while the page is read (and perhaps
    // compressed), let the browser start on what the page will ask for.
    // Only for a browser navigation: a 1xx before the real response is
    // legal HTTP/1.1, but plenty of non-browser clients mistake it for the
    // final answer (RFC 8297 §3), and HTTP/1.0 has no 1xx at all (RFC 9110
    // §15.2 forbids sending one). Chromium acts on 103 only over HTTP/2 or
    // later, so this pays off behind a proxy that forwards it.
    const earlyHints =
      isHtml &&
      req.method === 'GET' &&
      req.headers['sec-fetch-dest'] === 'document' &&
      !(req.httpVersionMajor === 1 && req.httpVersionMinor === 0);
    if (earlyHints) {
      res.writeEarlyHints({ link: [PRELOAD_STYLE, PRELOAD_FONT] });
    }

    let body = await file.readFile();
    // Pages have their metadata markers filled in (lib/meta.js): absolute
    // URLs when PUBLIC_ORIGIN is set, and on a tree page the tree's own
    // title and description. Everything inserted is escaped for where it
    // lands; the file on disk is never changed.
    if (isHtml) {
      body = Buffer.from(
        meta.renderPage(body.toString('utf8'), { pagePath, origin: CONFIGURED_ORIGIN, tree: treeMeta })
      );
    }
    // A tree page is built per request: its own ETag from its own bytes,
    // compressed at the per-request level, and not memoised — a crawler
    // walking every tree would otherwise churn the memo for nothing.
    if (treeMeta) return await sendRepresentation(req, res, 200, body, headers);

    let etag = memo && memo.etag;
    if (!etag) {
      etag = etagOf(body);
      // A new version of the file makes the old one's memos dead weight.
      compressedCache.deletePrefix(`${fullPath}\0`);
      etagCache.set(versionKey, { etag, length: body.length });
    }
    return await sendRepresentation(req, res, 200, body, headers, {
      etag,
      mtimeMs: modifiedMs,
      cacheKey: versionKey,
    });
  } finally {
    await file.close().catch(() => {});
  }
}

// ---------- API dispatch ----------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

// The Allow header for a path (RFC 9110 §10.2.1): every method some route
// takes there, HEAD wherever GET is (§9.3.2), and OPTIONS always.
function allowFor(matching) {
  const methods = new Set(matching.map((r) => r.method));
  if (methods.has('GET')) methods.add('HEAD');
  methods.add('OPTIONS');
  return [...methods].sort((a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b)).join(', ');
}

// A body the route can't take gets 415 before the handler runs (RFC 9110
// §15.5.16), with Accept saying what would have worked. JSON routes must be
// sent application/json (ASVS V13.1.5, "the request's content type matches
// what the endpoint expects"), which does double duty against CSRF: the only
// types a cross-site <form> — or a fetch that avoids a CORS preflight — can
// send are application/x-www-form-urlencoded, multipart/form-data and
// text/plain. Parameters are fine ("; charset=utf-8"), but JSON is UTF-8
// (RFC 8259 §8.1), so any other charset is refused rather than misread.
// Compressed request bodies aren't supported; §12.5.3 says to answer those
// with 415 and Accept-Encoding.
function unsupportedBody(req, r) {
  if (!requestHasBody(req)) return null;
  const accepted = r.accepts.join(', ');
  const headers = { Accept: accepted };
  // RFC 5789 §2.2: a PATCH refused for its document type names the types
  // it takes in Accept-Patch.
  if (req.method === 'PATCH') headers['Accept-Patch'] = accepted;
  const { type, params } = mediaType(req.headers['content-type']);
  if (!r.accepts.includes(type)) {
    return { message: `Send the request body as ${r.accepts[0]}.`, headers };
  }
  if (params.charset && params.charset !== 'utf-8' && params.charset !== 'utf8') {
    return { message: 'Request bodies must be UTF-8.', headers };
  }
  const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    return { message: 'Compressed request bodies are not accepted.', headers: { 'Accept-Encoding': 'identity' } };
  }
  return null;
}

// W3C Fetch Metadata, as a resource isolation policy: another site's pages
// may link to the API — a top-level GET navigation, which is how an OAuth
// provider hands someone back to /api/auth/oauth/<provider>/callback — but
// may not fetch from it, post to it or embed it. Sec-Fetch-Site is set by
// the browser and can't be forged by page script. A request without it
// (curl, a script, a browser from before 2020) is allowed, exactly as the
// Origin check allows a request without Origin.
function crossSiteRefused(req) {
  if (req.headers['sec-fetch-site'] !== 'cross-site') return false;
  const topLevelNavigation =
    req.method === 'GET' &&
    req.headers['sec-fetch-mode'] === 'navigate' &&
    req.headers['sec-fetch-dest'] === 'document';
  return !topLevelNavigation;
}

// A refusal sent before the request body was read. Keeping the connection
// open would mean reading (and throwing away) however much body is still
// coming, so close it instead.
function refuse(req, res, status, message, headers = {}) {
  if (requestHasBody(req)) headers = { ...headers, Connection: 'close' };
  return sendJson(res, status, { error: message }, headers);
}

// Adds Server-Timing (W3C) as the headers go out, whoever writes them: the
// time from the request arriving to its response starting. Whole
// milliseconds on purpose — finer figures would help a timing attack on the
// login more than they help anyone reading a waterfall.
function addServerTiming(res, started) {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    res.writeHead = writeHead;
    if (!res.headersSent) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      res.setHeader('Server-Timing', `app;dur=${Math.round(ms)}`);
    }
    return writeHead.apply(this, args);
  };
}

async function handleApi(req, res, urlPath) {
  // Nothing under /api/ is a page; keep it out of search results (the
  // export URL is an ordinary link, so crawlers do find it).
  res.setHeader('X-Robots-Tag', 'noindex');
  // Any API response may come to depend on who is asking, so a shared
  // cache must never hand one person's copy to another (RFC 9110 §12.5.5).
  appendVary(res, 'Cookie');
  // A default for responses written without sendJson — a sign-in redirect
  // built with res.writeHead, say. sendJson replaces it with the policy in
  // apiCacheControl(), which lets public GETs be revalidated rather than
  // refetched.
  res.setHeader('Cache-Control', urlPath.startsWith('/api/auth/') ? 'private, no-store' : 'no-store');
  addServerTiming(res, req.startedAt);

  if (crossSiteRefused(req)) {
    return refuse(req, res, 403, 'Cross-site request refused.');
  }

  // Defence in depth behind the SameSite=Lax cookie (ASVS V4.2.2): a browser
  // always sends Origin on a state-changing request, so a mismatched one is
  // another site acting on someone's behalf. A missing Origin means a
  // non-browser caller (curl, a script), which carries no ambient cookie and
  // so can't be tricked this way. Safe methods change nothing and are exempt.
  // PUBLIC_ORIGIN, when set, is accepted as well: behind a proxy that
  // rewrites Host, it is what our own pages send.
  if (!SAFE_METHODS.has(req.method) && req.headers.origin) {
    let originHost = null;
    try {
      originHost = new URL(req.headers.origin).host;
    } catch (e) {
      originHost = null;
    }
    const ours = originHost === req.headers.host || req.headers.origin === CONFIGURED_ORIGIN;
    if (!ours) {
      return refuse(req, res, 403, 'Cross-site request refused.');
    }
  }

  const matching = routes.filter((r) => r.regex.test(urlPath));
  if (matching.length === 0) return refuse(req, res, 404, 'Not found');
  const allow = allowFor(matching);

  // OPTIONS answers what the path allows (RFC 9110 §9.3.7) and nothing
  // more. Cross-origin requests are not supported: a CORS preflight gets no
  // Access-Control-Allow-* headers here — and is refused above anyway, as
  // cross-site — so the browser blocks the real request.
  if (req.method === 'OPTIONS') {
    const headers = { Allow: allow };
    // RFC 5789 §3.1: Accept-Patch belongs in OPTIONS wherever PATCH is.
    const patch = matching.find((r) => r.method === 'PATCH');
    if (patch) headers['Accept-Patch'] = patch.accepts.join(', ');
    res.writeHead(204, headers);
    return res.end();
  }

  // HEAD is GET without the body (RFC 9110 §9.3.2); node:http drops the
  // body of a response to HEAD by itself, keeping its Content-Length.
  const r =
    matching.find((m) => m.method === req.method) ||
    (req.method === 'HEAD' ? matching.find((m) => m.method === 'GET') : undefined);
  if (!r) {
    return refuse(req, res, 405, `${req.method} is not allowed here.`, { Allow: allow });
  }

  const unsupported = unsupportedBody(req, r);
  if (unsupported) return refuse(req, res, 415, unsupported.message, unsupported.headers);

  const match = urlPath.match(r.regex);
  const params = {};
  r.paramNames.forEach((name, i) => (params[name] = match[i + 1]));
  try {
    await r.handler(req, res, params);
  } catch (e) {
    if (res.headersSent) {
      console.error(e);
      return res.destroy();
    }
    // Bad input is the caller's problem: answer 4xx and don't log a stack
    // for it. Only genuine faults are worth a 500 and the noise.
    if (e && e.statusCode) {
      await sendJson(res, e.statusCode, { error: e.message }, e.headers || {});
    } else {
      console.error(e);
      await sendJson(res, 500, { error: 'Internal server error' });
    }
  }
}

// ---------- server ----------

// Timeouts and limits, all explicit rather than whatever this Node version
// defaults to.
//   headersTimeout 20 s: the whole header block. A browser sends it in one
//     packet; a slowloris client trickling a byte at a time is cut off here.
//   requestTimeout 60 s: the whole request, body included. The largest body
//     anything sends is a 1 MB import, which takes about that long at
//     150 kbit/s, a poor mobile uplink.
//   connectionsCheckingInterval 5 s: how often those two are enforced. The
//     default of 30 s would let a 20 s limit run to 50.
//   maxHeaderSize 16 KiB: Node's default, pinned. Our own cookie is ~70
//     bytes, but on localhost a browser sends the cookies of every other app
//     on every other port too, and 8 KiB is easy to pass in development.
const server = http.createServer(
  {
    headersTimeout: 20_000,
    requestTimeout: 60_000,
    connectionsCheckingInterval: 5_000,
    maxHeaderSize: 16 * 1024,
  },
  async (req, res) => {
    req.startedAt = process.hrtime.bigint();
    for (const [k, v] of Object.entries(securityHeaders(false, req))) res.setHeader(k, v);
    closeConnectionWhenNeeded(res);

    try {
      // OPTIONS * asks about the server as a whole (RFC 9110 §9.3.7).
      if (req.url === '*') {
        if (req.method !== 'OPTIONS') return sendText(res, 400);
        res.writeHead(204, { Allow: 'GET, HEAD, POST, PATCH, DELETE, OPTIONS' });
        return res.end();
      }
      const urlPath = req.url.split('?')[0];
      if (urlPath.startsWith('/api/')) return await handleApi(req, res, urlPath);
      const generated = GENERATED.get(urlPath);
      if (generated) return await generated(req, res);
      return await serveStatic(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendText(res, 500);
      else res.destroy();
    }
  }
);

// keepAliveTimeout 5 s: how long an idle connection is held for the next
//   request. Long enough to carry a page and its scripts; behind a proxy it
//   must be raised above the proxy's own idle timeout, or the proxy will
//   now and then reuse a connection just as we close it.
// maxRequestsPerSocket 1000: a busy keep-alive connection never goes idle,
//   so without a cap one client could hold one socket open indefinitely;
//   past it the response says Connection: close and the client reconnects.
// maxHeadersCount 100: a browser sends about twenty; this bounds the work a
//   request made of thousands of tiny headers can cause.
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
server.maxHeadersCount = 100;

// ---------- lifecycle ----------

// Graceful shutdown on SIGTERM (what a process manager, a container runtime
// or the test harness sends) and SIGINT (Ctrl-C). New connections are
// refused, idle keep-alive ones are closed, and requests already running —
// a login halfway through its scrypt, an import halfway through its
// transaction — finish and get their answer. Responses sent from then on say
// Connection: close so their sockets don't linger. The database is closed
// once the last connection has gone, and a hard deadline makes sure a stuck
// request can't hold the process up forever.
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

// Decides, as the headers go out, whether this connection should close once
// the response is sent (Connection: close, RFC 9112 §9.6). Hooked at
// writeHead time rather than request time, so it sees what happened while
// the request was handled:
//   - the server is shutting down — including for requests that arrived
//     before the signal;
//   - the request still has an unread body larger than anything this server
//     accepts. Node would otherwise read and discard all of it to keep the
//     connection reusable, which is an invitation to send a gigabyte to a
//     401.
function closeConnectionWhenNeeded(res) {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    res.writeHead = writeHead;
    const req = res.req;
    const unreadOversized =
      !req.complete &&
      (req.bodyRefused ||
        Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES ||
        req.headers['transfer-encoding'] !== undefined);
    if ((shuttingDown || unreadOversized) && !res.headersSent) res.setHeader('Connection', 'close');
    return writeHead.apply(this, args);
  };
}

function exitAfterShutdown(code) {
  try {
    db.close();
  } catch (e) {
    console.error('Closing the database failed:', e);
  }
  process.exit(code);
}

function shutdown(signal) {
  // A second Ctrl-C means "now", as it does for most servers.
  if (shuttingDown) {
    console.log(`[SERVER] ${signal} again; exiting without waiting`);
    return exitAfterShutdown(1);
  }
  shuttingDown = true;
  console.log(`[SERVER] ${signal} received; finishing in-flight requests`);
  const deadline = setTimeout(() => {
    console.error(`[SERVER] still busy after ${SHUTDOWN_DEADLINE_MS / 1000} s; closing anyway`);
    server.closeAllConnections();
    exitAfterShutdown(1);
  }, SHUTDOWN_DEADLINE_MS);
  server.close(() => {
    clearTimeout(deadline);
    console.log('[SERVER] stopped');
    exitAfterShutdown(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last line of defence. One malformed request should cost that request, not
// the whole site: without these, Node's default for an unhandled rejection is
// to exit, so any throw that escapes a handler takes every other user with it.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

// Which providers are on, and why any that were asked for are not. Never the
// secrets: only names, and the callback URL each provider needs registered.
for (const note of OAUTH.notes) console.log(`[AUTH] ${logSafe(note, 300)}`);
// Fetch each discovery document now, so a mistyped issuer shows up in the
// startup log rather than on someone's first click. Not awaited: a slow
// provider must not hold up the server, and the first sign-in retries anyway.
for (const provider of OAUTH.providers.values()) {
  provider.metadata().catch((e) => {
    console.warn(`[AUTH] ${provider.name} is not reachable yet: ${logSafe(e.message, 300)}`);
  });
}

// A port that can't be bound is fatal and should say so plainly, not surface
// as an unhandled 'error' event.
server.on('error', (e) => {
  console.error(`[SERVER] could not listen on port ${PORT}: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  // The real port, not PORT: with PORT=0 the OS picks one, and the test
  // harness reads it from this line.
  console.log(`Skill Tree server running at http://localhost:${server.address().port}`);
});
