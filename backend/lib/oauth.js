// Signing in through another provider: this site as an OAuth 2.0 client and
// an OpenID Connect relying party, built on node:crypto and the global fetch
// so the zero-dependency property holds here too.
//
// What it follows, and where each rule comes from:
//   - RFC 9700 (OAuth 2.0 Security BCP) and the OAuth 2.1 draft: the
//     authorization code grant and nothing else, always with PKCE, and a
//     redirect URI compared exactly.
//   - RFC 7636 PKCE, S256 only. "plain" sends the verifier itself through the
//     browser, which is the thing PKCE exists to keep out of it.
//   - RFC 9207: the `iss` authorization-response parameter, against mix-up.
//   - OpenID Connect Core 1.0 §3.1.3.7: ID token validation, and the nonce.
//   - OpenID Connect Discovery 1.0 (and RFC 8414 for its field names).
//
// This file only talks to providers. It never touches the database, the
// session or the HTTP layer: server.js owns the flow state, the browser
// binding and the accounts, next to the password sign-in they sit beside.

const crypto = require('node:crypto');
const { hasControlChars } = require('./text');

// Every outbound request gets a deadline and a size cap. A provider that
// hangs, or answers with an endless body, would otherwise hold a request —
// and its memory — for as long as it liked.
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;

// Discovery documents and key sets change rarely; an hour is the usual cache.
// A failed refresh keeps serving the copy it has, retrying a minute later.
const METADATA_TTL_MS = 60 * 60 * 1000;
const METADATA_RETRY_MS = 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
// An ID token signed with a key we have not seen is how a provider's key
// rotation looks, so an unknown `kid` triggers a refetch — but at most one
// per cooldown. Otherwise anyone able to hand us tokens with made-up kids
// could make every callback a request to the provider's key endpoint.
const JWKS_COOLDOWN_MS = 30 * 1000;

// Clock skew allowed on exp/iat/nbf, and how old an ID token may be. The token
// is fetched moments before it is checked, so anything much older was not
// minted for this exchange.
const CLOCK_SKEW_SEC = 60;
const MAX_ID_TOKEN_AGE_SEC = 10 * 60;
const MAX_ID_TOKEN_LENGTH = 16 * 1024;

// GitHub refuses API requests without one.
const USER_AGENT = 'SkillTrees-OAuth-Client';

// The failure codes the browser may be told. Anything the provider said stays
// in the server log; the page only ever sees one of these.
const ERROR_CODES = ['cancelled', 'expired', 'failed', 'unavailable', 'identity_taken', 'link_session'];

class OAuthError extends Error {
  // `code` is for the browser (one of ERROR_CODES); `message` is for the
  // server log, and must never carry a secret, a token or a provider's text
  // other than a short error code.
  constructor(code, message) {
    super(message);
    this.code = ERROR_CODES.includes(code) ? code : 'failed';
  }
}

// ---------- small pieces ----------

// 256 bits, base64url. Used for state, the browser binding, the nonce and the
// PKCE verifier: 43 characters, inside the 43-128 RFC 7636 §4.1 asks for.
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// RFC 7636 §4.2, S256: BASE64URL(SHA256(ASCII(code_verifier))).
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// Constant-time equality for strings of any length: hashing first gives both
// sides the same length, so neither the contents nor the length leak.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Every URL a provider gives us, and the configured ones, must be https —
// plain http would put codes, tokens and client secrets on the wire in the
// clear. Loopback http is the one exception (RFC 8252 §7.3 makes the same
// one), so a provider running on this machine — the test suite's mock — works.
function providerUrl(value, what) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError('unavailable', `${what} is not a URL`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new OAuthError('unavailable', `${what} must be an https URL`);
  }
  // Credentials in a URL end up in logs; a fragment is not allowed on an
  // endpoint URI (RFC 6749 §3.1).
  if (url.username || url.password || url.hash) {
    throw new OAuthError('unavailable', `${what} must not carry credentials or a fragment`);
  }
  return url;
}

