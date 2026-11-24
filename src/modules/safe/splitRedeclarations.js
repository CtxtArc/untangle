import { isInside } from '../../utils.js';

// Give each re-definition of a `var` its own name when the definitions are straight-line:
//   var s = 'a'; use(s); var s = 'b'; use(s);   ->   var s = 'a'; use(s); var s_1 = 'b'; use(s_1);
//   var s = '..'; s = s.split('#').join('');     ->   var s = '..'; var s_1 = s.split('#').join('');
//   var s = ''; s += 'a'; s += 'b';               ->   var s = ''; var s_1 = s + 'a'; var s_2 = s_1 + 'b';
// Afterwards every binding has a single definition, so constant inlining, builtin evaluation
// and dead-code removal apply again.
//
// Definitions are `var` declarations and plain `name = expr;` / `name op= expr;` statements. Conditions: the first
// definition is a `var` declaration, all definitions sit directly in the same statement list and
// are the only writes; every read lies inside that list after at least one definition and not
// inside a nested function (which could run later and see a different value).
function stmtIndexIn(node, list) {
  for (let n = node; n && n.parent; n = n.parent) if (n.parent[n.parentKey] === list && n.parentIndex !== null) return n.parentIndex;
  return -1;
}

function usedNames(tree) {
  const names = new Set();
  for (const s of tree.scopeManager.scopes) {
    for (const v of s.variables) names.add(v.name);
    for (const r of s.through) names.add(r.identifier.name);
  }
  return names;
}

const MAX_DEFS = 1000;
const COMPOUND = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=']);

export default {
  name: 'splitRedeclarations',
  run(ctx) {
    const { tree } = ctx;
    let names = null;
    for (const scope of tree.scopeManager.scopes) {
      next: for (const v of scope.variables) {
        if (!v.defs.length) continue;
        const decls = [];
        let list = null;
        for (const d of v.defs) {
          if (d.type !== 'Variable' || d.node.id.type !== 'Identifier' || !d.parent || d.parent.kind !== 'var') continue next;
          const stmt = d.parent;
          if (stmt.parentIndex === null || stmt.parentIndex === undefined) continue next;
          const l = stmt.parent[stmt.parentKey];
          if (list && l !== list) continue next;
          list = l;
          decls.push({ def: d, index: stmt.parentIndex, reads: [] });
        }
        // `name = expr;` statements in the same list are definitions too
        for (const r of v.references) {
          if (!r.isWrite() || r.init) continue;
          const id = r.identifier;
          const a = id.parent;
          const st = a && a.parent;
          if (!a || a.type !== 'AssignmentExpression' || a.left !== id || !COMPOUND.has(a.operator) || r.isRead() !== (a.operator !== '=') ||
              !st || st.type !== 'ExpressionStatement' || st.expression !== a || st.parent[st.parentKey] !== list || st.parentIndex == null) continue next;
          decls.push({ assign: st, name: id, index: st.parentIndex, reads: [], compound: a.operator !== '=' ? a : null });
        }
        // past this, renaming only builds chains too long to fold or read (literal runs are merged first)
        if (decls.length < 2 || decls.length > MAX_DEFS) continue;
        decls.sort((a, b) => a.index - b.index);
        if (!decls[0].def) continue; // first definition must be the declaration
        if (new Set(decls.map((x) => x.index)).size !== decls.length) continue; // two in one statement
        for (const r of v.references) {
          if (r.isWrite()) {
            if (r.init && decls.some((x) => x.def && x.def.name === r.identifier)) continue;
            const own = decls.find((x) => x.name === r.identifier);
            if (!own) continue next;
            if (own.compound) {
              // `s += e` reads the definition before it
              const prev = decls.filter((x) => x.index < own.index).pop();
              if (!prev) continue next;
              own.prev = prev;
            }
            continue;
          }
          if (r.from.variableScope !== v.scope.variableScope) continue next;
          const idx = stmtIndexIn(r.identifier, list);
          if (idx < 0) continue next;
          let reaching = null;
          // the last declaration strictly before the read's statement (a read inside a
          // declaration's own initializer sees the previous declaration)
          for (const x of decls) if (x.index < idx) reaching = x;
          if (!reaching) continue next;
          reaching.reads.push(r.identifier);
        }
        names = names || usedNames(tree);
        const plan = [];
        for (let i = 1; i < decls.length; i++) {
          let n = 1, name;
          do { name = `${v.name}_${n++}`; } while (names.has(name));
          names.add(name);
          plan.push([decls[i], name]);
        }
        const newName = new Map([[decls[0], v.name], ...plan]);
        const nodes = plan.flatMap(([x]) => [...(x.compound ? [] : [x.def ? x.def.name : x.name]), ...x.reads]);
        const compounds = plan.filter(([x]) => x.compound).map(([x]) => x.compound);
        if (!ctx.canReplaceAll(nodes) || !ctx.canReplaceAll(compounds)) continue;
        if (nodes.some((id) => compounds.some((a) => isInside(id, a)))) continue; // `s += s`: leave it
        for (const [x, name] of plan) {
          if (!x.compound) ctx.replace(x.def ? x.def.name : x.name, { type: 'Identifier', name });
          if (x.assign) x.assign.__declare = true; // `name_1 = expr;` -> `var name_1 = expr;` at fixup
          for (const id of x.reads) ctx.replace(id, { type: 'Identifier', name });
        }
        // `s += e` -> `s_2 = s_1 + e`
        for (const [x, name] of plan) {
          if (!x.compound) continue;
          const a = x.compound;
          ctx.replace(a, {
            type: 'AssignmentExpression', operator: '=', left: { type: 'Identifier', name },
            right: { type: 'BinaryExpression', operator: a.operator.slice(0, -1), left: { type: 'Identifier', name: newName.get(x.prev) }, right: a.right },
          });
        }
      }
    }
    return ctx.count;
  },
};
