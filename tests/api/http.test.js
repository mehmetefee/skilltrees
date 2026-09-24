// The HTTP layer every route shares: problem details, validators and 304s,
// compression, HEAD/OPTIONS/405, 415, rate-limit fields, security headers,
// the CSP report endpoint, Fetch Metadata, Early Hints, security.txt and
// graceful shutdown. Run with `node --test "tests/api/*.test.js"`.
//
// Most checks go through node:http rather than fetch, because fetch decodes
// Content-Encoding and hides 1xx responses, and those are what's under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer } = require('../helpers/server');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');

// One raw request, no connection pooling. Resolves with the status, the
// headers, the undecoded body and any 1xx responses that came first.
function raw(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const informational = [];
    const req = http.request(
      { host: url.hostname, port: url.port, path: pathname, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), informational })
        );
        res.on('error', reject);
      }
    );
    req.on('information', (info) => informational.push(info));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function decode(res) {
  const coding = res.headers['content-encoding'];
  if (coding === 'br') return zlib.brotliDecompressSync(res.body);
  if (coding === 'gzip') return zlib.gunzipSync(res.body);
  return res.body;
}

const json = (res) => JSON.parse(decode(res).toString('utf8'));

let srv;
let owner;
test.before(async () => {
  srv = await startServer();
  owner = await srv.signup('httpowner');
});
test.after(async () => {
  await srv.stop();
});

// ---------- RFC 9457 problem details ----------

