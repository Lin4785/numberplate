/**
 * 静态自检：确认前端里出现的每个 data-action 都有对应的处理函数。
 *
 * 这类"拼写不一致"的问题只会表现为点击无反应，不报错也不提示，很难排查，
 * 所以用脚本兜住：npm run lint:actions
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 由事件委托在 change 事件上处理、不需要出现在 actions 里的动作 */
const HANDLED_IN_CHANGE = new Set(['self-segment', 'self-digit']);

function extractUsed(source) {
  const used = new Set();
  for (const match of source.matchAll(/data-action=["'`]([a-zA-Z][a-zA-Z-]*)["'`]/g)) {
    used.add(match[1]);
  }
  return [...used].sort();
}

function extractDefined(source) {
  const start = source.indexOf('const actions = {');
  if (start < 0) return [];
  // 只取 actions 对象本身（以顶格的 "};" 结束），避免把后面的代码也算进来
  const end = source.indexOf('\n};', start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const defined = new Set();
  // "  key() {}" / "  async key() {}" / "  'key'(param) {}"
  for (const match of body.matchAll(/^\s{2}(?:async\s+)?'?([a-zA-Z][a-zA-Z-]*)'?\s*\(\s*[a-zA-Z,\s]*\)\s*\{/gm)) {
    defined.add(match[1]);
  }
  // "'key': async () => {}"
  for (const match of body.matchAll(/^\s{2}'([a-z][a-z-]*)'\s*:/gm)) {
    defined.add(match[1]);
  }
  return [...defined].sort();
}

let failures = 0;

for (const file of ['public/app.js', 'public/admin.js']) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const used = extractUsed(source);
  const defined = extractDefined(source);
  const missing = used.filter((name) => !defined.includes(name) && !HANDLED_IN_CHANGE.has(name));
  const unused = defined.filter((name) => !used.includes(name));

  console.log(`${file}`);
  console.log(`  标记中的动作 : ${used.join(', ')}`);
  console.log(`  已定义的处理 : ${defined.join(', ')}`);
  console.log(`  缺少处理函数 : ${missing.length ? `缺失 -> ${missing.join(', ')}` : '无'}`);
  console.log(`  定义了但未用 : ${unused.length ? unused.join(', ') : '无'}`);
  failures += missing.length;
}

if (failures > 0) {
  console.error(`\n发现 ${failures} 个没有处理函数的 data-action，点击它们将没有任何反应。`);
  process.exit(1);
}
console.log('\n所有 data-action 均有对应处理函数。');
