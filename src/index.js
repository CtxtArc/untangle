// untangle - restringer-style JavaScript deobfuscator.
//
// The engine runs every safe module repeatedly until the code stops changing, then the
// sandboxed (unsafe) modules once, and repeats while anything changes. After every module
// that changed something, the code is regenerated and re-parsed so the next module sees
// fresh parent links and scope information.
import { createHash } from 'node:crypto';
import { Tree } from './ast.js';
import { Context } from './context.js';

import normalizeComputed from './modules/safe/normalizeComputed.js';
import foldConstants from './modules/safe/foldConstants.js';
import simplifyBranches from './modules/safe/simplifyBranches.js';
import inlineConstants from './modules/safe/inlineConstants.js';
import resolveMemberAccess from './modules/safe/resolveMemberAccess.js';
import inlineProxyVariables from './modules/safe/inlineProxyVariables.js';
import inlineProxyFunctions from './modules/safe/inlineProxyFunctions.js';
import resolveProxyObjects from './modules/safe/resolveProxyObjects.js';
import unflattenControlFlow from './modules/safe/unflattenControlFlow.js';
import unwrapEval from './modules/safe/unwrapEval.js';
import splitSequences from './modules/safe/splitSequences.js';
import splitJoinConcat from './modules/safe/splitJoinConcat.js';
import splitRedeclarations from './modules/safe/splitRedeclarations.js';
import { cleanup, removeDeadCode } from './modules/safe/cleanup.js';
import resolveBuiltinCalls from './modules/unsafe/resolveBuiltinCalls.js';
import resolveDecoderCalls from './modules/unsafe/resolveDecoderCalls.js';
import resolveEvalArguments from './modules/unsafe/resolveEvalArguments.js';

export const SAFE_MODULES = [
  foldConstants,
  normalizeComputed,
  simplifyBranches,
  splitSequences,
  splitRedeclarations,
  inlineConstants,
  resolveMemberAccess,
  inlineProxyVariables,
  resolveProxyObjects,
  inlineProxyFunctions,
  unflattenControlFlow,
  unwrapEval,
  splitJoinConcat,
  removeDeadCode,
  cleanup,
];

export const UNSAFE_MODULES = [resolveBuiltinCalls, resolveEvalArguments, resolveDecoderCalls];

export const ALL_MODULES = [...SAFE_MODULES, ...UNSAFE_MODULES];

const DEFAULTS = {
  unsafe: true,
  maxIterations: 100,
  removeDeadCode: true,
  keepGlobals: false,
  disable: [],
  verbose: false,
  log: (msg) => process.stderr.write(msg + '\n'),
  sandbox: { timeout: 1000, preludeTimeout: 5000, checkSideEffects: true },
};

const hash = (s) => createHash('sha1').update(s).digest('hex');

const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));

export function deobfuscate(code, userOptions = {}) {
  const user = defined(userOptions);
  const options = { ...DEFAULTS, ...user, sandbox: { ...DEFAULTS.sandbox, ...defined(user.sandbox) } };
  const log = options.verbose ? options.log : () => {};
  const disabled = new Set(options.disable);
  if (!options.removeDeadCode) disabled.add('removeDeadCode');

  const tree = new Tree(code);
  const original = tree.code;
  tree.commit(); // normalise formatting once so "changed" means a real transformation
  const stats = {};
  const broken = new Set();
  const seen = new Set([hash(tree.code)]);
  let iterations = 0;

  const runModule = (mod) => {
    if (disabled.has(mod.name) || broken.has(mod.name)) return 0;
    const ctx = new Context(tree, options, log);
    let n;
    try {
      n = mod.run(ctx);
    } catch (err) {
      log(`[${mod.name}] crashed: ${err.stack || err}`);
      broken.add(mod.name);
      tree.load(tree.code); // drop partial edits
      return 0;
    }
    if (!n) return 0;
    const before = tree.code;
    try {
      tree.commit();
    } catch (err) {
      log(`[${mod.name}] produced unparsable code, reverting and disabling it: ${err.message}`);
      broken.add(mod.name);
      tree.load(before);
      return 0;
    }
    if (tree.code === before) return 0;
    stats[mod.name] = (stats[mod.name] || 0) + n;
    log(`[${mod.name}] ${n} change(s)`);
    return n;
  };

  outer:
  while (iterations < options.maxIterations) {
    // safe modules to a fixpoint
    for (;;) {
      if (++iterations > options.maxIterations) break outer;
      let changed = 0;
      for (const mod of SAFE_MODULES) changed += runModule(mod);
      if (!changed) break;
      const h = hash(tree.code);
      if (seen.has(h)) break; // oscillation guard
      seen.add(h);
    }
    if (!options.unsafe) break;
    let changed = 0;
    for (const mod of UNSAFE_MODULES) changed += runModule(mod);
    if (!changed) break;
  }

  return { code: tree.code, original, changed: hash(tree.code) !== hash(original), iterations, stats };
}

export { Tree };
