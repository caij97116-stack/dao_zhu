// src/card-adapt.js — M12：正则美化自适应（本插件的 [card] 卡片）
//
// 职责：
//   1. 把我们的 [card] 卡片改成「响应式」——CSS 里已流体宽，本轮补窄屏断点（见 style.css）；
//   2. 在「美化」标签页的「卡片美化自适应」区放一个「检查并重渲染全部卡片」按钮，
//      点一下对当前聊天的全部消息重跑清洗管线（复用 M2 的 reprocessAll），
//      解决个别旧消息因历史版本差异显示异常的问题。
//
// 设计约束（沿用 v1 硬指标）：
//   - 区块 HTML 抽成纯函数 buildCardAdaptHtml，不依赖 DOM，可 node 单测；
//   - 跨版本特性检测：缺 reprocessAll / 文档时安全降级，绝不抛错；
//   - 性能：reprocessAll 复用 M2 的「已渲染消息存原始文本 → 只重跑一次」机制，上千楼层也不卡。

import { getPane } from './floating-panel.js';
import { reprocessAll } from './incremental.js';

const DISPLAY_NAME = '岛主历险记';

// ---- 纯函数：返回「卡片美化自适应」区 HTML（便于单测）----
export function buildCardAdaptHtml() {
  return `
    <h4 class="dz-beauty-h">卡片美化自适应</h4>
    <p class="dz-hint">本插件的 [card] 卡片已适配 PC 与手机（流体宽 + 窄屏断点）。如某些旧消息显示异常，点下方按钮对当前聊天的全部消息重跑美化管线。</p>
    <button type="button" id="dz-recheck-cards" class="dz-btn">检查并重渲染全部卡片</button>
    <span id="dz-recheck-msg" class="dz-hint"></span>
  `;
}

// ---- 主入口：在 onReady 中调用（M11 之后填充 #dz-beautify-regex）----
export function renderCardAdaptPane(ctx, settings) {
  try {
    if (typeof document === 'undefined') return;
    const pane = getPane('beautify');
    if (!pane) return;
    const section = pane.querySelector('#dz-beautify-regex');
    if (!section) return;

    section.innerHTML = buildCardAdaptHtml();

    const btn = section.querySelector('#dz-recheck-cards');
    const msg = section.querySelector('#dz-recheck-msg');

    if (btn) {
      btn.addEventListener('click', () => {
        try {
          // 复用 M2 的增量渲染核心：只重跑一次，已渲染消息不会重复解析
          reprocessAll();
          if (msg) {
            msg.textContent = '已完成，已对全部消息重跑美化。';
            setTimeout(() => { if (msg) msg.textContent = ''; }, 2000);
          }
        } catch (e) {
          if (msg) msg.textContent = '重渲染出错（已捕获）。';
          console.error(`[${DISPLAY_NAME}] 重渲染卡片失败（已捕获）：`, e);
        }
      });
    }
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 渲染卡片自适应区失败（已捕获，不影响美化）：`, e);
  }
}
