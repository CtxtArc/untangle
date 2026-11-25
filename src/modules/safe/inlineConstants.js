// var a = 'str'; f(a) -> f('str')   (a declared once, never reassigned)
// a = 'str'; f(a)     -> f('str')   (assigned exactly once by a plain statement; reads that surely run after it)
import { staticValue, NOT, isPrimitive, valueToNode } from '../../values.js';
import { isConstVariable, declarator, readRefs, readMayPrecede, mayPrecedeStatement } from '../../utils.js';
import { evalCanSee, globalsReachable } from './cleanup.js';

const LONG_STRING = 200;

/** `x = <constant>;` as the only write of a binding declared by bare `var x` declarators. */
function assignedOnce(ctx, v, globalsByName) {
  if (!v.defs.length || evalCanSee(v.scope) || (v.scope.type === 'global' && (globalsByName || ctx.options.keepGlobals))) return;
  if (!v.defs.every((d) => d.type === 'Variable' && d.parent.kind === 'var' && !d.node.init && d.node.id.type === 'Identifier' &&
      !/^For(In|Of)?Statement$/.test(d.parent.parent.type))) return;
  const writes = v.references.filter((r) => r.isWrite());
  if (writes.length !== 1 || writes[0].isRead()) return;
  const id = writes[0].identifier;
  const a = id.parent;
  const st = a && a.parent;
  if (!a || a.type !== 'AssignmentExpression' || a.operator !== '=' || a.left !== id || !st || st.type !== 'ExpressionStatement' || st.expression !== a) return;
  const val = staticValue(a.right, ctx.cache);
  if (val === NOT || !isPrimitive(val)) return;
  const all = v.references.filter((r) => r.isRead());
  const reads = all.filter((r) => !mayPrecedeStatement(st, r.identifier));
  if (!reads.length || (typeof val === 'string' && val.length > LONG_STRING && all.length > 1)) return;
  for (const r of reads) {
    const node = valueToNode(val);
    if (node) ctx.replace(r.identifier, node);
  }
}

export default {
  name: 'inlineConstants',
  run(ctx) {
    const { tree } = ctx;
    const globalsByName = globalsReachable(tree);
    for (const scope of tree.scopeManager.scopes) {
      for (const v of scope.variables) {
        const d = declarator(v);
        if (!d || !d.init || d.id.type !== 'Identifier' || !isConstVariable(v)) {
          assignedOnce(ctx, v, globalsByName);
          continue;
        }
        if (v.scope.type === 'global' && globalsByName) continue; // this[k] = ... could overwrite it
        const val = staticValue(d.init, ctx.cache);
        if (val === NOT || !isPrimitive(val)) continue;
        const all = readRefs(v);
        // only reads that surely run after the declaration; the declaration stays for the others
        const reads = all.filter((r) => !readMayPrecede(v, r.identifier));
        if (!reads.length) continue;
        if (typeof val === 'string' && val.length > LONG_STRING && all.length > 1) continue;
        for (const r of reads) {
          const node = valueToNode(val);
          if (node) ctx.replace(r.identifier, node);
        }
      }
    }
    return ctx.count;
  },
};
