// src/phone-scripts-editor.js — M16-C：小手机工坊 · 全屏编辑器
//
// 职责：
//   1. 通过底部条「⚙ 管理」按钮注册的全屏编辑器，做模板的 新建/编辑/复制/删除；
//   2. 表单含：模板名 / 运行方式(STscript·纯文本) / 保存到作用域(同层·全局·角色) / 代码区；
//   3. 「✨ AI 帮写」：描述效果 → 调用 AI 生成（优先自有 OpenAI 兼容 API，否则复用酒馆同连接）；
//   4. 「▶ 试跑」：调用 M16-D 注册的运行器（未注册仅提示）；
//   5. 「📦 导出包 / 📥 导入包」：导出/导入命名 JSON 包（自定义脚本名）；
//   6. 保存时按表单所选作用域写回三作用域之一，并从其它作用域移除同 id（避免跨作用域重复）。
//
// 设计约束（沿用 v1 / M15 / M16 硬指标）：
//   - 跨版本一律特性检测，缺 document / location / fetch / 事件系统即安全降级，绝不抛错；
//   - 纯逻辑（AI 后端决策 / 请求体构造 / 返回解析 / 跨作用域持久化）抽成不依赖 DOM 的函数，node 单测；
//   - 命名空间 .dz-，编辑器 z-index 9500（高于悬浮窗 9000、低于酒馆原生模态逻辑上由我们独占），单例。

import { cloneObj, isNonEmptyString, escapeHtml } from './util.js';
import {
  makeTemplate, normalizeTemplate, validateTemplate, addTemplate, removeTemplate,
  getTemplate, collectTemplates, filterTemplates,
  exportPack, parsePack, importPack,
  PHONE_SCRIPT_SCOPES, SCOPE_LABELS, PHONE_SCRIPT_EXEC, EXEC_LABELS, PHONE_SCRIPT_INSERT, INSERT_LABELS,
} from './phone-scripts-data.js';
import {
  readAllSources, saveGlobalList, saveChatList, saveCharacterList, refreshPhoneBar,
  registerPhoneEditor, runPhoneTemplate,
} from './phone-scripts-bar.js';

const DISPLAY_NAME = '岛主历险记';
const EDITOR_ID = 'dz-phone-editor';

// ===================== 内置隐藏系统提示词（底层规则）=====================
// 这是「小手机工坊」的底层规则，作用：让被调用的任何 AI 只当代码生成器，
//   不被角色人设 / 世界观 / 世界书 / 角色扮演语境干扰，并按工坊要求的格式输出。
// 关键约束（来自用户）：
//   1. 内置、不可见、不可编辑 —— 不进 extensionSettings、不在 UI 暴露、无需用户手动塞进世界书/预设；
//   2. 自有 OpenAI 兼容 API 走它 → 完全隔离（请求只含我们的 messages）；
//   3. 酒馆同连接端点可能仍注入角色上下文，模型被指令忽略（详见 README 兼容性说明）。
// 注意：不要把它写成可被 {{宏}} 展开的动态字符串，保持为纯常量，避免被主题/上下文污染。
export const PHONE_SYSTEM_PROMPT = [
  '你是一个 SillyTavern「小手机工坊」专用代码生成器。你唯一的职责是产出可被该工坊使用的脚本或文本。',
  '硬性规则：',
  '1. 彻底忽略任何角色人设、世界观、世界书、先前对话、扮演设定与角色扮演语境——你只是在写代码，不是在聊天，也不要用角色口吻回答。',
  '2. 只输出最终产物本身：不要任何解释、不要寒暄、不要 markdown 代码块包裹、不要“好的/这里是你需要的”之类前缀。',
  '3. 保持简洁、可运行、符合 SillyTavern 当前语法；当用户描述与代码无关或自相矛盾时，按最合理的代码实现给出，不要反问。',
  '4. 你的输出会被直接写进用户输入框或作为 STscript 执行，所以必须干净、可被程序解析。',
].join('\n');

// ===================== 纯函数（可在 node 单测，不碰 DOM）=====================

