# Contributing

Thanks for helping untangle more JavaScript. The rules below are what keep the output trustworthy.

## Ground rules

1. **A transform must not change behaviour.** If it is only true under an assumption, it is a
   heuristic: say so in the module header, make it fire only when the assumption is obviously
   safe, and mention it in the README module table (⚠).
2. **Sample code never runs outside the sandbox.** Anything that evaluates sample code goes in
   `src/modules/unsafe/` and goes through `src/sandbox/runner.js`.
3. **Never commit live malware** (scripts, payloads, extracted blobs). Tests use synthetic
   look-alikes: write the smallest snippet that reproduces the pattern.

## Layout

```
src/index.js          engine: fixpoint loop and module order
src/ast.js            parse (espree), parent links, eslint-scope bindings, splice/remove fixup
src/context.js        conflict-free edits inside one module run
src/values.js         static evaluation, value <-> node, purity
src/builtins.js       which builtin calls are side-effect free; constant materialisation
src/utils.js          scope helpers, proxy-call inliner
src/modules/safe/     static transforms
src/modules/unsafe/   sandboxed transforms
src/sandbox/          child-process runner + vm worker
src/blobs.js          --extract-blobs (payload files, type and language labels)
src/rename.js         --rename (usage-based names; runs once after the fixpoint)
```

## Writing a module

A module is `{ name, run(ctx) }` and returns the number of changes:

```js
export default {
  name: 'myTransform',
  run(ctx) {
    for (const node of ctx.tree.ofType('CallExpression')) {
      // node.parent, node.variable (Identifiers), ctx.tree.scopeAt(node), ctx.tree.lookup(scope, name)
      if (/* pattern matches and is safe */ false) ctx.replace(node, { type: 'Literal', value: 'x' });
    }
    return ctx.count;
  },
};
```

- Use `ctx.replace`, `ctx.remove` and `ctx.splice` only, never mutate parents directly. They refuse
  edits that would conflict with earlier ones in the same run; the engine regenerates and
  re-parses after every module, so a refused edit simply happens on the next iteration.
- When several edits must happen together (e.g. a declaration and all its uses), check
  `ctx.canReplaceAll([...])` first.
- Scope facts come from eslint-scope: `Identifier.variable` is the binding (or `null` for
  globals). Check `isConstVariable`, `readBeforeDeclaration` and shadowing (`tree.lookup`) before
  moving code to a new place.
- A transform that removes, renames, merges or moves a binding must skip scopes where a direct
  `eval` could read it by name: use `evalCanSee(scope)` from `src/modules/safe/cleanup.js`.
- Register the module in `src/index.js`. Order matters: cheap, enabling transforms first.
- Document it: a row in the README module table (and the CLI options table / a section for any
  new flag), plus a CHANGELOG entry.

## Tests

`npm test` runs `node:test`. Add cases to `test/untangle.test.js`:

```js
same('input code', 'expected code');     // compared after normalising formatting
unchanged('code that must be left alone');
```

Include at least one negative case (a near-miss the module must leave alone). For
end-to-end samples, compare **behaviour** of input and output (see the obfuscator.io test).

`npm run samples` regenerates the synthetic samples in `samples/`.
