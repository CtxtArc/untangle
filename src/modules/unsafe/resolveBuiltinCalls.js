// Evaluate builtin calls on known values inside the sandbox:
//   'dlrow'.split('').reverse().join('')  -> 'world'
//   String.fromCharCode(104, 105)         -> 'hi'
//   atob('aGk=')                          -> 'hi'
// Constant bindings are followed, so a whole chain like
//   var a = '...'; var b = a.split('?').join(''); var c = b.split('!').join(''); use(c);
// is evaluated in one go (use('...')); the unused intermediates are then dead code.
import { valueToNode } from '../../values.js';
import { runJobs, fromSandbox } from '../../sandbox/runner.js';
import { isWriteTarget, declarator, readRefs } from '../../utils.js';
import { generate } from '../../codegen.js';
import { isBuiltinValue, materialize } from '../../builtins.js';

export default {
  name: 'resolveBuiltinCalls',
  unsafe: true,
  run(ctx) {
    const { tree } = ctx;
    const memo = new Map();
    const cands = tree.ofType('CallExpression').filter((c) => isBuiltinValue(c, ctx.cache, memo) && !isWriteTarget(c));
    const set = new Set(cands);
    const covered = (node) => { for (let p = node; p; p = p.parent) if (set.has(p)) return true; return false; };
    const outer = cands.filter((c) => {
      for (let p = c.parent; p; p = p.parent) if (set.has(p)) return false;
      // initializer of a constant whose every use is absorbed by another candidate
      const d = c.parent;
      if (d.type === 'VariableDeclarator' && d.init === c && d.id.type === 'Identifier' && d.id.variable &&
          declarator(d.id.variable) === d) {
        const reads = readRefs(d.id.variable);
        if (reads.length && reads.every((r) => covered(r.identifier))) return false;
      }
      return true;
    });
    if (!outer.length) return 0;
    const exprs = outer.map((c) => generate(materialize(c, ctx.cache)));
    const [res] = runJobs([{ prelude: '', exprs }], ctx.options.sandbox);
    if (!res || res.error) { ctx.log(`resolveBuiltinCalls: ${res && res.error}`); return 0; }
    res.values.forEach((r, i) => {
      if (!r.ok) return;
      const node = valueToNode(fromSandbox(r.v));
      if (node) ctx.replace(outer[i], node);
    });
    return ctx.count;
  },
};
