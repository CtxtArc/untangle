// Housekeeping: drop empty statements and side-effect-free expression statements,
// flatten nested blocks, and remove declarations nothing reads any more.
//
// "Side-effect free" here is the usual deobfuscator assumption for code being deleted: reading a
// variable or a property, arithmetic and comparisons, literals, and a few known-pure builtins
// (`new Date().getTime()`, `Math.*`, string methods) do not change program state. Property
// getters and valueOf/toString overrides are assumed absent.
import { inStatementList } from '../../ast.js';
import { isPureNode, propName, NOT } from '../../values.js';
import { isInside } from '../../utils.js';
import { isBuiltinValueSafe } from '../../builtins.js';

const PURE_METHODS = new Set(['getTime', 'valueOf', 'toString', 'charAt', 'charCodeAt', 'codePointAt', 'indexOf',
  'lastIndexOf', 'slice', 'substr', 'substring', 'toLowerCase', 'toUpperCase', 'trim', 'concat', 'includes',
  'startsWith', 'endsWith', 'split', 'join', 'padStart', 'padEnd', 'toFixed', 'getFullYear', 'getMonth', 'getDate',
  'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds', 'getTimezoneOffset']);
const PURE_GLOBAL_CALLS = { Date: new Set(['now']), Math: null, String: new Set(['fromCharCode', 'fromCodePoint']),
  Number: new Set(['isNaN', 'isFinite', 'isInteger', 'parseInt', 'parseFloat']) };

const isGlobal = (n, name) => n.type === 'Identifier' && !n.variable && !n.isDecl && (!name || n.name === name);

/** Evaluating `node` changes nothing observable (see the assumption above). `hook(n)` may decide
 *  a node first: true/false, or undefined to fall through to the rules below. */
export function sideEffectFree(node, hook) {
  if (!node) return true;
  if (hook) {
    const h = hook(node);
    if (h !== undefined) return h;
  }
  const sef = (n) => sideEffectFree(n, hook);
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
    case 'ThisExpression':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true;
    case 'TemplateLiteral':
      return node.expressions.every(sef);
    case 'UnaryExpression':
      return node.operator !== 'delete' && sef(node.argument);
    case 'BinaryExpression':
    case 'LogicalExpression':
      return node.left.type !== 'PrivateIdentifier' && sef(node.left) && sef(node.right);
    case 'ConditionalExpression':
      return sef(node.test) && sef(node.consequent) && sef(node.alternate);
    case 'SequenceExpression':
      return node.expressions.every(sef);
    case 'MemberExpression':
      return sef(node.object) && (!node.computed || sef(node.property));
    case 'ArrayExpression':
      return node.elements.every((e) => !e || (e.type !== 'SpreadElement' && sef(e)));
    case 'ObjectExpression':
      return node.properties.every((p) => p.type === 'Property' && (!p.computed || sef(p.key)) && sef(p.value));
    case 'NewExpression':
      return isGlobal(node.callee, 'Date') && node.arguments.every(sef);
    case 'CallExpression': {
      const c = node.callee;
      if (!node.arguments.every((a) => a.type !== 'SpreadElement' && sef(a))) return false;
      if (c.type !== 'MemberExpression') return false;
      const name = propName(c);
      if (name === NOT) return false;
      if (isGlobal(c.object) && Object.prototype.hasOwnProperty.call(PURE_GLOBAL_CALLS, c.object.name)) {
        const allowed = PURE_GLOBAL_CALLS[c.object.name];
        return !allowed || allowed.has(name);
      }
      return PURE_METHODS.has(name) && sef(c.object);
    }
    default:
      return false;
  }
}

