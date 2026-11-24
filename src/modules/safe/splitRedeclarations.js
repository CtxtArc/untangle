// Give each re-declaration of a `var` its own name when the declarations are straight-line:
//   var s = 'a'; use(s); var s = 'b'; use(s);   ->   var s = 'a'; use(s); var s_1 = 'b'; use(s_1);
// Afterwards every binding has a single definition, so constant inlining, builtin evaluation
// and dead-code removal apply again.
//
// Conditions: all declarations sit directly in the same statement list and are the only
// writes; every read lies inside that list after at least one declaration and not inside a
// nested function (which could run later and see a different value).
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

export default {
  name: 'splitRedeclarations',
  run(ctx) {
    const { tree } = ctx;
    let names = null;
    for (const scope of tree.scopeManager.scopes) {
      next: for (const v of scope.variables) {
        if (v.defs.length < 2) continue;
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
        decls.sort((a, b) => a.index - b.index || a.def.node.range[0] - b.def.node.range[0]);
        if (new Set(decls.map((x) => x.index)).size !== decls.length) continue; // two in one statement
        for (const r of v.references) {
          if (r.isWrite()) {
            if (r.init && decls.some((x) => x.def.name === r.identifier)) continue;
            continue next;
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
        const nodes = plan.flatMap(([x]) => [x.def.name, ...x.reads]);
        if (!ctx.canReplaceAll(nodes)) continue;
        for (const [x, name] of plan) {
          ctx.replace(x.def.name, { type: 'Identifier', name });
          for (const id of x.reads) ctx.replace(id, { type: 'Identifier', name });
        }
      }
    }
    return ctx.count;
  },
};
