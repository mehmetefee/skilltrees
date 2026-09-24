// Account management: changing or setting a password, the session list,
// deleting the account, and exporting its data — against a real server in
// its own process (tests/helpers/server.js).
//
// Signups are rationed per address (ten per window, counted before the
// hash) and every request here comes from 127.0.0.1, so each describe block
// starts a server of its own and signs up no more than ten accounts on it.
// The throttle tests get one to themselves for the same reason.
//
// Accounts without a password (made through a provider) are written straight
// into the test database, along with a session of a chosen age: the rules
// under test are about what such an account may do, not how it was made —
// tests/api/oauth.test.js covers that.

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { startServer, cookieFrom } = require('../helpers/server');

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function openDb(srv) {
  return new DatabaseSync(srv.dbPath);
}

// A client for an existing session cookie.
function clientFor(srv, cookie) {
  return { cookie, fetch: (p, opts = {}) => srv.request(p, { cookie, ...opts }) };
}

// Signs in again as `username`: a second browser, with a user agent of its own.
async function login(srv, username, password = PASSWORD, userAgent = 'Second Device/1.0') {
  const res = await srv.request('/api/auth/login', {
    method: 'POST',
    body: { username, password },
    headers: { 'User-Agent': userAgent },
  });
  assert.equal(res.status, 200, `login ${username}: ${res.text_}`);
  return clientFor(srv, cookieFrom(res));
}

async function me(client) {
  return (await client.fetch('/api/auth/me')).data.user;
}

// An account with no password, as a provider sign-in makes one, with a
// session that signed in `ageSeconds` ago and a connected identity.
function passwordlessAccount(srv, username, { ageSeconds = 0 } = {}) {
  const db = openDb(srv);
  const id = Number(
    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, '')").run(username).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO user_identities (user_id, provider, issuer, subject, display_name)
     VALUES (?, 'oidc', 'https://sso.example', ?, ?)`
  ).run(id, `sub-${username}`, `${username}@sso.example`);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at, public_id, user_agent)
     VALUES (?, ?, datetime('now', ?), datetime('now'), datetime('now', '+1 day'), ?, 'Provider Browser')`
  ).run(sha256(token), id, `-${ageSeconds} seconds`, crypto.randomBytes(16).toString('hex'));
  db.close();
  return { id, ...clientFor(srv, `skilltree_session=${token}`) };
}

// Makes every session of an account look as if it signed in `minutes` ago.
function ageSessions(srv, userId, minutes) {
  const db = openDb(srv);
  db.prepare(`UPDATE sessions SET created_at = datetime('now', ?) WHERE user_id = ?`).run(
    `-${minutes} minutes`,
    userId
  );
  db.close();
}

function throttleCount(srv, key) {
  const db = openDb(srv);
  const row = db.prepare('SELECT count FROM rate_limits WHERE key = ?').get(key);
  db.close();
  return row ? row.count : 0;
}

// A tree with three skills and two links, through the API.
async function makeTree(client, title) {
  const tree = await client.fetch('/api/trees', { method: 'POST', body: { title } });
  assert.equal(tree.status, 201);
  const id = tree.data.id;
  const skill = async (name) =>
    (await client.fetch(`/api/trees/${id}/skills`, { method: 'POST', body: { name } })).data.id;
  const a = await skill('Mix flour');
  const b = await skill('Knead dough');
  const c = await skill('Bake');
  for (const [skill_id, prereq_skill_id] of [[b, a], [c, b]]) {
    const link = await client.fetch(`/api/trees/${id}/prereqs`, {
      method: 'POST',
      body: { skill_id, prereq_skill_id },
    });
    assert.equal(link.status, 201);
  }
  return id;
}

