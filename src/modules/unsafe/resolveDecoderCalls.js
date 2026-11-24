// Resolve calls to string-array decoders (obfuscator.io and friends) by evaluating them in
// the sandbox together with the code they depend on:
//
//   function _0xarr() { var a = ['log', 'SGVsbG8=', ...]; _0xarr = function () { return a; }; return _0xarr(); }
//   function _0xdec(i, k) { ... return decoded; }
//   (function (arr, target) { ... rotate until checksum matches ... })(_0xarr, 0x5a3c1);
//   console[_0xdec(0x1a2)](_0xdec(0x1a5))        ->   console['log']('Hello')
//
// For every function called with literal-only arguments we collect its "context": its own
// declaration, the declarations of everything it references (transitively), direct
// assignments to those bindings, and IIFEs that receive one of them as an argument (array
// rotators). The context runs once as a prelude; each call is then evaluated twice and must
// return the same primitive without touching global state.
import { inStatementList, clone, walk } from '../../ast.js';
import { staticValue, NOT, isPrimitive, valueToNode } from '../../values.js';
import { isInside } from '../../utils.js';
import { runJobs, fromSandbox } from '../../sandbox/runner.js';
import { generate } from '../../codegen.js';

function declStatementOf(v) {
  if (!v || v.defs.length !== 1) return null;
  const d = v.defs[0];
  if (d.type === 'FunctionName' && d.node.type === 'FunctionDeclaration') return inStatementList(d.node) ? d.node : null;
  if (d.type === 'Variable' && d.parent && d.parent.type === 'VariableDeclaration') return inStatementList(d.parent) ? d.parent : null;
  return null;
}

/** Ancestor of node that sits directly in `list`. */
function statementIn(node, list) {
  for (let n = node; n && n.parent; n = n.parent) if (n.parent[n.parentKey] === list && n.parentIndex !== null) return n;
  return null;
}

function unwrapIIFE(stmt) {
  if (stmt.type !== 'ExpressionStatement') return null;
  let e = stmt.expression;
  if (e.type === 'UnaryExpression' && ['!', 'void', '+', '-', '~'].includes(e.operator)) e = e.argument;
  if (e.type !== 'CallExpression') return null;
  if (!/^(FunctionExpression|ArrowFunctionExpression)$/.test(e.callee.type)) return null;
  return e;
}

/** Variables declared directly (top level) by a context statement. */
function declaredBy(stmt) {
  const out = [];
  if (stmt.type === 'FunctionDeclaration' && stmt.id && stmt.id.variable) out.push(stmt.id.variable);
  if (stmt.type === 'VariableDeclaration') for (const d of stmt.declarations) walk(d.id, (n) => { if (n.type === 'Identifier' && n.variable) out.push(n.variable); });
  return out;
}

function collectContext(rootStmt) {
  const stmts = new Set([rootStmt]);
  const vars = new Set(declaredBy(rootStmt));
  const lists = new Set([rootStmt.parent[rootStmt.parentKey]]);
  const queue = [rootStmt];

  const addStmt = (s) => {
    if (stmts.has(s)) return;
    stmts.add(s);
    lists.add(s.parent[s.parentKey]);
    for (const v of declaredBy(s)) vars.add(v);
    queue.push(s);
  };

  const drain = () => {
    while (queue.length) {
      const s = queue.pop();
      const ids = [];
      walk(s, (n) => { if (n.type === 'Identifier' && n.variable) ids.push(n); });
      for (const id of ids) {
        const v = id.variable;
        const def = v.defs[0];
        if (!def) return false;
        if (def.name && [...stmts].some((cs) => isInside(def.name, cs) && !declaredBy(cs).includes(v))) continue; // local
        const ds = declStatementOf(v);
        if (!ds) return false; // parameter, catch binding, class, ... of an enclosing function: unknown value
        addStmt(ds);
        for (const r of v.references) {
          if (!r.isWrite() || r.init) continue;
          if ([...stmts].some((cs) => isInside(r.identifier, cs))) continue;
          const ws = statementIn(r.identifier, ds.parent[ds.parentKey]);
          // only plain `name = value;` statements may join the context: never arbitrary code
          if (!ws || ws.type !== 'ExpressionStatement' || ws.expression.type !== 'AssignmentExpression' ||
              ws.expression.left !== r.identifier || ws.expression.operator !== '=' ||
              !/^(FunctionExpression|ArrowFunctionExpression)$/.test(ws.expression.right.type)) return false;
          addStmt(ws);
        }
      }
    }
    return true;
  };

  if (!drain()) return null;
  // rotators: IIFEs receiving a context binding as argument
  let grew = true;
  while (grew) {
    grew = false;
    for (const list of [...lists]) {
      for (const s of list) {
        if (stmts.has(s)) continue;
        const call = unwrapIIFE(s);
        if (!call) continue;
        if (!call.arguments.some((a) => a.type === 'Identifier' && a.variable && vars.has(a.variable))) continue;
        addStmt(s);
        grew = true;
      }
    }
    if (grew && !drain()) return null;
  }
  return { stmts: [...stmts].sort((a, b) => a.range[0] - b.range[0]), vars };
}

