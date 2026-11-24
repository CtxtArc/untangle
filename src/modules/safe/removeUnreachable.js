// Statements after an unconditional exit in the same statement list never run:
//   return x; junk();            -> return x;
//   WScript.Quit(); if (...) {}  -> WScript.Quit();      (WSH ends the script immediately)
// Function declarations are hoisted and stay. `var` bindings are hoisted too: they are kept as
// bare `var a, b;` so later references still resolve to the same binding.
import { inStatementList, walk } from '../../ast.js';

function isExit(stmt) {
  switch (stmt.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return true;
    case 'ExpressionStatement': {
      const e = stmt.expression;
      return e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && !e.callee.computed &&
        e.callee.object.type === 'Identifier' && e.callee.object.name === 'WScript' && !e.callee.object.variable &&
        e.callee.property.name === 'Quit';
    }
    default:
      return false;
  }
}

function varNames(stmt) {
  const names = [];
  walk(stmt, (n) => {
    if (/^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration|Class)/.test(n.type)) return false;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') {
      for (const d of n.declarations) walk(d.id, (i) => { if (i.type === 'Identifier' && !names.includes(i.name)) names.push(i.name); });
    }
    return undefined;
  });
  return names;
}

export default {
  name: 'removeUnreachable',
  run(ctx) {
    const seen = new Set();
    for (const node of ctx.tree.nodes) {
      if (!inStatementList(node) || !isExit(node)) continue;
      const list = node.parent[node.parentKey];
      if (seen.has(list)) continue;
      seen.add(list);
      const dead = list.slice(node.parentIndex + 1).filter((s) => s.type !== 'FunctionDeclaration' && s.type !== 'EmptyStatement');
      if (!dead.length || !ctx.canReplaceAll(dead)) continue;
      const names = [];
      for (const s of dead) for (const n of varNames(s)) if (!names.includes(n)) names.push(n);
      dead.forEach((s, i) => {
        if (i === 0 && names.length) {
          ctx.replace(s, {
            type: 'VariableDeclaration', kind: 'var',
            declarations: names.map((name) => ({ type: 'VariableDeclarator', id: { type: 'Identifier', name }, init: null })),
          });
        } else {
          ctx.remove(s);
        }
      });
    }
    return ctx.count;
  },
};
