// tests/navigator-roster.test.mjs — M10 名册区纯函数单测（node 直接跑）
import { toRowView, groupRows } from '../src/navigator-roster.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
}

// ---------- toRowView ----------
const m1 = { chid: 2, name: 'Alice', avatar: 'a.png', fav: true, tags: ['x', 'y'], world: 'W1' };
let r = toRowView(m1);
eq(r, {
  chid: 2, name: 'Alice', initial: 'A',
  avatar: 'user/avatars/a.png', fav: true, tags: ['x', 'y'], world: 'W1',
}, '正常角色映射');

// 头像需 encodeURIComponent（含特殊字符安全）
eq(toRowView({ name: 'B', avatar: 'b c.png' }).avatar, 'user/avatars/b%20c.png', '头像文件名需编码');

// 缺名字 → 占位 + initial '?'
r = toRowView({ name: '', avatar: '', fav: false, tags: [], world: '' });
ok(r.name === '(无名角色)' && r.initial === '?' && r.avatar === '' && r.fav === false,
  '无名角色兜底');

// 缺字段不抛错
r = toRowView(null);
ok(r.name === '(无名角色)' && r.chid === -1 && Array.isArray(r.tags) && r.world === '',
  'null 输入安全兜底');

// ---------- groupRows ----------
const rows = [
  { chid: 0, name: 'A', world: 'W1', tags: ['t1'] },
  { chid: 1, name: 'B', world: 'W2', tags: ['t1', 't2'] },
  { chid: 2, name: 'C', world: '', tags: ['t2'] },
  { chid: 3, name: 'D', world: '', tags: [] },
];

// list 模式：单组，全部
let g = groupRows(rows, 'list');
ok(g.length === 1 && g[0].key === '__all__' && g[0].rows.length === 4, 'list 模式为单组全量');

// world 模式：W1/W2/未关联世界书；特殊组沉底
g = groupRows(rows, 'world');
eq(g.map((x) => x.label), ['W1', 'W2', '未关联世界书'], 'world 分组排序（特殊组沉底）');
eq(g.find((x) => x.label === '未关联世界书').rows.map((x) => x.chid), [2, 3], '未关联世界书含 C/D');

// tag 模式：t1/t2/无标签；特殊组沉底
g = groupRows(rows, 'tag');
eq(g.map((x) => x.label), ['t1', 't2', '无标签'], 'tag 分组排序（特殊组沉底）');
// B 同时有 t1/t2，应同时属于两组
ok(g.find((x) => x.label === 't1').rows.length === 2, 't1 含 A/B（B 双标签）');
ok(g.find((x) => x.label === 't2').rows.length === 2, 't2 含 B/C（B 双标签）');
eq(g.find((x) => x.label === '无标签').rows.map((x) => x.chid), [3], '无标签含 D');

// 非法 mode 视为 list
g = groupRows(rows, 'bogus');
ok(g.length === 1 && g[0].rows.length === 4, '非法 mode 回落 list');

// ---------- 结果 ----------
console.log(`— M10 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
