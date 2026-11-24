// Per-module-run mutation context. Guarantees a single module run never edits a node
// twice, edits inside an already-replaced subtree, or replaces an ancestor of an
// edited node (whose scope info would then be stale). Conflicting edits simply wait
// for the next iteration, after the tree has been regenerated and re-indexed.
import { inStatementList } from './ast.js';

export class Context {
  constructor(tree, options, log) {
    this.tree = tree;
    this.options = options;
    this.log = log;
    this.count = 0;
    this.planned = 0; // planOnly: how many evaluations a sandboxed module would have run
    this.touched = new WeakSet();
    this.dirty = new WeakSet();
  }

  get cache() {
    return this.tree.valueCache;
  }

  canReplace(node) {
    if (!node || !node.parent) return false;
    if (this.dirty.has(node)) return false;
    for (let n = node; n; n = n.parent) if (this.touched.has(n)) return false;
    return true;
  }

  /** Can every node in `nodes` be replaced in this run? */
  canReplaceAll(nodes) {
    return nodes.every((n) => this.canReplace(n));
  }

  replace(node, replacement) {
    if (!this.canReplace(node)) return false;
    const p = node.parent;
    if (p.type === 'ExportSpecifier' || p.type === 'ImportSpecifier') return false;
    if (p.type === 'Property' && p.shorthand && p.value === node) {
      if (p.key === node) p.key = { type: 'Identifier', name: node.name };
      p.shorthand = false;
    }
    if (node.parentIndex !== null && node.parentIndex !== undefined) p[node.parentKey][node.parentIndex] = replacement;
    else p[node.parentKey] = replacement;
    this.touched.add(node);
    for (let a = p; a; a = a.parent) this.dirty.add(a);
    this.count++;
    return true;
  }

  /** Remove a statement (or a VariableDeclarator). */
  remove(node) {
    if (node.type === 'VariableDeclarator') {
      if (!this.canReplace(node)) return false;
      node.__removed = true;
      this.touched.add(node);
      for (let a = node.parent; a; a = a.parent) this.dirty.add(a);
      this.count++;
      return true;
    }
    return this.replace(node, { type: 'EmptyStatement', __removed: true });
  }

  /** Replace one statement with several. Outside a statement list they become a block. */
  splice(stmt, statements) {
    if (inStatementList(stmt)) return this.replace(stmt, { type: 'BlockStatement', body: statements, __splice: true });
    return this.replace(stmt, { type: 'BlockStatement', body: statements });
  }
}
