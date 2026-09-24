// Starts a real server for a test suite: its own process, its own port, and a
// throwaway database, so suites can run side by side without sharing accounts,
// trees or rate-limit counters. Zero dependencies — node:test, node:child_process
// and the global fetch are all built in.
//
//   const { startServer } = require('../helpers/server');
//   const srv = await startServer();          // { base, stop, logs, dbPath }
//   const alice = await srv.signup('alice');  // { cookie, user, fetch }
//   await alice.fetch('/api/trees', { method: 'POST', body: { title: 'x' } });
//   await srv.stop();

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', 'backend', 'server.js');

async function startServer({ env = {}, timeoutMs = 15000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltree-test-'));
  const dbPath = path.join(dir, 'test.db');
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: { ...process.env, PORT: '0', SKILLTREE_DB: dbPath, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('server did not start:\n' + logs.join(''))),
      timeoutMs
    );
    const onData = (chunk) => {
      logs.push(chunk.toString());
      const m = logs.join('').match(/running at (http:\/\/localhost:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => logs.push(c.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n` + logs.join('')));
    });
  });

  // fetch() against this server. `body` objects are sent as JSON; a `cookie`
  // option rides along as the Cookie header. Returns the Response with the
  // parsed JSON (or null) attached as `.data`.
  async function request(pathname, { method = 'GET', body, headers = {}, cookie, ...rest } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = body;
    if (body !== undefined && typeof body !== 'string') {
      payload = JSON.stringify(body);
      h['Content-Type'] = h['Content-Type'] || 'application/json';
    }
    const res = await fetch(base + pathname, {
      method,
      headers: h,
      body: payload,
      redirect: 'manual',
      ...rest,
    });
    const text = await res.text();
    try {
      res.data = text ? JSON.parse(text) : null;
    } catch {
      res.data = null;
    }
    res.text_ = text;
    return res;
  }

  // Signs up a fresh account and returns a client bound to its session.
  async function signup(username, password = 'correct horse battery staple') {
    const res = await request('/api/auth/signup', { method: 'POST', body: { username, password } });
    if (res.status !== 201) {
      throw new Error(`signup ${username} failed: ${res.status} ${res.text_}`);
    }
    const cookie = cookieFrom(res);
    return {
      cookie,
      user: res.data,
      fetch: (p, opts = {}) => request(p, { cookie, ...opts }),
    };
  }

  async function stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, request, signup, stop, logs, dbPath, child };
}

// "name=value" pairs from every Set-Cookie on a response, joined the way a
// browser would send them back.
function cookieFrom(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return all
    .map((c) => c.split(';')[0])
    .filter((pair) => pair.split('=')[1] !== '')
    .join('; ');
}

module.exports = { startServer, cookieFrom };
