// Passkeys: this site as a WebAuthn relying party, on node:crypto alone so
// the zero-dependency property holds here too. That means the two formats
// WebAuthn is written in are read here by hand: CBOR (RFC 8949) for the
// attestation object and the credential's public key, and COSE_Key (RFC 9052
// §7, RFC 9053) for the key itself, turned into a JWK node:crypto can load.
//
// What it follows, and where each rule comes from:
//   - W3C Web Authentication Level 3 (a Recommendation since 25 August 2026):
//     §7.1 "Registering a New Credential" and §7.2 "Verifying an
//     Authentication Assertion", check by check; §6.1 for authenticator data;
//     §5.8.1 for the client data; §8.7 for attestation "none".
//   - CTAP 2.2 §8 "Message Encoding": the CBOR an authenticator produces is a
//     small, definite-length subset, and anything outside it is refused
//     rather than interpreted.
//   - RFC 9053: COSE algorithms -7 (ES256), -8 (EdDSA, Ed25519 here) and
//     -257 (RS256, RFC 8812), and nothing else.
//
// Attestation is not verified, on purpose: options ask for "none", and a
// statement in another format is accepted with its contents ignored. That is
// the passkeys.dev guidance for a consumer site — attestation says which
// make of authenticator this is, which only matters to a site that keeps an
// allowlist of them, and verifying it means trusting FIDO metadata roots
// this project has no reason to hold (see TODO.md).
//
// This file never touches the database, the session or the HTTP layer.
// server.js owns challenges, accounts and cookies, beside the password and
// provider sign-ins; everything here is a pure function of its arguments.

const crypto = require('node:crypto');
const net = require('node:net');
const { parsePublicOrigin } = require('./oauth');

// The browser-facing name of the relying party (§5.4, rp.name).
const RP_NAME = 'Skill Trees';

// Algorithms we ask for, in order of preference (§5.4 pubKeyCredParams):
// Ed25519 where the authenticator has it, then P-256, which nearly all do,
// then RSA for Windows Hello's older TPM keys.
const ALGORITHM_IDS = [-8, -7, -257];

// Refusals come in kinds, so the route can answer each in its own words
// without the text of a check ever reaching the browser:
//   malformed — the response couldn't be read as WebAuthn at all (400)
//   refused   — it was read, and a check failed (the ceremony fails)
//   counter   — the signature counter went backwards: a possible clone
// `message` is for the server log only.
class WebAuthnError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}
const malformed = (why) => new WebAuthnError('malformed', why);
const refused = (why) => new WebAuthnError('refused', why);

// ---------- configuration ----------

// Passkeys need to know, before any browser asks, which origin they are
// exercised on and which RP ID they are scoped to (§5.1.3, §13.4.9).
// Both come from PUBLIC_ORIGIN, never from the Host header: Host is whatever
// the requester says, and an RP ID taken from it would let them choose which
// site's passkeys the server accepts. So, as for the OAuth providers: no
// PUBLIC_ORIGIN, no passkeys.
//
// The RP ID is the origin's host, which is the default a browser would use
// and the narrowest scope that works. An IP address can't be one (§5.1.3:
// browsers refuse an RP ID that isn't a domain), so an origin by address
// leaves passkeys off with a note saying why.
function configurePasskeys(env) {
  const off = (note) => ({ enabled: false, rpId: null, origin: null, note });
  if (!env.PUBLIC_ORIGIN) {
    return off('Passkeys: off (PUBLIC_ORIGIN is not set; see .env.example).');
  }
  const { origin, problem } = parsePublicOrigin(env.PUBLIC_ORIGIN);
  if (!origin) return off(`Passkeys are OFF: ${problem}.`);
  const rpId = new URL(origin).hostname;
  if (net.isIP(rpId.replace(/^\[|\]$/g, ''))) {
    return off(
      'Passkeys are OFF: PUBLIC_ORIGIN names an IP address, which WebAuthn does not accept ' +
        'as an RP ID. Use a domain name (or localhost).'
    );
  }
  return {
    enabled: true,
    rpId,
    origin,
    note: `Passkeys are on for RP ID "${rpId}", accepted from ${origin} only.`,
  };
}

// ---------- base64url ----------

const B64URL = /^[A-Za-z0-9_-]*$/;

