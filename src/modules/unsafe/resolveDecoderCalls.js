// Resolve calls to string-array decoders (obfuscator.io and friends) by evaluating them in
// the sandbox together with the code they depend on:
//
//   function _0xarr() { var a = ['log', 'SGVsbG8=', ...]; _0xarr = function () { return a; }; return _0xarr(); }
//   function _0xdec(i, k) { ... return decoded; }
//   (function (arr, target) { ... rotate until checksum matches ... })(_0xarr, 0x5a3c1);
//   console[_0xdec(0x1a2)](_0xdec(0x1a5))        ->   console['log']('Hello')
//
// For every function called with constant arguments we collect its "context": its own
// declaration, the declarations of everything it references (transitively), direct
// assignments to those bindings, and IIFEs that receive one of them as an argument (array
// rotators). The context runs once as a prelude; each call is then evaluated twice and must
// return the same primitive without touching global state.
//
// Constant arguments are primitives, fresh array / object literals of constants (a new copy each
// evaluation, so nothing the call mutates is visible to the program), constant bindings with a
// primitive value (substituted), and nested calls to other functions with constant arguments
// (their contexts join the prelude):
//   key = derive(unpack('Qm9v'), [3, 1, 4]);   gate(buf, 21081, [63, 56, 4]);   f(g(['a', 'b'])) > 0
import { inStatementList, clone, walk } from '../../ast.js';
import { staticValue, NOT, isPrimitive, valueToNode } from '../../values.js';
import { isInside, isConstVariable, readBeforeDeclaration } from '../../utils.js';
import { runJobs, fromSandbox } from '../../sandbox/runner.js';
import { generate } from '../../codegen.js';
import { CALLSET } from '../../jscript.js';
import { globalsReachable } from '../safe/cleanup.js';

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

/** JScript `o.m(args) = v` (marker form) -> `__untangle_callset(o, 'm', [args], v)` for the sandbox. */
function lowerCallsets(node) {
  walk(node, (n) => {
    if (n.type !== 'AssignmentExpression' || n.operator !== '=' || n.left.type !== 'MemberExpression' || n.left.computed ||
        n.left.property.name !== CALLSET) return;
    const call = n.left.object;
    if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.computed) return;
    const replacement = {
      type: 'CallExpression', optional: false, callee: { type: 'Identifier', name: '__untangle_callset' },
      arguments: [call.callee.object, { type: 'Literal', value: call.callee.property.name }, { type: 'ArrayExpression', elements: call.arguments }, n.right],
    };
    for (const k of Object.keys(n)) if (!['parent', 'parentKey', 'parentIndex'].includes(k)) delete n[k];
    Object.assign(n, replacement);
  });
  return node;
}

