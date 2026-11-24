// Sandbox worker. Runs in a separate Node process started with the permission model
// enabled (no fs writes, no child processes, no workers, no native addons) and an empty
// environment. Code is evaluated in a fresh vm context whose global is a null-prototype
// object, so `this.constructor.constructor('return process')()` cannot reach the host.
//
// This is defense in depth, NOT a security boundary: analyse hostile samples inside a
// disposable VM.
//
// Protocol: stdin = JSON { jobs: [{ prelude, exprs: [code] }], timeout, preludeTimeout }
//           stdout = JSON [{ error } | { values: [ {ok:true, v} | {ok:false, e} ] }]
import vm from 'node:vm';

const HARDEN = String.raw`(function (g) {
  'use strict';
  var B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function atob(s) {
    s = String(s).replace(/[\t\n\f\r ]+/g, '');
    if (s.length % 4 === 0) s = s.replace(/==?$/, '');
    var out = '', bits = 0, acc = 0;
    for (var i = 0; i < s.length; i++) {
      var c = B.indexOf(s.charAt(i));
      if (c < 0) throw new Error('InvalidCharacterError');
      acc = (acc << 6) | c; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 255); }
    }
    return out;
  }
  function btoa(s) {
    s = String(s); var out = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('InvalidCharacterError');
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B.charAt(n >> 18 & 63) + B.charAt(n >> 12 & 63) +
        (i + 1 < s.length ? B.charAt(n >> 6 & 63) : '=') + (i + 2 < s.length ? B.charAt(n & 63) : '=');
    }
    return out;
  }
  function nondet() { throw new Error('non-deterministic API blocked by sandbox'); }
  g.atob = atob; g.btoa = btoa;
  Math.random = nondet;
  var D = function () { nondet(); }; D.now = nondet; D.prototype = Date.prototype; g.Date = D;
  if (typeof performance !== 'undefined') g.performance = undefined;
  g.window = g; g.self = g;

  var MAXS = 64 * 1024 * 1024, MAXA = 1000;
  function enc(v, d) {
    switch (typeof v) {
      case 'string': if (v.length > MAXS) throw new Error('string too long'); return { t: 's', v: v };
      case 'boolean': return { t: 'b', v: v };
      case 'number':
        if (v !== v) return { t: 'n', v: 'NaN' };
        if (v === Infinity) return { t: 'n', v: 'Infinity' };
        if (v === -Infinity) return { t: 'n', v: '-Infinity' };
        if (v === 0 && 1 / v < 0) return { t: 'n', v: '-0' };
        return { t: 'n', v: v };
      case 'undefined': return { t: 'u' };
      case 'bigint': return { t: 'big', v: String(v) };
      case 'object':
        if (v === null) return { t: 'null' };
        if (d === 0 && Array.isArray(v) && v.length <= MAXA) {
          var out = [];
          for (var i = 0; i < v.length; i++) { if (!(i in v)) throw new Error('hole'); out.push(enc(v[i], 1)); }
          return { t: 'a', v: out };
        }
    }
    throw new Error('unsupported result type');
  }
  // shallow-ish snapshot of global state, used to detect side effects of a call
  var gop = Object.getOwnPropertyNames;
  function snap() {
    var names = gop(g), vals = [], subs = [];
    for (var i = 0; i < names.length; i++) {
      var d = Object.getOwnPropertyDescriptor(g, names[i]);
      var v = d && 'value' in d ? d.value : d && d.get;
      vals.push(v);
      var sub = null;
      if (v && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype)) {
        var ks = gop(v);
        if (ks.length <= 5000) {
          sub = [];
          for (var j = 0; j < ks.length; j++) { var pd = Object.getOwnPropertyDescriptor(v, ks[j]); sub.push(ks[j], pd && pd.value); }
        }
      }
      subs.push(sub);
    }
    return { names: names, vals: vals, subs: subs };
  }
  // allowFnSwap: tolerate a global function being replaced by another function (self-redefinition)
  function same(a, b, allowFnSwap) {
    if (a.names.length !== b.names.length) return false;
    for (var i = 0; i < a.names.length; i++) {
      if (a.names[i] !== b.names[i]) return false;
      var x = a.vals[i], y = b.vals[i];
      if (!Object.is(x, y) && !(allowFnSwap && typeof x === 'function' && typeof y === 'function')) return false;
      var s = a.subs[i], t = b.subs[i];
      if ((s === null) !== (t === null)) return false;
      if (s) {
        if (s.length !== t.length) return false;
        for (var j = 0; j < s.length; j++) if (!Object.is(s[j], t[j])) return false;
      }
    }
    return true;
  }
  Object.defineProperty(g, '__untangle', { value: { enc: enc, snap: snap, same: same }, enumerable: false });
})(this);`;

function runJob(job, opts) {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  vm.runInContext(HARDEN, context, { timeout: 1000 });
  if (job.prelude) vm.runInContext(job.prelude, context, { timeout: opts.preludeTimeout, filename: 'prelude.js' });

  const check = opts.checkSideEffects !== false;
  const values = [];
  for (const code of job.exprs) {
    try {
      const wrapped = `(function(){ var u = __untangle, before = u.snap(); var r1 = (${code}\n); var mid = u.snap();` +
        ` var r2 = (${code}\n); var after = u.snap();` +
        ` return JSON.stringify({ r1: u.enc(r1, 0), r2: u.enc(r2, 0), se1: !u.same(before, mid, true), se2: !u.same(mid, after, false) }); })()`;
      const out = JSON.parse(vm.runInContext(wrapped, context, { timeout: opts.timeout }));
      if (JSON.stringify(out.r1) !== JSON.stringify(out.r2)) { values.push({ ok: false, e: 'non-deterministic' }); continue; }
      // A call may swap a global function for another one (self-redefining decoders) but must not
      // otherwise touch global state; the repeat call must not touch it at all.
      if (check && (out.se1 || out.se2)) { values.push({ ok: false, e: 'side effects' }); continue; }
      const r = out.r1;
      values.push({ ok: true, v: r.t === 'a' ? { array: r.v } : r });
    } catch (err) {
      values.push({ ok: false, e: String(err && err.message || err) });
    }
  }
  return { values };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  const opts = { timeout: req.timeout || 1000, preludeTimeout: req.preludeTimeout || 5000, checkSideEffects: req.checkSideEffects };
  const results = req.jobs.map((job) => {
    try { return runJob(job, opts); } catch (err) { return { error: String(err && err.message || err) }; }
  });
  process.stdout.write(JSON.stringify(results));
});
