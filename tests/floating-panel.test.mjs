// tests/floating-panel.test.mjs — M9 骨架纯函数单测（node 直接跑，无需浏览器）
import { computeClampedPosition, defaultNavigatorState, pickToggleHost, TAB_ORDER } from '../src/floating-panel.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}

// ---------- computeClampedPosition ----------
const vp = { w: 1000, h: 800 };
const size = { w: 360, h: 420 };

// 1) 完全在视口内 → 原样返回（受 margin 约束）
let p = computeClampedPosition({ x: 300, y: 200 }, size, vp);
eq(p, { x: 300, y: 200 }, '视口内位置应原样返回');

// 2) 左越界 → 夹到 margin
p = computeClampedPosition({ x: -50, y: 200 }, size, vp);
eq(p.x, 8, '左越界应夹到 margin(8)');

// 3) 右越界 → 夹到 maxX
p = computeClampedPosition({ x: 9999, y: 200 }, size, vp);
eq(p.x, vp.w - size.w - 8, '右越界应夹到视口右侧留边距');

// 4) 上越界 → 夹到 margin
p = computeClampedPosition({ x: 300, y: -10 }, size, vp);
eq(p.y, 8, '上越界应夹到 margin(8)');

// 5) 下越界 → 夹到 maxY
p = computeClampedPosition({ x: 300, y: 9999 }, size, vp);
eq(p.y, vp.h - size.h - 8, '下越界应夹到视口底部留边距');

// 6) 面板比视口还大 → 不出现负值（max 取下限）
p = computeClampedPosition({ x: 0, y: 0 }, { w: 5000, h: 5000 }, { w: 1000, h: 800 });
ok(p.x >= 0 && p.y >= 0, '超大面板不应被夹成负坐标');

// 7) 自定义 margin
p = computeClampedPosition({ x: -100, y: -100 }, size, vp, 20);
eq(p, { x: 20, y: 20 }, '自定义 margin 应生效');

// ---------- defaultNavigatorState ----------
// 8) 无入参 → 全部默认
let s = defaultNavigatorState(null);
ok(s.open === false && s.tab === 'roster' && s.pos === null && s.showButton === true,
  '空状态应给默认（未开/名册/无位置/显示按钮）');

// 9) 合法状态应保留（含新增的 showButton）
s = defaultNavigatorState({ open: true, tab: 'beautify', pos: { x: 100, y: 50 }, showButton: false });
eq(s, { open: true, tab: 'beautify', pos: { x: 100, y: 50 }, showButton: false },
  '合法状态应原样保留（含 showButton）');

// 9b) 缺省 showButton 应回落为 true
s = defaultNavigatorState({ open: true });
ok(s.showButton === true, '未提供 showButton 应回落为显示(true)');

// 10) 非法 tab → 回落默认
s = defaultNavigatorState({ tab: 'hacker' });
ok(s.tab === 'roster', '非法 tab 应回落默认 tab');

// 11) 非法 pos → null
s = defaultNavigatorState({ pos: { x: 'a', y: null } });
ok(s.pos === null, '非法 pos 应回落 null');

// 12) tab 必须是合法枚举成员
ok(TAB_ORDER.includes('roster') && TAB_ORDER.includes('beautify') && TAB_ORDER.includes('binding'),
  'TAB_ORDER 应包含 roster/beautify/binding');

// ---------- 结果 ----------
// ---- 按钮挂载容器选择：原生左侧按钮栏 #leftSendForm 优先（对齐 ☰ / 🪄 所在原生栏）----
function mockDoc(ids) {
  return { querySelector: (sel) => (ids.includes(sel) ? { id: sel.replace('#', '') } : null) };
}
{
  // 两个容器都在 → 选左侧原生栏
  const r = pickToggleHost(mockDoc(['#leftSendForm', '#rightSendForm']));
  ok(r && r.sel === '#leftSendForm', '左右栏都在时应优先选 #leftSendForm（原生栏）');
  // 只有右侧 → 降级右侧
  const r2 = pickToggleHost(mockDoc(['#rightSendForm']));
  ok(r2 && r2.sel === '#rightSendForm', '无左栏时降级到 #rightSendForm');
  // 都没有 → 返回 null（调用方再降级浮动钮）
  const r3 = pickToggleHost(mockDoc([]));
  ok(r3 && r3.el === null && r3.sel === null, '两侧都没有时返回 null 交给降级');
  // 传空/非法 doc → 不抛错
  let threw = false;
  try { pickToggleHost(null); pickToggleHost({}); } catch (_) { threw = true; }
  ok(!threw, 'doc 为空或非法时不抛错');
  // querySelector 抛错 → 安全跳过该候选，继续下一个
  const badDoc = { querySelector: (sel) => { if (sel === '#leftSendForm') throw new Error('boom'); return { id: 'rightSendForm' }; } };
  const r4 = pickToggleHost(badDoc);
  ok(r4 && r4.sel === '#rightSendForm', '左栏查询抛错时应安全跳过并选右栏');
}

console.log(`— M9 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
