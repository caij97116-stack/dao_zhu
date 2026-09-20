// tests/renderer.test.mjs — M5 渲染 + 容错 单测（node 直接跑）
// 运行：node tests/renderer.test.mjs
import { renderMessage, setCustomCardRenderer, makeProcessor } from '../src/renderer.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg, '\n    期望:', e, '\n    实际:', a); }
}

console.log('— M5 渲染层：基础用例 —');
// 1) 普通卡片 → 含卡片结构 + 主题 + 字段
{
  const input = '[card]\ntitle=角色状态面板\ntheme=blue\n体力:90/100\n心情:平静\n[/card]';
  const { html, changed, cards } = renderMessage(input);
  ok(changed && typeof html === 'string', '有卡片 → changed=true 且返回 html');
  ok(html.includes('class="dz-card'), '输出包含 dz-card');
  ok(html.includes('dz-theme-blue'), '主题类 dz-theme-blue 正确');
  ok(html.includes('角色状态面板'), 'title 出现在标题栏');
  ok(html.includes('体力') && html.includes('90/100'), '字段行渲染');
}
// 2) 无卡片 → 不改
{
  const input = '普通对话，没有卡片。';
  const { html, changed } = renderMessage(input);
  eq(changed, false, '无卡片 changed=false');
  eq(html, null, '无卡片 html=null（不触碰原 DOM）');
}
// 3) 字段值含 <script> → 转义，绝不注入裸脚本
{
  const input = '[card]\ntitle=<script>alert(1)</script>\n[/card]';
  const { html } = renderMessage(input);
  ok(!html.includes('<script>'), '字段值中的 <script> 被转义，未注入裸脚本');
  ok(html.includes('&lt;script&gt;'), '字段值以实体形式安全呈现');
}
// 4) 未知主题 → 降级默认 blue
{
  const input = '[card]\ntitle=X\ntheme=rainbow\n[/card]';
  const { html } = renderMessage(input);
  ok(html.includes('dz-theme-blue'), '未知主题降级为 dz-theme-blue');
}
// 5) iframe 合法 https → 沙箱 iframe 渲染
{
  const input = '[card]\ntitle=地图\ntheme=green\niframe=https://example.com/map\n[/card]';
  const { html } = renderMessage(input, { allowIframe: true });
  ok(html.includes('<iframe') && html.includes('sandbox="allow-scripts"'), '合法 https iframe 以沙箱渲染');
  ok(html.includes('https://example.com/map'), 'iframe src 正确');
}
// 6) iframe javascript: → 拒绝
{
  const input = '[card]\ntitle=X\niframe=javascript:alert(1)\n[/card]';
  const { html } = renderMessage(input, { allowIframe: true });
  ok(!html.includes('<iframe'), 'javascript: iframe 被拒绝，不渲染');
}
// 7) 单卡渲染失败 → 降级为原始文本（转义），不抛半成品
{
  setCustomCardRenderer(() => { throw new Error('boom'); });
  const input = '[card]\ntitle=面板\n[/card]';
  const { html } = renderMessage(input);
  ok(html.includes('dz-error'), '渲染异常卡降级为 dz-error');
  ok(html.includes('[card]') && html.includes('[/card]'), '降级展示原始卡片文本（转义）');
  setCustomCardRenderer(null); // 还原
}
// 8) 正文段保留换行
{
  const input = '之前的话\n[card]\ntitle=面板\n[/card]';
  const { html } = renderMessage(input);
  ok(html.startsWith('之前的话<br'), '前导正文保留且换行转为 <br>');
}
// 9) 高楼层压测：2000 楼渲染
{
  const N = 2000;
  const tpl = '[card]\ntitle=楼层{i}\ntheme=purple\n体力:90/100\n[/card]';
  const msgs = [];
  for (let i = 0; i < N; i++) msgs.push(tpl.replace('{i}', String(i)));
  const t0 = Date.now();
  let total = 0, err = 0;
  for (const m of msgs) {
    try { const r = renderMessage(m); if (r.changed) total++; } catch (e) { err++; }
  }
  const dt = Date.now() - t0;
  console.log(`  • ${N} 条消息渲染总耗时 ${dt}ms，渲染 ${total} 张，异常 ${err} 条`);
  ok(err === 0, '渲染压测无异常');
  ok(total === N, '每楼卡片均渲染');
  ok(dt < 2000, `2000 条渲染 < 2000ms（实测 ${dt}ms）`);
}

