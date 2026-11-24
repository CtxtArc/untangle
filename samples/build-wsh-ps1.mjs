// Builds samples/wsh-ps1.js: a benign WSH dropper look-alike with the constructs seen in
// trojanized printer-admin scripts: thousands of `this.x = ...` junk globals, a junk-padded hex
// blob cleaned by reassignment, a hex+XOR decode loop, a junk-padded PowerShell command line run
// hidden through WMI Win32_Process.Create, WScript.Quit() and unreachable code after it.
// The "payload" is a harmless PowerShell one-liner.
import fs from 'node:fs';

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const used = new Set(['blob', 'out', 'i', 'b', 'k', 'sh', 'fso', 'tmp', 'whole', 'cmdline', 'clean', 'wmi', 'proc', 'params', 'startup', 'f', 'decoy', 'dropper']);
const name = () => { let n; do { n = rawName(); } while (used.has(n)); used.add(n); return n; };
const rawName = () => Array.from({ length: 5 + Math.floor(rnd() * 6) }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * (rnd() < 0.3 ? 36 : 26))]).join('').replace(/^[0-9]/, 'q');
const num = () => (rnd() < 0.5 ? Math.floor(rnd() * 9999) : Math.round(rnd() * 99999) / 100);

function junk(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = name(), b = name(), c = name(), s = name();
    switch (i % 8) {
      case 0: out.push(`this.${a} = '${s}';`, `this.${b} = ${a} === '${s}';`); break;
      case 1: out.push(`this.${a} = [${num()}, ${num()}, ${num()}];`, `this.${b} = ${a}[0] * 2;`); break;
      case 2: out.push(`this.${a} = { ${c}: ${num()}, ${s}: true };`, `${a}.${c}++;`); break;
      case 3: out.push(`var ${a} = new Date().getTime();`, `var ${b} = ${a} > 0;`); break;
      case 4: out.push(`this.${a} = { val: ${num()} };`, `this.${b} = ${a}.val > 0;`); break;
      case 5: out.push(`this.${a} = [];`, `${a}[0] = { ${c}: '${s}' };`); break;
      case 6: out.push(`this.${a} = ${num()};`, `this.${c} = ${num()};`, `this.${b} = ${a} + ${c};`); break;
      default: out.push(`var ${a} = { ${c}: ${num()}, ${s}: true };`, `${a}.${c}++;`);
    }
  }
  return out.join('\n');
}

const JUNK = 'ῒ\u3195\u215Eń\uD800\uDE8Aᚋᇭ쪐㷹ꂱⱬ\u2047\u19FC䏊ઈ';
const pad = (s) => s.split('').join(JUNK);
const KEY = 'OPEnSYkR5jpbOA';
const ps1 = "Write-Output 'synthetic stage 2: nothing to see here'\r\n$x = 1 + 1\r\n";
const hex = [...ps1].map((ch, i) => (ch.charCodeAt(0) ^ KEY.charCodeAt(i % KEY.length)).toString(16).padStart(2, '0')).join('');
const cmd = (whole) => `'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe -${pad('WindowStyle')} ${pad('Hidden')} -${pad('ExecutionPolicy')} ${pad('Bypass')} -${pad('Command')} "& \\'' + ${whole} + '\\'; ${pad('Remove-Item')}"'`;

const src = `${junk(150)}
function decoy(a) {
  WScript.Echo('usage: decoy -p printer');
  return a;
}
function dropper() {
  var blob = '${pad(hex)}';
  blob = blob.split('${JUNK}').join('');
  var out = '';
  for (var i = 0; i < blob.length; i += 2) {
    var b = parseInt(blob.substr(i, 2), 16);
    var k = '${KEY}'.charCodeAt(i / 2 % ${KEY.length});
    out += String.fromCharCode(b ^ k);
  }
  var sh = new ActiveXObject('WScript.Shell');
  var fso = new ActiveXObject('Scripting.FileSystemObject');
  var tmp = sh.ExpandEnvironmentStrings('%TEMP%');
  var whole = tmp + '\\\\' + fso.GetTempName() + '.ps1';
  var cmdline = ${cmd('whole')};
  var clean = cmdline.split('${JUNK}').join('');
  var wmi = new ActiveXObject('WbemScripting.SWbemLocator').ConnectServer('.', 'root\\\\cimv2');
  var proc = wmi.Get('Win32_Process');
  var params = proc.Methods_.Item('Create').InParameters.SpawnInstance_();
  var startup = wmi.Get('Win32_ProcessStartup').SpawnInstance_();
  startup.ShowWindow = 0;
  params.ProcessStartupInformation = startup;
  params.CommandLine = clean;
  var f = fso.CreateTextFile(whole, true);
  f.Write(out);
  f.Close();
  proc.ExecMethod_('Create', params);
  WScript.Quit();
  if (neverDefined === true) {
    decoy(1);
  }
}
${junk(40)}
dropper();
${junk(150)}
`;
fs.writeFileSync(new URL('./wsh-ps1.js', import.meta.url), src);
fs.writeFileSync(new URL('./wsh-ps1.expected.ps1', import.meta.url), ps1);
console.log('written samples/wsh-ps1.js');