// PUBLIC_ORIGIN is the only thing the redirect_uri is built from. Building it
// from the request's Host header instead would let whoever sends the request
// choose where the provider delivers the code (Host-header injection).
// Returns { origin } or { problem }.
function parsePublicOrigin(value) {
  if (!value) return { problem: 'PUBLIC_ORIGIN is not set' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { problem: 'PUBLIC_ORIGIN is not a URL' };
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { problem: 'PUBLIC_ORIGIN must be https (http is accepted for localhost only)' };
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return { problem: 'PUBLIC_ORIGIN must be an origin only, like https://skilltrees.example' };
  }
  return { origin: url.origin };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'provider';
  }
}

// Reads a response body, refusing to hold more than maxBytes of it.
async function readCapped(res, maxBytes, url) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new OAuthError('failed', `${hostOf(url)} sent a response larger than ${maxBytes} bytes`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new OAuthError('failed', `${hostOf(url)} sent a response larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof OAuthError) throw e;
    throw new OAuthError('unavailable', `${hostOf(url)} stopped answering mid-response`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// fetch() with a deadline, a size cap, no redirects, and JSON or nothing.
// Redirects are refused because every URL here was checked before it was
// used; following a 3xx would take the request somewhere that was not.
async function fetchJson(url, init = {}, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? 'timed out' : 'network error';
    throw new OAuthError('unavailable', `could not reach ${hostOf(url)} (${why})`);
  }
  const text = await readCapped(res, maxBytes, url);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the text it choked on, and a token
    // endpoint's text is exactly what must never reach a log.
    throw new OAuthError('failed', `${hostOf(url)} answered ${res.status} with something other than JSON`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new OAuthError('failed', `${hostOf(url)} answered ${res.status} with something other than a JSON object`);
  }
  return { status: res.status, data };
}

function str(value, max = 200) {
  return typeof value === 'string' && value.length <= max && !hasControlChars(value) ? value : '';
}

// ---------- signing keys (JWKS) ----------

// Algorithms an ID token may be signed with. An allowlist, and only
// asymmetric ones: "none" would accept any token at all, and HS256 with a
// public key as its "secret" is the classic confusion that lets anyone who
// can read the key set mint tokens. Each entry also says which key type it
// may be used with, so an RSA key can't be pressed into service as anything
// else.
const ALGORITHMS = {
  RS256: {
    digest: 'sha256',
    fits: (k) => k.asymmetricKeyType === 'rsa' && k.asymmetricKeyDetails.modulusLength >= 2048,
    key: (k) => k,
  },
  PS256: {
    digest: 'sha256',
    fits: (k) =>
      (k.asymmetricKeyType === 'rsa' || k.asymmetricKeyType === 'rsa-pss') &&
      k.asymmetricKeyDetails.modulusLength >= 2048,
    key: (k) => ({ key: k, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }),
  },
  ES256: {
    digest: 'sha256',
    fits: (k) => k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails.namedCurve === 'prime256v1',
    // JWS carries ECDSA signatures as the raw r||s pair (RFC 7518 §3.4), not
    // the DER node:crypto expects by default.
    key: (k) => ({ key: k, dsaEncoding: 'ieee-p1363' }),
  },
  EdDSA: {
    digest: null,
    fits: (k) => k.asymmetricKeyType === 'ed25519',
    key: (k) => k,
  },
};

// Only the public members, so a provider that mistakenly publishes a private
// JWK doesn't have its private half imported here.
function publicJwk(jwk) {
  if (jwk.kty === 'RSA') return { kty: 'RSA', n: jwk.n, e: jwk.e };
  if (jwk.kty === 'EC') return { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
  if (jwk.kty === 'OKP') return { kty: 'OKP', crv: jwk.crv, x: jwk.x };
  return null;
}

class KeySet {
  #uri;
  #keys = [];
  #fetchedAt = 0; // last success
  #attemptedAt = 0; // last try, successful or not
  #pending = null;

  constructor(uri, { cooldownMs = JWKS_COOLDOWN_MS } = {}) {
    this.#uri = uri;
    this.cooldownMs = cooldownMs;
  }

  get uri() {
    return this.#uri;
  }

  // The key an ID token with this header should verify under, or null.
  async keyFor(kid, alg) {
    if (!this.#fetchedAt || Date.now() - this.#fetchedAt > JWKS_TTL_MS) {
      await this.#refresh();
    }
    let key = this.#find(kid, alg);
    if (!key && Date.now() - this.#attemptedAt >= this.cooldownMs) {
      await this.#refresh();
      key = this.#find(kid, alg);
    }
    return key;
  }

  #find(kid, alg) {
    const spec = ALGORITHMS[alg];
    const usable = this.#keys.filter((k) => (!k.alg || k.alg === alg) && spec.fits(k.key));
    if (typeof kid === 'string') {
      const match = usable.find((k) => k.kid === kid);
      return match ? match.key : null;
    }
    // No kid in the token: only unambiguous when there is exactly one
    // candidate. Guessing among several would verify against whichever key
    // happened to come first.
    return usable.length === 1 ? usable[0].key : null;
  }

  async #refresh() {
    if (!this.#pending) {
      this.#attemptedAt = Date.now();
      this.#pending = this.#load()
        .then((keys) => {
          this.#keys = keys;
          this.#fetchedAt = Date.now();
        })
        .catch((err) => {
          // A stale key set is still the provider's key set; carry on with
          // it. With nothing cached there is nothing to verify against.
          if (!this.#keys.length) throw err;
        })
        .finally(() => {
          this.#pending = null;
        });
    }
    return this.#pending;
  }

  async #load() {
    const { status, data } = await fetchJson(this.#uri, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (status !== 200 || !Array.isArray(data.keys)) {
      throw new OAuthError('unavailable', `key set at ${hostOf(this.#uri)} answered ${status}`);
    }
    const keys = [];
    for (const jwk of data.keys.slice(0, 50)) {
      if (!jwk || typeof jwk !== 'object') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) {
        continue;
      }
      const pub = publicJwk(jwk);
      if (!pub) continue;
      try {
        keys.push({
          kid: typeof jwk.kid === 'string' ? jwk.kid : undefined,
          alg: typeof jwk.alg === 'string' ? jwk.alg : undefined,
          key: crypto.createPublicKey({ key: pub, format: 'jwk' }),
        });
      } catch {
        // A key node:crypto can't read is a key nothing will verify under.
      }
    }
    return keys;
  }
}

