// The installable app and what the site says about itself: the web app
// manifest, the service worker's script and precache list, <head> metadata
// on every page, a tree page's own title/description/JSON-LD (and that
// whatever a tree's author wrote comes out inert), robots.txt, the sitemap,
// the well-known URLs and the speculation rules. Run with
// `node --test "tests/api/*.test.js"`; no dependencies.
//
// Pages go through node:http rather than fetch, so ETags, 304s, HEAD and
// content codings can be looked at exactly as sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { startServer } = require('../helpers/server');
const meta = require('../../backend/lib/meta');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');
const ORIGIN = 'https://skilltrees.example';
const PAGES = ['/', '/tree.html', '/viewer.html', '/account.html', '/offline.html'];

function raw(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      { host: url.hostname, port: url.port, path: pathname, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
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
const text = (res) => decode(res).toString('utf8');

// Our own markup, so a narrow pattern is enough: the content="" of the
// first <meta> with that name or property, entities decoded.
function metaContent(html, key) {
  const m = new RegExp(`<meta (?:name|property)="${key.replace(/[:.]/g, '\\$&')}" content="([^"]*)"`).exec(html);
  return m ? unescapeHtml(m[1]) : undefined;
}
function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
const head = (html) => html.slice(0, html.indexOf('</head>'));

// The tags in a piece of our markup, with their attribute names. Attribute
// values are always double-quoted here (or absent, like `defer`), which is
// what makes this enough.
function tagsOf(html) {
  return [...html.matchAll(/<(\/?[a-z]+)((?:\s+[a-z:-]+(?:="[^"]*")?)*)\s*\/?>/gi)].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: [...m[2].matchAll(/\s([a-z:-]+)(?:="[^"]*")?/gi)].map((a) => a[1].toLowerCase()),
  }));
}
const jsonLdOf = (html) => {
  const open = '<script type="application/ld+json">';
  const start = html.indexOf(open);
  if (start === -1) return null;
  const end = html.indexOf('</script>', start);
  return html.slice(start + open.length, end);
};

// PNG width and height, from the IHDR chunk.
function pngSize(buf) {
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let srv; // no PUBLIC_ORIGIN
let pub; // PUBLIC_ORIGIN=https://skilltrees.example
let owner;
let pubOwner;
test.before(async () => {
  [srv, pub] = await Promise.all([startServer(), startServer({ env: { PUBLIC_ORIGIN: ORIGIN } })]);
  [owner, pubOwner] = await Promise.all([srv.signup('pwaowner'), pub.signup('pwaowner')]);
});
test.after(async () => {
  await Promise.all([srv.stop(), pub.stop()]);
});

async function makeTree(client, { title, description = '', author, skills = [] }) {
  const created = await client.fetch('/api/trees', { method: 'POST', body: { title, description, author } });
  assert.equal(created.status, 201, created.text_);
  for (const [i, name] of skills.entries()) {
    const s = await client.fetch(`/api/trees/${created.data.id}/skills`, {
      method: 'POST',
      body: { name, pos_x: i * 250, pos_y: 0 },
    });
    assert.equal(s.status, 201, s.text_);
  }
  return created.data;
}

// ---------- the web app manifest ----------

test('the manifest is served as application/manifest+json and describes an installable app', async () => {
  const res = await raw(srv.base, '/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/manifest+json');
  assert.equal(res.headers['cache-control'], 'no-cache');
  const m = JSON.parse(text(res));

  assert.equal(m.id, '/');
  assert.equal(m.name, 'Skill Trees');
  assert.ok(m.short_name && m.short_name.length <= 12, 'short enough for a home screen');
  assert.ok(m.description.length > 20);
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.lang, 'en');
  assert.equal(m.dir, 'ltr');
  assert.ok(Array.isArray(m.categories) && m.categories.includes('education'));

  // The light palette (style.css :root): --bg is what every page is painted
  // with, so the splash screen and the title bar match the page.
  const css = fs.readFileSync(path.join(FRONTEND, 'style.css'), 'utf8');
  const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(css)[1];
  assert.equal(m.background_color, bg);
  assert.equal(m.theme_color, bg);

  const svg = m.icons.find((i) => i.type === 'image/svg+xml');
  assert.equal(svg.sizes, 'any');
  const png = (size, purpose) =>
    m.icons.find((i) => i.type === 'image/png' && i.sizes === `${size}x${size}` && (i.purpose || 'any') === purpose);
  assert.ok(png(192, 'any'), '192px icon');
  assert.ok(png(512, 'any'), '512px icon');
  assert.ok(png(512, 'maskable'), '512px maskable icon');

  // Every icon exists, has the declared type, and is the size it claims.
  const icons = [...m.icons, ...m.shortcuts.flatMap((s) => s.icons || [])];
  for (const icon of icons) {
    const file = await raw(srv.base, icon.src);
    assert.equal(file.status, 200, icon.src);
    assert.equal(file.headers['content-type'], icon.type, icon.src);
    if (icon.type === 'image/png') {
      const { width, height } = pngSize(file.body);
      assert.equal(`${width}x${height}`, icon.sizes, icon.src);
    }
  }

  const shortcuts = Object.fromEntries(m.shortcuts.map((s) => [s.url, s]));
  assert.equal(shortcuts['/tree.html'].name, 'New skill tree');
  assert.ok(shortcuts['/#import'], 'an Import shortcut');
  assert.match(fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8'), /location\.hash !== '#import'/, 'app.js opens it');
});

test('every page links the manifest, the icons and the service worker, with the same theme colour', async () => {
  const manifest = JSON.parse(text(await raw(srv.base, '/manifest.webmanifest')));
  for (const page of PAGES) {
    const html = head(text(await raw(srv.base, page)));
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/, page);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" \/>/, page);
    assert.match(html, /<script src="\/pwa\.js" defer><\/script>/, page);
    assert.equal(metaContent(html, 'theme-color'), manifest.theme_color, page);
    assert.equal(metaContent(html, 'color-scheme'), 'light', page);
    assert.ok(metaContent(html, 'description').length > 20, page);
    for (const key of ['og:title', 'og:description', 'og:type', 'og:site_name', 'twitter:card']) {
      assert.ok(metaContent(html, key), `${page} ${key}`);
    }
    assert.equal(metaContent(html, 'og:site_name'), 'Skill Trees', page);
    // Without PUBLIC_ORIGIN there is no absolute URL to give.
    assert.equal(metaContent(html, 'og:url'), undefined, page);
    assert.equal(metaContent(html, 'og:image'), undefined, page);
    assert.doesNotMatch(html, /rel="canonical"/, page);
    assert.equal(metaContent(html, 'twitter:card'), 'summary', page);
    assert.ok(!html.includes(meta.PAGE_URLS), `${page}: the marker is always filled`);
  }
  const offline = text(await raw(srv.base, '/offline.html'));
  assert.equal(metaContent(offline, 'robots'), 'noindex');
  assert.match(offline, /<a class="skip-link" href="#main">/);
  assert.match(offline, /<main id="main"/);
  assert.equal((offline.match(/<script /g) || []).length, 2, 'theme.js and pwa.js, nothing inline');
  assert.doesNotMatch(offline, /<script>/);
});

test('with PUBLIC_ORIGIN, pages get absolute canonical, og:url and og:image', async () => {
  const expectations = {
    '/': `${ORIGIN}/`,
    '/viewer.html': `${ORIGIN}/viewer.html`,
    '/account.html': `${ORIGIN}/account.html`,
    '/tree.html': undefined, // a draft has no address of its own
    '/offline.html': undefined,
  };
  for (const [page, url] of Object.entries(expectations)) {
    const html = head(text(await raw(pub.base, page)));
    assert.equal(metaContent(html, 'og:url'), url, page);
    if (url) assert.match(html, new RegExp(`<link rel="canonical" href="${url.replace(/[.?]/g, '\\$&')}" />`), page);
    else assert.doesNotMatch(html, /rel="canonical"/, page);
    assert.equal(metaContent(html, 'og:image'), `${ORIGIN}/social-card.png`, page);
    assert.equal(metaContent(html, 'og:image:width'), '1200', page);
    assert.equal(metaContent(html, 'og:image:height'), '630', page);
    assert.ok(metaContent(html, 'og:image:alt'), page);
    assert.equal(metaContent(html, 'twitter:card'), 'summary_large_image', page);
  }
  const card = await raw(pub.base, '/social-card.png');
  assert.equal(card.headers['content-type'], 'image/png');
  assert.deepEqual(pngSize(card.body), { width: 1200, height: 630 });
});

// ---------- the service worker ----------

test('sw.js is JavaScript, no-cache, and runs under a CSP that lets it fetch from this origin only', async () => {
  const res = await raw(srv.base, '/sw.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /script-src/, 'it imports nothing');
  assert.doesNotMatch(csp, /unsafe/);

  // However the path is spelled.
  const dotted = await raw(srv.base, '/./sw.js');
  assert.equal(dotted.headers['content-security-policy'], csp);
  // Only the worker: other scripts keep the ordinary non-page policy.
  const app = await raw(srv.base, '/app.js');
  assert.match(app.headers['content-security-policy'], /^default-src 'none'; frame-ancestors 'none'/);
  assert.doesNotMatch(app.headers['content-security-policy'], /connect-src/);

  const pwa = await raw(srv.base, '/pwa.js');
  assert.equal(pwa.status, 200);
  assert.match(text(pwa), /navigator\.serviceWorker\.register\('\/sw\.js'/);
});

// The worker's lists, read by running sw.js against a stub `self` — the
// same values the browser sees, with no parsing of our own.
function workerLists() {
  const source = fs.readFileSync(path.join(FRONTEND, 'sw.js'), 'utf8');
  const context = vm.createContext({ self: { addEventListener() {}, location: { origin: 'http://x' } } });
  return vm.runInContext(`${source}\n;({ PRECACHE, PRECACHE_DATA, NETWORK_ONLY_PAGES, isPublicRead, storable })`, context);
}

test('everything the worker precaches exists (addAll is all or nothing)', async () => {
  const { PRECACHE, PRECACHE_DATA } = workerLists();
  assert.ok(PRECACHE.includes('/offline.html'));
  assert.ok(PRECACHE.includes('/fonts/inter-latin.woff2'));
  for (const url of [...PRECACHE, ...PRECACHE_DATA]) {
    const res = await raw(srv.base, url);
    assert.equal(res.status, 200, url);
  }
  // Every script a page loads is in the shell, so a saved page can run.
  for (const page of ['/', '/tree.html', '/viewer.html']) {
    const html = text(await raw(srv.base, page));
    for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
      assert.ok(PRECACHE.includes(src), `${page} loads ${src}, which the worker should precache`);
    }
  }
});

test("the worker's caching rules: public reads only, nothing private or failed", () => {
  const { isPublicRead, storable, NETWORK_ONLY_PAGES } = workerLists();
  const u = (p) => new URL(p, 'http://x');
  assert.ok(isPublicRead(u('/api/trees')));
  assert.ok(isPublicRead(u('/api/trees/12')));
  for (const p of ['/api/auth/me', '/api/auth/identities', '/api/trees/12/export', '/api/trees/import', '/api/reports']) {
    assert.ok(!isPublicRead(u(p)), p);
  }
  assert.ok(NETWORK_ONLY_PAGES.has('/account.html'));

  const response = (status, headers = {}, extra = {}) => ({
    status,
    type: 'basic',
    redirected: false,
    headers: new Headers(headers),
    ...extra,
  });
  assert.ok(storable(response(200, { 'Cache-Control': 'no-cache' })));
  assert.ok(storable(response(200, { 'Cache-Control': 'public, max-age=31536000, immutable' })));
  assert.ok(!storable(response(200, { 'Cache-Control': 'private, no-store' })), 'a session response');
  assert.ok(!storable(response(200, { 'Cache-Control': 'no-store' })));
  assert.ok(!storable(response(200, { 'Cache-Control': 'private' })));
  assert.ok(!storable(response(200, { Vary: '*' })));
  assert.ok(!storable(response(404)));
  assert.ok(!storable(response(500)));
  assert.ok(!storable(response(206)));
  assert.ok(!storable(response(0, {}, { type: 'opaqueredirect' })));
  assert.ok(!storable(response(0, {}, { type: 'opaque' })));
  assert.ok(!storable(response(200, {}, { redirected: true })));
  assert.ok(!storable(undefined));
});

test('what the worker would cache from the API is marked cacheable, and the session is not', async () => {
  const { storable } = workerLists();
  const asWorkerSees = (res) => ({ status: res.status, type: 'basic', redirected: false, headers: new Headers(res.headers) });
  assert.ok(storable(asWorkerSees(await raw(srv.base, '/api/trees'))));
  const me = await raw(srv.base, '/api/auth/me', { headers: { Cookie: owner.cookie } });
  assert.equal(me.status, 200);
  assert.ok(!storable(asWorkerSees(me)), '/api/auth/me must never be stored');
});

// ---------- a tree page's own metadata ----------

// Everything a tree's author controls, each written to break out of where
// it lands: an attribute, <title>, the JSON-LD script element, the markers,
// and String.replace()'s "$" patterns.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const HOSTILE = {
  title: `"><script>alert(1)</script> & 'q' $& $' <!--@page-urls--> ${LS}${PS} end`,
  description: `</script><script>alert(2)</script>\n<!-- <p onclick="x">  $\` & more`,
  author: `" onmouseover="alert(3)" x="</title><script>alert(4)</script>`,
  skills: ['</script><img src=x onerror=alert(5)>', '<!--/@tree-meta-->', `Plain ${LS} skill`],
};

test('a tree page carries the tree’s title, description, Open Graph and JSON-LD — all of it inert', async () => {
  const tree = await makeTree(owner, HOSTILE);
  const res = await raw(srv.base, `/tree.html?id=${tree.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  const html = text(res);
  const h = head(html);

  // Exactly the scripts the page ships with, plus one JSON-LD block: none
  // of the hostile text became an element.
  const generic = text(await raw(srv.base, '/tree.html'));
  const scripts = (s) => (s.match(/<script/gi) || []).length;
  assert.equal(scripts(html), scripts(generic) + 1);
  assert.equal((html.match(/<\/script>/gi) || []).length, scripts(generic) + 1);
  assert.equal((h.match(/<title>/g) || []).length, 1);
  assert.equal((html.match(/<\/title>/g) || []).length, 1);
  assert.doesNotMatch(html, /<img/);
  // Every "<" in the <head> opens one of our own tags or comments — the
  // hostile text contributed none — and no tag grew an event handler.
  const tags = tagsOf(h);
  const comments = (h.match(/<!--/g) || []).length;
  assert.equal((h.match(/</g) || []).length, tags.length + comments + 1 /* doctype */);
  for (const tag of tags) {
    assert.ok(['html', 'head', 'meta', 'title', '/title', 'link', 'script', '/script'].includes(tag.name), tag.name);
    assert.ok(!tag.attrs.some((a) => a.startsWith('on')), JSON.stringify(tag));
  }
  // The markers were consumed and none was planted.
  assert.ok(!html.includes('<!--@tree-meta-->') && !html.includes('<!--/@tree-meta-->'));
  assert.ok(!html.includes(meta.PAGE_URLS));
  // Nothing the template doesn't contain came in through a "$" pattern.
  assert.equal(html.split('<!DOCTYPE html>').length, 2);

  // Round trip: what the attributes and <title> say, decoded, is exactly
  // what was saved (the description flattened to one line).
  const title = unescapeHtml(/<title>([^<]*)<\/title>/.exec(h)[1]);
  assert.equal(title, `${tree.title} — Skill Trees`);
  assert.equal(metaContent(h, 'og:title'), tree.title);
  assert.equal(metaContent(h, 'og:type'), 'article');
  assert.equal(metaContent(h, 'description'), meta.oneLine(tree.description));
  assert.equal(metaContent(h, 'og:description'), meta.oneLine(tree.description));
  assert.match(metaContent(h, 'article:published_time'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // JSON-LD: no <, >, & or line separator inside the element, and the data
  // survives intact.
  const block = jsonLdOf(h);
  assert.ok(block);
  assert.doesNotMatch(block, /[<>&]/);
  assert.ok(!block.includes(LS) && !block.includes(PS));
  const ld = JSON.parse(block);
  assert.equal(ld['@context'], 'https://schema.org');
  assert.equal(ld['@type'], 'LearningResource');
  assert.equal(ld.name, tree.title);
  assert.equal(ld.description, tree.description);
  assert.deepEqual(ld.author, { '@type': 'Person', name: tree.author });
  assert.match(ld.dateCreated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(ld.teaches, HOSTILE.skills);
  assert.equal(ld.url, undefined, 'no absolute URL without PUBLIC_ORIGIN');
  assert.equal(metaContent(h, 'og:url'), undefined);
});

test('the JSON-LD skill list is bounded', async () => {
  const skills = Array.from({ length: meta.MAX_TAUGHT + 5 }, (_, i) => `Skill ${i + 1}`);
  const tree = await makeTree(owner, { title: 'Many skills', skills });
  const html = text(await raw(srv.base, `/tree.html?id=${tree.id}`));
  const ld = JSON.parse(jsonLdOf(html));
  assert.deepEqual(ld.teaches, skills.slice(0, meta.MAX_TAUGHT));
  // No description of its own: one is made up from what is known.
  assert.equal(metaContent(html, 'description'), `Many skills: a skill tree of ${skills.length} skills, by pwaowner.`);
});

test('with PUBLIC_ORIGIN a tree page has its canonical URL, normalised', async () => {
  const tree = await makeTree(pubOwner, { title: 'Public tree', description: 'Out in the open.', skills: ['One'] });
  const url = `${ORIGIN}/tree.html?id=${tree.id}`;
  for (const spelling of [`/tree.html?id=${tree.id}`, `/tree.html?id=0${tree.id}&utm_source=x`]) {
    const h = head(text(await raw(pub.base, spelling)));
    assert.match(h, new RegExp(`<link rel="canonical" href="${url.replace(/[.?]/g, '\\$&')}" />`), spelling);
    assert.equal(metaContent(h, 'og:url'), url, spelling);
    assert.equal(JSON.parse(jsonLdOf(h)).url, url, spelling);
    assert.equal(metaContent(h, 'og:image'), `${ORIGIN}/social-card.png`);
    assert.equal(metaContent(h, 'twitter:card'), 'summary_large_image');
  }
});

test('a tree page: its ETag follows the tree, 304 on repeat, HEAD and compression work', async () => {
  const a = await makeTree(owner, { title: 'Etag one', description: 'First.', skills: ['A'] });
  const b = await makeTree(owner, { title: 'Etag two', description: 'First.', skills: ['A'] });
  const first = await raw(srv.base, `/tree.html?id=${a.id}`);
  assert.equal(first.status, 200);
  assert.ok(first.headers.etag);
  assert.equal(first.headers['last-modified'], undefined, 'no modification time to give');
  assert.equal(first.headers['cache-control'], 'no-cache');

  const other = await raw(srv.base, `/tree.html?id=${b.id}`);
  assert.notEqual(other.headers.etag, first.headers.etag, 'a different tree is a different page');

  const again = await raw(srv.base, `/tree.html?id=${a.id}`, { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.match(again.headers['content-security-policy'], /script-src 'self'/, "the page's CSP on its 304");

  // If-Modified-Since alone can't vouch for a tree page.
  const since = await raw(srv.base, `/tree.html?id=${a.id}`, {
    headers: { 'If-Modified-Since': new Date(Date.now() + 60000).toUTCString() },
  });
  assert.equal(since.status, 200);

  const renamed = await owner.fetch(`/api/trees/${a.id}`, { method: 'PATCH', body: { title: 'Etag one, renamed' } });
  assert.equal(renamed.status, 200);
  const after = await raw(srv.base, `/tree.html?id=${a.id}`, { headers: { 'If-None-Match': first.headers.etag } });
  assert.equal(after.status, 200, 'the old ETag no longer matches');
  assert.notEqual(after.headers.etag, first.headers.etag);
  assert.match(text(after), /<title>Etag one, renamed — Skill Trees<\/title>/);

  const headRes = await raw(srv.base, `/tree.html?id=${a.id}`, { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.body.length, 0);
  assert.equal(headRes.headers.etag, after.headers.etag);
  assert.equal(headRes.headers['content-length'], String(after.body.length));

  const br = await raw(srv.base, `/tree.html?id=${a.id}`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(text(br), text(after));
  assert.equal(br.headers.etag, after.headers.etag.slice(0, -1) + '-br"');
  assert.match(br.headers.vary, /Accept-Encoding/);
});

test('no tree, no tree metadata: drafts, bad ids and unknown ids get the page as it is', async () => {
  const generic = await raw(srv.base, '/tree.html');
  for (const spelling of ['/tree.html?id=999999', '/tree.html?id=abc', '/tree.html?id=', '/tree.html?id=-1', '/tree.html?x=1']) {
    const res = await raw(srv.base, spelling);
    assert.equal(res.status, 200, spelling);
    assert.equal(res.headers.etag, generic.headers.etag, spelling);
    const h = head(text(res));
    assert.match(h, /<title>Skill Tree<\/title>/, spelling);
    assert.equal(jsonLdOf(h), null, spelling);
  }
  // Pages without a tree keep an honest Last-Modified, and it still works.
  assert.ok(generic.headers['last-modified']);
  const since = await raw(srv.base, '/tree.html', { headers: { 'If-Modified-Since': generic.headers['last-modified'] } });
  assert.equal(since.status, 304);
});

test('lib/meta.js escapers', () => {
  assert.equal(meta.escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(meta.escapeXml(`<"&'>`), '&lt;&quot;&amp;&apos;&gt;');
  assert.equal(meta.escapeXml('a\u0001b\u000bc\td'), 'abc\td', 'XML 1.0 has no place for most controls');
  const json = meta.jsonForScript({ s: `</script><!--${LS}${PS}&` });
  assert.equal(json, '{"s":"\\u003c/script\\u003e\\u003c!--\\u2028\\u2029\\u0026"}');
  assert.deepEqual(JSON.parse(json), { s: `</script><!--${LS}${PS}&` });
  assert.equal(meta.isoDatetime('2026-09-24 08:09:01'), '2026-09-24T08:09:01Z');
  assert.equal(meta.isoDatetime('nonsense'), null);
  assert.equal(meta.oneLine('a\n\n b\tc'), 'a b c');
  const long = meta.oneLine('word '.repeat(100));
  assert.ok(long.length <= 200 && long.endsWith('…'), long);
  // A blank description gets the made-up one; a missing date, no date.
  const blank = meta.treeHead({
    tree: { id: 3, title: 'T', description: '  \n ', author: '', created_at: null },
    skillCount: 1,
    skillNames: ['A'],
  });
  assert.match(blank, /<meta name="description" content="T: a skill tree of 1 skill\." \/>/);
  assert.doesNotMatch(blank, /article:published_time/);
  const blankLd = JSON.parse(jsonLdOf(blank));
  assert.equal(blankLd.description, undefined);
  assert.equal(blankLd.author, undefined);
  assert.equal(blankLd.dateCreated, undefined);
  // A marker whose closing half is missing leaves the page alone.
  const broken = '<head><!--@tree-meta--><title>x</title></head>';
  assert.equal(
    meta.renderPage(broken, { pagePath: '/tree.html', tree: { tree: { id: 1, title: 't' }, skillCount: 0, skillNames: [] } }),
    broken
  );
});

// ---------- robots.txt and the sitemap ----------

test('robots.txt: everything but the API, and a Sitemap line only with PUBLIC_ORIGIN', async () => {
  const plain = await raw(srv.base, '/robots.txt');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-type'], 'text/plain; charset=utf-8');
  const lines = text(plain).trimEnd().split('\n');
  assert.ok(lines.includes('User-agent: *'));
  assert.ok(lines.includes('Allow: /'));
  assert.ok(lines.includes('Disallow: /api/'));
  assert.ok(!lines.some((l) => l.startsWith('Sitemap:')), 'no absolute URL to give');

  const configured = text(await raw(pub.base, '/robots.txt')).trimEnd().split('\n');
  assert.ok(configured.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));

  const headRes = await raw(srv.base, '/robots.txt', { method: 'HEAD' });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.body.length, 0);
  const post = await raw(srv.base, '/robots.txt', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD, OPTIONS');
  const options = await raw(srv.base, '/robots.txt', { method: 'OPTIONS' });
  assert.equal(options.status, 204);
  assert.equal(options.headers.allow, 'GET, HEAD, OPTIONS');
});

test('sitemap.xml: 404 without PUBLIC_ORIGIN, otherwise the homepage and every tree', async () => {
  assert.equal((await raw(srv.base, '/sitemap.xml')).status, 404);

  const t1 = await makeTree(pubOwner, { title: 'Sitemap <one> & "two"' });
  const t2 = await makeTree(pubOwner, { title: 'Sitemap three' });
  const res = await raw(pub.base, '/sitemap.xml', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/xml; charset=utf-8');
  assert.match(res.headers.vary, /Accept-Encoding/, 'XML is text: compressed like the rest once large enough');
  const xml = text(res);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /<\/urlset>\n$/);
  assert.ok(xml.includes(`<url><loc>${ORIGIN}/</loc></url>`));
  for (const t of [t1, t2]) {
    assert.match(
      xml,
      new RegExp(`<url><loc>${ORIGIN.replace(/\./g, '\\.')}/tree\\.html\\?id=${t.id}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z</lastmod></url>`)
    );
  }
  assert.ok(!xml.includes('Sitemap <one>'), 'titles are not in a sitemap at all');
  const trees = (await pub.request('/api/trees')).data;
  assert.equal((xml.match(/<url>/g) || []).length, trees.length + 1);

  const again = await raw(pub.base, '/sitemap.xml', {
    headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': res.headers.etag },
  });
  assert.equal(again.status, 304);
  assert.equal((await raw(pub.base, '/sitemap.xml', { method: 'HEAD' })).status, 200);
  assert.equal((await raw(pub.base, '/sitemap.xml', { method: 'DELETE' })).status, 405);
});

test('sitemapXml escapes every <loc> and stops at 50,000 URLs', () => {
  const xml = meta.sitemapXml('https://a.example/?x=1&y=<2>', [{ id: 1, created_at: '2026-01-02 03:04:05' }]);
  assert.ok(xml.includes('<loc>https://a.example/?x=1&amp;y=&lt;2&gt;/</loc>'));
  assert.ok(xml.includes('<lastmod>2026-01-02T03:04:05Z</lastmod>'));
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/, 'no bare ampersand');

  const many = Array.from({ length: 60000 }, (_, i) => ({ id: i + 1, created_at: '2026-01-01 00:00:00' }));
  const big = meta.sitemapXml('https://a.example', many);
  assert.equal((big.match(/<url>/g) || []).length, meta.MAX_SITEMAP_URLS);
});

