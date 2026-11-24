// Static (in-process) folding of builtin calls on known values. No sample code is executed:
// a small interpreter walks the AST and applies the engine's own String / Array / Number
// methods to literal data.
//
//   'dlrow'.split('').reverse().join('')   -> 'world'
//   blob.split('♉').join('')              -> '<cleaned>'      (blob a constant)
//   String.fromCharCode(104, 105)          -> 'hi'
//   atob('aGk='), parseInt('1f', 16), unescape('%41')
//
// Deliberately excluded (left to the sandboxed resolveBuiltinCalls under --dyn): regular
// expression arguments (a hostile pattern can hang the process), and anything not in the
// whitelist. Sizes are capped so `'x'.repeat(1e9)` cannot exhaust memory.
import { staticValue, NOT, valueToNode, isPrimitive, isCanonical, propName } from '../../values.js';
import { isBuiltinValue, MUTATING_METHODS } from '../../builtins.js';
import { isWriteTarget, declarator } from '../../utils.js';

const MAX_LEN = 64 * 1024 * 1024;
const MAX_REPEAT = 10 * 1024 * 1024;

const STRING_METHODS = new Set(['charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes', 'indexOf',
  'lastIndexOf', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'slice', 'split', 'startsWith',
  'substr', 'substring', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'trimLeft', 'trimRight', 'at',
  'toString', 'valueOf']);
const ARRAY_METHODS = new Set(['join', 'reverse', 'slice', 'concat', 'indexOf', 'lastIndexOf', 'includes', 'at', 'flat']);
const NUMBER_METHODS = new Set(['toString', 'toFixed', 'toPrecision']);

const GLOBALS = {
  parseInt, parseFloat, String, Number, Boolean, isNaN, isFinite,
  decodeURIComponent, decodeURI, encodeURIComponent, encodeURI, escape, unescape,
  atob: (s) => Buffer.from(String(s).replace(/[\t\n\f\r ]/g, ''), 'base64').toString('latin1'),
  btoa: (s) => Buffer.from(String(s), 'latin1').toString('base64'),
};
const GLOBAL_METHODS = {
  String: { fromCharCode: String.fromCharCode, fromCodePoint: String.fromCodePoint },
  Number: { parseInt: Number.parseInt, parseFloat: Number.parseFloat, isInteger: Number.isInteger, isNaN: Number.isNaN, isFinite: Number.isFinite },
  Math: Object.fromEntries(['abs', 'ceil', 'floor', 'round', 'trunc', 'sign', 'max', 'min', 'pow', 'sqrt', 'cbrt', 'log',
    'log2', 'log10', 'exp', 'hypot', 'imul', 'clz32', 'fround'].map((k) => [k, Math[k]])),
};

class Refuse extends Error {}
const refuse = () => { throw new Refuse(); };
const isGlobal = (n) => n.type === 'Identifier' && !n.variable && !n.isDecl;

function checkSize(v) {
  if (typeof v === 'string' && v.length > MAX_LEN) refuse();
  if (Array.isArray(v) && (v.length > 1_000_000 || !v.every(isPrimitive))) refuse();
  return v;
}

function callMethod(obj, name, args) {
  if (typeof obj === 'string' && STRING_METHODS.has(name)) {
    if (args.some((a) => a !== null && typeof a === 'object')) refuse(); // no regex / object args
    if (name === 'repeat' && !(args[0] >= 0 && args[0] * obj.length <= MAX_REPEAT)) refuse();
    if ((name === 'padStart' || name === 'padEnd') && !(args[0] <= MAX_REPEAT)) refuse();
    if ((name === 'replace' || name === 'replaceAll') && typeof args[1] !== 'string') refuse(); // no callbacks
    return String.prototype[name].apply(obj, args);
  }
  if (Array.isArray(obj) && ARRAY_METHODS.has(name)) {
    if (args.some((a) => a !== null && typeof a === 'object' && !Array.isArray(a))) refuse();
    return Array.prototype[name].apply(obj.slice(), args); // copy: reverse() must not alias
  }
  if (typeof obj === 'number' && NUMBER_METHODS.has(name)) {
    return Number.prototype[name].apply(obj, args);
  }
  return refuse();
}

function evaluate(node, cache, depth = 0) {
  if (depth > 200) refuse();
  const sv = staticValue(node, cache);
  if (sv !== NOT) return sv;
  switch (node.type) {
    case 'Identifier': {
      // same rule as everywhere else: a constant whose value provably never changes
      if (!isBuiltinValue(node, cache)) refuse();
      const d = declarator(node.variable);
      return evaluate(d.init, cache, depth + 1);
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') refuse();
      const a = evaluate(node.left, cache, depth + 1);
      const b = evaluate(node.right, cache, depth + 1);
      if (!isPrimitive(a) || !isPrimitive(b)) refuse();
      return checkSize(a + b);
    }
    case 'CallExpression': {
      if (node.optional || node.arguments.some((a) => a.type === 'SpreadElement' || (a.type === 'Literal' && a.regex))) refuse();
      const args = node.arguments.map((a) => evaluate(a, cache, depth + 1));
      const c = node.callee;
      if (isGlobal(c) && Object.prototype.hasOwnProperty.call(GLOBALS, c.name)) {
        if (!args.every(isPrimitive)) refuse();
        return checkSize(GLOBALS[c.name](...args));
      }
      if (c.type !== 'MemberExpression') refuse();
      const name = propName(c, cache);
      if (name === NOT) refuse();
      if (isGlobal(c.object) && GLOBAL_METHODS[c.object.name]) {
        const fn = GLOBAL_METHODS[c.object.name][name];
        if (!fn || !args.every(isPrimitive)) refuse();
        if (c.object.name === 'String' && args.length > 1_000_000) refuse();
        return checkSize(fn(...args));
      }
      if (MUTATING_METHODS.has(name) && c.object.type === 'Identifier') refuse(); // would mutate a shared array
      const obj = evaluate(c.object, cache, depth + 1);
      return checkSize(callMethod(obj, name, args));
    }
    default:
      return refuse();
  }
}

export default {
  name: 'foldBuiltinCalls',
  run(ctx) {
    const { tree } = ctx;
    const memo = new Map();
    const cands = tree.ofType('CallExpression').filter((c) => !isWriteTarget(c) && isBuiltinValue(c, ctx.cache, memo));
    const set = new Set(cands);
    for (const c of cands) {
      let outer = true;
      for (let p = c.parent; p; p = p.parent) if (set.has(p)) { outer = false; break; }
      if (!outer) continue;
      let v;
      try {
        v = evaluate(c, ctx.cache);
      } catch (err) {
        if (err instanceof Refuse || err instanceof RangeError || err instanceof URIError || err instanceof TypeError) continue;
        throw err;
      }
      if (!isPrimitive(v) && !(Array.isArray(v) && v.length <= 1000)) continue;
      const node = valueToNode(v);
      if (node && !isCanonical(c)) ctx.replace(c, node);
    }
    return ctx.count;
  },
};
