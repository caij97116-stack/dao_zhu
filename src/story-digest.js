// src/story-digest.js — M26：故事摘要页
// 把整段聊天里所有美化过的卡片（普通信息卡 + 关系图卡）抽出来，
// 按楼层顺序拼成一个独立打开、可以单独上下滚动看的"章节回顾"弹层，
// 不用再翻聊天记录去找某张卡片长什么样。
//
// 复用 renderer.js 的 renderCardHtml，保证摘要页里的卡片跟聊天里长得一模一样
// （包括当前皮肤配色），不需要另外维护一份渲染逻辑。

import { escapeHtml } from './util.js';
import { parseCards } from './transform.js';
import { renderCardHtml } from './renderer.js';

const DISPLAY_NAME = '岛主历险记';
const MODAL_ID = 'dz-story-digest';
const MAX_CARDS = 400; // 极端超长聊天的兜底上限，避免一次性渲染卡死页面

let modalEl = null;

// ---- 遍历当前聊天，抽出每一楼里的卡片 ----
function collectDigestItems(ctx) {
  const chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
  const items = [];
  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i];
    if (!msg || typeof msg.mes !== 'string' || !msg.mes) continue;
    let cards = [];
    try {
      cards = parseCards(msg.mes, { repair: true }).cards || [];
    } catch (_) { continue; } // 单楼解析失败不该拖垮整个摘要页
    if (!cards.length) continue;
    const speaker = msg.name ? String(msg.name) : (msg.is_user ? '你' : 'AI');
    for (const cardData of cards) {
      items.push({ cardData, floor: i, speaker, isUser: !!msg.is_user });
      if (items.length >= MAX_CARDS) return { items, truncated: true };
    }
  }
  return { items, truncated: false };
}

// ---- 拼出摘要正文（按楼层分组，每组前面插一条"楼层条"）----
function buildDigestBodyHtml(ctx, settings) {
  const { items, truncated } = collectDigestItems(ctx);
  if (!items.length) {
    return '<div class="dz-digest-empty">这段聊天里还没有可以汇总的卡片——先聊几句，等 AI 用卡片格式回复之后再来看看。</div>';
  }

  let html = '';
  let lastFloor = null;
  for (const it of items) {
    if (it.floor !== lastFloor) {
      html += `<div class="dz-digest-sep"><span>${escapeHtml(it.speaker)} · 第 ${it.floor + 1} 楼</span></div>`;
      lastFloor = it.floor;
    }
    try {
      html += renderCardHtml(it.cardData, settings);
    } catch (e) {
      console.error(`[${DISPLAY_NAME}] 摘要页里有一张卡片渲染失败（已跳过，不影响其他卡片）：`, e);
      html += '<div class="dz-card dz-error"><div class="dz-title">渲染失败</div></div>';
    }
  }
  if (truncated) {
    html += `<div class="dz-digest-truncated">聊天太长了，只汇总了最前面 ${MAX_CARDS} 张卡片。</div>`;
  }
  return html;
}

function skeletonHtml() {
  return `
    <div class="dz-digest-backdrop"></div>
    <div class="dz-digest-modal">
      <div class="dz-digest-header">
        <b class="dz-digest-title">📖 故事摘要 · 卡片回顾</b>
        <button type="button" class="dz-digest-refresh" title="重新扫描当前聊天">↻ 刷新</button>
        <button type="button" class="dz-digest-x" title="关闭">✕</button>
      </div>
      <div class="dz-digest-body"></div>
    </div>
  `;
}

function ensureModal(ctx, settings) {
  if (modalEl) return modalEl;
  if (typeof document === 'undefined') return null;
  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.className = 'dz-digest';
  root.hidden = true;
  root.innerHTML = skeletonHtml();
  document.body.appendChild(root);

  const close = () => { root.hidden = true; };
  const refresh = () => renderIntoModal(ctx, settings);

  root.querySelector('.dz-digest-x').addEventListener('click', close);
  root.querySelector('.dz-digest-backdrop').addEventListener('click', close);
  root.querySelector('.dz-digest-refresh').addEventListener('click', refresh);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  modalEl = root;
  return root;
}

function renderIntoModal(ctx, settings) {
  if (!modalEl) return;
  const body = modalEl.querySelector('.dz-digest-body');
  if (!body) return;
  body.innerHTML = buildDigestBodyHtml(ctx, settings);
}

// ---- 对外：打开 / 关闭摘要页 ----
export function openStoryDigest(ctx, settings) {
  try {
    if (typeof document === 'undefined') return;
    ensureModal(ctx, settings);
    if (!modalEl) return;
    renderIntoModal(ctx, settings);
    modalEl.hidden = false;
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 打开故事摘要页失败（已捕获，不影响其他功能）：`, e);
  }
}

export function closeStoryDigest() {
  if (modalEl) modalEl.hidden = true;
}
