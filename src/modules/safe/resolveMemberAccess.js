// ['a','b'][1] -> 'b' ; 'abc'.length -> 3 ; 'abc'[0] -> 'a'
// var arr = ['log', 'x']; console[arr[0]](arr[1]) -> console['log']('x')   (arr never mutated / escaping)
import { staticValue, NOT, isPrimitive, valueToNode, propName } from '../../values.js';
import { isConstVariable, declarator, readBeforeDeclaration, isWriteTarget } from '../../utils.js';

function lookupIndex(container, name) {
  if (name === 'length') return container.length;
  if (!/^(0|[1-9]\d*)$/.test(name)) return NOT;
  const i = Number(name);
  if (i >= container.length) return NOT; // keep out-of-range reads untouched
  return typeof container === 'string' ? container[i] : container[i];
}

function readOnlyMember(m) {
  return !isWriteTarget(m) && !(m.parent.type === 'CallExpression' && m.parent.callee === m);
}

export default {
  name: 'resolveMemberAccess',
  run(ctx) {
    const { tree } = ctx;
    const c = ctx.cache;
    // literal containers
    for (const m of tree.ofType('MemberExpression')) {
      if (m.object.type !== 'Literal' && m.object.type !== 'ArrayExpression') continue;
      const obj = staticValue(m.object, c);
      if (typeof obj !== 'string' && !Array.isArray(obj)) continue;
      if (!readOnlyMember(m)) continue;
      const name = propName(m, c);
      if (name === NOT) continue;
      const v = lookupIndex(obj, name);
      if (v === NOT || !isPrimitive(v)) continue;
      const node = valueToNode(v);
      if (node) ctx.replace(m, node);
    }
    // constant arrays bound to variables
    for (const scope of tree.scopeManager.scopes) {
      for (const v of scope.variables) {
        const d = declarator(v);
        if (!d || !d.init || d.init.type !== 'ArrayExpression' || !isConstVariable(v)) continue;
        const arr = staticValue(d.init, c);
        if (!Array.isArray(arr) || !arr.every(isPrimitive)) continue;
        const reads = v.references.filter((r) => r.isRead());
        if (!reads.length || readBeforeDeclaration(v)) continue;
        const plan = [];
        let ok = true;
        for (const r of reads) {
          const m = r.identifier.parent;
          if (!m || m.type !== 'MemberExpression' || m.object !== r.identifier || !readOnlyMember(m)) { ok = false; break; }
          const name = propName(m, c);
          const val = name === NOT ? NOT : lookupIndex(arr, name);
          if (val === NOT) { ok = false; break; }
          plan.push([m, val]);
        }
        if (!ok) continue; // the array escapes or is mutated somewhere
        for (const [m, val] of plan) ctx.replace(m, valueToNode(val));
      }
    }
    return ctx.count;
  },
};