// ---- 决定 AI 后端：自有 API（已配置）> 酒馆同连接（有 fetch+location）> 无 ----
export function decideAiBackend(settings) {
  const ps = (settings && settings.phoneScripts) || {};
  const own = ps.ownApi || {};
  if (own.enabled && isNonEmptyString(own.baseUrl) && isNonEmptyString(own.apiKey)) return 'own';
  if (typeof location !== 'undefined' && typeof fetch === 'function') return 'tavern';
  return null;
}

// ---- 把用户描述 + 运行方式拼成给 AI 的提示词 ----
export function buildAiPrompt(ask, exec = 'script') {
  const kind = exec === 'text'
    ? '纯文本片段（直接插入到聊天输入框，不执行）'
    : 'SillyTavern STscript 脚本（可被斜杠命令执行）';
  const lines = [
    '你是一个 SillyTavern「小手机工坊」脚本助手。请帮我写一个' + kind + '。',
    '要求：',
    '1. 只输出脚本本身，不要任何解释、不要 markdown 代码块包裹。',
    exec === 'text'
      ? '2. 输出一段可直接插入聊天输入框的纯文本（例如常用开场白、固定提示词、常用回复模板）。'
      : '2. 使用 STscript 语法（以 / 开头的斜杠命令，如 /sys、/echo、/setinput、/run 等），要可直接运行。',
    '3. 脚本要实用、简洁。',
  ];
  if (isNonEmptyString(ask)) lines.push('用户想实现的效果：' + ask);
  return lines.join('\n');
}

// ---- 构造 OpenAI 兼容 messages：内置 system 规则（隐藏）+ 用户描述 ----
// system = PHONE_SYSTEM_PROMPT（让 AI 只写代码、忽略世界观）；user = buildAiPrompt（带运行方式 + 用户效果描述）。
export function buildOpenAiMessages(ask, exec = 'script') {
  const userPrompt = buildAiPrompt(ask, exec);
  return [
    { role: 'system', content: PHONE_SYSTEM_PROMPT },
    { role: 'user', content: isNonEmptyString(userPrompt) ? userPrompt : '' },
  ];
}

// ---- 构造 OpenAI 兼容请求体 ----
export function buildOpenAiBody(messages, model, { temperature = 0.4, max_tokens = 1500 } = {}) {
  return {
    model: isNonEmptyString(model) ? model : 'gpt-4o-mini',
    messages: Array.isArray(messages) ? messages : [],
    temperature,
    max_tokens,
  };
}

// ---- 从响应解析出文本（兼容 OpenAI 完整返回 / 流式增量 / 字符串兜底）----
export function extractAiText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  try {
    if (Array.isArray(raw.choices) && raw.choices[0]) {
      const m = raw.choices[0].message || raw.choices[0].delta || {};
      if (isNonEmptyString(m.content)) return m.content.trim();
    }
  } catch (_) { /* 忽略 */ }
  if (isNonEmptyString(raw.content)) return String(raw.content).trim();
  return '';
}

// ---- 解析酒馆同连接的本地端点（特性检测 location，缺失返回 null）----
export function resolveTavernEndpoint() {
  try {
    if (typeof location !== 'undefined' && location && location.origin) {
      return location.origin + '/api/openai/chat/completions';
    }
  } catch (_) { /* 忽略 */ }
  return null;
}

// ---- 联合正文：把文本按插入方式合并进基底（replace=覆盖 / append=追加到正文）----
// 用于两处：① AI 帮写结果插入代码区；② M16-D 运行时文本模板插入聊天输入框（联合正文）。纯函数可测。
export function combineWithBody(body, text, mode = 'append') {
  const safeMode = PHONE_SCRIPT_INSERT.includes(mode) ? mode : 'append';
  const a = typeof body === 'string' ? body : '';
  const b = typeof text === 'string' ? text : '';
  if (safeMode === 'replace') return b;
  return [a, b].filter((s) => s.trim().length > 0).join('\n');
}

// ===================== 网络调用（浏览器；沙箱无 fetch 不测，仅特性检测）=====================