async function waitForLog(srv, pattern) {
  for (let i = 0; i < 100 && !pattern.test(srv.logs.join('')); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(srv.logs.join(''), pattern);
}

// ---------------------------------------------------------------------------

describe('changing a password', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => srv.stop());

  test('needs a session', async () => {
    const res = await srv.request('/api/auth/password', {
      method: 'POST',
      body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    assert.equal(res.status, 401);
  });

  test('a wrong current password is refused without detail, and counted', async () => {
    const alice = await srv.signup('alice');
    const res = await alice.fetch('/api/auth/password', {
      method: 'POST',
      body: { current_password: 'not my password at all', new_password: NEW_PASSWORD },
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.error, 'That is not your current password.');
    assert.equal(throttleCount(srv, `password-change-user:${alice.user.id}:127.0.0.1`), 1);
    await waitForLog(srv, /password change refused: wrong current password user=alice/);

    // Nothing changed: the old password still signs in, and alice is still here.
    assert.equal((await me(alice)).username, 'alice');
    await login(srv, 'alice');
  });

  test('a weak, reused or missing password is refused, and not counted', async () => {
    const bea = await srv.signup('bea');
    const key = `password-change-user:${bea.user.id}:127.0.0.1`;
    const cases = [
      [{ current_password: PASSWORD, new_password: 'short' }, /at least 8/],
      [{ current_password: PASSWORD, new_password: 'password123' }, /commonly used/],
      [{ current_password: PASSWORD, new_password: 'bea-the-great-baker' }, /username/],
      [{ current_password: PASSWORD, new_password: 'aaaaaaaaaaaa' }, /more than one character/],
      [{ current_password: PASSWORD, new_password: PASSWORD }, /different from your current/],
      [{ new_password: NEW_PASSWORD }, /current password/],
      [{ current_password: PASSWORD }, /at least 8/],
    ];
    // More refusals than the limit allows guesses: none of them may count.
    for (let round = 0; round < 2; round++) {
      for (const [body, message] of cases) {
        const res = await bea.fetch('/api/auth/password', { method: 'POST', body });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match(res.data.error, message);
      }
    }
    assert.equal(throttleCount(srv, key), 0);

    const ok = await bea.fetch('/api/auth/password', {
      method: 'POST',
      body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    assert.equal(ok.status, 200, 'refusals above never used up the limit');
  });

  test('success ends every other session and rotates this one', async () => {
    const cleo = await srv.signup('cleo');
    const phone = await login(srv, 'cleo');
    const before = (await cleo.fetch('/api/auth/sessions')).data.find((s) => s.current);

    const res = await cleo.fetch('/api/auth/password', {
      method: 'POST',
      body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { ok: true, other_sessions_ended: 1 });
    await waitForLog(srv, /password changed user=cleo id=\d+ first_password=no other_sessions_ended=1/);

    // A new token for this browser; the old cookie is dead.
    const rotated = cookieFrom(res);
    assert.match(rotated, /^skilltree_session=/);
    assert.notEqual(rotated, cleo.cookie);
    assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\//);
    assert.equal(await me(cleo), null, 'the cookie from before the change no longer works');
    const cleoNow = clientFor(srv, rotated);
    assert.equal((await me(cleoNow)).username, 'cleo');
    assert.equal(await me(phone), null, 'the other device was signed out');

    // Rotating is not signing in: the same session, the same sign-in time.
    const sessions = (await cleoNow.fetch('/api/auth/sessions')).data;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, before.id);
    assert.equal(sessions[0].created_at, before.created_at);
    assert.equal(sessions[0].current, true);

    // The old password is gone; the new one works.
    const old = await srv.request('/api/auth/login', {
      method: 'POST',
      body: { username: 'cleo', password: PASSWORD },
    });
    assert.equal(old.status, 401);
    await login(srv, 'cleo', NEW_PASSWORD);
  });

  test('a change whose session is ended while it hashes is not saved', async () => {
    const dana = await srv.signup('dana');
    const other = await login(srv, 'dana');
    const danaSession = (await dana.fetch('/api/auth/sessions')).data.find((s) => s.current);

    // Sent together: the change spends ~0.5 s per hash, and the other
    // device ends its session meanwhile. Whichever the server sees first,
    // the change must not land.
    const [change, ended] = await Promise.all([
      dana.fetch('/api/auth/password', {
        method: 'POST',
        body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
      }),
      other.fetch(`/api/auth/sessions/${danaSession.id}`, { method: 'DELETE' }),
    ]);
    assert.equal(ended.status, 200);
    assert.equal(change.status, 401);
    await login(srv, 'dana', PASSWORD);
  });

  test('an account without a password can set one, but only just after signing in', async () => {
    const stale = passwordlessAccount(srv, 'erin', { ageSeconds: 11 * 60 });
    const refused = await stale.fetch('/api/auth/password', {
      method: 'POST',
      body: { new_password: NEW_PASSWORD },
    });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /sign in again/i);
    assert.equal((await me(stale)).has_password, false);

    const fresh = passwordlessAccount(srv, 'fern', { ageSeconds: 30 });
    const set = await fresh.fetch('/api/auth/password', {
      method: 'POST',
      body: { new_password: NEW_PASSWORD },
    });
    assert.equal(set.status, 200);
    await waitForLog(srv, /password changed user=fern id=\d+ first_password=yes/);
    const fernNow = clientFor(srv, cookieFrom(set));
    assert.equal((await me(fernNow)).has_password, true);
    await login(srv, 'fern', NEW_PASSWORD);

    // From now on it is a change, and the password is what proves it.
    const again = await fernNow.fetch('/api/auth/password', {
      method: 'POST',
      body: { new_password: 'yet another passphrase' },
    });
    assert.equal(again.status, 400);
    assert.match(again.data.error, /current password/);
  });

  test('the username rule applies to a first password too', async () => {
    const gil = passwordlessAccount(srv, 'gilbert');
    const res = await gil.fetch('/api/auth/password', {
      method: 'POST',
      body: { new_password: 'gilbert-rocks-2026' },
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /username/);
  });
});

// ---------------------------------------------------------------------------

describe('sessions', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => srv.stop());

  test('need a session', async () => {
    assert.equal((await srv.request('/api/auth/sessions')).status, 401);
    assert.equal((await srv.request('/api/auth/sessions/revoke-others', { method: 'POST' })).status, 401);
    const id = crypto.randomBytes(16).toString('hex');
    assert.equal((await srv.request(`/api/auth/sessions/${id}`, { method: 'DELETE' })).status, 401);
  });

  test('are listed with a public id, a device and which one is this', async () => {
    const alice = await srv.signup('alice');
    await login(srv, 'alice', PASSWORD, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0');
    await login(srv, 'alice', PASSWORD, `Tabbed\tAgent ${'x'.repeat(400)}`);

    const res = await alice.fetch('/api/auth/sessions');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const list = res.data;
    assert.equal(list.length, 3);
    assert.equal(list.filter((s) => s.current).length, 1);
    for (const s of list) {
      assert.deepEqual(Object.keys(s).sort(), ['created_at', 'current', 'id', 'last_used_at', 'user_agent']);
      assert.match(s.id, /^[0-9a-f]{32}$/);
    }
    assert.ok(list.some((s) => s.user_agent.includes('Firefox/128.0')));

    // Stored cut short, and without control characters.
    const long = list.find((s) => s.user_agent.startsWith('Tabbed'));
    assert.equal(long.user_agent.length, 256);
    assert.ok(long.user_agent.startsWith('TabbedAgent '));

    // Nothing in the list is, or is part of, a token or its hash.
    const db = openDb(srv);
    const hashes = db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
    db.close();
    for (const h of hashes) {
      assert.ok(!res.text_.includes(h.slice(0, 12)), 'no token_hash, not even a prefix');
    }
    assert.ok(!res.text_.includes(alice.cookie.split('=')[1]));
  });

  test('another of your sessions can be ended; someone else’s is not found', async () => {
    const bob = await srv.signup('bob');
    const laptop = await login(srv, 'bob');
    const cyd = await srv.signup('cyd');

    const laptopId = (await bob.fetch('/api/auth/sessions')).data.find((s) => !s.current).id;
    const cyId = (await cyd.fetch('/api/auth/sessions')).data[0].id;

    // Another account's session answers like one that doesn't exist.
    const foreign = await bob.fetch(`/api/auth/sessions/${cyId}`, { method: 'DELETE' });
    assert.equal(foreign.status, 404);
    assert.equal((await me(cyd)).username, 'cyd', 'cyd is still signed in');
    for (const bad of ['nope', '1', cyId.toUpperCase(), `${cyId}0`]) {
      assert.equal((await bob.fetch(`/api/auth/sessions/${bad}`, { method: 'DELETE' })).status, 404);
    }

    const ended = await bob.fetch(`/api/auth/sessions/${laptopId}`, { method: 'DELETE' });
    assert.equal(ended.status, 200);
    assert.equal(ended.headers.get('set-cookie'), null, 'this browser keeps its cookie');
    assert.equal(await me(laptop), null);
    assert.equal((await me(bob)).username, 'bob');
    assert.equal((await bob.fetch('/api/auth/sessions')).data.length, 1);
    assert.equal((await bob.fetch(`/api/auth/sessions/${laptopId}`, { method: 'DELETE' })).status, 404);
  });

  test('ending your own session signs you out', async () => {
    const dee = await srv.signup('dee');
    const mine = (await dee.fetch('/api/auth/sessions')).data[0];
    assert.equal(mine.current, true);
    const res = await dee.fetch(`/api/auth/sessions/${mine.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(await me(dee), null);
  });

  test('"sign out everywhere else" ends every session but this one', async () => {
    const eve = await srv.signup('eve');
    const others = [await login(srv, 'eve'), await login(srv, 'eve')];
    const res = await eve.fetch('/api/auth/sessions/revoke-others', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { ok: true, ended: 2 });
    for (const o of others) assert.equal(await me(o), null);
    const list = (await eve.fetch('/api/auth/sessions')).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].current, true);
  });

  test('ending another session needs a recent sign-in; signing yourself out never does', async () => {
    const fay = await srv.signup('fay');
    const tablet = await login(srv, 'fay');
    ageSessions(srv, fay.user.id, 11);

    const tabletId = (await fay.fetch('/api/auth/sessions')).data.find((s) => !s.current).id;
    const one = await fay.fetch(`/api/auth/sessions/${tabletId}`, { method: 'DELETE' });
    assert.equal(one.status, 403);
    assert.match(one.data.error, /sign in again/i);
    const all = await fay.fetch('/api/auth/sessions/revoke-others', { method: 'POST' });
    assert.equal(all.status, 403);
    assert.equal((await me(tablet)).username, 'fay', 'nothing was ended');

    // A fresh sign-in is enough.
    const fresh = await login(srv, 'fay');
    const ok = await fresh.fetch('/api/auth/sessions/revoke-others', { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ended, 2);
    assert.equal(await me(tablet), null);
    assert.equal(await me(fay), null);

    // And an old session can always sign itself out.
    const gus = await srv.signup('gus');
    ageSessions(srv, gus.user.id, 60);
    const own = (await gus.fetch('/api/auth/sessions')).data[0];
    assert.equal((await gus.fetch(`/api/auth/sessions/${own.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(await me(gus), null);
  });
});

// ---------------------------------------------------------------------------

describe('deleting an account', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => srv.stop());

  test('needs a session', async () => {
    const res = await srv.request('/api/auth/account', {
      method: 'DELETE',
      body: { confirm_username: 'x', password: PASSWORD },
    });
    assert.equal(res.status, 401);
  });

  test('is refused for a wrong password, a wrong name or no password', async () => {
    const alice = await srv.signup('alice');
    await makeTree(alice, 'Alice keeps this');
    const del = (body) => alice.fetch('/api/auth/account', { method: 'DELETE', body });

    const wrongName = await del({ confirm_username: 'alicia', password: PASSWORD });
    assert.equal(wrongName.status, 400);
    assert.match(wrongName.data.error, /username/);
    const noPassword = await del({ confirm_username: 'alice' });
    assert.equal(noPassword.status, 400);
    assert.match(noPassword.data.error, /password/);
    assert.equal(throttleCount(srv, `account-delete-user:${alice.user.id}:127.0.0.1`), 0, 'typos are not counted');

    const wrongPassword = await del({ confirm_username: 'alice', password: 'a wrong password' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(throttleCount(srv, `account-delete-user:${alice.user.id}:127.0.0.1`), 1, 'a guess is');

    assert.equal((await me(alice)).username, 'alice');
    assert.equal((await alice.fetch('/api/auth/account')).data.tree_count, 1);
  });

  test('deletes the account, its trees, sessions and identities — and nothing of anyone else’s', async () => {
    const bram = await srv.signup('bram');
    const cara = await srv.signup('cara');
    const bramTrees = [await makeTree(bram, 'Bram one'), await makeTree(bram, 'Bram two')];
    const caraTree = await makeTree(cara, 'Cara stays');
    const bramPhone = await login(srv, 'bram');
    const db = openDb(srv);
    db.prepare(
      `INSERT INTO user_identities (user_id, provider, issuer, subject, display_name)
       VALUES (?, 'oidc', 'https://sso.example', 'bram-at-sso', 'bram@sso.example')`
    ).run(bram.user.id);
    db.close();

    const summary = await bram.fetch('/api/auth/account');
    assert.equal(summary.status, 200);
    assert.deepEqual(
      { ...summary.data, created_at: undefined },
      { id: bram.user.id, username: 'bram', has_password: true, tree_count: 2, created_at: undefined }
    );

    // The username is compared case-insensitively, as usernames are.
    const res = await bram.fetch('/api/auth/account', {
      method: 'DELETE',
      body: { confirm_username: 'BRAM', password: PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { ok: true, deleted_trees: 2 });
    assert.equal(res.headers.get('clear-site-data'), '"cookies", "storage"');
    assert.match(res.headers.get('set-cookie'), /^skilltree_session=; .*Max-Age=0/);
    await waitForLog(srv, /account deleted user=bram id=\d+ trees=2/);

    assert.equal(await me(bram), null);
    assert.equal(await me(bramPhone), null);
    const relogin = await srv.request('/api/auth/login', {
      method: 'POST',
      body: { username: 'bram', password: PASSWORD },
    });
    assert.equal(relogin.status, 401);

    const check = openDb(srv);
    const count = (sql, ...args) => check.prepare(sql).get(...args).n;
    assert.equal(count('SELECT COUNT(*) AS n FROM users WHERE id = ?', bram.user.id), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', bram.user.id), 0);
    assert.equal(count('SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ?', bram.user.id), 0);
    for (const id of bramTrees) {
      assert.equal(count('SELECT COUNT(*) AS n FROM trees WHERE id = ?', id), 0);
      assert.equal(count('SELECT COUNT(*) AS n FROM skills WHERE tree_id = ?', id), 0);
      assert.equal(count('SELECT COUNT(*) AS n FROM prereqs WHERE tree_id = ?', id), 0);
    }
    assert.equal(count('SELECT COUNT(*) AS n FROM skills WHERE tree_id = ?', caraTree), 3);
    check.close();

    const cTree = await srv.request(`/api/trees/${caraTree}`);
    assert.equal(cTree.status, 200);
    assert.equal(cTree.data.skills.length, 3);
    assert.equal(cTree.data.edges.length, 2);
    const titles = (await srv.request('/api/trees')).data.map((t) => t.title);
    assert.deepEqual(titles.filter((t) => t.startsWith('Bram')), []);
    assert.equal((await me(cara)).username, 'cara');
  });

  test('without a password it needs a recent sign-in instead', async () => {
    const stale = passwordlessAccount(srv, 'dove', { ageSeconds: 15 * 60 });
    const refused = await stale.fetch('/api/auth/account', {
      method: 'DELETE',
      body: { confirm_username: 'dove' },
    });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /sign in again/i);
    assert.equal((await me(stale)).username, 'dove');

    const fresh = passwordlessAccount(srv, 'elm');
    await makeTree(fresh, 'Elm tree');
    const res = await fresh.fetch('/api/auth/account', {
      method: 'DELETE',
      body: { confirm_username: 'elm' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.deleted_trees, 1);
    const db = openDb(srv);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ?').get(fresh.id).n, 0);
    db.close();
  });

  // The route deletes trees itself and relies on ON DELETE CASCADE for the
  // rest. A table added later that names users without it would make
  // deletion fail (safely, as one transaction) — this says so up front.
  test('every reference to users cascades, apart from trees.user_id', () => {
    const db = openDb(srv);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    const references = [];
    for (const table of tables) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
        if (fk.table === 'users') references.push(`${table}.${fk.from}:${fk.on_delete}`);
      }
    }
    db.close();
    assert.ok(references.includes('trees.user_id:NO ACTION'), 'trees are deleted by the route itself');
    const others = references.filter((r) => !r.startsWith('trees.user_id:'));
    assert.ok(others.length >= 3, `sessions, identities, oauth_flows at least: ${others}`);
    for (const r of others) assert.match(r, /:CASCADE$/, `${r} must be ON DELETE CASCADE`);
  });
});

// ---------------------------------------------------------------------------

describe('exporting your data', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => srv.stop());

  test('needs a session', async () => {
    assert.equal((await srv.request('/api/auth/export')).status, 401);
  });

  test('holds the account, its sign-ins, sessions, passkeys and trees — and no secrets', async () => {
    const fran = await srv.signup('fran');
    const phone = await login(srv, 'fran', PASSWORD, 'Phone Browser/2.0');
    await makeTree(fran, 'Sourdough');
    await makeTree(fran, 'Pasta');

    // Stand-ins for what other features store: a connected provider, and a
    // passkey, key material included — which must not come out.
    const db = openDb(srv);
    db.prepare(
      `INSERT INTO user_identities (user_id, provider, issuer, subject, display_name)
       VALUES (?, 'oidc', 'https://sso.example', 'fran-at-sso', 'fran@sso.example')`
    ).run(fran.user.id);
    db.prepare(
      `INSERT INTO passkeys (user_id, name, credential_id, public_key, alg, sign_count, aaguid, rp_id)
       VALUES (?, 'Laptop', 'CRED-ID-SHOULD-NOT-APPEAR', 'PUBLIC-KEY-SHOULD-NOT-APPEAR', -7, 7,
               'AAGUID-SHOULD-NOT-APPEAR', 'skilltrees.example')`
    ).run(fran.user.id);
    const secrets = [
      db.prepare('SELECT password_hash FROM users WHERE id = ?').get(fran.user.id).password_hash,
      ...db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').all(fran.user.id).map((r) => r.token_hash),
    ];
    db.close();

    const res = await fran.fetch('/api/auth/export');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="skilltrees-fran.json"');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('etag'), null, 'no-store: not a cacheable representation');

    const data = res.data;
    assert.equal(data.format, 'skilltrees-account-export');
    assert.equal(data.version, 1);
    assert.deepEqual(
      { ...data.account, created_at: undefined },
      { id: fran.user.id, username: 'fran', has_password: true, created_at: undefined }
    );
    assert.deepEqual(
      data.identities.map(({ created_at, ...rest }) => rest),
      [{
        provider: 'oidc',
        provider_name: 'oidc',
        issuer: 'https://sso.example',
        subject: 'fran-at-sso',
        display_name: 'fran@sso.example',
      }]
    );
    assert.equal(data.sessions.length, 2);
    assert.equal(data.sessions.filter((s) => s.current).length, 1);
    assert.ok(data.sessions.some((s) => s.user_agent === 'Phone Browser/2.0'));
    for (const s of data.sessions) {
      assert.deepEqual(Object.keys(s).sort(), ['created_at', 'current', 'expires_at', 'last_used_at', 'user_agent']);
    }
    assert.equal(data.passkeys.length, 1);
    assert.deepEqual(Object.keys(data.passkeys[0]).sort(), ['created_at', 'id', 'last_used_at', 'name']);
    assert.equal(data.passkeys[0].name, 'Laptop');
    assert.deepEqual(data.trees.map((t) => t.notation.title), ['Sourdough', 'Pasta']);

    for (const secret of [...secrets, fran.cookie.split('=')[1], phone.cookie.split('=')[1]]) {
      assert.ok(!res.text_.includes(secret), 'no password hash, token or token hash');
    }
    for (const leak of ['scrypt$', 'password_hash', 'token_hash', 'public_id', 'CRED-ID', 'PUBLIC-KEY', 'AAGUID', 'sign_count']) {
      assert.ok(!res.text_.includes(leak), `nothing like ${leak}`);
    }
    await waitForLog(srv, /data export user=fran id=\d+ trees=2/);
  });

  test('every tree in it can be imported again, unchanged', async () => {
    const gale = await srv.signup('gale');
    await makeTree(gale, 'Carpentry');
    const hal = await srv.signup('hal');

    const exported = (await gale.fetch('/api/auth/export')).data.trees;
    assert.equal(exported.length, 1);
    const { notation } = exported[0];
    assert.equal(notation.format, 'skilltree');
    assert.deepEqual(notation.skills.map((s) => s.requires.length), [0, 1, 1]);

    const imported = await hal.fetch('/api/trees/import', { method: 'POST', body: notation });
    assert.equal(imported.status, 201, imported.text_);
    assert.equal(imported.data.skill_count, 3);
    // Export -> import -> export stays identical, as for a single tree.
    const again = await srv.request(`/api/trees/${imported.data.id}/export`);
    assert.deepEqual(again.data, notation);
  });

  test('says when there is no password', async () => {
    const ivy = passwordlessAccount(srv, 'ivy');
    const res = await ivy.fetch('/api/auth/export');
    assert.equal(res.status, 200);
    assert.equal(res.data.account.has_password, false);
    assert.deepEqual(res.data.passkeys, []);
    assert.deepEqual(res.data.trees, []);
  });
});

describe('exporting an account without passkeys', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => srv.stop());

  // The passkeys table always exists now (db/init.js makes it), so an
  // account without any has an empty list rather than no member.
  test('has an empty passkeys list', async () => {
    const joe = await srv.signup('joe');
    const res = await joe.fetch('/api/auth/export');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.passkeys, []);
  });
});

// ---------------------------------------------------------------------------

describe('throttling', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => srv.stop());

  test('password guesses are limited before the hash, even a right one after', async () => {
    const kit = await srv.signup('kit');
    for (let i = 0; i < 10; i++) {
      const res = await kit.fetch('/api/auth/password', {
        method: 'POST',
        body: { current_password: `wrong guess ${i}`, new_password: NEW_PASSWORD },
      });
      assert.equal(res.status, 401);
    }
    const right = await kit.fetch('/api/auth/password', {
      method: 'POST',
      body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    assert.equal(right.status, 429);
    assert.ok(right.headers.get('retry-after'));
    await waitForLog(srv, /password change throttled user=kit/);
    await login(srv, 'kit', PASSWORD); // unchanged
  });

  test('so are deletion attempts, and the account survives them', async () => {
    const lee = await srv.signup('lee');
    const tries = [];
    for (let i = 0; i < 10; i++) {
      tries.push(
        (await lee.fetch('/api/auth/account', {
          method: 'DELETE',
          body: { confirm_username: 'lee', password: `wrong guess ${i}` },
        })).status
      );
    }
    assert.deepEqual([...new Set(tries)], [401]);
    const right = await lee.fetch('/api/auth/account', {
      method: 'DELETE',
      body: { confirm_username: 'lee', password: PASSWORD },
    });
    assert.equal(right.status, 429);
    assert.equal((await me(lee)).username, 'lee');
  });

  test('and exports, per account', async () => {
    const max = await srv.signup('max');
    for (let i = 0; i < 10; i++) {
      assert.equal((await max.fetch('/api/auth/export')).status, 200);
    }
    assert.equal((await max.fetch('/api/auth/export')).status, 429);
    const ned = await srv.signup('ned');
    assert.equal((await ned.fetch('/api/auth/export')).status, 200, 'another account is unaffected');
  });
});
