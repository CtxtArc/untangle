// Control-flow unflattening (obfuscator.io "controlFlowFlattening"):
//   var order = '2|0|1'.split('|'), i = 0;
//   while (true) { switch (order[i++]) { case '0': B; continue; case '1': C; continue; case '2': A; continue; } break; }
// -> A; B; C;
import { walk } from '../../ast.js';
import { staticValue, staticTruth, NOT } from '../../values.js';
import { declarator, isConstVariable } from '../../utils.js';

function orderOf(init, cache) {
  const v = staticValue(init, cache);
  if (Array.isArray(v)) return v.map(String);
  // 'a|b|c'.split('|')
  if (init.type === 'CallExpression' && init.callee.type === 'MemberExpression' && init.arguments.length === 1) {
    const s = staticValue(init.callee.object, cache);
    const sep = staticValue(init.arguments[0], cache);
    const name = init.callee.computed ? staticValue(init.callee.property, cache) : init.callee.property.name;
    if (typeof s === 'string' && typeof sep === 'string' && name === 'split') return s.split(sep);
  }
  return null;
}

/** Does `stmts` contain an unlabeled break/continue that would bind to our loop/switch? */
function hasLooseJumps(stmts) {
  let bad = false;
  const visit = (node, inLoop, inSwitch) => {
    walk(node, (n) => {
      if (bad) return false;
      if (n === node) {
        // root handled below
      } else if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassBody)$/.test(n.type)) {
        return false;
      } else if (/^(For|ForIn|ForOf|While|DoWhile)Statement$/.test(n.type)) {
        visit(n.body, true, inSwitch);
        return false;
      } else if (n.type === 'SwitchStatement') {
        for (const c of n.cases) for (const s of c.consequent) visit(s, inLoop, true);
        return false;
      }
      if (n.type === 'BreakStatement' && !n.label && !inLoop && !inSwitch) bad = true;
      if (n.type === 'ContinueStatement' && !n.label && !inLoop) bad = true;
      return undefined;
    });
  };
  for (const s of stmts) visit(s, false, false);
  return bad;
}

function lexical(stmts) {
  return stmts.some((s) => (s.type === 'VariableDeclaration' && s.kind !== 'var') || s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration');
}

export default {
  name: 'unflattenControlFlow',
  run(ctx) {
    const { tree } = ctx;
    const c = ctx.cache;
    for (const loop of tree.ofType('WhileStatement', 'ForStatement')) {
      if (loop.type === 'WhileStatement' && staticTruth(loop.test, c) !== true) continue;
      if (loop.type === 'ForStatement' && (loop.init || loop.update || (loop.test && staticTruth(loop.test, c) !== true))) continue;
      if (loop.parent.type === 'LabeledStatement') continue;
      const body = loop.body.type === 'BlockStatement' ? loop.body.body : null;
      if (!body || body.length !== 2 || body[0].type !== 'SwitchStatement' || body[1].type !== 'BreakStatement' || body[1].label) continue;
      const sw = body[0];
      const disc = sw.discriminant;
      if (disc.type !== 'MemberExpression' || !disc.computed || disc.object.type !== 'Identifier') continue;
      const upd = disc.property;
      if (upd.type !== 'UpdateExpression' || upd.operator !== '++' || upd.prefix || upd.argument.type !== 'Identifier') continue;

      const orderVar = disc.object.variable;
      const idxVar = upd.argument.variable;
      if (!orderVar || !idxVar || !isConstVariable(orderVar)) continue;
      const od = declarator(orderVar);
      const id = declarator(idxVar);
      if (!od || !id || !od.init || !id.init || staticValue(id.init, c) !== 0) continue;
      if (orderVar.references.filter((r) => r.isRead()).length !== 1) continue;
      if (idxVar.references.filter((r) => !r.init).length !== 1) continue;
      const order = orderOf(od.init, c);
      if (!order) continue;

      const cases = new Map();
      let ok = true;
      for (const sc of sw.cases) {
        if (!sc.test) { ok = false; break; }
        const k = staticValue(sc.test, c);
        if (k === NOT || cases.has(String(k))) { ok = false; break; }
        cases.set(String(k), sc.consequent);
      }
      if (!ok) continue;

      const out = [];
      for (const key of order) {
        const stmts = cases.get(key);
        if (!stmts) { ok = false; break; }
        const last = stmts[stmts.length - 1];
        if (!last) { ok = false; break; }
        const terminal = /^(ReturnStatement|ThrowStatement)$/.test(last.type);
        if (!terminal && !(last.type === 'ContinueStatement' && !last.label)) { ok = false; break; }
        const inner = terminal ? stmts : stmts.slice(0, -1);
        if (hasLooseJumps(inner)) { ok = false; break; }
        out.push(...inner);
        if (terminal) break;
      }
      if (!ok) continue;
      if (!ctx.canReplace(loop) || !ctx.canReplace(od) || !ctx.canReplace(id)) continue;
      const replacement = lexical(out) ? [{ type: 'BlockStatement', body: out }] : out;
      ctx.splice(loop, replacement);
      ctx.remove(od);
      if (id !== od) ctx.remove(id);
    }
    return ctx.count;
  },
};
