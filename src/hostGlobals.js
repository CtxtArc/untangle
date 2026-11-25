// Names that already mean something on the global object of a browser, Node or Windows Script Host.
// Writing one may have an effect (`location = url` navigates, `name` survives navigation, `onload`
// installs a handler), so an assignment to it is never treated as a scratch variable.
export const HOST_GLOBALS = new Set([
  // ECMAScript (a fixed list, so the output does not depend on the Node version running untangle)
  ...('globalThis Infinity NaN undefined eval isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent ' +
    'encodeURI encodeURIComponent escape unescape Object Function Array Number Boolean String Symbol BigInt Date ' +
    'Promise RegExp Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError JSON Math ' +
    'Intl ArrayBuffer SharedArrayBuffer Atomics DataView Int8Array Uint8Array Uint8ClampedArray Int16Array ' +
    'Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array Map Set WeakMap ' +
    'WeakSet WeakRef FinalizationRegistry Proxy Reflect').split(' '),
  // common hosts
  ...('console setTimeout setInterval setImmediate clearTimeout clearInterval clearImmediate queueMicrotask ' +
    'structuredClone fetch atob btoa process global Buffer require module exports URL URLSearchParams ' +
    'TextEncoder TextDecoder').split(' '),
  // browser window
  'window', 'self', 'top', 'parent', 'frames', 'opener', 'document', 'location', 'history', 'navigator', 'screen',
  'name', 'status', 'defaultStatus', 'length', 'closed', 'origin', 'event', 'external', 'frameElement',
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset',
  'screenX', 'screenY', 'screenLeft', 'screenTop', 'devicePixelRatio', 'localStorage', 'sessionStorage',
  'indexedDB', 'caches', 'crypto', 'performance', 'customElements', 'visualViewport', 'menubar', 'toolbar',
  'locationbar', 'personalbar', 'scrollbars', 'statusbar', 'clientInformation', 'styleMedia', 'speechSynthesis',
  'chrome', 'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'stop', 'focus', 'blur', 'find', 'postMessage',
  'Image', 'Option', 'Audio', 'XMLHttpRequest', 'ActiveXObject', 'GetObject', 'execScript',
  // Windows Script Host
  'WScript', 'WSH', 'ScriptEngine', 'ScriptEngineMajorVersion', 'ScriptEngineMinorVersion', 'ScriptEngineBuildVersion',
]);

export function isHostGlobal(name) {
  return HOST_GLOBALS.has(name) || /^on[a-z]/.test(name);
}