// ---------- ID tokens ----------

function decodeSegment(segment, what) {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* falls through */
  }
  throw new OAuthError('failed', `ID token ${what} is not a JSON object`);
}

// OpenID Connect Core §3.1.3.7, in order. `issuers` is normally just the
// one; see the Google provider for the only exception.
async function verifyIdToken(idToken, { keys, issuers, clientId, nonce, now = Math.floor(Date.now() / 1000) }) {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
    throw new OAuthError('failed', 'token response carried no usable id_token');
  }
  const parts = idToken.split('.');
  // Exactly three non-empty base64url parts: a JWS in compact form. Buffer's
  // base64url decoder skips characters it doesn't know, so the charset is
  // checked here rather than trusted to it.
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    throw new OAuthError('failed', 'ID token is not a signed JWT');
  }
  const header = decodeSegment(parts[0], 'header');
  if (typeof header.alg !== 'string' || !Object.hasOwn(ALGORITHMS, header.alg)) {
    throw new OAuthError('failed', `ID token alg ${String(header.alg).slice(0, 10)} is not allowed`);
  }
  // RFC 7515 §4.1.11: extensions we don't understand must not be ignored.
  if (header.crit !== undefined) {
    throw new OAuthError('failed', 'ID token uses critical header extensions');
  }

  const key = await keys.keyFor(header.kid, header.alg);
  if (!key) throw new OAuthError('failed', 'ID token is signed with a key the provider does not publish');
  const spec = ALGORITHMS[header.alg];
  let valid = false;
  try {
    valid = crypto.verify(
      spec.digest,
      Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
      spec.key(key),
      Buffer.from(parts[2], 'base64url')
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new OAuthError('failed', 'ID token signature does not verify');

  const claims = decodeSegment(parts[1], 'payload');

  // The issuer, exactly — not a prefix, not normalised.
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) {
    throw new OAuthError('failed', 'ID token was issued by someone else');
  }
  // Minted for this client. With several audiences the token must also name
  // this client as the party it was issued to (azp), or a token minted for
  // another app that merely lists this one could be replayed here.
  const aud = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!aud.includes(clientId)) throw new OAuthError('failed', 'ID token is for another client');
  if (aud.length > 1 && claims.azp !== clientId) {
    throw new OAuthError('failed', 'ID token has several audiences and no azp for this client');
  }
  if (claims.azp !== undefined && claims.azp !== clientId) {
    throw new OAuthError('failed', 'ID token was issued to another party (azp)');
  }
  if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_SEC <= now) {
    throw new OAuthError('failed', 'ID token has expired');
  }
  if (
    !Number.isFinite(claims.iat) ||
    claims.iat > now + CLOCK_SKEW_SEC ||
    claims.iat < now - MAX_ID_TOKEN_AGE_SEC - CLOCK_SKEW_SEC
  ) {
    throw new OAuthError('failed', 'ID token was not issued just now (iat)');
  }
  if (claims.nbf !== undefined && !(Number.isFinite(claims.nbf) && claims.nbf <= now + CLOCK_SKEW_SEC)) {
    throw new OAuthError('failed', 'ID token is not valid yet (nbf)');
  }
  // The nonce ties this token to the flow this browser started (§3.1.2.1):
  // a token captured from another sign-in carries another nonce.
  if (typeof claims.nonce !== 'string' || typeof nonce !== 'string' || !safeEqual(claims.nonce, nonce)) {
    throw new OAuthError('failed', 'ID token nonce does not match this sign-in');
  }
  // §2: sub is at most 255 ASCII characters. Anything else is not an
  // identifier we are prepared to key an account on.
  if (typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) {
    throw new OAuthError('failed', 'ID token has no usable subject');
  }
  return claims;
}

