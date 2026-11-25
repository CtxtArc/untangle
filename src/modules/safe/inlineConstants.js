// var a = 'str'; f(a) -> f('str')   (a declared once, never reassigned)
import { staticValue, NOT, isPrimitive, valueToNode } from '../../values.js';
import { isConstVariable, declarator, readRefs, readMayPrecede } from '../../utils.js';

const LONG_STRING = 200;

export default {
  name: 'inlineConstants',
  run(ctx) {
    const { tree } = ctx;
    for (const scope of tree.scopeManager.scopes) {
      for (const v of scope.variables) {
        const d = declarator(v);
        if (!d || !d.init || d.id.type !== 'Identifier' || !isConstVariable(v)) continue;
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
