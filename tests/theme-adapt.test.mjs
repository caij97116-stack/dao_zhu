// tests/theme-adapt.test.mjs — M11 整体美化自适应纯函数单测（node 直接跑）
import {
  defaultThemeAdaptState,
  detectDevice,
  BASELINE_CSS,
} from '../src/theme-adapt.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}

// ---------- defaultThemeAdaptState ----------
let s = defaultThemeAdaptState(null);
eq(s, { enabled: false, target: 'auto', patch: '' }, '空状态应给默认（关/自动/空补丁）');

s = defaultThemeAdaptState({ enabled: true, target: 'mobile', patch: '#sheld{width:100%}' });
eq(s, { enabled: true, target: 'mobile', patch: '#sheld{width:100%}' }, '合法状态应原样保留');

s = defaultThemeAdaptState({ target: 'phone' });
ok(s.target === 'auto', '非法 target 应回落 auto');

s = defaultThemeAdaptState({ enabled: 'yes' });
ok(s.enabled === false, '非布尔 enabled 应回落 false');

// ---------- detectDevice ----------
// 手动优先
eq(detectDevice({ target: 'desktop' }), 'desktop', 'target=desktop 应返回 desktop');
eq(detectDevice({ target: 'mobile' }), 'mobile', 'target=mobile 应返回 mobile');
eq(detectDevice({ target: 'auto' }), 'desktop', 'auto 在 node(无 window) 应回落 desktop');

// ---------- BASELINE_CSS 不碰配色、只修布局 ----------
ok(BASELINE_CSS.includes('data-dz-theme-adapt'), '基线层应挂在 data-dz-theme-adapt 属性上');
ok(BASELINE_CSS.includes('max-width: 820px'), '应含 820px 手机断点');
ok(BASELINE_CSS.includes('overflow-x: auto'), '代码块应可横向滚动');
ok(BASELINE_CSS.includes('word-break: break-word'), '文字应可换行');
ok(BASELINE_CSS.includes('data-dz-device="mobile"'), '应支持强制手机布局分支');
// 关键：绝不覆盖主题配色（只修布局）
ok(!/background\s*:/.test(BASELINE_CSS), '基线层不得覆盖 background（保留主题配色）');
ok(!/color\s*:/.test(BASELINE_CSS), '基线层不得覆盖 color（保留主题配色）');
// 关键：绝不波及第三方浮窗（.floating-panel 是酒馆通用浮窗类名，ST-Chat-Jumper 等插件共用）
ok(!BASELINE_CSS.includes('.floating-panel'), '基线层不得约束通用 .floating-panel 类（避免干扰第三方浮窗）');

// ---------- 结果 ----------
console.log(`— M11 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
