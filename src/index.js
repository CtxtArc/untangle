// untangle - restringer-style JavaScript deobfuscator.
//
// The engine runs every static module repeatedly until the code stops changing. Only when
// `dynamic: true` is given does it then run the sandboxed modules (which execute fragments of the
// sample) once, and repeat while anything changes. Without it, the sandboxed modules are only
// asked what they *would* evaluate, and that count is returned as `pending`. After every module
// that changed something, the code is regenerated and re-parsed so the next module sees
// fresh parent links and scope information.
import { createHash } from 'node:crypto';
import { Tree } from './ast.js';
import { Context } from './context.js';
import { renameBindings } from './rename.js';
import { toStandard, fromStandard } from './jscript.js';

import normalizeComputed from './modules/safe/normalizeComputed.js';
import foldConstants from './modules/safe/foldConstants.js';
import simplifyBranches from './modules/safe/simplifyBranches.js';
import inlineConstants from './modules/safe/inlineConstants.js';
import resolveMemberAccess from './modules/safe/resolveMemberAccess.js';
import inlineProxyVariables from './modules/safe/inlineProxyVariables.js';
import inlineSingleUseTemps from './modules/safe/inlineSingleUseTemps.js';
import inlineProxyFunctions from './modules/safe/inlineProxyFunctions.js';
import resolveProxyObjects from './modules/safe/resolveProxyObjects.js';
import unflattenControlFlow from './modules/safe/unflattenControlFlow.js';
import unwrapEval from './modules/safe/unwrapEval.js';
import splitSequences from './modules/safe/splitSequences.js';
import normalizeDeclarations from './modules/safe/normalizeDeclarations.js';
import splitJoinConcat from './modules/safe/splitJoinConcat.js';
import foldBuiltinCalls from './modules/safe/foldBuiltinCalls.js';
import mergeAccumulators from './modules/safe/mergeAccumulators.js';
import splitRedeclarations from './modules/safe/splitRedeclarations.js';
import foldJoinLoops from './modules/safe/foldJoinLoops.js';
import removeUnreachable from './modules/safe/removeUnreachable.js';
import { cleanup, removeDeadCode } from './modules/safe/cleanup.js';
import resolveBuiltinCalls from './modules/unsafe/resolveBuiltinCalls.js';
import resolveDecoderCalls from './modules/unsafe/resolveDecoderCalls.js';
import resolveEvalArguments from './modules/unsafe/resolveEvalArguments.js';
import resolveConstantLoops from './modules/unsafe/resolveConstantLoops.js';

export const SAFE_MODULES = [
  foldConstants,
  normalizeComputed,
  simplifyBranches,
  splitSequences,
  normalizeDeclarations,
  mergeAccumulators,
  splitRedeclarations,
  foldJoinLoops,
  inlineConstants,
  resolveMemberAccess,
  inlineProxyVariables,
  inlineSingleUseTemps,
  resolveProxyObjects,
  inlineProxyFunctions,
  unflattenControlFlow,
  unwrapEval,
  foldBuiltinCalls,
  splitJoinConcat,
  removeUnreachable,
  removeDeadCode,
  cleanup,
];

export const UNSAFE_MODULES = [resolveBuiltinCalls, resolveEvalArguments, resolveConstantLoops, resolveDecoderCalls];

export const ALL_MODULES = [...SAFE_MODULES, ...UNSAFE_MODULES];

const DEFAULTS = {
  dynamic: false, // never execute sample code unless explicitly asked
  maxIterations: 100,
  removeDeadCode: true,
  keepGlobals: false,
  rename: false, // false | 'auto' (generated-looking names) | 'all'
  disable: [],
  verbose: false,
  log: (msg) => process.stderr.write(msg + '\n'),
  sandbox: { timeout: 1000, preludeTimeout: 5000, checkSideEffects: true },
};

const hash = (s) => createHash('sha1').update(s).digest('hex');

const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));

export function deobfuscate(code, userOptions = {}) {
  const user = defined(userOptions);
  if (user.dynamic === undefined && user.unsafe !== undefined) user.dynamic = user.unsafe; // pre-0.4 option name
  const options = { ...DEFAULTS, ...user, sandbox: { ...DEFAULTS.sandbox, ...defined(user.sandbox) } };
  const log = options.verbose ? options.log : () => {};
  const disabled = new Set(options.disable);
  if (!options.removeDeadCode) disabled.add('removeDeadCode');

  const jscript = toStandard(code); // JScript-only syntax (`obj.Item(k) = v`) made parseable, undone on output
  if (jscript.count) log(`jscript: ${jscript.count} call assignment(s)`);
  const tree = new Tree(jscript.code);
  const original = fromStandard(tree.code);
  tree.commit(); // normalise formatting once so "changed" means a real transformation
  const stats = {};
  const broken = new Set();
  const problems = []; // modules disabled for the rest of the run (always reported by the CLI)
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
      problems.push({ module: mod.name, reason: 'crashed', error: String(err && err.stack || err) });
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
      problems.push({ module: mod.name, reason: 'unparsable output', error: err.message });
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
    if (!options.dynamic) break;
    let changed = 0;
    for (const mod of UNSAFE_MODULES) changed += runModule(mod);
    if (!changed) break;
  }

  // optional readability pass on the final code
  let renamed = 0;
  if (options.rename) {
    try {
      renamed = renameBindings(tree, { mode: options.rename === 'all' ? 'all' : 'auto', keepGlobals: options.keepGlobals });
      if (renamed) tree.commit();
    } catch (err) {
      problems.push({ module: 'rename', reason: 'crashed', error: String(err && err.stack || err) });
      tree.load(tree.code);
      renamed = 0;
    }
  }

  // static mode: report what the sandboxed modules would have evaluated, without running anything
  const pending = {};
  if (!options.dynamic) {
    for (const mod of UNSAFE_MODULES) {
      if (disabled.has(mod.name)) continue;
      const ctx = new Context(tree, { ...options, planOnly: true }, log);
      try {
        mod.run(ctx);
      } catch (err) {
        log(`[${mod.name}] planning failed: ${err.message}`);
      }
      if (ctx.planned) pending[mod.name] = ctx.planned;
    }
  }

  const out = fromStandard(tree.code);
  return { code: out, original, changed: hash(out) !== hash(original), iterations, stats, pending, problems, renamed, dynamic: options.dynamic };
}

export { Tree };
