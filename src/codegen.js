// Code generation via escodegen, patched for ES2022 class features
// (PropertyDefinition, PrivateIdentifier, StaticBlock) which escodegen 2.x lacks.
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPatchedEscodegen() {
  const file = require.resolve('escodegen');
  const src = fs.readFileSync(file, 'utf8');
  const marker = 'exports.generate = generate;';
  if (!src.includes(marker)) return { eg: require('escodegen'), patched: false };

  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(
    src.replace(marker, `${marker}\n exports.CodeGenerator = CodeGenerator; exports.Precedence = Precedence;`),
    file,
  );
  const eg = m.exports;
  const P = eg.CodeGenerator.prototype;
  const Prec = eg.Precedence;
  const E_TTT = 7; // F_ALLOW_IN | F_ALLOW_CALL | F_ALLOW_UNPARATH_NEW
  const S_TFFF = 1;

  P.PrivateIdentifier = function (expr) {
    return '#' + expr.name;
  };
  P.PropertyDefinition = function (expr) {
    const out = [];
    if (expr.static) out.push('static ');
    out.push(this.generatePropertyKey(expr.key, expr.computed));
    if (expr.value) {
      out.push(' = ');
      out.push(this.generateExpression(expr.value, Prec.Assignment, E_TTT));
    }
    out.push(';');
    return out;
  };
  P.StaticBlock = function (stmt) {
    return ['static ', this.BlockStatement({ type: 'BlockStatement', body: stmt.body }, S_TFFF)];
  };
  const origMember = P.MemberExpression;
  P.MemberExpression = function (expr, precedence, flags) {
    if (!expr.computed && expr.property && expr.property.type === 'PrivateIdentifier') {
      expr = { ...expr, property: { type: 'Identifier', name: '#' + expr.property.name } };
    }
    return origMember.call(this, expr, precedence, flags);
  };
  return { eg, patched: true };
}

const { eg: escodegen } = loadPatchedEscodegen();

const FORMAT = {
  indent: { style: '  ' },
  quotes: 'single',
  semicolons: true,
};

export function generate(node) {
  return escodegen.generate(node, { format: FORMAT });
}
