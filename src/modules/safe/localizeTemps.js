// Implicit globals that are only a function's scratch variables become locals:
//   function f(x, y) { t = g(y); t = (x & t) >> 2; return t; }   ->   function f(x, y) { var t; t = g(y); ... }
// Obfuscators (and old hand-written code) skip `var`, so the temps leak to the global object and
// every later pass has to treat them as shared state. A name qualifies only when
//
//  - nothing in the script can reach globals by name (this[k], window[k], with, eval, setTimeout('…')),
//    the same assumption removeDeadCode makes for unused globals;
//  - it is not a builtin or host global (`name`, `status`, `location` … have setters or meaning);
//  - every reference is in one function, outside nested functions, and none is `delete x`;
//  - every read is preceded, in the same call, by a plain `x = e;` statement: an earlier statement
//    of an enclosing statement list (or an earlier `if` whose branches both do that), or the head
//    of an enclosing `for (x = …; …)` / `for (x in …)`;
//  - the function is sloppy-mode, not a generator or async, and cannot be re-entered while it
//    runs: every call in it is to a builtin (by name, or a known builtin method name, assuming
//    builtins are not replaced) or to a function of the script that, transitively, only does the same.
//
// Then no code can observe the global: each call of the function writes it before reading it, and
// nothing else reads it. The `var` lands at the top of the function; normalizeDeclarations then
// moves it to the first assignment.
import { inStatementList } from '../../ast.js';
import { globalsEscape } from './cleanup.js';
import { isHostGlobal } from '../../hostGlobals.js';


const SAFE_GLOBAL_FNS = new Set(['parseInt', 'parseFloat', 'isNaN', 'isFinite', 'escape', 'unescape', 'encodeURI',
  'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'String', 'Number', 'Boolean', 'Array', 'Object', 'RegExp',
  'Date', 'Error', 'atob', 'btoa']);
const BUILTIN_OBJECTS = new Set(['Math', 'String', 'Number', 'JSON', 'Array', 'Object', 'Date']);
const SAFE_METHODS = new Set(['charCodeAt', 'charAt', 'codePointAt', 'fromCharCode', 'fromCodePoint', 'indexOf',
  'lastIndexOf', 'includes', 'slice', 'substr', 'substring', 'split', 'join', 'concat', 'toUpperCase', 'toLowerCase',
  'trim', 'padStart', 'padEnd', 'repeat', 'startsWith', 'endsWith', 'push', 'pop', 'shift', 'unshift', 'reverse',
  'splice', 'toString', 'toFixed', 'match', 'test', 'exec', 'search', 'abs', 'floor', 'ceil', 'round', 'pow', 'sqrt',
  'min', 'max', 'imul', 'parse', 'stringify', 'isArray', 'keys', 'parseInt', 'parseFloat']);
const CALLBACK_METHODS = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find',
  'findIndex', 'sort', 'replace', 'replaceAll', 'from']);

const isFn = (n) => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

/** The function node a callee identifier surely refers to, if it is a never-reassigned script function. */
function knownFunction(id) {
  const v = id.variable;
  if (!v || v.defs.length !== 1) return null;
  const d = v.defs[0];
  let fn = null;
  if (d.type === 'FunctionName') fn = d.node;
  else if (d.type === 'Variable' && isFn(d.node.init)) fn = d.node.init;
  if (!fn) return null;
  if (v.references.some((r) => r.isWrite() && !(d.type === 'Variable' && r.identifier === d.name))) return null;
  return fn;
}

