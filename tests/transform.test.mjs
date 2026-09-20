// tests/transform.test.mjs — M4 模糊正则 + 多兜底 单测（node 直接跑）
// 运行：node tests/transform.test.mjs
import { parseCards, extractCards } from '../src/transform.js';

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

console.log('— M4 解析层：基础用例 —');
// 1) 单卡片 + 多字段
{
  const input = '[card]\ntitle=角色状态面板\ntheme=blue\n体力:90/100\n心情:平静\n背包:钥匙,地图\n[/card]';
  const { segments, cards } = parseCards(input);
  eq(segments.length, 1, '单卡片 → 1 个片段');
  ok(segments[0].type === 'card', '片段类型为 card');
  eq(cards[0].fields.title, '角色状态面板', 'title 解析正确');
  eq(cards[0].fields.theme, 'blue', 'theme 解析正确');
  eq(cards[0].fields['体力'], '90/100', '全角/半角冒号字段（体力）解析正确');
  eq(cards[0].fields['心情'], '平静', '心情 解析正确');
  eq(cards[0].fields['背包'], '钥匙,地图', '背包 解析正确');
}
// 2) 多卡片
{
  const input = '[card]\ntitle=一\n[/card]\n杂项文字\n[card]\ntitle=二\n[/card]';
  const { cards } = parseCards(input);
  eq(cards.length, 2, '多卡片数量正确');
  eq(cards[0].fields.title, '一', '第一卡 title');
  eq(cards[1].fields.title, '二', '第二卡 title');
}
// 3) 卡片嵌入正文（分段正确）
{
  const input = '之前的话\n[card]\ntitle=面板\n[/card]\n之后的话';
  const { segments } = parseCards(input);
  eq(segments.map(s => s.type), ['text', 'card', 'text'], '分段顺序 text/card/text');
  eq(segments[0].value, '之前的话\n', '前导正文保留');
  eq(segments[2].value, '\n之后的话', '尾随正文（含卡片后换行）保留');
}
// 4) 漏闭合标签（默认 repair=true → 先补后解析）
{
  const input = '[card]\ntitle=面板\n体力:90/100';
  const { cards } = parseCards(input);
  eq(cards.length, 1, '漏闭合被修复并解析为 1 卡');
  eq(cards[0].fields.title, '面板', '漏闭合卡 title 正确');
}
// 5) 纯开启、无闭合、且关闭 repair（走 Tier2 兜底）
{
  const input = '[card]\ntitle=面板\n体力:90/100';
  const { cards } = parseCards(input, { repair: false });
  eq(cards.length, 1, 'repair=false 时 Tier2 兜底仍抓到 1 卡');
  eq(cards[0].fields.title, '面板', 'Tier2 兜底 title 正确');
  ok(cards[0]._dangling === true, '标记来自漏闭合兜底路径');
}
// 6) 大小写 / 标签内空格漂移
{
  const input = '[CARD]\ntitle=A\n[/ CARD ]';
  const { cards } = parseCards(input);
  eq(cards.length, 1, '大小写+空格标签被解析');
  eq(cards[0].fields.title, 'A', '漂移标签内字段正确');
}
// 7) 全角冒号字段
{
  const input = '[card]\n体力 ： 90/100\n[/card]';
  const { cards } = parseCards(input);
  eq(cards[0].fields['体力'], '90/100', '全角冒号归一后字段正确');
}
// 8) 非字段行归入 __notes
{
  const input = '[card]\ntitle=面板\n这是一句自由描述\n[/card]';
  const { cards } = parseCards(input);
  ok(Array.isArray(cards[0].fields.__notes) && cards[0].fields.__notes[0] === '这是一句自由描述', '非字段行进入 __notes');
}
// 9) 无卡片 → 整段当正文，cards 为空
{
  const input = '普通对话，没有卡片语法。';
  const { segments, cards } = parseCards(input);
  eq(cards.length, 0, '无卡片 cards 为空');
  eq(segments.length, 1, '无卡片 → 单正文片段');
  eq(segments[0].type, 'text', '片段类型为 text');
  eq(segments[0].value, input, '正文原样保留');
}
// 10) extractCards 便捷函数
{
  const input = '[card]\ntitle=一\n[/card][card]\ntitle=二\n[/card]';
  eq(extractCards(input).length, 2, 'extractCards 返回 2 卡');
}

