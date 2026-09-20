// tests/phone-scripts-data.test.mjs — M16-A 数据层单测
import {
  makeTemplate, normalizeTemplate, validateTemplate, addTemplate, updateTemplate,
  removeTemplate, getTemplate, collectTemplates, filterTemplates,
  exportPack, parsePack, importPack, defaultPhoneScriptsState,
  PHONE_SCRIPT_SCOPES, PHONE_SCRIPT_KIND,
} from '../src/phone-scripts-data.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (得到 ' + JSON.stringify(a) + ')'); }

// 1) makeTemplate：默认与规范化
let t = makeTemplate({ name: '小手机说话', scope: 'chat', code: '/sys 手机亮了' });
ok(t.id && t.id.startsWith('ps_'), 'makeTemplate 生成 ps_ 前缀 id');
ok(t.name === '小手机说话' && t.scope === 'chat', 'makeTemplate 保留 name/scope');
ok(t.code === '/sys 手机亮了', 'makeTemplate 保留 code');
ok(Number.isFinite(t.createdAt) && Number.isFinite(t.updatedAt), 'makeTemplate 带时间戳');

// 2) 非法 scope 兜底为 chat
eq(makeTemplate({ name: 'x', scope: 'bogus' }).scope, 'chat', '非法 scope 回落 chat');

// 3) 空 name 兜底
ok(makeTemplate({}).name === '未命名小手机脚本', '空 name 兜底默认名');

// 4) normalizeTemplate 防御
ok(normalizeTemplate(null).name === '未命名小手机脚本' &&
   normalizeTemplate(null).scope === 'chat' &&
   normalizeTemplate(null).code === '', 'null → 默认模板（字段兜底）');
const normed = normalizeTemplate({ id: 'a', name: 'A', scope: 'global', code: 'x' });
eq(normed, { id: 'a', name: 'A', scope: 'global', exec: 'script', insert: 'append', code: 'x', createdAt: normed.createdAt, updatedAt: normed.updatedAt },
   'normalize 保留合法字段（时间戳除外）');

// 4b) makeTemplate 带 exec / insert；非法值兜底
ok(makeTemplate({ name: 't', scope: 'chat', code: 'c', exec: 'text' }).exec === 'text', 'makeTemplate 保留 exec=text');
ok(makeTemplate({ name: 't', scope: 'chat', code: 'c', exec: 'bogus' }).exec === 'script', '非法 exec 回落 script');
ok(makeTemplate({ name: 't', scope: 'chat', code: 'c', insert: 'replace' }).insert === 'replace', 'makeTemplate 保留 insert=replace');
ok(makeTemplate({ name: 't', scope: 'chat', code: 'c', insert: 'bogus' }).insert === 'append', '非法 insert 回落 append');

// 5) validateTemplate
ok(validateTemplate({ name: 'ok', scope: 'chat', code: '' }).ok, '合法模板通过校验');
ok(!validateTemplate({ scope: 'chat', code: '' }).ok, '缺 name 不通过');
ok(!validateTemplate({ name: 'x', scope: 'wrong', code: '' }).ok, '非法 scope 不通过');
ok(!validateTemplate('notobject').ok, '非对象不通过');

// 6) CRUD
let list = [];
list = addTemplate(list, { id: '1', name: 'A', scope: 'chat', code: 'c1' });
list = addTemplate(list, { id: '2', name: 'B', scope: 'global', code: 'c2' });
eq(list.length, 2, 'add 两条');
// 同 id 覆盖
list = addTemplate(list, { id: '1', name: 'A2', scope: 'chat', code: 'c1b' });
eq(list.length, 2, '同 id 不增数量');
eq(getTemplate(list, '1').name, 'A2', '同 id 覆盖 name');
// 不改原数组
const before = list.length;
addTemplate(list, { id: '3', name: 'C', scope: 'chat', code: 'c3' });
eq(list.length, before, 'add 不改原数组');
// update
list = updateTemplate(list, '2', { code: 'c2b' });
eq(getTemplate(list, '2').code, 'c2b', 'update 改 code');
eq(getTemplate(list, '2').id, '2', 'update 不改 id');
// remove
list = removeTemplate(list, '1');
eq(list.length, 1, 'remove 一条');
ok(getTemplate(list, '1') === undefined, 'remove 后查不到');

// 7) collectTemplates：三作用域聚合 + 优先级去重
const sources = {
  global: [{ id: 'g1', name: 'G1', scope: 'global', code: 'g' }],
  chat: [{ id: 'c1', name: 'C1', scope: 'chat', code: 'c' }],
  character: [{ id: 'r1', name: 'R1', scope: 'character', code: 'r' }],
};
let all = collectTemplates(sources);
eq(all.length, 3, '三作用域聚合为 3 条');
ok(all.every((x) => PHONE_SCRIPT_SCOPES.includes(x.scope)), '每条携带合法 scope');