export default {
  name: 'localizeTemps',
  run(ctx) {
    const { tree } = ctx;
    if (ctx.options.keepGlobals || globalsEscape(tree)) return 0;
    const gs = tree.scopeManager.globalScope;

    const byName = new Map();
    for (const r of gs.through) {
      if (r.resolved) continue;
      const n = r.identifier.name;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(r);
    }

    // can calling `fn` (or anything it calls) run `target` again?
    const callsAreSafe = (fn, target, stack) => {
      if (fn === target) return false;
      if (stack.has(fn)) return true; // a cycle that does not pass through target
      stack.add(fn);
      const ok = calls(fn).every((c) => callSafe(c, target, stack));
      stack.delete(fn);
      return ok;
    };
    const callSafe = (call, target, stack) => {
      if (call.type === 'TaggedTemplateExpression') return false;
      const c = call.callee;
      const argFnsSafe = () => call.arguments.every((a) => {
        if (isFn(a)) return callsAreSafe(a, target, stack);
        if (a.type === 'Identifier') {
          const f = knownFunction(a);
          if (f) return callsAreSafe(f, target, stack);
          return !a.variable || !a.variable.defs.some((d) => d.type === 'Parameter'); // a parameter may be a callback
        }
        return true;
      });
      if (c.type === 'Identifier') {
        if (!c.variable) return SAFE_GLOBAL_FNS.has(c.name);
        const f = knownFunction(c);
        return !!f && callsAreSafe(f, target, stack);
      }
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
        const m = c.property.name;
        if ((m === 'call' || m === 'apply') && c.object.type === 'Identifier') {
          const f = knownFunction(c.object);
          return !!f && callsAreSafe(f, target, stack);
        }
        if (c.object.type === 'Identifier' && BUILTIN_OBJECTS.has(c.object.name) && !c.object.variable) {
          return CALLBACK_METHODS.has(m) ? argFnsSafe() : true;
        }
        if (SAFE_METHODS.has(m)) return true;
        if (CALLBACK_METHODS.has(m)) return argFnsSafe();
      }
      return false;
    };

    const callCache = new Map();
    function calls(fn) {
      if (callCache.has(fn)) return callCache.get(fn);
      const out = [];
      const [s, e] = fn.range;
      for (const t of ['CallExpression', 'NewExpression', 'TaggedTemplateExpression']) {
        for (const n of tree.byType.get(t) || []) if (n.range[0] >= s && n.range[1] <= e) out.push(n);
      }
      callCache.set(fn, out);
      return out;
    }

    const plainWrite = (st, name) => {
      if (!st || st.type !== 'ExpressionStatement') return false;
      for (let e = st.expression; e && e.type === 'AssignmentExpression' && e.operator === '='; e = e.right) {
        if (e.left.type === 'Identifier' && e.left.name === name) return true;
      }
      return false;
    };
    const definitelyWrites = (st, name) => {
      if (plainWrite(st, name)) return true;
      if (st.type === 'BlockStatement') return st.body.some((x) => definitelyWrites(x, name));
      if (st.type === 'IfStatement') return !!st.alternate && definitelyWrites(st.consequent, name) && definitelyWrites(st.alternate, name);
      return false;
    };
    const writesInit = (init, name) => {
      if (!init) return false;
      const parts = init.type === 'SequenceExpression' ? init.expressions : [init];
      return parts.some((e) => plainWrite({ type: 'ExpressionStatement', expression: e }, name));
    };
    const dominated = (id, body) => {
      const name = id.name;
      for (let n = id; n && n !== body; n = n.parent) {
        const p = n.parent;
        if (!p) return false;
        if (inStatementList(n)) {
          const list = p[n.parentKey];
          for (let i = 0; i < n.parentIndex; i++) if (definitelyWrites(list[i], name)) return true;
        }
        if (p.type === 'ForStatement' && n !== p.init && writesInit(p.init, name)) return true;
        if (/^For(In|Of)Statement$/.test(p.type) && n === p.body && p.left.type === 'Identifier' && p.left.name === name) return true;
      }
      return false;
    };

    const perFn = new Map();
    for (const [name, refs] of byName) {
      if (isHostGlobal(name)) continue;
      const fnScope = refs[0].from.variableScope;
      if (fnScope.type !== 'function') continue;
      const fn = fnScope.block;
      if (fn.type === 'ArrowFunctionExpression' || fn.generator || fn.async || fnScope.isStrict) continue;
      if (refs.some((r) => r.from.variableScope !== fnScope)) continue;
      if (refs.some((r) => r.identifier.parent.type === 'UnaryExpression' && r.identifier.parent.operator === 'delete')) continue;
      if (fn.body.type !== 'BlockStatement' || !fn.body.body.length) continue;
      if (refs.some((r) => r.isRead() && !dominated(r.identifier, fn.body))) continue;
      if (calls(fn).some((c) => !callSafe(c, fn, new Set([fn])))) continue;
      if (!perFn.has(fn)) perFn.set(fn, []);
      perFn.get(fn).push(name);
    }

    for (const [fn, names] of perFn) {
      const first = fn.body.body[0];
      const decl = {
        type: 'VariableDeclaration', kind: 'var',
        declarations: names.map((n) => ({ type: 'VariableDeclarator', id: { type: 'Identifier', name: n }, init: null })),
      };
      if (ctx.splice(first, [decl, first])) ctx.log(`localizeTemps: ${names.join(', ')} local to ${fn.id ? fn.id.name : 'a function'}`);
    }
    return ctx.count;
  },
};
