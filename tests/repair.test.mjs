// tests/repair.test.mjs — M3 纯函数单测（node 直接跑，无需依赖）
// 运行：node tests/repair.test.mjs
import { repairMessage, containsCard } from '../src/repair.js';

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
const r = (t) => repairMessage(t);

console.log('— M3 修复层：基础用例 —');
// 1) 干净格式 → 原样返回，未修复
{
  const input = '[card]\ntitle=角色状态面板\ntheme=blue\n体力:90/100\n心情:平静\n背包:钥匙,地图\n[/card]';
  const o = r(input);
  eq(o.text, input, '干净输入原样返回');
  ok(!o.repaired, '干净输入 repaired=false');
  eq(o.fixes, [], '干净输入无修复记录');
}
// 2) 漏写闭合标签（EOF）→ 自动补
{
  const input = '[card]\ntitle=面板\n体力:90/100';
  const o = r(input);
  eq(o.text, '[card]\ntitle=面板\n体力:90/100\n[/card]', 'EOF 漏闭合自动补 [/card]');
  ok(o.repaired, 'EOF 漏闭合 repaired=true');
}
// 3) 漏写闭合标签（下一个 [card] 前）→ 自动补
{
  const input = '[card]\ntitle=一\n[card]\ntitle=二\n[/card]';
  const o = r(input);
  eq(o.text, '[card]\ntitle=一\n[/card]\n[card]\ntitle=二\n[/card]', '连续开启时自动闭合前一块');
}
// 4) 大小写漂移
{
  const input = '[CARD]\ntitle=1\n[/Card]';
  const o = r(input);
  eq(o.text, '[card]\ntitle=1\n[/card]', '大小写漂移归一');
}
// 5) 标签内空格
{
  const input = '[ card ]\ntitle=1\n[/ card ]';
  const o = r(input);
  eq(o.text, '[card]\ntitle=1\n[/card]', '标签内多余空格归一');
}
// 6) CRLF 换行
{
  const input = '[card]\r\ntitle=1\r\n[/card]';
  const o = r(input);
  eq(o.text, '[card]\ntitle=1\n[/card]', 'CRLF 统一为 LF');
}
// 7) 悬挂闭合标签 → 丢弃
{
  const input = '[/card]\ntitle=1';
  const o = r(input);
  eq(o.text, 'title=1', '悬挂 [/card] 被丢弃，正文保留');
  ok(o.fixes.length === 1, '悬挂闭合有修复记录');
}
// 8) 分隔符两侧多空格
{
  const input = '[card]\ntitle = 面板\n[/card]';
  const o = r(input);
  eq(o.text, '[card]\ntitle=面板\n[/card]', '分隔符两侧空格去除');
}
// 9) 全角冒号
{
  const input = '[card]\n体力 ： 90/100\n[/card]';
  const o = r(input);
  eq(o.text, '[card]\n体力:90/100\n[/card]', '全角冒号归一 + 去空格');
}
// 10) 卡片内空行 / 尾部空格
{
  const input = '[card]\n\n  title=1  \n\n[/card]';
  const o = r(input);
  eq(o.text, '[card]\ntitle=1\n[/card]', '卡片内空行与首尾空格清理');
}
// 11) 纯正文（无卡片）→ 廉价跳过，原样返回
{
  const input = '你好，今天天气不错，我们继续冒险吧。';
  const o = r(input);
  eq(o.text, input, '纯正文原样返回');
  ok(!o.repaired && o.fixes.length === 0, '纯正文零成本跳过');
  ok(containsCard(input) === false, 'containsCard 对纯正文返回 false');
}

console.log('\n— M3 修复层：性能（数百/上千层不卡约束）—');
{
  const N = 2000;
  const malformed = '[card]\ntitle=楼层{i}\n体力:90/100\n背包:钥匙'; // 缺闭合
  const prose = '这是一段普通对话正文，没有卡片语法，应当零成本跳过。';
  const msgs = [];
  for (let i = 0; i < N; i++) {
    msgs.push(i % 2 === 0 ? malformed.replace('{i}', String(i)) : prose);
  }
  const t0 = Date.now();
  let repairedCount = 0, err = 0;
  for (const m of msgs) {
    try { if (repairMessage(m).repaired) repairedCount++; }
    catch (e) { err++; }
  }
  const dt = Date.now() - t0;
  console.log(`  • ${N} 条消息（半数含缺闭合卡片）总耗时 ${dt}ms，修复 ${repairedCount} 条，异常 ${err} 条`);
  ok(err === 0, '压测无异常抛出');
  ok(repairedCount === N / 2, '半数缺闭合消息均被修复');
  // 单条消息应在亚毫秒级：2000 条 < 2000ms（每条约 1ms 预算，留足余量）
  ok(dt < 2000, `2000 条总耗时 < 2000ms（实测 ${dt}ms）`);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
