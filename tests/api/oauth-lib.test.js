// backend/lib/oauth.js on its own, in this process: the parts the end-to-end
// suite can't reach through one configured provider — GitHub's plain-OAuth
// shape, the limits on outbound requests, key rotation, and the signature
// algorithms other than RS256.

const test = require('node:test');
const { describe, before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const util = require('node:util');
const oauth = require('../../backend/lib/oauth');
const { startMockOidc } = require('../helpers/mock-oidc');

let mock;
before(async () => {
  mock = await startMockOidc();
});
after(async () => mock.stop());

describe('configuration', () => {
  const secret = 'shh-this-is-the-client-secret';

  test('nothing configured means no providers, and says so', () => {
    const { providers, notes } = oauth.configureProviders({});
    assert.equal(providers.size, 0);
    assert.match(notes.join('\n'), /none configured/);
  });

  test('no PUBLIC_ORIGIN, or an unusable one, turns every provider off', () => {
    for (const PUBLIC_ORIGIN of [undefined, 'not a url', 'http://skilltrees.example', 'https://x.example/app', 'https://u:p@x.example']) {
      const { providers, notes } = oauth.configureProviders({
        PUBLIC_ORIGIN,
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: secret,
      });
      assert.equal(providers.size, 0, String(PUBLIC_ORIGIN));
      assert.match(notes.join('\n'), /PUBLIC_ORIGIN/);
    }
  });

  test('a half-configured provider is off and the note names what is missing', () => {
    const { providers, notes } = oauth.configureProviders({
      PUBLIC_ORIGIN: 'https://skilltrees.example',
      GOOGLE_CLIENT_ID: 'id',
      OIDC_ISSUER: 'http://idp.example', // not https, not loopback
      OIDC_CLIENT_ID: 'id',
      OIDC_CLIENT_SECRET: secret,
    });
    assert.equal(providers.size, 0);
    const text = notes.join('\n');
    assert.match(text, /Google sign-in is OFF: GOOGLE_CLIENT_SECRET not set/);
    assert.match(text, /https/);
    assert.ok(!text.includes(secret));
  });

  test('a configured provider shows only its id and name, however it is printed', () => {
    const { providers, notes, publicOrigin } = oauth.configureProviders({
      PUBLIC_ORIGIN: 'https://skilltrees.example/',
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: secret,
      OIDC_ISSUER: mock.issuer,
      OIDC_CLIENT_ID: 'oidc-id',
      OIDC_CLIENT_SECRET: secret,
      OIDC_NAME: 'Company\x1b[2J SSO',
    });
    assert.equal(publicOrigin, 'https://skilltrees.example');
    const github = providers.get('github');
    assert.equal(github.redirectUri, 'https://skilltrees.example/api/auth/oauth/github/callback');
    assert.equal(JSON.stringify(github), '{"id":"github","name":"GitHub"}');
    assert.ok(!util.inspect(github, { depth: 5, showHidden: true }).includes(secret));
    assert.equal(providers.get('oidc').name, 'Company[2J SSO', 'control characters are stripped');
    assert.ok(!notes.join('\n').includes(secret));
  });
});

describe('URLs', () => {
  test('providers must be https, or http on loopback only', () => {
    assert.ok(oauth.providerUrl('https://idp.example/authorize', 'x'));
    assert.ok(oauth.providerUrl('http://localhost:9999/x', 'x'));
    assert.ok(oauth.providerUrl('http://127.0.0.1:9999/x', 'x'));
    assert.ok(oauth.providerUrl('http://[::1]:9999/x', 'x'));
    for (const bad of [
      'http://idp.example/authorize',
      'http://localhost.evil.example/x',
      'ftp://idp.example/',
      'javascript:alert(1)',
      'https://user:pass@idp.example/',
      'https://idp.example/authorize#frag',
      'not a url',
    ]) {
      assert.throws(() => oauth.providerUrl(bad, 'x'), oauth.OAuthError, bad);
    }
  });
});

describe('outbound requests', () => {
  test('are cut off at a deadline', async () => {
    await assert.rejects(
      oauth.fetchJson(`${mock.issuer}/slow`, {}, { timeoutMs: 200 }),
      (e) => e instanceof oauth.OAuthError && e.code === 'unavailable' && /timed out/.test(e.message)
    );
  });

  test('refuse a response over the size cap', async () => {
    await assert.rejects(
      oauth.fetchJson(`${mock.issuer}/huge`),
      (e) => e instanceof oauth.OAuthError && /larger than/.test(e.message)
    );
  });

  test('do not follow redirects', async () => {
    await assert.rejects(
      oauth.fetchJson(`${mock.issuer}/redirect`),
      (e) => e instanceof oauth.OAuthError && e.code === 'unavailable'
    );
  });

  test('never quote a non-JSON body into the error', async () => {
    await assert.rejects(oauth.fetchJson(`${mock.issuer}/not-json`), (e) => {
      assert.ok(e instanceof oauth.OAuthError);
      assert.ok(!e.message.includes('gho_very_secret_value'), e.message);
      return true;
    });
  });
});

describe('GitHub', () => {
  const redirectUri = 'https://skilltrees.example/api/auth/oauth/github/callback';

  function provider() {
    return new oauth.GitHubProvider({
      clientId: mock.clientId,
      clientSecret: mock.clientSecret,
      redirectUri,
      endpoints: {
        authorization_endpoint: `${mock.issuer}/login/oauth/authorize`,
        token_endpoint: `${mock.issuer}/login/oauth/access_token`,
        user_endpoint: `${mock.issuer}/user`,
      },
    });
  }

  async function codeFor(gh, verifier) {
    const url = await gh.authorizationUrl({ state: 's', codeChallenge: oauth.pkceChallenge(verifier) });
    const res = await fetch(url, { redirect: 'manual' });
    const back = new URL(res.headers.get('location'));
    assert.equal(back.searchParams.get('iss'), null, 'GitHub sends no iss');
    return back.searchParams.get('code');
  }

  test('code for token (client_secret_post, PKCE, JSON), then the numeric id', async () => {
    mock.reset();
    const gh = provider();
    const verifier = oauth.randomToken();
    const code = await codeFor(gh, verifier);
    const tokens = await gh.exchangeCode(code, verifier);
    const sent = mock.tokenRequests[mock.tokenRequests.length - 1];
    assert.equal(sent.auth, 'post');
    assert.equal(sent.pkce, 'ok');
    assert.equal(sent.redirect_uri, redirectUri);
    assert.match(sent.accept, /application\/json/);
    assert.ok(sent.userAgent);

    const identity = await gh.identify(tokens);
    assert.deepEqual(identity, {
      issuer: 'https://github.com',
      subject: '4242',
      displayName: 'octo-cat',
      usernameHint: 'octo-cat',
    });
  });

  test('an error answered with a 200 is still an error', async () => {
    mock.reset();
    const gh = provider();
    await assert.rejects(gh.exchangeCode('no-such-code', oauth.randomToken()), (e) => {
      assert.equal(e.code, 'failed');
      assert.match(e.message, /bad_verification_code/);
      return true;
    });
  });

  test('a profile without a numeric id is refused', async () => {
    mock.reset();
    mock.set({ githubUser: { id: 'not-a-number' } });
    const gh = provider();
    const verifier = oauth.randomToken();
    const tokens = await gh.exchangeCode(await codeFor(gh, verifier), verifier);
    await assert.rejects(gh.identify(tokens), /no numeric id/);
  });
});

describe('signing keys', () => {
  function jwks(...entries) {
    return entries.map(([kid, key]) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig' }));
  }

  test('an unknown kid refetches the key set, once per cooldown', async () => {
    const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    mock.reset();
    const eager = new oauth.KeySet(`${mock.issuer}/jwks`, { cooldownMs: 0 });
    const patient = new oauth.KeySet(`${mock.issuer}/jwks`, { cooldownMs: 60 * 1000 });
    assert.ok(await eager.keyFor(mock.kid, 'RS256'));
    assert.ok(await patient.keyFor(mock.kid, 'RS256'));

    // The provider rotates to a new key.
    mock.set({ jwks: jwks(['rotated', rotated.publicKey]) });
    const before = mock.jwksFetches;
    assert.ok(await eager.keyFor('rotated', 'RS256'), 'found after a refetch');
    assert.equal(mock.jwksFetches, before + 1);
    assert.equal(await patient.keyFor('rotated', 'RS256'), null, 'inside the cooldown');
    assert.equal(mock.jwksFetches, before + 1, 'and no request was made');
  });

  test('keys are matched to the algorithm, and weak RSA is refused', async () => {
    const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    mock.reset();
    mock.set({ jwks: jwks(['small', small.publicKey], ['ec', ec.publicKey]) });
    const keys = new oauth.KeySet(`${mock.issuer}/jwks`, { cooldownMs: 0 });
    assert.equal(await keys.keyFor('small', 'RS256'), null, '1024-bit RSA');
    assert.equal(await keys.keyFor('ec', 'RS256'), null, 'an EC key for RS256');
    assert.ok(await keys.keyFor('ec', 'ES256'));
  });
});

describe('ID tokens under other algorithms', () => {
  const clientId = 'client';
  const issuer = 'https://idp.example';

  function sign(alg, privateKey, claims, extraHeader = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg, kid: 'k', ...extraHeader })).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({ iss: issuer, aud: clientId, sub: 'someone', iat: now, exp: now + 60, nonce: 'n', ...claims })
    ).toString('base64url');
    const input = Buffer.from(`${h}.${p}`);
    let sig;
    if (alg === 'ES256') sig = crypto.sign('sha256', input, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    else if (alg === 'PS256') {
      sig = crypto.sign('sha256', input, {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      });
    } else if (alg === 'EdDSA') sig = crypto.sign(null, input, privateKey);
    else sig = crypto.sign('sha256', input, privateKey);
    return `${h}.${p}.${sig.toString('base64url')}`;
  }

  const keysOf = (publicKey) => ({ keyFor: async () => publicKey });
  const verify = (token, publicKey, extra = {}) =>
    oauth.verifyIdToken(token, { keys: keysOf(publicKey), issuers: [issuer], clientId, nonce: 'n', ...extra });

  for (const [alg, type, options] of [
    ['ES256', 'ec', { namedCurve: 'P-256' }],
    ['PS256', 'rsa', { modulusLength: 2048 }],
    ['EdDSA', 'ed25519', {}],
    ['RS256', 'rsa', { modulusLength: 2048 }],
  ]) {
    test(`${alg} verifies, and fails once tampered`, async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync(type, options);
      const token = sign(alg, privateKey, {});
      const claims = await verify(token, publicKey);
      assert.equal(claims.sub, 'someone');
      const [h, , s] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ iss: issuer, aud: clientId, sub: 'admin' })).toString('base64url');
      await assert.rejects(verify(`${h}.${forged}.${s}`, publicKey), /signature does not verify/);
    });
  }

  test('azp must name this client when present', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await assert.rejects(verify(sign('RS256', privateKey, { azp: 'other' }), publicKey), /azp/);
    const ok = await verify(sign('RS256', privateKey, { aud: [clientId, 'other'], azp: clientId }), publicKey);
    assert.equal(ok.sub, 'someone');
  });

  test('critical header extensions and odd subjects are refused', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await assert.rejects(verify(sign('RS256', privateKey, {}, { crit: ['b64'] }), publicKey), /critical/);
    await assert.rejects(verify(sign('RS256', privateKey, { sub: '' }), publicKey), /subject/);
    await assert.rejects(verify(sign('RS256', privateKey, { sub: 'a\nb' }), publicKey), /subject/);
    await assert.rejects(verify(sign('RS256', privateKey, { sub: 'x'.repeat(256) }), publicKey), /subject/);
  });

  test('an alias is honoured only where one is configured', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = sign('RS256', privateKey, { iss: 'idp.example' });
    await assert.rejects(verify(token, publicKey), /issued by someone else/);
    const claims = await verify(token, publicKey, { issuers: [issuer, 'idp.example'] });
    assert.equal(claims.iss, 'idp.example');
  });
});