// A base64url field from a response's JSON (§5.1 toJSON; unpadded, per
// RFC 4648 §5). Buffer's decoder skips characters it doesn't know and
// ignores stray trailing bits, so the charset is checked here and the bytes
// must encode back to exactly the text: one byte string, one spelling.
function fromB64url(value, what, maxBytes) {
  if (typeof value !== 'string') throw malformed(`${what} is not a base64url string`);
  if (value.length > Math.ceil((maxBytes * 4) / 3)) throw malformed(`${what} is too long`);
  if (!B64URL.test(value)) throw malformed(`${what} is not base64url`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw malformed(`${what} is not canonical base64url`);
  return bytes;
}

// ---------- CBOR (RFC 8949), the CTAP2 subset ----------

// Deeper than anything an authenticator sends — an attestation object is
// three levels at most, a TPM statement four — and shallow enough that a
// hostile document can't turn the recursion into a stack overflow.
const CBOR_MAX_DEPTH = 16;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Reads one CBOR data item starting at `offset`. Returns { value, end }.
//
// Strict on purpose (CTAP 2.2 §8.1): definite lengths only, no tags, no
// floating point, no simple values beyond false/true/null, map keys that are
// integers or text and never repeated, integers within 2^53. Every length is
// checked against the bytes that are actually left *before* anything is
// allocated or looped over, so a header claiming a four-gigabyte string or a
// billion-entry array costs nothing but its own few bytes. Maps come back as
// Map, so integer keys (COSE's) stay integers.
function decodeCborItem(buf, offset = 0, maxDepth = CBOR_MAX_DEPTH) {
  if (!Buffer.isBuffer(buf)) throw malformed('CBOR input is not bytes');
  let pos = offset;
  const left = () => buf.length - pos;
  const need = (n) => {
    if (n > left()) throw malformed('CBOR is truncated');
  };

  // The argument of a head (§3): the value itself below 24, else 1, 2, 4 or
  // 8 bytes after it. 28-30 are reserved; 31 is indefinite length.
  const argument = (info) => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf[pos++];
    }
    if (info === 25) {
      need(2);
      const v = buf.readUInt16BE(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = buf.readUInt32BE(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = buf.readBigUInt64BE(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed('CBOR integer or length is too large');
      return Number(v);
    }
    if (info === 31) throw malformed('CBOR indefinite lengths are not allowed');
    throw malformed('CBOR uses a reserved additional-information value');
  };

  const item = (depth) => {
    if (depth > maxDepth) throw malformed('CBOR is nested too deeply');
    need(1);
    const head = buf[pos++];
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return argument(info);
      case 1:
        return -1 - argument(info);
      case 2: {
        const len = argument(info);
        need(len);
        const bytes = Buffer.from(buf.subarray(pos, pos + len));
        pos += len;
        return bytes;
      }
      case 3: {
        const len = argument(info);
        need(len);
        let text;
        try {
          text = UTF8.decode(buf.subarray(pos, pos + len));
        } catch {
          throw malformed('CBOR text string is not UTF-8');
        }
        pos += len;
        return text;
      }
      case 4: {
        const count = argument(info);
        // Every item takes at least one byte.
        if (count > left()) throw malformed('CBOR array is longer than its input');
        const out = [];
        for (let i = 0; i < count; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const count = argument(info);
        if (count * 2 > left()) throw malformed('CBOR map is longer than its input');
        const out = new Map();
        for (let i = 0; i < count; i++) {
          const key = item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') {
            throw malformed('CBOR map key is neither an integer nor text');
          }
          if (out.has(key)) throw malformed('CBOR map repeats a key');
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 6:
        throw malformed('CBOR tags are not allowed');
      default: // 7
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw malformed('CBOR floats and other simple values are not allowed');
    }
  };

  const value = item(1);
  return { value, end: pos };
}

// Exactly one item, and nothing after it.
function decodeCbor(buf, maxDepth = CBOR_MAX_DEPTH) {
  const { value, end } = decodeCborItem(buf, 0, maxDepth);
  if (end !== buf.length) throw malformed('CBOR has bytes after its data item');
  return value;
}

// ---------- authenticator data (§6.1) ----------

const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };

function formatAaguid(bytes) {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

//   rpIdHash (32) | flags (1) | signCount (4, big-endian)
//   [attested credential data, if AT: aaguid (16) | L (2) | credentialId (L)
//    | credentialPublicKey (CBOR)]
//   [extensions, if ED: CBOR map]
// and not a byte more: whatever is left over means the flags lied about
// what is there, and a parser that shrugs at that reads a different
// structure from the one the authenticator signed.
function parseAuthenticatorData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw malformed('authenticator data is shorter than 37 bytes');
  const flagsByte = buf[32];
  const flags = {
    up: (flagsByte & FLAGS.UP) !== 0,
    uv: (flagsByte & FLAGS.UV) !== 0,
    be: (flagsByte & FLAGS.BE) !== 0,
    bs: (flagsByte & FLAGS.BS) !== 0,
    at: (flagsByte & FLAGS.AT) !== 0,
    ed: (flagsByte & FLAGS.ED) !== 0,
  };
  const out = {
    rpIdHash: Buffer.from(buf.subarray(0, 32)),
    flags,
    signCount: buf.readUInt32BE(33),
    attested: null,
    extensions: null,
  };
  let pos = 37;
  if (flags.at) {
    if (buf.length - pos < 18) throw malformed('attested credential data is truncated');
    const aaguid = formatAaguid(buf.subarray(pos, pos + 16));
    pos += 16;
    const idLength = buf.readUInt16BE(pos);
    pos += 2;
    if (idLength > buf.length - pos) throw malformed('credential ID runs past the authenticator data');
    const credentialId = Buffer.from(buf.subarray(pos, pos + idLength));
    pos += idLength;
    const { value: publicKey, end } = decodeCborItem(buf, pos);
    if (!(publicKey instanceof Map)) throw malformed('credential public key is not a COSE_Key map');
    pos = end;
    out.attested = { aaguid, credentialId, publicKey };
  }
  if (flags.ed) {
    const { value, end } = decodeCborItem(buf, pos);
    if (!(value instanceof Map)) throw malformed('authenticator extensions are not a map');
    pos = end;
    out.extensions = value;
  }
  if (pos !== buf.length) throw malformed('authenticator data has bytes its flags do not account for');
  return out;
}

// ---------- COSE_Key -> public key ----------

// COSE labels (RFC 9052 §7.1, RFC 9053 §7): kty 1, alg 3; for EC2 and OKP
// crv -1, x -2, (EC2) y -3; for RSA (RFC 8230 §4) n -1, e -2.
const COSE = { KTY: 1, ALG: 3, CRV: -1, X: -2, Y: -3, N: -1, E: -2 };
const KTY = { OKP: 1, EC2: 2, RSA: 3 };
const CRV = { P256: 1, ED25519: 6 };

const bytesOf = (cose, label, what) => {
  const v = cose.get(label);
  if (!Buffer.isBuffer(v)) throw refused(`COSE key has no ${what}`);
  return v;
};

// The JWK for a COSE_Key, for one of the algorithms we asked for. Only the
// public members are ever read, so a key that carries a private part (label
// -4) doesn't get it imported. Each algorithm's key type and curve are
// required to match it, the same rule the ID-token check in lib/oauth.js
// applies: an algorithm is never allowed to pick its own key type.
function coseToJwk(cose, allowed = ALGORITHM_IDS) {
  if (!(cose instanceof Map)) throw refused('credential public key is not a COSE_Key');
  const alg = cose.get(COSE.ALG);
  const kty = cose.get(COSE.KTY);
  if (!Number.isInteger(alg)) throw refused('COSE key names no algorithm');
  // §7.1: the key's algorithm must be one the options offered.
  if (!allowed.includes(alg)) throw refused(`COSE algorithm ${alg} was not one we asked for`);

  if (alg === -7) {
    if (kty !== KTY.EC2 || cose.get(COSE.CRV) !== CRV.P256) throw refused('ES256 key is not an EC2 P-256 key');
    const x = bytesOf(cose, COSE.X, 'x');
    const y = bytesOf(cose, COSE.Y, 'y');
    if (x.length !== 32 || y.length !== 32) throw refused('P-256 coordinates are not 32 bytes');
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') } };
  }
  if (alg === -8) {
    if (kty !== KTY.OKP || cose.get(COSE.CRV) !== CRV.ED25519) throw refused('EdDSA key is not an OKP Ed25519 key');
    const x = bytesOf(cose, COSE.X, 'x');
    if (x.length !== 32) throw refused('Ed25519 public key is not 32 bytes');
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') } };
  }
  if (alg === -257) {
    if (kty !== KTY.RSA) throw refused('RS256 key is not an RSA key');
    const n = bytesOf(cose, COSE.N, 'modulus');
    const e = bytesOf(cose, COSE.E, 'exponent');
    return { alg, jwk: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') } };
  }
  throw refused(`COSE algorithm ${alg} is not supported`);
}

const RSA_MIN_BITS = 2048;
// Verifying is cheap at any size, but nothing legitimate is bigger, and a
// ceiling keeps a 64 KB modulus from being a thing someone can store.
const RSA_MAX_BITS = 8192;

// Loads a COSE_Key as a node:crypto KeyObject and checks what JWK import
// alone doesn't: node:crypto rejects a P-256 point that isn't on the curve
// and an Ed25519 key of the wrong length, but takes any RSA exponent — e=1
// included, which makes every message its own signature. Returns the key
// and its SubjectPublicKeyInfo DER, which is what gets stored.
function publicKeyFromCose(cose, allowed = ALGORITHM_IDS) {
  const { alg, jwk } = coseToJwk(cose, allowed);
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw refused('credential public key is not a valid key');
  }
  if (alg === -257) {
    const { modulusLength, publicExponent } = key.asymmetricKeyDetails;
    if (modulusLength < RSA_MIN_BITS || modulusLength > RSA_MAX_BITS) {
      throw refused(`RSA key is ${modulusLength} bits; ${RSA_MIN_BITS}-${RSA_MAX_BITS} are accepted`);
    }
    // 65537 is what every RSA authenticator uses (a TPM's default exponent
    // among them). Anything else is either broken or an experiment.
    if (publicExponent !== 65537n) throw refused('RSA public exponent is not 65537');
  }
  return { alg, key, spki: key.export({ type: 'spki', format: 'der' }) };
}

// A stored key (SPKI DER), loaded again for a sign-in.
function publicKeyFromSpki(spki) {
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// §6.3.3 / §7.2: the signature is over authenticatorData followed by
// SHA-256(clientDataJSON). ES256 signatures are ASN.1 DER here (WebAuthn's
// signature formats), not the raw r||s of JOSE — node:crypto's default. The
// key type is checked against the algorithm again, so a stored key can't be
// pressed into another algorithm's service whatever the database says.
function verifySignature(alg, key, data, signature) {
  try {
    if (alg === -7) {
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') return false;
      return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
    }
    if (alg === -8) {
      if (key.asymmetricKeyType !== 'ed25519') return false;
      return crypto.verify(null, data, key, signature);
    }
    if (alg === -257) {
      if (key.asymmetricKeyType !== 'rsa') return false;
      return crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
    }
  } catch {
    return false;
  }
  return false;
}

// ---------- the responses a browser sends back ----------

// Upper bounds for each part, well above anything real: client data is a few
// hundred bytes, an attestation object with a TPM certificate chain a few
// kilobytes. The request body is capped at 1 MB anyway; these keep each
// field to what its parser should ever be asked to read.
const MAX_CREDENTIAL_ID_BYTES = 1023; // the most a credential ID may be; §7.1 checks it
const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_ATTESTATION_OBJECT_BYTES = 64 * 1024;
const MAX_AUTHENTICATOR_DATA_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024; // an 8192-bit RSA signature
const MAX_USER_HANDLE_BYTES = 64; // §5.4.3

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal']);

// The credential ID, which a PublicKeyCredential's JSON carries twice (id
// and rawId, §5.1): both must be present, identical and usable.
function readCredentialId(body) {
  if (!body || typeof body !== 'object') throw malformed('credential is not an object');
  if (body.type !== 'public-key') throw malformed('credential type is not "public-key"');
  if (body.id !== body.rawId) throw malformed('credential id and rawId differ');
  const rawId = fromB64url(body.id, 'credential id', MAX_CREDENTIAL_ID_BYTES);
  if (rawId.length === 0) throw malformed('credential id is empty');
  return { id: body.id, rawId };
}

// §7.1 / §7.2, the first checks of each: UTF-8, then JSON, then the members
// every later step reads. Its exact bytes are kept, because the signature
// covers their hash — the JSON is never re-serialised or compared against a
// template (browsers add members, and Chrome adds one deliberately to catch
// sites that do).
function readClientData(value) {
  const raw = fromB64url(value, 'clientDataJSON', MAX_CLIENT_DATA_BYTES);
  let data;
  try {
    data = JSON.parse(UTF8.decode(raw));
  } catch {
    throw malformed('clientDataJSON is not UTF-8 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw malformed('clientDataJSON is not an object');
  if (typeof data.type !== 'string' || typeof data.origin !== 'string') {
    throw malformed('clientDataJSON has no type or origin');
  }
  // Ours are 43 characters; this only has to be a plausible lookup key.
  if (typeof data.challenge !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.challenge)) {
    throw malformed('clientDataJSON has no usable challenge');
  }
  return { raw, data, hash: crypto.createHash('sha256').update(raw).digest() };
}

function responseObject(body) {
  const r = body.response;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw malformed('credential has no response object');
  return r;
}

// A RegistrationResponseJSON (§5.1, from credential.toJSON()), decoded and
// bounded but not yet judged: the route needs the challenge out of it first,
// to find (and use up) the ceremony it belongs to.
function readRegistrationResponse(body) {
  const { id, rawId } = readCredentialId(body);
  const r = responseObject(body);
  const clientData = readClientData(r.clientDataJSON);
  const attestationObject = fromB64url(r.attestationObject, 'attestationObject', MAX_ATTESTATION_OBJECT_BYTES);
  // getTransports() (§5.2.1): hints for later sign-ins, never trusted for
  // anything. Only known values, each once.
  const transports = Array.isArray(r.transports)
    ? [...new Set(r.transports.filter((t) => typeof t === 'string' && TRANSPORTS.has(t)))]
    : [];
  const ext = body.clientExtensionResults;
  return {
    id,
    rawId,
    clientData,
    attestationObject,
    transports,
    extensionResults: ext && typeof ext === 'object' && !Array.isArray(ext) ? ext : {},
  };
}

// An AuthenticationResponseJSON (§5.1), decoded and bounded.
function readAuthenticationResponse(body) {
  const { id, rawId } = readCredentialId(body);
  const r = responseObject(body);
  const clientData = readClientData(r.clientDataJSON);
  const authenticatorData = fromB64url(r.authenticatorData, 'authenticatorData', MAX_AUTHENTICATOR_DATA_BYTES);
  const signature = fromB64url(r.signature, 'signature', MAX_SIGNATURE_BYTES);
  if (signature.length === 0) throw malformed('signature is empty');
  const userHandle =
    r.userHandle === undefined || r.userHandle === null
      ? null
      : fromB64url(r.userHandle, 'userHandle', MAX_USER_HANDLE_BYTES);
  return { id, rawId, clientData, authenticatorData, signature, userHandle };
}

// ---------- the ceremonies ----------

// §7.1 / §7.2, the client data half: type, origin, and no framing. (The
// challenge was checked when the route found its ceremony by it.)
function checkClientData(data, type, origin) {
  if (data.type !== type) throw refused(`clientDataJSON type is "${String(data.type).slice(0, 20)}", not ${type}`);
  // §13.4.9: the origin, exactly — not a suffix, not a parse-and-compare.
  if (data.origin !== origin) throw refused(`origin ${String(data.origin).slice(0, 100)} is not ${origin}`);
  // §5.8.1: crossOrigin is true when the ceremony ran in a frame whose
  // ancestors aren't all this origin, and topOrigin then names the page on
  // top. This site is never framed (frame-ancestors 'none'), so either one
  // means a ceremony nobody here started.
  if (data.crossOrigin === true) throw refused('ceremony ran in a cross-origin frame');
  if (data.topOrigin !== undefined) throw refused('ceremony names a top origin: it ran in a frame');
}

function rpIdHash(rpId) {
  return crypto.createHash('sha256').update(rpId, 'utf8').digest();
}

// The checks on authenticator data that both ceremonies share (§7.1, §7.2):
// rpIdHash, then the UP, UV and BE/BS flags.
function checkAuthenticatorData(auth, rpId, { requireUserPresence, requireUserVerification }) {
  // The authenticator scoped this credential to our RP ID, not another
  // site's: a phishing page on another domain gets its own hash here.
  if (!auth.rpIdHash.equals(rpIdHash(rpId))) throw refused('rpIdHash is not the hash of our RP ID');
  if (requireUserPresence && !auth.flags.up) throw refused('user presence (UP) flag is not set');
  if (requireUserVerification && !auth.flags.uv) throw refused('user verification (UV) flag is not set');
  // §6.1: a credential that can't be backed up can't be backed up now.
  if (auth.flags.bs && !auth.flags.be) throw refused('backup state (BS) is set without backup eligibility (BE)');
}

// §7.1, after the client data is parsed. `resp` is the result of
// readRegistrationResponse(); the caller has already matched its challenge
// to a live ceremony. `requireUserPresence` is false only for an automatic
// passkey upgrade (§7.1 checks UP only "if options.mediation is not set to
// conditional"), and `requireUserVerification` with it, since that request
// asks for userVerification "preferred". Returns what gets stored.
function verifyRegistration(
  resp,
  { rpId, origin, requireUserPresence = true, requireUserVerification = true, algorithms = ALGORITHM_IDS }
) {
  checkClientData(resp.clientData.data, 'webauthn.create', origin);

  // The attestation object is a CBOR map of fmt, attStmt and authData
  // (§6.5). Other keys are not ours to interpret, so they are left alone.
  const att = decodeCbor(resp.attestationObject);
  if (!(att instanceof Map)) throw malformed('attestation object is not a map');
  const fmt = att.get('fmt');
  const attStmt = att.get('attStmt');
  const authDataBytes = att.get('authData');
  if (typeof fmt !== 'string' || !/^[\x21-\x7e]{1,32}$/.test(fmt)) throw malformed('attestation fmt is missing');
  if (!(attStmt instanceof Map)) throw malformed('attestation statement is not a map');
  if (!Buffer.isBuffer(authDataBytes)) throw malformed('attestation object has no authData');
  // §8.7: "none" is an empty statement. Any other format is accepted with
  // its statement unread — we asked for none and act on none (§7.1 lets an
  // RP whose policy allows it register the credential and treat it as one
  // without attestation); see the top of this file for why.
  if (fmt === 'none' && attStmt.size !== 0) throw refused('"none" attestation carries a statement');

  const auth = parseAuthenticatorData(authDataBytes);
  checkAuthenticatorData(auth, rpId, { requireUserPresence, requireUserVerification });

  // A new credential comes with its ID and key, and the ID is the one the
  // browser reported, and short enough to be one.
  if (!auth.flags.at || !auth.attested) throw refused('no attested credential data (AT flag not set)');
  const { credentialId, publicKey, aaguid } = auth.attested;
  if (credentialId.length === 0 || credentialId.length > MAX_CREDENTIAL_ID_BYTES) {
    throw refused(`credential ID is ${credentialId.length} bytes`);
  }
  if (!credentialId.equals(resp.rawId)) throw refused('credential ID in authData differs from rawId');

  const { alg, spki } = publicKeyFromCose(publicKey, algorithms);

  // credProps (§10.1.3): the client reports whether it made a discoverable
  // credential. We require one (residentKey "required"), because sign-in
  // offers no list of credentials to choose from; a client that says it
  // made something else has made a credential nobody could sign in with.
  const credProps = resp.extensionResults.credProps;
  if (credProps && typeof credProps === 'object' && credProps.rk === false) {
    throw refused('client reports the credential is not discoverable (credProps.rk false)');
  }

  return {
    credentialId: credentialId.toString('base64url'),
    publicKey: spki,
    alg,
    signCount: auth.signCount,
    userVerified: auth.flags.uv,
    backupEligible: auth.flags.be,
    backedUp: auth.flags.bs,
    aaguid,
    transports: resp.transports,
    fmt,
  };
}

// §7.2, after the client data is parsed. `credential` is the stored record:
// publicKey (SPKI DER), alg, signCount, backupEligible, and the owner's
// userHandle (bytes). The caller has already matched the challenge and found
// this record by the response's credential ID. Returns what gets updated.
function verifyAuthentication(resp, { rpId, origin, credential }) {
  // With an empty allowCredentials the user handle is how the account is
  // identified, so it must be there, and must be the handle of the account
  // that owns this credential — otherwise a credential of one account could
  // be presented as belonging to another.
  if (!resp.userHandle) throw refused('assertion carries no userHandle');
  const expected = credential.userHandle;
  if (
    !Buffer.isBuffer(expected) ||
    expected.length !== resp.userHandle.length ||
    !crypto.timingSafeEqual(expected, resp.userHandle)
  ) {
    throw refused("userHandle is not the handle of this credential's account");
  }

  checkClientData(resp.clientData.data, 'webauthn.get', origin);

  const auth = parseAuthenticatorData(resp.authenticatorData);
  checkAuthenticatorData(auth, rpId, { requireUserPresence: true, requireUserVerification: true });

  // BE is fixed when a credential is made (§6.1.3); one that changes is not
  // the credential we registered.
  if (auth.flags.be !== credential.backupEligible) throw refused('backup eligibility (BE) changed since registration');

  // The signature, by the key stored at registration.
  const key = publicKeyFromSpki(credential.publicKey);
  const signed = Buffer.concat([resp.authenticatorData, resp.clientData.hash]);
  if (!verifySignature(credential.alg, key, signed, resp.signature)) throw refused('signature does not verify');

  // The signature counter (§6.1.1). A counter of zero means the
  // authenticator doesn't keep one (synced passkeys don't: one credential on
  // several devices can't share a count), and zero forever is fine. Once
  // either side is non-zero, the new value must be larger than the stored
  // one; if it isn't, two authenticators are answering for one credential —
  // a cloned key — and the ceremony fails. That includes a counter that
  // falls back to zero: a clone that simply doesn't count must not slip past
  // the check by saying 0.
  if ((auth.signCount !== 0 || credential.signCount !== 0) && auth.signCount <= credential.signCount) {
    const e = new WebAuthnError(
      'counter',
      `signature counter ${auth.signCount} is not above the stored ${credential.signCount}`
    );
    e.received = auth.signCount;
    throw e;
  }

  return { signCount: auth.signCount, backedUp: auth.flags.bs, userVerified: auth.flags.uv };
}

// ---------- the options sent to the browser ----------

// PublicKeyCredentialCreationOptionsJSON (§5.4; what the browser's
// PublicKeyCredential.parseCreationOptionsFromJSON() takes).
//   - residentKey "required": sign-in never names an account first, so the
//     credential has to be discoverable (a passkey).
//   - userVerification "required": a passkey replaces a password rather than
//     adding to one, so the device must check it's the person (biometric or
//     PIN), not just that someone touched it. "preferred" only for an
//     automatic upgrade, which can't ask (see verifyRegistration).
//   - attestation "none": see the top of this file.
//   - credProps: so the client says whether it really made a passkey.
function creationOptions({ rpId, challenge, userHandle, username, exclude, userVerification = 'required', timeoutMs }) {
  return {
    rp: { id: rpId, name: RP_NAME },
    user: { id: userHandle, name: username, displayName: username },
    challenge,
    pubKeyCredParams: ALGORITHM_IDS.map((alg) => ({ type: 'public-key', alg })),
    timeout: timeoutMs,
    excludeCredentials: exclude.map((c) => ({ type: 'public-key', id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification },
    attestation: 'none',
    extensions: { credProps: true },
  };
}

// PublicKeyCredentialRequestOptionsJSON (§5.5): an empty allowCredentials
// asks for any discoverable credential for this RP ID, so nobody has to type
// a username first — and the server never says which accounts exist.
function requestOptions({ rpId, challenge, timeoutMs }) {
  return { challenge, timeout: timeoutMs, rpId, allowCredentials: [], userVerification: 'required' };
}

// ---------- names ----------

// A label for a new passkey from its AAGUID, when the authenticator gives a
// real one (with attestation "none" some send zeros). Only for display — a
// label the owner can change, never a policy — so a short list of the common
// passkey providers is enough, and anything else is just "Passkey".
const PROVIDER_NAMES = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

function defaultName(aaguid) {
  return PROVIDER_NAMES[aaguid] || 'Passkey';
}

module.exports = {
  configurePasskeys,
  decodeCbor,
  decodeCborItem,
  parseAuthenticatorData,
  coseToJwk,
  publicKeyFromCose,
  publicKeyFromSpki,
  verifySignature,
  readRegistrationResponse,
  readAuthenticationResponse,
  verifyRegistration,
  verifyAuthentication,
  creationOptions,
  requestOptions,
  defaultName,
  fromB64url,
  WebAuthnError,
  ALGORITHM_IDS,
  RP_NAME,
  MAX_CREDENTIAL_ID_BYTES,
};
