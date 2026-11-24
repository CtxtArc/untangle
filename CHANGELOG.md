# Changelog

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