// ---------- well-known URLs ----------

test('/.well-known/change-password redirects to the password section of the account page', async () => {
  for (const method of ['GET', 'HEAD']) {
    const res = await raw(srv.base, '/.well-known/change-password', { method });
    assert.equal(res.status, 302, method);
    assert.equal(res.headers.location, '/account.html#account-password', method);
    assert.equal(res.body.length, 0);
  }
  const post = await raw(srv.base, '/.well-known/change-password', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD, OPTIONS');
  // The page itself is not at the well-known URL (RFC 8615 §1.1), and a
  // made-up well-known resource is still a 404 — which is how password
  // managers check that a 302 here means something.
  assert.equal((await raw(srv.base, '/.well-known/not-a-thing')).status, 404);
});

test('/.well-known/passkey-endpoints: absolute URLs with PUBLIC_ORIGIN, 404 without', async () => {
  assert.equal((await raw(srv.base, '/.well-known/passkey-endpoints')).status, 404);
  const res = await raw(pub.base, '/.well-known/passkey-endpoints');
  assert.equal(res.status, 200, 'the spec forbids a redirect');
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(text(res)), {
    enroll: `${ORIGIN}/account.html#account-passkeys`,
    manage: `${ORIGIN}/account.html#account-passkeys`,
  });
  assert.equal((await raw(pub.base, '/.well-known/passkey-endpoints', { method: 'HEAD' })).status, 200);
  assert.equal((await raw(pub.base, '/.well-known/passkey-endpoints', { method: 'PUT' })).status, 405);
});

// ---------- speculation rules ----------

test('pages name the speculation rules, which are served with their own media type', async () => {
  for (const page of PAGES) {
    const res = await raw(srv.base, page);
    assert.equal(res.headers['speculation-rules'], '"/speculationrules.json"', page);
  }
  for (const other of ['/app.js', '/style.css', '/api/trees', '/manifest.webmanifest']) {
    assert.equal((await raw(srv.base, other)).headers['speculation-rules'], undefined, other);
  }

  const res = await raw(srv.base, '/speculationrules.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/speculationrules+json');
  assert.equal(res.headers['cache-control'], 'no-cache');
  const rules = JSON.parse(text(res));
  assert.equal(rules.prerender, undefined, 'prefetch only: a prerender would run the page');
  assert.equal(rules.prefetch.length, 1);
  const [rule] = rules.prefetch;
  assert.equal(rule.source, 'document');
  assert.equal(rule.eagerness, 'moderate');
  const conditions = JSON.stringify(rule.where);
  assert.ok(rule.where.and.some((c) => c.href_matches === '/tree.html?id=*'), 'tree pages, with an id');
  for (const excluded of ['/api/*', '/account.html*', '[data-no-prefetch]']) {
    assert.ok(conditions.includes(excluded), excluded);
  }
});
