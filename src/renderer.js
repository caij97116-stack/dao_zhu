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

// ===== M25：关系图卡片（type=relations）=====
// 独立的字段小语法：nodes=A,B,C  /  edges=A->B:关系,B->C:关系
// 刻意跟主格式一样"多套兜底"——没写 nodes 也没事，edges 里出现过的名字会被自动收进节点；
// 边里引用到没声明过的节点也不会报错，照样画得出来。
const MAX_RELATION_NODES = 12; // 节点太多画不下，也防着弱模型瞎写一长串把卡片撑爆
const EDGE_ARROW_RE = /^\s*(.+?)\s*->\s*(.+?)\s*(?::\s*(.*))?\s*$/; // 优先认箭头，指向明确
const EDGE_DASH_RE = /^\s*(.+?)\s*-\s*(.+?)\s*(?::\s*(.*))?\s*$/;   // 退化：只写了短横线也认

function parseRelationsFields(f) {
  const names = [];
  const nameSet = new Set();
  const addName = (raw) => {
    const name = String(raw == null ? '' : raw).trim();
    if (!name) return null;
    if (!nameSet.has(name)) { nameSet.add(name); names.push(name); }
    return name;
  };

  if (f.nodes != null) {
    String(f.nodes).split(/[,，、;；]/).forEach((s) => addName(s));
  }

  const edges = [];
  if (f.edges != null) {
    String(f.edges).split(/[,，;；]/).forEach((chunk) => {
      const t = chunk.trim();
      if (!t) return;
      const m = EDGE_ARROW_RE.exec(t) || EDGE_DASH_RE.exec(t);
      if (!m) return;
      const from = addName(m[1]);
      const to = addName(m[2]);
      if (!from || !to || from === to) return; // 自环没法画，跳过
      edges.push({ from, to, label: m[3] ? m[3].trim() : '' });
    });
  }

  const truncated = names.length > MAX_RELATION_NODES;
  return { names: names.slice(0, MAX_RELATION_NODES), edges, truncated };
}

// 关系图内容用「圆周均匀布局」——不需要力导向算法，节点一多就绕一圈，够用且稳定可预测
let relCardCounter = 0;
function buildRelationsBody(f) {
  const { names, edges, truncated } = parseRelationsFields(f);

  if (!names.length) {
    // 没有可用节点：不硬画一张空图，退化成一行提示，保持"不留半成品"的一贯风格
    return '<div class="dz-notes">（关系图数据为空或无法识别，请检查 nodes / edges 字段）</div>';
  }

  const cx = 160;
  const cy = 160;
  const r = names.length <= 1 ? 0 : 110;
  const pos = names.map((_, i) => {
    if (names.length === 1) return { x: cx, y: cy };
    const angle = (Math.PI * 2 * i) / names.length - Math.PI / 2;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
  const idOf = new Map(names.map((n, i) => [n, i]));
  const markerId = `dz-rel-arrow-${++relCardCounter}`;

  let edgesSvg = '';
  for (const e of edges) {
    const i = idOf.get(e.from);
    const j = idOf.get(e.to);
    if (i == null || j == null) continue; // 极端兜底：理论上不会发生（above 已保证入 names）
    const a = pos[i];
    const b = pos[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const pad = 14; // 线两端各往里缩一点，别整根线插进节点圆点里
    const x1 = a.x + (dx / len) * pad;
    const y1 = a.y + (dy / len) * pad;
    const x2 = b.x - (dx / len) * pad;
    const y2 = b.y - (dy / len) * pad;
    edgesSvg += `<line class="dz-rel-edge" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" `
      + `x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" marker-end="url(#${markerId})"></line>`;
    if (e.label) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const labelW = Math.min(140, Math.max(28, e.label.length * 10 + 8)); // 中文标签按近似方块字估宽度
      edgesSvg += `<g transform="translate(${mx.toFixed(1)},${my.toFixed(1)})">`
        + `<rect class="dz-rel-edge-label-bg" x="${(-labelW / 2).toFixed(1)}" y="-8" width="${labelW.toFixed(1)}" height="16" rx="4"></rect>`
        + `<text class="dz-rel-edge-label" text-anchor="middle" dy="4">${escapeHtml(e.label)}</text>`
        + `</g>`;
    }
  }

  let nodesSvg = '';
  names.forEach((name, i) => {
    const p = pos[i];
    nodesSvg += `<g class="dz-rel-node">`
      + `<circle class="dz-rel-node-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9"></circle>`
      + `<text class="dz-rel-node-label" x="${p.x.toFixed(1)}" y="${(p.y + 22).toFixed(1)}" text-anchor="middle">${escapeHtml(name)}</text>`
      + `</g>`;
  });

  const svg = `<svg class="dz-rel-graph" viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`
    + `<path class="dz-rel-arrowhead" d="M0,0 L10,5 L0,10 z"></path></marker></defs>`
    + edgesSvg + nodesSvg
    + `</svg>`;

  const hint = truncated
    ? `<div class="dz-hint">角色数量较多，只展示前 ${MAX_RELATION_NODES} 个</div>`
    : '';
  return `<div class="dz-relations">${svg}</div>${hint}`;
}

// 渲染单张卡片为安全 HTML
function renderCardHtml(data, settings) {
  const f = data && data.fields ? data.fields : {};
  const order = data && Array.isArray(data.order) ? data.order : Object.keys(f);
  const themeKey = THEMES[f.theme] ? String(f.theme) : DEFAULT_THEME;
  const accent = THEMES[themeKey];
  const title = f.title ? String(f.title) : '';

  // M25：关系图卡片走独立分支——同一套外层卡片壳(标题/主题色)，body 换成 SVG 关系网
  if (String(f.type || '').trim().toLowerCase() === 'relations') {
    return `<div class="dz-card dz-theme-${escapeHtml(themeKey)} dz-card-relations" style="--dz-accent:${escapeHtml(accent)}">`
      + `<div class="dz-title">${escapeHtml(title)}</div>`
      + `<div class="dz-body">${buildRelationsBody(f)}</div>`
      + `</div>`;
  }

  let rows = '';
  for (const k of order) {
    if (k === 'title' || k === 'theme' || k === 'type' || k === 'nodes' || k === 'edges'
      || k === '__notes' || k === 'iframe' || k === 'html') continue;
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
