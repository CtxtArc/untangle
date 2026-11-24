# Changelog

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