// ---------- providers ----------

class Provider {
  // Private, so it can't be serialised or printed by accident: toJSON and
  // util.inspect never see a #field.
  #clientSecret;

  constructor({ id, name, clientId, clientSecret, redirectUri }) {
    this.id = id;
    this.name = name;
    this.clientId = clientId;
    this.#clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  // What the browser may know about a provider. Nothing else.
  toJSON() {
    return { id: this.id, name: this.name };
  }

  // The authorization request (RFC 6749 §4.1.1 + RFC 7636 §4.3 + OIDC §3.1.2.1).
  async authorizationUrl({ state, codeChallenge, nonce }) {
    const meta = await this.metadata();
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    if (this.scope) url.searchParams.set('scope', this.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (nonce) url.searchParams.set('nonce', nonce);
    return url.href;
  }

  // The token request (RFC 6749 §4.1.3), with the PKCE verifier and exactly
  // the redirect_uri the authorization request used.
  async exchangeCode(code, codeVerifier) {
    const meta = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    });
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (meta.authMethod === 'client_secret_basic') {
      // RFC 6749 §2.3.1: each half is form-encoded before the base64 —
      // which is not what encodeURIComponent does with spaces and !'()*.
      const enc = (v) => new URLSearchParams({ v }).toString().slice(2);
      headers.Authorization =
        'Basic ' + Buffer.from(`${enc(this.clientId)}:${enc(this.#clientSecret)}`).toString('base64');
    } else {
      body.set('client_id', this.clientId);
      body.set('client_secret', this.#clientSecret);
    }
    const { status, data } = await fetchJson(meta.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    // GitHub reports errors with a 200 and an `error` member, so both count.
    if (status !== 200 || data.error !== undefined) {
      const why = str(data.error, 40);
      throw new OAuthError('failed', `token endpoint refused the code (${status}${why ? ' ' + why : ''})`);
    }
    if (typeof data.access_token !== 'string' || data.access_token === '') {
      throw new OAuthError('failed', 'token endpoint sent no access token');
    }
    if (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer') {
      throw new OAuthError('failed', 'token endpoint sent a token type other than Bearer');
    }
    return data;
  }
}

// GitHub is OAuth 2.0 without OpenID Connect: no discovery, no ID token.
// Who someone is comes from GET /user, and it is the numeric `id` — stable
// for the life of the account — not `login`, which its owner can rename and
// someone else can then register.
const GITHUB_ENDPOINTS = {
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
  user_endpoint: 'https://api.github.com/user',
};

class GitHubProvider extends Provider {
  constructor(options) {
    super({ id: 'github', name: 'GitHub', ...options });
    this.kind = 'oauth';
    // GitHub has no issuer identifier of its own; this one names it in
    // user_identities and is what an `iss` on its callback would have to say.
    this.issuer = 'https://github.com';
    // No scope at all: GitHub then grants read access to public profile
    // information and nothing more, which is all a sign-in needs.
    this.scope = '';
    const endpoints = { ...GITHUB_ENDPOINTS, ...(options.endpoints || {}) };
    for (const [name, value] of Object.entries(endpoints)) providerUrl(value, `GitHub ${name}`);
    this.meta = {
      ...endpoints,
      // GitHub doesn't send `iss` (RFC 9207) and has no metadata saying it
      // would; the per-provider callback path is its mix-up defence instead.
      issParameterSupported: false,
      authMethod: 'client_secret_post',
    };
  }

  async metadata() {
    return this.meta;
  }

  async identify(tokens) {
    const { status, data } = await fetchJson(this.meta.user_endpoint, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    });
    if (status !== 200) throw new OAuthError('failed', `GitHub /user answered ${status}`);
    if (!Number.isSafeInteger(data.id) || data.id <= 0) {
      throw new OAuthError('failed', 'GitHub /user returned no numeric id');
    }
    const login = str(data.login, 39);
    return {
      issuer: this.issuer,
      subject: String(data.id),
      displayName: login,
      usernameHint: login,
    };
  }
}

// Any OpenID Connect provider, found through its discovery document.
class OidcProvider extends Provider {
  #meta = null;
  #metaAt = 0;
  #pending = null;
  #keys = null;

