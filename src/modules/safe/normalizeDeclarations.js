// Put declarations back where the value is assigned:
//   function f() { x = g(); use(x); var x; }      ->   function f() { var x = g(); use(x); }
// Some obfuscators hoist every declaration to the end of its function and turn `const x = v`
// into a plain assignment, so that every binding looks reassigned and nothing can be inlined.
//
// `var` is function-scoped and hoisted, so a bare `var x;` anywhere in the function and an
// assignment statement `x = e;` mean exactly what `var x = e;` at the assignment means. The
// first plain `x = e;` statement of the binding becomes the declaration; the bare declarators go.
import { evalCanSee } from './cleanup.js';

export default {
  name: 'normalizeDeclarations',
  run(ctx) {
    const { tree } = ctx;
    for (const scope of tree.scopeManager.scopes) {
      if (scope.type === 'with' || evalCanSee(scope)) continue;
      for (const v of scope.variables) {
        if (!v.defs.length) continue;
        // only bare `var x;` declarators (no initialiser, plain identifier, not a for-in/of head)
        const bare = v.defs.every((d) => d.type === 'Variable' && d.parent.kind === 'var' && d.node.id.type === 'Identifier' &&
          !d.node.init && !/^For(In|Of)?Statement$/.test(d.parent.parent.type));
        if (!bare) continue;
        // first write, in source order, that is a whole `x = e;` statement in the binding's own function
        const writes = v.references.filter((r) => r.isWrite()).sort((a, b) => a.identifier.range[0] - b.identifier.range[0]);
        const r = writes[0];
        if (!r || r.from.variableScope !== v.scope.variableScope || r.isRead()) continue;
        const a = r.identifier.parent;
        const st = a && a.parent;
        if (!a || a.type !== 'AssignmentExpression' || a.operator !== '=' || a.left !== r.identifier ||
            !st || st.type !== 'ExpressionStatement' || st.expression !== a || st.parentIndex == null) continue;
        // only at the top level of the function body: declarations do not move into branches or loops
        const fnBlock = v.scope.variableScope.block;
        const body = fnBlock.type === 'Program' ? fnBlock : fnBlock.body;
        if (st.parent !== body) continue;
        // no read of x inside its own value (`x = x || {}` keeps its meaning either way, but stays as is)
        if (v.references.some((x) => x.isRead() && x.identifier.range[0] > a.right.range[0] && x.identifier.range[1] <= a.right.range[1])) continue;
        const declarators = v.defs.map((d) => d.node);
        if (!ctx.canReplaceAll([st, ...declarators])) continue;
        for (const d of declarators) ctx.remove(d);
        st.__declare = true; // `x = e;` -> `var x = e;` at fixup
        ctx.touched.add(st);
        for (let p = st.parent; p; p = p.parent) ctx.dirty.add(p);
        ctx.count++;
      }
    }
    return ctx.count;
  },
};
