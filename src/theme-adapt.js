// src/theme-adapt.js — M11：整体美化自适应（响应式基线层 + 设备/主题检测 + 自定义补丁）
//
// 背景（用户的痛点）：有些酒馆「美化 / 主题」只适配 PC 或只适配手机，
//   在另一端会布局崩坏（固定宽溢出、按钮挤飞、侧栏撑爆、图片超宽）。
//
// 本模块做法（已在技术边界里和你对齐）：
//   - 注入一套稳健的「响应式基线层」：只修布局崩坏（固定宽改流体、补断点、面板可滚动、
//     图片/代码限宽），尊重主题自带的 --SmartTheme* 颜色变量，绝不覆盖配色；
//   - 设备/主题检测：自动嗅探当前是桌面还是手机（也可手动指定目标），据此切换基线策略；
//   - 自定义补丁框：极少数结构特殊的主题，由你手动贴 CSS 补漏（我们的安全逃生口）。
//
// 设计约束（沿用 v1 硬指标）：
//   - 纯逻辑（状态合并 / 设备检测 / 基线 CSS 生成）抽成函数，可 node 单测；
//   - 跨版本特性检测：缺 matchMedia / document 就安全降级；
//   - 仅在用户开启时把 <style> 挂到文档，关闭即移除，零残留。

import { escapeHtml } from './util.js';
import { getPane } from './floating-panel.js';

const DISPLAY_NAME = '岛主历险记';
const ADAPT_STYLE_ID = 'dz-theme-adapt';
const PATCH_STYLE_ID = 'dz-theme-patch';

// ---- 响应式基线层 CSS（只动布局，不碰 color/background，保留主题原貌）----
// 仅在 html[data-dz-theme-adapt="on"] 时生效；手机策略同时挂在
//   @media (max-width:820px) 与 html[data-dz-device="mobile"] 上。
const MOBILE_FIXES = `
  #sheld { width: 100% !important; max-width: 100% !important; left: 0 !important; right: 0 !important; margin: 0 !important; }
  #chat { padding-left: 8px !important; padding-right: 8px !important; }
  #send_form { flex-wrap: wrap !important; }
  #leftSendForm, #rightSendForm { flex-wrap: wrap !important; justify-content: flex-start !important; }
  .mes { margin-left: 0 !important; margin-right: 0 !important; }
`;

export const BASELINE_CSS = `
/* 岛主历险记 · 整体美化自适应基线层（仅启用时生效，只修布局不碰配色） */
html[data-dz-theme-adapt="on"] .mes_text { overflow-wrap: anywhere; word-break: break-word; }
html[data-dz-theme-adapt="on"] .mes img,
html[data-dz-theme-adapt="on"] .mes_text img,
html[data-dz-theme-adapt="on"] .mes video { max-width: 100% !important; height: auto; }
html[data-dz-theme-adapt="on"] pre,
html[data-dz-theme-adapt="on"] code,
html[data-dz-theme-adapt="on"] .code-block,
html[data-dz-theme-adapt="on"] .hljs { max-width: 100%; overflow-x: auto; }
html[data-dz-theme-adapt="on"] .drawer,
html[data-dz-theme-adapt="on"] .drawer-content,
html[data-dz-theme-adapt="on"] .popup { max-height: 92vh !important; overflow-y: auto !important; }

/* 手机端布局修复（针对 PC-only 美化在窄屏崩坏） */
@media (max-width: 820px) {
  html[data-dz-theme-adapt="on"] ${MOBILE_FIXES}
}

/* 强制按手机布局（针对 mobile-only 美化在桌面崩坏） */
html[data-dz-device="mobile"][data-dz-theme-adapt="on"] ${MOBILE_FIXES}
`;

// ---- 纯函数：安全合并 themeAdapt 状态 ----
export function defaultThemeAdaptState(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const targetOk = (s.target === 'desktop' || s.target === 'mobile' || s.target === 'auto');
  return {
    enabled: s.enabled === true,
    target: targetOk ? s.target : 'auto',
    patch: typeof s.patch === 'string' ? s.patch : '',
  };
}

// ---- 纯函数：设备检测（手动 target 优先；否则运行时嗅探）----
export function detectDevice(state) {
  if (state && state.target === 'desktop') return 'desktop';
  if (state && state.target === 'mobile') return 'mobile';
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const narrow = window.matchMedia('(max-width: 820px)').matches;
      const touch = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window));
      return (narrow && touch) ? 'mobile' : 'desktop';
    }
  } catch (_) { /* ignore */ }
  return 'desktop';
}

// ---- 模块级引用 ----
let ctxRef = null;
let built = false;

