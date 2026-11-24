// Merge runs of literal appends into one definition before anything else looks at them:
//   var s = ''; s += 'ab'; var junk = 1; s += 'cd'; use(s);   ->   var s = 'abcd'; var junk = 1; use(s);
// Droppers build payloads with tens of thousands of `s += '..'` statements; splitting each into
// its own SSA name and folding them one by one would materialise every prefix of the payload
// (quadratic memory) and build expression chains too deep to walk recursively.
//
// Conditions (the same straight-line rules as splitRedeclarations): every definition is a `var`
// declaration or a `s = <lit>` / `s += <lit>` statement directly in one statement list, and no
// read of s sits between the statements merged together, nor in a nested function.
import { staticValue, valueToNode } from '../../values.js';
import { evalCanSee } from './cleanup.js';

const MAX_LEN = 64 * 1024 * 1024;

function stmtIndexIn(node, list) {
  for (let n = node; n && n.parent; n = n.parent) if (n.parent[n.parentKey] === list && n.parentIndex !== null) return n.parentIndex;
  return -1;
}

const isStr = (v) => typeof v === 'string';

export default {
  name: 'mergeAccumulators',
  run(ctx) {
    const { tree } = ctx;
    for (const scope of tree.scopeManager.scopes) {
      if (evalCanSee(scope)) continue; // an eval between appends could read the partial value
      next: for (const v of scope.variables) {
        if (v.defs.length !== 1) continue;
        const d = v.defs[0];
        if (d.type !== 'Variable' || d.node.id.type !== 'Identifier' || !d.node.init || !d.parent || d.parent.kind !== 'var' ||
            d.parent.declarations.length !== 1) continue;
        const declStmt = d.parent;
        if (declStmt.parentIndex == null) continue;
        const list = declStmt.parent[declStmt.parentKey];
        const init = staticValue(d.node.init, ctx.cache);
        if (!isStr(init)) continue;

        // definitions: index -> { stmt, op, value }; reads: statement indices
        const defs = [{ index: declStmt.parentIndex, stmt: declStmt, op: '=', value: init, decl: true }];
        const reads = [];
        for (const r of v.references) {
          if (r.init) continue;
          const id = r.identifier;
          if (r.isWrite()) {
            const a = id.parent, st = a && a.parent;
            if (!a || a.type !== 'AssignmentExpression' || a.left !== id || (a.operator !== '=' && a.operator !== '+=') ||
                !st || st.type !== 'ExpressionStatement' || st.expression !== a || st.parent[st.parentKey] !== list || st.parentIndex == null) continue next;
            const val = staticValue(a.right, ctx.cache);
            if (!isStr(val)) continue next; // a non-literal write: leave the whole binding alone
            defs.push({ index: st.parentIndex, stmt: st, op: a.operator, value: val });
            continue;
          }
          if (r.from.variableScope !== v.scope.variableScope) continue next;
          const idx = stmtIndexIn(id, list);
          if (idx < 0) continue next;
          reads.push(idx);
        }
        if (defs.length < 2) continue;
        defs.sort((a, b) => a.index - b.index);
        if (defs[0] !== defs.find((x) => x.decl)) continue; // declaration must come first
        reads.sort((a, b) => a - b);

        // group consecutive definitions with no read in between; merge each group into its head
        let i = 0;
        while (i < defs.length) {
          const head = defs[i];
          const appendHead = !head.decl && head.op === '+=';
          let value = head.value;
          let j = i + 1;
          while (j < defs.length && !reads.some((r) => r > defs[j - 1].index && r <= defs[j].index)) {
            if (appendHead && defs[j].op === '=') break; // `s += a; s = b` is not one append
            const next = defs[j].op === '=' ? defs[j].value : value + defs[j].value;
            if (next.length > MAX_LEN) break;
            value = next;
            j++;
          }
          if (j - i > 1) {
            const group = defs.slice(i, j);
            const target = head.decl ? head.stmt.declarations[0].init : head.stmt.expression.right;
            if (ctx.canReplaceAll([target, ...group.slice(1).map((x) => x.stmt)])) {
              ctx.replace(target, valueToNode(value));
              for (const x of group.slice(1)) ctx.remove(x.stmt);
            }
          }
          i = Math.max(j, i + 1);
        }
      }
    }
    return ctx.count;
  },
};
