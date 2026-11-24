#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { deobfuscate, ALL_MODULES } from '../src/index.js';
import { SANDBOX_FLAGS } from '../src/sandbox/runner.js';
import { extractBlobs } from '../src/blobs.js';
import { decodeSource, describeParseError, InputError } from '../src/input.js';

const HELP = `untangle - JavaScript deobfuscator for malware reversing

Usage: untangle [options] <input.js | ->

Options:
  -o, --output <file>       write result to file (default: stdout)
      --dyn                 also run the sandboxed modules, which EXECUTE fragments of the sample
                            (decoders, builtin calls, decode loops, packer bodies). Off by default.
  -s, --safe                static transforms only (the default; kept for compatibility)
      --max-iterations <n>  iteration cap (default 100)
      --rename              give machine-generated names (_0x4f1e, PREFIX38299) readable names from
                            their use: shell, fso, stream, url, exePath, i, err, fn1, arg1, v1, ...
      --rename-all          like --rename, but rename every eligible binding, not only generated ones
      --keep-globals        do not remove unused top-level declarations (and never rename them)
      --no-dead-code        do not remove unused declarations at all
      --disable <a,b,...>   disable modules by name (see --list-modules)
      --timeout <ms>        per-call sandbox timeout (default 1000)
      --no-side-effect-check  accept decoder results even if a call changes global state
      --extract-blobs <dir> move string literals >= --blob-min chars into files (base64 is
                            decoded and identified: PE/ELF/ZIP/...); writes manifest.json
      --blob-min <n>        minimum length for --extract-blobs (default 2048)
      --stats               print per-module change counts to stderr
  -v, --verbose             log every module run to stderr
      --list-modules        list transformation modules and exit
      --version             print the version
  -h, --help                show this help

By default nothing from the input is executed: untangle only parses and rewrites it, and reports
what --dyn could additionally resolve. With --dyn, fragments run in a sandbox (separate Node
process, permission model${SANDBOX_FLAGS.length ? '' : ' UNAVAILABLE on this Node'}, vm context with no host objects). That is defense in
depth, not a security boundary: only use --dyn on hostile samples inside an isolated VM.`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      safe: { type: 'boolean', short: 's' },
      dyn: { type: 'boolean' },
      'max-iterations': { type: 'string' },
      'keep-globals': { type: 'boolean' },
      rename: { type: 'boolean' },
      'rename-all': { type: 'boolean' },
      'no-dead-code': { type: 'boolean' },
      disable: { type: 'string' },
      timeout: { type: 'string' },
      'no-side-effect-check': { type: 'boolean' },
      stats: { type: 'boolean' },
      'extract-blobs': { type: 'string' },
      'blob-min': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      'list-modules': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
} catch (err) {
  console.error(err.message + '\n\n' + HELP);
  process.exit(2);
}
const o = args.values;

if (o.help) { console.log(HELP); process.exit(0); }
if (o.version) {
  console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
if (o['list-modules']) {
  for (const m of ALL_MODULES) console.log(`${m.unsafe ? 'sandbox' : 'static '}  ${m.name}`);
  process.exit(0);
}
if (args.positionals.length !== 1) { console.error(HELP); process.exit(2); }
if (o.safe && o.dyn) { console.error('untangle: --safe and --dyn are mutually exclusive'); process.exit(2); }

const raw = args.positionals[0] === '-' ? fs.readFileSync(0) : fs.readFileSync(args.positionals[0]);
let input;
try {
  const decoded = decodeSource(raw);
  input = decoded.code;
  if (o.verbose || !decoded.encoding.startsWith('utf-8')) console.error(`input encoding: ${decoded.encoding}`);
} catch (err) {
  if (err instanceof InputError) { console.error(`untangle: ${err.message}`); process.exit(1); }
  throw err;
}
const known = new Set(ALL_MODULES.map((m) => m.name));
const disable = (o.disable || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const d of disable) if (!known.has(d)) { console.error(`unknown module: ${d}`); process.exit(2); }

let result;
try {
  result = deobfuscate(input, {
    dynamic: !!o.dyn,
    maxIterations: o['max-iterations'] ? Number(o['max-iterations']) : undefined,
    keepGlobals: !!o['keep-globals'],
    rename: o['rename-all'] ? 'all' : o.rename ? 'auto' : false,
    removeDeadCode: !o['no-dead-code'],
    disable,
    verbose: !!o.verbose,
    sandbox: {
      timeout: o.timeout ? Number(o.timeout) : undefined,
      checkSideEffects: !o['no-side-effect-check'],
    },
  });
} catch (err) {
  console.error(`untangle: ${describeParseError(err, input)}`);
  process.exit(1);
}

let out = result.code;
if (o['extract-blobs']) {
  const { code, blobs } = extractBlobs(out, o['extract-blobs'], { minLength: o['blob-min'] ? Number(o['blob-min']) : undefined });
  out = code;
  for (const b of blobs) console.error(`blob ${b.id}: ${b.type}, ${b.bytes ?? b.chars} ${b.bytes ? 'bytes' : 'chars'}, sha256 ${b.sha256} -> ${b.file}`);
}

if (o.output) fs.writeFileSync(o.output, out + '\n');
else process.stdout.write(out + '\n');

const MODULE_UNITS = {
  resolveBuiltinCalls: 'builtin call',
  resolveEvalArguments: 'eval/Function argument',
  resolveConstantLoops: 'decode loop',
  resolveDecoderCalls: 'decoder call',
};
const pending = Object.entries(result.pending || {});
if (!result.dynamic && pending.length) {
  const what = pending.map(([m, n]) => `${n} ${MODULE_UNITS[m] || m}${n > 1 ? 's' : ''}`).join(', ');
  console.error(`static mode: ${what} left as-is; rerun with --dyn to evaluate them (executes sample code: isolated VM only)`);
}

for (const p of result.problems || []) {
  const first = p.error.split('\n').slice(0, 2).join(' | ');
  console.error(`warning: ${p.module} ${p.reason} and was disabled for this run, so output may be incomplete: ${first}`);
}

if (o.stats || o.verbose) {
  console.error(`iterations: ${result.iterations}`);
  if (result.renamed) console.error(`  renamed bindings       ${result.renamed}`);
  for (const [k, v] of Object.entries(result.stats)) console.error(`  ${k.padEnd(22)} ${v}`);
}
