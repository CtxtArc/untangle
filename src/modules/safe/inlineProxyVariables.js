// var b = a; b(1) -> a(1)   (both bindings constant, `a` resolves identically at every use)
import { isConstVariable, isStableBinding, declarator, readRefs, readMayPrecede } from '../../utils.js';

export default {
  name: 'inlineProxyVariables',
  run(ctx) {
    const { tree } = ctx;
    for (const scope of tree.scopeManager.scopes) {
      for (const v of scope.variables) {
        const d = declarator(v);
        if (!d || !d.init || d.init.type !== 'Identifier' || d.id.type !== 'Identifier' || !isConstVariable(v)) continue;
        const target = d.init;
        if (target.name === v.name || target.name === 'arguments') continue;
        const tv = target.variable || null;
        if (tv && !isStableBinding(tv)) continue;
        if (!tv && ['undefined', 'NaN', 'Infinity'].includes(target.name)) continue; // constants handled elsewhere
        // only reads that surely run after the declaration; the declaration stays for the others
        const reads = readRefs(v).filter((r) => !readMayPrecede(v, r.identifier));
        if (!reads.length) continue;
        if (reads.some((r) => tree.lookup(r.from, target.name) !== tv)) continue;
        for (const r of reads) ctx.replace(r.identifier, { type: 'Identifier', name: target.name });
      }
    }
    return ctx.count;
  },
};
