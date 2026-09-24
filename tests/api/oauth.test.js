// Sign-in through another provider (OAuth 2.0 / OpenID Connect), end to end:
// a real server in its own process, and the mock provider in
// tests/helpers/mock-oidc.js standing in for GitHub, Google or an SSO.
//
// The server throttles flow starts per address (ten per window, given back
// when a sign-in completes). Every request here comes from 127.0.0.1, so the
// suites that deliberately fail flows each get a server of their own rather
// than sharing one and tripping over each other's counts.

const test = require('node:test');
const { describe, before, after, beforeEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const { startServer } = require('../helpers/server');
const { startMockOidc } = require('../helpers/mock-oidc');

let mock;
before(async () => {
  mock = await startMockOidc();
});
after(async () => {
  await mock.stop();
});

// PUBLIC_ORIGIN has to be known before the server starts, so the port can't
// be left to PORT=0: take one the OS hands out, release it, and use it.
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startOAuthServer(env = {}) {
  const port = await freePort();
  return startServer({
    env: {
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      OIDC_ISSUER: mock.issuer,
      OIDC_CLIENT_ID: mock.clientId,
      OIDC_CLIENT_SECRET: mock.clientSecret,
      OIDC_NAME: 'Test SSO',
      ...env,
    },
  });
}

// A browser, as far as cookies go: remembers what it is sent, forgets what
// is cleared, and sends the rest back.
function browser(srv, { headers: always = {} } = {}) {
  const jar = new Map();
  const b = {
    jar,
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
    },
    async fetch(path, { headers = {}, ...opts } = {}) {
      const res = await srv.request(path, {
        cookie: b.cookie() || undefined,
        headers: { ...always, ...headers },
        ...opts,
      });
      b.absorb(res);
      return res;
    },
    // POST .../start the way the page does: same-origin, JSON.
    start(provider = 'oidc', body = {}, { headers = {} } = {}) {
      return b.fetch(`/api/auth/oauth/${provider}/start`, {
        method: 'POST',
        body,
        headers: { Origin: srv.base, ...headers },
      });
    },
    // Follows a callback URL (an absolute one, from the provider's redirect).
    back(callbackUrl, opts = {}) {
      const url = new URL(callbackUrl);
      return b.fetch(url.pathname + url.search, opts);
    },
    // The whole round trip: start, the provider's auto-approval, callback.
    async signIn(provider = 'oidc', body = {}) {
      const started = await b.start(provider, body);
      assert.equal(started.status, 200, `start failed: ${started.text_}`);
      const callbackUrl = await atProvider(started.data.authorization_url);
      return b.back(callbackUrl);
    },
    me: async () => (await b.fetch('/api/auth/me')).data.user,
  };
  return b;
}

// The provider's side: it approves at once and redirects back.
async function atProvider(authorizationUrl) {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(res.status, 302, 'the mock provider should redirect back');
  return res.headers.get('location');
}

function errorCode(res) {
  assert.equal(res.status, 303);
  const url = new URL(res.headers.get('location'), 'http://x.invalid');
  assert.equal(url.pathname, '/account.html');
  return url.searchParams.get('oauth_error');
}

