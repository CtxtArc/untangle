// A temporary written once and read once, right away:
//   t = decode(x); eval(t);          ->   eval(decode(x));
//   var r = f(a); return r;          ->   return f(a);
// Applies to declared variables and to implicit globals (assigned without `var`).
//
// Moving `expr` from its own statement into the next one keeps the program's behaviour when:
//   - the binding has exactly these two references, in adjacent statements of one list;
//   - the read is not under a branch, a loop or a nested function of the second statement;
//   - everything that statement evaluates before reaching the read is a literal or a constant
//     binding (a callee like `eval`, `WScript.Echo`), so it can neither cause nor observe
//     effects of `expr`.
// Implicit globals are left alone when the script can reach globals by computed name.
import { propName, NOT, isPureNode } from '../../values.js';
import { inStatementList } from '../../ast.js';
import { isConstVariable } from '../../utils.js';
import { evalCanSee } from './cleanup.js';

/** Can a script reach global-object properties by computed name or through an alias of the global? */
function globalsReachable(tree) {
  if (tree.sourceType !== 'script') return true;
  if (tree.scopeManager.scopes.some((s) => s.type === 'with')) return true;
  const aliases = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);
  for (const n of tree.nodes) {
    const g = (n.type === 'ThisExpression' && tree.scopeAt(n).variableScope.type === 'global') ||
      (n.type === 'Identifier' && aliases.has(n.name) && n.reference && !n.reference.resolved);
    if (!g) continue;
    const m = n.parent;
    if (m.type === 'MemberExpression' && m.object === n && propName(m) !== NOT) continue;
    return true;
  }
  return false;
}

function memberGlobalNames(tree) {
  const names = new Set();
  for (const m of tree.ofType('MemberExpression')) {
    const o = m.object;
    if (o.type === 'ThisExpression' || (o.type === 'Identifier' && ['window', 'self', 'globalThis'].includes(o.name) && !o.variable)) {
      const name = propName(m);
      if (name !== NOT) names.add(name);
    }
  }
  return names;
}

/** A value read before the temp that `expr` cannot change: literal, constant binding, untouched global. */
function stable(n, writtenGlobals) {
  if (isPureNode(n) && n.type === 'Literal') return true;
  if (n.type === 'Identifier') {
    if (n.variable) return isConstVariable(n.variable);
    return n.reference && !n.reference.resolved && !writtenGlobals.has(n.name);
  }
  if (n.type === 'MemberExpression') return stable(n.object, writtenGlobals) && (!n.computed || stable(n.property, writtenGlobals));
  return false;
}

/** Is `id` read first (after only stable values) when `stmt` runs, outside branches/loops/functions? */
function readFirst(id, stmt, writtenGlobals) {
  let child = id;
  for (let n = id.parent; n; child = n, n = n.parent) {
    if (n === stmt) {
      switch (n.type) {
        case 'ExpressionStatement':
        case 'ReturnStatement':
        case 'ThrowStatement':
          return true;
        case 'VariableDeclaration':
          return n.declarations.length === 1 && n.declarations[0].init === child;
        case 'IfStatement':
        case 'SwitchStatement':
          return child === n.test || child === n.discriminant;
        default:
          return false;
      }
    }
    const before = [];
    switch (n.type) {
      case 'CallExpression':
      case 'NewExpression': {
        if (child === n.callee) break;
        const i = n.arguments.indexOf(child);
        if (i < 0) return false;
        before.push(n.callee, ...n.arguments.slice(0, i));
        break;
      }
      case 'MemberExpression':
        if (child === n.object) break;
        if (!n.computed) return false;
        before.push(n.object);
        break;
      case 'BinaryExpression':
        if (child === n.right) before.push(n.left);
        break;
      case 'LogicalExpression':
        if (child !== n.left) return false; // right side may not run
        break;
      case 'ConditionalExpression':
        if (child !== n.test) return false;
        break;
      case 'UnaryExpression':
        if (n.operator === 'delete') return false;
        break;
      case 'ArrayExpression': {
        const i = n.elements.indexOf(child);
        before.push(...n.elements.slice(0, i).filter(Boolean));
        break;
      }
      case 'TemplateLiteral': {
        const i = n.expressions.indexOf(child);
        before.push(...n.expressions.slice(0, i));
        break;
      }
      case 'AssignmentExpression':
        if (child !== n.right || n.left.type !== 'Identifier') return false;
        break;
      case 'VariableDeclarator':
        if (child !== n.init) return false;
        break;
      default:
        return false; // functions, loops, sequences, spreads, ...: don't move evaluation there
    }
    if (!before.every((b) => b.type !== 'SpreadElement' && stable(b, writtenGlobals))) return false;
  }
  return false;
}

/** `t = expr;` / `var t = expr;` statement for the write reference, with its value node. */
function writeSite(ref, v) {
  const id = ref.identifier;
  const p = id.parent;
  if (p.type === 'AssignmentExpression' && p.operator === '=' && p.left === id && p.parent.type === 'ExpressionStatement' &&
      p.parent.expression === p) return { stmt: p.parent, value: p.right, valueSlot: p };
  if (v && p.type === 'VariableDeclarator' && p.init && p.id === id && p.parent.declarations.length === 1 && p.parent.kind === 'var') {
    return { stmt: p.parent, value: p.init, valueSlot: p };
  }
  return null;
}

export default {
  name: 'inlineSingleUseTemps',
  run(ctx) {
    const { tree } = ctx;
    const gs = tree.scopeManager.globalScope;
    const writtenGlobals = new Set(gs.through.filter((r) => r.isWrite()).map((r) => r.identifier.name));
    const sites = [];

    for (const scope of tree.scopeManager.scopes) {
      for (const v of scope.variables) {
        if (v.defs.length !== 1 || v.defs[0].type !== 'Variable' || v.defs[0].name.type !== 'Identifier') continue;
        if (scope.type === 'global' && ctx.options.keepGlobals) continue;
        if (evalCanSee(v.scope)) continue;
        sites.push([v.references, v]);
      }
    }
    if (!ctx.options.keepGlobals && !globalsReachable(tree)) {
      const byName = new Map();
      for (const r of gs.through) {
        if (gs.set.has(r.identifier.name)) continue;
        if (!byName.has(r.identifier.name)) byName.set(r.identifier.name, []);
        byName.get(r.identifier.name).push(r);
      }
      const viaMember = memberGlobalNames(tree);
      for (const [name, refs] of byName) if (!viaMember.has(name)) sites.push([refs, null]);
    }

    for (const [refs, v] of sites) {
      if (refs.length !== 2) continue;
      const w = refs.find((r) => r.isWrite() && !r.isRead());
      const rd = refs.find((r) => r.isRead() && !r.isWrite());
      if (!w || !rd) continue;
      const site = writeSite(w, v);
      if (!site || !inStatementList(site.stmt)) continue;
      const list = site.stmt.parent[site.stmt.parentKey];
      const next = list[site.stmt.parentIndex + 1];
      if (!next) continue;
      let inNext = false;
      for (let n = rd.identifier; n; n = n.parent) if (n === next) { inNext = true; break; }
      if (!inNext || !readFirst(rd.identifier, next, writtenGlobals)) continue;
      if (!ctx.canReplaceAll([site.stmt, rd.identifier])) continue;
      ctx.replace(rd.identifier, site.value);
      ctx.remove(site.stmt);
    }
    return ctx.count;
  },
};