  constructor({ issuer, issuerAliases = [], ...options }) {
    super(options);
    this.kind = 'oidc';
    providerUrl(issuer, `${options.name} issuer`);
    this.issuer = issuer;
    this.issuerAliases = issuerAliases;
    // openid for the ID token; profile and email only to suggest a username
    // for a new account. The address is never used to find or link one.
    this.scope = 'openid profile email';
  }

  // OIDC Discovery §4, cached. Stale beats nothing: if a refresh fails, the
  // last good document keeps working and the next try is a minute away.
  async metadata() {
    if (this.#meta && Date.now() - this.#metaAt < METADATA_TTL_MS) return this.#meta;
    if (!this.#pending) {
      this.#pending = this.#discover()
        .then((meta) => {
          this.#meta = meta;
          this.#metaAt = Date.now();
          // A new key set only when the document points somewhere new, so a
          // routine refresh keeps the keys (and the refetch cooldown) it has.
          if (!this.#keys || this.#keys.uri !== meta.jwks_uri) this.#keys = new KeySet(meta.jwks_uri);
          return meta;
        })
        .catch((err) => {
          if (!this.#meta) throw err;
          this.#metaAt = Date.now() - METADATA_TTL_MS + METADATA_RETRY_MS;
          return this.#meta;
        })
        .finally(() => {
          this.#pending = null;
        });
    }
    return this.#pending;
  }

  async #discover() {
    // §4.1: a trailing slash on the issuer is removed before appending.
    const base = this.issuer.endsWith('/') ? this.issuer.slice(0, -1) : this.issuer;
    const where = `${base}/.well-known/openid-configuration`;
    const { status, data } = await fetchJson(where, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (status !== 200) throw new OAuthError('unavailable', `discovery at ${hostOf(where)} answered ${status}`);
    // §4.3: the document must name exactly the issuer it was fetched for.
    // Otherwise one provider's document could point this client at another.
    if (data.issuer !== this.issuer) {
      throw new OAuthError(
        'unavailable',
        `discovery document names issuer "${str(data.issuer, 200)}", configured "${this.issuer}" — they must match exactly`
      );
    }
    const list = (v) => (Array.isArray(v) ? v : null);
    const responseTypes = list(data.response_types_supported);
    if (responseTypes && !responseTypes.includes('code')) {
      throw new OAuthError('unavailable', 'provider does not offer the authorization code flow');
    }
    // RFC 9700 §2.1.1: a provider that says which PKCE methods it supports
    // and leaves out S256 can't be used safely, so it isn't used at all.
    const pkce = list(data.code_challenge_methods_supported);
    if (pkce && !pkce.includes('S256')) {
      throw new OAuthError('unavailable', 'provider does not support PKCE with S256');
    }
    // Client authentication: client_secret_basic is the default when the
    // provider doesn't say (OIDC Discovery §3); _post if that's all it offers.
    const authMethods = list(data.token_endpoint_auth_methods_supported) || ['client_secret_basic'];
    const authMethod = authMethods.includes('client_secret_basic')
      ? 'client_secret_basic'
      : authMethods.includes('client_secret_post')
        ? 'client_secret_post'
        : null;
    if (!authMethod) throw new OAuthError('unavailable', 'provider supports no client-secret authentication');

    return {
      issuer: data.issuer,
      authorization_endpoint: providerUrl(data.authorization_endpoint, 'authorization_endpoint').href,
      token_endpoint: providerUrl(data.token_endpoint, 'token_endpoint').href,
      jwks_uri: providerUrl(data.jwks_uri, 'jwks_uri').href,
      issParameterSupported: data.authorization_response_iss_parameter_supported === true,
      authMethod,
    };
  }

  async identify(tokens, { nonce }) {
    await this.metadata();
    const claims = await verifyIdToken(tokens.id_token, {
      keys: this.#keys,
      issuers: [this.issuer, ...this.issuerAliases],
      clientId: this.clientId,
      nonce,
    });
    const preferred = str(claims.preferred_username);
    const email = str(claims.email);
    const name = str(claims.name);
    return {
      // Always the configured issuer, even when the token used an alias, so
      // one account at the provider is one row here.
      issuer: this.issuer,
      subject: claims.sub,
      displayName: preferred || email || name,
      usernameHint: preferred || email || name,
    };
  }
}

// ---------- configuration ----------

// Reads the environment and returns the providers that are fully configured,
// plus a line for the startup log about each one that is or isn't — the
// secrets themselves are never part of those lines.
function configureProviders(env) {
  const notes = [];
  const providers = new Map();

  const wanted = {
    github: env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_SECRET,
    google: env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET,
    oidc: env.OIDC_ISSUER || env.OIDC_CLIENT_ID || env.OIDC_CLIENT_SECRET,
  };
  if (!Object.values(wanted).some(Boolean)) {
    notes.push('Sign-in with GitHub, Google or SSO: off (none configured; see .env.example).');
    return { providers, publicOrigin: null, notes };
  }

  const { origin, problem } = parsePublicOrigin(env.PUBLIC_ORIGIN);
  if (!origin) {
    notes.push(`Sign-in with other providers is OFF: ${problem}. Every redirect URI is built from it.`);
    return { providers, publicOrigin: null, notes };
  }

  const callback = (id) => `${origin}/api/auth/oauth/${id}/callback`;
  const missing = (...names) => names.filter((n) => !env[n]);
  const add = (make, label, vars) => {
    const lacking = missing(...vars);
    if (lacking.length) {
      notes.push(`${label} sign-in is OFF: ${lacking.join(' and ')} not set.`);
      return;
    }
    try {
      const provider = make();
      providers.set(provider.id, provider);
      notes.push(`${provider.name} sign-in is on. Register this callback URL with it: ${callback(provider.id)}`);
    } catch (e) {
      notes.push(`${label} sign-in is OFF: ${e.message}.`);
    }
  };

  if (wanted.github) {
    add(
      () =>
        new GitHubProvider({
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
          redirectUri: callback('github'),
        }),
      'GitHub',
      ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']
    );
  }
  if (wanted.google) {
    add(
      () =>
        new OidcProvider({
          id: 'google',
          name: 'Google',
          issuer: 'https://accounts.google.com',
          // Google documents both spellings for the iss of its ID tokens
          // ("https://accounts.google.com or accounts.google.com"); this is
          // the one provider-specific allowance in the validation.
          issuerAliases: ['accounts.google.com'],
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          redirectUri: callback('google'),
        }),
      'Google',
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
    );
  }
  if (wanted.oidc) {
    const name = String(env.OIDC_NAME || '')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .slice(0, 40);
    add(
      () =>
        new OidcProvider({
          id: 'oidc',
          name: name || 'Single sign-on',
          issuer: env.OIDC_ISSUER,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
          redirectUri: callback('oidc'),
        }),
      name || 'OIDC',
      ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']
    );
  }

  return { providers, publicOrigin: origin, notes };
}

module.exports = {
  configureProviders,
  parsePublicOrigin,
  providerUrl,
  fetchJson,
  randomToken,
  pkceChallenge,
  safeEqual,
  verifyIdToken,
  KeySet,
  GitHubProvider,
  OidcProvider,
  OAuthError,
  ERROR_CODES,
};