function setCookieNamed(res, name) {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

// Waits for a line in the server's log (it arrives over the child's stdout,
// separately from the HTTP response that prompted it).
async function waitForLog(srv, pattern) {
  for (let i = 0; i < 100 && !pattern.test(srv.logs.join('')); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(srv.logs.join(''), pattern);
}

// The refusal has to be for the reason the test is about, not some earlier
// check tripping by accident — so the server's own log line is checked too.
// It arrives over the child's stdout, so give it a moment.
async function logged(srv, pattern) {
  const last = () => {
    const lines = srv.logs.join('').split('\n').filter((l) => l.includes('oauth refused'));
    return lines[lines.length - 1] || '';
  };
  for (let i = 0; i < 50 && !pattern.test(last()); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(last(), pattern, 'the server refused it for this reason');
}

async function assertSignedOut(b, res) {
  assert.equal(setCookieNamed(res, 'skilltree_session'), undefined, 'no session cookie');
  assert.match(setCookieNamed(res, 'skilltree_oauth') || '', /Max-Age=0/, 'flow cookie cleared');
  assert.equal(await b.me(), null);
}

const pkce = (verifier) => crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

beforeEach(() => mock && mock.reset());

// ---------------------------------------------------------------------------

describe('with nothing configured', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => srv.stop());

  test('the provider list is empty and every provider route is closed', async () => {
    const list = await srv.request('/api/auth/providers');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data, []);

    const start = await srv.request('/api/auth/oauth/github/start', { method: 'POST', body: {} });
    assert.equal(start.status, 404);
    const back = await srv.request('/api/auth/oauth/github/callback?code=x&state=y');
    assert.equal(errorCode(back), 'unavailable');
    assert.ok(srv.logs.join('').includes('off (none configured'), 'startup log says why');
  });

  test('password accounts report has_password, and identities need a session', async () => {
    const alice = await srv.signup('alice');
    const me = await alice.fetch('/api/auth/me');
    assert.equal(me.data.user.has_password, true);
    assert.equal((await srv.request('/api/auth/identities')).status, 401);
    assert.deepEqual((await alice.fetch('/api/auth/identities')).data, []);
  });

  test('over HTTPS the session cookie is __Host- prefixed, and only that name counts', async () => {
    const https = { 'X-Forwarded-Proto': 'https' };
    await srv.signup('hana');
    const login = await srv.request('/api/auth/login', {
      method: 'POST',
      body: { username: 'hana', password: 'correct horse battery staple' },
      headers: https,
    });
    assert.equal(login.status, 200);
    const cookie = setCookieNamed(login, '__Host-skilltree_session');
    assert.ok(cookie, 'sets __Host-skilltree_session');
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; Path=\//);
    assert.doesNotMatch(cookie, /Domain=/i);
    const token = cookie.split(';')[0].split('=')[1];

    const withHost = await srv.request('/api/auth/me', {
      cookie: `__Host-skilltree_session=${token}`,
      headers: https,
    });
    assert.equal(withHost.data.user.username, 'hana');

    // The same token under the plain name is what a tossed cookie would
    // look like; a secure request ignores it.
    const plain = await srv.request('/api/auth/me', { cookie: `skilltree_session=${token}`, headers: https });
    assert.equal(plain.data.user, null);
    // And plain http keeps the plain name.
    const overHttp = await srv.request('/api/auth/me', { cookie: `skilltree_session=${token}` });
    assert.equal(overHttp.data.user.username, 'hana');
  });

  test('logout sends Clear-Site-Data: "cookies"', async () => {
    const carol = await srv.signup('carol');
    const res = await carol.fetch('/api/auth/logout', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('clear-site-data'), '"cookies"');
    assert.equal((await carol.fetch('/api/auth/me')).data.user, null);
  });
});

// ---------------------------------------------------------------------------

