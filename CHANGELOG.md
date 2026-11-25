# Changelog

## 0.11.1

- JScript call assignments (`dict.Item("k") = v`, `rs.Fields(0).Value = v`, `env("X") += v`) no
  longer stop untangle with "Assigning to rvalue": they are rewritten to an opaque marker-property
  write for parsing and printed back exactly as written. Blob extraction handles them too.

## 0.11.0

- `inlineConstants`: a binding whose only write is a plain `x = <constant>;` statement (declared by a
  bare `var`, possibly elsewhere) is inlined into the reads that surely run after that statement.
  String-builder fallbacks (`str1 = 'pow'; str2 = 'er'; ... v8 = str1 + str2 + ...`) collapse into
  one literal.
- `inlineSingleUseTemps`: a side-effect-free value may move past plain copies that do not write
  anything it reads (`v5 = exePath; v6 = path2; v7 = path1; v8 = ... + v5 + ...`), and only needs
  side-effect-free (not constant) code before its read. Never with `arguments`, calls, or literals.
- Top-level constants are no longer inlined when the script writes globals by computed name.

## 0.10.0

- New `normalizeDeclarations`: `x = v; ...; var x;` (an obfuscator trick that hoists every
  declaration to the end of its function and turns `const` into assignments, so that every binding
  looks reassigned) becomes `var x = v;` at the assignment. With it, a sample with five chained
  obfuscator.io string arrays resolves completely: 835 -> 170 lines.
- `resolveDecoderCalls`: removes decoder machinery (string arrays, decoders, rotators) once nothing
  outside uses it, if every statement in it touches only the machinery, its locals and pure globals.
- Fix: constants were inlined into reads that may run before the declaration: past a conditional
  block holding it (`if (c) { var x = 'a' } log(x)`), and into hoisted functions called before it
  (`f(); var x = 'a'; function f() { log(x) }`). The check is now per read and follows which
  hoisted functions code before the declaration can reach.
- Fix: `removeDeadCode` removed unused global functions even when `this[k]()` / `window[k]` /
  `with` could call them by name.
- Fix: `--rename` could pick `toString` / `constructor` from `Object.prototype` as a name and
  produce unparsable output.

## 0.9.0

- `resolveDecoderCalls` (`--dyn`): arguments no longer have to be literal primitives. Constant
  arguments now include fresh array / object literals of constants, bindings that hold a
  primitive (substituted by value), nested calls to other functions with constant arguments
  (their contexts join the prelude) and a static read of the result (`f(...).length`). Only the
  outermost call is evaluated. A sample whose payload went through a custom-alphabet base64 + a
  stream cipher + 43 offset/XOR slices now resolves completely (1193 -> 217 lines).
- Fix (`inlineSingleUseTemps`): a read inside a `var x = ...` initialiser was never matched.
  Object / array / function literals are no longer inlined (proxy-object and constant-array
  passes need them bound).
- `--extract-blobs` no longer writes an empty `manifest.json` when nothing was extracted.

## 0.8.0

- New `--rename` (library: `rename: 'auto'`): after deobfuscation, machine-generated binding
  names (`_0x4f1e`, `PREFIX38299`, long all-caps runs) get names from their use: `shell`, `fso`,
  `stream`, `http`, `exePath`, `url`, `xml`, `cmdLine`, `payload`, `pos`, `i`, `err`, `fn1`,
  `arg1`, `v1`, ... `--rename-all` (`rename: 'all'`) renames every eligible binding. Only declared
  bindings, program-wide unique names, and never where `eval` / `with` / `this[expr]` could reach
  a name at runtime. Result field `renamed`; `--stats` prints it.
- README: CLI options table, the modules added since 0.5 (`mergeAccumulators`, `foldJoinLoops`,
  `inlineSingleUseTemps`, the new `removeDeadCode` / `simplifyBranches` / `foldBuiltinCalls`
  rules), disabled-module warnings, blob language labels, a renaming section.
