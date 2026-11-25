// JScript-only syntax that standard parsers reject.
//
// Assignment to a call: `dict.Item("k") = v`, `env("PATH") = v`, `rs.Fields(0).Value(1) += 2`.
// WSH accepts it for parameterised COM properties; ECMAScript makes it an early error. On input,
// `call = v` becomes an assignment to a marker property of the call, `call.__untangle_callset__ = v`,
// which parses and which every module treats as an opaque write through an unknown object. On
// output the marker is removed again, so the code reads exactly as written.
import * as espree from 'espree';

export const CALLSET = '__untangle_callset__';
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '**=', '&&=', '||=', '??=']);
const NOT_CALL = new Set(['if', 'while', 'for', 'switch', 'catch', 'with', 'function', 'return', 'typeof', 'void', 'delete', 'in', 'of', 'new']);

/** Rewrite JScript call-assignments; returns { code, count }. Leaves the source alone if it cannot tokenise it. */
export function toStandard(src) {
  let tokens;
  try {
    tokens = espree.tokenize(src, { ecmaVersion: 'latest', range: true });
  } catch {
    return { code: src, count: 0 };
  }
  const inserts = [];
  const opens = []; // indices of '(' tokens
  const match = new Map();
  tokens.forEach((t, i) => {
    if (t.type !== 'Punctuator') return;
    if (t.value === '(') opens.push(i);
    else if (t.value === ')' && opens.length) match.set(i, opens.pop());
  });
  tokens.forEach((t, i) => {
    if (t.type !== 'Punctuator' || !ASSIGN.has(t.value) || i === 0) return;
    const close = tokens[i - 1];
    if (close.type !== 'Punctuator' || close.value !== ')') return;
    const open = match.get(i - 1);
    if (open == null || open === 0) return;
    const before = tokens[open - 1];
    // a call: the '(' follows an identifier (not a keyword), ')' or ']'
    const isCall = (before.type === 'Identifier' && !NOT_CALL.has(before.value)) ||
      (before.type === 'Punctuator' && (before.value === ')' || before.value === ']'));
    if (isCall) inserts.push(close.range[1]);
  });
  if (!inserts.length) return { code: src, count: 0 };
  let out = src;
  for (const pos of inserts.sort((a, b) => b - a)) out = out.slice(0, pos) + '.' + CALLSET + out.slice(pos);
  return { code: out, count: inserts.length };
}

/** Undo toStandard in generated code. */
export function fromStandard(code) {
  return code.includes(CALLSET) ? code.split('.' + CALLSET).join('') : code;
}
