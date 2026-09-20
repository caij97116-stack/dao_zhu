// tests/settings.test.mjs — M14 设置升级 / 嵌套默认值合并（导入 index.js）
import { getSettings, defaultSettings, registerBuiltinFormatInstruction, buildSettingsHtml, buildSkinOptionsHtml } from '../index.js';
import { FORMAT_INSTRUCTION } from '../src/instruction.js';
import { SKINS, DEFAULT_SKIN, normalizeSkin } from '../src/skin.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}

// ---- 1) 全新用户：ext 完全缺失 → 全量深拷贝默认 ----
{
  const ctx = { extensionSettings: {} };
  const s = getSettings(ctx);
  ok(s && typeof s === 'object', 'getSettings 返回对象');
  ok(s.enabled === true, 'enabled 默认 true');
  ok(s.navigator && typeof s.navigator === 'object', 'navigator 默认对象存在');
  ok(s.navigator.open === false && s.navigator.showButton === true, 'navigator 默认未开/显示按钮');
  ok(s.themeAdapt && s.themeAdapt.enabled === false && s.themeAdapt.target === 'auto', 'themeAdapt 默认关闭/auto');
  // 深拷贝：不与原冻结默认值共享引用
  ok(s.navigator !== defaultSettings.navigator, 'navigator 应为深拷贝（非共享引用）');
  ok(s.themeAdapt !== defaultSettings.themeAdapt, 'themeAdapt 应为深拷贝（非共享引用）');
}

// ---- 2) 深拷贝独立性：改副本不影响默认值 ----
{
  const ctx = { extensionSettings: {} };
  const s = getSettings(ctx);
  s.navigator.open = true;
  ok(defaultSettings.navigator.open === false, '修改副本不应污染冻结默认值');
}

// ---- 3) 升级用户：保留已有键，补缺失的嵌套默认 ----
{
  const ctx = { extensionSettings: { 'dao-zhu': { enabled: false, navigator: { open: true } } } };
  const s = getSettings(ctx);
  ok(s.enabled === false, '升级：保留已有 enabled=false');
  ok(s.navigator.open === true, '升级：保留已有 navigator.open=true');
  // themeAdapt 此前缺失 → 补齐
  ok(s.themeAdapt && s.themeAdapt.enabled === false, '升级：补齐缺失的 themeAdapt');
}

// ---- 4) 仅缺 navigator（保留 themeAdapt 等）：补齐 navigator ----
{
  const ctx = { extensionSettings: { 'dao-zhu': { enabled: true, themeAdapt: { enabled: true, target: 'mobile', patch: '.x{}' } } } };
  const s = getSettings(ctx);
  ok(s.navigator && s.navigator.showButton === true, '升级：补齐缺失的 navigator（含 showButton 默认）');
  ok(s.themeAdapt.target === 'mobile' && s.themeAdapt.patch === '.x{}', '升级：保留已有 themeAdapt');
}

// ---- 5) 极端缺失：ctx 无 extensionSettings → 退回内存对象且不崩溃 ----
{
  const s = getSettings({});
  ok(s && s.navigator && s.themeAdapt, '缺 extensionSettings 时仍能返回含嵌套默认的对象');
}

// ---- 6) M6 内置格式指令开关（builtinFormatInstruction）：默认 true，升级补齐，用户关闭则保留 ----
{
  const s1 = getSettings({ extensionSettings: {} });
  ok(s1.builtinFormatInstruction === true, '全新用户：内置格式指令默认自动注入 true');
  const ctx2 = { extensionSettings: { 'dao-zhu': { enabled: true } } };
  const s2 = getSettings(ctx2);
  ok(s2.builtinFormatInstruction === true, '升级用户：补齐 builtinFormatInstruction=true（无需手动复制）');
  const ctx3 = { extensionSettings: { 'dao-zhu': { builtinFormatInstruction: false } } };
  const s3 = getSettings(ctx3);
  ok(s3.builtinFormatInstruction === false, '已手动关闭的用户：保留 false，不被强制改回');
}

