// src/phone-scripts-bar.js — M16-B：小手机工坊 · 底部模板条
//
// 职责：
//   1. 在聊天底部注入一条独立的横向滚动模板条（.dz-phonebar），与 Quick Replies / 输入助手的
//      bar 互不干扰（独立命名空间、独立 DOM 节点、z-index 低于模态与悬浮窗）；
//   2. 模板按钮来自三作用域聚合（同层/全局/角色），点按钮即运行该脚本（runner 由 M16-D 注册）；
//   3. 「⚙ 管理」按钮打开全屏编辑器（editor 由 M16-C 注册），用于新建/编辑/AI 生成；
//   4. 贴输入框上方（不挡输入）+ 移动端安全区适配（env(safe-area-inset-bottom)）+ 可收起为把手。
//
// 设计约束（沿用 v1 / M15 硬指标）：
//   - 跨版本一律特性检测，缺 #send_form / document / window / 事件系统即安全降级，绝不抛错；
//   - 纯逻辑（底部距离计算、渲染上限）抽成不依赖 DOM 的函数，可用 node 单测；
//   - 命名空间 .dz-，z-index 8000（低于悬浮窗 9000、低于酒馆模态），pointer-events 仅限自身。

import { cloneObj } from './util.js';
import { collectTemplates, filterTemplates, defaultPhoneScriptsState } from './phone-scripts-data.js';

const DISPLAY_NAME = '岛主历险记';
const BAR_ID = 'dz-phonebar';
const HANDLE_ID = 'dz-phonebar-handle';
const MAX_VISIBLE = 50; // 底部条最多渲染多少按钮，超出提示去「管理」

// ---- 模块级引用 ----
let barEl = null;
let handleEl = null;
let phoneState = null;
let ctxRef = null;
let settingsRef = null;
let editHandler = null; // 由 M16-C 注册（打开全屏编辑器）
let runHandler = null;  // 由 M16-D 注册（运行脚本）

// ---- 纯函数：计算底部条距视口底部的距离（贴输入框上方；无输入框则贴底）----
export function computeBarBottom(sendFormTop, winH, safeInset = 0) {
  const safe = Number.isFinite(safeInset) ? safeInset : 0;
  if (!Number.isFinite(sendFormTop) || !Number.isFinite(winH)) return safe;
  return Math.max(0, winH - sendFormTop) + safe;
}

// ---- 纯函数：控制渲染上限（超出部分提示去管理）----
export function sliceVisible(list, max = MAX_VISIBLE) {
  const arr = Array.isArray(list) ? list : [];
  const m = Number.isFinite(max) && max > 0 ? max : MAX_VISIBLE;
  return { items: arr.slice(0, m), more: Math.max(0, arr.length - m) };
}

// ---- 懒初始化 phoneScripts 子状态（不依赖 index.js 的 defaultSettings，保持模块自洽）----
function getPhoneState(settings) {
  if (!settings || typeof settings !== 'object') return defaultPhoneScriptsState();
  if (!settings.phoneScripts || typeof settings.phoneScripts !== 'object') {
    settings.phoneScripts = defaultPhoneScriptsState();
  }
  const def = defaultPhoneScriptsState();
  for (const k of Object.keys(def)) {
    if (!Object.prototype.hasOwnProperty.call(settings.phoneScripts, k)) settings.phoneScripts[k] = def[k];
  }
  if (!settings.phoneScripts.ownApi || typeof settings.phoneScripts.ownApi !== 'object') {
    settings.phoneScripts.ownApi = def.ownApi;
  }
  return settings.phoneScripts;
}

// ---- 读取三作用域来源（供 M16-C/D 复用）----
export function readAllSources(ctx, settings) {
  const ps = getPhoneState(settings);
  const global = Array.isArray(ps.templates) ? ps.templates : [];
  let chat = [];
  try {
    const cm = ctx && (ctx.chatMetadata || ctx.chat_metadata);
    if (cm && cm.phoneScripts && Array.isArray(cm.phoneScripts.templates)) chat = cm.phoneScripts.templates;
  } catch (_) { /* 忽略：无聊天元数据 */ }
  let character = [];
  try {
    const chid = ctx && (ctx.characterId != null ? ctx.characterId : ctx.chid);
    const ch = (ctx && Array.isArray(ctx.characters) && chid != null) ? ctx.characters[chid] : null;
    if (ch && ch.data && ch.data.extensions && Array.isArray(ch.data.extensions.phoneScripts)) {
      character = ch.data.extensions.phoneScripts;
    }
  } catch (_) { /* 忽略：无角色 */ }
  return { global, chat, character };
}

