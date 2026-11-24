// Static evaluation of literal-ish expressions and value <-> node conversion.

export const NOT = Symbol('not-static');

const GLOBAL_CONSTS = { undefined: undefined, NaN: NaN, Infinity: Infinity };

function isGlobalConst(node) {
  return node.type === 'Identifier' && Object.prototype.hasOwnProperty.call(GLOBAL_CONSTS, node.name) &&
    !node.variable && !node.isDecl;
}

export function isPrimitive(v) {
  return v === null || (typeof v !== 'object' && typeof v !== 'function');
}

function binary(op, a, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '**': return a ** b;
    case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; // eslint-disable-line eqeqeq
    case '===': return a === b;
    case '!==': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<<': return a << b;
    case '>>': return a >> b;
    case '>>>': return a >>> b;
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    default: return NOT;
  }
}

const MAX_STR = 64 * 1024 * 1024; // payload blobs in droppers are routinely several MB

/**
 * Returns the static value of node, or NOT.
 * Arrays of static values are returned as real arrays (useful for `![]`, `[]+[]`, member access).
 */
export function staticValue(node, cache) {
  if (!node) return NOT;
  if (cache && cache.has(node)) return cache.get(node);
  const v = compute(node, cache);
  if (cache) cache.set(node, v);
  return v;
}

function compute(node, cache) {
  switch (node.type) {
    case 'Literal':
      if (node.regex) return NOT;
      return node.value;
    case 'Identifier':
      return isGlobalConst(node) ? GLOBAL_CONSTS[node.name] : NOT;
    case 'TemplateLiteral': {
      if (node.parent && node.parent.type === 'TaggedTemplateExpression') return NOT;
      let s = '';
      for (let i = 0; i < node.quasis.length; i++) {
        if (node.quasis[i].value.cooked == null) return NOT;
        s += node.quasis[i].value.cooked;
        if (i < node.expressions.length) {
          const e = staticValue(node.expressions[i], cache);
          if (e === NOT || typeof e === 'symbol') return NOT;
          s += String(e);
        }
      }
      return s;
    }
    case 'UnaryExpression': {
      if (node.operator === 'delete') return NOT;
      const a = staticValue(node.argument, cache);
      if (a === NOT) return NOT;
      switch (node.operator) {
        case '!': return !a;
        case '-': return typeof a === 'bigint' ? -a : -a;
        case '+': return typeof a === 'bigint' ? NOT : +a;
        case '~': return ~a;
        case 'typeof': return Array.isArray(a) ? 'object' : typeof a;
        case 'void': return undefined;
        default: return NOT;
      }
    }
    case 'BinaryExpression': {
      if (node.left.type === 'PrivateIdentifier') return NOT;
      const a = staticValue(node.left, cache);
      if (a === NOT) return NOT;
      const b = staticValue(node.right, cache);
      if (b === NOT) return NOT;
      if ((typeof a === 'bigint') !== (typeof b === 'bigint') && !['==', '!=', '===', '!==', '<', '>', '<=', '>=', '+'].includes(node.operator)) return NOT;
      try {
        const r = binary(node.operator, a, b);
        if (typeof r === 'string' && r.length > MAX_STR) return NOT;
        return r;
      } catch { return NOT; }
    }
    case 'LogicalExpression': {
      const a = staticValue(node.left, cache);
      if (a === NOT) return NOT;
      const b = staticValue(node.right, cache);
      if (b === NOT) return NOT;
      if (node.operator === '&&') return a && b;
      if (node.operator === '||') return a || b;
      return a ?? b;
    }
    case 'ConditionalExpression': {
      const t = staticValue(node.test, cache);
      if (t === NOT) return NOT;
      const c = staticValue(node.consequent, cache);
      const alt = staticValue(node.alternate, cache);
      if (c === NOT || alt === NOT) return NOT;
      return t ? c : alt;
    }
    case 'ArrayExpression': {
      const out = [];
      for (const el of node.elements) {
        if (!el || el.type === 'SpreadElement') return NOT;
        const v = staticValue(el, cache);
        if (v === NOT) return NOT;
        out.push(v);
      }
      return out;
    }
    case 'SequenceExpression': {
      let last = NOT;
      for (const e of node.expressions) {
        last = staticValue(e, cache);
        if (last === NOT) return NOT;
      }
      return last;
    }
    default:
      return NOT;
  }
}

