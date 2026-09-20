// tests/phone-scripts-editor.test.mjs — M16-C 全屏编辑器单测（纯函数 + 跨作用域持久化）
import {
  decideAiBackend, buildAiPrompt, buildOpenAiMessages, buildOpenAiBody,
  extractAiText, resolveTavernEndpoint, combineWithBody,
  PHONE_SYSTEM_PROMPT,
  persistTemplateToScope, deleteTemplateFromScope,
} from '../src/phone-scripts-editor.js';
import { makeTemplate, PHONE_SCRIPT_SCOPES, collectTemplates, getTemplate } from '../src/phone-scripts-data.js';
import { readAllSources } from '../src/phone-scripts-bar.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa === sb) { pass++; } else { fail++; console.error(`  ✗ ${msg} | 期望 ${sb} 实际 ${sa}`); } }

// ---- decideAiBackend ----
ok(decideAiBackend({ phoneScripts: { ownApi: { enabled: true, baseUrl: 'https://x/v1', apiKey: 'k' } } }) === 'own', '自有 API 已配 → own');
ok(decideAiBackend({ phoneScripts: { ownApi: { enabled: true, baseUrl: '', apiKey: '' } } }) === null, '自有 API 缺 baseUrl → null（node 无 location/fetch）');
ok(decideAiBackend({ phoneScripts: { ownApi: { enabled: false } } }) === null, '未启用 → null（node 无 location/fetch）');

// ---- buildAiPrompt ----
ok(buildAiPrompt('报时间', 'script').includes('STscript'), 'script 提示含 STscript');
ok(buildAiPrompt('开场白', 'text').includes('纯文本'), 'text 提示含 纯文本');
ok(buildAiPrompt('报时间', 'script').includes('报时间'), '提示词带入用户描述');
ok(buildAiPrompt('', 'script').length > 0, '空描述也返回提示词');

// ---- PHONE_SYSTEM_PROMPT（内置隐藏底层规则：只写代码、不受世界观/角色干扰）----
ok(typeof PHONE_SYSTEM_PROMPT === 'string' && PHONE_SYSTEM_PROMPT.length > 0, '系统是提示词为非空字符串常量');
ok(PHONE_SYSTEM_PROMPT.includes('代码生成器'), '系统提示词声明自己是代码生成器');
ok(PHONE_SYSTEM_PROMPT.includes('世界观'), '系统提示词要求忽略世界观');
ok(PHONE_SYSTEM_PROMPT.includes('只输出'), '系统提示词要求只输出产物');
ok(!PHONE_SYSTEM_PROMPT.includes('{{'), '系统提示词不含可被宏展开的动态片段（防主题/上下文污染）');

// ---- buildOpenAiMessages / buildOpenAiBody（system=内置规则 + user=效果描述）----
const msgs = buildOpenAiMessages('你好', 'script');
eq(msgs, [{ role: 'system', content: PHONE_SYSTEM_PROMPT }, { role: 'user', content: buildAiPrompt('你好', 'script') }], 'messages 结构：system=内置规则 + user=描述');
ok(msgs[0].role === 'system' && msgs[0].content === PHONE_SYSTEM_PROMPT, 'system 角色固定用内置隐藏提示词');
ok(msgs[1].role === 'user' && msgs[1].content.includes('你好'), 'user 角色带用户效果描述');
eq(buildOpenAiBody(msgs, 'gpt-4o-mini'), { model: 'gpt-4o-mini', messages: msgs, temperature: 0.4, max_tokens: 1500 }, 'body 默认参数');
eq(buildOpenAiBody(msgs, '').model, 'gpt-4o-mini', '空 model 回落默认');

// ---- extractAiText ----
eq(extractAiText({ choices: [{ message: { content: '  /sys x  ' } }] }), '/sys x', '解析 OpenAI 完整返回');
eq(extractAiText({ choices: [{ delta: { content: 'hi' } }] }), 'hi', '解析流式 delta');
eq(extractAiText('/echo ok'), '/echo ok', '解析裸字符串');
eq(extractAiText({}), '', '空结构返回空串');

// ---- combineWithBody（联合正文：AI 结果插入代码区 / M16-D 文本模板插入聊天输入框）----
eq(combineWithBody('', '你好', 'replace'), '你好', 'replace 覆盖（基底空）');
eq(combineWithBody('正文A', '模板B', 'replace'), '模板B', 'replace 覆盖基底');
eq(combineWithBody('', '模板B', 'append'), '模板B', 'append 基底空→模板');
eq(combineWithBody('正文A', '模板B', 'append'), '正文A\n模板B', 'append 联合正文（换行连接）');
eq(combineWithBody('正文A', '', 'append'), '正文A', 'append 文本空→保留基底');
eq(combineWithBody('正文A', '模板B', 'bogus'), '正文A\n模板B', '非法 mode 回落 append');

