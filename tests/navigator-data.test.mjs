// tests/navigator-data.test.mjs — M8 数据层纯函数单测（node 直接跑，无需依赖）
// 运行：node tests/navigator-data.test.mjs
import {
  buildCharacterMeta, getCharactersWithMeta, groupByWorld, groupByTags,
  getWorldNames, getTagNames, filterCharacters, sortCharacters,
  NO_WORLD, NO_TAG, refreshCharacterCache, getCharacterCache,
} from '../src/navigator-data.js';

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

const mkChar = (over = {}) => ({
  name: 'Alice', avatar: 'alice.png', date_last_chat: 100, chat_size: 5,
  data: { tags: ['hero', 'mage'], extensions: { world: 'Avalon', fav: true } },
  ...over,
});

console.log('— M8 数据层：buildCharacterMeta —');
{
  const m = buildCharacterMeta(mkChar(), 3);
  eq(m.chid, 3, 'chid 透传下标');
  eq(m.name, 'Alice', 'name 取自 .name');
  eq(m.avatar, 'alice.png', 'avatar 透传');
  eq(m.tags, ['hero', 'mage'], 'tags 取自 data.tags');
  eq(m.world, 'Avalon', 'world 取自 data.extensions.world');
  ok(m.fav === true, 'fav 取自 data.extensions.fav');
  eq(m.lastChat, 100, 'lastChat 取自顶层 date_last_chat');
  eq(m.chatSize, 5, 'chatSize 取自顶层 chat_size');
}
{
  // 缺字段 / 异常类型的防御
  const m = buildCharacterMeta({}, 0);
  eq(m.name, '(无名角色)', '空对象给默认名');
  eq(m.tags, [], '缺 tags 给空数组');
  eq(m.world, '', '缺 world 给空串');
  ok(m.fav === false, '缺 fav 默认 false');
  eq(m.lastChat, 0, '缺日期给 0');
}
{
  // ch_name 兜底 / c.fav 兜底 / 字符串数字转数字
  const m = buildCharacterMeta({
    ch_name: 'Bob', fav: true, date_last_chat: '200',
    data: { tags: ['x'], extensions: {} },
  }, 1);
  eq(m.name, 'Bob', 'name 回退到 ch_name');
  ok(m.fav === true, 'fav 回退到顶层 fav');
  eq(m.lastChat, 200, '字符串日期转数字');
}

console.log('— M8 数据层：getCharactersWithMeta —');
{
  const ctx = { characters: [mkChar({ name: 'A' }), mkChar({ name: 'B' }), null, mkChar({ name: 'C' })] };
  const list = getCharactersWithMeta(ctx);
  eq(list.length, 4, '长度含无效项（null 被安全处理）');
  eq(list[0].name, 'A', '第 0 项');
  eq(list[2].name, '(无名角色)', 'null 项安全降级');
  eq(list[2].chid, 2, 'chid 正确');
}
{
  // 缺 characters 时返回空数组而非抛错
  eq(getCharactersWithMeta({}).length, 0, '缺 characters 返回 []');
  eq(getCharactersWithMeta(null).length, 0, 'ctx 为 null 返回 []');
}

console.log('— M8 数据层：分组 —');
{
  const chars = [
    buildCharacterMeta(mkChar({ name: 'A', data: { tags: ['t1'], extensions: { world: 'W1' } } })),
    buildCharacterMeta(mkChar({ name: 'B', data: { tags: ['t1', 't2'], extensions: { world: 'W1' } } })),
    buildCharacterMeta(mkChar({ name: 'C', data: { tags: [], extensions: { world: '' } } })),
  ];
  const gw = groupByWorld(chars);
  eq([...gw.keys()].sort(), ['W1', NO_WORLD].sort(), '世界分组键');
  eq(gw.get('W1').length, 2, 'W1 下有 2 张卡');
  eq(gw.get(NO_WORLD).length, 1, '未关联世界 1 张卡');

  const gt = groupByTags(chars);
  ok(gt.has('t1') && gt.get('t1').length === 2, 't1 含 A、B');
  ok(gt.has('t2') && gt.get('t2').length === 1, 't2 含 B');
  ok(gt.has(NO_TAG) && gt.get(NO_TAG).length === 1, '无标签归入 NO_TAG');
}
{
  const chars = [buildCharacterMeta(mkChar({ data: { tags: ['z'], extensions: { world: 'W2' } } }))];
  eq(getWorldNames(chars), ['W2'], '世界名清单去重排序');
  eq(getTagNames(chars), ['z'], '标签清单去重排序');
  eq(getWorldNames([]), [], '空清单安全');
}

