// A tiny OpenID Connect provider for tests, on 127.0.0.1 and a port the OS
// picks. Zero dependencies: node:http and node:crypto. It does just enough
// of a real provider to be a fair test of the client:
//
//   GET  /.well-known/openid-configuration   discovery, advertising RFC 9207 iss
//   GET  /authorize      auto-approves: redirects to redirect_uri with code, state, iss
//   POST /token          checks client auth, redirect_uri and PKCE S256, returns
//                        an RS256 ID token signed with a key made at startup
//   GET  /jwks           the public half of that key
//
// and, for GitHub's plain-OAuth shape (no discovery, no ID token):
//
//   GET  /login/oauth/authorize, POST /login/oauth/access_token, GET /user
//
// Knobs make it misbehave on purpose, for the negative tests:
//
//   mock.set({ authorizeIss: 'https://evil.example' })   wrong iss on the redirect
//   mock.set({ omitIss: true })                           no iss on the redirect
//   mock.set({ authorizeError: 'access_denied' })         the user said no
//   mock.set({ tokenError: 'invalid_grant' })             token endpoint refuses
//   mock.set({ idToken: { nonce: 'x', aud: 'y', exp: 1, iss: '...', ... } })
//   mock.set({ header: { alg: 'none' } })  or { alg: 'HS256' } or { kid: 'nope' }
//   mock.set({ header: { alg: 'none' }, signature: 'AAAA' })  none, but not empty
//   mock.set({ badSignature: true })                      payload changed after signing
//   mock.user = { sub, preferred_username, email, ... }    who "signs in" next
//
// mock.reset() puts everything back.

const http = require('node:http');
const crypto = require('node:crypto');

const b64url = (value) => Buffer.from(value).toString('base64url');

