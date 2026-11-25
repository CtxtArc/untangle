// Optional readability pass (--rename): give machine-generated binding names (`_0x4676b2`,
// `AYTRJHTPTRRUBMPC38299`) names derived from how the binding is used:
//   var a = new ActiveXObject('WScript.Shell')      -> shell
//   var b = sh.ExpandEnvironmentStrings('%TEMP%')   -> temp
//   for (var c = 0; c < n; c++)                      -> i
//   catch (d)                                        -> err
//   anything else                                    -> fn1 / arg1 / v1 ...
//
// It never changes behaviour: only declared bindings are renamed (never implicit globals or
// properties), every new name is unique in the whole program (so nothing can be shadowed or
// captured), and no binding is renamed where code could reach it by name at runtime: a function
// containing a direct eval, or the global scope when the script uses eval / with / this[expr].
import { propName, NOT, staticValue } from './values.js';
import { Context } from './context.js';
import { evalCanSee } from './modules/safe/cleanup.js';

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false ' +
  'finally for function if implements import in instanceof interface let new null package private protected public return ' +
  'static super switch this throw true try typeof var void while with yield await arguments eval undefined NaN Infinity ' +
  'WScript ActiveXObject GetObject console window document global globalThis self top parent frames require module exports ' +
  'process Buffer Math JSON Object Array String Number Boolean Date RegExp Error Function Symbol Promise Map Set').split(' '));

const COM = {
  'wscript.shell': 'shell', 'scripting.filesystemobject': 'fso', 'adodb.stream': 'stream', 'wscript.network': 'network',
  'msxml2.xmlhttp': 'http', 'microsoft.xmlhttp': 'http', 'msxml2.serverxmlhttp': 'http', 'winhttp.winhttprequest.5.1': 'http',
  'microsoft.xmldom': 'xmlDoc', 'msxml2.domdocument': 'xmlDoc', 'schedule.service': 'scheduler', 'shell.application': 'shellApp',
  'scripting.dictionary': 'dict', 'wbemscripting.swbemlocator': 'wmiLocator',
};

/** Does this look like an obfuscator's name rather than a human's? */
export function looksGenerated(name) {
  if (/^_0x[0-9a-f]+$/i.test(name)) return true;
  if (/^[A-Za-z_$][A-Za-z_$]*\d{3,}$/.test(name) && name.length >= 8) return true; // PREFIX38299
  if (/^[A-Z]{12,}\d*$/.test(name)) return true;                                    // AYTRJHTPTRRUBMPC
  if (/^[Il1O0_]{6,}$/.test(name)) return true;                                     // IlI1lIl
  return false;
}

const camel = (s) => {
  const parts = String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  // keep words that are already camelCase (MyDocuments -> myDocuments); flatten ALLCAPS (TEMP -> temp)
  const word = (p, i) => {
    const w = p === p.toUpperCase() ? p.toLowerCase() : p;
    return i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1);
  };
  const out = parts.map(word).join('');
  return /^[0-9]/.test(out) ? '' : out.slice(0, 24);
};

function comName(arg) {
  if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return null;
  const id = arg.value.replace(/^new:/i, '').toLowerCase();
  if (Object.hasOwn(COM, id)) return COM[id];
  if (/^winmgmts/i.test(arg.value)) return 'wmi';
  const last = id.split('.').filter((p) => !/^\d+$/.test(p)).pop();
  return last ? camel(last) : null;
}

const EXT = /\.(exe|dll|ps1|vbs|vbe|js|jse|wsf|hta|bat|cmd|lnk|zip|dat|txt|tmp|mui|xml|json|log)$/i;

