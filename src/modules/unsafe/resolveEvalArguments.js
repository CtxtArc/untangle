// eval(<self-contained expression>) -> eval('<computed source>'), which unwrapEval then inlines.
// Covers Dean Edwards' packer `eval(function (p, a, c, k, e, d) {...}('...', 62, 120, '...'.split('|'), 0, {}))`,
// eval(atob('...')), eval(unescape('...')), etc. The argument may only reference globals
// (no local bindings), so it can be evaluated without any surrounding context.
import { walk } from '../../ast.js';
import { staticValue } from '../../values.js';
import { isInside } from '../../utils.js';
import { runJobs, fromSandbox } from '../../sandbox/runner.js';
import { generate } from '../../codegen.js';

function selfContained(expr) {
  let ok = true;
  walk(expr, (n) => {
    if (!ok) return false;
    if (n.type === 'Identifier' && n.variable) {
      const def = n.variable.defs[0];
      if (!def || !isInside(def.name, expr)) ok = false;
    }
    if (n.type === 'ThisExpression' && !isInside(n, expr)) ok = false;
    return undefined;
  });
  return ok;
}

export default {
  name: 'resolveEvalArguments',
  unsafe: true,
  run(ctx) {
    const targets = [];
    for (const call of ctx.tree.ofType('CallExpression')) {
      const cal = call.callee;
      const isEval = cal.type === 'Identifier' && cal.name === 'eval' && !cal.variable;
      const isFn = (cal.type === 'Identifier' && cal.name === 'Function' && !cal.variable) && call.parent.type === 'CallExpression';
      if ((!isEval && !isFn) || call.arguments.length !== 1) continue;
      const arg = call.arguments[0];
      if (typeof staticValue(arg, ctx.cache) === 'string' || !selfContained(arg)) continue;
      targets.push(arg);
    }
    if (!targets.length) return 0;
    if (ctx.options.planOnly) { ctx.planned = targets.length; return 0; } // static mode: count, never run
    const [res] = runJobs([{ prelude: '', exprs: targets.map((t) => generate(t)) }], ctx.options.sandbox);
    if (!res || res.error) { ctx.log(`resolveEvalArguments: ${res && res.error}`); return 0; }
    res.values.forEach((r, i) => {
      if (!r.ok) return;
      const v = fromSandbox(r.v);
      if (typeof v === 'string') ctx.replace(targets[i], { type: 'Literal', value: v });
    });
    return ctx.count;
  },
};
