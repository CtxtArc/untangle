// Housekeeping: drop empty statements and side-effect-free expression statements,
// flatten nested blocks, and remove declarations nothing reads any more.
import { inStatementList } from '../../ast.js';
import { isPureNode } from '../../values.js';
import { isInside } from '../../utils.js';
import { isBuiltinValue } from '../../builtins.js';

function hasLexical(block) {
  return block.body.some((s) => (s.type === 'VariableDeclaration' && s.kind !== 'var') ||
    s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration');
}

/**
 * Statement that only writes to the binding `id` refers to (or to a property of it):
 *   x = <pure>;   x += <pure>;   x[k] = <pure>;   x.k = <pure>;
 */
function deadWrite(id, pure) {
  let assign = id.parent;
  if (assign.type === 'MemberExpression' && assign.object === id && (!assign.computed || pure(assign.property))) {
    const m = assign;
    assign = m.parent;
    if (!assign || assign.type !== 'AssignmentExpression' || assign.left !== m) return null;
  } else if (assign.type !== 'AssignmentExpression' || assign.left !== id) {
    return null;
  }
  if (!pure(assign.right)) return null;
  const stmt = assign.parent;
  return stmt.type === 'ExpressionStatement' && stmt.expression === assign && inStatementList(stmt) ? stmt : null;
}

// Remove bindings nothing reads: every declaration (a binding may be declared many times,
// as junk generators love to do) plus every statement that merely writes to it. All or nothing.
export const removeDeadCode = {
  name: 'removeDeadCode',
  run(ctx) {
    const { tree } = ctx;
    const memo = new Map();
    const pure = (n) => !n || isPureNode(n) || isBuiltinValue(n, ctx.cache, memo);
    for (const scope of tree.scopeManager.scopes) {
      if (scope.type === 'global' && ctx.options.keepGlobals) continue;
      next: for (const v of scope.variables) {
        if (!v.defs.length) continue;
        const targets = [];
        const ownFns = [];
        for (const def of v.defs) {
          if (def.type === 'Variable') {
            const d = def.node;
            const decl = def.parent;
            if (d.id.type !== 'Identifier' || (d.init && !pure(d.init))) continue next;
            if (!decl || !(inStatementList(decl) || (decl.parent.type === 'ForStatement' && decl.parent.init === decl))) continue next;
            targets.push(d);
          } else if (def.type === 'FunctionName' && def.node.type === 'FunctionDeclaration' && inStatementList(def.node)) {
            targets.push(def.node);
            ownFns.push(def.node);
          } else {
            continue next;
          }
        }
        for (const r of v.references) {
          const id = r.identifier;
          if (r.init && targets.some((t) => t.type === 'VariableDeclarator' && t.id === id)) continue;
          if (ownFns.some((fn) => isInside(id, fn))) continue;
          const stmt = deadWrite(id, pure);
          if (!stmt) continue next; // a real read
          targets.push(stmt);
        }
        const unique = [...new Set(targets)].filter((t, _, all) => !all.some((u) => u !== t && isInside(t, u)));
        if (!unique.length || !ctx.canReplaceAll(unique)) continue;
        for (const t of unique) ctx.remove(t);
      }
    }
    return ctx.count;
  },
};

export const cleanup = {
  name: 'cleanup',
  run(ctx) {
    const { tree } = ctx;
    for (const node of tree.ofType('EmptyStatement', 'ExpressionStatement', 'BlockStatement')) {
      if (!inStatementList(node)) continue;
      if (node.type === 'EmptyStatement') ctx.remove(node);
      else if (node.type === 'ExpressionStatement') {
        if (node.directive) continue;
        if (isPureNode(node.expression) && !(node.expression.type === 'Identifier')) ctx.remove(node);
      } else if (!hasLexical(node)) {
        ctx.splice(node, node.body);
      }
    }
    return ctx.count;
  },
};