// 同 id 跨作用域：character > chat > global
const dup = collectTemplates({
  global: [{ id: 'same', name: 'G', scope: 'global', code: 'g' }],
  chat: [{ id: 'same', name: 'C', scope: 'chat', code: 'c' }],
  character: [{ id: 'same', name: 'R', scope: 'character', code: 'r' }],
});
eq(dup.length, 1, '同 id 去重为 1');
eq(dup[0].name, 'R', '同 id 以 character 优先级优先');
eq(dup[0].scope, 'character', '同 id 优先作用域为 character');

// 8) filterTemplates
eq(filterTemplates(all, { scope: 'global' }).length, 1, '按 global 筛选命中 all 中的 1 条');
const mixed = collectTemplates({
  global: [{ id: 'g1', name: 'G1', scope: 'global', code: 'glob' }],
  chat: [{ id: 'c1', name: 'C1', scope: 'chat', code: 'chat' }],
});
eq(filterTemplates(mixed, { scope: 'global' }).length, 1, '按 global 筛选命中 1');
eq(filterTemplates(mixed, { query: 'chat' }).length, 1, 'query 命中 code 子串');
eq(filterTemplates(mixed, { query: 'G1' }).length, 1, 'query 命中 name');
eq(filterTemplates(mixed, { query: 'zzz' }).length, 0, 'query 无命中');

// 9) exportPack / parsePack / importPack 往返
const tpls = [
  { id: '1', name: '小手机说话', scope: 'chat', code: '/sys 手机亮了' },
  { id: '2', name: '天气播报', scope: 'global', code: '/echo 晴' },
];
const pack = exportPack(tpls, '我的小手机脚本');
ok(pack.app === 'dao-zhu' && pack.kind === PHONE_SCRIPT_KIND, 'pack 带 app/kind');
ok(pack.name === '我的小手机脚本', 'pack 用自定义名字');
ok(pack.templates.length === 2, 'pack 含 2 模板');

const parsed = parsePack(JSON.stringify(pack));
ok(parsed.ok, 'parsePack 成功');
eq(parsed.name, '我的小手机脚本', 'parse 还原名字');
eq(parsed.templates.length, 2, 'parse 还原 2 模板');

// 非法 kind
const bad = parsePack(JSON.stringify({ kind: 'other', templates: [] }));
ok(!bad.ok, 'kind 不匹配被拒');

// 损坏 JSON
ok(!parsePack('{不是json').ok, '损坏 JSON 被拒（不抛异常）');

// importPack 合并
const merged = importPack(parsed.templates, [{ id: '1', name: '旧名', scope: 'chat', code: 'old' }]);
eq(merged.templates.length, 2, 'import 合并后 2 条');
eq(merged.updated, 1, 'import 更新 1 条（同 id）');
eq(merged.added, 1, 'import 新增 1 条');
eq(getTemplate(merged.templates, '1').name, '小手机说话', 'import 覆盖同 id');

// importPack 跳过非法
const skip = importPack([{ id: 'x', code: 'no name' }], []);
eq(skip.templates.length, 0, 'import 跳过非法模板');

// 10) defaultPhoneScriptsState 深拷贝独立
const s1 = defaultPhoneScriptsState();
const s2 = defaultPhoneScriptsState();
s1.ownApi.enabled = true;
s1.showBar = false;
ok(s2.ownApi.enabled === false && s2.showBar === true, 'default 深拷贝独立（改 s1 不影响 s2）');
ok(PHONE_SCRIPT_SCOPES.includes(s1.defaultScope), 'default 含合法 defaultScope');

// 11) 性能：2000 模板 collect + filter + export < 50ms
const big = { global: [], chat: [], character: [] };
for (let i = 0; i < 2000; i++) {
  const scope = i % 3 === 0 ? 'global' : i % 3 === 1 ? 'chat' : 'character';
  big[scope].push({ id: 'b' + i, name: 'T' + i, scope, code: 'c' + i });
}
const t0 = performance.now();
const collected = collectTemplates(big);
filterTemplates(collected, { query: 'T1999' });
exportPack(collected, 'big');
const dt = performance.now() - t0;
ok(dt < 50, '2000 模板聚合+筛选+导出耗时 ' + dt.toFixed(2) + 'ms < 50ms');

console.log(`\n— M16-A 结果：${pass} 通过 / ${fail} 失败 —`);
if (fail > 0) process.exit(1);