function getState(settings) {
  if (!settings || typeof settings !== 'object') return defaultThemeAdaptState(null);
  if (!settings.themeAdapt || typeof settings.themeAdapt !== 'object') {
    settings.themeAdapt = defaultThemeAdaptState(settings.themeAdapt);
  }
  const merged = defaultThemeAdaptState(settings.themeAdapt);
  settings.themeAdapt = merged;
  return merged;
}

function persist() {
  if (ctxRef && typeof ctxRef.saveSettingsDebounced === 'function') {
    try { ctxRef.saveSettingsDebounced(); } catch (_) {}
  }
}

// ---- 应用 / 移除 基线层 + 自定义补丁 ----
function applyThemeAdapt(settings) {
  try {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const state = getState(settings);

    let styleEl = document.getElementById(ADAPT_STYLE_ID);
    let patchEl = document.getElementById(PATCH_STYLE_ID);

    if (!state.enabled) {
      // 关闭：移除样式与数据属性，零残留
      if (styleEl) styleEl.remove();
      if (patchEl) patchEl.remove();
      delete root.dataset.dzThemeAdapt;
      delete root.dataset.dzDevice;
      return;
    }

    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = ADAPT_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = BASELINE_CSS;

    // 自定义补丁（用户自己的 CSS，按原样注入；不执行、不 eval）
    if (!patchEl) {
      patchEl = document.createElement('style');
      patchEl.id = PATCH_STYLE_ID;
      document.head.appendChild(patchEl);
    }
    patchEl.textContent = state.patch || '';

    root.dataset.dzThemeAdapt = 'on';
    root.dataset.dzDevice = detectDevice(state);
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 应用整体美化自适应失败（已捕获）：`, e);
  }
}

// ---- 构建「美化」标签页内容（M11 整体自适应 + M12 卡片自适应的壳）----
function buildBeautifyPane(pane) {
  pane.innerHTML = `
    <div class="dz-beauty-section">
      <h4 class="dz-beauty-h">整体美化自适应</h4>
      <label class="dz-row-set"><input type="checkbox" id="dz-adapt-enable"> 启用（修复 PC/手机偏科的主题布局崩坏）</label>
      <div class="dz-ros-row2">
        <select id="dz-adapt-target" title="目标设备">
          <option value="auto">自动检测</option>
          <option value="desktop">按桌面布局</option>
          <option value="mobile">按手机布局</option>
        </select>
        <button type="button" id="dz-adapt-detect" class="dz-btn">检测并适配</button>
      </div>
      <p class="dz-hint">说明：仅修正布局（流体宽、断点、面板可滚动、图片/代码限宽），不改动主题配色。
        对极少数结构特殊的美化，请用下方「自定义补丁」手动补漏。</p>
      <label class="dz-row-set">自定义补丁（CSS，按需填写）</label>
      <textarea id="dz-adapt-patch" class="dz-instruction" rows="6" placeholder="/* 例如： #sheld { max-width: 1000px !important; } */"></textarea>
      <button type="button" id="dz-adapt-apply-patch" class="dz-btn">应用自定义补丁</button>
    </div>
    <div class="dz-beauty-section" id="dz-beautify-regex"></div>
  `;

  const enable = pane.querySelector('#dz-adapt-enable');
  const target = pane.querySelector('#dz-adapt-target');
  const detectBtn = pane.querySelector('#dz-adapt-detect');
  const patch = pane.querySelector('#dz-adapt-patch');
  const applyPatch = pane.querySelector('#dz-adapt-apply-patch');

  enable.addEventListener('change', () => updateState({ enabled: enable.checked }));
  target.addEventListener('change', () => updateState({ target: target.value }));
  detectBtn.addEventListener('click', () => { applyThemeAdapt(currentSettings); });
  applyPatch.addEventListener('click', () => updateState({ patch: patch.value }));

  // 暴露初始值填充入口
  pane._fillValues = (state) => {
    enable.checked = state.enabled;
    target.value = state.target;
    patch.value = state.patch;
  };
}

// 持有当前 settings 引用，供事件回调更新
let currentSettings = null;

// 更新某字段并即时应用 + 持久化
function updateState(patchObj) {
  if (!currentSettings) return;
  const state = getState(currentSettings);
  Object.assign(state, patchObj);
  applyThemeAdapt(currentSettings);
  persist();
}

// ---- 主入口：在 onReady 中调用（M10 之后）----
export function renderBeautifyPane(ctx, settings) {
  try {
    if (typeof document === 'undefined') return;
    const pane = getPane('beautify');
    if (!pane) return;

    ctxRef = ctx;
    currentSettings = settings;
    const state = getState(settings);

    if (!built) {
      buildBeautifyPane(pane);
      built = true;
    }
    // 填充初始控件值
    if (pane._fillValues) pane._fillValues(state);

    // 首次按已存设置应用一次（开关状态即时生效，无需用户再点）
    applyThemeAdapt(settings);
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 渲染美化区失败（已捕获，不影响美化）：`, e);
  }
}