// ---- resolveTavernEndpoint（node 无 location → null）----
eq(resolveTavernEndpoint(), null, 'node 无 location → null');

// ===================== 跨作用域持久化（mock ctx，无 DOM）=====================
function makeCtx() {
  return {
    chatMetadata: { phoneScripts: { templates: [] } },
    characters: [{ data: { extensions: {} } }],
    characterId: 0,
    saveSettingsDebounced() {},
    writeExtensionField() {},
  };
}
function makeSettings() {
  return { phoneScripts: { templates: [], defaultScope: 'chat', ownApi: { enabled: false } } };
}

// 1) 新建并保存到同层(chat)
let ctx = makeCtx();
let settings = makeSettings();
let t1 = makeTemplate({ name: 'A', scope: 'chat', code: 'x', exec: 'script' });
ok(persistTemplateToScope(ctx, settings, t1, 'chat'), 'persist chat 返回 true');
eq(ctx.chatMetadata.phoneScripts.templates.length, 1, 'chat 源写入 1 条');
eq(ctx.chatMetadata.phoneScripts.templates[0].name, 'A', 'chat 写入正确名');
eq(settings.phoneScripts.templates.length, 0, 'global 源未受影响');

// 2) 把同 id 改存到 global → 从 chat 移除（跨作用域去重）
let t1b = makeTemplate({ id: t1.id, name: 'A', scope: 'global', code: 'y', exec: 'script' });
persistTemplateToScope(ctx, settings, t1b, 'global');
eq(ctx.chatMetadata.phoneScripts.templates.length, 0, '切到 global 后 chat 源清空同 id');
eq(settings.phoneScripts.templates.length, 1, 'global 源含 1 条');
eq(settings.phoneScripts.templates[0].code, 'y', 'global 源为更新后的 code');

// 3) 保存到跨层角色(character)
let t2 = makeTemplate({ name: 'B', scope: 'character', code: 'z', exec: 'text' });
persistTemplateToScope(ctx, settings, t2, 'character');
eq(ctx.characters[0].data.extensions.phoneScripts.length, 1, 'character 源写入 1 条');
eq(ctx.characters[0].data.extensions.phoneScripts[0].name, 'B', 'character 写入正确名');
eq(ctx.characters[0].data.extensions.phoneScripts[0].exec, 'text', 'character 保留 exec=text');

// 4) 非法作用域 → 不写
ok(persistTemplateToScope(ctx, settings, t1, 'bogus') === false, '非法作用域被拒');

// 5) 删除（按聚合 scope）
ok(deleteTemplateFromScope(ctx, settings, t2.id, 'character'), 'delete character 返回 true');
eq(ctx.characters[0].data.extensions.phoneScripts.length, 0, 'character 源删除成功');
ok(deleteTemplateFromScope(ctx, settings, 'nope', 'bogus') === false, '非法作用域 delete 被拒');

// 6) 单次保存性能：先铺 1000 条，再测「一次保存」耗时（真实场景是用户偶尔保存一次，非批量）
const bigCtx = makeCtx();
const bigSet = makeSettings();
for (let i = 0; i < 1000; i++) {
  const scope = PHONE_SCRIPT_SCOPES[i % 3];
  persistTemplateToScope(bigCtx, bigSet, makeTemplate({ name: 'T' + i, scope, code: 'c' + i }), scope);
}
const t0 = performance.now();
persistTemplateToScope(bigCtx, bigSet, makeTemplate({ name: 'X', scope: 'global', code: 'z' }), 'global');
const dt = performance.now() - t0;
ok(dt < 80, '1000 条已存在时单次保存耗时 ' + dt.toFixed(2) + 'ms < 80ms');

// 7) 回归：insert / exec 字段随模板持久化并回读（onSave 必须读取表单的插入方式）
let ctxI = makeCtx();
let setI = makeSettings();
let tI = makeTemplate({ name: 'I', scope: 'chat', exec: 'text', insert: 'replace', code: 'z' });
persistTemplateToScope(ctxI, setI, tI, 'chat');
const allI = collectTemplates(readAllSources(ctxI, setI));
const gotI = getTemplate(allI, tI.id);
ok(gotI && gotI.insert === 'replace', 'insert=replace 随模板持久化并回读');
ok(gotI && gotI.exec === 'text', 'exec=text 随模板持久化并回读');

console.log(`\n— M16-C 结果：${pass} 通过 / ${fail} 失败 —`);
if (fail > 0) process.exit(1);
