// backend/lib/webauthn.js on its own, in this process: the CBOR reader, the
// authenticator-data parser, COSE keys, and both ceremonies' checks, fed by
// the software authenticator in tests/helpers/webauthn-authenticator.js.
// The end-to-end suite (passkeys.test.js) covers the same ground through
// the server; this one reaches the corners that are awkward from there.

const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const webauthn = require('../../backend/lib/webauthn');
const { SoftAuthenticator, cbor, coseKey, generateKey } = require('../helpers/webauthn-authenticator');

const ORIGIN = 'https://skilltrees.example';
const RP_ID = 'skilltrees.example';

const malformed = (fn, pattern) =>
  assert.throws(fn, (e) => e instanceof webauthn.WebAuthnError && e.kind === 'malformed' && pattern.test(e.message));
const refused = (fn, pattern) =>
  assert.throws(fn, (e) => e instanceof webauthn.WebAuthnError && e.kind === 'refused' && pattern.test(e.message));

describe('configuration', () => {
  test('no PUBLIC_ORIGIN means no passkeys', () => {
    const cfg = webauthn.configurePasskeys({});
    assert.equal(cfg.enabled, false);
    assert.match(cfg.note, /PUBLIC_ORIGIN is not set/);
  });

  test('the RP ID is the origin host, and the origin is kept exactly', () => {
    const cfg = webauthn.configurePasskeys({ PUBLIC_ORIGIN: 'https://skilltrees.example/' });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.rpId, 'skilltrees.example');
    assert.equal(cfg.origin, 'https://skilltrees.example');
    const local = webauthn.configurePasskeys({ PUBLIC_ORIGIN: 'http://localhost:3141' });
    assert.equal(local.rpId, 'localhost');
    assert.equal(local.origin, 'http://localhost:3141');
  });

  test('unusable origins leave passkeys off, saying why', () => {
    for (const PUBLIC_ORIGIN of ['not a url', 'http://skilltrees.example', 'https://x.example/app', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      const cfg = webauthn.configurePasskeys({ PUBLIC_ORIGIN });
      assert.equal(cfg.enabled, false, PUBLIC_ORIGIN);
      assert.match(cfg.note, /OFF/);
    }
    assert.match(webauthn.configurePasskeys({ PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }).note, /IP address/);
  });
});

describe('CBOR', () => {
  test('reads what authenticators write', () => {
    const value = new Map([
      [1, 2],
      [-1, 1],
      ['fmt', 'none'],
      ['bytes', Buffer.from([1, 2, 3])],
      ['list', [true, false, null, 0, 23, 24, 255, 256, 65535, 65536, 2 ** 32, -1, -25, -257]],
    ]);
    const decoded = webauthn.decodeCbor(cbor(value));
    assert.ok(decoded instanceof Map);
    assert.equal(decoded.get(1), 2);
    assert.equal(decoded.get(-1), 1);
    assert.equal(decoded.get('fmt'), 'none');
    assert.deepEqual(decoded.get('bytes'), Buffer.from([1, 2, 3]));
    assert.deepEqual(decoded.get('list'), [true, false, null, 0, 23, 24, 255, 256, 65535, 65536, 2 ** 32, -1, -25, -257]);
  });

  test('truncated input is refused, at every length', () => {
    const whole = cbor(new Map([['fmt', 'none'], ['authData', crypto.randomBytes(40)]]));
    for (let n = 0; n < whole.length; n++) {
      malformed(() => webauthn.decodeCbor(whole.subarray(0, n)), /truncated|longer than its input/);
    }
  });

  test('lengths far past the input cost nothing and are refused', () => {
    // A byte string, a text string, an array and a map each claiming 2^32-1
    // or 2^53-1 entries, followed by almost nothing.
    const huge = [
      Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff, 0x00]),
      Buffer.from([0x7a, 0xff, 0xff, 0xff, 0xff, 0x61]),
      Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff, 0x01]),
      Buffer.from([0xba, 0xff, 0xff, 0xff, 0xff, 0x01, 0x01]),
      Buffer.from([0x5b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]),
    ];
    for (const bytes of huge) malformed(() => webauthn.decodeCbor(bytes), /truncated|longer than its input/);
    // Beyond 2^53: not representable, so not accepted.
    malformed(() => webauthn.decodeCbor(Buffer.from([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), /too large/);
  });

  test('deep nesting is refused without recursing through all of it', () => {
    const deep = Buffer.concat([Buffer.alloc(100000, 0x81), Buffer.from([0x00])]); // [[[[...0...]]]]
    malformed(() => webauthn.decodeCbor(deep), /nested too deeply/);
    const deepMaps = Buffer.concat([Buffer.alloc(40000).fill(Buffer.from([0xa1, 0x00])), Buffer.from([0x00])]);
    malformed(() => webauthn.decodeCbor(deepMaps), /nested too deeply/);
    // Sixteen levels are fine.
    assert.ok(webauthn.decodeCbor(Buffer.concat([Buffer.alloc(15, 0x81), Buffer.from([0x00])])));
  });

  test('anything outside the CTAP2 subset is refused', () => {
    const cases = [
      [Buffer.from([0x5f, 0x41, 0x00, 0xff]), /indefinite/], // indefinite byte string
      [Buffer.from([0x9f, 0x00, 0xff]), /indefinite/], // indefinite array
      [Buffer.from([0xc2, 0x41, 0x01]), /tags/], // tag 2 (bignum)
      [Buffer.from([0xf9, 0x3c, 0x00]), /floats/], // half float 1.0
      [Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]), /floats/], // double
      [Buffer.from([0xf7]), /simple/], // undefined
      [Buffer.from([0x1c]), /reserved/], // additional info 28
      [Buffer.from([0xa2, 0x01, 0x00, 0x01, 0x00]), /repeats a key/],
      [Buffer.from([0xa1, 0x41, 0x00, 0x00]), /map key/], // byte-string key
      [Buffer.from([0x62, 0xc3, 0x28]), /UTF-8/], // invalid UTF-8
      [Buffer.from([0x00, 0x00]), /after its data item/],
    ];
    for (const [bytes, pattern] of cases) malformed(() => webauthn.decodeCbor(bytes), pattern);
  });

  test('random bytes never throw anything but a WebAuthnError', () => {
    for (let i = 0; i < 3000; i++) {
      const bytes = crypto.randomBytes(1 + (i % 64));
      try {
        webauthn.decodeCbor(bytes);
      } catch (e) {
        assert.ok(e instanceof webauthn.WebAuthnError, `${bytes.toString('hex')}: ${e.stack}`);
      }
    }
  });
});

