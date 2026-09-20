// src/renderer.js — M5：渲染 + iframe/JS + 容错
//
// 职责（对应需求二“不爆代码/不显示半成品” + 需求一“iframe 脚本注入类”）：
//   把 M4 解析出的 segments（正文段 + 卡片段）渲染成安全的卡片 HTML。
//   - 所有字段值一律 escapeHtml，绝不把 AI 文本当 HTML 注入（防裸代码/脚本）；
//   - 宿主有 DOMPurify（SillyTavern.libs.DOMPurify / window.DOMPurify）时用于可选 html 字段，缺省用极简转义兜底；
//   - iframe 字段仅允许 http/https 且经 URL 校验，sandbox="allow-scripts" 隔离；
//   - 单卡渲染失败降级为该卡原始文本（转义），绝不抛半成品；整体报错由 M2 的 try/catch 兜住。
//
// 性能（对应“数百/上千层不卡、逐层渲染完成”硬约束）：
//   纯字符串构建、无 DOM、无重正则；配合 M2 的“每楼只处理一次 + 防抖”即可高楼层稳定渲染。

import { escapeHtml } from './util.js';
import { parseCards } from './transform.js';

// 主题色允许列表（弱模型写错主题也不会注入任意 CSS）
const THEMES = {
  blue: '#3b82f6', green: '#22c55e', red: '#ef4444',
  purple: '#a855f7', orange: '#f97316', dark: '#334155',
};
const DEFAULT_THEME = 'blue';

// 特性检测宿主 DOMPurify（不依赖则走兜底）
function getDOMPurify() {
  try {
    if (typeof window !== 'undefined' && window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
      return window.DOMPurify;
    }
    const ST = globalThis.SillyTavern;
    if (ST && ST.libs && ST.libs.DOMPurify && typeof ST.libs.DOMPurify.sanitize === 'function') {
      return ST.libs.DOMPurify;
    }
  } catch (_) { /* ignore */ }
  return null;
}

// 仅用于“可选 html 字段”的可信消毒；无 DOMPurify 时退化为转义（禁用脚本）
function sanitizeHtmlField(html) {
  const DP = getDOMPurify();
  if (DP) {
    try { return DP.sanitize(String(html), { ADD_ATTR: ['target'] }); } catch (_) { /* fall through */ }
  }
  return escapeHtml(String(html)); // 兜底：实体化，等于禁用脚本
}

// iframe src 校验：只允许 http/https，拒绝 javascript:/data: 等
function safeIframeSrc(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch (_) { /* ignore */ }
  return null;
}

// 渲染单张卡片为安全 HTML
function renderCardHtml(data, settings) {
  const f = data && data.fields ? data.fields : {};
  const order = data && Array.isArray(data.order) ? data.order : Object.keys(f);
  const themeKey = THEMES[f.theme] ? String(f.theme) : DEFAULT_THEME;
  const accent = THEMES[themeKey];
  const title = f.title ? String(f.title) : '';

  let rows = '';
  for (const k of order) {
    if (k === 'title' || k === 'theme' || k === '__notes' || k === 'iframe' || k === 'html') continue;
    const val = f[k];
    const v = Array.isArray(val) ? val.join(' ') : String(val);
    rows += `<div class="dz-row"><span class="dz-k">${escapeHtml(k)}</span><span class="dz-v">${escapeHtml(v)}</span></div>`;
  }

  // 备注/独白：解析层有两条来源，这里都必须接住，否则内容会被静默吞掉——
  //   ① 卡片里的「裸文本行」→ parseCardBody 归入 __notes（数组）；
  //   ② AI 显式写的「__notes=...」字段行 → 走字段分支，是字符串。
  // （修复历史 bug：此前只认数组，弱模型一旦显式写 __notes=… 整段独白就消失。）
  let notes = '';
  const notesText = Array.isArray(f.__notes)
    ? f.__notes.join('\n')
    : (f.__notes == null ? '' : String(f.__notes));
  if (notesText) {
    notes = `<div class="dz-notes">${escapeHtml(notesText).replace(/\n/g, '<br>\n')}</div>`;
  }

  let extra = '';
  // 可选 html 字段：受控富文本（有 DOMPurify 才渲染，否则转义兜底）
  if (settings && settings.allowHtml && f.html != null) {
    extra += `<div class="dz-html">${sanitizeHtmlField(f.html)}</div>`;
  }
  // 可选 iframe 字段：仅 http/https，沙箱隔离
  if (settings && settings.allowIframe && f.iframe != null) {
    const src = safeIframeSrc(f.iframe);
    if (src) {
      extra += `<iframe class="dz-iframe" src="${escapeHtml(src)}" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`;
    }
  }

  return `<div class="dz-card dz-theme-${escapeHtml(themeKey)}" style="--dz-accent:${escapeHtml(accent)}">`
    + `<div class="dz-title">${escapeHtml(title)}</div>`
    + `<div class="dz-body">${rows}${notes}${extra}</div>`
    + `</div>`;
}

// 外部容错钩子：允许 M6 等注入自定义渲染策略（特性检测）
let customRenderer = null;
export function setCustomCardRenderer(fn) { customRenderer = (typeof fn === 'function') ? fn : null; }

/**
 * 把一条消息原始文本渲染为最终 HTML。
 * @param {string} rawText 消息原始文本（纯文本，不含已渲染卡片）
 * @param {object} [settings] 扩展设置（allowHtml / allowIframe 等）
 * @returns {{ html: (string|null), changed: boolean, cards: object[] }}
 */
export function renderMessage(rawText, settings = {}) {
  const { segments, cards } = parseCards(rawText, { repair: true });
  if (!cards.length) {
    return { html: null, changed: false, cards: [] };
  }

  let html = '';
  for (const seg of segments) {
    if (seg.type === 'text') {
      // 正文：转义后保留换行
      html += escapeHtml(seg.value).replace(/\n/g, '<br>\n');
    } else {
      try {
        html += (customRenderer ? customRenderer(seg.data, settings) : renderCardHtml(seg.data, settings));
      } catch (e) {
        // 单卡失败 → 降级为该卡原始文本（转义），绝不显示半成品/裸代码
        html += `<div class="dz-card dz-error">${escapeHtml(seg.value)}</div>`;
      }
    }
  }
  return { html, changed: true, cards };
}

/**
 * 生成一个适配 M2 增量管线的消息处理器。
 * @param {object} [settings] 扩展设置（enabled / allowHtml / allowIframe 等）；会读取其最新值，支持运行期开关
 * @returns {Function} processor({ mesEl, textEl, rawHtml })
 */
export function makeProcessor(settings = {}) {
  return function messageProcessor({ mesEl, textEl }) {
    if (!textEl) return;
    // 运行期开关：禁用时直接跳过（不美化新消息）
    if (settings && settings.enabled === false) return;
    // 优先从 dataset.dzOrig 拿“原始文本”，避免重复解析我们自己的渲染产物（支持设置变更后重新美化）
    const store = (mesEl && mesEl.dataset) ? mesEl : textEl;
    const rawText = (store.dataset && store.dataset.dzOrig != null)
      ? store.dataset.dzOrig
      : (textEl.textContent || '');
    const result = renderMessage(rawText, settings);
    if (result.changed && typeof result.html === 'string') {
      store.dataset.dzOrig = rawText; // 存原始文本，便于重新美化 / 还原
      textEl.innerHTML = result.html;
    }
  };
}
