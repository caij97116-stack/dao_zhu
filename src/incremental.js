// src/incremental.js — M2：增量渲染核心
// 目标（对应需求一：冲突/重复/卡顿/内存泄漏）：
//   - 用 MutationObserver 只盯聊天区里“新增/变化”的消息节点，不轮询、不全量重绘；
//   - 防抖：流式输出时文本频繁变动，只有“安静 200ms 后”才真正处理一次；
//   - 去重：已处理的消息用 id/元素标记，绝不重复处理（避免重复匹配、全量重绘）；
//   - 清理：切聊(CHAT_CHANGED)时清空已处理集合并重新扫描；卸载时断开 observer，防内存泄漏。

import { debounce } from './util.js';

const DISPLAY_NAME = '岛主历险记';

// ---- 模块级状态（ES 模块单例，跨调用保持）----
let observer = null;              // MutationObserver 实例
let chatEl = null;                // 聊天容器元素
let processor = null;             // 实际美化处理器（M3~M5 注册）；为 null 时只走管线不美化
let pending = new Set();          // 待处理消息元素
let processedIds = new Set();     // 已处理消息 id（data-message-id）
let processedEls = new WeakSet(); // 无 id 元素兜底
let chatChangedHandler = null;    // 切聊监听器引用（便于清理）
let chatChangedType = null;       // 切聊事件类型（便于清理）

// M15-B：识别消息是否含 [card] 标签（与 repair.js 的 HAS_CARD_RE 同源），
// 用于判断“本楼层卡片被第三方插件改写冲掉后是否需要恢复”
const HAS_CARD_RE = /\[\s*\/?\s*card\s*\]/i;

const OBSERVE_OPTS = { childList: true, subtree: true, characterData: true };
const DEBOUNCE_MS = 200;

// ---- 选择器特性检测（不同版本容器/类名可能不同）----
function findChatContainer() {
  const candidates = ['#chat', '.chat', '#chat-container', 'main'];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body || null;
}

function isMesEl(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.classList && node.classList.contains('mes')) return true;
  if (node.hasAttribute && node.hasAttribute('data-message-id')) return true;
  return false;
}

function closestMes(node) {
  let n = node;
  while (n && n.nodeType !== 1) n = n.parentElement; // 文本节点先上提到元素
  while (n && n.nodeType === 1) {
    if (isMesEl(n)) return n;
    n = n.parentElement;
  }
  return null;
}

function getMessageId(el) {
  return el && el.getAttribute ? el.getAttribute('data-message-id') : null;
}

function isProcessed(el) {
  const id = getMessageId(el);
  if (id != null) return processedIds.has(id);
  return processedEls.has(el);
}

function markProcessed(el) {
  const id = getMessageId(el);
  if (id != null) processedIds.add(id);
  else processedEls.add(el);
}

function unmarkProcessed(el) {
  const id = getMessageId(el);
  if (id != null) processedIds.delete(id);
  else processedEls.delete(el);
}

// 取消息正文容器（特性检测 .mes_text，缺失则退回 .mes 本身）
function getTextEl(mesEl) {
  if (!mesEl) return null;
  const t = mesEl.querySelector('.mes_text');
  return t || mesEl;
}

// ---- 处理单条消息（核心：先标记再改 DOM，避免自身突变递归）----
function processMessage(el) {
  if (!el || !el.isConnected) return;   // 元素已被移除则跳过
  if (isProcessed(el)) return;          // 已处理则跳过（去重）
  markProcessed(el);                    // 先标记，防自身 DOM 写入触发递归

  const textEl = getTextEl(el);
  if (!textEl) return;

  if (typeof processor === 'function') {
    // 处理期间暂停观察，避免我们的 DOM 写入再次触发 observer（防死循环）
    if (observer) observer.disconnect();
    try {
      processor({ mesEl: el, textEl, rawHtml: textEl.innerHTML });
    } catch (e) {
      console.error(`[${DISPLAY_NAME}] 消息处理出错（已捕获，不影响其他消息）：`, e);
    } finally {
      if (observer && chatEl) observer.observe(chatEl, OBSERVE_OPTS);
    }
  }
}

// ---- 防抖刷新：把 pending 里的消息各处理一次 ----
const flush = debounce(function flushNow() {
  for (const el of pending) {
    processMessage(el);
  }
  pending.clear();
}, DEBOUNCE_MS);

function scheduleProcess(el) {
  if (!el) return;
  pending.add(el);
  flush();
}

