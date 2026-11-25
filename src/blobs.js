// Pull long string literals (embedded payloads) out of the deobfuscated code into files,
// decode base64 ones and identify what they are. Nothing extracted is ever executed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Tree, walk } from './ast.js';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function identify(buf) {
  const s = buf.subarray(0, 8);
  if (s[0] === 0x4d && s[1] === 0x5a) {
    try {
      const pe = buf.readUInt32LE(0x3c);
      if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') return 'MZ (DOS/PE, malformed header)';
      const machine = buf.readUInt16LE(pe + 4);
      const chars = buf.readUInt16LE(pe + 22);
      const arch = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'ARM64', 0x1c4: 'ARM' }[machine] || `machine 0x${machine.toString(16)}`;
      const ts = new Date(buf.readUInt32LE(pe + 8) * 1000).toISOString().slice(0, 10);
      return `PE ${arch} ${chars & 0x2000 ? 'DLL' : 'EXE'}, timestamp ${ts}`;
    } catch { return 'MZ (truncated)'; }
  }
  if (s[0] === 0x7f && buf.toString('latin1', 1, 4) === 'ELF') return 'ELF';
  if (buf.toString('latin1', 0, 4) === 'PK\x03\x04') return 'ZIP / OOXML / JAR';
  if (s[0] === 0x1f && s[1] === 0x8b) return 'gzip';
  if (buf.toString('latin1', 0, 4) === '%PDF') return 'PDF';
  if (buf.toString('latin1', 0, 3) === '\x1bLJ') return 'LuaJIT bytecode';
  if (buf.toString('latin1', 0, 4) === '\x1bLua') return 'Lua bytecode';
  if (buf.toString('latin1', 0, 6) === 'Rar!\x1a\x07') return 'RAR';
  if (buf.toString('latin1', 0, 6) === '7z\xbc\xaf\x27\x1c') return '7z';
  const text = buf.subarray(0, 4096).toString('utf8');
  if (!/[\x00-\x08\x0e-\x1f]/.test(text)) {
    // whole payload (up to 4 MB): packed scripts often open with one long data literal
    const lang = textLanguage(buf.subarray(0, 4 * 1024 * 1024).toString('utf8'));
    return lang ? `text (${lang})` : 'text';
  }
  return 'data';
}

const count = (s, re) => (s.match(re) || []).length;

/** Best guess at the language of a script payload, or null. Conservative: needs several tells. */
export function textLanguage(s) {
  const head = s.slice(0, 512).trimStart();
  if (/^<\?xml\b/i.test(head)) return 'XML';
  if (/^<(!doctype html|html\b)/i.test(head)) return 'HTML';
  // `local x = ...` / `local a, b = ...` / `local function f` are the tells; `then`, `elseif`, `~=` add up
  const luaDecl = count(s, /\blocal\s+(function\s+[A-Za-z_]|[A-Za-z_]\w*(\s*,\s*[A-Za-z_]\w*)*\s*=[^=])/g);
  const lua = luaDecl + count(s, /\bthen\b/g) + count(s, /\belseif\b/g) + count(s, /~=/g);
  const luaEnd = count(s, /\bend\b/g);
  const js = count(s, /\b(var|let|const)\s+[A-Za-z_$]/g) + count(s, /=>/g) + count(s, /===|!==/g);
  const ps = count(s, /\$[A-Za-z_]\w*\s*=/g);
  const psTells = /\bNew-Object\b|\[(System\.|Convert\]|Text\.Encoding|IO\.)|\b(Invoke-\w+|Add-Type|Start-Process|Get-\w+|Set-\w+)\b|\s-(join|split|replace|bxor|eq|ne)\b/i.test(s);
  // constructs JavaScript never has (`function` alone would match JS, VBScript being case-insensitive)
  const vbs = count(s, /^\s*(Dim\s+\w|End\s+(Sub|Function|If)\b|On\s+Error\s+Resume\s+Next\b|Set\s+\w+\s*=\s*\w)/gim);
  if (luaDecl >= 3 && lua >= 5 && luaEnd >= 2 && lua > js) return 'Lua source';
  if (ps >= 3 && psTells) return 'PowerShell';
  if (vbs >= 3) return 'VBScript';
  if (js >= 3 && count(s, /[;{}]/g) >= 10) return 'JavaScript';
  return null;
}

function asBase64(str) {
  const s = str.replace(/[\r\n\s]/g, '');
  if (s.length < 16 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  return Buffer.from(s, 'base64');
}

const human = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/**
 * @returns {{ code: string, blobs: object[] }}
 */
export function extractBlobs(code, dir, { minLength = 2048 } = {}) {
  const tree = new Tree(code);
  fs.mkdirSync(dir, { recursive: true });
  const blobs = [];
  walk(tree.ast, (n) => {
    if (n.type !== 'Literal' || typeof n.value !== 'string' || n.value.length < minLength) return;
    const id = blobs.length + 1;
    const raw = Buffer.from(n.value, 'utf8');
    const entry = { id, chars: n.value.length, sha256_text: sha256(raw) };
    const base = `blob${id}_${entry.sha256_text.slice(0, 12)}`;
    const decoded = asBase64(n.value);
    if (decoded) {
      entry.encoding = 'base64';
      entry.type = identify(decoded);
      entry.bytes = decoded.length;
      entry.sha256 = sha256(decoded);
      entry.file = `${base}.bin`;
      fs.writeFileSync(path.join(dir, entry.file), decoded);
    } else {
      entry.type = identify(raw);
      entry.sha256 = entry.sha256_text;
      entry.file = `${base}.txt`;
      fs.writeFileSync(path.join(dir, entry.file), raw);
    }
    blobs.push(entry);
    n.value = `[untangle blob ${id}: ${entry.encoding ? 'base64 -> ' : ''}${entry.type}, ${human(entry.bytes || raw.length)}, ` +
      `sha256 ${entry.sha256}, saved as ${entry.file}]`;
    delete n.raw;
  });
  if (!blobs.length) return { code: tree.generate(), blobs }; // nothing extracted: leave the directory alone
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(blobs, null, 2) + '\n');
  return { code: tree.generate(), blobs };
}