function preludeOf(stmts) {
  return stmts.map((s) => {
    const c = lowerCallsets(clone(s));
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

const MAX_ARG_DEPTH = 4;
const MAX_ARRAY_RESULT = 200000;

/** Primitive value of a constant binding (`var buf = '...'`, never reassigned or read early), or NOT. */
function bindingValue(id, cache) {
  const v = id.type === 'Identifier' ? id.variable : null;
  if (!v || !isConstVariable(v) || readBeforeDeclaration(v) || v.defs[0].type !== 'Variable') return NOT;
  const init = v.defs[0].node.init;
  if (!init) return NOT;
  const sv = staticValue(init, cache);
  return sv !== NOT && isPrimitive(sv) ? sv : NOT;
}

/** staticValue, or the value of a constant binding. */
function argValue(a, cache) {
  const sv = staticValue(a, cache);
  if (sv !== NOT) return sv;
  return a.type === 'Identifier' ? bindingValue(a, cache) : NOT;
}

/**
 * Is `a` a constant argument? Collects the function bindings of nested calls into `fns`.
 * Returns false, or true.
 */
const PURE_METHODS = new Set(['concat', 'slice', 'join', 'split', 'substr', 'substring', 'charAt', 'charCodeAt', 'indexOf',
  'lastIndexOf', 'toString', 'toUpperCase', 'toLowerCase', 'trim', 'replace', 'reverse', 'map']);

/** `arr` bound once to an array / object literal, read only here: the call may mutate it unobserved. */
function soleLiteralBinding(id) {
  const v = id.type === 'Identifier' ? id.variable : null;
  if (!v || !isConstVariable(v) || readBeforeDeclaration(v) || v.defs[0].type !== 'Variable') return null;
  const init = v.defs[0].node.init;
  if (!init || !/^(ArrayExpression|ObjectExpression)$/.test(init.type)) return null;
  const reads = v.references.filter((r) => r.isRead());
  return reads.length === 1 && reads[0].identifier === id ? init : null;
}

function constArg(a, cache, fns, fnVars, depth = 0) {
  if (!a || a.type === 'SpreadElement') return false;
  const sv = argValue(a, cache);
  if (sv !== NOT && isPrimitive(sv)) return true;
  const lit = a.type === 'Identifier' && soleLiteralBinding(a);
  if (lit) return constArg(lit, cache, fns, fnVars, depth);
  // receiver.concat(x) / .slice(...) ...: the receiver chain does not count towards the depth
  if (a.type === 'CallExpression' && !a.optional && a.callee.type === 'MemberExpression' && !a.callee.computed &&
      PURE_METHODS.has(a.callee.property.name) && a.callee.property.name !== 'map') {
    return constArg(a.callee.object, cache, fns, fnVars, depth) && a.arguments.every((x) => constArg(x, cache, fns, fnVars, depth + 1));
  }
  if (depth >= MAX_ARG_DEPTH) return false;
  if (a.type === 'ArrayExpression') return a.elements.every((e) => e && constArg(e, cache, fns, fnVars, depth + 1));
  if (a.type === 'ObjectExpression') {
    return a.properties.every((p) => p.type === 'Property' && p.kind === 'init' && !p.computed && !p.method &&
      constArg(p.value, cache, fns, fnVars, depth + 1));
  }
  if (a.type === 'CallExpression' && !a.optional && a.callee.type === 'Identifier' && a.callee.variable && fnVars.has(a.callee.variable)) {
    if (!a.arguments.every((x) => constArg(x, cache, fns, fnVars, depth + 1))) return false;
    fns.add(a.callee.variable);
    return true;
  }
  return false;
}

/** The call as standalone code: constant identifiers replaced by their values. */
function standalone(n, cache) {
  const lit = n.type === 'Identifier' && soleLiteralBinding(n);
  if (lit) return standalone(lit, cache);
  const sv = argValue(n, cache);
  if (n.type !== 'CallExpression' && n.type !== 'MemberExpression' && sv !== NOT && isPrimitive(sv)) return valueToNode(sv);
  switch (n.type) {
    case 'CallExpression': {
      const callee = n.callee.type === 'MemberExpression' && !n.callee.computed && PURE_METHODS.has(n.callee.property.name)
        ? { type: 'MemberExpression', computed: false, optional: false, object: standalone(n.callee.object, cache), property: clone(n.callee.property) }
        : clone(n.callee);
      return { type: 'CallExpression', optional: false, callee, arguments: n.arguments.map((a) => standalone(a, cache)) };
    }
    case 'MemberExpression': return { type: 'MemberExpression', optional: false, computed: n.computed, object: standalone(n.object, cache), property: n.computed ? standalone(n.property, cache) : clone(n.property) };
    case 'ArrayExpression': return { type: 'ArrayExpression', elements: n.elements.map((e) => (e ? standalone(e, cache) : e)) };
    case 'ObjectExpression': return { type: 'ObjectExpression', properties: n.properties.map((p) => ({ ...clone(p), value: standalone(p.value, cache) })) };
    default: return clone(n);
  }
}

const PURE_GLOBALS = new Set(['parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'Array', 'Math', 'isNaN', 'isFinite',
  'undefined', 'NaN', 'Infinity']);

/** Does `stmt` only touch the context's bindings, its own locals and pure globals (no `this`)? */
function onlyTouches(stmt, vars) {
  let ok = true;
  walk(stmt, (n) => {
    if (!ok) return;
    if (n.type === 'ThisExpression' || n.type === 'WithStatement') { ok = false; return; }
    if (n.type !== 'Identifier' || !n.reference) return;
    const v = n.variable;
    if (!v) { if (!PURE_GLOBALS.has(n.name)) ok = false; return; }
    if (vars.has(v)) return;
    if (v.defs.some((d) => isInside(d.name, stmt))) return; // declared inside: a local / parameter
    ok = false;
  });
  return ok;
}

export default {
  name: 'resolveDecoderCalls',
  unsafe: true,
  run(ctx) {
    const { tree } = ctx;
    const fnList = functionVariables(tree);
    const fnVars = new Set(fnList);
    // candidate calls: a known function, every argument constant
    const cands = [];
    for (const v of fnList) {
      for (const r of v.references) {
        const c = r.identifier.parent;
        if (!c || c.type !== 'CallExpression' || c.optional || c.callee !== r.identifier || c.arguments.length === 0) continue;
        const fns = new Set([v]);
        if (!c.arguments.every((a) => constArg(a, ctx.cache, fns, fnVars))) continue;
        // f(...).length / f(...)[0]: evaluate the read too (the call may return an array)
        const m = c.parent;
        const read = m && m.type === 'MemberExpression' && m.object === c && staticValue(m.computed ? m.property : { type: 'Literal', value: m.property.name }, ctx.cache) !== NOT &&
          !(m.parent.type === 'CallExpression' && m.parent.callee === m) && !(m.parent.type === 'AssignmentExpression' && m.parent.left === m) &&
          m.parent.type !== 'UpdateExpression' && !(m.parent.type === 'UnaryExpression' && m.parent.operator === 'delete');
        cands.push({ v, c: read ? m : c, fns });
      }
    }
    // only the outermost: an inner call is evaluated as part of the outer one
    const outer = cands.filter((x) => !cands.some((y) => y !== x && isInside(x.c, y.c)));
    const byFn = new Map();
    for (const x of outer) {
      if (!byFn.has(x.v)) byFn.set(x.v, { calls: [], fns: new Set() });
      const g = byFn.get(x.v);
      g.calls.push(x.c);
      for (const f of x.fns) g.fns.add(f);
    }
    const contexts = new Map();
    const contextOf = (f) => {
      if (!contexts.has(f)) {
        const root = declStatementOf(f);
        contexts.set(f, root ? collectContext(root) : null);
      }
      return contexts.get(f);
    };
    const plans = [];
    for (const [v, g] of byFn) {
      const parts = [...g.fns].map(contextOf);
      if (parts.some((p) => !p)) continue;
      const stmts = [...new Set(parts.flatMap((p) => p.stmts))].sort((a, b) => a.range[0] - b.range[0]);
      const vars = new Set(parts.flatMap((p) => [...p.vars]));
      const own = contextOf(v);
      const outside = g.calls.filter((c) => !stmts.some((s) => isInside(c, s)));
      if (!outside.length) continue;
      plans.push({ v, context: { stmts, vars }, own, calls: outside });
    }
    if (ctx.options.planOnly) { ctx.planned = plans.reduce((n, p) => n + p.calls.length, 0); return 0; } // static mode: count, never run
    // decoder machinery nothing outside uses any more (string arrays, decoders, rotators that only shuffle them)
    const globalsByName = globalsReachable(tree); // this[k]() may call any global function: keep global decoders
    if (ctx.options.removeDeadCode !== false) {
      const busy = new Set(plans.flatMap((p) => p.context.stmts));
      for (const f of fnList) {
        if (globalsByName && f.scope.type === 'global') continue;
        const c = contextOf(f);
        if (!c || c.stmts.some((st) => busy.has(st))) continue;
        const outside = [...c.vars].some((cv) => cv.references.some((r) => !c.stmts.some((st) => isInside(r.identifier, st))));
        if (outside || !c.stmts.every((st) => st.type === 'FunctionDeclaration' || onlyTouches(st, c.vars))) continue;
        if (!ctx.canReplaceAll(c.stmts)) continue;
        for (const st of c.stmts) { ctx.remove(st); busy.add(st); }
        ctx.log(`resolveDecoderCalls: removed unused decoder context of ${f.name} (${c.stmts.length} statements)`);
      }
    }
    if (!plans.length) return ctx.count;
    const jobs = plans.map((p) => ({ prelude: preludeOf(p.context.stmts), exprs: p.calls.map((c) => generate(lowerCallsets(standalone(c, ctx.cache)))) }));
    const results = runJobs(jobs, ctx.options.sandbox);

    plans.forEach((plan, i) => {
      const res = results[i];
      if (!res || res.error) { ctx.log(`resolveDecoderCalls(${plan.v.name}): ${res && res.error}`); return; }
      let resolved = 0;
      res.values.forEach((r, j) => {
        if (!r.ok) return;
        const value = fromSandbox(r.v);
        const prim = (x) => ['string', 'number', 'boolean'].includes(typeof x);
        if (!prim(value) && !(Array.isArray(value) && value.length <= MAX_ARRAY_RESULT && value.every(prim))) return;
        if (ctx.replace(plan.calls[j], valueToNode(value))) resolved++;
      });
      if (resolved) ctx.log(`resolveDecoderCalls: ${plan.v.name} resolved ${resolved}/${plan.calls.length} calls`);
      // everything resolved and nothing else uses the context -> drop decoder, array and rotators
      if (resolved === plan.calls.length && ctx.options.removeDeadCode !== false &&
          !(globalsByName && plan.v.scope.type === 'global')) {
        const resolvedSet = new Set(plan.calls);
        const { stmts, vars } = plan.own;
        const inResolved = (id) => plan.calls.some((c) => isInside(id, c));
        const used = [...vars].some((cv) => cv.references.some((r) =>
          !stmts.some((s) => isInside(r.identifier, s)) && !resolvedSet.has(r.identifier.parent) && !inResolved(r.identifier)));
        if (!used) for (const s of stmts) ctx.remove(s);
      }
    });
    return ctx.count;
  },
};
