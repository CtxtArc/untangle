// Character-by-character string assembly loops over a constant array of strings:
//   var parts = ['', 'w', 'in', 'mgmts'];
//   for (var i = 0; i < parts.length; i++) { out += parts[i]; }     ->   out += parts.join('');
// `join` then folds statically, and the accumulator becomes a plain constant.
//
// Only rewritten when every element is known to be a string (an array literal of strings, or the
// result of `.split()` on a known value) - `s += undefined` would add "undefined" where join adds
// nothing - and the counter is not used anywhere outside the loop.
import { isBuiltinValue, materialize } from '../../builtins.js';
import { staticValue, propName } from '../../values.js';
import { inStatementList } from '../../ast.js';
import { isInside } from '../../utils.js';

const ident = (n, name) => n && n.type === 'Identifier' && (!name || n.name === name);

function counterName(init) {
  if (!init) return null;
  if (init.type === 'VariableDeclaration' && init.declarations.length === 1) {
    const d = init.declarations[0];
    return ident(d.id) && d.init && d.init.type === 'Literal' && d.init.value === 0 ? d.id.name : null;
  }
  if (init.type === 'AssignmentExpression' && init.operator === '=' && ident(init.left) &&
      init.right.type === 'Literal' && init.right.value === 0) return init.left.name;
  return null;
}

function stepsByOne(u, i) {
  if (!u) return false;
  if (u.type === 'UpdateExpression') return u.operator === '++' && ident(u.argument, i);
  return u.type === 'AssignmentExpression' && u.operator === '+=' && ident(u.left, i) && u.right.type === 'Literal' && u.right.value === 1;
}

function onlyStatement(body) {
  if (body.type !== 'BlockStatement') return body;
  return body.body.length === 1 ? body.body[0] : null;
}

/** Is `arr` (an identifier) bound to an array whose elements are all strings? */
function stringArray(arr, cache) {
  if (!isBuiltinValue(arr, cache)) return false;
  const m = materialize(arr, cache);
  if (m.type === 'ArrayExpression') {
    const v = staticValue(m, cache);
    return Array.isArray(v) && v.every((e) => typeof e === 'string');
  }
  return m.type === 'CallExpression' && m.callee.type === 'MemberExpression' && propName(m.callee, cache) === 'split';
}

export default {
  name: 'foldJoinLoops',
  run(ctx) {
    const { tree } = ctx;
    for (const loop of tree.ofType('ForStatement')) {
      if (!inStatementList(loop)) continue;
      const i = counterName(loop.init);
      if (!i) continue;
      const t = loop.test;
      if (!t || t.type !== 'BinaryExpression' || t.operator !== '<' || !ident(t.left, i)) continue;
      const len = t.right;
      if (len.type !== 'MemberExpression' || len.computed || !ident(len.property, 'length') || !ident(len.object)) continue;
      const arr = len.object;
      if (arr.name === i || !stepsByOne(loop.update, i)) continue;
      const st = onlyStatement(loop.body);
      if (!st || st.type !== 'ExpressionStatement') continue;
      const a = st.expression;
      if (a.type !== 'AssignmentExpression' || a.operator !== '+=' || !ident(a.left)) continue;
      const acc = a.left.name;
      if (acc === i || acc === arr.name) continue;
      const r = a.right;
      if (r.type !== 'MemberExpression' || !r.computed || !ident(r.object, arr.name) || !ident(r.property, i)) continue;
      // same bindings for both array references; the accumulator is not the array
      if (r.object.variable !== arr.variable || !arr.variable) continue;
      // the counter: one binding, used only inside this loop
      const iv = (loop.init.type === 'VariableDeclaration' ? loop.init.declarations[0].id : loop.init.left).variable;
      if (!iv || [...iv.references.map((x) => x.identifier), ...iv.defs.map((d) => d.name)].some((n) => !isInside(n, loop))) continue;
      if (!stringArray(arr, ctx.cache)) continue;
      ctx.replace(loop, {
        type: 'ExpressionStatement',
        expression: {
          type: 'AssignmentExpression', operator: '+=', left: { type: 'Identifier', name: acc },
          right: {
            type: 'CallExpression', optional: false,
            callee: { type: 'MemberExpression', computed: false, optional: false, object: { type: 'Identifier', name: arr.name }, property: { type: 'Identifier', name: 'join' } },
            arguments: [{ type: 'Literal', value: '', raw: "''" }],
          },
        },
      });
    }
    return ctx.count;
  },
};