console.log('\n— M4 解析层：性能（数百/上千层不卡约束）—');
{
  const N = 2000;
  const template = '[card]\ntitle=楼层{i}\ntheme=blue\n体力:90/100\n心情:平静\n背包:钥匙,地图\n[/card]';
  const msgs = [];
  for (let i = 0; i < N; i++) msgs.push(template.replace('{i}', String(i)));
  const t0 = Date.now();
  let totalCards = 0, err = 0;
  for (const m of msgs) {
    try { totalCards += parseCards(m).cards.length; } catch (e) { err++; }
  }
  const dt = Date.now() - t0;
  console.log(`  • ${N} 条消息解析总耗时 ${dt}ms，卡片 ${totalCards} 张，异常 ${err} 条`);
  ok(err === 0, '压测无异常抛出');
  ok(totalCards === N, '每楼 1 卡全部解析到');
  ok(dt < 2000, `2000 条解析 < 2000ms（实测 ${dt}ms）`);
}

// 11) __notes 双来源混用必须安全（回归：M17 用真实渲染截图时挖出的两个真 bug）
{
  // 11a) AI 显式写 `__notes=…` → 走字段分支，是字符串
  {
    const { cards } = parseCards('[card]\ntitle=A\n__notes=我害怕依赖松子的爱。\n[/card]');
    eq(cards[0].fields.__notes, '我害怕依赖松子的爱。', '显式 __notes=… 解析为字符串字段');
  }
  // 11b) 显式在前 + 裸文本行在后 → 旧版会 TypeError（fields.__notes.push is not a function），整楼美化失败
  {
    let threw = null, cards = null;
    try {
      ({ cards } = parseCards('[card]\ntitle=A\n__notes=第一句\n裸文本第二句\n[/card]'));
    } catch (e) { threw = e; }
    ok(threw === null, '显式 __notes=… 与裸文本行混用不应抛异常（旧版 TypeError）');
    ok(Array.isArray(cards[0].fields.__notes), '混用后 __notes 归一为数组');
    eq(cards[0].fields.__notes.join('|'), '第一句|裸文本第二句', '混用后两句都保留且顺序正确');
  }
  // 11c) 裸文本行在前 + 显式字段行在后：走字段覆盖语义，显式值胜出（字符串），不抛错
  {
    const { cards } = parseCards('[card]\ntitle=A\n裸文本第一句\n__notes=显式第二句\n[/card]');
    eq(cards[0].fields.__notes, '显式第二句', '反序混用：后出现的显式字段值生效（与字段覆盖语义一致）');
  }
  // 11d) 空值字段行 `key=` / `key:` → 丢弃，不得被当作裸文本落进 __notes
  {
    const { cards } = parseCards('[card]\ntitle=A\n__notes=\n[/card]');
    ok(!('__notes' in cards[0].fields), '空 __notes= 被丢弃，不落进备注');
    eq(cards[0].fields.title, 'A', '空字段行不影响同卡其它字段');
  }
  {
    const { cards } = parseCards('[card]\ntitle=B\n备注:\n[/card]');
    ok(!('备注' in cards[0].fields) && !('__notes' in cards[0].fields), '空 备注: 同样被丢弃');
  }
  // 11e) 值里含冒号/等号不应被误判（有值就仍是正常字段）
  {
    const { cards } = parseCards('[card]\ntitle=A\n时间=12:30\n[/card]');
    eq(cards[0].fields['时间'], '12:30', '值含冒号仍是正常字段');
  }
  // 11f) 含冒号的行按既有字段语义处理成字段（不是备注）——记录现状，防止新规则（空字段丢弃）误伤
  {
    const { cards } = parseCards('[card]\ntitle=A\n他说：走吧\n[/card]');
    eq(cards[0].fields['他说'], '走吧', '含冒号且有值 → 按字段行解析（非空字段规则不误吃）');
    ok(!('__notes' in cards[0].fields), '含冒号的行不会同时落进备注');
  }
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