function hasLexical(block) {
  return block.body.some((s) => (s.type === 'VariableDeclaration' && s.kind !== 'var') ||
    s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration');
}

/**
 * Statement that only writes to the binding `id` refers to (or to a property of it):
 *   x = <pure>;   x += <pure>;   x[k] = <pure>;   x.k = <pure>;   x++;   x.k++;   x[k]--;
 *   x.push(<pure>);   x.reverse();   ...   (only when x always holds a fresh literal)
 */
// in-place array methods whose only effect is on the array itself (given plain-data arguments)
const DEAD_MUTATORS = new Set(['push', 'unshift', 'pop', 'shift', 'reverse', 'sort', 'splice', 'fill', 'copyWithin']);
const isFn = (n) => /^(FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

function deadWrite(id, pure, fresh = false) {
  let target = id;
  const p = id.parent;
  // arr.push(x); arr.reverse(); ... on an array nothing else reads (no comparators / callbacks)
  if (fresh && p.type === 'MemberExpression' && p.object === id && p.parent.type === 'CallExpression' && p.parent.callee === p &&
      DEAD_MUTATORS.has(propName(p)) && p.parent.arguments.every((a) => a.type !== 'SpreadElement' && !isFn(a) && pure(a))) {
    const stmt = p.parent.parent;
    return stmt.type === 'ExpressionStatement' && stmt.expression === p.parent && inStatementList(stmt) ? stmt : null;
  }
  // x.k = ... only mutates x's own object if x always holds a fresh literal (no aliasing)
  if (p.type === 'MemberExpression' && p.object === id) {
    if (!fresh || (p.computed && !pure(p.property))) return null;
    target = p;
  }
  const w = target.parent;
  if (!w) return null;
  if (w.type === 'AssignmentExpression') {
    if (w.left !== target || !pure(w.right)) return null;
  } else if (w.type !== 'UpdateExpression' || w.argument !== target) {
    return null;
  }
  const stmt = w.parent;
  return stmt.type === 'ExpressionStatement' && stmt.expression === w && inStatementList(stmt) ? stmt : null;
}

/**
 * Function-level bindings a direct `eval(...)` in that function (or a nested one) could read by
 * name. eslint-scope marks every scope enclosing a direct eval as dynamic. The global scope is
 * always dynamic and is handled by the usual deobfuscator assumption instead: evaluated code is
 * resolved and shown inline before its references matter.
 */
export function evalCanSee(scope) {
  return scope.type !== 'global' && scope.dynamic;
}

/** Can a script reach global-object properties by computed name or through an alias of the global? */
export function globalsReachable(tree) {
  if (tree.sourceType !== 'script') return true;
  if (tree.scopeManager.scopes.some((s) => s.type === 'with')) return true;
  return globalObjectEscapes(tree);
}

const GLOBAL_ALIASES = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);

/** The function whose `this` a ThisExpression denotes (arrows see through), or null at top level. */
function thisOwner(tree, n) {
  for (let s = tree.scopeAt(n); s; s = s.upper) {
    if (s.type === 'function' && s.block.type !== 'ArrowFunctionExpression') return s.block;
    if (s.type === 'global' || s.type === 'module') return null;
  }
  return null;
}

/**
 * Does the global object flow anywhere other than a static `g.name` read? `this`/`window` at top
 * level are followed through the usual module wrappers, so `(function () { ... }).call(this)` and
 * `var root = this;` only count when that inner `this` / alias is itself used by computed name or
 * passed on.
 */
function globalObjectEscapes(tree) {
  const thisByOwner = new Map();
  const roots = [];
  for (const n of tree.nodes) {
    if (n.type === 'ThisExpression') {
      const o = thisOwner(tree, n);
      if (!o) roots.push(n);
      else {
        let l = thisByOwner.get(o);
        if (!l) thisByOwner.set(o, (l = []));
        l.push(n);
      }
    } else if (n.type === 'Identifier' && GLOBAL_ALIASES.has(n.name) && n.reference && !n.reference.resolved) {
      roots.push(n);
    }
  }
  const seen = new Set();
  const escapes = (n, depth) => {
    if (depth > 32) return true;
    const m = n.parent;
    if (m.type === 'MemberExpression' && m.object === n) return propName(m) === NOT; // this.x ok, this[k] not
    if (m.type === 'MemberExpression') return true; // x[this]
    // (function () { ... }).call(g, ...) / .apply(g, ...): follow the callee's own `this`
    if (m.type === 'CallExpression' && m.arguments[0] === n && m.callee.type === 'MemberExpression' &&
        !m.callee.computed && ['call', 'apply'].includes(m.callee.property.name) &&
        m.callee.object.type === 'FunctionExpression') {
      const fn = m.callee.object;
      if (seen.has(fn)) return false;
      seen.add(fn);
      return (thisByOwner.get(fn) || []).some((t) => escapes(t, depth + 1));
    }
    // var root = this;  (never reassigned): follow every read of root
    if (m.type === 'VariableDeclarator' && m.init === n && m.id.type === 'Identifier' && m.id.variable) {
      const v = m.id.variable;
      if (seen.has(v)) return false;
      if (v.defs.length !== 1) return true;
      if (v.references.some((r) => r.isWrite() && r.identifier !== m.id)) return true;
      seen.add(v);
      return v.references.some((r) => r.isRead() && escapes(r.identifier, depth + 1));
    }
    return true; // f(this), return this, x = window, ...
  };
  return roots.some((n) => escapes(n, 0));
}

/** Can a script reach global-object properties by computed name or through an alias of the global? */
function globalsEscape(tree) {
  if (tree.sourceType !== 'script') return true;
  for (const s of tree.scopeManager.scopes) {
    if (s.type === 'with') return true;
    if (s.references.some((r) => r.identifier.name === 'eval' && !r.resolved)) return true;
  }
  return globalObjectEscapes(tree);
}

/** A value that is a brand-new object/array (or a primitive), so writes to its properties can't leak. */
function freshValue(n) {
  if (!n) return true;
  switch (n.type) {
    case 'ObjectExpression':
    case 'ArrayExpression':
    case 'Literal':
    case 'TemplateLiteral':
    case 'UnaryExpression':    // always a primitive
    case 'BinaryExpression':   // always a primitive
    case 'UpdateExpression':
      return true;
    case 'NewExpression':
      return isGlobal(n.callee, 'Date');
    default:                   // identifiers, members, calls, `a || b` may all alias an existing object
      return false;
  }
}

/** Top-level `this.NAME = <pure>;` statements: script-global bindings created without `var`. */
function globalPropertyDefs(tree, pure) {
  const defs = new Map();
  for (const st of tree.ast.body) {
    if (st.type !== 'ExpressionStatement' || st.expression.type !== 'AssignmentExpression' || st.expression.operator !== '=') continue;
    const l = st.expression.left;
    if (l.type !== 'MemberExpression' || l.object.type !== 'ThisExpression') continue;
    const name = propName(l);
    if (name === NOT) continue;
    if (!defs.has(name)) defs.set(name, { stmts: [], ok: true, fresh: true });
    const d = defs.get(name);
    d.stmts.push(st);
    if (!pure(st.expression.right)) d.ok = false;
    if (!freshValue(st.expression.right)) d.fresh = false;
  }
  return defs;
}


// --- self-feeding junk ---------------------------------------------------------------------------
// Junk generators pad scripts with dozens of statements over one throwaway variable:
//   if (/k/.test(v || "")) { v += "k"; } else { v = "k"; }
//   try { v = v.concat("k"); } catch (e) { v = "k"; }
//   switch (typeof v) { case "string": v += "k"; break; default: v = "k"; }
//   for (var v = 0; v < 1; v++) { v = (v || "") + "k"; }
// Every read of v only feeds the next write to v, so nothing outside ever observes it. A
// statement is "junk for v" when it is side-effect free apart from writing v, and the binding
// is dead when every reference to it sits inside such a statement.

const VALUE_CTORS = new Set(['String', 'Number', 'Boolean']);

function junkExprHook(isV) {
  const hook = (n) => {
    switch (n.type) {
      case 'AssignmentExpression':
        return isV(n.left) && sideEffectFree(n.right, hook);
      case 'UpdateExpression':
        return isV(n.argument);
      case 'CallExpression': {
        const c = n.callee;
        const args = n.arguments.every((a) => a.type !== 'SpreadElement' && sideEffectFree(a, hook));
        if (!args) return false;
        // /re/.test(x) on a literal without g/y: no lastIndex state
        if (c.type === 'MemberExpression' && c.object.type === 'Literal' && c.object.regex &&
            !/[gy]/.test(c.object.regex.flags) && propName(c) === 'test') return true;
        // String(x), Number(x), Boolean(x)
        if (isGlobal(c) && VALUE_CTORS.has(c.name)) return true;
        // (function (p) { return <pure>; })(args)
        if ((c.type === 'FunctionExpression' || c.type === 'ArrowFunctionExpression') && !c.async && !c.generator &&
            c.params.every((p) => p.type === 'Identifier')) {
          const b = c.body;
          if (b.type !== 'BlockStatement') return sideEffectFree(b, hook);
          return b.body.length === 1 && b.body[0].type === 'ReturnStatement' && sideEffectFree(b.body[0].argument, hook);
        }
        return undefined;
      }
      default:
        return undefined;
    }
  };
  return hook;
}

function junkStatement(st, isV, hook, breakable = 0) {
  const j = (s, b = breakable) => !s || junkStatement(s, isV, hook, b);
  const e = (x) => sideEffectFree(x, hook);
  switch (st.type) {
    case 'EmptyStatement':
      return true;
    case 'ExpressionStatement':
      return !st.directive && e(st.expression);
    case 'BlockStatement':
      return st.body.every((s) => j(s));
    case 'IfStatement':
      return e(st.test) && j(st.consequent) && j(st.alternate);
    case 'TryStatement':
      return j(st.block) && (!st.handler || ((!st.handler.param || st.handler.param.type === 'Identifier') && j(st.handler.body))) && j(st.finalizer);
    case 'SwitchStatement':
      return e(st.discriminant) && st.cases.every((c) => e(c.test) && c.consequent.every((s) => j(s, breakable + 1)));
    case 'ForStatement':
      return (!st.init || (st.init.type === 'VariableDeclaration' ? j(st.init) : e(st.init))) && e(st.test) && e(st.update) && j(st.body, breakable + 1);
    case 'VariableDeclaration':
      return st.kind === 'var' && st.declarations.every((d) => isV(d.id) && e(d.init));
    case 'BreakStatement':
      return !st.label && breakable > 0;
    default:
      return false;
  }
}

/** The outermost statement around `id` (up to `stop`) that is junk for v, if it sits in a statement list. */
function junkRoot(id, stop, isV, hook) {
  let best = null;
  for (let n = id.parent; n && n !== stop; n = n.parent) {
    if (!/Statement$|Declaration$/.test(n.type)) continue;
    if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') break;
    if (n.type === 'VariableDeclaration' && n.parent.type === 'ForStatement') continue; // judged with the loop
    if (!junkStatement(n, isV, hook)) {
      if (best) break; // the junk region ended
      continue;        // not yet: e.g. the `v += k` inside `if (...)` is junk, the `{}` around it maybe not
    }
    if (inStatementList(n)) best = n;
  }
  return best;
}

function selfFeedingTargets(v, scope) {
  if (!v.defs.length || !v.defs.every((d) => d.type === 'Variable' && d.parent.kind === 'var' && d.name.type === 'Identifier')) return null;
  const isV = (n) => n.type === 'Identifier' && n.variable === v;
  const hook = junkExprHook(isV);
  const stop = scope.block;
  const ids = [...v.defs.map((d) => d.name), ...v.references.map((r) => r.identifier)];
  const targets = [];
  for (const id of ids) {
    const root = junkRoot(id, stop, isV, hook);
    if (!root) return null;
    targets.push(root);
  }
  return [...new Set(targets)].filter((t, _, all) => !all.some((u) => u !== t && isInside(t, u)));
}


// --- dead IIFEs ----------------------------------------------------------------------------------
// Padding that builds a data table onto a throwaway argument:
//   (function (a, b) { a[b] = { ...big literal... }; }(function () { ... }));
// Every argument is a fresh value (a literal object/array/function or a primitive), and the body
// only writes properties of those fresh parameters with pure values, so nothing outside can ever
// observe the call. Writes that could throw or run code are excluded: setters / __proto__ on a
// literal object, read-only `name` / `length` / `caller` / `arguments` of a function (a TypeError
// in strict mode), and an array's `length` (RangeError on a bad value).

const FN_READONLY = new Set(['name', 'length', 'caller', 'arguments']);

function freshKind(n) {
  if (!n) return 'undefined';
  if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return 'function';
  if (n.type === 'ArrayExpression') return n.elements.every((e) => !e || (e.type !== 'SpreadElement' && sideEffectFree(e))) ? 'array' : null;
  if (n.type === 'ObjectExpression') {
    const plain = n.properties.every((p) => p.type === 'Property' && p.kind === 'init' && !p.computed &&
      propName({ type: 'MemberExpression', computed: false, property: p.key }) !== '__proto__' && sideEffectFree(p.value));
    return plain ? 'object' : null;
  }
  return null;
}

/** Static key of `param[key]` / `param.key`: a literal, or a parameter that receives no argument (undefined). */
function staticKey(m, unpassed) {
  if (!m.computed) return m.property.type === 'Identifier' ? m.property.name : NOT;
  const k = m.property;
  if (k.type === 'Literal' && (typeof k.value === 'string' || typeof k.value === 'number')) return String(k.value);
  if (k.type === 'Identifier' && k.variable && unpassed.has(k.variable)) return 'undefined';
  return NOT;
}

export function deadIIFE(stmt, tree) {
  if (stmt.type !== 'ExpressionStatement') return false;
  let call = stmt.expression;
  if (call.type === 'UnaryExpression' && ['!', 'void', '+', '-', '~'].includes(call.operator)) call = call.argument;
  if (call.type !== 'CallExpression' || call.optional) return false;
  const fn = call.callee;
  if (!/^(FunctionExpression|ArrowFunctionExpression)$/.test(fn.type) || fn.async || fn.generator || fn.body.type !== 'BlockStatement') return false;
  if (!fn.params.every((p) => p.type === 'Identifier')) return false;
  if (call.arguments.some((a) => a.type === 'SpreadElement' || !sideEffectFree(a))) return false;
  const scope = tree.scopeManager.acquire(fn);
  if (!scope || evalCanSee(scope)) return false;
  // what each parameter holds
  const kinds = new Map();
  const unpassed = new Set();
  fn.params.forEach((p, i) => {
    const v = scope.set.get(p.name);
    if (!v) return;
    const a = call.arguments[i];
    kinds.set(v, a ? freshKind(a) : 'undefined');
    if (!a) unpassed.add(v);
  });
  const paramOf = (id) => id.type === 'Identifier' && id.variable && kinds.has(id.variable) ? id.variable : null;
  for (const st of fn.body.body) {
    if (st.type === 'EmptyStatement') continue;
    if (st.type === 'VariableDeclaration' && st.kind === 'var' &&
        st.declarations.every((d) => d.id.type === 'Identifier' && !paramOf(d.id) && sideEffectFree(d.init))) continue;
    if (st.type !== 'ExpressionStatement') return false;
    const e = st.expression;
    if (e.type !== 'AssignmentExpression' || e.operator !== '=' || e.left.type !== 'MemberExpression' || !sideEffectFree(e.right)) return false;
    const v = paramOf(e.left.object);
    if (!v) return false;
    const kind = kinds.get(v);
    const key = staticKey(e.left, unpassed);
    if (key === NOT || !kind || kind === 'undefined') return false;
    if (kind === 'function' && FN_READONLY.has(key)) return false;
    if (kind === 'object' && key === '__proto__') return false;
    if (kind === 'array' && key === 'length') return false;
  }
  // parameters are only ever used as write targets or unpassed keys (never read, passed or reassigned)
  for (const [v] of kinds) {
    for (const r of v.references) {
      if (r.isWrite()) return false;
      const id = r.identifier;
      const m = id.parent;
      if (m.type === 'MemberExpression' && m.object === id && m.parent.type === 'AssignmentExpression' && m.parent.left === m) continue;
      if (m.type === 'MemberExpression' && m.property === id && m.computed && unpassed.has(v)) continue;
      return false;
    }
  }
  return true;
}

// Remove bindings nothing reads: every declaration (a binding may be declared many times,
// as junk generators love to do) plus every statement that merely writes to it. All or nothing.
export const removeDeadCode = {
  name: 'removeDeadCode',
  run(ctx) {
    const { tree } = ctx;
    const memo = new Map();
    const pure = (n) => !n || isPureNode(n) || isBuiltinValueSafe(n, ctx.cache, memo) || sideEffectFree(n);

    // whole IIFEs whose only effect is writing onto their own fresh arguments
    for (const st of tree.ofType('ExpressionStatement')) {
      if (inStatementList(st) && ctx.canReplace(st) && deadIIFE(st, tree)) ctx.remove(st);
    }

    // script globals created as `this.NAME = ...` (and read as plain `NAME`)
    if (!ctx.options.keepGlobals && !globalsEscape(tree)) {
      const gs = tree.scopeManager.globalScope;
      const unresolved = new Map();
      for (const r of gs.through) {
        if (!unresolved.has(r.identifier.name)) unresolved.set(r.identifier.name, []);
        unresolved.get(r.identifier.name).push(r);
      }
      const memberReads = new Map();
      for (const m of tree.ofType('MemberExpression')) {
        const o = m.object;
        if (o.type !== 'ThisExpression' && !(o.type === 'Identifier' && ['window', 'self', 'globalThis'].includes(o.name) && !o.variable)) continue;
        const name = propName(m);
        if (name === NOT) continue;
        if (!memberReads.has(name)) memberReads.set(name, []);
        memberReads.get(name).push(m);
      }
      nextGlobal: for (const [name, d] of globalPropertyDefs(tree, pure)) {
        if (!d.ok || gs.set.has(name)) continue;
        const targets = [...d.stmts];
        for (const m of memberReads.get(name) || []) {
          if (d.stmts.some((st) => st.expression.left === m)) continue;
          continue nextGlobal; // read as this.NAME / window.NAME
        }
        for (const r of unresolved.get(name) || []) {
          const stmt = deadWrite(r.identifier, pure, d.fresh);
          if (!stmt) continue nextGlobal; // a real read
          targets.push(stmt);
        }
        const unique = [...new Set(targets)].filter((t, _, all) => !all.some((u) => u !== t && isInside(t, u)));
        if (!ctx.canReplaceAll(unique)) continue;
        for (const t of unique) ctx.remove(t);
      }
    }

    const globalsByName = globalsReachable(tree);
    for (const scope of tree.scopeManager.scopes) {
      if (scope.type === 'global' && ctx.options.keepGlobals) continue;
      if (scope.type === 'global' && globalsByName) continue; // this[k](), window[k], with: any global may be used
      if (evalCanSee(scope)) continue; // a direct eval in or below this function can read any local by name
      next: for (const v of scope.variables) {
        if (!v.defs.length) continue;
        // not plainly dead: maybe every read of v only feeds further writes to v
        const fallback = () => {
          const junk = selfFeedingTargets(v, scope);
          if (junk && junk.length && ctx.canReplaceAll(junk)) for (const t of junk) ctx.remove(t);
        };
        const targets = [];
        const ownFns = [];
        // every value the binding can hold: declarator inits and plain assignments
        const fresh = v.defs.every((def) => def.type === 'Variable' && freshValue(def.node.init)) &&
          v.references.every((r) => !r.isWrite() || r.init || (r.writeExpr && freshValue(r.writeExpr)));
        for (const def of v.defs) {
          if (def.type === 'Variable') {
            const d = def.node;
            const decl = def.parent;
            if (d.id.type !== 'Identifier' || (d.init && !pure(d.init))) { fallback(); continue next; }
            if (!decl || !(inStatementList(decl) || (decl.parent.type === 'ForStatement' && decl.parent.init === decl))) { fallback(); continue next; }
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
          const stmt = deadWrite(id, pure, fresh);
          if (!stmt) { fallback(); continue next; } // a real read, unless it only feeds v itself
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