// ---- 写回三来源（供 M16-C/D 复用）----
export function saveGlobalList(ctx, settings, list) {
  const ps = getPhoneState(settings);
  ps.templates = cloneObj(list);
  try { if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced(); } catch (_) {}
  return true;
}
export function saveChatList(ctx, settings, list) {
  try {
    const cm = ctx && (ctx.chatMetadata || ctx.chat_metadata);
    if (cm) {
      if (!cm.phoneScripts || typeof cm.phoneScripts !== 'object') cm.phoneScripts = {};
      cm.phoneScripts.templates = cloneObj(list);
      return true;
    }
  } catch (_) {}
  return false;
}
export function saveCharacterList(ctx, settings, list) {
  try {
    const chid = ctx && (ctx.characterId != null ? ctx.characterId : ctx.chid);
    const ch = (ctx && Array.isArray(ctx.characters) && chid != null) ? ctx.characters[chid] : null;
    if (ch && ch.data && ch.data.extensions) {
      ch.data.extensions.phoneScripts = cloneObj(list);
      try { if (ctx && typeof ctx.writeExtensionField === 'function') ctx.writeExtensionField(chid, 'phoneScripts', list); } catch (_) {}
      return true;
    }
  } catch (_) {}
  return false;
}

// ---- 由后续模块注册回调（解耦：M16-C 注册编辑器、M16-D 注册运行器）----
export function registerPhoneEditor(fn) { if (typeof fn === 'function') editHandler = fn; }
export function registerPhoneRunner(fn) { if (typeof fn === 'function') runHandler = fn; }

// ---- 供编辑器「试跑」按钮调用：未注册运行器时只提示不报错 ----
export function runPhoneTemplate(id) {
  if (runHandler) { runHandler(id); return true; }
  console.warn(`[${DISPLAY_NAME}] 运行器尚未就绪（需 M16-D），试跑未执行。`);
  return false;
}

// ---- 重新渲染底部条（模板变更后调用）----
export function refreshPhoneBar() {
  if (barEl) renderBar();
}

// ---- 设置面板用：显示/隐藏整条 ----
export function setPhoneBarVisible(visible) {
  if (!phoneState) return;
  phoneState.showBar = !!visible;
  persist();
  if (visible) {
    if (barEl == null) attachPhoneBar(ctxRef, settingsRef);
    else { barEl.hidden = false; if (handleEl) handleEl.hidden = true; applyBarPosition(); }
  } else {
    if (barEl) barEl.hidden = true;
    if (handleEl) handleEl.hidden = true;
  }
}

// ---- 内部：当前展示列表（聚合 + 不筛选）----
function currentList() {
  const sources = readAllSources(ctxRef, settingsRef);
  return filterTemplates(collectTemplates(sources), {});
}

function escapeForAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- 内部：渲染条内容 ----
function renderBar() {
  if (!barEl) return;
  const list = currentList();
  const { items, more } = sliceVisible(list, MAX_VISIBLE);
  const btns = items.map((t) =>
    `<button type="button" class="dz-phonebar-btn" data-id="${escapeForAttr(t.id)}" title="作用域：${escapeForAttr(t.scope)}">${escapeForAttr(t.name)}</button>`
  ).join('');
  const moreBtn = more > 0 ? `<span class="dz-phonebar-more">+${more} 项（管理里查看）</span>` : '';
  const manageBtn = `<button type="button" class="dz-phonebar-btn dz-phonebar-manage" data-act="manage" title="打开小手机工坊">⚙ 管理</button>`;
  barEl.innerHTML = `
    <div class="dz-phonebar-track">${btns}${moreBtn}${manageBtn}</div>
    <button type="button" class="dz-phonebar-collapse" data-act="collapse" title="收起">▾</button>
  `;
  barEl.querySelectorAll('.dz-phonebar-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.id;
      if (id) {
        if (runHandler) runHandler(id);
        else console.warn(`[${DISPLAY_NAME}] 运行器尚未就绪（需 M16-D）。`);
      } else if (b.dataset.act === 'manage') {
        if (editHandler) editHandler(null);
        else console.warn(`[${DISPLAY_NAME}] 编辑器尚未就绪（需 M16-C）。`);
      }
    });
  });
  const collapseBtn = barEl.querySelector('.dz-phonebar-collapse');
  if (collapseBtn) collapseBtn.addEventListener('click', collapseBar);
}