function preludeOf(stmts) {
  return stmts.map((s) => {
    const c = clone(s);
    if (c.type === 'VariableDeclaration') c.kind = 'var'; // make bindings visible as globals for side-effect checks
    return generate(c);
  }).join('\n');
}

function functionVariables(tree) {
  const out = [];
  for (const fn of tree.ofType('FunctionDeclaration')) if (fn.id && fn.id.variable) out.push(fn.id.variable);
  for (const d of tree.ofType('VariableDeclarator')) {
    if (d.id.type === 'Identifier' && d.id.variable && d.init && /^(FunctionExpression|ArrowFunctionExpression)$/.test(d.init.type)) out.push(d.id.variable);
  }
  return out;
}

export default {
  name: 'resolveDecoderCalls',
  unsafe: true,
  run(ctx) {
    const { tree } = ctx;
    const plans = [];
    for (const v of functionVariables(tree)) {
      const calls = v.references
        .map((r) => r.identifier.parent)
        .filter((c) => c && c.type === 'CallExpression' && !c.optional && c.arguments.length > 0 &&
          c.arguments.every((a) => a.type !== 'SpreadElement' && isPrimitive(staticValue(a, ctx.cache)) && staticValue(a, ctx.cache) !== NOT));
      if (!calls.length) continue;
      const root = declStatementOf(v);
      if (!root) continue;
      const context = collectContext(root);
      if (!context) continue;
      const outside = calls.filter((c) => !context.stmts.some((s) => isInside(c, s)) && c.callee.variable === v);
      if (!outside.length) continue;
      plans.push({ v, context, calls: outside });
    }
    if (!plans.length) return 0;

    if (ctx.options.planOnly) { ctx.planned = plans.reduce((n, p) => n + p.calls.length, 0); return 0; } // static mode: count, never run
    const jobs = plans.map((p) => ({ prelude: preludeOf(p.context.stmts), exprs: p.calls.map((c) => generate(c)) }));
    const results = runJobs(jobs, ctx.options.sandbox);

    plans.forEach((plan, i) => {
      const res = results[i];
      if (!res || res.error) { ctx.log(`resolveDecoderCalls(${plan.v.name}): ${res && res.error}`); return; }
      let resolved = 0;
      res.values.forEach((r, j) => {
        if (!r.ok) return;
        const value = fromSandbox(r.v);
        if (!['string', 'number', 'boolean'].includes(typeof value)) return;
        if (ctx.replace(plan.calls[j], valueToNode(value))) resolved++;
      });
      if (resolved) ctx.log(`resolveDecoderCalls: ${plan.v.name} resolved ${resolved}/${plan.calls.length} calls`);
      // everything resolved and nothing else uses the context -> drop decoder, array and rotators
      if (resolved === plan.calls.length && ctx.options.removeDeadCode !== false) {
        const resolvedSet = new Set(plan.calls);
        const used = [...plan.context.vars].some((cv) => cv.references.some((r) =>
          !plan.context.stmts.some((s) => isInside(r.identifier, s)) && !resolvedSet.has(r.identifier.parent)));
        if (!used) for (const s of plan.context.stmts) ctx.remove(s);
      }
    });
    return ctx.count;
  },
};