- `samples/fib.js`: a small obfuscator.io sample used in the README.

## 0.7.0

- `removeDeadCode`: removes IIFEs whose only effect is writing properties onto their own fresh
  arguments (`(function (a, b) { a[b] = {...}; }(function () {...}))`, used to pad droppers with
  megabytes of data tables). Every argument must be pure, written parameters must receive a fresh
  object/array/function literal, and writes that could throw or run code (setters, `__proto__`,
  read-only function properties, array `length`, non-static keys) keep the call.
- `simplifyBranches`: `if (c) {} else S` becomes `if (!c) S`, an empty `else` is dropped, and
  `if (c) {}` keeps only `c;`. `if (a); else if (b) ...` chains are left flat.
- `--extract-blobs`: text payloads are labelled with their language when it's clear: Lua source,
  PowerShell, VBScript, JavaScript, XML, HTML (`text (Lua source)`). The whole payload is scanned,
  since packed scripts often open with one long data literal.

## 0.6.0

Decoders padded with junk array writes, behind a wrapper that stores into a temp before `eval`,
now resolve with `--dyn`.

- `removeDeadCode`: `arr.push(...)`, `unshift`, `pop`, `shift`, `reverse`, `sort`, `splice`,
  `fill`, `copyWithin` statements are dead writes when the array is always a fresh literal and
  nothing else reads it (no callbacks such as sort comparators). This also makes such decoders
  side-effect free, so the sandbox accepts them.
- New `inlineSingleUseTemps`: `t = expr; use(t);` becomes `use(expr);` when `t` (declared or an
  implicit global) has exactly these two references in adjacent statements and only literals or
  constant bindings are evaluated before the read. Never into branches, loops or functions.
- Proxy functions with a single expression statement (`function f(p) { g(p); }`) are inlined at
  call sites used as statements. A body with a direct `eval` only when the function declares
  nothing besides its parameters.