describe('authenticator data', () => {
  const rpIdHash = crypto.createHash('sha256').update(RP_ID).digest();
  const count = Buffer.from([0, 0, 0, 7]);

  test('flags and counter are read', () => {
    const parsed = webauthn.parseAuthenticatorData(Buffer.concat([rpIdHash, Buffer.from([0x1d]), count]));
    assert.deepEqual(parsed.flags, { up: true, uv: true, be: true, bs: true, at: false, ed: false });
    assert.equal(parsed.signCount, 7);
    assert.equal(parsed.attested, null);
  });

  test('too short, trailing bytes, and flags that promise what is not there', () => {
    malformed(() => webauthn.parseAuthenticatorData(Buffer.alloc(36)), /shorter than 37/);
    malformed(() => webauthn.parseAuthenticatorData(Buffer.concat([rpIdHash, Buffer.from([0x05]), count, Buffer.from([0])])), /flags do not account/);
    malformed(() => webauthn.parseAuthenticatorData(Buffer.concat([rpIdHash, Buffer.from([0x45]), count])), /truncated/);
    malformed(() => webauthn.parseAuthenticatorData(Buffer.concat([rpIdHash, Buffer.from([0x85]), count])), /truncated/);
    // A credential ID longer than what follows it.
    const at = Buffer.concat([rpIdHash, Buffer.from([0x45]), count, Buffer.alloc(16), Buffer.from([0x04, 0x00]), Buffer.alloc(10)]);
    malformed(() => webauthn.parseAuthenticatorData(at), /runs past/);
  });

  test('attested credential data and extensions are read', () => {
    const { publicKey } = generateKey(-7);
    const credentialId = crypto.randomBytes(20);
    const len = Buffer.from([0, credentialId.length]);
    const aaguid = Buffer.from('ea9b8d664d011d213ce4b6b48cb575d4', 'hex');
    const data = Buffer.concat([rpIdHash, Buffer.from([0xc5]), count, aaguid, len, credentialId, cbor(coseKey(publicKey, -7)), cbor({ credProtect: 2 })]);
    const parsed = webauthn.parseAuthenticatorData(data);
    assert.equal(parsed.attested.aaguid, 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4');
    assert.deepEqual(parsed.attested.credentialId, credentialId);
    assert.equal(parsed.extensions.get('credProtect'), 2);
    assert.equal(webauthn.defaultName(parsed.attested.aaguid), 'Google Password Manager');
    assert.equal(webauthn.defaultName('00000000-0000-0000-0000-000000000000'), 'Passkey');
  });
});

describe('COSE keys', () => {
  test('ES256, EdDSA and RS256 load, and sign-verify round trips', () => {
    for (const alg of [-7, -8, -257]) {
      const { publicKey, privateKey } = generateKey(alg);
      const { key, spki } = webauthn.publicKeyFromCose(coseKey(publicKey, alg));
      assert.ok(Buffer.isBuffer(spki));
      const data = crypto.randomBytes(64);
      const sig = alg === -8 ? crypto.sign(null, data, privateKey) : crypto.sign('sha256', data, privateKey);
      assert.equal(webauthn.verifySignature(alg, key, data, sig), true, `alg ${alg}`);
      assert.equal(webauthn.verifySignature(alg, key, crypto.randomBytes(64), sig), false);
    }
  });

  test('ES256 signatures are DER, not raw r||s', () => {
    const { publicKey, privateKey } = generateKey(-7);
    const { key } = webauthn.publicKeyFromCose(coseKey(publicKey, -7));
    const data = Buffer.from('hello');
    const raw = crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    assert.equal(webauthn.verifySignature(-7, key, data, raw), false);
  });

  test('an algorithm must bring its own key type and curve', () => {
    const ec = generateKey(-7).publicKey;
    const ed = generateKey(-8).publicKey;
    const wrongAlg = coseKey(ec, -7);
    wrongAlg.set(3, -8);
    refused(() => webauthn.publicKeyFromCose(wrongAlg), /not an OKP Ed25519/);
    const wrongCurve = coseKey(ed, -8);
    wrongCurve.set(-1, 4); // X25519
    refused(() => webauthn.publicKeyFromCose(wrongCurve), /Ed25519/);
    refused(() => webauthn.publicKeyFromCose(coseKey(generateKey(-35).publicKey, -35)), /not one we asked for/);
    const noAlg = coseKey(ec, -7);
    noAlg.delete(3);
    refused(() => webauthn.publicKeyFromCose(noAlg), /no algorithm/);
    const offCurve = coseKey(ec, -7);
    offCurve.set(-3, Buffer.alloc(32, 1));
    refused(() => webauthn.publicKeyFromCose(offCurve), /not a valid key/);
    // An algorithm that wasn't asked for is refused even if supported.
    refused(() => webauthn.publicKeyFromCose(coseKey(ec, -7), [-8]), /not one we asked for/);
  });

  test('RSA keys under 2048 bits, or with an odd exponent, are refused', () => {
    refused(() => webauthn.publicKeyFromCose(coseKey(generateKey(-257, { rsaBits: 1024 }).publicKey, -257)), /1024 bits/);
    const e1 = coseKey(generateKey(-257).publicKey, -257);
    e1.set(-2, Buffer.from([1]));
    refused(() => webauthn.publicKeyFromCose(e1), /exponent/);
  });

  test('a stored key cannot be used under another algorithm', () => {
    const { publicKey, privateKey } = generateKey(-8);
    const { key } = webauthn.publicKeyFromCose(coseKey(publicKey, -8));
    const data = Buffer.from('x');
    const sig = crypto.sign(null, data, privateKey);
    assert.equal(webauthn.verifySignature(-7, key, data, sig), false);
    assert.equal(webauthn.verifySignature(-257, key, data, sig), false);
    assert.equal(webauthn.verifySignature(-35, key, data, sig), false);
  });
});

describe('the ceremonies', () => {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const creation = webauthn.creationOptions({
    rpId: RP_ID,
    challenge,
    userHandle: crypto.randomBytes(64).toString('base64url'),
    username: 'ada',
    exclude: [],
    timeoutMs: 300000,
  });
  const expected = { rpId: RP_ID, origin: ORIGIN };

  const register = (auth, knobs) => webauthn.verifyRegistration(webauthn.readRegistrationResponse(auth.create(creation, knobs)), expected);

  test('creation options are what the brief says', () => {
    assert.deepEqual(creation.pubKeyCredParams.map((p) => p.alg), [-8, -7, -257]);
    assert.equal(creation.authenticatorSelection.residentKey, 'required');
    assert.equal(creation.authenticatorSelection.userVerification, 'required');
    assert.equal(creation.attestation, 'none');
    assert.deepEqual(creation.extensions, { credProps: true });
    const request = webauthn.requestOptions({ rpId: RP_ID, challenge, timeoutMs: 300000 });
    assert.deepEqual(request.allowCredentials, []);
    assert.equal(request.userVerification, 'required');
  });

  test('registration and assertion round trip, for every algorithm', () => {
    for (const alg of [-7, -8, -257]) {
      const auth = new SoftAuthenticator({ origin: ORIGIN, counter: true });
      const stored = register(auth, { alg });
      assert.equal(stored.alg, alg);
      assert.equal(stored.signCount, 1);
      const request = webauthn.requestOptions({ rpId: RP_ID, challenge, timeoutMs: 1 });
      const credential = {
        publicKey: stored.publicKey,
        alg: stored.alg,
        signCount: stored.signCount,
        backupEligible: stored.backupEligible,
        userHandle: Buffer.from(creation.user.id, 'base64url'),
      };
      const result = webauthn.verifyAuthentication(webauthn.readAuthenticationResponse(auth.get(request)), { ...expected, credential });
      assert.equal(result.signCount, 2);
    }
  });

  test('registration refusals', () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    refused(() => register(auth, { type: 'webauthn.get' }), /type/);
    refused(() => register(auth, { origin: 'https://evil.example' }), /origin/);
    refused(() => register(auth, { origin: 'https://skilltrees.example.evil.example' }), /origin/);
    refused(() => register(auth, { crossOrigin: true }), /cross-origin/);
    refused(() => register(auth, { clientDataExtra: { topOrigin: 'https://evil.example' } }), /top origin/);
    refused(() => register(auth, { rpId: 'evil.example' }), /rpIdHash/);
    refused(() => register(auth, { up: false }), /UP/);
    refused(() => register(auth, { uv: false }), /UV/);
    refused(() => register(auth, { be: false, bs: true }), /BS/);
    refused(() => register(auth, { at: false }), /AT/);
    refused(() => register(auth, { fmt: 'none', attStmt: new Map([['sig', Buffer.alloc(8)]]) }), /none/);
    refused(() => register(auth, { clientExtensionResults: { credProps: { rk: false } } }), /discoverable/);
    const other = crypto.randomBytes(16).toString('base64url');
    // Over 1023 bytes, the most a credential ID may be: refused as the
    // browser reports it, and as the authenticator data carries it.
    malformed(() => register(auth, { credentialId: crypto.randomBytes(1024) }), /too long/);
    refused(() => register(auth, { credentialId: crypto.randomBytes(1024), idOverride: other, rawIdOverride: other }), /1024 bytes/);
    malformed(() => register(auth, { idOverride: other }), /differ/);
    refused(() => register(auth, { idOverride: other, rawIdOverride: other }), /differs from rawId/);
  });

  test('another attestation format is accepted, its statement unread', () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const stored = register(auth, { fmt: 'packed', attStmt: new Map([['alg', -7], ['sig', Buffer.alloc(70)]]) });
    assert.equal(stored.fmt, 'packed');
  });

  test('an automatic upgrade may come without UP and UV, and nothing else may', () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const response = webauthn.readRegistrationResponse(auth.create(creation, { up: false, uv: false }));
    const stored = webauthn.verifyRegistration(response, { ...expected, requireUserPresence: false, requireUserVerification: false });
    assert.equal(stored.userVerified, false);
  });

  test('the client data must be UTF-8 JSON with a challenge', () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    for (const clientDataJSON of [Buffer.from([0xff, 0xfe]), Buffer.from('not json'), Buffer.from('[]'), Buffer.from('{"type":"webauthn.create","origin":"x"}')]) {
      malformed(() => webauthn.readRegistrationResponse(auth.create(creation, { clientDataJSON })), /clientDataJSON/);
    }
  });

  test('base64url fields must be canonical and bounded', () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const good = auth.create(creation);
    const tweak = (fn) => {
      const copy = JSON.parse(JSON.stringify(good));
      fn(copy);
      return copy;
    };
    malformed(() => webauthn.readRegistrationResponse(tweak((c) => (c.response.clientDataJSON += '='))), /base64url/);
    malformed(() => webauthn.readRegistrationResponse(tweak((c) => (c.response.clientDataJSON = c.response.clientDataJSON.replace(/.$/, '+')))), /base64url/);
    malformed(() => webauthn.readRegistrationResponse(tweak((c) => (c.response.attestationObject = 'A'.repeat(200000)))), /too long/);
    malformed(() => webauthn.readRegistrationResponse(tweak((c) => (c.response.attestationObject = 42))), /base64url string/);
    malformed(() => webauthn.readRegistrationResponse(tweak((c) => (c.type = 'password'))), /public-key/);
    malformed(() => webauthn.readRegistrationResponse(tweak((c) => delete c.response)), /response/);
    // "AB" decodes to one byte that encodes back as "AA": not canonical.
    malformed(() => webauthn.fromB64url('AB', 'x', 10), /canonical/);
  });
});
