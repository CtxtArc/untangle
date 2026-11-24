// Which expressions are side-effect-free builtin computations over known values?
//   'dlrow'.split('').reverse().join('')     String.fromCharCode(104, 105)     atob('aGk=')
//   x.split('#').join('')   where `var x = <another such expression or a literal>`
// Used by resolveBuiltinCalls (to evaluate them) and removeDeadCode (to drop unused ones).
import { staticValue, NOT, propName } from './values.js';
import { clone } from './ast.js';
import { isConstVariable, declarator, readBeforeDeclaration } from './utils.js';

const METHODS = new Set([
  // String.prototype
  'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'normalize',
  'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll', 'slice', 'split', 'startsWith', 'substr', 'substring',
  'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'trimLeft', 'trimRight', 'at', 'toString', 'valueOf',
  // Array.prototype (non-mutating, or acting on a fresh value)
  'join', 'reverse', 'flat',
  // Number.prototype
  'toFixed', 'toPrecision',
]);

const GLOBAL_FNS = new Set(['parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'decodeURIComponent', 'decodeURI',
  'encodeURIComponent', 'encodeURI', 'escape', 'unescape', 'atob', 'btoa', 'isNaN', 'isFinite']);

const GLOBAL_METHODS = {
  String: new Set(['fromCharCode', 'fromCodePoint']),
  Number: new Set(['parseInt', 'parseFloat', 'isInteger', 'isNaN', 'isFinite', 'isSafeInteger']),
  Math: new Set(['abs', 'ceil', 'floor', 'round', 'trunc', 'sign', 'max', 'min', 'pow', 'sqrt', 'cbrt', 'log', 'log2',
    'log10', 'exp', 'sin', 'cos', 'tan', 'atan', 'atan2', 'hypot', 'imul', 'clz32', 'fround']),
};

const isGlobal = (n, name) => n.type === 'Identifier' && !n.variable && !n.isDecl && (!name || n.name === name);

/** Constant binding whose initializer is itself a known value / builtin computation. */
function constInit(id, cache, memo) {
  const v = id.variable;
  if (!v || !id.reference || id.reference.isWrite()) return null;
  const d = declarator(v);
  if (!d || !d.init || d.id.type !== 'Identifier' || !isConstVariable(v) || readBeforeDeclaration(v)) return null;
  return isBuiltinValue(d.init, cache, memo) ? d.init : null;
}

/** Is `node` a value we can compute without side effects (given the sandbox's builtins)? */
export function isBuiltinValue(node, cache, memo = new Map()) {
  if (memo.has(node)) return memo.get(node);
  memo.set(node, false); // cycle guard
  let ok = false;
  if (staticValue(node, cache) !== NOT) ok = true;
  else if (node.type === 'Identifier') ok = !!constInit(node, cache, memo);
  else if (node.type === 'BinaryExpression' && node.operator === '+') ok = isBuiltinValue(node.left, cache, memo) && isBuiltinValue(node.right, cache, memo);
  else if (node.type === 'CallExpression' && !node.optional &&
    node.arguments.every((a) => a.type !== 'SpreadElement' && ((a.type === 'Literal' && a.regex) || isBuiltinValue(a, cache, memo)))) {
    const cal = node.callee;
    if (isGlobal(cal) && GLOBAL_FNS.has(cal.name)) ok = true;
    else if (cal.type === 'MemberExpression') {
      const name = propName(cal, cache);
      if (name !== NOT) {
        if (isGlobal(cal.object) && GLOBAL_METHODS[cal.object.name] && GLOBAL_METHODS[cal.object.name].has(name)) ok = true;
        else if (METHODS.has(name) && !isGlobal(cal.object) && isBuiltinValue(cal.object, cache, memo)) ok = true;
        // String.fromCharCode.apply(null, [104, 105])
        else if (name === 'apply' && cal.object.type === 'MemberExpression' && isGlobal(cal.object.object, 'String') &&
          propName(cal.object, cache) === 'fromCharCode') ok = true;
      }
    }
  }
  memo.set(node, ok);
  return ok;
}

/** Copy of a builtin value expression with every constant binding replaced by its initializer. */
export function materialize(node, cache, memo = new Map()) {
  return clone(node, (n) => {
    if (n.type === 'Identifier' && n.variable) {
      const init = constInit(n, cache, memo);
      if (init) return materialize(init, cache, memo);
    }
    return undefined;
  });
}
