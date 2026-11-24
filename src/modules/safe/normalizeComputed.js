// a['b'] -> a.b ; {'b': 1} -> {b: 1} ; class { ['m']() {} } -> class { m() {} }
import { staticValue, NOT, isValidIdentifier } from '../../values.js';

export default {
  name: 'normalizeComputed',
  run(ctx) {
    let n = 0;
    for (const node of ctx.tree.ofType('MemberExpression', 'Property', 'MethodDefinition', 'PropertyDefinition')) {
      if (node.type === 'MemberExpression') {
        if (!node.computed) continue;
        const v = staticValue(node.property, ctx.cache);
        if (typeof v !== 'string' || !isValidIdentifier(v)) continue;
        node.property = { type: 'Identifier', name: v };
        node.computed = false;
        n++;
      } else {
        const key = node.key;
        if (!key || key.type === 'PrivateIdentifier') continue;
        if (node.computed) {
          const v = staticValue(key, ctx.cache);
          if (v === NOT || typeof v === 'object') continue;
          // computed and plain keys differ in meaning for these names
          if (['__proto__', 'constructor', 'prototype'].includes(String(v))) continue;
          if (typeof v === 'string' && isValidIdentifier(v)) node.key = { type: 'Identifier', name: v };
          else if (typeof v === 'string' || (typeof v === 'number' && v >= 0 && Number.isFinite(v))) node.key = { type: 'Literal', value: v };
          else continue;
          node.computed = false;
          n++;
        } else if (key.type === 'Literal' && typeof key.value === 'string' && isValidIdentifier(key.value)) {
          if (node.type === 'Property' && node.shorthand) continue;
          node.key = { type: 'Identifier', name: key.value };
          n++;
        }
      }
    }
    ctx.count += n;
    return n;
  },
};