test('errors are application/problem+json and keep error/problems', async () => {
  const missing = await raw(srv.base, '/api/trees/999999');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['content-type'], 'application/problem+json');
  assert.equal(missing.headers['cache-control'], 'no-store');
  assert.deepEqual(json(missing), {
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'Tree not found',
    error: 'Tree not found',
  });

  const unknown = await raw(srv.base, '/api/no-such-thing');
  assert.equal(unknown.status, 404);
  assert.equal(json(unknown).title, 'Not Found');

  const signedOut = await srv.request('/api/trees', { method: 'POST', body: { title: 'x' } });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.headers.get('content-type'), 'application/problem+json');
  assert.equal(signedOut.data.status, 401);
  assert.equal(signedOut.data.title, 'Unauthorized');
  assert.equal(signedOut.data.detail, signedOut.data.error);

  // The import screen lists `problems`; it must survive the new shape.
  const bad = await owner.fetch('/api/trees/import', {
    method: 'POST',
    body: { format: 'skilltree', version: 1, title: '', skills: 'nope' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('content-type'), 'application/problem+json');
  assert.equal(bad.data.type, 'about:blank');
  assert.equal(bad.data.title, 'Bad Request');
  assert.ok(Array.isArray(bad.data.problems) && bad.data.problems.length > 0);
  assert.match(bad.data.error, /problem/);
  assert.equal(bad.data.detail, bad.data.error);

  const badJson = await raw(srv.base, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
  assert.equal(json(badJson).detail, 'Invalid JSON body');

  // Successes are unchanged: plain JSON, no problem members.
  const ok = await raw(srv.base, '/api/trees');
  assert.equal(ok.headers['content-type'], 'application/json');
  assert.ok(Array.isArray(json(ok)));
});

// ---------- conditional requests and caching ----------

test('static files carry a strong ETag and answer If-None-Match with 304', async () => {
  const first = await raw(srv.base, '/app.js');
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.match(etag, /^"[A-Za-z0-9_-]+"$/, 'strong, not W/');
  assert.equal(first.headers['cache-control'], 'no-cache');
  assert.ok(first.headers['last-modified']);
  assert.deepEqual(first.body, fs.readFileSync(path.join(FRONTEND, 'app.js')));

  const again = await raw(srv.base, '/app.js', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, etag);
  assert.equal(again.headers['cache-control'], 'no-cache');
  assert.match(again.headers.vary, /Accept-Encoding/);
  assert.equal(again.headers['content-type'], undefined, 'no representation metadata on a 304');

  // Weak comparison: W/ on the request side still matches, and so does one
  // entry in a list.
  const weak = await raw(srv.base, '/app.js', { headers: { 'If-None-Match': `"nope", W/${etag}` } });
  assert.equal(weak.status, 304);
  const star = await raw(srv.base, '/app.js', { headers: { 'If-None-Match': '*' } });
  assert.equal(star.status, 304);
  const other = await raw(srv.base, '/app.js', { headers: { 'If-None-Match': '"something-else"' } });
  assert.equal(other.status, 200);

  // If-Modified-Since, and If-None-Match taking precedence over it.
  const since = await raw(srv.base, '/app.js', {
    headers: { 'If-Modified-Since': first.headers['last-modified'] },
  });
  assert.equal(since.status, 304);
  const both = await raw(srv.base, '/app.js', {
    headers: { 'If-Modified-Since': first.headers['last-modified'], 'If-None-Match': '"x"' },
  });
  assert.equal(both.status, 200);
});

test('a page 304 carries the page CSP, not the API one', async () => {
  const page = await raw(srv.base, '/tree.html');
  const again = await raw(srv.base, '/tree.html', { headers: { 'If-None-Match': page.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers['content-security-policy'], page.headers['content-security-policy']);
  assert.match(again.headers['content-security-policy'], /script-src 'self'/);
});

test('cache policy per resource type', async () => {
  const font = await raw(srv.base, '/fonts/inter-latin.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable');

  for (const file of ['/', '/style.css', '/tree.js', '/favicon.svg']) {
    const res = await raw(srv.base, file);
    assert.equal(res.headers['cache-control'], 'no-cache', file);
    assert.ok(res.headers.etag, file);
  }
});

test('API GETs get ETags and no-cache; session responses get no-store', async () => {
  const list = await raw(srv.base, '/api/trees');
  assert.equal(list.status, 200);
  assert.equal(list.headers['cache-control'], 'no-cache');
  assert.match(list.headers.vary, /Cookie/);
  assert.ok(list.headers.etag);

  const same = await raw(srv.base, '/api/trees', { headers: { 'If-None-Match': list.headers.etag } });
  assert.equal(same.status, 304);
  assert.equal(same.body.length, 0);

  // A change makes the old validator stale.
  const created = await owner.fetch('/api/trees', { method: 'POST', body: { title: 'Etag tree' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const changed = await raw(srv.base, '/api/trees', { headers: { 'If-None-Match': list.headers.etag } });
  assert.equal(changed.status, 200);

  const me = await raw(srv.base, '/api/auth/me', { headers: { Cookie: owner.cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.headers['cache-control'], 'private, no-store');
  assert.equal(me.headers.etag, undefined, 'nothing to revalidate when nothing is stored');
  assert.match(me.headers.vary, /Cookie/);

  const login = await raw(srv.base, '/api/auth/logout', { method: 'POST' });
  assert.equal(login.headers['cache-control'], 'private, no-store');
});

// ---------- compression ----------

test('compression follows Accept-Encoding and decodes to the same bytes', async () => {
  const plain = fs.readFileSync(path.join(FRONTEND, 'app.js'));
  const cases = [
    ['gzip, deflate, br, zstd', 'br'],
    ['br', 'br'],
    ['gzip', 'gzip'],
    ['x-gzip', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
    ['gzip;q=0.5, br;q=0.4', 'gzip'],
    ['gzip;q=0.4, br;q=0.5', 'br'],
    ['identity', undefined],
    ['', undefined],
    ['gzip;q=0, br;q=0', undefined],
    ['*;q=0', undefined], // nothing acceptable: identity anyway (RFC 9110 §12.5.3)
    ['*', 'br'],
    ['deflate', undefined],
    ['gzip;q=1.5', undefined], // an invalid weight drops the member
  ];
  const etags = new Map();
  for (const [accept, expected] of cases) {
    const res = await raw(srv.base, '/app.js', { headers: { 'Accept-Encoding': accept } });
    assert.equal(res.status, 200, accept);
    assert.equal(res.headers['content-encoding'], expected, `Accept-Encoding: ${accept}`);
    assert.deepEqual(decode(res), plain, accept);
    assert.equal(Number(res.headers['content-length']), res.body.length, accept);
    assert.match(res.headers.vary, /Accept-Encoding/, accept);
    etags.set(expected || 'identity', res.headers.etag);
  }
  // No header at all: identity, since the client didn't ask.
  const none = await raw(srv.base, '/app.js');
  assert.equal(none.headers['content-encoding'], undefined);

  // One ETag per coding, so caches can't mix them up...
  assert.equal(new Set(etags.values()).size, 3);
  // ...and a br validator doesn't validate a gzip response.
  const cross = await raw(srv.base, '/app.js', {
    headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etags.get('br') },
  });
  assert.equal(cross.status, 200);
  assert.equal(cross.headers['content-encoding'], 'gzip');
  const match = await raw(srv.base, '/app.js', {
    headers: { 'Accept-Encoding': 'br', 'If-None-Match': etags.get('br') },
  });
  assert.equal(match.status, 304);
});

test('small files, fonts and already-compressed types are not compressed', async () => {
  const small = await raw(srv.base, '/theme.js', { headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.ok(small.body.length < 1024);
  assert.equal(small.headers['content-encoding'], undefined);

  const font = await raw(srv.base, '/fonts/inter-latin.woff2', { headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(font.headers['content-encoding'], undefined);
  assert.doesNotMatch(font.headers.vary || '', /Accept-Encoding/);
  assert.deepEqual(font.body, fs.readFileSync(path.join(FRONTEND, 'fonts', 'inter-latin.woff2')));
});

test('API responses and exports are compressed, and still round-trip', async () => {
  const guitar = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'guitar-auto.json'), 'utf8'));
  const imported = await owner.fetch('/api/trees/import', { method: 'POST', body: guitar });
  assert.equal(imported.status, 201, imported.text_);
  const id = imported.data.id;

  const tree = await raw(srv.base, `/api/trees/${id}`, { headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(tree.headers['content-encoding'], 'br');
  assert.equal(json(tree).title, guitar.title);
  const again = await raw(srv.base, `/api/trees/${id}`, {
    headers: { 'Accept-Encoding': 'gzip, br', 'If-None-Match': tree.headers.etag },
  });
  assert.equal(again.status, 304);

  const exported = await raw(srv.base, `/api/trees/${id}/export`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(exported.headers['content-encoding'], 'gzip');
  assert.match(exported.headers['content-disposition'], /attachment; filename="playing-guitar.json"/);
  assert.equal(exported.headers['cache-control'], 'no-cache');
  assert.ok(exported.headers.etag);
  const identity = await raw(srv.base, `/api/trees/${id}/export`);
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.deepEqual(decode(exported), identity.body, 'same bytes once decoded');
});

// ---------- methods ----------

test('HEAD works wherever GET does, without a body', async () => {
  for (const p of ['/', '/app.js', '/api/trees', '/api/auth/me']) {
    const get = await raw(srv.base, p, { headers: { 'Accept-Encoding': 'br' } });
    const head = await raw(srv.base, p, { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } });
    assert.equal(head.status, 200, p);
    assert.equal(head.body.length, 0, p);
    assert.equal(head.headers['content-length'], get.headers['content-length'], p);
    assert.equal(head.headers.etag, get.headers.etag, p);
    assert.equal(head.headers['content-type'], get.headers['content-type'], p);
  }
});

test('a known path with the wrong method is 405 with Allow', async () => {
  const put = await raw(srv.base, '/api/trees', { method: 'PUT' });
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET, HEAD, POST, OPTIONS');
  assert.equal(put.headers['content-type'], 'application/problem+json');
  assert.equal(json(put).title, 'Method Not Allowed');

  const del = await raw(srv.base, '/api/auth/me', { method: 'DELETE' });
  assert.equal(del.status, 405);
  assert.equal(del.headers.allow, 'GET, HEAD, OPTIONS');

  const tree = await raw(srv.base, '/api/trees/1', { method: 'POST' });
  assert.equal(tree.status, 405);
  assert.equal(tree.headers.allow, 'GET, HEAD, PATCH, DELETE, OPTIONS');

  const page = await raw(srv.base, '/index.html', { method: 'POST' });
  assert.equal(page.status, 405);
  assert.equal(page.headers.allow, 'GET, HEAD, OPTIONS');
  assert.equal(page.headers['content-type'], 'text/plain; charset=utf-8');

  // An unknown path is still 404, whatever the method.
  assert.equal((await raw(srv.base, '/api/nothing', { method: 'PUT' })).status, 404);
  assert.equal((await raw(srv.base, '/nothing.html', { method: 'POST' })).status, 404);
});

test('OPTIONS answers Allow, and still no CORS', async () => {
  const tree = await raw(srv.base, '/api/trees/1', { method: 'OPTIONS' });
  assert.equal(tree.status, 204);
  assert.equal(tree.headers.allow, 'GET, HEAD, PATCH, DELETE, OPTIONS');
  assert.equal(tree.headers['accept-patch'], 'application/json');
  assert.equal(tree.headers['access-control-allow-origin'], undefined);

  const file = await raw(srv.base, '/app.js', { method: 'OPTIONS' });
  assert.equal(file.status, 204);
  assert.equal(file.headers.allow, 'GET, HEAD, OPTIONS');

  const star = await raw(srv.base, '*', { method: 'OPTIONS' });
  assert.equal(star.status, 204);
  assert.match(star.headers.allow, /GET/);

  assert.equal((await raw(srv.base, '/api/nothing', { method: 'OPTIONS' })).status, 404);

  // A CORS preflight from another site gets nothing it can use.
  const preflight = await raw(srv.base, '/api/trees', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
    },
  });
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal(preflight.headers['access-control-allow-methods'], undefined);
});

// ---------- 415 ----------

test('a body that is not declared JSON is refused with 415', async () => {
  const login = JSON.stringify({ username: 'nobody', password: 'irrelevant-password' });
  for (const type of [
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    undefined,
  ]) {
    const headers = type ? { 'Content-Type': type } : {};
    const res = await raw(srv.base, '/api/auth/login', { method: 'POST', headers, body: login });
    assert.equal(res.status, 415, String(type));
    assert.equal(res.headers.accept, 'application/json');
    assert.equal(res.headers['content-type'], 'application/problem+json');
    assert.equal(res.headers.connection, 'close');
  }

  const utf16 = await raw(srv.base, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-16' },
    body: login,
  });
  assert.equal(utf16.status, 415);

  const gzipped = await raw(srv.base, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: zlib.gzipSync(login),
  });
  assert.equal(gzipped.status, 415);
  assert.equal(gzipped.headers['accept-encoding'], 'identity');

  const patch = await raw(srv.base, '/api/trees/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(patch.status, 415);
  assert.equal(patch.headers['accept-patch'], 'application/json');

  // Parameters are fine, and so is a request with no body at all.
  const withCharset = await raw(srv.base, '/api/auth/me', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
  assert.equal(withCharset.status, 200);
  const logout = await raw(srv.base, '/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  const empty = await raw(srv.base, '/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '0' },
  });
  assert.equal(empty.status, 200);
});

test('an oversized body is 413, before it is read', async () => {
  const res = await new Promise((resolve, reject) => {
    const url = new URL(srv.base);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: '/api/auth/login',
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(5 * 1024 * 1024) },
      },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    // Send only a little of the promised 5 MB: the answer must not wait for
    // the rest.
    req.write('{"username":');
  });
  assert.equal(res.status, 413);
  assert.equal(res.headers.connection, 'close');
  assert.equal(JSON.parse(res.body).title, 'Payload Too Large');
});

// ---------- security headers ----------

test('pages carry the full set of security headers', async () => {
  const page = await raw(srv.base, '/');
  const h = page.headers;
  const csp = h['content-security-policy'];
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'report-to csp-endpoint',
    'report-uri /api/reports',
  ]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, 'not over plain http');
  assert.equal(h['reporting-endpoints'], 'csp-endpoint="/api/reports"');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['cross-origin-opener-policy'], 'same-origin');
  assert.equal(h['cross-origin-resource-policy'], 'same-origin');
  assert.equal(h['origin-agent-cluster'], '?1');
  assert.equal(h['x-permitted-cross-domain-policies'], 'none');
  assert.equal(h['cross-origin-embedder-policy'], undefined);
  assert.equal(h['strict-transport-security'], undefined, 'RFC 6797 §7.2: not over plain http');

  const pp = h['permissions-policy'];
  for (const denied of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'browsing-topics=()']) {
    assert.ok(pp.includes(denied), denied);
  }
  for (const allowed of [
    'publickey-credentials-get=(self)',
    'publickey-credentials-create=(self)',
    'clipboard-write=(self)',
    'fullscreen=(self)',
  ]) {
    assert.ok(pp.includes(allowed), allowed);
  }

  assert.match(h.link, /<\/fonts\/inter-latin\.woff2>; rel=preload; as=font; type="font\/woff2"; crossorigin/);
});

test('over https: HSTS and upgrade-insecure-requests', async () => {
  const page = await raw(srv.base, '/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(page.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.match(page.headers['content-security-policy'], /; upgrade-insecure-requests$/);
  const api = await raw(srv.base, '/api/trees', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(api.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
});

test('API responses: locked-down CSP, noindex, Server-Timing', async () => {
  const res = await raw(srv.base, '/api/trees');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(res.headers['x-robots-tag'], 'noindex');
  assert.match(res.headers['server-timing'], /^app;dur=\d+$/);
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(res.headers['permissions-policy'], undefined, 'document-only headers stay on documents');

  const err = await raw(srv.base, '/api/nothing');
  assert.match(err.headers['server-timing'], /^app;dur=\d+$/);
  assert.equal(err.headers['x-robots-tag'], 'noindex');

  const page = await raw(srv.base, '/');
  assert.equal(page.headers['x-robots-tag'], undefined);
  assert.equal(page.headers['server-timing'], undefined);
});

// ---------- 103 Early Hints ----------

test('a page navigation gets 103 Early Hints; other clients do not', async () => {
  const nav = await raw(srv.base, '/tree.html', {
    headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
  });
  assert.equal(nav.status, 200);
  assert.equal(nav.informational.length, 1);
  assert.equal(nav.informational[0].statusCode, 103);
  const link = nav.informational[0].headers.link;
  assert.match(link, /<\/style\.css>; rel=preload; as=style/);
  assert.match(link, /<\/fonts\/inter-latin\.woff2>; rel=preload; as=font; type="font\/woff2"; crossorigin/);

  const script = await raw(srv.base, '/tree.html');
  assert.equal(script.informational.length, 0);
  const js = await raw(srv.base, '/app.js', { headers: { 'Sec-Fetch-Dest': 'document' } });
  assert.equal(js.informational.length, 0);

  // HTTP/1.0 has no 1xx responses at all (RFC 9110 §15.2).
  const url = new URL(srv.base);
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write('GET /tree.html HTTP/1.0\r\nHost: localhost\r\nSec-Fetch-Dest: document\r\n\r\n');
    });
    let text = '';
    socket.on('data', (c) => (text += c.toString('latin1')));
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 200 OK\r\n/);
  assert.doesNotMatch(reply, /103 Early Hints/);
});

// ---------- Fetch Metadata ----------

test('Fetch Metadata: cross-site API requests are refused, navigations are not', async () => {
  const xs = { 'Sec-Fetch-Site': 'cross-site' };

  const fetched = await raw(srv.base, '/api/auth/me', {
    headers: { ...xs, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Cookie: owner.cookie },
  });
  assert.equal(fetched.status, 403);
  assert.equal(json(fetched).detail, 'Cross-site request refused.');

  const embedded = await raw(srv.base, '/api/trees', {
    headers: { ...xs, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' },
  });
  assert.equal(embedded.status, 403);

  const framed = await raw(srv.base, '/api/trees', {
    headers: { ...xs, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
  });
  assert.equal(framed.status, 403);

  const posted = await raw(srv.base, '/api/auth/logout', {
    method: 'POST',
    headers: { ...xs, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
  });
  assert.equal(posted.status, 403, 'only GET navigations are let through');

  // An OAuth provider sending someone back is a top-level GET navigation.
  const navigation = await raw(srv.base, '/api/trees', {
    headers: { ...xs, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
  });
  assert.equal(navigation.status, 200);

  for (const site of ['same-origin', 'same-site', 'none']) {
    const res = await raw(srv.base, '/api/trees', {
      headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
    });
    assert.equal(res.status, 200, site);
  }
  // No metadata at all: a non-browser client, allowed as before.
  assert.equal((await raw(srv.base, '/api/trees')).status, 200);

  // The Origin check still stands on its own.
  const origin = await raw(srv.base, '/api/auth/logout', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(origin.status, 403);
});

// ---------- CSP reports ----------

// What Chromium sends for report-uri (captured from Chromium 141).
const reportHeaders = (host, type) => ({
  'Content-Type': type,
  Origin: `http://${host}`,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Dest': 'report',
});

test('the report endpoint takes both report formats and logs a line each', async () => {
  const host = new URL(srv.base).host;
  const logsBefore = srv.logs.join('').length;

  const legacy = await raw(srv.base, '/api/reports', {
    method: 'POST',
    headers: reportHeaders(host, 'application/csp-report'),
    body: JSON.stringify({
      'csp-report': {
        'document-uri': `http://${host}/tree.html?id=7&secret=abc`,
        'violated-directive': 'img-src',
        'effective-directive': 'img-src',
        'blocked-uri': 'https://evil.example/pixel.png?who=me',
        disposition: 'enforce',
      },
    }),
  });
  assert.equal(legacy.status, 204);
  assert.equal(legacy.body.length, 0);
  // Written without sendJson, so it shows the API's default policy.
  assert.equal(legacy.headers['cache-control'], 'no-store');

  const modern = await raw(srv.base, '/api/reports', {
    method: 'POST',
    headers: reportHeaders(host, 'application/reports+json'),
    body: JSON.stringify([
      {
        type: 'csp-violation',
        age: 10,
        url: `http://${host}/`,
        user_agent: 'test',
        body: {
          documentURL: `http://${host}/`,
          effectiveDirective: 'script-src-elem',
          blockedURL: 'inline',
          disposition: 'enforce',
        },
      },
    ]),
  });
  assert.equal(modern.status, 204);

  // Give the child's stdout a moment to arrive.
  await new Promise((r) => setTimeout(r, 100));
  const logged = srv.logs.join('').slice(logsBefore);
  assert.match(logged, /\[REPORT\] csp-violation directive=img-src blocked=https:\/\/evil\.example\/pixel\.png document=http:\/\/[^ ]+\/tree\.html disposition=enforce/);
  assert.doesNotMatch(logged, /secret=abc|who=me/, 'query strings stay out of the log');
  assert.match(logged, /\[REPORT\] csp-violation directive=script-src-elem blocked=inline/);
});

test('the report endpoint refuses the wrong type, junk and oversized bodies', async () => {
  const host = new URL(srv.base).host;
  const wrongType = await raw(srv.base, '/api/reports', {
    method: 'POST',
    headers: reportHeaders(host, 'text/plain'),
    body: '[]',
  });
  assert.equal(wrongType.status, 415);
  assert.match(wrongType.headers.accept, /application\/reports\+json/);
  assert.match(wrongType.headers.accept, /application\/csp-report/);

  const junk = await raw(srv.base, '/api/reports', {
    method: 'POST',
    headers: reportHeaders(host, 'application/csp-report'),
    body: '{"hello":1}',
  });
  assert.equal(junk.status, 400);

  const huge = await raw(srv.base, '/api/reports', {
    method: 'POST',
    headers: reportHeaders(host, 'application/reports+json'),
    body: JSON.stringify([{ type: 'csp-violation', body: { sample: 'x'.repeat(70 * 1024) } }]),
  });
  assert.equal(huge.status, 413);

  assert.equal((await raw(srv.base, '/api/reports')).status, 405);
});

// ---------- servers of their own ----------
//
// Throttling fills counters, and security.txt and shutdown need their own
// environment and lifecycle, so each gets a fresh server.

test('429 carries Retry-After and the RateLimit fields', async () => {
  const limited = await startServer();
  try {
    // Ten attempts are allowed through to the (slow) password check...
    for (let i = 0; i < 10; i++) {
      const res = await limited.request('/api/auth/login', {
        method: 'POST',
        body: { username: 'nobody', password: `wrong-password-${i}` },
      });
      assert.equal(res.status, 401, `attempt ${i + 1}`);
    }
    // ...and the eleventh is throttled.
    const res = await raw(limited.base, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong-password-x' }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers['retry-after'], '900');
    assert.equal(res.headers['ratelimit-policy'], '"attempts";q=10;w=900');
    assert.equal(res.headers['ratelimit'], '"attempts";r=0;t=900');
    assert.equal(res.headers['content-type'], 'application/problem+json');
    assert.equal(json(res).title, 'Too Many Requests');
    assert.equal(json(res).error, 'Too many attempts. Try again in a few minutes.');

    // The report endpoint has a budget of its own, per address.
    const host = new URL(limited.base).host;
    const report = () =>
      raw(limited.base, '/api/reports', {
        method: 'POST',
        headers: reportHeaders(host, 'application/csp-report'),
        body: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'data' } }),
      });
    for (let i = 0; i < 10; i++) assert.equal((await report()).status, 204, `report ${i + 1}`);
    const throttled = await report();
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers['retry-after'], '900');
  } finally {
    await limited.stop();
  }
});

test('security.txt is served only when a contact is configured; PUBLIC_ORIGIN is honoured', async () => {
  assert.equal((await raw(srv.base, '/.well-known/security.txt')).status, 404);

  const configured = await startServer({
    env: {
      SECURITY_CONTACT: 'security@example.org, https://example.org/report, http://insecure.example/',
      SECURITY_POLICY: 'https://example.org/security-policy',
      PUBLIC_ORIGIN: 'https://skilltrees.example',
    },
  });
  try {
    const res = await raw(configured.base, '/.well-known/security.txt');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    const text = res.body.toString('utf8');
    const lines = text.trimEnd().split('\n');
    assert.deepEqual(
      lines.filter((l) => l.startsWith('Contact: ')),
      ['Contact: mailto:security@example.org', 'Contact: https://example.org/report'],
      'plain http contacts are refused (RFC 9116 §2.5.3)'
    );
    assert.ok(lines.includes('Preferred-Languages: en'));
    assert.ok(lines.includes('Canonical: https://skilltrees.example/.well-known/security.txt'));
    assert.ok(lines.includes('Policy: https://example.org/security-policy'));
    const expires = lines.find((l) => l.startsWith('Expires: ')).slice('Expires: '.length);
    assert.match(expires, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const ms = Date.parse(expires) - Date.now();
    assert.ok(ms > 0 && ms < 365 * 24 * 60 * 60 * 1000, 'less than a year ahead (§2.5.5)');
    assert.match(configured.logs.join(''), /ignoring SECURITY_CONTACT entry "http:\/\/insecure\.example\/"/);

    assert.equal((await raw(configured.base, '/.well-known/security.txt', { method: 'HEAD' })).status, 200);
    const post = await raw(configured.base, '/.well-known/security.txt', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD, OPTIONS');

    // PUBLIC_ORIGIN also counts as our own Origin: behind a proxy that
    // rewrites Host, it is what our pages send.
    const fromSite = await raw(configured.base, '/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://skilltrees.example' },
    });
    assert.equal(fromSite.status, 200);
    const fromElsewhere = await raw(configured.base, '/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://skilltrees.example.evil' },
    });
    assert.equal(fromElsewhere.status, 403);
  } finally {
    await configured.stop();
  }
});

test('SIGTERM lets an in-flight request finish, then exits cleanly', async () => {
  const dying = await startServer();
  try {
    const url = new URL(dying.base);
    const body = JSON.stringify({ username: 'nobody', password: 'a-wrong-password' });
    let sent;
    const response = new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: '/api/auth/login',
          method: 'POST',
          agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }
      );
      req.on('error', reject);
      sent = req;
    });
    // Half the body now, so the request is certainly in progress on the
    // server when the signal lands...
    sent.write(body.slice(0, 10));
    await new Promise((r) => setTimeout(r, 200));
    const exited = new Promise((resolve) => dying.child.once('exit', (code) => resolve(code)));
    dying.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));

    // ...by which time the server has stopped taking new connections.
    await assert.rejects(raw(dying.base, '/api/trees'), /ECONNREFUSED/);

    // The rest of the body arrives, and the request is answered in full.
    sent.end(body.slice(10));
    const res = await response;
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).error, 'Wrong username or password.');
    assert.equal(res.headers.connection, 'close');

    assert.equal(await exited, 0);
    const logs = dying.logs.join('');
    assert.match(logs, /SIGTERM received/);
    assert.match(logs, /\[SERVER\] stopped/);
  } finally {
    await dying.stop();
  }
});
