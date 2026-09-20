// Text that came from outside and is about to be shown to someone.
//
// Shared by the server and the command-line scripts, because both print
// caller-authored text — a username in an access log, a tree title in the
// operator's terminal — and the same bytes are dangerous in both places.

// C0 controls, and DEL. Nothing legitimate carries them in a single-line
// field: they appear only where someone percent-encoded them into a URL or
// put them into a field on purpose.
function hasControlChars(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// For anything interpolated into a log line or a terminal message. A newline
// in a username or a tree title would otherwise let its author forge whole
// log records; an ESC lets them drive the operator's terminal — erasing the
// line that was being printed and writing a more convincing one in its place.
// Controls become spaces and the result is capped to a sane length.
function logSafe(str, maxLen = 120) {
  let out = '';
  const text = String(str == null ? '' : str).slice(0, maxLen);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? ' ' : text[i];
  }
  return out;
}

// Removes control characters on the way in, so no stored value ever carries
// one. Single-line fields — a title, a name, an author — lose all of them;
// a description keeps the whitespace that makes it a paragraph and loses the
// rest. Neutralizing at the sink (logSafe) covers rows written before this
// existed; this covers everything written after it.
function stripControlChars(str, { keepWhitespace = false } = {}) {
  let out = '';
  const text = String(str == null ? '' : str);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if (code < 0x20 || code === 0x7f) {
      if (keepWhitespace && isWhitespace) out += text[i];
      continue;
    }
    out += text[i];
  }
  return out;
}

module.exports = { hasControlChars, logSafe, stripControlChars };
