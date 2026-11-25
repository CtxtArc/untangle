// Turn the raw bytes of a sample into source text.
//
// WSH happily runs scripts that are UTF-16 (with or without a BOM) or saved in the system ANSI
// codepage, so droppers come in all of these. Reading them as UTF-8 produces U+FFFD garbage
// that the parser rejects.

import { decodeScriptEncoder } from './scriptEncoder.js';

export class InputError extends Error {}

function looksUtf16(buf) {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) evenNul++;
    if (buf[i + 1] === 0) oddNul++;
  }
  const half = n / 2;
  if (oddNul / half > 0.3 && evenNul / half < 0.05) return 'utf-16le';
  if (evenNul / half > 0.3 && oddNul / half < 0.05) return 'utf-16be';
  return null;
}

function decodeUtf16(buf, le) {
  const b = Buffer.from(buf.subarray(0, buf.length & ~1));
  if (!le) b.swap16();
  return b.toString('utf16le');
}

/**
 * @param {Buffer} buf
 * @returns {{ code: string, encoding: string }}
 */
export function decodeSource(buf) {
  let code;
  let encoding;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    code = decodeUtf16(buf.subarray(2), true);
    encoding = 'utf-16le (BOM)';
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    code = decodeUtf16(buf.subarray(2), false);
    encoding = 'utf-16be (BOM)';
  } else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    code = buf.subarray(3).toString('utf8');
    encoding = 'utf-8 (BOM)';
  } else {
    const guess = looksUtf16(buf);
    if (guess) {
      code = decodeUtf16(buf, guess === 'utf-16le');
      encoding = `${guess} (no BOM)`;
    } else {
      try {
        code = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        encoding = 'utf-8';
      } catch {
        // not valid UTF-8: WSH would read it in the ANSI codepage
        code = new TextDecoder('windows-1252').decode(buf);
        encoding = 'windows-1252 (not valid UTF-8)';
      }
    }
  }
  if (code.charCodeAt(0) === 0xfeff) code = code.slice(1);
  if (code.includes('#@~^')) {
    // JScript.Encode / VBScript.Encode (screnc, .jse / .vbe): a fixed substitution, decoded here
    const r = decodeScriptEncoder(code);
    if (!r.blocks) {
      throw new InputError('this looks like a Script Encoder (screnc / .jse) script, but no complete ' +
        '"#@~^...^#~@" block was found: is the file truncated?');
    }
    code = r.code;
    encoding += `, Script Encoder: ${r.blocks} block${r.blocks > 1 ? 's' : ''} decoded` +
      (r.badChecksums ? ` (${r.badChecksums} with a wrong length or checksum: the file was altered)` : '');
    return { code, encoding, scriptEncoded: r };
  }
  return { code, encoding };
}

/** A readable one-line description of a parse error, with the offending character. */
export function describeParseError(err, code) {
  if (typeof err.index !== 'number' && typeof err.lineNumber !== 'number') return err.message;
  const idx = typeof err.index === 'number' ? err.index : null;
  const where = err.lineNumber ? `line ${err.lineNumber}, column ${err.column}` : `offset ${idx}`;
  let what = '';
  if (idx !== null && idx < code.length) {
    const cp = code.codePointAt(idx);
    what = ` (character U+${cp.toString(16).toUpperCase().padStart(4, '0')})`;
    const ctx = code.slice(Math.max(0, idx - 30), idx + 30).replace(/\s+/g, ' ');
    what += `\n  near: ${JSON.stringify(ctx)}`;
  }
  return `${err.message} at ${where}${what}`;
}
