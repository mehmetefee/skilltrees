// Unit checks for backend/lib/http.js: the pure pieces the HTTP layer is
// built from. No server needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mediaType,
  isCompressible,
  negotiateEncoding,
  etagOf,
  etagForCoding,
  ifNoneMatchHit,
  notModifiedSince,
  problemBody,
  LruCache,
} = require('../../backend/lib/http');

test('mediaType parses type and parameters case-insensitively', () => {
  assert.deepEqual(mediaType('Application/JSON; Charset="UTF-8"'), {
    type: 'application/json',
    params: { charset: 'utf-8' },
  });
  assert.deepEqual(mediaType(undefined), { type: '', params: {} });
  assert.equal(mediaType('text/plain;;x').type, 'text/plain');
});

test('isCompressible: text yes, fonts and images no', () => {
  for (const t of [
    'text/html; charset=utf-8',
    'text/javascript',
    'application/json',
    'application/problem+json',
    'application/manifest+json',
    'application/speculationrules+json',
    'application/xml; charset=utf-8',
    'image/svg+xml',
  ]) {
    assert.ok(isCompressible(t), t);
  }
  for (const t of ['font/woff2', 'image/png', 'application/octet-stream', undefined]) {
    assert.ok(!isCompressible(t), String(t));
  }
});

test('negotiateEncoding follows RFC 9110 §12.5.3', () => {
  assert.equal(negotiateEncoding(undefined), 'identity');
  assert.equal(negotiateEncoding(''), 'identity');
  assert.equal(negotiateEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(negotiateEncoding('GZIP'), 'gzip');
  assert.equal(negotiateEncoding('identity;q=1, gzip;q=0.5'), 'identity');
  assert.equal(negotiateEncoding('identity, gzip'), 'gzip', 'a tie goes to the smaller body');
  assert.equal(negotiateEncoding('*;q=0.1, gzip;q=0'), 'br');
  assert.equal(negotiateEncoding('identity;q=0'), 'identity', 'nothing better: identity anyway');
  assert.equal(negotiateEncoding('br;q=0.001, gzip;q=0.002'), 'gzip');
  assert.equal(negotiateEncoding('br;q=abc'), 'identity');
});

test('ETags: strong, per coding, weak comparison for If-None-Match', () => {
  const tag = etagOf(Buffer.from('hello'));
  assert.match(tag, /^"[A-Za-z0-9_-]{22}"$/);
  assert.equal(etagOf(Buffer.from('hello')), tag);
  assert.notEqual(etagOf(Buffer.from('hellp')), tag);
  assert.equal(etagForCoding(tag, 'identity'), tag);
  assert.equal(etagForCoding(tag, 'br'), tag.slice(0, -1) + '-br"');

  assert.ok(ifNoneMatchHit(tag, tag));
  assert.ok(ifNoneMatchHit(`W/${tag}`, tag));
  assert.ok(ifNoneMatchHit(`"a", "b,c", ${tag}`, tag));
  assert.ok(ifNoneMatchHit(' * ', tag));
  assert.ok(!ifNoneMatchHit('"a"', tag));
  assert.ok(!ifNoneMatchHit('', tag));
  assert.ok(!ifNoneMatchHit(undefined, tag));
});

test('notModifiedSince compares at one-second resolution', () => {
  const mtime = Date.parse('2026-01-02T03:04:05.678Z');
  assert.ok(notModifiedSince('Fri, 02 Jan 2026 03:04:05 GMT', mtime));
  assert.ok(notModifiedSince('Sat, 03 Jan 2026 00:00:00 GMT', mtime));
  assert.ok(!notModifiedSince('Fri, 02 Jan 2026 03:04:04 GMT', mtime));
  assert.ok(!notModifiedSince('not a date', mtime));
  assert.ok(!notModifiedSince(undefined, mtime));
});

test('problemBody: RFC 9457 members plus the old ones', () => {
  assert.deepEqual(problemBody(404, { error: 'Tree not found' }), {
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'Tree not found',
    error: 'Tree not found',
  });
  const withProblems = problemBody(400, { error: 'Two problems.', problems: ['a', 'b'] });
  assert.deepEqual(withProblems.problems, ['a', 'b']);
  assert.equal(withProblems.detail, 'Two problems.');

  // A caller's own problem type survives; status is always the real one.
  const custom = problemBody(409, {
    type: 'https://example.org/problems/taken',
    title: 'Name taken',
    detail: 'That username is taken.',
    status: 200,
  });
  assert.equal(custom.type, 'https://example.org/problems/taken');
  assert.equal(custom.title, 'Name taken');
  assert.equal(custom.status, 409);
  assert.equal(custom.error, 'That username is taken.', 'detail is mirrored into error');

  assert.deepEqual(problemBody(500), { type: 'about:blank', title: 'Internal Server Error', status: 500 });
});

test('LruCache evicts by count and by bytes, oldest use first', () => {
  const byCount = new LruCache({ maxEntries: 2, maxBytes: 1000 });
  byCount.set('a', 1, 1);
  byCount.set('b', 2, 1);
  byCount.get('a'); // a is now the most recent
  byCount.set('c', 3, 1);
  assert.equal(byCount.get('b'), undefined);
  assert.equal(byCount.get('a'), 1);
  assert.equal(byCount.get('c'), 3);

  const byBytes = new LruCache({ maxEntries: 100, maxBytes: 10 });
  byBytes.set('x', 'x', 6);
  byBytes.set('y', 'y', 6);
  assert.equal(byBytes.get('x'), undefined);
  assert.equal(byBytes.bytes, 6);
  byBytes.set('huge', 'h', 11);
  assert.equal(byBytes.get('huge'), undefined, 'larger than the whole cache: not kept');

  const prefixed = new LruCache();
  prefixed.set('/a.js\u00001', 1, 5);
  prefixed.set('/a.js\u00002', 2, 5);
  prefixed.set('/b.js\u00001', 3, 5);
  prefixed.deletePrefix('/a.js\u0000');
  assert.equal(prefixed.map.size, 1);
  assert.equal(prefixed.bytes, 5);
});
