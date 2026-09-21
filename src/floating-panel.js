// src/floating-panel.js — M9：岛民名册悬浮窗骨架
//
// 职责（本轮只搭骨架，三块标签页的“内容”分别留给 M10 名册 / M11+M12 美化 / M13 绑定）：
//   1. 挂载一个 position:fixed 的悬浮窗 #dz-navigator，可拖拽（指针事件，鼠标+触摸通用），
//      位置持久化到本扩展设置里（settings.navigator.pos），刷新/重开酒馆后回到原位；
//   2. 往聊天输入框的原生按钮栏注入一个「📒 名册」开关按钮：优先 #leftSendForm（左侧，
//      ☰ 汉堡菜单 / 🪄 魔法棒 等原生按钮所在处，与它们并列），降级 #rightSendForm（右侧），
//      再降级为右下角迷你浮动按钮，功能不变；
//   3. 提供 名册 / 美化 / 绑定 三个标签页壳，并对外暴露 getPane(name) 供后续模块填内容。
//
// 设计约束（沿用 v1 硬指标）：
//   - 跨版本一律特性检测，缺 #leftSendForm / #rightSendForm / document / window 等就安全降级，绝不抛错；
//   - 纯逻辑（位置夹取、默认状态合并）抽成不依赖 DOM 的函数，可用 node 单测；
//   - 不引外部库，拖拽用原生 Pointer Events 手写。

const DISPLAY_NAME = '岛主历险记';

// 三块标签页（顺序即展示顺序；data-tab 值供后续模块定位）
export const TAB_ORDER = ['roster', 'beautify', 'binding'];
export const TAB_LABELS = { roster: '名册', beautify: '美化', binding: '绑定' };

const PANEL_ID = 'dz-navigator';
const TOGGLE_ID = 'dz-nav-toggle';
const DEFAULT_TAB = 'roster';
const EDGE_MARGIN = 8; // 距视口边缘最小间距

// ---- 纯函数：把已保存的 navigator 状态与默认值安全合并 ----
export function defaultNavigatorState(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    open: s.open === true,
    tab: TAB_ORDER.includes(s.tab) ? s.tab : DEFAULT_TAB,
    // pos 为 null 时由挂载逻辑按视口计算默认位置
    pos: (s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y))
      ? { x: s.pos.x, y: s.pos.y }
      : null,
    // 是否在聊天输入框右侧显示「📒 名册」按钮（关闭后仍可由设置面板临时打开）
    showButton: s.showButton !== false,
  };
}

// ---- 纯函数：按优先级挑选「📒 名册」按钮的挂载容器 ----
// 候选顺序（对齐 SillyTavern 原生布局，参考其它成熟插件的落位习惯）：
//   1. #leftSendForm  —— 左侧原生按钮栏（☰ 汉堡菜单 / 🪄 魔法棒 / 引导生成等原生按钮所在处），首选；
//   2. #rightSendForm —— 右侧（发送按钮所在区），仅在左侧栏不存在时降级使用。
// 返回 {el, sel}；都拿不到则返回 {el:null, sel:null}（调用方再降级为浮动迷你钮）。
export function pickToggleHost(doc) {
  const CANDIDATES = ['#leftSendForm', '#rightSendForm'];
  for (const sel of CANDIDATES) {
    try {
      const el = (doc && typeof doc.querySelector === 'function') ? doc.querySelector(sel) : null;
      if (el) return { el, sel };
    } catch (_) { /* 忽略：该选择器不可用，试下一个 */ }
  }
  return { el: null, sel: null };
}

// ---- 纯函数：把面板位置夹到视口内，避免被边缘裁掉 ----
// pos: {x,y}（期望左上角）；size: {w,h}（面板尺寸）；vp: {w,h}（视口尺寸）
export function computeClampedPosition(pos, size, vp, margin = EDGE_MARGIN) {
  const px = Number.isFinite(pos.x) ? pos.x : margin;
  const py = Number.isFinite(pos.y) ? pos.y : margin;
  const w = Number.isFinite(size.w) ? size.w : 320;
  const h = Number.isFinite(size.h) ? size.h : 240;
  const vw = Math.max(vp.w, w + margin * 2);
  const vh = Math.max(vp.h, h + margin * 2);
  const maxX = vw - w - margin;
  const maxY = vh - h - margin;
  return {
    x: Math.min(Math.max(px, margin), maxX),
    y: Math.min(Math.max(py, margin), maxY),
  };
}

// ---- 模块级引用（供 getPane / togglePanel 等对外函数使用）----
let panelEl = null;
let toggleEl = null;
let navState = null;
let persist = () => {};

// 懒初始化 navigator 子状态（不依赖 index.js 的 defaultSettings，保持模块自洽）
function getNavState(settings) {
  if (!settings || typeof settings !== 'object') return defaultNavigatorState(null);
  if (!settings.navigator || typeof settings.navigator !== 'object') {
    settings.navigator = defaultNavigatorState(settings.navigator);
  }
  // 二次合并，保证字段齐全
  const merged = defaultNavigatorState(settings.navigator);
  settings.navigator = merged;
  return merged;
}

