// A software authenticator for the passkey tests, standing in for both the
// browser and the authenticator behind it: it takes the options JSON the
// server hands out and returns the JSON that credential.toJSON() would —
// clientDataJSON, authenticator data, a CBOR attestation object with
// fmt "none", and signed assertions. Zero dependencies: keys come from
// crypto.generateKeyPairSync, and the CBOR is encoded here by hand.
//
//   const auth = new SoftAuthenticator({ origin: 'https://skilltrees.test' });
//   const credential = auth.create(creationOptionsJSON);          // registration
//   const assertion = auth.get(requestOptionsJSON);               // sign-in
//
// Both take knobs that make it misbehave, one field at a time, which is the
// point of it: wrong origin, rpId, type or challenge; UP or UV missing; a
// chosen counter; another user handle; a bad signature; a different
// algorithm, attestation format or credential ID; raw bytes in place of any
// part.

const crypto = require('node:crypto');

// ---------- CBOR (RFC 8949), encoding only ----------

// Bytes to splice in exactly as given, for building malformed input.
class RawCbor {
  constructor(bytes) {
    this.bytes = Buffer.from(bytes);
  }
}

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

function cbor(value) {
  if (value instanceof RawCbor) return value.bytes;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}
cbor.raw = (bytes) => new RawCbor(bytes);
cbor.head = head;

// ---------- keys ----------

const b64 = (s) => Buffer.from(s, 'base64url');

function generateKey(alg, { rsaBits = 2048 } = {}) {
  if (alg === -7) return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  if (alg === -35) return crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  if (alg === -8) return crypto.generateKeyPairSync('ed25519');
  if (alg === -257) return crypto.generateKeyPairSync('rsa', { modulusLength: rsaBits });
  throw new Error(`no key type for COSE alg ${alg}`);
}

// COSE_Key (RFC 9052 §7, RFC 9053, RFC 8230) for a public key.
function coseKey(publicKey, alg) {
  const jwk = publicKey.export({ format: 'jwk' });
  if (alg === -7) return new Map([[1, 2], [3, -7], [-1, 1], [-2, b64(jwk.x)], [-3, b64(jwk.y)]]);
  if (alg === -35) return new Map([[1, 2], [3, -35], [-1, 2], [-2, b64(jwk.x)], [-3, b64(jwk.y)]]);
  if (alg === -8) return new Map([[1, 1], [3, -8], [-1, 6], [-2, b64(jwk.x)]]);
  if (alg === -257) return new Map([[1, 3], [3, -257], [-1, b64(jwk.n)], [-2, b64(jwk.e)]]);
  throw new Error(`no COSE key for alg ${alg}`);
}

// WebAuthn signatures: ES256 as ASN.1 DER, Ed25519 raw, RS256 PKCS#1 v1.5.
function sign(alg, privateKey, data) {
  if (alg === -8) return crypto.sign(null, data, privateKey);
  if (alg === -35) return crypto.sign('sha384', data, privateKey);
  return crypto.sign('sha256', data, privateKey);
}

// ---------- authenticator data (WebAuthn §6.1) ----------

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

function flagsByte({ up = true, uv = true, be = false, bs = false, at = false, ed = false }) {
  return (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (be ? 0x08 : 0) | (bs ? 0x10 : 0) | (at ? 0x40 : 0) | (ed ? 0x80 : 0);
}

function authenticatorData({ rpId, flags, signCount = 0, attested = null, extensions = null }) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount >>> 0);
  // AT and ED follow what is actually there, unless a test says otherwise.
  const byte = flagsByte({ ...flags, at: flags.at ?? !!attested, ed: flags.ed ?? !!extensions });
  const parts = [sha256(Buffer.from(rpId, 'utf8')), Buffer.from([byte]), count];
  if (attested) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(attested.credentialId.length);
    parts.push(attested.aaguid, len, attested.credentialId, attested.publicKeyCbor);
  }
  if (extensions) parts.push(Buffer.isBuffer(extensions) ? extensions : cbor(extensions));
  return Buffer.concat(parts);
}

const ZERO_AAGUID = Buffer.alloc(16);

class SoftAuthenticator {
  // origin: what this "browser" puts in clientDataJSON.
  // counter: true for an authenticator that counts signatures (a security
  //   key), false for one that always says 0 (a synced passkey).
  // backupEligible / backedUp: the BE and BS flags it reports.
  constructor({ origin, aaguid = ZERO_AAGUID, counter = false, backupEligible = true, backedUp = true } = {}) {
    this.origin = origin;
    this.aaguid = Buffer.isBuffer(aaguid) ? aaguid : Buffer.from(aaguid.replace(/-/g, ''), 'hex');
    this.counter = counter;
    this.backupEligible = backupEligible;
    this.backedUp = backedUp;
    this.credentials = new Map(); // base64url id -> record
  }