// ---- 7) M6 内置自动注入：用 mock 事件系统验证注入逻辑（无需 DOM/真实酒馆）----
function makeEventCtx(eventName) {
  const handlers = [];
  return {
    handlers,
    ctx: {
      eventSource: { on: (ev, fn) => handlers.push({ ev, fn }) },
      event_types: eventName ? { CHAT_COMPLETION_PROMPT: eventName } : {},
    },
  };
}
{
  // 7a) 有 CHAT_COMPLETION_PROMPT：应注册，并把指令追加进已有 system 消息
  const { handlers, ctx } = makeEventCtx('ccp');
  registerBuiltinFormatInstruction(ctx, { builtinFormatInstruction: true });
  ok(handlers.length === 1, '有事件时应注册 1 个处理器');
  ok(handlers[0] && handlers[0].ev === 'ccp', '注册到 CHAT_COMPLETION_PROMPT 事件');
  const prompt = [{ role: 'system', content: '原有系统提示' }, { role: 'user', content: '你好' }];
  handlers[0].fn(prompt);
  ok(prompt[0].content.includes(FORMAT_INSTRUCTION), '注入后 system 消息应包含格式指令');
  ok(prompt[0].content.includes('原有系统提示'), '注入应追加而非覆盖原有 system 内容');
  ok(prompt[1].content === '你好', '不应改动 user 消息');
}
{
  // 7b) 没有 system 消息：应 unshift 一条 system
  const { handlers, ctx } = makeEventCtx('ccp');
  registerBuiltinFormatInstruction(ctx, { builtinFormatInstruction: true });
  const prompt = [{ role: 'user', content: '你好' }];
  handlers[0].fn(prompt);
  ok(prompt.length === 2 && prompt[0].role === 'system', '无 system 时应插到最前一条 system');
  ok(prompt[0].content === FORMAT_INSTRUCTION, '插入内容即格式指令');
}
{
  // 7c) 用户关闭开关：不应注册
  const { handlers, ctx } = makeEventCtx('ccp');
  registerBuiltinFormatInstruction(ctx, { builtinFormatInstruction: false });
  ok(handlers.length === 0, '开关关闭时不应注册（退回手动复制模式）');
}
{
  // 7d) 旧版本无该事件 / 无 eventSource：安全降级，不抛错
  const { handlers, ctx } = makeEventCtx(null);
  let threw = false;
  try { registerBuiltinFormatInstruction(ctx, { builtinFormatInstruction: true }); } catch (_) { threw = true; }
  ok(!threw && handlers.length === 0, '无 CHAT_COMPLETION_PROMPT 事件时安全降级不注册');
  let threw2 = false;
  try { registerBuiltinFormatInstruction({}, { builtinFormatInstruction: true }); } catch (_) { threw2 = true; }
  ok(!threw2, 'ctx 完全缺失时不抛错');
  // 7e) 非法 prompt（非数组）：处理器应静默跳过
  const { handlers: h2, ctx: ctx2 } = makeEventCtx('ccp');
  registerBuiltinFormatInstruction(ctx2, { builtinFormatInstruction: true });
  let threw3 = false;
  try { h2[0].fn(null); h2[0].fn('not-an-array'); h2[0].fn([]); } catch (_) { threw3 = true; }
  ok(!threw3, '传入非法 prompt 时处理器静默跳过不抛错');
}

// ---- 8) M17 界面皮肤：默认 / 升级补齐 / 用户选择保留 / 面板含皮肤选项 ----
{
  const s1 = getSettings({ extensionSettings: {} });
  ok(s1.skin === DEFAULT_SKIN && s1.skin === 'cinder', '全新用户：皮肤默认 cinder（拼贴墨）');
  const ctx2 = { extensionSettings: { 'dao-zhu': { enabled: true } } };
  const s2 = getSettings(ctx2);
  ok(s2.skin === 'cinder', '升级用户：补齐 skin 默认值');
  const ctx3 = { extensionSettings: { 'dao-zhu': { skin: 'classic' } } };
  const s3 = getSettings(ctx3);
  ok(s3.skin === 'classic', '已选 classic 的用户：保留选择，不被强制改回');
  const ctx4 = { extensionSettings: { 'dao-zhu': { skin: 'paper' } } };
  ok(getSettings(ctx4).skin === 'paper', '已选 paper 的用户：保留选择');
  ok(normalizeSkin(s3.skin) === 'classic', '保留值本身合法（面板回显不会跳回默认）');
}
{
  const html = buildSettingsHtml();
  ok(typeof html === 'string' && html.length > 0, '设置面板 HTML 可构建');
  ok(html.includes('id="dz-skin"'), '面板含皮肤下拉框');
  ok(html.includes('id="dz-skin-hint"'), '面板含皮肤说明');
  ok(html.includes('id="dz-phone-open"'), '面板仍含小手机工坊入口（不回归）');
  ok(html.includes('id="dz-nav-showbtn"'), '面板仍含名册按钮开关（不回归）');
  ok(html.includes('id="dz-builtin-instr"'), '面板仍含内置指令开关（不回归）');
  for (const k of Object.keys(SKINS)) {
    ok(html.includes(`value="${SKINS[k].id}"`), `面板含皮肤选项 ${k}`);
  }
  // 折叠抽屉结构仍在（M16 修的可用性不能回退）
  ok(html.includes('id="dz-settings-header"') && html.includes('id="dz-settings-content"'), '面板仍是可折叠抽屉结构');
  ok(html.includes('id="dz-settings-content" hidden'), '抽屉默认折叠');
}
{
  const opts = buildSkinOptionsHtml('paper');
  ok(opts.includes('value="paper" selected'), '选中项带 selected');
  ok((opts.match(/ selected/g) || []).length === 1, '有且仅有一个 selected');
  const optsBad = buildSkinOptionsHtml('不存在的皮肤');
  ok(optsBad.includes(`value="${DEFAULT_SKIN}" selected`), '非法选中值回落默认皮肤');
  ok((optsBad.match(/ selected/g) || []).length === 1, '非法值回落时仍只有一个 selected');
}

console.log(`— M14 结果：${pass} 通过 / ${fail} 失败 —`);
process.exit(fail ? 1 : 0);
