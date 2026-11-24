// a(), b(), c();       -> a(); b(); c();
// return a(), b;       -> a(); return b;
// if (a(), b) ...      -> a(); if (b) ...
// var a = 1, b = 2;    -> var a = 1; var b = 2;
import { inStatementList } from '../../ast.js';

const exprStmt = (expression) => ({ type: 'ExpressionStatement', expression });

export default {
  name: 'splitSequences',
  run(ctx) {
    const { tree } = ctx;
    for (const s of tree.ofType('ExpressionStatement', 'ReturnStatement', 'IfStatement', 'ThrowStatement', 'VariableDeclaration')) {
      if (s.type === 'VariableDeclaration') {
        if (s.declarations.length < 2 || !inStatementList(s)) continue;
        ctx.splice(s, s.declarations.map((d) => ({ type: 'VariableDeclaration', kind: s.kind, declarations: [d] })));
        continue;
      }
      const key = s.type === 'ExpressionStatement' ? 'expression' : s.type === 'IfStatement' ? 'test' : 'argument';
      const seq = s[key];
      if (!seq || seq.type !== 'SequenceExpression') continue;
      if (s.type === 'ExpressionStatement' && s.directive) continue;
      // keep `else if (a, b)` chains intact unless we can wrap them in a block
      const head = seq.expressions.slice(0, -1).map(exprStmt);
      const last = seq.expressions[seq.expressions.length - 1];
      const tail = s.type === 'ExpressionStatement' ? exprStmt(last) : { ...s, [key]: last };
      ctx.splice(s, [...head, tail]);
    }
    return ctx.count;
  },
};