console.log('— M8 数据层：筛选 —');
{
  const chars = [
    buildCharacterMeta(mkChar({ name: 'Aquaman', data: { tags: ['sea'], extensions: { world: 'Ocean', fav: true } } })),
    buildCharacterMeta(mkChar({ name: 'Batman', data: { tags: ['dark'], extensions: { world: 'Ocean', fav: false } } })),
    buildCharacterMeta(mkChar({ name: 'Cat', data: { tags: ['dark'], extensions: { world: '' } } })),
  ];
  eq(filterCharacters(chars, { query: 'man' }).length, 2, 'query 命中 Aquaman/Batman');
  eq(filterCharacters(chars, { world: 'Ocean' }).length, 2, '按世界筛选');
  eq(filterCharacters(chars, { tag: 'dark' }).length, 2, '按标签筛选');
  eq(filterCharacters(chars, { favOnly: true }).length, 1, '仅收藏筛选');
  eq(filterCharacters(chars, { world: 'Ocean', favOnly: true }).length, 1, '世界+收藏组合');
  eq(filterCharacters(chars, { query: '海洋' }).length, 0, '中文 query 不误命中');
}

console.log('— M8 数据层：排序 —');
{
  const chars = [
    buildCharacterMeta(mkChar({ name: 'Charlie', data: { extensions: { fav: false } }, date_last_chat: 50, chat_size: 10 })),
    buildCharacterMeta(mkChar({ name: 'Alice', data: { extensions: { fav: true } }, date_last_chat: 30, chat_size: 99 })),
    buildCharacterMeta(mkChar({ name: 'Bob', data: { extensions: { fav: false } }, date_last_chat: 999, chat_size: 1 })),
  ];
  eq(sortCharacters(chars, 'name').map(c => c.name), ['Alice', 'Bob', 'Charlie'], '按名字');
  eq(sortCharacters(chars, 'fav').map(c => c.name), ['Alice', 'Bob', 'Charlie'], '收藏优先（Alice 在前）');
  eq(sortCharacters(chars, 'recent').map(c => c.name), ['Bob', 'Charlie', 'Alice'], '最近聊天（Bob 最新）');
  eq(sortCharacters(chars, 'mostChats').map(c => c.name), ['Alice', 'Charlie', 'Bob'], '聊天量（Alice 最大）');
}

console.log('— M8 数据层：缓存 —');
{
  const ctx = { characters: [mkChar({ name: 'A' }), mkChar({ name: 'B' })] };
  refreshCharacterCache(ctx);
  eq(getCharacterCache().length, 2, 'refresh 后缓存 2 项');
  eq(getCharacterCache()[0].name, 'A', '缓存内容正确');
  eq(getCharacterCache(), getCharacterCache(), '空缓存返回稳定对象');
}

console.log('— M8 数据层：性能（2000 角色不卡约束）—');
{
  const raw = [];
  for (let i = 0; i < 2000; i++) {
    raw.push(mkChar({
      name: 'C' + i,
      data: { tags: [i % 2 ? 'odd' : 'even'], extensions: { world: i % 3 ? 'W' + (i % 3) : '' } },
    }));
  }
  const t0 = performance.now();
  const meta = getCharactersWithMeta({ characters: raw });
  const gw = groupByWorld(meta);
  const gf = filterCharacters(meta, { query: 'C1999' });
  const gs = sortCharacters(meta, 'name');
  const t1 = performance.now();
  ok(meta.length === 2000, '2000 项元数据生成');
  ok(gw.size >= 3, '世界分组生成');
  ok(gf.length === 1, '筛选命中 C123');
  ok(gs.length === 2000, '排序完成');
  const dt = t1 - t0;
  console.log(`    ⏱ 2000 角色 提取+分组+筛选+排序 耗时 ${dt.toFixed(2)}ms`);
  ok(dt < 50, '2000 角色全套处理 < 50ms');
}

console.log(`\n— M8 结果：${pass} 通过 / ${fail} 失败 —`);
if (fail > 0) process.exitCode = 1;
