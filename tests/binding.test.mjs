// tests/binding.test.mjs — M13 绑定工具 纯函数单测（node 环境，无 DOM）
import {
  buildBindingRow,
  getBoundRows,
  getUnboundRows,
  candidateWorldNames,
} from '../src/binding.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}

// ---- 构造测试用元数据（与 navigator-data.buildCharacterMeta 形态一致）----
function mk(chid, name, world, avatar) {
  return {
    chid,
    name,
    avatar: avatar || '',
    fav: false,
    tags: [],
    world: world || '',
    lastChat: 0,
    dateAdded: 0,
    chatSize: 0,
  };
}

const chars = [
  mk(0, 'Alice', 'Eldoria', 'alice.png'),
  mk(1, 'Bob', '', 'bob.png'),
  mk(2, 'Cara', 'Eldoria', ''),
  mk(3, 'Dan', 'Oceania', 'dan.png'),
  mk(4, '(无名角色)', '', ''),
];

// ---- buildBindingRow ----
{
  const r = buildBindingRow(chars[0]);
  ok(r.chid === 0, 'buildBindingRow 保留 chid');
  ok(r.name === 'Alice', 'buildBindingRow 保留 name');
  ok(r.world === 'Eldoria', 'buildBindingRow 保留 world');
  ok(r.avatar === 'user/avatars/alice.png', '头像路径拼接 user/avatars/');
  ok(r.initial === 'A', '首字母大写');
}
{
  const r = buildBindingRow(chars[4]);
  ok(r.name === '(无名角色)', '无名角色名兜底');
  ok(r.initial === '?', '无名角色首字母为 ?');
  ok(r.avatar === '', '无头像则头像为空');
}
{
  const r = buildBindingRow(null);
  ok(r && r.name === '(无名角色)' && r.chid === -1, 'null 输入安全兜底');
}

// ---- getBoundRows / getUnboundRows ----
{
  const bound = getBoundRows(chars);
  // Alice(Eldoria), Cara(Eldoria), Dan(Oceania) => 3 个
  ok(bound.length === 3, `已绑定数量应为 3，实为 ${bound.length}`);
  ok(bound.every((b) => !!b.world), '已绑定行 world 均非空');
  ok(bound.find((b) => b.name === 'Alice'), '已绑定含 Alice');
}
{
  const unbound = getUnboundRows(chars);
  // Bob(''), (无名角色)('') => 2 个
  ok(unbound.length === 2, `未绑定数量应为 2，实为 ${unbound.length}`);
  ok(unbound.every((u) => !u.world), '未绑定行 world 均为空');
  ok(unbound.find((u) => u.name === 'Bob'), '未绑定含 Bob');
}
{
  ok(getBoundRows(null).length === 0, '空输入安全返回空数组');
}

// ---- candidateWorldNames ----
{
  const names = candidateWorldNames(chars, null);
  // 来自角色卡：Eldoria(出现2次) / Oceania
  ok(names.length === 2, `候选世界书应为 2，实为 ${names.length}`);
  ok(names.includes('Eldoria') && names.includes('Oceania'), '候选含 Eldoria/Oceania');
  ok(names[0].localeCompare(names[1]) <= 0, '候选按字母排序');
}
{
  // 特性检测 ctx.worlds 补集
  const names = candidateWorldNames(chars, { worlds: ['Atlantis', 'Eldoria'] });
  ok(names.length === 3, `含 ctx.worlds 后应为 3，实为 ${names.length}`);
  ok(names.includes('Atlantis'), 'ctx.worlds 被并入候选');
}
{
  // ctx.worldNames 也支持；非数组被忽略
  const names = candidateWorldNames(chars, { worldNames: 'not-array' });
  ok(names.length === 2, '非数组 worlds 被忽略，回退角色卡');
}

// ---- 性能：2000 角色分组 + 候选收集 ----
{
  const big = [];
  for (let i = 0; i < 2000; i++) {
    big.push(mk(i, 'C' + i, i % 3 ? 'W' + (i % 3) : '', 'a' + i + '.png'));
  }
  const t0 = performance.now();
  const bound = getBoundRows(big);
  const unbound = getUnboundRows(big);
  const names = candidateWorldNames(big, null);
  const t1 = performance.now();
  ok(bound.length === 1333, `2000 中已绑定应为 1333，实为 ${bound.length}`);
  ok(unbound.length === 667, `2000 中未绑定应为 667，实为 ${unbound.length}`);
  ok(names.length === 2, `2000 候选世界书应为 2，实为 ${names.length}`);
  ok((t1 - t0) < 50, `2000 角色处理应 <50ms，实为 ${(t1 - t0).toFixed(2)}ms`);
}

console.log(`— M13 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
