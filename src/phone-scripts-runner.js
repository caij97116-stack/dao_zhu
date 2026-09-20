// src/phone-scripts-runner.js — M16-D：小手机工坊 · 运行器
//
// 职责：把底部条按钮、编辑器「试跑」点到的模板真正跑起来：
//   1. 运行方式 = script（STscript）：走 SillyTavern 全局 executeSlashCommands（特性检测，缺则安全降级）；
//   2. 运行方式 = text（仅插入文本）：按「插入方式」把文本塞进聊天输入框（replace=覆盖 / append=联合正文）；
//   3. 通过底部条的 registerPhoneRunner 注册，所有运行入口统一走这里。
//
// 设计约束（沿用 v1 / M15 / M16 硬指标）：
//   - 跨版本一律特性检测，缺 executeSlashCommands / document / #send_textarea / Event 即安全降级，绝不抛错；
//   - 纯逻辑（输入框定位之外的合并、命令分发判定、按 id 查找并分发）抽成不依赖真实 DOM 的函数，node 单测；
//   - 命名空间 .dz-，运行时行为（executeSlashCommands / 操作输入框）属酒馆环境，需在真机 F12 验证。

import { isNonEmptyString } from './util.js';
import { collectTemplates, getTemplate, PHONE_SCRIPT_INSERT } from './phone-scripts-data.js';
import { readAllSources, registerPhoneRunner } from './phone-scripts-bar.js';
import { combineWithBody } from './phone-scripts-editor.js';

const DISPLAY_NAME = '岛主历险记';

// ===================== 纯函数（可在 node 单测，尽量不碰真实 DOM）=====================

// ---- 特性检测：找到聊天输入框（SillyTavern 默认 #send_textarea）----
export function findInputTextarea() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
    return document.querySelector('#send_textarea') || null;
  } catch (_) { /* 忽略：非浏览器 / 无输入框 */ }
  return null;
}

// ---- 把文本按插入方式合并进输入框（replace=覆盖 / append=联合正文）；并派发 input 事件让酒馆响应式更新 ----
// ta 为输入框元素（或测试用的伪元素：含 value / dispatchEvent）。纯逻辑、可测。
export function applyTextToInput(ta, text, mode = 'append') {
  if (!ta || typeof ta !== 'object') return false;
  const cur = typeof ta.value === 'string' ? ta.value : '';
  const next = combineWithBody(cur, typeof text === 'string' ? text : '', mode);
  try { ta.value = next; } catch (_) { return false; }
  if (typeof ta.dispatchEvent === 'function') {
    try {
      const Ev = (typeof Event !== 'undefined') ? Event
        : (typeof globalThis !== 'undefined' && globalThis.Event ? globalThis.Event : null);
      if (Ev) ta.dispatchEvent(new Ev('input', { bubbles: true }));
    } catch (_) { /* 忽略：派发事件失败不影响已写入的值 */ }
  }
  return true;
}

// ---- 特性检测并运行 STscript（斜杠命令）----
export function runSlashCommands(code) {
  try {
    const fn = (typeof globalThis !== 'undefined' && typeof globalThis.executeSlashCommands === 'function')
      ? globalThis.executeSlashCommands : null;
    if (!fn) return { ok: false, error: 'executeSlashCommands 不可用（当前酒馆版本未暴露该 API）' };
    fn(String(code || ''));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ---- 按模板运行（核心分发）----
export function runTemplate(ctx, settings, tpl) {
  if (!tpl || typeof tpl !== 'object') return { ok: false, error: '模板为空' };
  if (tpl.exec === 'text') {
    const ta = findInputTextarea();
    if (!ta) return { ok: false, error: '未找到聊天输入框（#send_textarea）' };
    const mode = PHONE_SCRIPT_INSERT.includes(tpl.insert) ? tpl.insert : 'append';
    applyTextToInput(ta, tpl.code || '', mode);
    return { ok: true, kind: 'text', mode };
  }
  // 默认 script
  const r = runSlashCommands(tpl.code || '');
  return r.ok ? { ok: true, kind: 'script' } : { ok: false, error: r.error, kind: 'script' };
}

// ---- 按 id 从三作用域聚合里查模板并运行（供底部条 / 编辑器试跑调用）----
export function runTemplateById(ctx, settings, id) {
  if (!isNonEmptyString(id)) return { ok: false, error: '模板 id 为空' };
  const sources = readAllSources(ctx, settings);
  const all = collectTemplates(sources);
  const t = getTemplate(all, id);
  if (!t) return { ok: false, error: '未找到模板：' + id };
  return runTemplate(ctx, settings, t);
}

// ===================== 注册（由 index.js 在 onReady 调用）=====================

// 把运行器接到底部条的 runHandler：底部按钮 / 编辑器「试跑」统一走 runTemplateById
export function initPhoneRunner(ctx, settings) {
  try {
    registerPhoneRunner((id) => runTemplateById(ctx, settings, id));
    console.log(`[${DISPLAY_NAME}] 小手机工坊运行器已注册。`);
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 注册小手机工坊运行器失败（已捕获）：`, e);
  }
}
