// Passkeys end to end: a real server in its own process, and the software
// authenticator in tests/helpers/webauthn-authenticator.js standing in for
// the browser and the device. Every ceremony goes through the HTTP API
// exactly as the page drives it — options, then verify — carrying cookies
// like a browser does.
//
// PUBLIC_ORIGIN can be any origin string here, as long as the authenticator
// uses the same one: these requests never come from a browser, so the
// origin in clientDataJSON is whatever the test says it is. Every request
// comes from 127.0.0.1 and the throttles count per address, so the suite
// clears rate_limits before each test (the throttling tests excepted).

const test = require('node:test');
const { describe, before, after, beforeEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { startServer } = require('../helpers/server');
const { SoftAuthenticator, cbor } = require('../helpers/webauthn-authenticator');

const ORIGIN = 'https://skilltrees.test';
const RP_ID = 'skilltrees.test';
const PASSWORD = 'correct horse battery staple';

// ---------- a browser, as far as cookies go ----------

function client(srv) {
  const jar = new Map();
  const c = {
    jar,
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    async fetch(path, opts = {}) {
      const res = await srv.request(path, { cookie: c.cookie() || undefined, ...opts });
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!value || /max-age=0/i.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
      return res;
    },
    post: (path, body = {}) => c.fetch(path, { method: 'POST', body }),
    get: (path) => c.fetch(path),
    me: async () => (await c.get('/api/auth/me')).data.user,
  };
  return c;
}

// ---------- the database, for what the API deliberately can't do ----------

function sql(srv, statement, ...params) {
  const db = new DatabaseSync(srv.dbPath);
  try {
    const stmt = db.prepare(statement);
    return /^\s*select/i.test(statement) ? stmt.all(...params) : stmt.run(...params);
  } finally {
    db.close();
  }
}

const resetThrottles = (srv) => sql(srv, 'DELETE FROM rate_limits');

// Waits for a line in the server's log (it arrives over the child's stdout,
// separately from the HTTP response that prompted it). Only the part of the
// log after the last match is searched, and each test starts at the end of
// it (see markLog), so a refusal has to be logged for the reason the test
// is about, by that test — not found left over from an earlier one.
async function logged(srv, pattern) {
  const unseen = () => srv.logs.join('').slice(srv.logCursor || 0);
  for (let i = 0; i < 100 && !pattern.test(unseen()); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const text = unseen();
  const match = pattern.exec(text);
  assert.ok(match, `the log should match ${pattern}; it says:\n${text.slice(-3000)}`);
  srv.logCursor = (srv.logCursor || 0) + match.index + match[0].length;
}

const markLog = (srv) => {
  srv.logCursor = srv.logs.join('').length;
};

// ---------- the flows ----------

let names = 0;
const freshName = (prefix = 'user') => `${prefix}-${++names}-${crypto.randomBytes(2).toString('hex')}`;

async function passwordAccount(srv, username = freshName()) {
  const c = client(srv);
  const res = await c.post('/api/auth/signup', { username, password: PASSWORD });
  assert.equal(res.status, 201, res.text_);
  c.username = username;
  return c;
}

async function addPasskey(c, auth, knobs = {}, body = {}) {
  const options = await c.post('/api/auth/passkeys/register/options', body);
  assert.equal(options.status, 200, options.text_);
  const credential = auth.create(options.data, knobs);
  const res = await c.post('/api/auth/passkeys/register/verify', credential);
  return { options: options.data, credential, res };
}

async function signIn(c, auth, knobs = {}) {
  const options = await c.post('/api/auth/passkeys/login/options');
  assert.equal(options.status, 200, options.text_);
  const assertion = auth.get(options.data, knobs);
  const res = await c.post('/api/auth/passkeys/login/verify', assertion);
  return { options: options.data, assertion, res };
}

async function passkeySignup(c, auth, username = freshName(), knobs = {}) {
  const options = await c.post('/api/auth/passkeys/signup/options', { username });
  assert.equal(options.status, 200, options.text_);
  const credential = auth.create(options.data, knobs);
  const res = await c.post('/api/auth/passkeys/signup/verify', credential);
  return { options: options.data, credential, res, username };
}

const newAuth = (opts = {}) => new SoftAuthenticator({ origin: ORIGIN, ...opts });

// ---------- with passkeys switched off ----------

describe('with PUBLIC_ORIGIN unset', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { PUBLIC_ORIGIN: '' } });
  });
  after(async () => srv.stop());

  test('config says no, and every other route is 404', async () => {
    const cfg = await srv.request('/api/auth/passkeys/config');
    assert.equal(cfg.status, 200);
    assert.deepEqual(cfg.data, { enabled: false });
    const c = await passwordAccount(srv);
    for (const [method, path] of [
      ['POST', '/api/auth/passkeys/register/options'],
      ['POST', '/api/auth/passkeys/register/verify'],
      ['POST', '/api/auth/passkeys/signup/options'],
      ['POST', '/api/auth/passkeys/signup/verify'],
      ['POST', '/api/auth/passkeys/login/options'],
      ['POST', '/api/auth/passkeys/login/verify'],
      ['GET', '/api/auth/passkeys'],
      ['PATCH', '/api/auth/passkeys/1'],
      ['DELETE', '/api/auth/passkeys/1'],
    ]) {
      const res = await c.fetch(path, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    assert.equal((await c.me()).passkeys, 0);
    await logged(srv, /Passkeys: off \(PUBLIC_ORIGIN is not set/);
  });

  test('an origin by IP address leaves them off too, and advertises no passkey endpoints', async () => {
    const byIp = await startServer({ env: { PUBLIC_ORIGIN: 'http://127.0.0.1:3141' } });
    try {
      assert.deepEqual((await byIp.request('/api/auth/passkeys/config')).data, { enabled: false });
      assert.equal((await byIp.request('/.well-known/passkey-endpoints')).status, 404);
      await logged(byIp, /Passkeys are OFF: PUBLIC_ORIGIN names an IP address/);
    } finally {
      await byIp.stop();
    }
  });
});

// ---------- the main suite ----------

describe('passkeys', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { PUBLIC_ORIGIN: ORIGIN } });
  });
  after(async () => srv.stop());
  beforeEach(() => {
    resetThrottles(srv);
    markLog(srv);
  });

  test('config, and the startup log, name the RP ID', async () => {
    const cfg = await srv.request('/api/auth/passkeys/config');
    assert.deepEqual(cfg.data, { enabled: true, rp_id: RP_ID });
    srv.logCursor = 0; // the startup lines
    await logged(srv, /Passkeys are on for RP ID "skilltrees\.test", accepted from https:\/\/skilltrees\.test only/);
  });

  test('creation options: a random user handle, discoverable, UV required, no attestation', async () => {
    const c = await passwordAccount(srv);
    const res = await c.post('/api/auth/passkeys/register/options');
    assert.equal(res.status, 200);
    const o = res.data;
    assert.deepEqual(o.rp, { id: RP_ID, name: 'Skill Trees' });
    assert.equal(o.user.name, c.username);
    assert.equal(o.user.displayName, c.username);
    // 64 random bytes, not the account's row id.
    assert.equal(Buffer.from(o.user.id, 'base64url').length, 64);
    assert.notEqual(o.user.id, String((await c.me()).id));
    assert.equal(Buffer.from(o.challenge, 'base64url').length, 32);
    assert.deepEqual(o.pubKeyCredParams, [
      { type: 'public-key', alg: -8 },
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ]);
    assert.deepEqual(o.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    assert.equal(o.attestation, 'none');
    assert.deepEqual(o.extensions, { credProps: true });
    assert.deepEqual(o.excludeCredentials, []);
    assert.equal(o.timeout, 300000);

    const cookie = res.headers.getSetCookie().find((l) => l.startsWith('skilltree_webauthn='));
    assert.ok(cookie, 'binds the ceremony to this browser');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=300/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');

    // The handle is the account's, and stays: asking again gives the same one.
    const again = await c.post('/api/auth/passkeys/register/options');
    assert.equal(again.data.user.id, o.user.id);
    assert.notEqual(again.data.challenge, o.challenge);
  });

  test('request options: discoverable credentials, UV required, nothing about any account', async () => {
    const res = await client(srv).post('/api/auth/passkeys/login/options');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.data).sort(), ['allowCredentials', 'challenge', 'rpId', 'timeout', 'userVerification']);
    assert.deepEqual(res.data.allowCredentials, []);
    assert.equal(res.data.rpId, RP_ID);
    assert.equal(res.data.userVerification, 'required');
  });

  for (const [alg, name] of [[-7, 'ES256'], [-8, 'EdDSA'], [-257, 'RS256']]) {
    test(`register, sign out, and sign in again with ${name}`, async () => {
      const c = await passwordAccount(srv);
      const auth = newAuth();
      const { res } = await addPasskey(c, auth, { alg });
      assert.equal(res.status, 201, res.text_);
      assert.equal(res.data.name, 'Passkey');
      assert.equal(res.data.backed_up, true);
      assert.equal(res.data.enabled, true);
      assert.deepEqual(res.data.transports, ['hybrid', 'internal']);
      assert.ok(!c.jar.has('skilltree_webauthn'), 'verify clears the binding cookie');
      assert.equal((await c.me()).passkeys, 1);
      assert.equal(sql(srv, 'SELECT alg FROM passkeys WHERE id = ?', res.data.id)[0].alg, alg);

      await c.post('/api/auth/logout');
      assert.equal(await c.me(), null);

      const signedIn = await signIn(c, auth);
      assert.equal(signedIn.res.status, 200, signedIn.res.text_);
      assert.equal(signedIn.res.data.username, c.username);
      assert.equal((await c.me()).username, c.username);
      const [row] = sql(srv, 'SELECT last_used_at FROM passkeys WHERE id = ?', res.data.id);
      assert.ok(row.last_used_at, 'last_used_at is set');
      await logged(srv, new RegExp(`passkey login success user=${c.username}`));
    });
  }

  test('a passkey sign-in starts a fresh session and ends the one before', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    await addPasskey(c, auth);
    const before = c.cookie();
    const { res } = await signIn(c, auth);
    assert.equal(res.status, 200);
    assert.notEqual(c.cookie(), before);
    const stale = await srv.request('/api/auth/me', { cookie: before });
    assert.equal(stale.data.user, null, 'the old session no longer works');
  });

  test('sign up with a passkey: no password, and the account exists only once verified', async () => {
    const c = client(srv);
    const auth = newAuth();
    const username = freshName('pk');
    const options = await c.post('/api/auth/passkeys/signup/options', { username });
    assert.equal(options.status, 200);
    assert.equal(options.data.user.name, username);
    assert.equal(sql(srv, 'SELECT id FROM users WHERE username = ?', username).length, 0, 'no account yet');

    const res = await c.post('/api/auth/passkeys/signup/verify', auth.create(options.data));
    assert.equal(res.status, 201, res.text_);
    assert.equal(res.data.username, username);
    const me = await c.me();
    assert.equal(me.username, username);
    assert.equal(me.has_password, false);
    assert.equal(me.passkeys, 1);
    const [user] = sql(srv, 'SELECT password_hash, webauthn_user_id FROM users WHERE username = ?', username);
    assert.equal(user.password_hash, '');
    assert.equal(user.webauthn_user_id, options.data.user.id);

    // No password to guess: a password login reads like any wrong one.
    const pw = await client(srv).post('/api/auth/login', { username, password: PASSWORD });
    assert.equal(pw.status, 401);
    assert.equal(pw.data.error, 'Wrong username or password.');

    await c.post('/api/auth/logout');
    const again = await signIn(c, auth);
    assert.equal(again.res.status, 200);
    assert.equal(again.res.data.username, username);
  });

  test('sign-up names follow the password sign-up rules', async () => {
    const c = client(srv);
    const bad = await c.post('/api/auth/passkeys/signup/options', { username: 'a b' });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /3-40 characters/);
    const taken = await passwordAccount(srv);
    const dup = await c.post('/api/auth/passkeys/signup/options', { username: taken.username.toUpperCase() });
    assert.equal(dup.status, 409);
  });

  test('a name taken while the passkey was being made is refused, and nothing is left behind', async () => {
    const c = client(srv);
    const auth = newAuth();
    const username = freshName('race');
    const options = await c.post('/api/auth/passkeys/signup/options', { username });
    await passwordAccount(srv, username); // someone else gets there first
    const credential = auth.create(options.data);
    const res = await c.post('/api/auth/passkeys/signup/verify', credential);
    assert.equal(res.status, 409);
    assert.match(res.data.error, /taken while your passkey was being made/);
    assert.equal(sql(srv, 'SELECT id FROM passkeys WHERE credential_id = ?', credential.id).length, 0);
    assert.equal(await c.me(), null);
  });

  test('a challenge is used once', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    const { credential, res } = await addPasskey(c, auth);
    assert.equal(res.status, 201);
    const replayedRegistration = await c.post('/api/auth/passkeys/register/verify', credential);
    assert.equal(replayedRegistration.status, 400);
    assert.match(replayedRegistration.data.error, /expired, was already used/);

    const { assertion, res: first } = await signIn(c, auth);
    assert.equal(first.status, 200);
    const replayedLogin = await client(srv).post('/api/auth/passkeys/login/verify', assertion);
    assert.equal(replayedLogin.status, 401);
    const sameBrowser = await c.post('/api/auth/passkeys/login/verify', assertion);
    assert.equal(sameBrowser.status, 401);
    await logged(srv, /passkey login refused reason="unknown or already used challenge"/);
  });

  test('an expired challenge is refused', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    await addPasskey(c, auth);
    const options = await c.post('/api/auth/passkeys/login/options');
    sql(srv, `UPDATE webauthn_challenges SET expires_at = datetime('now', '-1 second')`);
    const res = await c.post('/api/auth/passkeys/login/verify', auth.get(options.data));
    assert.equal(res.status, 401);
    await logged(srv, /passkey login refused reason="challenge expired"/);
  });

  test('a challenge issued for one ceremony cannot finish another', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    await addPasskey(c, auth);

    // A sign-in challenge presented as a registration.
    const reg = await c.post('/api/auth/passkeys/register/options');
    const login = await c.post('/api/auth/passkeys/login/options');
    const asRegistration = await c.post(
      '/api/auth/passkeys/register/verify',
      auth.create(reg.data, { challenge: login.data.challenge, store: false })
    );
    assert.equal(asRegistration.status, 400);
    await logged(srv, /passkey registration refused reason="challenge was issued for login"/);

    // A registration challenge presented as a sign-in.
    const reg2 = await c.post('/api/auth/passkeys/register/options');
    const login2 = { ...(await client(srv).post('/api/auth/passkeys/login/options')).data, challenge: reg2.data.challenge };
    const asLogin = await c.post('/api/auth/passkeys/login/verify', auth.get(login2));
    assert.equal(asLogin.status, 401);
    await logged(srv, /passkey login refused reason="challenge was issued for register"/);

    // A sign-up challenge presented as a registration to an existing account.
    const signup = await c.post('/api/auth/passkeys/signup/options', { username: freshName() });
    const asRegistration2 = await c.post('/api/auth/passkeys/register/verify', auth.create(signup.data, { store: false }));
    assert.equal(asRegistration2.status, 400);
    await logged(srv, /passkey registration refused reason="challenge was issued for signup"/);
  });

  test('a challenge is bound to the browser that asked for it', async () => {
    const owner = await passwordAccount(srv);
    const auth = newAuth();
    await addPasskey(owner, auth);
    await owner.post('/api/auth/logout');

    const victim = client(srv);
    const options = await victim.post('/api/auth/passkeys/login/options');
    const assertion = auth.get(options.data);
    // Carried off and redeemed elsewhere: another browser, or no cookie.
    const elsewhere = await client(srv).post('/api/auth/passkeys/login/verify', assertion);
    assert.equal(elsewhere.status, 401);
    await logged(srv, /passkey login refused reason="challenge was issued to another browser"/);
    // And the challenge is spent by that attempt.
    const home = await victim.post('/api/auth/passkeys/login/verify', assertion);
    assert.equal(home.status, 401);
  });

  test('a registration challenge is bound to the account that asked', async () => {
    const alice = await passwordAccount(srv);
    const bob = await passwordAccount(srv);
    const options = await alice.post('/api/auth/passkeys/register/options');
    // Bob gets hold of alice's ceremony, cookie and all.
    bob.jar.set('skilltree_webauthn', alice.jar.get('skilltree_webauthn'));
    const res = await bob.post('/api/auth/passkeys/register/verify', newAuth().create(options.data));
    assert.equal(res.status, 400);
    await logged(srv, /passkey registration refused reason="challenge was issued to another account"/);
    assert.equal((await bob.me()).passkeys, 0);
    assert.equal((await alice.me()).passkeys, 0);
  });

  test('adding a passkey needs a sign-in from the last ten minutes', async () => {
    const c = await passwordAccount(srv);
    // A session of twenty minutes ago: still signed in, but not recently.
    sql(srv, `UPDATE sessions SET created_at = datetime('now', '-20 minutes')`);
    const stale = await c.post('/api/auth/passkeys/register/options');
    assert.equal(stale.status, 403);
    assert.match(stale.data.error, /sign in again/i);
    // Signing in again is what it asks for.
    const again = await c.post('/api/auth/login', { username: c.username, password: PASSWORD });
    assert.equal(again.status, 200);
    assert.equal((await addPasskey(c, newAuth())).res.status, 201);
  });

  test('registration needs a session', async () => {
    const res = await client(srv).post('/api/auth/passkeys/register/options');
    assert.equal(res.status, 401);
    const verify = await client(srv).post('/api/auth/passkeys/register/verify', {});
    assert.equal(verify.status, 401);
  });

  test('wrong origin, RP ID, type or framing is refused, in both ceremonies', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    const cases = [
      [{ origin: 'https://evil.example' }, /origin https:\/\/evil\.example is not/],
      [{ origin: 'https://skilltrees.test:8443' }, /origin/],
      [{ origin: 'http://skilltrees.test' }, /origin/],
      [{ rpId: 'evil.example' }, /rpIdHash/],
      [{ rpId: 'sub.skilltrees.test' }, /rpIdHash/],
      [{ crossOrigin: true }, /cross-origin frame/],
      [{ clientDataExtra: { topOrigin: 'https://evil.example' } }, /top origin/],
    ];
    for (const [knobs, reason] of cases) {
      const { res } = await addPasskey(c, auth, { ...knobs, store: false });
      assert.equal(res.status, 400, JSON.stringify(knobs));
      assert.equal(res.data.error, 'That passkey could not be verified.');
      await logged(srv, reason);
    }
    const wrongType = await addPasskey(c, auth, { type: 'webauthn.get', store: false });
    assert.equal(wrongType.res.status, 400);
    await logged(srv, /type is "webauthn\.get", not webauthn\.create/);

    const { res } = await addPasskey(c, auth);
    assert.equal(res.status, 201);
    for (const [knobs, reason] of [...cases, [{ type: 'webauthn.create' }, /not webauthn\.get/]]) {
      resetThrottles(srv);
      const signed = await signIn(c, auth, knobs);
      assert.equal(signed.res.status, 401, JSON.stringify(knobs));
      await logged(srv, reason);
    }
  });

  test('user verification is required; user presence too', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    const noUv = await addPasskey(c, auth, { uv: false, store: false });
    assert.equal(noUv.res.status, 400);
    await logged(srv, /registration refused reason="user verification \(UV\) flag is not set"/);
    const noUp = await addPasskey(c, auth, { up: false, store: false });
    assert.equal(noUp.res.status, 400);
    await logged(srv, /registration refused reason="user presence \(UP\) flag is not set"/);

    assert.equal((await addPasskey(c, auth)).res.status, 201);
    assert.equal((await signIn(c, auth, { uv: false })).res.status, 401);
    await logged(srv, /login refused reason="user verification \(UV\) flag is not set/);
    assert.equal((await signIn(c, auth, { up: false })).res.status, 401);
    await logged(srv, /login refused reason="user presence \(UP\) flag is not set/);
    assert.equal((await signIn(c, auth)).res.status, 200);
  });

  test('a bad signature is refused', async () => {
    for (const alg of [-7, -8, -257]) {
      const c = await passwordAccount(srv);
      const auth = newAuth();
      await addPasskey(c, auth, { alg });
      const { res } = await signIn(c, auth, { badSignature: true });
      assert.equal(res.status, 401, `alg ${alg}`);
      await logged(srv, /login refused reason="signature does not verify/);
    }
  });

  test('the signature counter must go up, and a clone is logged', async () => {
    const c = await passwordAccount(srv);
    const key = newAuth({ counter: true, backupEligible: false, backedUp: false });
    const { res } = await addPasskey(c, key);
    assert.equal(res.status, 201);
    assert.equal(res.data.backup_eligible, false);
    assert.equal((await signIn(c, key)).res.status, 200); // 2
    assert.equal((await signIn(c, key)).res.status, 200); // 3

    const same = await signIn(c, key, { signCount: 3 });
    assert.equal(same.res.status, 401);
    await logged(srv, /signature counter went backwards — possible cloned authenticator .*stored=3 received=3/);
    const lower = await signIn(c, key, { signCount: 1 });
    assert.equal(lower.res.status, 401);
    // Falling back to zero is a regression too, not a way around the check.
    const zero = await signIn(c, key, { signCount: 0 });
    assert.equal(zero.res.status, 401);
    await logged(srv, /stored=3 received=0/);
    // A jump forward is fine.
    assert.equal((await signIn(c, key, { signCount: 50 })).res.status, 200);
    assert.equal(sql(srv, 'SELECT sign_count FROM passkeys WHERE id = ?', res.data.id)[0].sign_count, 50);
  });

  test('a synced passkey reports 0 every time, and that is fine', async () => {
    const c = await passwordAccount(srv);
    const synced = newAuth({ counter: false });
    await addPasskey(c, synced);
    for (let i = 0; i < 3; i++) assert.equal((await signIn(c, synced)).res.status, 200);
  });

  test('BE is fixed at registration; BS may change', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth({ backupEligible: true, backedUp: false });
    const { res } = await addPasskey(c, auth);
    assert.equal(res.data.backed_up, false);
    assert.equal((await signIn(c, auth, { bs: true })).res.status, 200);
    const list = await c.get('/api/auth/passkeys');
    assert.equal(list.data.passkeys[0].backed_up, true, 'backed up since');
    assert.equal((await signIn(c, auth, { be: false, bs: false })).res.status, 401);
    await logged(srv, /backup eligibility \(BE\) changed/);
    assert.equal((await signIn(c, auth, { be: true, bs: true })).res.status, 200);
    assert.equal((await addPasskey(c, newAuth(), { be: false, bs: true, store: false })).res.status, 400);
  });

  test("the user handle must be the credential's own", async () => {
    const alice = await passwordAccount(srv);
    const bob = await passwordAccount(srv);
    const aliceKey = newAuth();
    const bobKey = newAuth();
    const { options: aliceOptions } = await addPasskey(alice, aliceKey);
    const { options: bobOptions } = await addPasskey(bob, bobKey);

    // Alice's credential, presented as belonging to Bob's account.
    const asBob = await signIn(client(srv), aliceKey, { userHandle: Buffer.from(bobOptions.user.id, 'base64url') });
    assert.equal(asBob.res.status, 401);
    await logged(srv, /userHandle is not the handle of this credential's account/);
    // No handle at all.
    const none = await signIn(client(srv), aliceKey, { userHandle: null });
    assert.equal(none.res.status, 401);
    await logged(srv, /assertion carries no userHandle/);
    // Bob's credential ID and Bob's handle, signed with Alice's key.
    const bobCred = [...bobKey.credentials.values()][0];
    const aliceCred = [...aliceKey.credentials.values()][0];
    const mixed = newAuth();
    mixed.credentials.set(bobCred.id.toString('base64url'), { ...aliceCred, id: bobCred.id, userHandle: bobCred.userHandle });
    const forged = await signIn(client(srv), mixed);
    assert.equal(forged.res.status, 401);
    await logged(srv, new RegExp(`signature does not verify \\(passkey=\\d+\\)`));
    assert.notEqual(aliceOptions.user.id, bobOptions.user.id);
  });

  test('an unknown credential gets a reply the page can signal', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    // Made on the device, never registered here.
    const options = await c.post('/api/auth/passkeys/register/options');
    auth.create(options.data);
    const { res } = await signIn(client(srv), auth);
    assert.equal(res.status, 401);
    assert.equal(res.data.unknown_credential, true);
    assert.equal(res.headers.get('content-type'), 'application/problem+json');

    // And one that was registered, then removed.
    const other = newAuth();
    const added = await addPasskey(c, other);
    const del = await c.fetch(`/api/auth/passkeys/${added.res.data.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const gone = await signIn(client(srv), other);
    assert.equal(gone.res.status, 401);
    assert.equal(gone.res.data.unknown_credential, true);
  });

  test('excludeCredentials lists the passkeys the account already has', async () => {
    const c = await passwordAccount(srv);
    const one = await addPasskey(c, newAuth());
    const two = await addPasskey(c, newAuth(), { transports: ['usb', 'nfc', 'bogus'] });
    const options = await c.post('/api/auth/passkeys/register/options');
    assert.deepEqual(options.data.excludeCredentials, [
      { type: 'public-key', id: one.credential.id, transports: ['hybrid', 'internal'] },
      { type: 'public-key', id: two.credential.id, transports: ['usb', 'nfc'] },
    ]);
  });

  test('one credential cannot be registered twice, to anyone', async () => {
    const alice = await passwordAccount(srv);
    const bob = await passwordAccount(srv);
    const credentialId = crypto.randomBytes(16);
    assert.equal((await addPasskey(alice, newAuth(), { credentialId })).res.status, 201);
    const again = await addPasskey(alice, newAuth(), { credentialId });
    assert.equal(again.res.status, 409);
    const elsewhere = await addPasskey(bob, newAuth(), { credentialId });
    assert.equal(elsewhere.res.status, 409);
    const signup = await passkeySignup(client(srv), newAuth(), freshName(), { credentialId });
    assert.equal(signup.res.status, 409);
    assert.equal(sql(srv, 'SELECT id FROM users WHERE username = ?', signup.username).length, 0);
  });

  test('an algorithm that was not offered, or a weak RSA key, is refused', async () => {
    const c = await passwordAccount(srv);
    const es384 = await addPasskey(c, newAuth(), { alg: -35, store: false });
    assert.equal(es384.res.status, 400);
    await logged(srv, /COSE algorithm -35 was not one we asked for/);
    const rsa1024 = await addPasskey(c, newAuth(), { alg: -257, rsaBits: 1024, store: false });
    assert.equal(rsa1024.res.status, 400);
    await logged(srv, /RSA key is 1024 bits/);
  });

  test('another attestation format is accepted without being verified', async () => {
    const c = await passwordAccount(srv);
    const { res } = await addPasskey(c, newAuth(), { fmt: 'packed', attStmt: new Map([['alg', -7], ['sig', Buffer.alloc(71)]]) });
    assert.equal(res.status, 201);
    await logged(srv, /passkey added .*fmt=packed/);
  });

  test('a client that says it made no discoverable credential is refused', async () => {
    const c = await passwordAccount(srv);
    const { res } = await addPasskey(c, newAuth(), { clientExtensionResults: { credProps: { rk: false } }, store: false });
    assert.equal(res.status, 400);
  });

  test('the list: what it shows, and what the Signal API needs', async () => {
    const c = await passwordAccount(srv);
    const aaguid = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';
    const { options, credential } = await addPasskey(c, newAuth({ aaguid }));
    const res = await c.get('/api/auth/passkeys');
    assert.equal(res.status, 200);
    assert.equal(res.data.rp_id, RP_ID);
    assert.equal(res.data.user_handle, options.user.id);
    assert.equal(res.data.sign_in_methods, 2); // password + passkey
    assert.equal(res.data.passkeys.length, 1);
    const [p] = res.data.passkeys;
    assert.deepEqual(Object.keys(p).sort(), [
      'backed_up', 'backup_eligible', 'created_at', 'credential_id', 'enabled', 'id', 'last_used_at', 'name', 'transports',
    ]);
    assert.equal(p.name, 'iCloud Keychain');
    assert.equal(p.credential_id, credential.id);
    assert.equal(p.last_used_at, null);
    assert.equal((await client(srv).get('/api/auth/passkeys')).status, 401);
  });

  test('rename and remove are the owner’s alone; names are cleaned', async () => {
    const alice = await passwordAccount(srv);
    const bob = await passwordAccount(srv);
    const { res } = await addPasskey(alice, newAuth());
    const id = res.data.id;

    const bobRename = await bob.fetch(`/api/auth/passkeys/${id}`, { method: 'PATCH', body: { name: 'mine' } });
    assert.equal(bobRename.status, 404);
    const bobDelete = await bob.fetch(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
    assert.equal(bobDelete.status, 404);
    assert.equal((await srv.request(`/api/auth/passkeys/${id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await alice.fetch('/api/auth/passkeys/nope', { method: 'PATCH', body: { name: 'x' } })).status, 404);

    const renamed = await alice.fetch(`/api/auth/passkeys/${id}`, {
      method: 'PATCH',
      body: { name: `  Work\u001b[2J laptop\n${'x'.repeat(100)}` },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.name, `Work[2J laptop${'x'.repeat(100)}`.slice(0, 60));
    const empty = await alice.fetch(`/api/auth/passkeys/${id}`, { method: 'PATCH', body: { name: ' \u0007 ' } });
    assert.equal(empty.status, 400);
    const removed = await alice.fetch(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal((await alice.me()).passkeys, 0);
  });

  test('the last way in cannot be removed', async () => {
    // A passkey-only account.
    const c = client(srv);
    const first = newAuth();
    const { res } = await passkeySignup(c, first);
    assert.equal(res.status, 201);
    const [only] = (await c.get('/api/auth/passkeys')).data.passkeys;
    const refused = await c.fetch(`/api/auth/passkeys/${only.id}`, { method: 'DELETE' });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /only way you can sign in/);

    // With a second passkey, either can go — but not both.
    const second = await addPasskey(c, newAuth());
    assert.equal((await c.get('/api/auth/passkeys')).data.sign_in_methods, 2);
    assert.equal((await c.fetch(`/api/auth/passkeys/${only.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await c.fetch(`/api/auth/passkeys/${second.res.data.id}`, { method: 'DELETE' })).status, 409);

    // A password account may drop its only passkey: the password remains.
    const pw = await passwordAccount(srv);
    const added = await addPasskey(pw, newAuth());
    assert.equal((await pw.fetch(`/api/auth/passkeys/${added.res.data.id}`, { method: 'DELETE' })).status, 200);
  });

  test('a passkey counts when disconnecting a provider', async () => {
    // A passkey-only account with a connected identity: the identity can go,
    // because the passkey is still a way in.
    const c = client(srv);
    await passkeySignup(c, newAuth());
    const { id: userId } = await c.me();
    sql(
      srv,
      `INSERT INTO user_identities (user_id, provider, issuer, subject, display_name) VALUES (?, 'oidc', 'https://sso.invalid', 'sub-1', 'x')`,
      userId
    );
    const [identity] = sql(srv, 'SELECT id FROM user_identities WHERE user_id = ?', userId);
    assert.equal((await c.fetch(`/api/auth/identities/${identity.id}`, { method: 'DELETE' })).status, 200);
  });

  test('a passkey made for another RP ID is listed but is no way in', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    const { res } = await addPasskey(c, auth);
    sql(srv, `UPDATE passkeys SET rp_id = 'old.example' WHERE id = ?`, res.data.id);
    const list = await c.get('/api/auth/passkeys');
    assert.equal(list.data.passkeys[0].enabled, false);
    assert.equal(list.data.sign_in_methods, 1);
    assert.equal((await c.me()).passkeys, 0);
    const excluded = await c.post('/api/auth/passkeys/register/options');
    assert.deepEqual(excluded.data.excludeCredentials, []);
    const signedIn = await signIn(client(srv), auth);
    assert.equal(signedIn.res.data.unknown_credential, true);
  });

  test('an automatic upgrade: only just after signing in, and only it may skip UP and UV', async () => {
    const c = await passwordAccount(srv);
    const options = await c.post('/api/auth/passkeys/register/options', { mediation: 'conditional' });
    assert.equal(options.status, 200);
    assert.equal(options.data.authenticatorSelection.userVerification, 'preferred');
    const res = await c.post('/api/auth/passkeys/register/verify', newAuth().create(options.data, { up: false, uv: false }));
    assert.equal(res.status, 201, res.text_);
    await logged(srv, /passkey added .*upgrade=true/);

    assert.equal((await c.post('/api/auth/passkeys/register/options', { mediation: 'required' })).status, 400);

    // A session older than the window may still add passkeys, but not silently.
    sql(srv, `UPDATE sessions SET created_at = datetime('now', '-6 minutes')`);
    const stale = await c.post('/api/auth/passkeys/register/options', { mediation: 'conditional' });
    assert.equal(stale.status, 403);
    const normal = await addPasskey(c, newAuth(), { up: false, uv: false, store: false });
    assert.equal(normal.res.status, 400);
  });

  test('malformed responses never cause a 500', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    await addPasskey(c, auth);

    const regOptions = async () => (await c.post('/api/auth/passkeys/register/options')).data;
    const b64 = (buf) => Buffer.from(buf).toString('base64url');
    const withAttestation = async (attestationObject) => {
      const good = auth.create(await regOptions(), { store: false });
      good.response.attestationObject = b64(attestationObject);
      return good;
    };
    const authData = (tail) => Buffer.concat([crypto.createHash('sha256').update(RP_ID).digest(), Buffer.from([0x45, 0, 0, 0, 0]), tail]);
    const attObj = (authDataBytes) => cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authDataBytes]]));

    const bodies = [
      {},
      { type: 'public-key' },
      { id: 'abc', rawId: 'abc', type: 'public-key' },
      { id: 'abc', rawId: 'abc', type: 'public-key', response: 'x' },
      { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 42 } },
      { id: '!!', rawId: '!!', type: 'public-key', response: {} },
      { id: 'a'.repeat(5000), rawId: 'a'.repeat(5000), type: 'public-key', response: {} },
      await withAttestation(Buffer.from([0xa3, 0x63])), // truncated map
      await withAttestation(Buffer.from([0xba, 0xff, 0xff, 0xff, 0xff])), // a 4-billion-entry map
      await withAttestation(Buffer.from([0x5b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), // a 2^53-byte string
      await withAttestation(Buffer.concat([Buffer.alloc(60000, 0x81), Buffer.from([0])])), // deep nesting
      await withAttestation(Buffer.from([0xbf, 0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65, 0xff])), // indefinite map
      await withAttestation(Buffer.from([0xc0, 0x60])), // a tag
      await withAttestation(cbor([1, 2, 3])), // not a map
      await withAttestation(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()]]))), // no authData
      await withAttestation(attObj(Buffer.alloc(10))), // authData too short
      await withAttestation(attObj(authData(Buffer.alloc(5)))), // AT set, no credential data
      await withAttestation(attObj(authData(Buffer.concat([Buffer.alloc(16), Buffer.from([0xff, 0xff]), Buffer.alloc(4)])))), // id runs past
      await withAttestation(attObj(authData(Buffer.concat([Buffer.alloc(16), Buffer.from([0, 1, 7]), cbor([1])])))), // key not a map
      await withAttestation(attObj(authData(Buffer.concat([Buffer.alloc(16), Buffer.from([0, 1, 7]), cbor(new Map([[1, 2], [3, -7]]))])))), // key without x/y
    ];
    const notJson = auth.create(await regOptions(), { store: false, clientDataJSON: Buffer.from([0xc3, 0x28]) });
    bodies.push(notJson);

    const endpoints = ['/api/auth/passkeys/register/verify', '/api/auth/passkeys/signup/verify', '/api/auth/passkeys/login/verify'];
    for (const endpoint of endpoints) {
      for (const body of bodies) {
        resetThrottles(srv);
        const res = await c.post(endpoint, body);
        assert.ok([400, 401, 409].includes(res.status), `${endpoint} answered ${res.status} to ${JSON.stringify(body).slice(0, 120)}`);
      }
    }
    // Assertions with broken parts.
    const loginBodies = [];
    for (const [part, value] of [
      ['authenticatorData', b64(Buffer.alloc(36))],
      ['authenticatorData', b64(Buffer.concat([authData(Buffer.alloc(0)).subarray(0, 32), Buffer.from([0x85, 0, 0, 0, 0, 0xbf])]))],
      ['signature', ''],
      ['signature', b64(crypto.randomBytes(2000))],
      ['userHandle', b64(crypto.randomBytes(65))],
      ['userHandle', 17],
    ]) {
      const options = await c.post('/api/auth/passkeys/login/options');
      const assertion = auth.get(options.data);
      assertion.response[part] = value;
      loginBodies.push(assertion);
    }
    for (const body of loginBodies) {
      resetThrottles(srv);
      const res = await c.post('/api/auth/passkeys/login/verify', body);
      assert.ok([400, 401].includes(res.status), `login answered ${res.status}`);
    }
    // Still answering, and nothing was logged as a server fault.
    resetThrottles(srv);
    assert.equal((await signIn(c, auth)).res.status, 200);
    assert.doesNotMatch(srv.logs.join(''), /Internal server error|TypeError|RangeError/);
  });
});

// ---------- throttling, on servers of their own ----------

describe('throttling', () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { PUBLIC_ORIGIN: ORIGIN } });
  });
  after(async () => srv.stop());
  beforeEach(() => {
    resetThrottles(srv);
    markLog(srv);
  });

  test('sign-in verify is counted before anything is checked', async () => {
    const c = client(srv);
    for (let i = 0; i < 10; i++) {
      const res = await c.post('/api/auth/passkeys/login/verify', { junk: true });
      assert.equal(res.status, 400);
    }
    const res = await c.post('/api/auth/passkeys/login/verify', { junk: true });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
    await logged(srv, /passkey login throttled/);
  });

  test('a completed sign-in gives its count back', async () => {
    const c = await passwordAccount(srv);
    const auth = newAuth();
    await addPasskey(c, auth);
    resetThrottles(srv);
    for (let i = 0; i < 25; i++) assert.equal((await signIn(c, auth)).res.status, 200, `sign-in ${i + 1}`);
  });

  test('sign-in options: a browser swapping its own ceremony is free; new browsers count', async () => {
    const same = client(srv);
    for (let i = 0; i < 30; i++) {
      assert.equal((await same.post('/api/auth/passkeys/login/options')).status, 200, `reload ${i + 1}`);
    }
    assert.equal(sql(srv, `SELECT COUNT(*) AS n FROM webauthn_challenges WHERE purpose = 'login'`)[0].n, 1, 'one row, replaced each time');

    for (let i = 0; i < 9; i++) {
      assert.equal((await client(srv).post('/api/auth/passkeys/login/options')).status, 200);
    }
    const res = await client(srv).post('/api/auth/passkeys/login/options');
    assert.equal(res.status, 429);
  });

  test('passkey sign-up shares the password sign-up throttle', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await client(srv).post('/api/auth/passkeys/signup/options', { username: freshName('t') });
      assert.equal(res.status, 200);
    }
    const passkey = await client(srv).post('/api/auth/passkeys/signup/options', { username: freshName('t') });
    assert.equal(passkey.status, 429);
    const password = await client(srv).post('/api/auth/signup', { username: freshName('t'), password: PASSWORD });
    assert.equal(password.status, 429);
    // A bad name costs nothing and is not counted.
    resetThrottles(srv);
    for (let i = 0; i < 15; i++) {
      assert.equal((await client(srv).post('/api/auth/passkeys/signup/options', { username: '!' })).status, 400);
    }
    assert.equal((await client(srv).post('/api/auth/passkeys/signup/options', { username: freshName('t') })).status, 200);
  });

  test('unfinished ceremonies are capped overall', async () => {
    const db = new DatabaseSync(srv.dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO webauthn_challenges (challenge_hash, browser_hash, purpose, expires_at)
         VALUES (?, 'x', 'login', datetime('now', '+5 minutes'))`
      );
      db.exec('BEGIN');
      for (let i = 0; i < 5000; i++) insert.run(`filler-${i}`);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const res = await client(srv).post('/api/auth/passkeys/login/options');
    assert.equal(res.status, 503);
    sql(srv, `DELETE FROM webauthn_challenges WHERE challenge_hash LIKE 'filler-%'`);
    assert.equal((await client(srv).post('/api/auth/passkeys/login/options')).status, 200);
  });
});