// ---- 自有 OpenAI 兼容 API 生成（完全隔离：请求只含我们的 system+user messages）----
export async function callOwnApi(ask, exec, settings) {
  const own = (settings && settings.phoneScripts && settings.phoneScripts.ownApi) || {};
  const base = (own.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '自有 API 缺少 baseUrl' };
  const url = base + '/chat/completions';
  const body = buildOpenAiBody(buildOpenAiMessages(ask, exec), own.model);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (own.apiKey || '') },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const data = await res.json().catch(() => null);
    const text = extractAiText(data);
    return text ? { ok: true, text } : { ok: false, error: '返回内容为空' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---- 复用酒馆同连接（本地服务端注入 key，无需自带 apiKey）----
// 说明：该端点可能仍注入角色上下文，但 PHONE_SYSTEM_PROMPT 已指令模型忽略；需彻底隔离请用自有 API。
export async function callTavernApi(ask, exec, ctx) {
  const url = resolveTavernEndpoint();
  if (!url) return { ok: false, error: '酒馆同连接不可用（缺少 location / fetch）' };
  const body = buildOpenAiBody(buildOpenAiMessages(ask, exec), '');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: '酒馆同连接请求失败 HTTP ' + res.status };
    const data = await res.json().catch(() => null);
    const text = extractAiText(data);
    return text ? { ok: true, text } : { ok: false, error: '返回内容为空' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ===================== 跨作用域持久化（纯逻辑，可在 node 用 mock ctx 测）=====================

// 把模板写回目标作用域，并从其它作用域移除同 id（避免跨作用域重复 + 保证作用域随表单切换）
export function persistTemplateToScope(ctx, settings, tpl, targetScope) {
  if (!PHONE_SCRIPT_SCOPES.includes(targetScope)) return false;
  const sources = readAllSources(ctx, settings);
  const norm = normalizeTemplate(tpl);
  for (const scope of PHONE_SCRIPT_SCOPES) {
    let list = Array.isArray(sources[scope]) ? sources[scope].slice() : [];
    if (scope === targetScope) list = addTemplate(list, norm);
    else list = removeTemplate(list, norm.id);
    if (scope === 'global') saveGlobalList(ctx, settings, list);
    else if (scope === 'chat') saveChatList(ctx, settings, list);
    else if (scope === 'character') saveCharacterList(ctx, settings, list);
  }
  refreshPhoneBar();
  return true;
}

// 从某作用域删除一个模板
export function deleteTemplateFromScope(ctx, settings, id, scope) {
  if (!PHONE_SCRIPT_SCOPES.includes(scope)) return false;
  const sources = readAllSources(ctx, settings);
  const list = Array.isArray(sources[scope]) ? sources[scope].slice() : [];
  const next = removeTemplate(list, id);
  if (scope === 'global') saveGlobalList(ctx, settings, next);
  else if (scope === 'chat') saveChatList(ctx, settings, next);
  else if (scope === 'character') saveCharacterList(ctx, settings, next);
  refreshPhoneBar();
  return true;
}

// ===================== 编辑器 DOM（单例，挂在 body）=====================

let editorEl = null;
let ctxRef = null;
let settingsRef = null;
let currentId = null;
let aiBusy = false;
let undoStack = [];          // 撤回栈：每项 { kind:'form', snap } 或 { kind:'restore', tpl, scope }
let lastAiText = '';        // AI 预览的待插入文本

function escapeForAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function skeletonHtml() {
  const scopeOpts = PHONE_SCRIPT_SCOPES.map((s) => `<option value="${s}">${escapeForAttr(SCOPE_LABELS[s])}</option>`).join('');
  const execOpts = PHONE_SCRIPT_EXEC.map((e) => `<option value="${e}">${escapeForAttr(EXEC_LABELS[e])}</option>`).join('');
  const insertOpts = PHONE_SCRIPT_INSERT.map((m) => `<option value="${m}">${escapeForAttr(INSERT_LABELS[m])}</option>`).join('');
  return `
  <div class="dz-pe-modal" role="dialog" aria-label="小手机工坊" aria-modal="true">
    <div class="dz-pe-header">
      <span class="dz-pe-title">📱 小手机工坊</span>
      <span id="dz-pe-backend" class="dz-pe-backend"></span>
      <button type="button" id="dz-pe-close" class="dz-pe-x" title="关闭">✕</button>
    </div>
    <div class="dz-pe-body">
      <div class="dz-pe-list-wrap">
        <div class="dz-pe-list-head">
          <span>模板列表</span>
          <button type="button" id="dz-pe-new" class="dz-pe-mini" title="新建空白模板">＋ 新建</button>
        </div>
        <div id="dz-pe-list" class="dz-pe-list"></div>
      </div>
      <div class="dz-pe-form">
        <label class="dz-pe-row">模板名
          <input type="text" id="dz-pe-name" class="dz-pe-input" placeholder="例如：小手机说话" />
        </label>
        <div class="dz-pe-row dz-pe-row2">
          <label>运行方式
            <select id="dz-pe-exec" class="dz-pe-sel">${execOpts}</select>
          </label>
          <label>保存到
            <select id="dz-pe-save-scope" class="dz-pe-sel">${scopeOpts}</select>
          </label>
          <label>插入方式
            <select id="dz-pe-insert" class="dz-pe-sel" title="运行时文本模板如何进入聊天输入框">${insertOpts}</select>
          </label>
        </div>
        <label class="dz-pe-row">脚本 / 文本
          <textarea id="dz-pe-code" class="dz-pe-code" rows="12" placeholder="STscript 例如：/sys 手机亮了&#10;或纯文本：直接插入输入框"></textarea>
        </label>
        <div class="dz-pe-ai">
          <label class="dz-pe-row dz-pe-row-ask">📝 告诉 AI 你想要什么（效果描述）
            <textarea id="dz-pe-ai-ask" class="dz-pe-ai-ask" rows="3" placeholder="例如：让小手机报当前时间，并用 /sys 在后台写一条世界书条目"></textarea>
          </label>
          <div class="dz-pe-ai-note">🔒 已内置不可见的代码生成规则：AI 只写代码，不受角色 / 世界观 / 世界书干扰（无需你手动塞预设）。</div>
          <div class="dz-pe-ai-row">
            <button type="button" id="dz-pe-ai" class="dz-pe-btn">✨ AI 生成</button>
            <button type="button" id="dz-pe-undo" class="dz-pe-btn" title="撤回上一步（AI 插入 / 保存 / 删除）">↩ 撤回</button>
            <span id="dz-pe-ai-status" class="dz-pe-ai-status"></span>
          </div>
          <div id="dz-pe-ai-preview" class="dz-pe-ai-preview" hidden></div>
          <div id="dz-pe-ai-preview-acts" class="dz-pe-ai-row" hidden>
            <button type="button" id="dz-pe-ai-insert" class="dz-pe-btn dz-pe-primary">插入到模板</button>
            <button type="button" id="dz-pe-ai-discard" class="dz-pe-btn">丢弃</button>
          </div>
        </div>
        <div class="dz-pe-actions">
          <button type="button" id="dz-pe-try" class="dz-pe-btn">▶ 试跑</button>
          <button type="button" id="dz-pe-save" class="dz-pe-btn dz-pe-primary">💾 保存</button>
          <button type="button" id="dz-pe-export" class="dz-pe-btn">📦 导出包</button>
          <button type="button" id="dz-pe-import" class="dz-pe-btn">📥 导入包</button>
        </div>
        <input type="file" id="dz-pe-file" accept="application/json,.json" hidden />
      </div>
    </div>
    <div class="dz-pe-footer"><span id="dz-pe-hint"></span></div>
  </div>`;
}

function ensureEditor(ctx, settings) {
  if (editorEl) return editorEl;
  if (typeof document === 'undefined') return null;
  const root = document.createElement('div');
  root.id = EDITOR_ID;
  root.className = 'dz-phone-editor';
  root.hidden = true;
  root.innerHTML = skeletonHtml();
  document.body.appendChild(root);
  wireEditor(root, ctx, settings);
  editorEl = root;
  return root;
}

function $(root, sel) { return root.querySelector(sel); }

function setHint(root, msg, isErr) {
  const el = $(root, '#dz-pe-hint');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'dz-pe-hint' + (isErr ? ' dz-pe-hint-err' : '');
}

function setBackend(root, settings) {
  const el = $(root, '#dz-pe-backend');
  if (!el) return;
  const b = decideAiBackend(settings);
  el.textContent = b === 'own' ? 'AI：自有 API' : b === 'tavern' ? 'AI：酒馆同连接' : 'AI：未配置';
  el.className = 'dz-pe-backend' + (b ? '' : ' dz-pe-backend-off');
}

// ---- 渲染模板列表（按作用域分组）----
function renderList(root, ctx, settings) {
  const box = $(root, '#dz-pe-list');
  if (!box) return;
  const sources = readAllSources(ctx, settings);
  const all = filterTemplates(collectTemplates(sources), {});
  if (all.length === 0) {
    box.innerHTML = '<div class="dz-pe-empty">还没有模板，点「＋ 新建」或从「📥 导入包」开始。</div>';
    return;
  }
  const rows = all.map((t) => {
    const scopeLabel = SCOPE_LABELS[t.scope] || t.scope;
    const execLabel = EXEC_LABELS[t.exec] || t.exec;
    return `
    <div class="dz-pe-item" data-id="${escapeForAttr(t.id)}">
      <div class="dz-pe-item-main">
        <span class="dz-pe-item-name">${escapeForAttr(t.name)}</span>
        <span class="dz-pe-badge dz-pe-badge-scope">${escapeForAttr(scopeLabel)}</span>
        <span class="dz-pe-badge dz-pe-badge-exec">${escapeForAttr(execLabel)}</span>
      </div>
      <div class="dz-pe-item-acts">
        <button type="button" class="dz-pe-mini" data-act="edit">编辑</button>
        <button type="button" class="dz-pe-mini" data-act="dup">复制</button>
        <button type="button" class="dz-pe-mini dz-pe-danger" data-act="del">删除</button>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = rows;
  box.querySelectorAll('.dz-pe-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'edit') loadTemplate(root, ctx, settings, id);
        else if (act === 'dup') duplicateTemplate(root, ctx, settings, id);
        else if (act === 'del') deleteTemplate(root, ctx, settings, id);
      });
    });
    item.addEventListener('click', () => loadTemplate(root, ctx, settings, id));
  });
}

// ---- 把某模板载入表单（编辑模式）----
function loadTemplate(root, ctx, settings, id) {
  const sources = readAllSources(ctx, settings);
  const all = collectTemplates(sources);
  const t = getTemplate(all, id);
  if (!t) { setHint(root, '未找到该模板', true); return; }
  currentId = t.id;
  $(root, '#dz-pe-name').value = t.name || '';
  $(root, '#dz-pe-exec').value = PHONE_SCRIPT_EXEC.includes(t.exec) ? t.exec : 'script';
  $(root, '#dz-pe-save-scope').value = PHONE_SCRIPT_SCOPES.includes(t.scope) ? t.scope : 'chat';
  $(root, '#dz-pe-insert').value = PHONE_SCRIPT_INSERT.includes(t.insert) ? t.insert : 'append';
  $(root, '#dz-pe-code').value = t.code || '';
  setHint(root, '正在编辑：' + (t.name || t.id));
}

// ---- 复制一个模板为新模板（换 id，作用域落到默认）----
function duplicateTemplate(root, ctx, settings, id) {
  const sources = readAllSources(ctx, settings);
  const all = collectTemplates(sources);
  const t = getTemplate(all, id);
  if (!t) return;
  const def = (settings && settings.phoneScripts && settings.phoneScripts.defaultScope) || 'chat';
  const copy = makeTemplate({ name: (t.name || '未命名') + ' 副本', scope: def, exec: t.exec, insert: t.insert, code: t.code });
  persistTemplateToScope(ctx, settings, copy, def);
  renderList(root, ctx, settings);
  loadTemplate(root, ctx, settings, copy.id);
  setHint(root, '已复制为：' + copy.name);
}

// ---- 删除模板（按其在聚合中的 scope 删除）----
function deleteTemplate(root, ctx, settings, id) {
  const sources = readAllSources(ctx, settings);
  const all = collectTemplates(sources);
  const t = getTemplate(all, id);
  if (!t) return;
  pushDeleteUndo(t, t.scope); // 撤回可把刚删的模板重新加回
  deleteTemplateFromScope(ctx, settings, id, t.scope);
  if (currentId === id) resetForm(root);
  renderList(root, ctx, settings);
  setHint(root, '已删除：' + (t.name || id) + '（可「↩ 撤回」恢复）');
}

// ---- 清空表单（新建模式）----
function resetForm(root) {
  currentId = null;
  $(root, '#dz-pe-name').value = '';
  const def = (settingsRef && settingsRef.phoneScripts && settingsRef.phoneScripts.defaultScope) || 'chat';
  $(root, '#dz-pe-exec').value = 'script';
  $(root, '#dz-pe-save-scope').value = PHONE_SCRIPT_SCOPES.includes(def) ? def : 'chat';
  $(root, '#dz-pe-insert').value = 'append';
  $(root, '#dz-pe-code').value = '';
  $(root, '#dz-pe-ai-ask').value = '';
  hideAiPreview(root);
  setHint(root, '新建模板');
}

// ===================== 撤回栈（表单快照 / 删除恢复）=====================
function snapshotForm(root) {
  return {
    name: $(root, '#dz-pe-name').value,
    exec: $(root, '#dz-pe-exec').value,
    scope: $(root, '#dz-pe-save-scope').value,
    insert: $(root, '#dz-pe-insert').value,
    code: $(root, '#dz-pe-code').value,
  };
}
function restoreForm(root, snap) {
  if (!snap) return;
  $(root, '#dz-pe-name').value = snap.name || '';
  $(root, '#dz-pe-exec').value = PHONE_SCRIPT_EXEC.includes(snap.exec) ? snap.exec : 'script';
  $(root, '#dz-pe-save-scope').value = PHONE_SCRIPT_SCOPES.includes(snap.scope) ? snap.scope : 'chat';
  $(root, '#dz-pe-insert').value = PHONE_SCRIPT_INSERT.includes(snap.insert) ? snap.insert : 'append';
  $(root, '#dz-pe-code').value = snap.code || '';
}
function pushFormUndo(root) {
  undoStack.push({ kind: 'form', snap: snapshotForm(root) });
  if (undoStack.length > 30) undoStack.shift();
}
function pushDeleteUndo(tpl, scope) {
  undoStack.push({ kind: 'restore', tpl: normalizeTemplate(tpl), scope });
  if (undoStack.length > 30) undoStack.shift();
}
function onUndo(root, ctx, settings) {
  const entry = undoStack.pop();
  if (!entry) { setHint(root, '没有可撤回的步骤', true); return; }
  if (entry.kind === 'form') {
    restoreForm(root, entry.snap);
    setHint(root, '已撤回上一步（表单已还原）');
  } else if (entry.kind === 'restore') {
    persistTemplateToScope(ctx, settings, entry.tpl, entry.scope);
    renderList(root, ctx, settings);
    loadTemplate(root, ctx, settings, entry.tpl.id);
    setHint(root, '已撤回删除，模板已恢复：' + (entry.tpl.name || entry.tpl.id));
  }
}

// ---- 保存：校验 → 构造 → 持久化到所选作用域 ----
function onSave(root, ctx, settings) {
  pushFormUndo(root); // 撤回可还原到保存前的表单
  const name = $(root, '#dz-pe-name').value.trim();
  const code = $(root, '#dz-pe-code').value;
  const exec = $(root, '#dz-pe-exec').value;
  const scope = $(root, '#dz-pe-save-scope').value;
  const insert = $(root, '#dz-pe-insert').value;
  const draft = { name, scope, exec, insert, code };
  if (!currentId) {
    const v = validateTemplate(draft);
    if (!v.ok) { setHint(root, '保存失败：' + v.error, true); return; }
    const tpl = v.template;
    persistTemplateToScope(ctx, settings, tpl, scope);
    renderList(root, ctx, settings);
    loadTemplate(root, ctx, settings, tpl.id);
    setHint(root, '已保存：' + tpl.name);
  } else {
    const sources = readAllSources(ctx, settings);
    const all = collectTemplates(sources);
    const base = getTemplate(all, currentId);
    if (!base) { setHint(root, '原模板不存在', true); return; }
    const patch = { name: name || base.name, scope, exec, insert, code, updatedAt: Date.now() };
    const updated = { ...base, ...patch, id: base.id };
    const v = validateTemplate(updated);
    if (!v.ok) { setHint(root, '保存失败：' + v.error, true); return; }
    // 先从所有作用域清掉旧 id，再按新 scope 写回（处理作用域切换）
    persistTemplateToScope(ctx, settings, v.template, scope);
    renderList(root, ctx, settings);
    loadTemplate(root, ctx, settings, v.template.id);
    setHint(root, '已保存：' + v.template.name);
  }
}

// ---- 试跑：调用 M16-D 运行器（未注册仅提示）----
function onTry(root) {
  if (!currentId) { setHint(root, '请先保存模板再试跑', true); return; }
  const ok = runPhoneTemplate(currentId);
  setHint(root, ok ? '已发送到运行器（M16-D）' : '运行器尚未就绪（需 M16-D）');
}

// ---- AI 帮写 ----
async function onAi(root, ctx, settings) {
  if (aiBusy) return;
  const backend = decideAiBackend(settings);
  if (!backend) {
    setHint(root, '未配置 AI：请在设置里填写自有 OpenAI 兼容 API（baseUrl/apiKey/model），或确保酒馆同连接可用', true);
    return;
  }
  const ask = $(root, '#dz-pe-ai-ask').value.trim();
  const exec = $(root, '#dz-pe-exec').value;
  aiBusy = true;
  const status = $(root, '#dz-pe-ai-status');
  if (status) status.textContent = '生成中…';
  setHint(root, 'AI 生成中（' + (backend === 'own' ? '自有 API' : '酒馆同连接') + '）');
  let res;
  try {
    res = backend === 'own' ? await callOwnApi(ask, exec, settings) : await callTavernApi(ask, exec, ctx);
  } catch (e) {
    res = { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    aiBusy = false;
  }
  if (status) status.textContent = '';
  if (res && res.ok) {
    lastAiText = res.text;
    const preview = $(root, '#dz-pe-ai-preview');
    if (preview) { preview.value = res.text; preview.hidden = false; }
    const acts = $(root, '#dz-pe-ai-preview-acts');
    if (acts) acts.hidden = false;
    if (!$(root, '#dz-pe-name').value.trim()) {
      $(root, '#dz-pe-name').value = isNonEmptyString(ask) ? ('AI：' + ask.slice(0, 20)) : 'AI 生成脚本';
    }
    setHint(root, 'AI 已生成，审查后点「插入到模板」（可「↩ 撤回」）');
  } else {
    setHint(root, 'AI 生成失败：' + (res && res.error ? res.error : '未知错误'), true);
  }
}

// ---- AI 预览「插入到模板」：按当前插入方式合并进代码区（replace / 联合正文）----
function onAiInsert(root) {
  if (!lastAiText) return;
  const mode = $(root, '#dz-pe-insert').value;
  pushFormUndo(root);
  const cur = $(root, '#dz-pe-code').value;
  $(root, '#dz-pe-code').value = combineWithBody(cur, lastAiText, mode);
  hideAiPreview(root);
  lastAiText = '';
  setHint(root, mode === 'replace' ? '已替换代码区（可「↩ 撤回」）' : '已联合正文插入代码区（可「↩ 撤回」）');
}

// ---- AI 预览「丢弃」----
function onAiDiscard(root) {
  hideAiPreview(root);
  lastAiText = '';
  setHint(root, '已丢弃 AI 结果');
}

function hideAiPreview(root) {
  const p = $(root, '#dz-pe-ai-preview');
  if (p) { p.hidden = true; p.value = ''; }
  const a = $(root, '#dz-pe-ai-preview-acts');
  if (a) a.hidden = true;
}

// ---- 导出命名 JSON 包（下载）----
function onExport(root, ctx, settings) {
  const sources = readAllSources(ctx, settings);
  const all = filterTemplates(collectTemplates(sources), {});
  if (all.length === 0) { setHint(root, '没有可导出的模板', true); return; }
  const defName = $(root, '#dz-pe-name').value.trim() || '我的小手机脚本';
  const pack = exportPack(all, defName);
  const text = JSON.stringify(pack, null, 2);
  try {
    if (typeof document === 'undefined' || !document.createElement) return;
    const blob = new Blob([text], { type: 'application/json' });
    const url = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(blob) : null;
    const a = document.createElement('a');
    a.href = url || ('data:application/json;charset=utf-8,' + encodeURIComponent(text));
    a.download = (defName || 'phone-scripts') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (url && URL.revokeObjectURL) URL.revokeObjectURL(url);
    setHint(root, '已导出包：' + pack.name + '（' + all.length + ' 个模板）');
  } catch (e) {
    setHint(root, '导出失败：' + (e && e.message ? e.message : String(e)), true);
  }
}

// ---- 导入包（文件选择 → 解析 → 合并进全局）----
function onImportFile(root, ctx, settings, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const parsed = parsePack(String(reader.result || ''));
    if (!parsed.ok) { setHint(root, '导入失败：' + parsed.error, true); return; }
    if (parsed.templates.length === 0) { setHint(root, '包内没有合法模板', true); return; }
    const sources = readAllSources(ctx, settings);
    const merged = importPack(parsed.templates, sources.global);
    saveGlobalList(ctx, settings, merged.templates);
    refreshPhoneBar();
    renderList(root, ctx, settings);
    let msg = '已导入：新增 ' + merged.added + '，更新 ' + merged.updated;
    if (parsed.skipped && parsed.skipped.length) msg += '，跳过 ' + parsed.skipped.length + ' 个非法';
    setHint(root, msg);
  };
  reader.onerror = () => setHint(root, '读取文件失败', true);
  try { reader.readAsText(file); } catch (e) { setHint(root, '读取文件失败：' + (e && e.message ? e.message : String(e)), true); }
}

function wireEditor(root, ctx, settings) {
  $(root, '#dz-pe-close').addEventListener('click', () => closePhoneEditor());
  $(root, '#dz-pe-new').addEventListener('click', () => { resetForm(root); renderList(root, ctx, settings); });
  $(root, '#dz-pe-save').addEventListener('click', () => onSave(root, ctx, settings));
  $(root, '#dz-pe-try').addEventListener('click', () => onTry(root));
  $(root, '#dz-pe-ai').addEventListener('click', () => onAi(root, ctx, settings));
  $(root, '#dz-pe-undo').addEventListener('click', () => onUndo(root, ctx, settings));
  const aiInsert = $(root, '#dz-pe-ai-insert');
  if (aiInsert) aiInsert.addEventListener('click', () => onAiInsert(root));
  const aiDiscard = $(root, '#dz-pe-ai-discard');
  if (aiDiscard) aiDiscard.addEventListener('click', () => onAiDiscard(root));
  $(root, '#dz-pe-export').addEventListener('click', () => onExport(root, ctx, settings));
  const fileInput = $(root, '#dz-pe-file');
  $(root, '#dz-pe-import').addEventListener('click', () => { if (fileInput) fileInput.click(); });
  if (fileInput) fileInput.addEventListener('change', (e) => {
    const f = e.target && e.target.files && e.target.files[0];
    onImportFile(root, ctx, settings, f);
    e.target.value = '';
  });
  // 点遮罩空白关闭
  root.addEventListener('mousedown', (e) => { if (e.target === root) closePhoneEditor(); });
  // Esc 关闭
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePhoneEditor(); });
}

// ---- 打开编辑器（注册回调时传入 null = 新建；传入 id = 编辑）----
export function openPhoneEditor(ctx, settings, id) {
  try {
    if (typeof document === 'undefined') { console.warn(`[${DISPLAY_NAME}] 非浏览器环境，编辑器未打开。`); return; }
    const root = ensureEditor(ctx, settings);
    if (!root) return;
    ctxRef = ctx; settingsRef = settings;
    setBackend(root, settings);
    resetForm(root);
    renderList(root, ctx, settings);
    if (isNonEmptyString(id)) loadTemplate(root, ctx, settings, id);
    root.hidden = false;
    // 聚焦名字输入框（新建时）
    const nameEl = $(root, '#dz-pe-name');
    if (nameEl && !id) setTimeout(() => { try { nameEl.focus(); } catch (_) {} }, 0);
    console.log(`[${DISPLAY_NAME}] 小手机工坊编辑器已打开。`);
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 打开小手机工坊编辑器失败（已捕获）：`, e);
  }
}

export function closePhoneEditor() {
  if (editorEl) editorEl.hidden = true;
}

// ---- 由 index.js 在 onReady 中调用：把编辑器注册到底部条「⚙ 管理」----
export function initPhoneEditor(ctx, settings) {
  try {
    ctxRef = ctx; settingsRef = settings;
    registerPhoneEditor((id) => openPhoneEditor(ctx, settings, id));
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 注册小手机工坊编辑器失败（已捕获）：`, e);
  }
}