/** Truthiness of a node if statically known: true / false / null (unknown). */
export function staticTruth(node, cache) {
  const v = staticValue(node, cache);
  if (v !== NOT) return !!v;
  if (['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(node.type)) return true;
  if (node.type === 'ObjectExpression' && node.properties.every((p) => p.type === 'Property' && !p.computed && isPureNode(p.value))) return true;
  return null;
}

export function valueToNode(v, depth = 0) {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return { type: 'Literal', value: v };
    case 'number':
      if (Number.isNaN(v)) return { type: 'Identifier', name: 'NaN' };
      if (v === Infinity) return { type: 'Identifier', name: 'Infinity' };
      if (v === -Infinity) return { type: 'UnaryExpression', operator: '-', prefix: true, argument: { type: 'Identifier', name: 'Infinity' } };
      if (v < 0 || Object.is(v, -0)) return { type: 'UnaryExpression', operator: '-', prefix: true, argument: { type: 'Literal', value: -v } };
      return { type: 'Literal', value: v };
    case 'bigint':
      if (v < 0n) return { type: 'UnaryExpression', operator: '-', prefix: true, argument: { type: 'Literal', value: -v, bigint: String(-v) } };
      return { type: 'Literal', value: v, bigint: String(v) };
    case 'undefined':
      return { type: 'Identifier', name: 'undefined' };
    case 'object':
      if (v === null) return { type: 'Literal', value: null };
      if (Array.isArray(v) && depth < 4) {
        const els = v.map((x) => valueToNode(x, depth + 1));
        if (els.some((e) => e === null)) return null;
        return { type: 'ArrayExpression', elements: els };
      }
      return null;
    default:
      return null;
  }
}

/** Is node already in the canonical form valueToNode would produce? */
export function isCanonical(node) {
  switch (node.type) {
    case 'Literal':
      return !node.regex;
    case 'Identifier':
      return isGlobalConst(node);
    case 'UnaryExpression':
      return node.operator === '-' && (
        (node.argument.type === 'Literal' && (typeof node.argument.value === 'number' || typeof node.argument.value === 'bigint')) ||
        (node.argument.type === 'Identifier' && node.argument.name === 'Infinity' && isGlobalConst(node.argument)));
    case 'ArrayExpression':
      return node.elements.every((e) => e && e.type !== 'SpreadElement' && isCanonical(e));
    default:
      return false;
  }
}

/** Conservative purity: evaluating the node has no side effects (reading globals is allowed). */
export function isPureNode(node) {
  if (!node) return true;
  switch (node.type) {
    case 'Literal':
    case 'Identifier':
    case 'ThisExpression':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true;
    case 'TemplateLiteral':
      return node.expressions.every((e) => staticValue(e) !== NOT);
    case 'UnaryExpression':
      return node.operator !== 'delete' && staticValue(node) !== NOT;
    case 'BinaryExpression':
    case 'LogicalExpression':
    case 'ConditionalExpression':
    case 'SequenceExpression':
      return staticValue(node) !== NOT;
    case 'ArrayExpression':
      return node.elements.every((e) => !e || (e.type !== 'SpreadElement' && isPureNode(e)));
    case 'ObjectExpression':
      return node.properties.every((p) => p.type === 'Property' && (!p.computed || staticValue(p.key) !== NOT) &&
        (p.kind === 'init' ? isPureNode(p.value) : true));
    default:
      return false;
  }
}

/** Static property name of a MemberExpression / Property, or NOT. */
export function propName(node, cache) {
  const key = node.type === 'MemberExpression' ? node.property : node.key;
  if (!key) return NOT;
  if (!node.computed) {
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal') return String(key.value);
    return NOT;
  }
  const v = staticValue(key, cache);
  if (v === NOT || !isPrimitive(v)) return NOT;
  return String(v);
}

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for function ' +
  'if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements ' +
  'interface package private protected public await').split(' '));

export function isValidIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name);
}

export function isValidBindingName(name) {
  return isValidIdentifier(name) && !RESERVED.has(name);
}
