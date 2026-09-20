// tests/skin.test.mjs — M17 界面皮肤层（纯函数 + 应用行为）
import {
  SKINS, DEFAULT_SKIN, allSkinClasses,
  normalizeSkin, skinClassesOf, describeSkin, skinHintOf, applySkin,
} from '../src/skin.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}

// ---- 1) 归一化：合法值保留，脏数据一律回落默认 ----
{
  ok(normalizeSkin('cinder') === 'cinder', 'cinder 合法');
  ok(normalizeSkin('paper') === 'paper', 'paper 合法');
  ok(normalizeSkin('classic') === 'classic', 'classic 合法');
  ok(normalizeSkin('  Cinder  ') === 'cinder', '大小写 / 空白容忍');
  ok(normalizeSkin('CINDER') === 'cinder', '全大写归一');
  ok(normalizeSkin('nope') === DEFAULT_SKIN, '未知字符串回落默认');
  ok(normalizeSkin('') === DEFAULT_SKIN, '空串回落默认');
  ok(normalizeSkin(null) === DEFAULT_SKIN, 'null 回落默认');
  ok(normalizeSkin(undefined) === DEFAULT_SKIN, 'undefined 回落默认');
  ok(normalizeSkin(123) === DEFAULT_SKIN, '非字符串回落默认');
  ok(normalizeSkin({}) === DEFAULT_SKIN, '对象回落默认');
  ok(DEFAULT_SKIN === 'cinder', '默认皮肤为 cinder（忠实美化稿）');
}

// ---- 2) 皮肤表结构完整 ----
{
  const ids = Object.keys(SKINS);
  ok(ids.length === 3 && ids.includes('cinder') && ids.includes('paper') && ids.includes('classic'), '三套皮肤齐备');
  for (const id of ids) {
    const s = SKINS[id];
    ok(s.id === id, `${id}.id 自洽`);
    ok(typeof s.label === 'string' && s.label.length > 0, `${id} 有展示名`);
    ok(typeof s.hint === 'string' && s.hint.length > 0, `${id} 有说明`);
    ok(Array.isArray(s.classes), `${id}.classes 是数组`);
  }
  // 质感层复用：两个拼贴皮肤共享 dz-skin-collage，配色层各自独立
  ok(SKINS.cinder.classes.includes('dz-skin-collage'), 'cinder 含质感层类');
  ok(SKINS.paper.classes.includes('dz-skin-collage'), 'paper 含质感层类');
  ok(SKINS.cinder.classes.includes('dz-skin-cinder') && !SKINS.cinder.classes.includes('dz-skin-paper'), 'cinder 只带自己的配色类');
  ok(SKINS.paper.classes.includes('dz-skin-paper') && !SKINS.paper.classes.includes('dz-skin-cinder'), 'paper 只带自己的配色类');
  ok(SKINS.classic.classes.length === 0, 'classic 不挂任何皮肤类（回到旧版简洁）');
}

// ---- 3) allSkinClasses：覆盖全部且不重复（切换时的清理清单）----
{
  const all = allSkinClasses();
  ok(all.includes('dz-skin-collage') && all.includes('dz-skin-cinder') && all.includes('dz-skin-paper'), '含全部皮肤类');
  ok(new Set(all).size === all.length, '无重复项');
  ok(all.every((c) => c.startsWith('dz-skin-')), '全部带 dz-skin- 前缀（命名空间）');
}

// ---- 4) skinClassesOf / describeSkin / skinHintOf ----
{
  ok(skinClassesOf('paper').join(',') === 'dz-skin-collage,dz-skin-paper', 'skinClassesOf(paper)');
  ok(skinClassesOf('bogus').join(',') === 'dz-skin-collage,dz-skin-cinder', 'skinClassesOf 非法值回落默认组合');
  ok(skinClassesOf('cinder') !== SKINS.cinder.classes, '返回副本，不暴露冻结数组引用');
  // 改返回值不应污染定义
  const got = skinClassesOf('cinder');
  got.push('x');
  ok(SKINS.cinder.classes.length === 2, '修改返回值不污染 SKINS 定义');
  ok(typeof describeSkin('paper') === 'string' && describeSkin('paper').includes('纸'), 'describeSkin(paper)');
  ok(describeSkin('bogus') === SKINS[DEFAULT_SKIN].label, 'describeSkin 非法值回落默认');
  ok(typeof skinHintOf('cinder') === 'string' && skinHintOf('cinder').length > 0, 'skinHintOf(cinder)');
  ok(skinHintOf(null) === SKINS[DEFAULT_SKIN].hint, 'skinHintOf 非法值回落默认');
}

// ---- 5) applySkin：只增删 .dz-skin-* 类，不动其它类 ----
function mockDoc(initial) {
  const set = new Set(initial || []);
  return {
    set,
    documentElement: {
      classList: {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
      },
    },
  };
}
{
  const doc = mockDoc(['dz-skin-collage', 'dz-skin-cinder', 'some-other-class']);
  const applied = applySkin('paper', doc);
  ok(applied === 'paper', 'applySkin 返回生效皮肤 id');
  ok(doc.set.has('dz-skin-collage') && doc.set.has('dz-skin-paper'), 'paper：挂上质感层 + paper 配色类');
  ok(!doc.set.has('dz-skin-cinder'), 'paper：清掉旧的 cinder 配色类');
  ok(doc.set.has('some-other-class'), '绝不误删非皮肤类（酒馆/其它扩展的类）');
}
{
  const doc = mockDoc([]);
  applySkin('classic', doc);
  ok(doc.set.size === 0, 'classic：不挂任何皮肤类');
}
{
  // 从 classic 切回 cinder（此前无残留也能正确挂上）
  const doc = mockDoc([]);
  applySkin('cinder', doc);
  ok(doc.set.has('dz-skin-collage') && doc.set.has('dz-skin-cinder'), 'cinder：挂上两个类');
}
{
  // 脏值：回落到默认皮肤，不产生未知类
  const doc = mockDoc(['dz-skin-collage', 'dz-skin-paper']);
  const applied = applySkin('__evil value__', doc);
  ok(applied === DEFAULT_SKIN, '脏值回落默认皮肤');
  ok(!doc.set.has('dz-skin-paper'), '脏值：清掉旧配色类');
  ok(doc.set.has('dz-skin-cinder'), '脏值：挂上默认配色类');
}

// ---- 6) 健壮性：无 document / 无 documentElement / classList 抛错，都不应崩 ----
{
  let threw = false;
  try { applySkin('cinder', null); } catch (_) { threw = true; }
  ok(!threw, 'doc 为 null 时不抛错');
  let threw2 = false;
  try { applySkin('cinder', { documentElement: null }); } catch (_) { threw2 = true; }
  ok(!threw2, '无 documentElement 时不抛错');
  let threw3 = false;
  try {
    applySkin('cinder', {
      documentElement: {
        classList: { add: () => { throw new Error('boom'); }, remove: () => {} },
      },
    });
  } catch (_) { threw3 = true; }
  ok(!threw3, 'classList 抛错时被吞掉（皮肤失败不影响功能）');
  // node 环境无 document：直接不传 doc 也应安全返回
  let threw4 = false;
  let id4 = null;
  try { id4 = applySkin('paper'); } catch (_) { threw4 = true; }
  ok(!threw4 && id4 === 'paper', '无全局 document 时安全返回且不抛错');
}

console.log(`— M17 皮肤 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
