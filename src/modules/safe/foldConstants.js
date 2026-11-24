// Evaluate deterministic expressions over literals:
//   !![] -> true, 0x1f + 1 -> 32, 'a' + 'b' -> 'ab', typeof 'x' -> 'string', void 0 -> undefined
import { staticValue, NOT, isPrimitive, isCanonical, valueToNode } from '../../values.js';
import { isWriteTarget } from '../../utils.js';

const SKIP_PARENT = new Set(['TaggedTemplateExpression']);

export default {
  name: 'foldConstants',
  run(ctx) {
    for (const node of ctx.tree.nodes) {
      if (!/Expression$|^Literal$|^Identifier$|^TemplateLiteral$/.test(node.type)) continue;
      if (!node.parent || SKIP_PARENT.has(node.parent.type)) continue;
      if (isCanonical(node) || isWriteTarget(node)) continue;
      if (node.parent.type === 'ExpressionStatement' && node.parent.directive) continue;
      const v = staticValue(node, ctx.cache);
      if (v === NOT || !isPrimitive(v)) continue;
      const repl = valueToNode(v);
      if (repl) ctx.replace(node, repl);
    }
    // x + 'a' + 'b' -> x + 'ab'   ((x + 'a') is a string, so the second + concatenates)
    for (const node of ctx.tree.ofType('BinaryExpression')) {
      if (node.operator !== '+' || node.left.type !== 'BinaryExpression' || node.left.operator !== '+') continue;
      const a = staticValue(node.left.right, ctx.cache);
      const b = staticValue(node.right, ctx.cache);
      if (typeof a !== 'string' || b === NOT || !isPrimitive(b) || typeof b === 'symbol') continue;
      if (staticValue(node.left, ctx.cache) !== NOT) continue; // fully static: handled above
      ctx.replace(node, { type: 'BinaryExpression', operator: '+', left: node.left.left, right: { type: 'Literal', value: a + String(b) } });
    }
    return ctx.count;
  },
};