// 取某标签页的内容容器（供 M10/M11/M13 填充）
export function getPane(name) {
  if (!panelEl) return null;
  return panelEl.querySelector(`.dz-nav-pane[data-pane="${name}"]`);
}

// 切换标签页（同步到状态并持久化）
function setActiveTab(name) {
  if (!panelEl || !TAB_ORDER.includes(name)) return;
  navState.tab = name;
  panelEl.querySelectorAll('.dz-nav-tab').forEach((b) => {
    b.classList.toggle('dz-nav-active', b.dataset.tab === name);
    b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false');
  });
  panelEl.querySelectorAll('.dz-nav-pane').forEach((p) => {
    p.hidden = p.dataset.pane !== name;
  });
  persist();
}

// 显示/隐藏面板（force 为真则强制显示，为假强制隐藏；不传则翻转）
export function togglePanel(force) {
  if (!panelEl) return;
  const want = (typeof force === 'boolean') ? force : !navState.open;
  navState.open = want;
  panelEl.hidden = !want;
  if (toggleEl) {
    toggleEl.classList.toggle('dz-nav-on', want);
    toggleEl.setAttribute('aria-pressed', want ? 'true' : 'false');
  }
  persist();
}

// 拖拽：用 Pointer Events 统一鼠标/触摸；点按钮不触发拖拽
function enableDrag(header) {
  let dragging = false;
  let startX = 0, startY = 0, baseX = 0, baseY = 0;

  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // 点标题栏上的按钮不拖拽
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panelEl.getBoundingClientRect();
    baseX = rect.left;
    baseY = rect.top;
    header.setPointerCapture && header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  header.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const x = baseX + (e.clientX - startX);
    const y = baseY + (e.clientY - startY);
    const size = { w: panelEl.offsetWidth, h: panelEl.offsetHeight };
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const clamped = computeClampedPosition({ x, y }, size, vp);
    panelEl.style.left = `${clamped.x}px`;
    panelEl.style.top = `${clamped.y}px`;
    panelEl.style.right = 'auto';
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    // 落点后持久化位置
    navState.pos = { x: panelEl.offsetLeft, y: panelEl.offsetTop };
    persist();
    header.releasePointerCapture && e.pointerId != null && header.releasePointerCapture(e.pointerId);
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
}

// 把开关塞进魔法棒（🪄 #extensionsMenu）菜单列表本体，而不是发送栏旁边——
// 用户明确要求「必须在点开魔法棒之后那一长列里面」，不要出现在外面。
// 挂法参考酒馆官方 Objective 扩展：优先找专属容器，没有就直接挂到 #extensionsMenu 本体，
// 用它原生的 list-group-item + extensionsMenuExtensionButton 结构，样式完全原生。
// 只有连 #extensionsMenu 都找不到（极老/魔改前端）才退回 pickToggleHost 的原生栏，
// 再退无可退才是右下角浮动钮——保证任何版本下都至少有一个入口，不会彻底消失。
function injectToggleButton() {
  // M15-A：显式去重（兼容重载/多次调用），且绝不改写容器现有子节点或样式
  if (toggleEl || (typeof document !== 'undefined' && document.getElementById(TOGGLE_ID))) return;

  const onToggle = () => togglePanel();

  let mounted = false;
  let btn = null;

  // ① 首选：魔法棒菜单本体
  try {
    const wandContainer =
      document.getElementById('dz_wand_container') ||
      document.getElementById('extensionsMenu');
    if (wandContainer) {
      btn = document.createElement('div');
      btn.id = TOGGLE_ID;
      btn.className = 'list-group-item flex-container flexGap5 dz-nav-toggle';
      btn.title = '打开/关闭 岛民名册';
      btn.tabIndex = 0;
      btn.innerHTML = '<div class="extensionsMenuExtensionButton fa-solid fa-address-book"></div>岛民名册';
      btn.setAttribute('aria-pressed', navState.open ? 'true' : 'false');
      if (navState.open) btn.classList.add('dz-nav-on');
      btn.addEventListener('click', onToggle);
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
      });
      wandContainer.appendChild(btn);
      mounted = true;
    }
  } catch (_) { /* 忽略，走降级 */ }

  // ② 找不到魔法棒菜单才退回原生发送栏（老版本/魔改前端兼容）
  if (!mounted) {
    try {
      const host = pickToggleHost(document);
      if (host.el) {
        btn = document.createElement('button');
        btn.id = TOGGLE_ID;
        btn.type = 'button';
        btn.className = 'dz-nav-toggle';
        btn.title = '打开/关闭 岛民名册';
        btn.textContent = '📒 名册';
        btn.setAttribute('aria-pressed', navState.open ? 'true' : 'false');
        if (navState.open) btn.classList.add('dz-nav-on');
        btn.addEventListener('click', onToggle);
        host.el.appendChild(btn);
        btn.dataset.host = host.sel;
        mounted = true;
      }
    } catch (_) { /* 忽略，走降级 */ }
  }

  // ③ 都拿不到：右下角迷你浮动钮
  if (!mounted) {
    btn = document.createElement('div');
    btn.id = TOGGLE_ID;
    btn.className = 'dz-nav-toggle dz-nav-toggle-float';
    btn.title = '打开/关闭 岛民名册';
    btn.tabIndex = 0;
    btn.innerHTML = '<i class="fa-solid fa-address-book"></i>';
    btn.setAttribute('aria-pressed', navState.open ? 'true' : 'false');
    if (navState.open) btn.classList.add('dz-nav-on');
    btn.addEventListener('click', onToggle);
    if (typeof document.body !== 'undefined') document.body.appendChild(btn);
  }

  if (navState.showButton === false) btn.style.display = 'none'; // 配置关闭则默认隐藏（仍可经 setToggleButtonVisible 恢复）
  toggleEl = btn;
}