// ---- MutationObserver 回调：只收集相关节点，不做重活 ----
function onMutations(mutations) {
  for (const m of mutations) {
    // 1) 新增子节点（新消息进入 DOM / 第三方插件重写了某楼 innerHTML）
    if (m.type === 'childList' && m.addedNodes) {
      for (const node of m.addedNodes) {
        const mes = isMesEl(node) ? node : closestMes(node);
        if (!mes) continue;
        // M15-B：与酒馆助手/柏宝箱等“同消息改写 innerHTML”的插件共存时，
        // 若本插件的卡片已被对方重写冲掉，则解除去重标记并重渲染恢复。
        // 仍只对“含 [card] 的原始楼层”生效；不含 [card] 的楼一律交还给第三方处理，绝不插手。
        if (isProcessed(mes)) {
          const t = getTextEl(mes);
          const stillHasCard = t && t.querySelector('.dz-card');
          if (!stillHasCard && mes.dataset && mes.dataset.dzOrig != null && HAS_CARD_RE.test(mes.dataset.dzOrig)) {
            unmarkProcessed(mes); // 允许下面重处理，恢复卡片
          } else {
            continue; // 卡片仍在；或本楼本不含 [card] → 不再插手，避免与第三方互相覆盖
          }
        }
        scheduleProcess(mes);
      }
    }
    // 2) 文本变化（流式输出 / 划词编辑 / 切换）
    if (m.type === 'characterData') {
      const mes = closestMes(m.target);
      if (!mes) continue;
      if (isProcessed(mes)) {
        // 已处理消息又变了（如 swipe/编辑）→ 解除标记，允许重处理
        unmarkProcessed(mes);
      }
      scheduleProcess(mes);
    }
  }
}

// ---- 初始扫描：把加载时已有的消息处理一遍（仅一次，非持续重绘）----
function processExisting() {
  if (!chatEl) return;
  chatEl.querySelectorAll('.mes').forEach((el) => scheduleProcess(el));
}

// ---- 切聊：清空状态并重新扫描新聊 ----
function onChatChanged() {
  processedIds.clear();
  pending.clear();
  processExisting();
}

// 安全移除事件监听（特性检测 off / removeListener）
function offEvent(eventSource, type, handler) {
  if (!eventSource || !handler || type == null) return;
  try {
    if (typeof eventSource.off === 'function') eventSource.off(type, handler);
    else if (typeof eventSource.removeListener === 'function') eventSource.removeListener(type, handler);
  } catch (_) { /* ignore */ }
}

// ---- 对外：注册实际美化处理器（M3~M5 调用）----
export function registerMessageProcessor(fn) {
  processor = (typeof fn === 'function') ? fn : null;
}

// ---- 对外：挂载增量渲染（在 onReady 中调用）----
export function attachIncrementalRenderer(ctx) {
  try {
    chatEl = findChatContainer();
    if (!chatEl) {
      console.warn(`[${DISPLAY_NAME}] 未找到聊天容器，增量渲染未启用（不影响酒馆）。`);
      return;
    }

    observer = new MutationObserver(onMutations);
    observer.observe(chatEl, OBSERVE_OPTS);

    // 切聊监听（特性检测）
    const eventSource = (ctx && ctx.eventSource) || globalThis.eventSource || null;
    const event_types = globalThis.event_types || (ctx && ctx.event_types) || null;
    if (eventSource && event_types && event_types.CHAT_CHANGED !== undefined) {
      chatChangedType = event_types.CHAT_CHANGED;
      chatChangedHandler = () => onChatChanged();
      eventSource.on(chatChangedType, chatChangedHandler);
    }

    // 资源清理（防内存泄漏）
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', destroy, { once: true });
    }

    console.log(`[${DISPLAY_NAME}] 增量渲染已挂载（MutationObserver + 防抖 ${DEBOUNCE_MS}ms + 去重）。`);
    processExisting(); // 处理加载时已有的消息（一次）
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 挂载增量渲染失败（已捕获）：`, e);
  }
}

// ---- 对外：按当前设置重新美化当前聊天的所有已渲染消息（设置变更后即时生效）----
// 依赖 renderMessage 处理器把“原始文本”存进了 el.dataset.dzOrig，
// 因此重渲染不会重复解析我们已经生成的卡片 HTML（高楼层也不会越跑越慢）。
export function reprocessAll() {
  if (!chatEl) return;
  processedIds.clear();   // 解除去重标记，让所有消息重新走一遍处理器
  processedEls.clear();
  chatEl.querySelectorAll('.mes').forEach((el) => processMessage(el));
}

// ---- 对外：还原当前聊天所有已渲染消息为最初原始文本（关闭美化时使用）----
export function restoreAll() {
  if (!chatEl) return;
  processedIds.clear();
  processedEls.clear();
  chatEl.querySelectorAll('.mes').forEach((el) => {
    if (el && el.dataset && el.dataset.dzOrig != null) {
      const textEl = getTextEl(el);
      if (textEl) textEl.textContent = el.dataset.dzOrig; // 还原为原始文本（dataset.dzOrig 保留以便再次美化）
    }
  });
}

// ---- 资源清理 ----
export function destroy() {
  try {
    if (observer) { observer.disconnect(); observer = null; }
    const eventSource = globalThis.eventSource || null;
    if (eventSource && chatChangedHandler) offEvent(eventSource, chatChangedType, chatChangedHandler);
    processedIds.clear();
    pending.clear();
    chatEl = null;
    processor = null;
    chatChangedHandler = null;
    chatChangedType = null;
  } catch (_) { /* ignore */ }
}
