// function w(a, b) { return dec(b - 0x1a, a); }   w('k', 0x20) -> dec(0x20 - 0x1a, 'k')
// function s() { return 'str'; }                   s() -> 'str'
import { isConstVariable, readRefs, inlineCall } from '../../utils.js';

function candidates(tree) {
  const out = [];
  for (const fn of tree.ofType('FunctionDeclaration')) {
    if (fn.id && fn.id.variable) out.push([fn.id.variable, fn]);
  }
  for (const d of tree.ofType('VariableDeclarator')) {
    if (d.id.type === 'Identifier' && d.init && /^(FunctionExpression|ArrowFunctionExpression)$/.test(d.init.type) && d.id.variable) {
      out.push([d.id.variable, d.init]);
    }
  }
  return out;
}

export default {
  name: 'inlineProxyFunctions',
  run(ctx) {
    const { tree } = ctx;
    for (const [v, fn] of candidates(tree)) {
      if (!isConstVariable(v)) continue;
      for (const r of readRefs(v)) {
        const call = r.identifier.parent;
        if (!call || call.type !== 'CallExpression' || call.callee !== r.identifier || call.optional) continue;
        if (!ctx.canReplace(call)) continue;
        const expr = inlineCall(fn, call, tree, ctx.cache);
        if (expr) ctx.replace(call, expr);
      }
    }
    return ctx.count;
  },
};
