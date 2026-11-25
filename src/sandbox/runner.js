// Host side of the sandbox: one child process per batch of jobs.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));

function permissionFlag() {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return ['--permission'];
  if (flags.has('--experimental-permission')) return ['--experimental-permission'];
  return [];
}

export const SANDBOX_FLAGS = permissionFlag();

/**
 * @param {{prelude: string, exprs: string[]}[]} jobs
 * @returns {({error: string} | {values: ({ok: true, v: any} | {ok: false, e: string})[]})[]}
 */
export function runJobs(jobs, opts = {}) {
  if (!jobs.length) return [];
  const req = JSON.stringify({
    jobs,
    timeout: opts.timeout ?? 1000,
    preludeTimeout: opts.preludeTimeout ?? 5000,
    checkSideEffects: opts.checkSideEffects ?? true,
  });
  const res = spawnSync(process.execPath, [
    ...SANDBOX_FLAGS,
    `--max-old-space-size=${opts.memoryMb ?? 512}`,
    WORKER,
  ], {
    input: req,
    env: {},
    cwd: os.tmpdir(),
    timeout: opts.totalTimeout ?? 120_000,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) {
    const why = res.error ? res.error.message : (res.stderr || `exit ${res.status}`).split('\n').slice(0, 3).join(' | ');
    return jobs.map(() => ({ error: `sandbox failed: ${why}` }));
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    return jobs.map(() => ({ error: `bad sandbox output: ${err.message}` }));
  }
}

/** Convert a sandbox value back into a JS value. */
export function fromSandbox(v) {
  if (v.array) return v.array.map(fromSandbox);
  switch (v.t) {
    case 'u': return undefined;
    case 'null': return null;
    case 'big': return BigInt(v.v);
    case 'n': return typeof v.v === 'string' ? Number(v.v) : v.v;
    case 'a': return v.v.map(fromSandbox);
    default: return v.v;
  }
}
