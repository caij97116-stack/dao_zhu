// tests/card-adapt.test.mjs — M12 正则美化自适应单测（node 直接跑）
import { buildCardAdaptHtml } from '../src/card-adapt.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }

// ---------- buildCardAdaptHtml（纯函数）----------
const html = buildCardAdaptHtml();
ok(typeof html === 'string' && html.length > 0, '应返回非空字符串');
ok(html.includes('id="dz-recheck-cards"'), '应包含重渲染按钮 #dz-recheck-cards');
ok(html.includes('检查并重渲染全部卡片'), '按钮文案应正确');
ok(html.includes('[card]'), '说明应提及本插件的 [card] 卡片');
ok(html.includes('dz-beauty-h'), '应带分区标题样式');

// ---------- 卡片响应式 CSS 已落地（style.css）----------
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
ok(css.includes('@media (max-width: 480px)'), 'style.css 应含窄屏断点');
ok(/\.dz-card\s*\{/.test(css), '应存在 .dz-card 规则');
ok(css.includes('flex-wrap: wrap'), '窄屏下 .dz-row 应允许换行（键值可堆叠）');

// ---------- 结果 ----------
console.log(`— M12 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