- Fix: bindings in a function containing a direct `eval` are no longer removed, renamed, merged or
  inlined away (the eval'd code can reference them by name).

## 0.5.2

Fixes a dropper with a 10,596-statement `s += '...'` payload making untangle run out of memory
("Invalid string length") and stack (`RangeError` in `foldBuiltinCalls` / `resolveBuiltinCalls`).

- New `mergeAccumulators`: runs of literal appends with no read in between are merged into one
  literal before `splitRedeclarations` sees them (linear instead of materialising every prefix).
- `splitRedeclarations` leaves bindings with more than 1,000 definitions alone.
- Builtin-value checks answer "no" instead of crashing on expressions too deep to walk.

## 0.5.1

- A module that crashes (or produces unparsable code) is still disabled for the rest of the run,
  but the CLI now always says so (`warning: inlineConstants crashed and was disabled ...`) instead
  of only under `-v`, and the library returns the details in `result.problems`.

## 0.5.0

More of a WSH dropper now resolves **statically**, without `--dyn`:

- `splitRedeclarations`: `x += e` (and other compound assignments) is a definition too, so string
  accumulators (`var c = ''; c += '...'; c += '...';`) become constants.
- New `foldJoinLoops`: `for (var i = 0; i < a.length; i++) { s += a[i]; }` becomes
  `s += a.join('')` when `a` is a constant array of strings (a literal, or `.split()` of a known
  value) and the counter isn't used after the loop.
- `foldBuiltinCalls`: a regex with no metacharacters is just a string, so `.replace(/'/g, "''")`
  and `.split(/#/)` fold. Real regexes are still never evaluated statically.
- Constant arrays may now be read with a computed index (`a[i]`) and stay known.

## 0.4.1

- `removeDeadCode`: removes self-feeding junk variables, where every read only feeds the next
  write to the same variable (`if (/k/.test(v)) v += "k"; else v = "k";`,
  `try { v = v.concat("k") } catch (e) { v = "k" }`, `switch (typeof v) ...`,
  `for (var v = 0; v < 1; v++) ...`, `v = (function (p) { return p + "k" })(v)`). Whole
  `if`/`try`/`switch`/`for` statements go only when nothing in them has another side effect;
  if the variable is read anywhere else, everything is kept.

## 0.4.0

**Breaking: static by default.** Nothing from the input is executed unless `--dyn` is given
(library: `dynamic: true`; the old `unsafe` option is still honoured). In static mode the
sandboxed modules only count what they would evaluate, and the CLI reports it:
`static mode: 23 decoder calls left as-is; rerun with --dyn ...`. `--safe` is now the default
and kept as a no-op for compatibility.

- `foldBuiltinCalls` (static): string/array/number builtins on literal data (`split/join/
  reverse`, `fromCharCode`, `atob`, `parseInt`, `unescape`, `Math.*`, ...) are folded in-process
  by a whitelist interpreter. No `eval`; regex arguments and callbacks are refused (left to
  `--dyn`); `repeat`/`padStart` sizes are capped.
- Fix: a mutating method on a variable (`a.reverse()`) is never folded, and an array-valued
  constant is only treated as known when no use can mutate or leak it. Previously
  `var a=[3,1,2]; a.reverse(); y = a.join()` could fold `y` to the unreversed value, in both modes.

## 0.3.0

- `resolveConstantLoops` (sandbox): evaluates self-contained decode loops
  (`var R = ...; for (...) { R += f(constants) }`) and replaces them with their result.
- `splitRedeclarations` also splits straight-line reassignments (`s = s.split(x).join('')`), so
  in-place cleanup chains resolve.
- `removeUnreachable`: statements after `return` / `throw` / `break` / `continue` /
  `WScript.Quit()` (hoisted `var` names and function declarations are kept).
- `removeDeadCode`:
  - top-level `this.NAME = ...` junk globals, when the script never reads them (and never
    reaches the global object by computed name or alias);
  - write-only statements now include `x++`, `x.k++` and compound assignments;
  - wider side-effect-free initialisers (property reads, comparisons, `new Date().getTime()`,
    `Math.*`, string methods);
  - property writes count as dead only when the binding always holds a fresh literal, so
    writes through aliases such as `var p = Parser.prototype; p.m = ...` are kept.
- `splitJoinConcat` accepts long non-ASCII junk separators (e.g. `'ῒ㆕⅞ń𐊊ᚋᇭ쪐…'`).
- New synthetic sample `samples/wsh-ps1.js` (WSH -> PowerShell via WMI) with a behaviour test.

## 0.2.1

- Input decoding: UTF-16 LE/BE (with or without BOM), UTF-8 BOM, and Windows-1252 for files that
  are not valid UTF-8 (WSH runs all of these). Previously such files failed with
  `Unexpected character '\uFFFD'`.
- JScript.Encode (`#@~^...^#~@`) scripts are detected and reported instead of failing to parse.
- Parse errors now report line, column, the offending code point and the surrounding text.

## 0.2.0

- WSH / JScript dropper support:
  - `splitRedeclarations`: straight-line re-declarations get their own names.
  - `splitJoinConcat` (heuristic): junk-separator removal over concatenations with runtime parts.
  - `removeDeadCode` handles bindings declared many times and drops their write-only statements.
  - `resolveBuiltinCalls` follows constant variables: whole `split/join` chains resolve in one step.
  - `x + 'a' + 'b'` folds to `x + 'ab'`.
- String limits raised to 64 MB (multi-MB payload blobs).
- `--extract-blobs <dir>`: long literals to files, base64 decoded, type identified, SHA-256 manifest.

## 0.1.0

- Engine: espree + eslint-scope + escodegen (patched for class fields), fixpoint loop.
- Static modules: constant folding, computed members, dead branches, sequences, constant / proxy
  inlining, proxy objects and functions, control-flow unflattening, eval shells, dead code.
- Sandboxed modules: builtin calls, packer `eval` arguments, string-array decoders.
- CLI, test suite, synthetic obfuscator.io-style and packer samples.
