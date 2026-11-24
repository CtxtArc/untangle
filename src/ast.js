// Parsing, parent-linked "flat" AST indexing and scope resolution.
//
// Every node gets non-enumerable meta properties:
//   parent, parentKey, parentIndex, nodeId
// Identifiers additionally get (when known):
//   variable  - the eslint-scope Variable it declares or resolves to (null = global/unresolved)
//   reference - the eslint-scope Reference (for non-declaration identifiers)
import * as espree from 'espree';
import * as eslintScope from 'eslint-scope';
import { generate } from './codegen.js';

export const VisitorKeys = espree.VisitorKeys;

const META = ['parent', 'parentKey', 'parentIndex', 'nodeId', 'variable', 'reference', 'isDecl'];

function setMeta(node, key, value) {
  Object.defineProperty(node, key, { value, writable: true, configurable: true, enumerable: false });
}

export function childKeys(node) {
  return VisitorKeys[node.type] || Object.keys(node).filter((k) => {
    const v = node[k];
    return v && typeof v === 'object' && (Array.isArray(v) || typeof v.type === 'string');
  });
}

/** Pre-order walk. visitor(node, parent, key, index) may return false to skip children. */
export function walk(root, visitor, parent = null, key = null, index = null) {
  if (!root || typeof root.type !== 'string') return;
  if (visitor(root, parent, key, index) === false) return;
  for (const k of childKeys(root)) {
    const v = root[k];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (v[i]) walk(v[i], visitor, root, k, i);
    } else if (v && typeof v.type === 'string') {
      walk(v, visitor, root, k, null);
    }
  }
}

const PARSE_BASE = { ecmaVersion: 'latest', range: true };

export function parse(code) {
  try {
    return { ast: espree.parse(code, { ...PARSE_BASE, sourceType: 'script', ecmaFeatures: { globalReturn: true } }), sourceType: 'script' };
  } catch (scriptErr) {
    try {
      return { ast: espree.parse(code, { ...PARSE_BASE, sourceType: 'module' }), sourceType: 'module' };
    } catch {
      throw scriptErr;
    }
  }
}

/** Deep clone a subtree (meta props are non-enumerable, so they are dropped). */
export function clone(node, replacer) {
  if (Array.isArray(node)) return node.map((n) => clone(n, replacer));
  if (!node || typeof node !== 'object') return node;
  if (node instanceof RegExp) return node;
  if (replacer && typeof node.type === 'string') {
    const r = replacer(node);
    if (r !== undefined) return r;
  }
  const out = {};
  for (const k of Object.keys(node)) {
    if (k === 'range' || k === 'start' || k === 'end' || k === 'loc') continue;
    out[k] = clone(node[k], replacer);
  }
  if (replacer && out.type === 'Property' && out.shorthand &&
      !(out.value && out.value.type === 'Identifier' && out.key.type === 'Identifier' && out.value.name === out.key.name)) {
    out.shorthand = false;
  }
  return out;
}

export class Tree {
  constructor(code) {
    this.load(code);
  }

  load(code) {
    const { ast, sourceType } = parse(code);
    this.code = code;
    this.ast = ast;
    this.sourceType = sourceType;
    this.index();
  }

  index() {
    const nodes = [];
    const byType = new Map();
    let id = 0;
    walk(this.ast, (node, parent, key, index) => {
      setMeta(node, 'parent', parent);
      setMeta(node, 'parentKey', key);
      setMeta(node, 'parentIndex', index);
      setMeta(node, 'nodeId', id++);
      nodes.push(node);
      let list = byType.get(node.type);
      if (!list) byType.set(node.type, (list = []));
      list.push(node);
    });
    this.nodes = nodes;
    this.byType = byType;
    this.valueCache = new WeakMap();

    this.scopeManager = eslintScope.analyze(this.ast, {
      ecmaVersion: 2022,
      sourceType: this.sourceType,
      optimistic: true, // resolve global-scope references statically
      childVisitorKeys: VisitorKeys,
      fallback: 'iteration',
    });
    for (const scope of this.scopeManager.scopes) {
      for (const v of scope.variables) {
        for (const d of v.defs) {
          if (d.name && d.name.type === 'Identifier') {
            setMeta(d.name, 'variable', v);
            setMeta(d.name, 'isDecl', true);
          }
        }
      }
      for (const r of scope.references) {
        setMeta(r.identifier, 'reference', r);
        setMeta(r.identifier, 'variable', r.resolved || null);
      }
    }
  }

  ofType(...types) {
    const out = [];
    for (const t of types) {
      const l = this.byType.get(t);
      if (l) out.push(...l);
    }
    return out.sort((a, b) => a.nodeId - b.nodeId);
  }

  /** Innermost scope that contains node. */
  scopeAt(node) {
    for (let n = node; n; n = n.parent) {
      const s = this.scopeManager.acquire(n, true);
      if (s) return s;
    }
    return this.scopeManager.globalScope;
  }

  /** Resolve a name as it would be from `scope`. null => global / undeclared. */
  lookup(scope, name) {
    for (let s = scope; s; s = s.upper) {
      const v = s.set.get(name);
      if (v) return v;
    }
    return null;
  }

  /** Expand splice-blocks, drop removed nodes, then regenerate and reparse. */
  commit() {
    fixup(this.ast);
    const code = generate(this.ast);
    this.load(code);
    return code;
  }

  generate() {
    return generate(this.ast);
  }
}

// ---------- structural fixup after a module ran ----------

const STATEMENT_LISTS = new Set(['body', 'consequent']); // Program/Block/StaticBlock body, SwitchCase consequent

export function isStatementList(parent, key) {
  if (!parent || !STATEMENT_LISTS.has(key) || !Array.isArray(parent[key])) return false;
  return parent.type === 'Program' || parent.type === 'BlockStatement' ||
    parent.type === 'StaticBlock' || parent.type === 'SwitchCase';
}

export function inStatementList(node) {
  return node.parentIndex !== null && node.parentIndex !== undefined && isStatementList(node.parent, node.parentKey);
}

function fixup(root) {
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    for (const k of childKeys(node)) {
      const v = node[k];
      if (Array.isArray(v)) {
        if (isStatementList(node, k)) {
          const out = [];
          for (const s of v) expandInto(out, s);
          node[k] = out;
        }
        if (node.type === 'VariableDeclaration' && k === 'declarations') {
          node[k] = v.filter((d) => !d.__removed);
        }
        for (const c of node[k]) visit(c);
      } else if (v && typeof v.type === 'string') {
        if (v.type === 'VariableDeclaration' && v.declarations.every((d) => d.__removed)) {
          if (node.type === 'ForStatement' && k === 'init') { node[k] = null; continue; }
        }
        if (v.__splice) node[k] = { type: 'BlockStatement', body: v.body };
        visit(node[k]);
      }
    }
  };
  visit(root);
}

function expandInto(out, stmt) {
  if (!stmt) return;
  if (stmt.__removed) return;
  if (stmt.__splice) {
    for (const s of stmt.body) expandInto(out, s);
    return;
  }
  if (stmt.type === 'VariableDeclaration' && stmt.declarations.length && stmt.declarations.every((d) => d.__removed)) return;
  out.push(stmt);
}

export { META };