async function startMockOidc({
  clientId = 'skilltrees-test-client',
  clientSecret = 'test-secret-that-must-never-be-logged',
  githubUser = { id: 4242, login: 'octo-cat' },
} = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'mock-key-1';
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  const codes = new Map(); // code -> what the token endpoint needs to know
  const githubTokens = new Map(); // access token -> user

  const mock = {
    clientId,
    clientSecret,
    issuer: null,
    kid,
    privateKey,
    publicKey,
    behavior: {},
    user: null,
    tokenRequests: [],
    authorizeRequests: [],
    jwksFetches: 0,
    set(behavior) {
      Object.assign(mock.behavior, behavior);
    },
    reset() {
      mock.behavior = {};
      mock.user = { sub: 'user-1', preferred_username: 'ada', email: 'ada@example.com' };
    },
    signJwt,
    stop: null,
  };
  mock.reset();

  function signJwt(header, payload, { tamper = false } = {}) {
    const h = b64url(JSON.stringify(header));
    const p = b64url(JSON.stringify(payload));
    const input = `${h}.${p}`;
    let sig;
    if (header.alg === 'none') {
      sig = mock.behavior.signature || '';
    } else if (header.alg === 'HS256') {
      // The classic confusion: the public key used as an HMAC secret.
      sig = crypto.createHmac('sha256', publicPem).update(input).digest('base64url');
    } else {
      sig = crypto.sign('sha256', Buffer.from(input), privateKey).toString('base64url');
    }
    if (tamper) {
      const forged = b64url(JSON.stringify({ ...payload, sub: 'someone-else' }));
      return `${h}.${forged}.${sig}`;
    }
    return `${h}.${p}.${sig}`;
  }

  function send(res, status, body, headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(text);
  }

  function readForm(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    });
  }

  // client_secret_basic (form-encoded halves, RFC 6749 §2.3.1) or _post.
  function clientAuth(req, form) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const dec = (v) => new URLSearchParams(`v=${v}`).get('v');
      return {
        method: 'basic',
        id: dec(decoded.slice(0, colon)),
        secret: dec(decoded.slice(colon + 1)),
      };
    }
    return { method: 'post', id: form.get('client_id'), secret: form.get('client_secret') };
  }

  function authorize(req, res, url, { github = false } = {}) {
    const q = url.searchParams;
    mock.authorizeRequests.push(Object.fromEntries(q));
    if (q.get('client_id') !== clientId) return send(res, 400, 'unknown client_id');
    if (q.get('response_type') !== 'code' && !github) return send(res, 400, 'response_type must be code');
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      return send(res, 400, 'PKCE S256 required');
    }
    let redirect;
    try {
      redirect = new URL(q.get('redirect_uri'));
    } catch {
      return send(res, 400, 'bad redirect_uri');
    }
    const b = mock.behavior;
    if (b.authorizeError) {
      redirect.searchParams.set('error', b.authorizeError);
    } else {
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, {
        redirectUri: q.get('redirect_uri'),
        challenge: b.challengeOverride || q.get('code_challenge'),
        nonce: q.get('nonce'),
        user: { ...mock.user },
        used: false,
      });
      redirect.searchParams.set('code', code);
    }
    redirect.searchParams.set('state', q.get('state'));
    if (!github && !b.omitIss) redirect.searchParams.set('iss', b.authorizeIss || mock.issuer);
    res.writeHead(302, { Location: redirect.href });
    res.end();
  }

  // Shared by both token endpoints: the checks a real provider makes.
  function redeem(req, form) {
    const auth = clientAuth(req, form);
    const record = {
      auth: auth.method,
      grant_type: form.get('grant_type'),
      code_verifier: form.get('code_verifier'),
      redirect_uri: form.get('redirect_uri'),
      accept: req.headers.accept || '',
      userAgent: req.headers['user-agent'] || '',
    };
    mock.tokenRequests.push(record);
    if (auth.id !== clientId || auth.secret !== clientSecret) return { error: 'invalid_client', status: 401 };
    if (record.grant_type !== 'authorization_code') return { error: 'unsupported_grant_type', status: 400 };
    const entry = codes.get(form.get('code'));
    if (!entry || entry.used) return { error: 'invalid_grant', status: 400 };
    entry.used = true;
    if (record.redirect_uri !== entry.redirectUri) return { error: 'invalid_grant', status: 400 };
    const verifier = record.code_verifier || '';
    const expected = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || expected !== entry.challenge) {
      record.pkce = 'mismatch';
      return { error: 'invalid_grant', status: 400 };
    }
    record.pkce = 'ok';
    if (mock.behavior.tokenError) return { error: mock.behavior.tokenError, status: 400 };
    return { entry };
  }

  async function token(req, res) {
    const form = await readForm(req);
    const outcome = redeem(req, form);
    if (outcome.error) return send(res, outcome.status, { error: outcome.error });
    const { entry } = outcome;
    const now = Math.floor(Date.now() / 1000);
    const b = mock.behavior;
    const claims = {
      iss: mock.issuer,
      aud: clientId,
      iat: now,
      exp: now + 300,
      nonce: entry.nonce,
      ...entry.user,
      ...(b.idToken || {}),
    };
    for (const name of b.omitClaims || []) delete claims[name];
    const header = { alg: 'RS256', typ: 'JWT', kid, ...(b.header || {}) };
    send(res, 200, {
      access_token: crypto.randomBytes(16).toString('hex'),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: signJwt(header, claims, { tamper: !!b.badSignature }),
    });
  }

  // GitHub answers errors with a 200 and an `error` member, and wants
  // Accept: application/json to answer in JSON at all.
  async function githubToken(req, res) {
    const form = await readForm(req);
    const outcome = redeem(req, form);
    const json = (req.headers.accept || '').includes('application/json');
    if (outcome.error) {
      return json
        ? send(res, 200, { error: outcome.error === 'invalid_grant' ? 'bad_verification_code' : outcome.error })
        : send(res, 200, `error=${outcome.error}`);
    }
    const accessToken = 'gho_' + crypto.randomBytes(16).toString('hex');
    githubTokens.set(accessToken, { ...githubUser, ...(mock.behavior.githubUser || {}) });
    if (!json) return send(res, 200, `access_token=${accessToken}&scope=&token_type=bearer`);
    send(res, 200, { access_token: accessToken, token_type: 'bearer', scope: '' });
  }

  function githubUserEndpoint(req, res) {
    const auth = req.headers.authorization || '';
    const user = githubTokens.get(auth.replace(/^Bearer /, ''));
    if (!req.headers['user-agent']) return send(res, 403, { message: 'User-Agent required' });
    if (!user) return send(res, 401, { message: 'Bad credentials' });
    send(res, 200, user);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, mock.issuer);
    try {
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return send(res, 200, {
          issuer: mock.issuer,
          authorization_endpoint: `${mock.issuer}/authorize`,
          token_endpoint: `${mock.issuer}/token`,
          jwks_uri: `${mock.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'profile', 'email'],
          authorization_response_iss_parameter_supported: true,
          ...(mock.behavior.discovery || {}),
        });
      }
      if (req.method === 'GET' && url.pathname === '/authorize') return authorize(req, res, url);
      if (req.method === 'POST' && url.pathname === '/token') return await token(req, res);
      if (req.method === 'GET' && url.pathname === '/jwks') {
        mock.jwksFetches++;
        const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
        return send(res, 200, { keys: mock.behavior.jwks || [jwk] });
      }
      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        return authorize(req, res, url, { github: true });
      }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        return await githubToken(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/user') return githubUserEndpoint(req, res);
      // For the client's own limits: a body that never ends, and one too big.
      if (url.pathname === '/slow') return; // never answers
      if (url.pathname === '/huge') return send(res, 200, { pad: 'x'.repeat(300 * 1024) });
      if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: `${mock.issuer}/.well-known/openid-configuration` });
        return res.end();
      }
      if (url.pathname === '/not-json') return send(res, 200, 'access_token=gho_very_secret_value');
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: String(e && e.message) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.issuer = `http://127.0.0.1:${server.address().port}`;
  mock.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return mock;
}

module.exports = { startMockOidc };
