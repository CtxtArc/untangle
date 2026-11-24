// var a = 'str'; f(a) -> f('str')   (a declared once, never reassigned)
import { staticValue, NOT, isPrimitive, valueToNode } from '../../values.js';
import { isConstVariable, declarator, readRefs, readBeforeDeclaration } from '../../utils.js';

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
        const reads = readRefs(v);
        if (!reads.length) continue;
        if (typeof val === 'string' && val.length > LONG_STRING && reads.length > 1) continue;
        if (readBeforeDeclaration(v)) continue;
        for (const r of reads) {
          const node = valueToNode(val);
          if (node) ctx.replace(r.identifier, node);
        }
      }
    }
    return ctx.count;
  },
};
