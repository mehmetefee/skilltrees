// HTTP plumbing that every response shares: content negotiation, validators,
// compression, media types and problem details. Pure helpers — nothing in
// here knows about routes, the database or accounts — so server.js can apply
// them in one place and every route, including ones added later, gets them.
//
// Built on node:crypto and node:zlib only; the zero-dependency rule holds.

const crypto = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

// ---------- media types (RFC 9110 §8.3.1) ----------

// "application/json; charset=UTF-8" -> { type: 'application/json',
// params: { charset: 'utf-8' } }. Type and parameter names are
// case-insensitive; so is the charset value, which is the only one we read.
function mediaType(header) {
  if (typeof header !== 'string' || header.trim() === '') return { type: '', params: {} };
  const [type, ...rest] = header.split(';');
  const params = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params[name] = value.toLowerCase();
  }
  return { type: type.trim().toLowerCase(), params };
}

// Text compresses well; woff2, images and anything already compressed do not,
// and spending CPU to make them a few bytes larger helps nobody.
function isCompressible(contentType) {
  const { type } = mediaType(contentType);
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/javascript' ||
    type === 'application/xml' || // the sitemap
    type === 'image/svg+xml' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

// ---------- Accept-Encoding (RFC 9110 §12.5.3) ----------

// A weight is 0 to 1 with at most three decimals (RFC 9110 §12.4.2). A
// member whose weight doesn't parse is dropped rather than guessed at.
function parseWeighted(header) {
  const out = [];
  for (const member of header.split(',')) {
    const [token, ...params] = member.split(';');
    const name = token.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    let valid = true;
    for (const p of params) {
      const [k, v] = p.split('=').map((s) => (s || '').trim().toLowerCase());
      if (k !== 'q') continue;
      if (!/^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(v)) valid = false;
      else q = Number(v);
    }
    if (valid) out.push({ name: name === 'x-gzip' ? 'gzip' : name, q });
  }
  return out;
}

// The codings this server produces, in the order it prefers them when the
// client weighs them equally: brotli is smaller at the same speed.
// zstd is deliberately absent — node:zlib's zstd is still marked
// experimental in Node 22, and br already beats it on size for text.
const CODINGS = ['br', 'gzip'];

// Picks the content coding for a response. Returns 'identity' when nothing
// better is acceptable.
//
//   - No header at all: RFC 9110 allows any coding, but a client that didn't
//     ask (curl, a script) is far more likely to choke on br than to want it,
//     so it gets identity, which is always a correct answer.
//   - An empty header means "no coding, please".
//   - "*" covers codings not named; "q=0" rules one out.
//   - identity stays acceptable unless "identity;q=0", or "*;q=0" with no
//     identity entry of its own, says otherwise. If the client then accepts
//     nothing we can make, it still gets identity: §12.5.3 lets a server
//     disregard the field rather than answer 406.
function negotiateEncoding(header) {
  if (header === undefined || header === null) return 'identity';
  const prefs = parseWeighted(String(header));
  const weight = (name) => {
    const exact = prefs.find((p) => p.name === name);
    if (exact) return exact.q;
    const star = prefs.find((p) => p.name === '*');
    if (star) return star.q;
    // Unlisted identity is acceptable by default, but ranks below anything
    // the client did name.
    return name === 'identity' ? 0.0001 : 0;
  };
  let best = 'identity';
  let bestQ = weight('identity');
  for (const coding of CODINGS) {
    const q = weight(coding);
    if (q > 0 && q > bestQ) {
      best = coding;
      bestQ = q;
    } else if (q > 0 && q === bestQ && best === 'identity') {
      // An explicit tie with identity goes to the coding: the client said
      // both are equally fine, and the smaller one is better for everyone.
      best = coding;
    }
  }
  return best;
}

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Async on purpose: compression runs on the libuv threadpool instead of the
// one thread that answers every request. Measured on this project's files:
// brotli at quality 11 takes 55-75 ms for a 48 KB script, far too long to
// hold the event loop, so it's only used for static files, whose output is
// memoised; responses built per request use quality 4 (about 1 ms for a
// 160 KB tree, and smaller than quality 5 on JSON).
function compress(buf, coding, { level = 'dynamic' } = {}) {
  const best = level === 'static';
  if (coding === 'br') {
    return brotli(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_QUALITY]: best ? 11 : 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
  }
  if (coding === 'gzip') return gzip(buf, { level: best ? 9 : 6 });
  return Promise.resolve(buf);
}

// ---------- validators (RFC 9110 §8.8, §13.1) ----------

// A strong validator: a hash of the exact bytes. 132 bits of SHA-256 in
// base64url, which is all characters an entity-tag may carry.
function etagOf(buf) {
  return '"' + crypto.createHash('sha256').update(buf).digest('base64url').slice(0, 22) + '"';
}

// A strong ETag names one exact sequence of bytes, and a br body and a gzip
// body of the same file are different bytes (RFC 9110 §8.8.3.3), so each
// coding gets its own tag. Otherwise a cache holding the gzip copy could be
// told "still valid" about a br one and hand out bytes that don't match their
// Content-Encoding.
function etagForCoding(etag, coding) {
  return coding === 'identity' ? etag : etag.slice(0, -1) + '-' + coding + '"';
}

// If-None-Match uses the weak comparison (RFC 9110 §13.1.2): W/ is ignored
// on both sides and the opaque tags must match exactly. "*" matches any
// current representation, and there always is one when this is asked.
function ifNoneMatchHit(header, etag) {
  if (typeof header !== 'string' || header === '') return false;
  if (header.trim() === '*') return true;
  const opaque = (t) => t.replace(/^W\//, '');
  const want = opaque(etag);
  for (const tag of header.match(/(?:W\/)?"[^"]*"/g) || []) {
    if (opaque(tag) === want) return true;
  }
  return false;
}

// If-Modified-Since (RFC 9110 §13.1.3). HTTP dates have one-second
// resolution, so the file's time is truncated the same way before comparing;
// otherwise a file modified at .4 s past a second would never be "not
// modified since" the date we ourselves sent for it.
function notModifiedSince(header, mtimeMs) {
  if (typeof header !== 'string') return false;
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000);
}

// ---------- Vary (RFC 9110 §12.5.5) ----------

// Adds field names to Vary without duplicating ones already there, since
// several independent parts of a response can each depend on a request
// header.
function appendVary(res, ...fields) {
  const current = res.getHeader('Vary');
  const list = current
    ? String(current)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (list.includes('*')) return;
  const lower = new Set(list.map((s) => s.toLowerCase()));
  for (const f of fields) {
    if (!lower.has(f.toLowerCase())) {
      list.push(f);
      lower.add(f.toLowerCase());
    }
  }
  res.setHeader('Vary', list.join(', '));
}

// ---------- problem details (RFC 9457) ----------

// Turns the { error, problems } objects this API has always sent into an
// RFC 9457 problem object, keeping those members as extensions:
//
//   { "type": "about:blank", "title": "Not Found", "status": 404,
//     "detail": "Tree not found", "error": "Tree not found" }
//
// type is about:blank, which means "nothing beyond what the status code
// says", so title is the status's own phrase, as §4.2.1 asks. detail is the
// human-readable explanation. error repeats it because the frontend (and
// anyone else's client) reads data.error; problems stays as the list of
// validation failures the import screen shows. A caller that passes its own
// type/title/detail keeps them; status is always the real one.
function problemBody(status, data) {
  const extra =
    data && typeof data === 'object' && !Array.isArray(data)
      ? data
      : data === undefined || data === null
        ? {}
        : { detail: String(data) };
  const detail = extra.detail !== undefined ? extra.detail : extra.error;
  const out = {
    type: 'about:blank',
    title: http.STATUS_CODES[status] || 'Error',
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...extra,
  };
  out.status = status;
  if (out.error === undefined && detail !== undefined) out.error = detail;
  return out;
}

// ---------- a small LRU ----------

// Bounded by entry count and by total bytes, so a directory full of large
// files can't turn a memo into a memory leak. A Map iterates in insertion
// order, so re-inserting on every hit keeps the least recently used first.
class LruCache {
  constructor({ maxEntries = 100, maxBytes = 16 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, size = 0) {
    if (size > this.maxBytes) return;
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldestKey, oldest] = this.map.entries().next().value;
      this.map.delete(oldestKey);
      this.bytes -= oldest.size;
    }
  }

  // Drops every entry whose key starts with prefix — the versions of a file
  // that has since changed on disk.
  deletePrefix(prefix) {
    for (const [key, entry] of this.map) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        this.bytes -= entry.size;
      }
    }
  }
}

module.exports = {
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
  CODINGS,
};
