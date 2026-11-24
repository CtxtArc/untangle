// obfuscator.io "proxy objects":
//   var o = { 'aBc': function (a, b) { return a + b; }, 'xYz': 'log' };
//   o['aBc'](x, 1) -> x + 1 ;  console[o.xYz] -> console['log']
// Only when `o` is constant and every use is a static, read-only member access.
import { staticValue, NOT, isPrimitive, valueToNode, propName } from '../../values.js';
import { isConstVariable, declarator, readRefs, readBeforeDeclaration, isWriteTarget, inlineCall } from '../../utils.js';

function collectProps(obj, cache) {
  const props = new Map();
  for (const p of obj.properties) {
    if (p.type !== 'Property' || p.kind !== 'init' || p.method && p.value.type !== 'FunctionExpression') return null;
    const name = propName(p, cache);
    if (name === NOT || props.has(name)) return null;
    props.set(name, p.value);
  }
  return props;
}

export default {
  name: 'resolveProxyObjects',
  run(ctx) {
    const { tree } = ctx;
    const c = ctx.cache;
    for (const scope of tree.scopeManager.scopes) {
      for (const v of scope.variables) {
        const d = declarator(v);
        if (!d || !d.init || d.init.type !== 'ObjectExpression' || d.id.type !== 'Identifier' || !isConstVariable(v)) continue;
        const props = collectProps(d.init, c);
        if (!props || !props.size) continue;
        const reads = readRefs(v);
        if (!reads.length || readBeforeDeclaration(v)) continue;
        const uses = [];
        let ok = true;
        for (const r of reads) {
          const m = r.identifier.parent;
          if (!m || m.type !== 'MemberExpression' || m.object !== r.identifier || isWriteTarget(m)) { ok = false; break; }
          const name = propName(m, c);
          if (name === NOT || !props.has(name)) { ok = false; break; }
          uses.push([m, props.get(name)]);
        }
        if (!ok) continue;
        for (const [m, value] of uses) {
          const isCall = m.parent.type === 'CallExpression' && m.parent.callee === m;
          if (/^(FunctionExpression|ArrowFunctionExpression)$/.test(value.type)) {
            if (!isCall || !ctx.canReplace(m.parent)) continue;
            const expr = inlineCall(value, m.parent, tree, c);
            if (expr) ctx.replace(m.parent, expr);
          } else {
            const val = staticValue(value, c);
            if (val === NOT || !isPrimitive(val) || isCall) continue;
            ctx.replace(m, valueToNode(val));
          }
        }
      }
    }
    return ctx.count;
  },
};
