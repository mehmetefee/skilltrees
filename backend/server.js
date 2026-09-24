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

// Sent on every response. Studies of generated web code single these out as
// the thing that's routinely missing, and the login form is exactly the kind
// of page that suffers for it (framing it is a clickjacking attack).
function securityHeaders(isHtml = false) {
  const headers = {
    'X-Content-Type-Options': 'nosniff', // don't let a .json be run as script
    'X-Frame-Options': 'DENY', // for browsers predating frame-ancestors
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Tell browsers to use HTTPS for the next year. On a first plain-HTTP
    // visit the header is ignored (spec requirement), but once a user has
    // visited via HTTPS the browser remembers and upgrades automatically.
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
  headers['Content-Security-Policy'] = isHtml
    ? // 'unsafe-inline' for styles only: several pages carry style attributes.
      // Scripts stay strict, which is what stops injected markup executing.
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
      "form-action 'self'; frame-ancestors 'none'; object-src 'none'"
    : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  return headers;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        // A bad body is the caller's mistake, not a server fault.
        return reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
      // Valid JSON that isn't an object (null, a number, an array) would make
      // every `body.field` read below either throw or behave oddly.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(
          Object.assign(new Error('Request body must be a JSON object'), { statusCode: 400 })
        );
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
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
function route(method, pattern, handler) {
  // pattern like /api/trees/:id -> regex with named captures
  const paramNames = [];
  const regexStr = pattern.replace(/:[^/]+/g, (m) => {
    paramNames.push(m.slice(1));
    return '([^/]+)';
  });
  const regex = new RegExp(`^${regexStr}$`);
  routes.push({ method, regex, paramNames, handler });
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
    { 'Set-Cookie': sessionCookie(startSession(user.id), req) }
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
    .replace(/[̀-ͯ]/g, '')
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
  const token = startSession(userId);
  giveBackStart();
  console.log(`[AUTH] oauth login success provider=${provider.id} user=${logSafe(username)} id=${userId} ip=${clientIp(req)}`);
  redirectTo(res, flow.next_path, [sessionCookie(token, req), clearFlow]);
});

route('GET', '/api/auth/identities', async (req, res) => {
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Sign in to see your account.' });
  const rows = db
    .prepare(
      `SELECT id, provider, display_name, created_at FROM user_identities
        WHERE user_id = ? ORDER BY id`
    )
    .all(user.id);
  sendJson(
    res,
    200,
    rows.map((row) => {
      const provider = OAUTH.providers.get(row.provider);
      return {
        ...row,
        provider_name: provider ? provider.name : row.provider,
        // Configured right now, so usable to sign in with.
        enabled: !!provider,
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

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${filename}"`,
    ...securityHeaders(),
  });
  res.end(body);
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

// ---------- static file serving (frontend) ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  try {
    filePath = decodeURIComponent(filePath);
  } catch (e) {
    res.writeHead(400, securityHeaders());
    return res.end('Bad Request');
  }
  // No control character can be part of a real filename here, and one of them
  // is a weapon: fs.readFile validates its path *synchronously*, so a decoded
  // NUL ("/%00") throws rather than calling back — out of this function, out
  // of the async listener, and into an unhandled rejection that ends the
  // process. Refusing the whole class costs nothing and closes that door.
  if (hasControlChars(filePath)) {
    res.writeHead(400, securityHeaders());
    return res.end('Bad Request');
  }
  if (filePath === '/') filePath = '/index.html';
  const fullPath = path.normalize(path.join(FRONTEND_DIR, filePath));

  // Note the separator: a bare startsWith(FRONTEND_DIR) would also accept a
  // sibling directory whose name merely starts the same way ("frontend-keys"),
  // which is a traversal out of the served tree.
  if (fullPath !== FRONTEND_DIR && !fullPath.startsWith(FRONTEND_DIR + path.sep)) {
    res.writeHead(403, securityHeaders());
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders() });
      return res.end('Not found');
    }
    const ext = path.extname(fullPath);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...securityHeaders(ext === '.html'),
    };
    if (ext === '.svg') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    if (ext === '.woff2') {
      // Named for its contents, so a stale copy is not a risk worth a
      // revalidation on every page load.
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  // Cross-origin requests are not supported: no CORS headers means the
  // browser's preflight will fail and the request will be blocked.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, securityHeaders());
    return res.end();
  }

  const urlPath = req.url.split('?')[0];

  if (urlPath.startsWith('/api/')) {
    // Defence in depth behind the SameSite=Lax cookie (ASVS V4.2.2): a browser
    // always sends Origin on a state-changing request, so a mismatched one is
    // another site acting on someone's behalf. A missing Origin means a
    // non-browser caller (curl, a script), which carries no ambient cookie and
    // so can't be tricked this way.
    if (req.method !== 'GET' && req.headers.origin) {
      let originHost = null;
      try {
        originHost = new URL(req.headers.origin).host;
      } catch (e) {
        originHost = null;
      }
      if (originHost !== req.headers.host) {
        return sendJson(res, 403, { error: 'Cross-site request refused.' });
      }
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = urlPath.match(r.regex);
      if (!match) continue;
      const params = {};
      r.paramNames.forEach((name, i) => (params[name] = match[i + 1]));
      try {
        await r.handler(req, res, params);
      } catch (e) {
        // Bad input is the caller's problem: answer 4xx and don't log a stack
        // for it. Only genuine faults are worth a 500 and the noise.
        if (e && e.statusCode) {
          sendJson(res, e.statusCode, { error: e.message });
        } else {
          console.error(e);
          sendJson(res, 500, { error: 'Internal server error' });
        }
      }
      return;
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  try {
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain', ...securityHeaders() });
    res.end('Internal server error');
  }
});

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

server.listen(PORT, () => {
  // The real port, not PORT: with PORT=0 the OS picks one, and the test
  // harness reads it from this line.
  console.log(`Skill Tree server running at http://localhost:${server.address().port}`);
});
