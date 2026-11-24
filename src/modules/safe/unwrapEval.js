// eval('a(1); b(2);')  -> a(1); b(2);
// x = eval('1 + y')     -> x = 1 + y
// Function('return this')() / new Function('code')() -> (function () { code })()   (only when free names stay global)
import * as eslintScope from 'eslint-scope';
import { parse, VisitorKeys } from '../../ast.js';
import { staticValue } from '../../values.js';

function parseProgram(code) {
  try {
    return parse(code).ast;
  } catch {
    return null;
  }
}

function freeNames(code) {
  const { ast } = parse(`(function(){${code}\n})`);
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, childVisitorKeys: VisitorKeys, fallback: 'iteration' });
  return sm.globalScope.through.map((r) => r.identifier.name);
}

function isGlobalCallee(node, name) {
  return node.type === 'Identifier' && node.name === name && !node.variable;
}

export default {
  name: 'unwrapEval',
  run(ctx) {
    const { tree } = ctx;
    for (const call of tree.ofType('CallExpression', 'NewExpression')) {
      // direct eval with a literal string
      if (call.type === 'CallExpression' && isGlobalCallee(call.callee, 'eval') && call.arguments.length === 1) {
        const src = staticValue(call.arguments[0], ctx.cache);
        if (typeof src !== 'string') continue;
        const prog = parseProgram(src);
        if (!prog || prog.body.some((s) => s.type === 'ImportDeclaration' || /^Export/.test(s.type))) continue;
        const stmt = call.parent;
        const strict = tree.scopeAt(call).isStrict;
        if (strict && prog.body.some((s) => /Declaration$/.test(s.type))) continue; // strict eval has its own var scope
        if (stmt.type === 'ExpressionStatement' && stmt.expression === call) {
          ctx.splice(stmt, prog.body.length ? prog.body : []);
        } else if (prog.body.length === 1 && prog.body[0].type === 'ExpressionStatement') {
          ctx.replace(call, prog.body[0].expression);
        }
        continue;
      }
      // Function('code')() — immediately invoked function shells
      const outer = call.parent;
      if (!outer || outer.type !== 'CallExpression' || outer.callee !== call || outer.arguments.length) continue;
      if (!isGlobalCallee(call.callee, 'Function') || call.arguments.length !== 1) continue;
      const body = staticValue(call.arguments[0], ctx.cache);
      if (typeof body !== 'string') continue;
      let names;
      try { names = freeNames(body); } catch { continue; }
      const scope = tree.scopeAt(call);
      if (scope.isStrict) continue; // Function() bodies are sloppy, an inlined expression would not be
      if (names.some((n) => tree.lookup(scope, n))) continue; // would capture a local binding
      const fnAst = parseProgram(`(function () {${body}\n})`);
      if (!fnAst) continue;
      ctx.replace(call, fnAst.body[0].expression);
    }
    return ctx.count;
  },
};
