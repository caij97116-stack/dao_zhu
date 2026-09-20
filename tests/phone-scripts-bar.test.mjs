// tests/phone-scripts-bar.test.mjs — M16-B 纯函数单测
import { computeBarBottom, sliceVisible } from '../src/phone-scripts-bar.js';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) { passed++; } else { failed++; console.error(`  ✗ ${msg} | 期望 ${sb} 实际 ${sa}`); }
}

// ---- computeBarBottom ----
// 1) 输入框顶部 600、视口高 800 → 距底 200
eq(computeBarBottom(600, 800, 0), 200, '输入框上方 200');
// 2) 输入框贴底（top=800） → 0
eq(computeBarBottom(800, 800, 0), 0, '输入框贴底 → 0');
// 3) 输入框很高（top=200） → 距底 600
eq(computeBarBottom(200, 800, 0), 600, '输入框上方 600');
// 4) 缺 sendFormTop（NaN） → 退化为 0（safe）
eq(computeBarBottom(NaN, 800, 0), 0, '无输入框 → 0');
// 5) 带安全区 10
eq(computeBarBottom(600, 800, 10), 210, '带安全区 +10');
// 6) 安全区非法 → 0
eq(computeBarBottom(600, 800, NaN), 200, '安全区非法被忽略');
// 7) winH 非法 → 0
eq(computeBarBottom(600, NaN, 0), 0, '视口高非法 → 0');

// ---- sliceVisible ----
const big = Array.from({ length: 60 }, (_, i) => ({ id: 't' + i }));
// 8) 超过上限 50 → 截 50，more=10
let r = sliceVisible(big);
eq(r.items.length, 50, '渲染上限 50');
eq(r.more, 10, 'more=10');
// 9) 低于上限 → 全量
r = sliceVisible(Array.from({ length: 30 }, (_, i) => ({ id: 't' + i })));
eq(r.items.length, 30, '低于上限全量');
eq(r.more, 0, 'more=0');
// 10) 非数组 → 安全兜底
r = sliceVisible(null);
eq(r.items.length, 0, '非数组 items 空');
eq(r.more, 0, '非数组 more 0');
// 11) 自定义上限
r = sliceVisible(big, 10);
eq(r.items.length, 10, '自定义上限 10');
eq(r.more, 50, '自定义 more 50');

console.log(`— M16-B 结果：${passed} 通过 / ${failed} 失败 —`);
process.exit(failed ? 1 : 0);
