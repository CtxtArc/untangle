// Remove dead branches: if (true) A else B -> A ; cond ? a : b with static cond ;
// static-left logical expressions ; while (false) {...}
// and, for any condition, empty branches: if (c) {} else S -> if (!c) S
import { staticTruth, staticValue, NOT, valueToNode, isPrimitive, isCanonical } from '../../values.js';
import { walk } from '../../ast.js';

const LEXICAL = (stmt) => stmt && (
  (stmt.type === 'VariableDeclaration' && stmt.kind !== 'var') ||
  stmt.type === 'ClassDeclaration' || stmt.type === 'FunctionDeclaration');

/** A branch statement that can stand where the if-statement was. */
function branchStatement(s) {
  if (s.type === 'BlockStatement' && !s.body.some(LEXICAL)) return { type: 'BlockStatement', body: s.body, __splice: true };
  return s;
}

/** Names of `var` bindings declared in s (not inside nested functions). */
function varNames(s) {
  const names = [];
  if (!s) return names;
  walk(s, (n) => {
    if (/^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration|Class)/.test(n.type)) return false;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') {
      for (const d of n.declarations) walk(d.id, (i) => { if (i.type === 'Identifier' && !names.includes(i.name)) names.push(i.name); });
    }
    return undefined;
  });
  return names;
}

function hoisted(names) {
  return {
    type: 'VariableDeclaration', kind: 'var',
    declarations: names.map((name) => ({ type: 'VariableDeclarator', id: { type: 'Identifier', name }, init: null })),
  };
}

const isEmpty = (s) => s && ((s.type === 'BlockStatement' && s.body.length === 0) || s.type === 'EmptyStatement');
const asBlock = (s) => (s.type === 'BlockStatement' ? s : { type: 'BlockStatement', body: [s] });
const negate = (e) => (e.type === 'UnaryExpression' && e.operator === '!' ? e.argument : { type: 'UnaryExpression', operator: '!', prefix: true, argument: e });

/** if (c) {} else S -> if (!c) S ;  if (c) S else {} -> if (c) S ;  if (c) {} -> c; */
function emptyBranches(ctx, node) {
  const thenEmpty = isEmpty(node.consequent);
  const elseEmpty = !node.alternate || isEmpty(node.alternate);
  if (thenEmpty && elseEmpty) {
    ctx.replace(node, { type: 'ExpressionStatement', expression: node.test }); // keep the condition's effects
  } else if (thenEmpty && node.alternate.type !== 'IfStatement') { // keep `if (a); else if (b) ...` chains flat
    ctx.replace(node, { type: 'IfStatement', test: negate(node.test), consequent: asBlock(node.alternate), alternate: null });
  } else if (node.alternate && elseEmpty) {
    ctx.replace(node, { type: 'IfStatement', test: node.test, consequent: node.consequent, alternate: null });
  }
}

export default {
  name: 'simplifyBranches',
  run(ctx) {
    const c = ctx.cache;
    for (const node of ctx.tree.ofType('IfStatement', 'ConditionalExpression', 'LogicalExpression', 'WhileStatement')) {
      switch (node.type) {
        case 'IfStatement': {
          const t = staticTruth(node.test, c);
          if (t === null) {
            if (ctx.canReplace(node)) emptyBranches(ctx, node);
            break;
          }
          if (!ctx.canReplace(node)) break;
          const keep = t ? node.consequent : node.alternate;
          const drop = t ? node.alternate : node.consequent;
          // keep hoisted `var` bindings of the dropped branch alive
          const names = varNames(drop).filter((n) => !varNames(keep).includes(n));
          const pre = names.length ? [hoisted(names)] : [];
          if (!keep) {
            if (pre.length) ctx.splice(node, pre); else ctx.remove(node);
          } else if (pre.length) {
            ctx.splice(node, [...pre, keep]);
          } else if (node.parentKey === 'body' || node.parentKey === 'consequent') {
            ctx.replace(node, branchStatement(keep));
          } else {
            ctx.replace(node, keep.type === 'BlockStatement' ? keep : { type: 'BlockStatement', body: [keep] });
          }
          break;
        }
        case 'ConditionalExpression': {
          const t = staticTruth(node.test, c);
          if (t === null) break;
          ctx.replace(node, t ? node.consequent : node.alternate);
          break;
        }
        case 'LogicalExpression': {
          const l = staticValue(node.left, c);
          if (l === NOT || !isPrimitive(l)) {
            // ![] style arrays are truthy objects; only handle && / || on them
            const t = staticTruth(node.left, c);
            if (t === null || node.operator === '??') break;
            if (node.operator === '&&') { if (t) ctx.replace(node, node.right); }
            else if (!t) ctx.replace(node, node.right);
            break;
          }
          const leftNode = isCanonical(node.left) ? node.left : valueToNode(l);
          let pick;
          if (node.operator === '&&') pick = l ? node.right : leftNode;
          else if (node.operator === '||') pick = l ? leftNode : node.right;
          else pick = l == null ? node.right : leftNode;
          if (pick) ctx.replace(node, pick);
          break;
        }
        case 'WhileStatement': {
          if (staticTruth(node.test, c) !== false) break;
          const names = varNames(node.body);
          if (names.length) ctx.splice(node, [hoisted(names)]); else ctx.remove(node);
          break;
        }
        default:
      }
    }
    return ctx.count;
  },
};
