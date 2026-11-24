// Junk-character removal over concatenations that contain a runtime value (WSH droppers):
//   var p = folder + '\\' + '♉♉♉ev♉♉♉il.e♉♉♉xe';  run(p.split('♉♉♉').join(''))
//   -> var p = folder + '\\' + 'evil.exe';        run(p)
//
// HEURISTIC: this is exact only if the runtime parts (`folder`) never contain a character of
// the separator. It only fires when the separator has no letters or digits and actually
// occurs in the literal parts, i.e. when it is obviously junk. Disable with
// --disable splitJoinConcat.
import { staticValue, NOT } from '../../values.js';
import { clone } from '../../ast.js';
import { isConstVariable, declarator, readRefs, readBeforeDeclaration, identifiersIn } from '../../utils.js';

function concatParts(node, out = []) {
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    concatParts(node.left, out);
    out.push(node.right);
  } else {
    out.push(node);
  }
  return out;
}

function method(call, name, cache) {
  if (!call || call.type !== 'CallExpression' || call.arguments.length !== 1) return false;
  const c = call.callee;
  if (c.type !== 'MemberExpression') return false;
  const n = c.computed ? staticValue(c.property, cache) : c.property.name;
  return n === name;
}

/** `X.split(S).join(J)` -> { x: X, sep: S, joiner: J, call } */
function matchSplitJoin(join, cache) {
  if (!method(join, 'join', cache)) return null;
  const split = join.callee.object;
  if (!method(split, 'split', cache)) return null;
  const sep = staticValue(split.arguments[0], cache);
  const joiner = staticValue(join.arguments[0], cache);
  if (typeof sep !== 'string' || !sep || typeof joiner !== 'string') return null;
  if (/[\p{L}\p{N}]/u.test(sep)) return null; // only junk-looking separators
  return { x: split.callee.object, sep, joiner, call: join };
}

/** Rewrite a concatenation with the junk removed from its literal parts, or null. */
function rewrite(expr, sep, joiner, cache) {
  if (expr.type !== 'BinaryExpression' || expr.operator !== '+') return null;
  const parts = concatParts(expr);
  const firstStr = parts.findIndex((p) => typeof staticValue(p, cache) === 'string');
  if (firstStr < 0 || firstStr > 1) return null; // must be a string concatenation from the start
  // from the first string on, `+` is string concatenation: adjacent literals can be merged
  const merged = [];
  parts.forEach((p, i) => {
    const v = staticValue(p, cache);
    const isLit = i >= firstStr && v !== NOT && (v === null || typeof v !== 'object');
    const last = merged[merged.length - 1];
    if (isLit && last && last.lit !== undefined) last.lit += String(v);
    else if (isLit) merged.push({ lit: String(v) });
    else merged.push({ node: p });
  });
  if (!merged.some((m) => m.lit !== undefined && m.lit.includes(sep))) return null;
  const nodes = merged.map((m) => (m.lit !== undefined ? { type: 'Literal', value: m.lit.split(sep).join(joiner) } : clone(m.node)));
  return nodes.reduce((l, r) => ({ type: 'BinaryExpression', operator: '+', left: l, right: r }));
}

/** Free identifiers of expr resolve to the same bindings from `at`. */
function portable(expr, at, tree) {
  const scope = tree.scopeAt(at);
  return identifiersIn(expr).every((id) => !id.reference || tree.lookup(scope, id.name) === (id.variable || null));
}

export default {
  name: 'splitJoinConcat',
  run(ctx) {
    const { tree } = ctx;
    const c = ctx.cache;
    const handledVars = new Set();
    for (const join of tree.ofType('CallExpression')) {
      const m = matchSplitJoin(join, c);
      if (!m) continue;
      // inline concatenation
      if (m.x.type === 'BinaryExpression') {
        const r = rewrite(m.x, m.sep, m.joiner, c);
        if (r) ctx.replace(join, r);
        continue;
      }
      // constant variable holding a concatenation
      if (m.x.type !== 'Identifier' || !m.x.variable) continue;
      const v = m.x.variable;
      if (handledVars.has(v)) continue;
      const d = declarator(v);
      if (!d || !d.init || !isConstVariable(v) || readBeforeDeclaration(v)) continue;
      const fixed = rewrite(d.init, m.sep, m.joiner, c);
      if (!fixed) continue;
      handledVars.add(v);
      const reads = readRefs(v);
      // id -> .split member -> split call -> .join member -> join call
      const uses = reads.map((r) => { let n = r.identifier; for (let k = 0; k < 4 && n; k++) n = n.parent; return matchSplitJoin(n, c); });
      const allSame = uses.every((u, i) => u && u.x === reads[i].identifier && u.sep === m.sep && u.joiner === m.joiner);
      if (allSame) {
        // clean the initializer once, every use becomes the plain variable
        const calls = uses.map((u) => u.call);
        if (!ctx.canReplace(d.init) || !ctx.canReplaceAll(calls)) continue;
        ctx.replace(d.init, fixed);
        for (const call of calls) ctx.replace(call, { type: 'Identifier', name: v.name });
      } else if (portable(d.init, join, tree)) {
        ctx.replace(join, fixed);
      }
    }
    return ctx.count;
  },
};