  clientData(type, challenge, knobs) {
    const data = {
      type: knobs.type ?? type,
      challenge: knobs.challenge ?? challenge,
      origin: knobs.origin ?? this.origin,
      crossOrigin: knobs.crossOrigin ?? false,
      ...(knobs.clientDataExtra || {}),
    };
    return knobs.clientDataJSON ?? Buffer.from(JSON.stringify(data), 'utf8');
  }

  // navigator.credentials.create({ publicKey }), from the options JSON.
  //
  // knobs: alg, rsaBits, credentialId, type, challenge, origin, rpId,
  //   crossOrigin, clientDataExtra, clientDataJSON (bytes), up, uv, be, bs,
  //   at (false leaves out the attested credential data), signCount, fmt,
  //   attStmt, attestationObject (bytes), authData (bytes), publicKeyCbor
  //   (bytes), extensions, transports, clientExtensionResults, store
  //   (false: don't remember the credential), rawIdOverride.
  create(options, knobs = {}) {
    const offered = options.pubKeyCredParams.map((p) => p.alg);
    const alg = knobs.alg ?? offered.find((a) => [-8, -7, -257].includes(a));
    const { publicKey, privateKey } = generateKey(alg, knobs);
    const credentialId = knobs.credentialId ?? crypto.randomBytes(16);
    const rpId = knobs.rpId ?? options.rp.id;

    const clientDataJSON = this.clientData('webauthn.create', options.challenge, knobs);
    const flags = {
      up: knobs.up ?? true,
      uv: knobs.uv ?? true,
      be: knobs.be ?? this.backupEligible,
      bs: knobs.bs ?? this.backedUp,
    };
    const authData =
      knobs.authData ??
      authenticatorData({
        rpId,
        flags: knobs.at === false ? { ...flags, at: false } : flags,
        signCount: knobs.signCount ?? (this.counter ? 1 : 0),
        attested:
          knobs.at === false
            ? null
            : {
                aaguid: this.aaguid,
                credentialId,
                publicKeyCbor: knobs.publicKeyCbor ?? cbor(coseKey(publicKey, alg)),
              },
        extensions: knobs.extensions ?? null,
      });
    const attestationObject =
      knobs.attestationObject ??
      cbor(new Map([['fmt', knobs.fmt ?? 'none'], ['attStmt', knobs.attStmt ?? new Map()], ['authData', authData]]));

    const id = credentialId.toString('base64url');
    if (knobs.store !== false) {
      this.credentials.set(id, {
        id: credentialId,
        alg,
        privateKey,
        publicKey,
        rpId,
        userHandle: Buffer.from(options.user.id, 'base64url'),
        signCount: knobs.signCount ?? (this.counter ? 1 : 0),
      });
    }
    return {
      id: knobs.idOverride ?? id,
      rawId: knobs.rawIdOverride ?? id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: knobs.transports ?? ['hybrid', 'internal'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: knobs.clientExtensionResults ?? { credProps: { rk: true } },
    };
  }

  // navigator.credentials.get({ publicKey }), from the options JSON. With an
  // empty allowCredentials it answers with a discoverable credential for the
  // RP ID, as a browser would; `knobs.credential` picks one by base64url id.
  //
  // knobs: credential, type, challenge, origin, rpId, crossOrigin,
  //   clientDataExtra, clientDataJSON, up, uv, be, bs, signCount,
  //   userHandle (bytes, or null to leave it out), badSignature, signature
  //   (bytes), authData (bytes), extensions.
  get(options, knobs = {}) {
    const record = knobs.credential
      ? this.credentials.get(knobs.credential)
      : [...this.credentials.values()].reverse().find((c) => c.rpId === options.rpId);
    if (!record) throw new Error('no credential for this RP ID');

    let signCount = knobs.signCount;
    if (signCount === undefined) {
      if (this.counter) record.signCount += 1;
      signCount = this.counter ? record.signCount : 0;
    }
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, knobs);
    const authData =
      knobs.authData ??
      authenticatorData({
        rpId: knobs.rpId ?? options.rpId,
        flags: {
          up: knobs.up ?? true,
          uv: knobs.uv ?? true,
          be: knobs.be ?? this.backupEligible,
          bs: knobs.bs ?? this.backedUp,
        },
        signCount,
        extensions: knobs.extensions ?? null,
      });
    let signature = knobs.signature ?? sign(record.alg, record.privateKey, Buffer.concat([authData, sha256(clientDataJSON)]));
    if (knobs.badSignature) {
      signature = Buffer.from(signature);
      signature[signature.length - 1] ^= 0x01;
    }
    const userHandle = knobs.userHandle === undefined ? record.userHandle : knobs.userHandle;
    const id = record.id.toString('base64url');
    const response = {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    };
    if (userHandle !== null) response.userHandle = userHandle.toString('base64url');
    return {
      id,
      rawId: id,
      type: 'public-key',
      response,
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }
}

module.exports = { SoftAuthenticator, cbor, coseKey, generateKey, authenticatorData, sha256 };