// 构建悬浮窗 DOM（空壳 + 三标签页），内容由后续模块填充
function buildPanel() {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'dz-nav';
  panel.hidden = !navState.open;

  const tabsHtml = TAB_ORDER.map((t) =>
    `<button type="button" class="dz-nav-tab${t === navState.tab ? ' dz-nav-active' : ''}" data-tab="${t}" aria-selected="${t === navState.tab}">${TAB_LABELS[t]}</button>`
  ).join('');

  const panesHtml = TAB_ORDER.map((t) =>
    `<div class="dz-nav-pane" data-pane="${t}"${t === navState.tab ? '' : ' hidden'}></div>`
  ).join('');

  panel.innerHTML = `
    <div class="dz-nav-header" data-drag-handle>
      <span class="dz-nav-title">📒 岛民名册</span>
      <div class="dz-nav-tabs">${tabsHtml}</div>
      <button type="button" class="dz-nav-close" title="关闭">✕</button>
    </div>
    <div class="dz-nav-body">${panesHtml}</div>
  `;

  // 标签切换
  panel.querySelectorAll('.dz-nav-tab').forEach((b) => {
    b.addEventListener('click', () => setActiveTab(b.dataset.tab));
  });
  // 关闭按钮
  panel.querySelector('.dz-nav-close').addEventListener('click', () => togglePanel(false));

  return panel;
}

// 应用位置：有保存则用之，否则按视口给个默认右下（留边距）
function applyPosition() {
  if (!panelEl || typeof window === 'undefined') return;
  const vp = { w: window.innerWidth, h: window.innerHeight };
  let pos = navState.pos;
  if (!pos) {
    // 先按默认尺寸估算（CSS 有固定宽，高度取一个保守值），再夹到视口
    pos = computeClampedPosition(
      { x: vp.w - 360 - 24, y: 80 },
      { w: 360, h: 420 },
      vp
    );
  }
  const size = { w: panelEl.offsetWidth || 360, h: panelEl.offsetHeight || 420 };
  const clamped = computeClampedPosition(pos, size, vp);
  panelEl.style.left = `${clamped.x}px`;
  panelEl.style.top = `${clamped.y}px`;
  panelEl.style.right = 'auto';
}

// ---- 主入口：在 onReady 中调用 ----
export function attachFloatingPanel(ctx, settings) {
  try {
    if (typeof document === 'undefined') return; // 非浏览器环境（如 node 单测）直接退出
    if (document.getElementById(PANEL_ID)) return; // 已挂载则跳过，防重复

    navState = getNavState(settings);
    persist = (ctx && typeof ctx.saveSettingsDebounced === 'function')
      ? () => { try { ctx.saveSettingsDebounced(); } catch (_) {} }
      : () => {};

    panelEl = buildPanel();
    document.body.appendChild(panelEl);

    // 应用已存位置（需要在挂到 DOM 后才能测到尺寸）
    applyPosition();

    // 拖拽（标题栏）
    const header = panelEl.querySelector('.dz-nav-header');
    if (header) enableDrag(header);

    // 注入开关按钮（聊天框右侧，或降级迷你钮）
    injectToggleButton();

    // 视口变化时重新夹取，避免面板被挤出屏外
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        if (panelEl && !panelEl.hidden) applyPosition();
      });
    }

    console.log(`[${DISPLAY_NAME}] 岛民名册悬浮窗已挂载（拖拽 + 位置记忆 + 三标签页壳）。`);
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 挂载悬浮窗失败（已捕获，不影响美化）：`, e);
  }
}

// 显示/隐藏聊天框右侧的「📒 名册」按钮（供设置面板“显示按钮”开关调用）
export function setToggleButtonVisible(visible) {
  try {
    if (toggleEl) toggleEl.style.display = visible ? '' : 'none';
  } catch (_) { /* ignore */ }
}

// 资源清理（可选，供未来统一卸载调用）
export function destroyFloatingPanel() {
  try {
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    if (toggleEl && toggleEl.parentNode) toggleEl.parentNode.removeChild(toggleEl);
    panelEl = null;
    toggleEl = null;
  } catch (_) { /* ignore */ }
}
