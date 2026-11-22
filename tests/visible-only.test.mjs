/**
 * The hard constraint, as a test: the collector may only use what a person can
 * see and do on the page. These checks fail the build if that ever changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COLLECTOR = path.join(ROOT, 'collector');

const sources = readdirSync(COLLECTOR)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => ({ file: f, text: readFileSync(path.join(COLLECTOR, f), 'utf8') }));

test('采集器不导入演示数据或图表模块', () => {
  for (const { file, text } of sources) {
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(!/demo\/data|chart\/|console\//.test(spec), `${file} 导入了 ${spec}`);
    }
  }
});

test('采集器不碰页面全局、data-* 或网络接口', () => {
  const forbidden = [
    /window\.__/,
    /\b__NEXT_DATA__\b/,
    /\bdataset\b/,
    /getAttribute\(['"]data-/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
  ];
  for (const { file, text } of sources) {
    for (const re of forbidden) {
      assert.ok(!re.test(text), `${file} 匹配了禁用模式 ${re}`);
    }
  }
});

test('页面读取只发生在 DOM 文本与可见状态上', () => {
  const pageSource = sources.find((s) => s.file === 'page.mjs')?.text ?? '';
  // The only evaluate/$$eval calls allowed read textContent / aria-pressed /
  // hidden, or scroll the canvas into view.
  const calls = [...pageSource.matchAll(/page\.(\$\$?eval|evaluate)\(/g)].length;
  const textReads = [...pageSource.matchAll(/textContent|aria-pressed|hidden|scrollIntoView/g)].length;
  assert.ok(calls > 0 && textReads >= calls, '页面读取应只读取可见文本/可见状态');
});
