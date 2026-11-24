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
  if (!/[\x00-\x08\x0e-\x1f]/.test(text)) return 'text';
  return 'data';
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
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(blobs, null, 2) + '\n');
  return { code: tree.generate(), blobs };
}
