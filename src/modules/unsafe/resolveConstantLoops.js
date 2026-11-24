// Evaluate decode loops whose inputs are all known, inside the sandbox:
//
//   var out = '';
//   for (var i = 0; i < blob.length; i += 2) {           // blob is a constant string
//     var b = parseInt(blob.substr(i, 2), 16);
//     var k = 'KEY'.charCodeAt(i / 2 % 3);
//     out += String.fromCharCode(b ^ k);
//   }
//   -> var out = '<decoded text>';
//
// Requirements: `var R = <known value>;` followed (in the same statement list, with nothing in
// between touching R) by a for/while/do-while loop that
//   * writes only R and variables that exist only inside the loop,
//   * reads only R, those loop-locals, constants with known values and builtin globals,
//   * contains no functions, `this`, `new`, return/throw or labeled jumps.
// The loop is run as `(function(){ var R = init; <loop>; return R; })()`, twice, and must
// produce the same primitive both times.
import { walk, inStatementList } from '../../ast.js';
import { valueToNode, isPrimitive } from '../../values.js';
import { isInside } from '../../utils.js';
import { isBuiltinValue, materialize } from '../../builtins.js';
import { runJobs, fromSandbox } from '../../sandbox/runner.js';
import { generate } from '../../codegen.js';

const ALLOWED_GLOBALS = new Set(['String', 'parseInt', 'parseFloat', 'Math', 'Number', 'Boolean', 'unescape', 'escape',
  'decodeURIComponent', 'encodeURIComponent', 'decodeURI', 'encodeURI', 'atob', 'btoa', 'isNaN', 'isFinite',
  'undefined', 'NaN', 'Infinity']);
const FORBIDDEN = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ClassExpression',
  'ClassDeclaration', 'ThisExpression', 'NewExpression', 'ReturnStatement', 'ThrowStatement', 'YieldExpression',
  'AwaitExpression', 'LabeledStatement', 'WithStatement', 'MetaProperty', 'Super', 'ImportExpression']);
const LOOPS = new Set(['ForStatement', 'WhileStatement', 'DoWhileStatement']);

function references(node, list) {
  return list.some((s) => {
    let hit = false;
    walk(s, (n) => {
      if (hit) return false;
      if (n.type === 'Identifier' && n.reference && n.variable === node) hit = true;
      return undefined;
    });
    return hit;
  });
}

/** Is `loop` self-contained apart from R and known constants? */
function analyse(loop, R, cache, memo) {
  let ok = true;
  walk(loop, (n) => {
    if (!ok) return false;
    if (FORBIDDEN.has(n.type)) { ok = false; return false; }
    if ((n.type === 'BreakStatement' || n.type === 'ContinueStatement') && n.label) { ok = false; return false; }
    if (n.type !== 'Identifier' || !n.reference) return undefined;
    const v = n.variable;
    if (!v) {
      if (!ALLOWED_GLOBALS.has(n.name) || n.reference.isWrite()) ok = false;
      return undefined;
    }
    if (v === R) return undefined;
    const local = v.defs.length > 0 && v.defs.every((d) => isInside(d.name, loop)) &&
      v.references.every((r) => isInside(r.identifier, loop));
    if (local) return undefined;
    if (!n.reference.isWrite() && isBuiltinValue(n, cache, memo)) return undefined;
    ok = false;
    return false;
  });
  return ok;
}

export default {
  name: 'resolveConstantLoops',
  unsafe: true,
  run(ctx) {
    const { tree } = ctx;
    const memo = new Map();
    const plans = [];
    for (const decl of tree.ofType('VariableDeclaration')) {
      if (decl.kind === 'const' || decl.declarations.length !== 1 || !inStatementList(decl)) continue;
      const d = decl.declarations[0];
      if (d.id.type !== 'Identifier' || !d.id.variable || !d.init) continue;
      const R = d.id.variable;
      if (R.defs.length !== 1 || !isBuiltinValue(d.init, ctx.cache, memo)) continue;
      const list = decl.parent[decl.parentKey];
      // first loop after the declaration; statements in between must not touch R
      let k = decl.parentIndex + 1;
      while (k < list.length && !LOOPS.has(list[k].type)) k++;
      if (k >= list.length) continue;
      const loop = list[k];
      if (references(R, list.slice(decl.parentIndex + 1, k))) continue;
      if (!R.references.some((r) => r.isWrite() && !r.init && isInside(r.identifier, loop))) continue; // loop must build R
      if (!analyse(loop, R, ctx.cache, memo)) continue;
      const code = `(function () {\nvar ${R.name} = ${generate(materialize(d.init, ctx.cache))};\n` +
        `${generate(materialize(loop, ctx.cache))}\nreturn ${R.name};\n})()`;
      plans.push({ d, loop, code, R });
    }
    if (!plans.length) return 0;
    if (ctx.options.planOnly) { ctx.planned = plans.length; return 0; } // static mode: count, never run
    const [res] = runJobs([{ prelude: '', exprs: plans.map((p) => p.code) }], ctx.options.sandbox);
    if (!res || res.error) { ctx.log(`resolveConstantLoops: ${res && res.error}`); return 0; }
    res.values.forEach((r, i) => {
      const p = plans[i];
      if (!r.ok) { ctx.log(`resolveConstantLoops(${p.R.name}): ${r.e}`); return; }
      const value = fromSandbox(r.v);
      if (!isPrimitive(value) || !['string', 'number', 'boolean'].includes(typeof value)) return;
      if (!ctx.canReplace(p.d.init) || !ctx.canReplace(p.loop)) return;
      ctx.replace(p.d.init, valueToNode(value));
      ctx.remove(p.loop);
      ctx.log(`resolveConstantLoops: ${p.R.name} = <${typeof value}${typeof value === 'string' ? `, ${value.length} chars` : ''}>`);
    });
    return ctx.count;
  },
};