describe('a provider that cannot be used', () => {
  test('unreachable: listed, but the start answers 503 and the log says why', async () => {
    const nobody = `http://127.0.0.1:${await freePort()}`; // nothing listens here
    const srv = await startOAuthServer({ OIDC_ISSUER: nobody });
    try {
      const res = await browser(srv).start('oidc');
      assert.equal(res.status, 503);
      assert.match(res.data.error, /not available right now/);
      assert.equal(setCookieNamed(res, 'skilltree_oauth'), undefined, 'no flow was made');
      await waitForLog(srv, /Test SSO is not reachable yet/);
    } finally {
      await srv.stop();
    }
  });

  test('a discovery document naming another issuer is not trusted', async () => {
    // Configured with a trailing slash; the document says it without one.
    const srv = await startOAuthServer({ OIDC_ISSUER: `${mock.issuer}/` });
    try {
      const res = await browser(srv).start('oidc');
      assert.equal(res.status, 503);
      await waitForLog(srv, /must match exactly/);
    } finally {
      await srv.stop();
    }
  });

  test('a provider without PKCE S256 is not used', async () => {
    mock.set({ discovery: { code_challenge_methods_supported: ['plain'] } });
    const srv = await startOAuthServer();
    try {
      const res = await browser(srv).start('oidc');
      assert.equal(res.status, 503);
      await waitForLog(srv, /does not support PKCE with S256/);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------

describe('signing in and linking', () => {
  let srv;
  before(async () => {
    srv = await startOAuthServer();
  });
  after(async () => srv.stop());

  let adaId;

  test('the provider list names what is configured and nothing secret', async () => {
    const res = await srv.request('/api/auth/providers');
    assert.deepEqual(res.data, [{ id: 'oidc', name: 'Test SSO' }]);
    assert.ok(!res.text_.includes(mock.clientSecret));
    assert.ok(!srv.logs.join('').includes(mock.clientSecret), 'the secret is never logged');
  });

  test('a first sign-in creates an account with a working session', async () => {
    const b = browser(srv);
    const res = await b.signIn('oidc', { next: '/tree.html?id=3#skill-2' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/tree.html?id=3#skill-2');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(setCookieNamed(res, 'skilltree_session'), 'a session cookie is set');
    assert.match(setCookieNamed(res, 'skilltree_oauth'), /Max-Age=0/, 'the flow cookie is cleared');

    const me = await b.me();
    assert.equal(me.username, 'ada');
    assert.equal(me.has_password, false);
    adaId = me.id;

    const ids = await b.fetch('/api/auth/identities');
    assert.equal(ids.data.length, 1);
    assert.equal(ids.data[0].provider, 'oidc');
    assert.equal(ids.data[0].provider_name, 'Test SSO');
    assert.equal(ids.data[0].display_name, 'ada');
    assert.equal(ids.data[0].enabled, true);

    // The account can write, like any other.
    const tree = await b.fetch('/api/trees', { method: 'POST', body: { title: 'Made via SSO' } });
    assert.equal(tree.status, 201);
  });

  test('the PKCE verifier reaches the token endpoint and matches the challenge', async () => {
    const b = browser(srv);
    const started = await b.start('oidc');
    const auth = new URL(started.data.authorization_url);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const before = mock.tokenRequests.length;
    await b.back(await atProvider(auth.href));
    const sent = mock.tokenRequests[before];
    assert.ok(sent, 'the token endpoint was called');
    assert.match(sent.code_verifier, /^[A-Za-z0-9._~-]{43,128}$/);
    assert.equal(pkce(sent.code_verifier), auth.searchParams.get('code_challenge'));
    assert.equal(sent.pkce, 'ok');
    assert.equal(sent.redirect_uri, auth.searchParams.get('redirect_uri'), 'same redirect_uri both times');
    assert.equal(sent.auth, 'basic', 'client_secret_basic, as the discovery document allows');
  });

  test('signing in again reaches the same account, with a fresh session', async () => {
    const first = browser(srv);
    await first.signIn();
    const second = browser(srv);
    await second.signIn();
    assert.equal((await first.me()).id, adaId);
    assert.equal((await second.me()).id, adaId);
    assert.notEqual(first.jar.get('skilltree_session'), second.jar.get('skilltree_session'));
  });

  test('signing in again from a signed-in browser ends the old session', async () => {
    const b = browser(srv);
    await b.signIn();
    const oldToken = b.jar.get('skilltree_session');
    await b.signIn();
    assert.notEqual(b.jar.get('skilltree_session'), oldToken);
    const stale = await srv.request('/api/auth/me', { cookie: `skilltree_session=${oldToken}` });
    assert.equal(stale.data.user, null);
  });

  test('a new identity gets a unique, sanitised username — never an email match', async () => {
    // Same preferred_username, different person: a suffix, not ada's account.
    mock.user = { sub: 'user-2', preferred_username: 'ADA', email: 'ada@example.com' };
    const b = browser(srv);
    await b.signIn();
    const me = await b.me();
    assert.notEqual(me.id, adaId, 'same email, same name, still a different account');
    assert.match(me.username, /^ADA-\d+$/);

    mock.user = { sub: 'user-3', email: 'zoë.o’brien@example.com' };
    const z = browser(srv);
    await z.signIn();
    assert.equal((await z.me()).username, 'zoe-o-brien');

    mock.user = { sub: 'user-4' };
    const nameless = browser(srv);
    await nameless.signIn();
    assert.match((await nameless.me()).username, /^[a-zA-Z0-9_-]{3,40}$/);
  });

  test('a password login to an account with no password fails like any other', async () => {
    const res = await srv.request('/api/auth/login', {
      method: 'POST',
      body: { username: 'ada', password: 'anything-at-all-123' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.error, 'Wrong username or password.');
  });

  test('next is kept to this site, whatever it says', async () => {
    const attempts = [
      '//evil.example/',
      '/\\evil.example',
      'https://evil.example/',
      '/\t/evil.example',
      '/\n/evil.example',
      'javascript:alert(1)',
      'evil.example',
      '',
    ];
    for (const next of attempts) {
      const b = browser(srv);
      const res = await b.signIn('oidc', { next });
      assert.equal(res.headers.get('location'), '/#browse', `next=${JSON.stringify(next)}`);
    }
    // Percent-encoded, a tab is just part of a path on this site.
    const b = browser(srv);
    const res = await b.signIn('oidc', { next: '/%09/evil.example' });
    const location = res.headers.get('location');
    assert.ok(location.startsWith('/') && !location.startsWith('//'), location);
  });

  test('a start from another site is refused', async () => {
    const b = browser(srv);
    const res = await b.start('oidc', {}, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('over HTTPS the flow and session cookies are __Host- prefixed', async () => {
    const b = browser(srv, { headers: { 'X-Forwarded-Proto': 'https' } });
    const started = await b.start('oidc');
    const flow = setCookieNamed(started, '__Host-skilltree_oauth');
    assert.ok(flow, 'flow cookie is __Host- prefixed');
    assert.match(flow, /HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=600/);
    const res = await b.back(await atProvider(started.data.authorization_url));
    assert.equal(res.status, 303);
    assert.ok(setCookieNamed(res, '__Host-skilltree_session'));
    assert.match(setCookieNamed(res, '__Host-skilltree_oauth'), /Max-Age=0/);
    assert.equal((await b.me()).id, adaId);
  });

  let alice;
  let aliceIdentityId;

  test('a signed-in account can connect a provider, and then sign in with it', async () => {
    alice = browser(srv);
    const signup = await alice.fetch('/api/auth/signup', {
      method: 'POST',
      body: { username: 'alice', password: 'correct horse battery staple' },
    });
    assert.equal(signup.status, 201);

    mock.user = { sub: 'alice-at-sso', preferred_username: 'alice.sso' };
    const res = await alice.signIn('oidc', { intent: 'link' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/account.html');
    assert.equal((await alice.me()).username, 'alice', 'still alice; linking is not a login');

    const ids = (await alice.fetch('/api/auth/identities')).data;
    assert.equal(ids.length, 1);
    assert.equal(ids[0].display_name, 'alice.sso');
    aliceIdentityId = ids[0].id;

    const elsewhere = browser(srv);
    await elsewhere.signIn();
    assert.equal((await elsewhere.me()).username, 'alice');
  });

  test('another account cannot claim an identity that is already connected', async () => {
    const bob = browser(srv);
    await bob.fetch('/api/auth/signup', {
      method: 'POST',
      body: { username: 'bob', password: 'correct horse battery staple' },
    });
    mock.user = { sub: 'alice-at-sso', preferred_username: 'alice.sso' };
    const res = await bob.signIn('oidc', { intent: 'link' });
    assert.equal(errorCode(res), 'identity_taken');
    assert.deepEqual((await bob.fetch('/api/auth/identities')).data, []);
    assert.equal((await bob.me()).username, 'bob');
  });

  test('linking needs a session at the start and the same one at the end', async () => {
    const stranger = browser(srv);
    const res = await stranger.start('oidc', { intent: 'link' });
    assert.equal(res.status, 401);

    const carol = browser(srv);
    await carol.fetch('/api/auth/signup', {
      method: 'POST',
      body: { username: 'carol', password: 'correct horse battery staple' },
    });
    mock.user = { sub: 'carol-at-sso' };
    const started = await carol.start('oidc', { intent: 'link' });
    const callbackUrl = await atProvider(started.data.authorization_url);
    await carol.fetch('/api/auth/logout', { method: 'POST' });
    const finished = await carol.back(callbackUrl);
    assert.equal(errorCode(finished), 'link_session');
    const carolAgain = await srv.request('/api/auth/login', {
      method: 'POST',
      body: { username: 'carol', password: 'correct horse battery staple' },
    });
    assert.equal(carolAgain.status, 200);
  });

  test('the last way to sign in cannot be removed', async () => {
    const ada = browser(srv);
    await ada.signIn();
    const [identity] = (await ada.fetch('/api/auth/identities')).data;
    const refused = await ada.fetch(`/api/auth/identities/${identity.id}`, { method: 'DELETE' });
    assert.equal(refused.status, 409);
    assert.equal((await ada.fetch('/api/auth/identities')).data.length, 1);

    // Someone else's identity looks like one that doesn't exist.
    const theirs = await ada.fetch(`/api/auth/identities/${aliceIdentityId}`, { method: 'DELETE' });
    assert.equal(theirs.status, 404);

    // alice still has her password, so her connection can go.
    const removed = await alice.fetch(`/api/auth/identities/${aliceIdentityId}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual((await alice.fetch('/api/auth/identities')).data, []);
  });

  test('an identity from an issuer no longer configured is listed as unusable', async () => {
    const dora = browser(srv);
    await dora.fetch('/api/auth/signup', {
      method: 'POST',
      body: { username: 'dora', password: 'correct horse battery staple' },
    });
    mock.user = { sub: 'dora-at-sso' };
    await dora.signIn('oidc', { intent: 'link' });
    assert.equal((await dora.fetch('/api/auth/identities')).data[0].enabled, true);

    // The operator points OIDC_ISSUER somewhere new; the row keeps the old one.
    const db = new DatabaseSync(srv.dbPath);
    db.prepare(`UPDATE user_identities SET issuer = 'https://old-idp.example' WHERE subject = 'dora-at-sso'`).run();
    db.close();
    assert.equal((await dora.fetch('/api/auth/identities')).data[0].enabled, false);

    // A subject means nothing under another issuer: the same sub at the
    // current one is somebody new, not dora.
    const fresh = browser(srv);
    await fresh.signIn();
    assert.notEqual((await fresh.me()).username, 'dora');
  });

  test('log lines never carry codes, tokens or the client secret', async () => {
    const logs = srv.logs.join('');
    assert.ok(!logs.includes(mock.clientSecret));
    assert.doesNotMatch(logs, /code=|access_token|id_token|eyJ/);
    assert.match(logs, /\[AUTH\] oauth login success provider=oidc/);
  });
});

// ---------------------------------------------------------------------------

describe('callbacks that must be refused', () => {
  let srv;
  before(async () => {
    srv = await startOAuthServer();
  });
  after(async () => srv.stop());

  test('without the flow cookie (login CSRF)', async () => {
    const attacker = browser(srv);
    const started = await attacker.start('oidc');
    const callbackUrl = await atProvider(started.data.authorization_url);
    // The victim's browser opens the attacker's callback URL. It has no
    // flow cookie of its own for this state.
    const victim = browser(srv);
    const res = await victim.back(callbackUrl);
    assert.equal(errorCode(res), 'expired');
    await logged(srv, /flow cookie missing or from another browser/);
    await assertSignedOut(victim, res);
  });

  test('with another flow’s cookie', async () => {
    const attacker = browser(srv);
    const started = await attacker.start('oidc');
    const callbackUrl = await atProvider(started.data.authorization_url);
    const victim = browser(srv);
    await victim.start('oidc'); // the victim has a flow cookie — for their own flow
    const res = await victim.back(callbackUrl);
    assert.equal(errorCode(res), 'expired');
    await logged(srv, /flow cookie missing or from another browser/);
    await assertSignedOut(victim, res);
  });

  test('replayed', async () => {
    const b = browser(srv);
    const started = await b.start('oidc');
    const flowCookie = b.jar.get('skilltree_oauth');
    const callbackUrl = await atProvider(started.data.authorization_url);
    const first = await b.back(callbackUrl);
    assert.equal(first.status, 303);
    assert.ok(await b.me(), 'the first use signs in');

    // The same URL and the same cookie, a second time.
    const replayer = browser(srv);
    replayer.jar.set('skilltree_oauth', flowCookie);
    const again = await replayer.back(callbackUrl);
    assert.equal(errorCode(again), 'expired');
    await logged(srv, /unknown, used or tampered state/);
    await assertSignedOut(replayer, again);
  });

  test('with a tampered state', async () => {
    const b = browser(srv);
    const started = await b.start('oidc');
    const callbackUrl = new URL(await atProvider(started.data.authorization_url));
    const state = callbackUrl.searchParams.get('state');
    callbackUrl.searchParams.set('state', state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A'));
    const res = await b.back(callbackUrl.href);
    assert.equal(errorCode(res), 'expired');
    await logged(srv, /unknown, used or tampered state/);
    await assertSignedOut(b, res);
  });

  test('after the flow has expired', async () => {
    const b = browser(srv);
    const started = await b.start('oidc');
    const callbackUrl = await atProvider(started.data.authorization_url);
    const db = new DatabaseSync(srv.dbPath);
    db.exec(`UPDATE oauth_flows SET expires_at = datetime('now', '-1 minute')`);
    db.close();
    const res = await b.back(callbackUrl);
    assert.equal(errorCode(res), 'expired');
    await logged(srv, /flow expired/);
    await assertSignedOut(b, res);
  });

  test('with the wrong iss, or none from a provider that promises one (RFC 9207)', async () => {
    mock.set({ authorizeIss: 'https://evil.example' });
    const wrong = browser(srv);
    const res = await wrong.signIn();
    assert.equal(errorCode(res), 'failed');
    await logged(srv, /iss does not match/);
    await assertSignedOut(wrong, res);

    mock.reset();
    mock.set({ omitIss: true });
    const missing = browser(srv);
    const res2 = await missing.signIn();
    assert.equal(errorCode(res2), 'failed');
    await logged(srv, /iss missing/);
    await assertSignedOut(missing, res2);
  });

  test('when the person says no at the provider', async () => {
    mock.set({ authorizeError: 'access_denied' });
    const b = browser(srv);
    const res = await b.signIn('oidc', { next: '/tree.html?id=9' });
    assert.equal(errorCode(res), 'cancelled');
    // The page keeps where they were going, but none of the provider's words.
    const url = new URL(res.headers.get('location'), 'http://x.invalid');
    assert.equal(url.searchParams.get('next'), '/tree.html?id=9');
    assert.ok(!res.headers.get('location').includes('access_denied'));
    await assertSignedOut(b, res);
  });

});

// ---------------------------------------------------------------------------

describe('the authorization request, with two providers', () => {
  let srv;
  before(async () => {
    srv = await startOAuthServer({ GITHUB_CLIENT_ID: 'gh-test-id', GITHUB_CLIENT_SECRET: 'gh-test-secret' });
  });
  after(async () => srv.stop());

  test('both providers are listed, GitHub first', async () => {
    const res = await srv.request('/api/auth/providers');
    assert.deepEqual(res.data, [
      { id: 'github', name: 'GitHub' },
      { id: 'oidc', name: 'Test SSO' },
    ]);
    assert.ok(!res.text_.includes('gh-test-secret'));
  });

  test('the authorization request is built from PUBLIC_ORIGIN, never the Host header', async () => {
    // A plain request with a forged Host. No Origin, so the dispatcher's
    // same-origin check has nothing to compare and lets it through.
    const port = new URL(srv.base).port;
    const answer = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/auth/oauth/oidc/start',
          headers: { Host: 'evil.example', 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
        }
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['cache-control'], 'no-store');
    const url = new URL(answer.body.authorization_url);
    assert.equal(url.origin, mock.issuer);
    assert.equal(url.searchParams.get('redirect_uri'), `${srv.base}/api/auth/oauth/oidc/callback`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), mock.clientId);
    assert.equal(url.searchParams.get('scope'), 'openid profile email');
    assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    assert.match(url.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!url.href.includes(mock.clientSecret));

    const github = await browser(srv).start('github');
    const gh = new URL(github.data.authorization_url);
    assert.equal(gh.origin + gh.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(gh.searchParams.get('redirect_uri'), `${srv.base}/api/auth/oauth/github/callback`);
    assert.equal(gh.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(gh.searchParams.get('scope'), null, 'no scopes: public profile only');
    assert.equal(gh.searchParams.get('nonce'), null);
  });

  test('at another provider’s callback (mix-up)', async () => {
    // An OIDC flow's code and state, delivered to GitHub's callback path.
    const b = browser(srv);
    const started = await b.start('oidc');
    const callbackUrl = new URL(await atProvider(started.data.authorization_url));
    callbackUrl.pathname = '/api/auth/oauth/github/callback';
    const res = await b.back(callbackUrl.href);
    assert.equal(errorCode(res), 'failed');
    await logged(srv, /flow belongs to another provider/);
    await assertSignedOut(b, res);
  });

  test('a GitHub flow delivered to the SSO callback (mix-up, the other way)', async () => {
    const b = browser(srv);
    const started = await b.start('github');
    const state = new URL(started.data.authorization_url).searchParams.get('state');
    const res = await b.fetch(`/api/auth/oauth/oidc/callback?code=anything&state=${state}&iss=${encodeURIComponent(mock.issuer)}`);
    assert.equal(errorCode(res), 'failed');
    await logged(srv, /flow belongs to another provider/);
    await assertSignedOut(b, res);
  });
});

// ---------------------------------------------------------------------------

describe('ID tokens that must be refused', () => {
  let srv;
  before(async () => {
    srv = await startOAuthServer();
  });
  after(async () => srv.stop());

  async function refused(behavior, reason) {
    mock.reset();
    mock.set(behavior);
    const b = browser(srv);
    const res = await b.signIn();
    assert.equal(errorCode(res), 'failed', String(reason));
    await logged(srv, reason);
    assert.equal(await b.me(), null, `${reason}: not signed in`);
  }

  test('a nonce from another sign-in', () => refused({ idToken: { nonce: 'not-this-flow' } }, /nonce does not match/));
  test('no nonce at all', () => refused({ omitClaims: ['nonce'] }, /nonce does not match/));
  test('another client as audience', () => refused({ idToken: { aud: 'someone-else' } }, /for another client/));
  test('several audiences and no azp', () =>
    refused({ idToken: { aud: [mock.clientId, 'someone-else'] } }, /several audiences and no azp/));
  test('an expired token', () =>
    refused({ idToken: { exp: Math.floor(Date.now() / 1000) - 600 } }, /has expired/));
  test('a token issued in the future', () =>
    refused({ idToken: { iat: Math.floor(Date.now() / 1000) + 3600 } }, /\(iat\)/));
  test('another issuer inside the token', () =>
    refused({ idToken: { iss: 'https://evil.example' } }, /issued by someone else/));
  test('the token endpoint refusing the code', () => refused({ tokenError: 'invalid_grant' }, /token endpoint refused the code/));
  test('a verifier that does not match the challenge', async () => {
    const before = mock.tokenRequests.length;
    await refused({ challengeOverride: 'A'.repeat(43) }, /token endpoint refused the code \(400 invalid_grant\)/);
    assert.equal(mock.tokenRequests[before].pkce, 'mismatch');
  });
});

describe('ID token signatures that must be refused', () => {
  let srv;
  before(async () => {
    srv = await startOAuthServer();
  });
  after(async () => srv.stop());

  async function refused(behavior, reason) {
    mock.reset();
    mock.set(behavior);
    const b = browser(srv);
    const res = await b.signIn();
    assert.equal(errorCode(res), 'failed', String(reason));
    await logged(srv, reason);
    assert.equal(await b.me(), null, `${reason}: not signed in`);
  }

  test('a good token first, so the key set is cached', async () => {
    const b = browser(srv);
    const res = await b.signIn();
    assert.equal(res.status, 303);
    assert.ok(await b.me());
  });

  test('alg=none', () => refused({ header: { alg: 'none' } }, /not a signed JWT/));
  test('alg=none with something in the signature slot', () =>
    refused({ header: { alg: 'none' }, signature: 'AAAA' }, /alg none is not allowed/));
  test('HS256 keyed with the public key', () => refused({ header: { alg: 'HS256' } }, /alg HS256 is not allowed/));
  test('a payload changed after signing', () => refused({ badSignature: true }, /signature does not verify/));
  test('an unknown kid, and refetching the key set is rate-limited', async () => {
    const before = mock.jwksFetches;
    await refused({ header: { kid: 'not-a-published-key' } }, /key the provider does not publish/);
    await refused({ header: { kid: 'another-unknown-key' } }, /key the provider does not publish/);
    assert.ok(mock.jwksFetches - before <= 1, `refetched ${mock.jwksFetches - before} times`);
  });

  test('starts are throttled per address', async () => {
    let throttled = null;
    for (let i = 0; i < 12 && !throttled; i++) {
      const res = await browser(srv).start('oidc');
      if (res.status === 429) throttled = res;
    }
    assert.ok(throttled, 'a 429 within a dozen unfinished starts');
    assert.match(throttled.data.error, /Too many attempts/);
  });
});