// ---- 内部：读取安全区插入值 ----
function getComputedSafeInset() {
  let v = 0;
  try {
    if (typeof getComputedStyle === 'function' && document.documentElement) {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('env(safe-area-inset-bottom)');
      const n = parseFloat(raw);
      if (Number.isFinite(n)) v = n;
    }
  } catch (_) { /* 忽略 */ }
  return v;
}

// ---- 内部：把条贴到输入框上方（不挡输入）----
function applyBarPosition() {
  if (!barEl) return;
  const safe = getComputedSafeInset();
  let sendTop = NaN;
  try {
    const sf = document.querySelector('#send_form');
    if (sf) sendTop = sf.getBoundingClientRect().top;
  } catch (_) { /* 忽略：无输入框容器 */ }
  barEl.style.bottom = `${computeBarBottom(sendTop, window.innerHeight, safe)}px`;
}

function collapseBar() {
  if (barEl) { barEl.hidden = true; barEl.style.bottom = 'auto'; }
  if (handleEl) handleEl.hidden = false;
  if (phoneState) { phoneState.collapsed = true; persist(); }
}
function expandBar() {
  if (barEl) { barEl.hidden = false; applyBarPosition(); }
  if (handleEl) handleEl.hidden = true;
  if (phoneState) { phoneState.collapsed = false; persist(); }
}

function persist() {
  try { if (ctxRef && typeof ctxRef.saveSettingsDebounced === 'function') ctxRef.saveSettingsDebounced(); } catch (_) {}
}

// ---- 主入口：在 onReady 中调用 ----
export function attachPhoneBar(ctx, settings) {
  try {
    if (typeof document === 'undefined') return; // 非浏览器环境直接退出
    if (document.getElementById(BAR_ID)) return; // 已挂载则跳过，防重复

    phoneState = getPhoneState(settings);
    ctxRef = ctx;
    settingsRef = settings;
    if (phoneState.showBar === false) return; // 配置关闭则默认不挂载（设置可恢复）

    // 构建横向条
    barEl = document.createElement('div');
    barEl.id = BAR_ID;
    barEl.className = 'dz-phonebar';
    document.body.appendChild(barEl);

    // 收起把手（默认隐藏；仅折叠态可见）
    handleEl = document.createElement('button');
    handleEl.id = HANDLE_ID;
    handleEl.type = 'button';
    handleEl.className = 'dz-phonebar-handle';
    handleEl.textContent = '📱';
    handleEl.title = '展开小手机模板条';
    handleEl.hidden = !(phoneState.collapsed === true);
    handleEl.addEventListener('click', expandBar);
    document.body.appendChild(handleEl);

    renderBar();
    applyBarPosition();

    if (phoneState.collapsed === true) {
      barEl.hidden = true;
      handleEl.hidden = false;
    }

    // 视口变化重定位（输入框高度变化也跟得上）
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', applyBarPosition);
    }
    // 切换聊天/角色后，模板来源变化 → 刷新条
    const eventSource = (ctx && ctx.eventSource) || globalThis.eventSource || null;
    const event_types = globalThis.event_types || (ctx && ctx.event_types) || null;
    if (eventSource && event_types && event_types.CHAT_CHANGED !== undefined) {
      eventSource.on(event_types.CHAT_CHANGED, () => { renderBar(); applyBarPosition(); });
    }

    console.log(`[${DISPLAY_NAME}] 小手机模板条已挂载（独立底条 + 三作用域聚合）。`);
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 挂载小手机模板条失败（已捕获，不影响其他功能）：`, e);
  }
}