// 10) makeProcessor 读取 dataset.dzOrig（支持设置变更后重新美化，不重复解析渲染产物）
{
  // 模拟一个带 dataset 的 textEl（node 下无真实 DOM，用 defineProperty 模拟 innerHTML）
  const makeEl = (textContent, dzOrig) => {
    const el = { dataset: {}, textContent: textContent || '' };
    if (dzOrig != null) el.dataset.dzOrig = dzOrig;
    let _h = '';
    Object.defineProperty(el, 'innerHTML', { get: () => _h, set: (v) => { _h = v; } });
    return el;
  };
  const proc = makeProcessor({ enabled: true });
  const el1 = makeEl('[card]\ntitle=X\n[/card]');
  proc({ textEl: el1 });
  ok(el1.dataset.dzOrig === '[card]\ntitle=X\n[/card]', '原始文本存入 dataset.dzOrig');
  ok(typeof el1.innerHTML === 'string' && el1.innerHTML.includes('dz-card'), '渲染后 innerHTML 为卡片');
  // 模拟“再次处理”：此时 textContent 已被渲染产物占据，必须从 dzOrig 读取，而非被污染
  const el2 = makeEl('<div class="dz-card dz-theme-blue">...</div>', '[card]\ntitle=X\n[/card]');
  const proc2 = makeProcessor({ enabled: true });
  proc2({ textEl: el2 });
  ok(el2.innerHTML.includes('dz-card') && !el2.innerHTML.includes('dz-card dz-theme-blue">...'),
    '从 dzOrig 重新渲染，不被已渲染产物污染');
  // 禁用时处理器应直接跳过
  const el3 = makeEl('[card]\ntitle=Y\n[/card]');
  const proc3 = makeProcessor({ enabled: false });
  proc3({ textEl: el3 });
  ok(el3.dataset.dzOrig == null && el3.innerHTML === '', 'enabled=false 时处理器不美化');
}

// 11) 备注/独白的两条来源都必须渲染（回归：显式 __notes=… 曾被静默吞掉）
{
  // 11a) 裸文本行 → 解析层归入 __notes 数组
  const a = renderMessage('[card]\ntitle=A\n我不习惯被爱。\n[/card]', {});
  ok(a.html.includes('dz-notes') && a.html.includes('我不习惯被爱。'), '裸文本行 → 渲染为 dz-notes');
  // 11b) AI 显式写 __notes=…（字符串）→ 同样必须渲染
  const b = renderMessage('[card]\ntitle=A\n__notes=我害怕依赖松子的爱。\n[/card]', {});
  ok(b.html.includes('dz-notes'), '显式 __notes=… → 应生成 dz-notes（历史 bug：内容被静默吞掉）');
  ok(b.html.includes('我害怕依赖松子的爱。'), '显式 __notes=… → 文本必须出现');
  ok(!b.html.includes('>__notes<'), '显式 __notes=… → 不应被当作普通字段行渲染成 dz-k');
  // 11c) 显式 + 裸文本行同时出现：两者都要在（一条字符串 + 一个数组）
  const c = renderMessage('[card]\ntitle=A\n__notes=第一句\n裸文本第二句\n[/card]', {});
  ok(c.html.includes('第一句') && c.html.includes('第二句'), '显式与裸文本行共存时都不丢');
  // 11d) 空备注不应产出空壳节点
  const d1 = renderMessage('[card]\ntitle=A\n__notes=\n[/card]\n\n[card]\ntitle=B\n[/card]', {});
  ok(!d1.html.includes('dz-notes'), '空 __notes 不产出空壳');
  // 11e) 备注里含 HTML/换行 → 转义（不注入），且换行保留
  const e = renderMessage('[card]\ntitle=A\n__notes=<img src=x onerror=alert(1)>\n[/card]', {});
  ok(!e.html.includes('<img src=x'), '备注内容必须转义，不注入 HTML');
  ok(e.html.includes('&lt;img'), '备注中的尖括号被实体化');
  const f = renderMessage('[card]\ntitle=A\n__notes=甲\n乙\n[/card]', {});
  ok(f.html.includes('<br>') || f.html.includes('甲\n乙'), '备注换行得到保留（br 或原换行）');
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
