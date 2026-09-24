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

const SESSION_COOKIE = 'skilltree_session';

// NIST 800-63B 5.1.1.2: at least 8 characters, and accept long ones. The upper
// bound only exists so a huge body can't be turned into expensive hashing.
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 4096;

// Absolute and idle session lifetimes (ASVS V3.3).
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

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

async function passwordMatches(password, stored) {
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
function startSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`
  ).run(hashToken(token), userId, `+${Math.floor(SESSION_ABSOLUTE_MS / 1000)} seconds`);
  return token;
}

function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

// HttpOnly so page scripts can't read it; Lax so it rides along with ordinary
// navigation but not with cross-site form posts, which is the CSRF vector;
// Secure whenever the connection can carry it (plain http on localhost can't).
function sessionCookie(token, req) {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (isSecureRequest(req)) flags.push('Secure');
  const maxAge = token ? Math.floor(SESSION_ABSOLUTE_MS / 1000) : 0;
  return `${SESSION_COOKIE}=${token || ''}; ${flags.join('; ')}; Max-Age=${maxAge}`;
}

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
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
  sendJson(res, 201, { id, username }, { 'Set-Cookie': sessionCookie(startSession(id), req) });
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
  const ok = user
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
    { 'Set-Cookie': sessionCookie(startSession(user.id), req) }
  );
});

route('POST', '/api/auth/logout', async (req, res) => {
  const user = currentUser(req);
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  console.log(`[AUTH] logout user=${user ? user.username : 'unknown'} ip=${clientIp(req)}`);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(null, req) });
});

route('GET', '/api/auth/me', async (req, res) => {
  sendJson(res, 200, { user: currentUser(req) });
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
  let canonical = null;
  const rawOrigin = clean(process.env.PUBLIC_ORIGIN);
  if (rawOrigin) {
    try {
      const origin = new URL(rawOrigin);
      if (origin.protocol === 'https:') canonical = origin.origin + SECURITY_TXT_PATH;
    } catch {
      console.warn('[SECURITY.TXT] PUBLIC_ORIGIN is not a URL; leaving Canonical out');
    }
  }
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

function serveSecurityTxt(req, res) {
  const body = securityTxtBody();
  if (body === null) return sendText(res, 404);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: READ_ONLY_ALLOW });
    return res.end();
  }
  if (!isGetLike(req)) return sendText(res, 405, { Allow: READ_ONLY_ALLOW });
  // §3: text/plain with charset=utf-8.
  return sendRepresentation(req, res, 200, Buffer.from(body), {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
}

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
function staticCacheControl(ext) {
  return ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache';
}

// Strong ETags for static files, keyed by path + mtime + size, so a file is
// hashed once per version rather than once per request. A 304 then needs
// only a stat: the file isn't read at all.
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
    // Set on the response rather than passed to writeHead, so a 304 carries
    // the page's own CSP too: a browser folds a 304's headers into the copy
    // it stored, and the dispatcher's default is the API's default-src 'none'.
    for (const [k, v] of Object.entries(securityHeaders(isHtml, req))) res.setHeader(k, v);

    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': staticCacheControl(ext),
      'Last-Modified': stat.mtime.toUTCString(),
    };
    // The same preload on the 200, for the benefit of anything that reads
    // it there — a CDN that turns a page's Link headers into its own Early
    // Hints, or a browser the 103 never reached. The font only: the
    // stylesheet is in the first bytes of every page anyway, and preloading
    // it from the page's own response made Chromium 141 fetch it twice and
    // warn that the preload went unused.
    if (isHtml) headers.Link = PRELOAD_FONT;

    const versionKey = `${fullPath}\0${stat.mtimeMs}\0${stat.size}`;
    const compressible = isCompressible(headers['Content-Type']);
    if (compressible) appendVary(res, 'Accept-Encoding');
    const coding =
      compressible && stat.size >= MIN_COMPRESS_BYTES
        ? negotiateEncoding(req.headers['accept-encoding'])
        : 'identity';

    // Answer a conditional request from the memo, without reading the file.
    let etag = etagCache.get(versionKey);
    if (etag && isNotModified(req, etagForCoding(etag, coding), stat.mtimeMs)) {
      return sendNotModified(res, { ...headers, ETag: etagForCoding(etag, coding) });
    }

    // RFC 8297 Early Hints: while the page is read (and perhaps
    // compressed), let the browser start on what the page will ask for.
    // Only for a browser navigation: a 1xx before the real response is
    // legal HTTP/1.1, but plenty of non-browser clients mistake it for the
    // final answer (RFC 8297 §3). Chromium acts on 103 only over HTTP/2 or
    // later, so this pays off behind a proxy that forwards it.
    if (isHtml && req.method === 'GET' && req.headers['sec-fetch-dest'] === 'document') {
      res.writeEarlyHints({ link: [PRELOAD_STYLE, PRELOAD_FONT] });
    }

    const data = await file.readFile();
    if (!etag) {
      etag = etagOf(data);
      // A new version of the file makes the old one's memos dead weight.
      compressedCache.deletePrefix(`${fullPath}\0`);
      etagCache.set(versionKey, etag);
    }
    return await sendRepresentation(req, res, 200, data, headers, {
      etag,
      mtimeMs: stat.mtimeMs,
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
  if (!SAFE_METHODS.has(req.method) && req.headers.origin) {
    let originHost = null;
    try {
      originHost = new URL(req.headers.origin).host;
    } catch (e) {
      originHost = null;
    }
    if (originHost !== req.headers.host) {
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
      if (urlPath === SECURITY_TXT_PATH) return await serveSecurityTxt(req, res);
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