/** What a string literal holds, judged from its text. */
function strKind(v, whole = true) {
  if (whole && v.length >= 1024) return 'payload';
  if (/^\s*<(\?xml|!doctype|[a-z])/i.test(v)) return 'xml';
  if (/^https?:\/\//i.test(v)) return 'url';
  if (/^\s*--|^\s*(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|schtasks|certutil|bitsadmin)(\.exe)?\b/i.test(v) ||
      /\.exe"?\s+[-/]/i.test(v)) return 'cmdLine';
  const ext = v.match(EXT);
  if (ext) return ext[1].toLowerCase() + 'Path';
  if (/^([A-Za-z]:)?\\|\\$|^%\w+%/.test(v)) return 'path';
  return null;
}

const STRING_METHODS = { indexOf: 'pos', lastIndexOf: 'pos', search: 'pos', substring: 'part', substr: 'part', slice: 'part',
  split: 'parts', charCodeAt: 'code', fromCharCode: 'chr', toUpperCase: 'str', toLowerCase: 'str', trim: 'str', replace: 'str' };

/** A name suggested by the value a binding is initialised with. */
function fromValue(init) {
  if (!init) return null;
  switch (init.type) {
    case 'NewExpression':
    case 'CallExpression': {
      const c = init.callee;
      const cname = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' ? propName(c) : NOT;
      if (cname === 'ActiveXObject' || cname === 'CreateObject' || cname === 'GetObject') return comName(init.arguments[0]);
      if (cname === NOT || typeof cname !== 'string') return null;
      if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && !c.object.variable && c.object.name === 'Math') return 'num';
      if (Object.hasOwn(STRING_METHODS, cname)) return STRING_METHODS[cname]; // own keys only: never toString / constructor
      if (cname === 'ExpandEnvironmentStrings' && init.arguments[0]?.type === 'Literal') return camel(String(init.arguments[0].value).replace(/%/g, '')) || 'envPath';
      if (cname === 'SpecialFolders' && init.arguments[0]?.type === 'Literal') return camel(init.arguments[0].value);
      if (/^(CreateTextFile|OpenTextFile|GetFile)$/.test(cname)) return 'file';
      if (/^(GetFolder|CreateFolder)$/.test(cname)) return 'folder';
      if (cname === 'createElement') return 'element';
      if (cname === 'SpawnInstance_') return 'instance';
      if (cname === 'Date') return 'date';
      if (/^(get|Get|create|Create|read|Read|open|Open)[A-Z]/.test(cname)) return camel(cname.replace(/^(get|create|read|open)/i, ''));
      return null;
    }
    case 'Literal': {
      if (typeof init.value === 'string') return strKind(init.value) || 'str';
      if (typeof init.value === 'number') return 'num';
      if (typeof init.value === 'boolean') return 'flag';
      return null;
    }
    case 'BinaryExpression': {
      if (init.operator !== '+') return null;
      // operands left to right: 'C:\\x\\' + name + '.exe'
      const ops = [];
      const walkOps = (n) => { if (n.type === 'BinaryExpression' && n.operator === '+') { walkOps(n.left); walkOps(n.right); } else ops.push(n); };
      walkOps(init);
      const lits = ops.filter((x) => x.type === 'Literal' && typeof x.value === 'string').map((x) => x.value);
      const first = ops[0].type === 'Literal' && typeof ops[0].value === 'string' ? strKind(ops[0].value, false) : null;
      if (first === 'xml' || first === 'url' || first === 'cmdLine') return first;
      const last = ops[ops.length - 1];
      if (last.type === 'Literal' && typeof last.value === 'string' && EXT.test(last.value)) return strKind(last.value, false);
      if (lits.some((x) => /^([A-Za-z]:)?\\|\\$|^%\w+%/.test(x))) return 'path';
      const sv = staticValue(init);
      return typeof sv === 'string' ? strKind(sv) || 'str' : lits.length ? 'str' : null;
    }
    case 'MemberExpression': {
      const name = propName(init);
      if (name === 'length') return 'len';
      return typeof name === 'string' && !/^\d+$/.test(name) ? camel(name) || null : null;
    }
    case 'ArrayExpression': return 'arr';
    case 'ObjectExpression': return 'obj';
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': return 'fn';
    case 'TemplateLiteral': return 'str';
    default: return null;
  }
}

const COUNTERS = ['i', 'j', 'k', 'l', 'm', 'n'];

/** Base name for a variable: [base, numbered?] */
function suggest(v) {
  const def = v.defs[0];
  switch (def.type) {
    case 'CatchClause': return ['err', false];
    case 'FunctionName': return ['fn', true];
    case 'ClassName': return ['Cls', true];
    case 'Parameter': return ['arg', true];
    case 'ImplicitGlobalVariable': return null;
    case 'Variable': {
      const decl = def.parent;
      const loop = decl && decl.parent;
      if (loop && /^For(In|Of)?Statement$/.test(loop.type) && (loop.init === decl || loop.left === decl)) {
        return loop.type === 'ForStatement' ? ['#counter', false] : ['key', false];
      }
      const base = fromValue(def.node.init);
      if (base) return [base, false];
      // assigned later: name from the first plain assignment
      for (const r of v.references) {
        if (r.isWrite() && !r.init && r.writeExpr) {
          const b = fromValue(r.writeExpr);
          if (b) return [b, false];
          break;
        }
      }
      return ['v', true];
    }
    default: return null;
  }
}

function usedNames(tree) {
  const names = new Set(RESERVED);
  for (const s of tree.scopeManager.scopes) {
    for (const v of s.variables) names.add(v.name);
    for (const r of s.through) names.add(r.identifier.name);
  }
  return names;
}

function globalsByName(tree) {
  if (tree.sourceType !== 'script') return true;
  for (const s of tree.scopeManager.scopes) {
    if (s.type === 'with') return true;
    if (s.references.some((r) => r.identifier.name === 'eval' && !r.resolved)) return true;
  }
  for (const n of tree.nodes) {
    if (n.type === 'ThisExpression' && tree.scopeAt(n).variableScope.type === 'global') {
      const m = n.parent;
      if (!(m.type === 'MemberExpression' && m.object === n && propName(m) !== NOT)) return true;
    }
  }
  return false;
}

/**
 * Rename bindings in place. mode: 'auto' (generated-looking names only) or 'all'.
 * Returns the number of bindings renamed.
 */
export function renameBindings(tree, { mode = 'auto', keepGlobals = false } = {}) {
  const names = usedNames(tree);
  const ctx = new Context(tree, {}, () => {});
  const skipGlobals = keepGlobals || globalsByName(tree);
  const counters = new Map(); // function scope -> next loop counter index
  const seq = new Map();      // base -> next number
  let renamed = 0;
  const fresh = (base, numbered) => {
    let name;
    if (!numbered && !names.has(base)) name = base;
    else {
      let n = seq.get(base) || 1;
      do { name = `${base}${n++}`; } while (names.has(name));
      seq.set(base, n);
    }
    names.add(name);
    return name;
  };
  for (const scope of tree.scopeManager.scopes) {
    if (scope.type === 'global' && skipGlobals) continue;
    if (evalCanSee(scope) || scope.type === 'with') continue;
    if (scope.type === 'module' || tree.sourceType === 'module' && scope.type === 'global') continue;
    for (const v of scope.variables) {
      if (!v.defs.length || v.name === 'arguments') continue;
      if (mode !== 'all' && !looksGenerated(v.name)) continue;
      if (v.defs.some((d) => d.type === 'ImportBinding' || d.name.type !== 'Identifier')) continue;
      const s = suggest(v);
      if (!s) continue;
      let [base, numbered] = s;
      if (base === '#counter') {
        const fs = v.scope.variableScope;
        const k = counters.get(fs) || 0;
        counters.set(fs, k + 1);
        base = COUNTERS[k] || 'idx';
        numbered = !COUNTERS[k];
      }
      const ids = new Set([...v.defs.map((d) => d.name), ...v.references.map((r) => r.identifier)]);
      if (!ctx.canReplaceAll([...ids])) continue;
      const name = fresh(base, numbered);
      for (const id of ids) ctx.replace(id, { type: 'Identifier', name });
      renamed++;
    }
  }
  return renamed;
}
