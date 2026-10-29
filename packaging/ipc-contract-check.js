'use strict';
/* IPC 参数契约检查（P0-1）。
   背景：1.6.7 的界面调用 invoke('self_update_download') 时漏了 version，
   后台只能回「缺少参数 version」。这类前后端参数不匹配，靠人工 review 很难每次都盯住，
   所以在 preflight / 打包前静态扫一遍界面里的 invoke 调用：
   - 契约里列了每个命令的必需参数；
   - 界面的第二个参数是对象字面量时，逐个核对 key；
   - 第二个参数是变量 / 动态表达式时跳过（记为 dynamic），不误报。
   只扫 UI（main.js 走 callSidecar，不在这条链上）。 */
const fs = require('fs');
const path = require('path');

const UI = path.resolve(__dirname, '..', 'apps', 'electron', 'ui');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(__dirname, 'ipc-contract.json'), 'utf8'));

function lineOf(s, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (s[i] === '\n') n++;
  return n;
}
function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}
function readString(s, i) {
  const q = s[i];
  i++;
  let out = '';
  while (i < s.length) {
    const c = s[i++];
    if (c === '\\') { out += s[i++] || ''; continue; }
    if (c === q) return { value: out, end: i };
    out += c;
  }
  return null;
}
function topLevelKeys(objText) {
  const keys = [];
  let depth = 0, quote = null, i = 0;
  while (i < objText.length) {
    const c = objText[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
    if (depth === 0 && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < objText.length && /[\w$]/.test(objText[j])) j++;
      const name = objText.slice(i, j);
      const k = skipWs(objText, j);
      const next = objText[k];
      // key: value / shorthand key / 最后一个 key
      if (next === ':' || next === ',' || next === '}' || k >= objText.length) keys.push(name);
      i = j;
      continue;
    }
    i++;
  }
  return [...new Set(keys)];
}
function parseCall(src, start) {
  let i = start + 'invoke('.length;
  i = skipWs(src, i);
  if (src[i] !== "'" && src[i] !== '"') return { cmd: null };
  const str = readString(src, i);
  if (!str) return { cmd: null };
  const cmd = str.value;
  i = skipWs(src, str.end);
  if (src[i] === ')') return { cmd, keys: [], dynamic: false };
  if (src[i] !== ',') return { cmd, dynamic: true };
  i = skipWs(src, i + 1);
  if (src[i] === '{') {
    let depth = 0, quote = null, j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === '\\') { j++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    return { cmd, keys: topLevelKeys(src.slice(i + 1, j - 1)), dynamic: false };
  }
  return { cmd, dynamic: true };
}

if (process.argv.includes('--self-test')) {
  const bad = parseCall("invoke('self_update_download')", 0);
  const good = parseCall("invoke('self_update_download', { version: p.latest })", 0);
  if (bad.dynamic || bad.keys.length !== 0 || !good.keys.includes('version')) {
    console.log('SELF-TEST FAILED: 解析器没认出缺少 version 的调用');
    process.exit(1);
  }
  console.log('SELF-TEST OK: 能识别 invoke(\'self_update_download\') 缺 version');
  process.exit(0);
}

const files = fs.readdirSync(UI).filter((f) => f.endsWith('.js') && f !== 'i18n.js');
let total = 0, checked = 0, dynamic = 0;
const errors = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(UI, f), 'utf8');
  let idx = 0;
  while ((idx = src.indexOf('invoke(', idx)) !== -1) {
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    const prefix = src.slice(lineStart, idx).trim();
    const found = idx;
    idx += 'invoke('.length;
    if (prefix.startsWith('//') || prefix.startsWith('*')) continue;
    const call = parseCall(src, found);
    if (!call.cmd) continue;
    const req = CONTRACT[call.cmd];
    if (!req) continue;
    total++;
    if (call.dynamic) { dynamic++; continue; }
    const missing = req.filter((k) => !call.keys.includes(k));
    if (missing.length) {
      errors.push(f + ':' + lineOf(src, found) + ": invoke('" + call.cmd + "') 缺少必需参数 " +
        missing.join(', ') + '；实际参数 [' + (call.keys.join(', ') || '无') + ']');
    } else {
      checked++;
    }
  }
}
console.log('IPC 契约：扫描 ' + files.length + ' 个 UI 文件，命中契约命令 ' + total +
  ' 处（已验证 ' + checked + '，动态参数跳过 ' + dynamic + '）');
for (const e of errors) console.log('  [BAD] ' + e);
if (errors.length) {
  console.log('FAILED: ' + errors.length + ' 处缺少必需参数');
  process.exit(1);
}
console.log('OK');
