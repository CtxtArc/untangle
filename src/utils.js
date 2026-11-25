// Scope / structure helpers shared by modules.
import { walk, clone } from './ast.js';
import { staticValue, NOT, isPureNode } from './values.js';

export function isInside(node, ancestor) {
  for (let n = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** Variable declared exactly once and never reassigned (aside from its initializer). */
export function isConstVariable(v) {
  if (!v || v.defs.length !== 1) return false;
  const def = v.defs[0];
  if (!['Variable', 'FunctionName'].includes(def.type)) return false;
  if (def.type === 'Variable') {
    const decl = def.parent;
    if (decl && decl.parent && /^For(In|Of)Statement$/.test(decl.parent.type) && decl.parent.left === decl) return false;
  }
  for (const r of v.references) {
    if (r.isWrite() && !(r.init && def.type === 'Variable' && r.identifier === def.name)) return false;
  }
  return true;
}

export function readRefs(v) {
  return v.references.filter((r) => r.isRead());
}

export function declarator(v) {
  const def = v && v.defs[0];
  return def && def.type === 'Variable' && def.node.type === 'VariableDeclarator' ? def.node : null;
}

const FN = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;

const earlyCache = new WeakMap();

/**
 * Hoisted function declarations that may run while `list.slice(0, idx)` executes: every function
 * those statements mention, and transitively every function mentioned by those (a mention also
 * covers callbacks and aliases: the values written to variables they mention are followed too).
 * Returns null when anything could run (eval, with, computed access on `this`).
 */
function mayRunBefore(list, idx) {
  let byIdx = earlyCache.get(list);
  if (!byIdx) earlyCache.set(list, (byIdx = new Map()));
  if (byIdx.has(idx)) return byIdx.get(idx);
  const fns = new Set();
  const vars = new Set();
  let dynamic = false;
  const queue = list.slice(0, idx);
  const visit = (root) => walk(root, (x) => {
    if (x.type === 'WithStatement') dynamic = true;
    if (x.type === 'MemberExpression' && x.computed && x.object.type === 'ThisExpression') dynamic = true;
    if (x.type !== 'Identifier') return;
    if (!x.variable) { if (x.name === 'eval' || x.name === 'Function') dynamic = true; return; }
    const v = x.variable;
    for (const d of v.defs) {
      if (d.type === 'FunctionName' && d.node.type === 'FunctionDeclaration' && !fns.has(d.node)) { fns.add(d.node); queue.push(d.node.body); }
    }
    if (!vars.has(v)) {
      vars.add(v); // follow what the variable may hold: its initialiser and every value written to it
      for (const d of v.defs) if (d.type === 'Variable' && d.node.init) queue.push(d.node.init);
      for (const r of v.references) if (r.isWrite() && r.writeExpr) queue.push(r.writeExpr);
    }
  });
  while (queue.length && !dynamic) visit(queue.pop());
  const out = dynamic ? null : fns;
  byIdx.set(idx, out);
  return out;
}

/**
 * Could some read of v run before its declaration has run (hoisting / TDZ / conditional declaration)?
 * A read is safe only if it sits in a later statement of the declaration's own statement list (so the
 * declaration always ran first), or inside a function created after it. A read inside a hoisted
 * function declaration is safe only when nothing but declarations precede the declaration in the
 * function body, so that function cannot have been called earlier.
 */
export function readBeforeDeclaration(v) {
  return v.references.some((r) => r.isRead() && readMayPrecede(v, r.identifier));
}

/** Could this read of v (an Identifier) run before v's declaration has run? See readBeforeDeclaration. */
export function readMayPrecede(v, id) {
  const d = v.defs[0];
  if (!d) return true;
  if (d.type !== 'Variable') {
    const declStart = d.node.range ? d.node.range[0] : 0;
    return id.range[0] < declStart && id.reference && id.reference.from.variableScope === v.scope.variableScope;
  }
  return mayPrecedeStatement(d.parent, id);
}

/**
 * Could the read `id` run before statement `stmt` (a declaration or an assignment statement) has run?
 * Safe only in a later statement of the same list, or in a function created after it; a hoisted
 * function in that list counts as safe only if code before `stmt` cannot reach it.
 */
export function mayPrecedeStatement(stmt, id) {
  const list = stmt && stmt.parent && stmt.parent[stmt.parentKey];
  if (!Array.isArray(list) || stmt.parentIndex == null) return true; // for-loop heads etc.
  const idx = stmt.parentIndex;
  if (id.range[0] < stmt.range[1]) return true;
  for (let n = id; n && n.parent; n = n.parent) {
    // only declarations directly in a function body / the program are hoisted to its start; one inside a
    // block exists once the block runs, so the block's own position decides (checked further up)
    const hoisted = n.type === 'FunctionDeclaration' && (n.parent.type === 'Program' ||
      (n.parent.type === 'BlockStatement' && n.parent.parent && FN.test(n.parent.parent.type)));
    if (hoisted && n.parent[n.parentKey] === list) {
      // a hoisted function in the declaration's own body: unsafe only if code before the declaration can reach it
      const early = mayRunBefore(list, idx);
      return !early || early.has(n);
    }
    if (hoisted && !(n.parent.parent && FN.test(n.parent.parent.type))) return true; // hoisted at a level we don't track
    if (n.parent[n.parentKey] === list && n.parentIndex != null) return n.parentIndex <= idx;
  }
  return true; // outside the declaration's block: it may not have run
}

/** Is the node used as a write target (assignment, update, delete, for-in/of target, pattern)? */
export function isWriteTarget(node) {
  const p = node.parent;
  if (!p) return false;
  switch (p.type) {
    case 'AssignmentExpression': return p.left === node;
    case 'UpdateExpression': return true;
    case 'UnaryExpression': return p.operator === 'delete';
    case 'ForInStatement':
    case 'ForOfStatement': return p.left === node;
    case 'AssignmentPattern': return p.left === node;
    case 'ArrayPattern':
    case 'RestElement': return true;
    case 'Property': return p.value === node && p.parent && p.parent.type === 'ObjectPattern';
    default: return false;
  }
}

/** Contains a node of the given types (not descending into nested non-arrow functions unless deep). */
export function containsType(root, types, { intoFunctions = true } = {}) {
  let found = false;
  walk(root, (n) => {
    if (found) return false;
    if (types.includes(n.type)) { found = true; return false; }
    if (!intoFunctions && n !== root && (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration')) return false;
    return undefined;
  });
  return found;
}

export function identifiersIn(root) {
  const out = [];
  walk(root, (n) => { if (n.type === 'Identifier') out.push(n); });
  return out;
}

/** Nearest ancestor statement (including node itself). */
export function enclosingStatement(node) {
  for (let n = node; n; n = n.parent) {
    if (/Statement$|Declaration$/.test(n.type) && n.type !== 'VariableDeclarator') return n;
  }
  return null;
}

/**
 * Try to inline `call` (a CallExpression) given a function node whose body is a single
 * `return <expr>` (or an arrow with expression body), or a single expression statement when the
 * call itself is a statement. Returns a fresh expression or null.
 *
 * A direct `eval(...)` in the body runs in the function's scope; it is only moved to the call site
 * when the function declares nothing but its parameters (the usual assumption that the evaluated
 * code doesn't depend on the wrapper's internals, which is what lets unwrapEval show it inline).
 */
export function inlineCall(fn, call, tree, cache) {
  if (fn.async || fn.generator) return null;
  if (!fn.params.every((p) => p.type === 'Identifier')) return null;
  let expr;
  if (fn.type === 'ArrowFunctionExpression' && fn.expression) expr = fn.body;
  else if (fn.body.type === 'BlockStatement' && fn.body.body.length === 1 && fn.body.body[0].type === 'ReturnStatement') expr = fn.body.body[0].argument;
  // function f(p) { g(p); }  called as a statement `f(x);`, so its (undefined) result is unused
  else if (fn.body.type === 'BlockStatement' && fn.body.body.length === 1 && fn.body.body[0].type === 'ExpressionStatement' &&
    call.parent && call.parent.type === 'ExpressionStatement' && call.parent.expression === call) expr = fn.body.body[0].expression;
  else return null;
  if (!expr) return null;
  if (containsType(expr, ['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression', 'ThisExpression', 'Super',
    'MetaProperty', 'YieldExpression', 'AwaitExpression'])) return null;

  const fnScope = tree.scopeManager.acquire(fn);
  if (!fnScope) return null;
  const directEval = identifiersIn(expr).some((id) => id.name === 'eval' && !id.variable && id.parent.type === 'CallExpression' && id.parent.callee === id);
  if (directEval && fnScope.variables.some((v) => v.name !== 'arguments' && !fn.params.some((p) => p.name === v.name))) return null;
  const paramVars = new Map();
  fn.params.forEach((p, i) => { const v = fnScope.set.get(p.name); if (v) paramVars.set(v, i); });

  const uses = new Array(fn.params.length).fill(0);
  const callScope = tree.scopeAt(call);
  for (const id of identifiersIn(expr)) {
    if (!id.reference) continue;
    if (id.name === 'arguments') return null;
    const v = id.variable;
    if (v && paramVars.has(v)) {
      if (id.reference.isWrite()) return null;
      uses[paramVars.get(v)]++;
      continue;
    }
    // free identifier: must resolve to the same binding at the call site
    if (tree.lookup(callScope, id.name) !== (v || null)) return null;
    if (v && v.defs.some((d) => d.node === fn || d.node.init === fn)) return null; // recursion
  }

  const args = call.arguments;
  if (args.some((a) => a.type === 'SpreadElement')) return null;
  for (let i = fn.params.length; i < args.length; i++) if (!isPureNode(args[i])) return null;
  let impure = 0;
  for (let i = 0; i < fn.params.length; i++) {
    const a = args[i];
    if (!a) continue;
    const simple = a.type === 'Identifier' || staticValue(a, cache) !== NOT;
    if (uses[i] === 0 && !isPureNode(a)) return null;
    if (uses[i] > 1 && !simple) return null;
    if (!simple) impure++;
  }
  if (impure > 1) return null;

  const out = clone(expr, (n) => {
    if (n.type === 'Identifier' && n.variable && paramVars.has(n.variable) && n.reference) {
      const a = args[paramVars.get(n.variable)];
      return a ? clone(a) : { type: 'Identifier', name: 'undefined', __missing: true };
    }
    return undefined;
  });
  // f(a, <missing>) -> f(a): a trailing missing argument was never passed in the original call
  walk(out, (n) => {
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      while (n.arguments.length && n.arguments[n.arguments.length - 1].__missing) n.arguments.pop();
    }
  });
  return out;
}

/**
 * A function declaration whose only reassignments happen inside its own body and assign
 * another function (obfuscator.io's self-redefining decoders / string-array getters).
 */
export function isSelfRedefiningFunction(v) {
  if (!v || v.defs.length !== 1 || v.defs[0].type !== 'FunctionName') return false;
  const fn = v.defs[0].node;
  const writes = v.references.filter((r) => r.isWrite());
  return writes.length > 0 && writes.every((r) => isInside(r.identifier, fn) && r.writeExpr &&
    /^(FunctionExpression|ArrowFunctionExpression)$/.test(r.writeExpr.type));
}

export function isStableBinding(v) {
  return isConstVariable(v) || isSelfRedefiningFunction(v);
}
