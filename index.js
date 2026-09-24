// index.js — 岛主历险记 入口
//
// 设计原则（对应需求三：跨版本兼容 1.17 ~ 1.19+）：
//   1. 全程“特性检测”（判断函数/属性是否存在），绝不写死版本号；
//   2. 任何 API 缺失都“安全降级”（no-op 或不激活），绝不抛错导致酒馆崩溃；
//   3. manifest.json 里 minimum_client_version 只设下限（1.17.0）、不设上限。
//
// 职责拆分：
//   M1 入口/启动/设置  → 本文件
//   M2 增量渲染核心    → src/incremental.js
//   M3 格式校验+修复   → src/repair.js   （已实现）
//   M4 模糊正则+兜底   → src/transform.js（已实现）
//   M5 渲染+iframe+容错 → src/renderer.js （已实现）
//   M6 设置面板+内置指令 → 本文件（mountSettingsPanel / 复制指令）

import { cloneObj, escapeHtml } from './src/util.js';
import {
  attachIncrementalRenderer,
  registerMessageProcessor,
  reprocessAll,
  restoreAll,
} from './src/incremental.js';
import { makeProcessor } from './src/renderer.js';
import { FORMAT_INSTRUCTION, FORMAT_INSTRUCTION_HINT } from './src/instruction.js';
import { attachFloatingPanel, togglePanel, setToggleButtonVisible } from './src/floating-panel.js';
import { renderRosterPane } from './src/navigator-roster.js';
import { renderBeautifyPane } from './src/theme-adapt.js';
import { renderCardAdaptPane } from './src/card-adapt.js';
import { renderBindingPane } from './src/binding.js';
import { attachPhoneBar, setPhoneBarVisible } from './src/phone-scripts-bar.js';
import { openStoryDigest } from './src/story-digest.js';
import { initPhoneEditor } from './src/phone-scripts-editor.js';
import { initPhoneRunner } from './src/phone-scripts-runner.js';
import { SKINS, DEFAULT_SKIN, normalizeSkin, applySkin } from './src/skin.js';

const MODULE_NAME = 'dao-zhu';
const DISPLAY_NAME = '岛主历险记';
const SETTINGS_KEY = MODULE_NAME;

// ---- 默认设置（后续模块会扩展；allowHtml/allowIframe 对应 M5 渲染层开关）----
// 嵌套的 navigator / themeAdapt 由 M9 / M11 各自用 default*State 兜底合并，
// 这里列入仅作“ schema 完整 + 升级补齐 + 文档化”之用（深拷贝避免与冻结默认值共享引用）。
export const defaultSettings = Object.freeze({
  enabled: true,      // 是否启用自动美化
  allowHtml: false,   // 是否允许卡片内 html 富文本字段（需酒馆内置 DOMPurify，否则自动转义兜底）
  allowIframe: false, // 是否允许卡片内 iframe 字段（仅 http/https，沙箱隔离）
  cardSkin: DEFAULT_SKIN, // 卡片/悬浮窗视觉皮肤：见 src/skin.js 的 SKINS 定义（classic | cinder | paper）
  // —— 岛民名册悬浮窗（M9+）——
  navigator: {
    open: false,      // 悬浮窗是否默认展开
    tab: 'roster',    // 默认标签页 roster / beautify / binding
    pos: null,        // 拖拽位置 {x,y}（null = 由视口给默认）
    showButton: true, // 是否在聊天输入框右侧显示「📒 名册」按钮
  },
  // —— 整体美化自适应（M11）——
  themeAdapt: {
    enabled: false,   // 是否注入响应式基线层
    target: 'auto',   // auto | desktop | mobile
    patch: '',        // 自定义补丁 CSS
  },
});

// ---- 获取 ST 全局对象（特性检测，兼容 1.17+ 的 globalThis.SillyTavern）----
function getSillyTavern() {
  try {
    if (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function') {
      return SillyTavern;
    }
  } catch (_) { /* 忽略：SillyTavern 未定义 */ }
  try {
    if (globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function') {
      return globalThis.SillyTavern;
    }
  } catch (_) { /* 忽略 */ }
  return null;
}

// ---- 安全读取 / 初始化本扩展设置（缺 extensionSettings 时退回内存对象）----
const memSettings = {}; // 仅在极端缺失时的兜底
export function getSettings(ctx) {
  const ext = ctx && ctx.extensionSettings;
  if (ext && typeof ext === 'object') {
    if (!ext[SETTINGS_KEY]) ext[SETTINGS_KEY] = cloneObj(defaultSettings);
    // 升级兼容：补齐新增的默认键（嵌套对象须深拷贝，避免与冻结的默认值共享引用）
    for (const k of Object.keys(defaultSettings)) {
      if (!Object.prototype.hasOwnProperty.call(ext[SETTINGS_KEY], k)) {
        const def = defaultSettings[k];
        ext[SETTINGS_KEY][k] = (def && typeof def === 'object') ? cloneObj(def) : def;
      }
    }
    return ext[SETTINGS_KEY];
  }
  if (!memSettings[SETTINGS_KEY]) memSettings[SETTINGS_KEY] = cloneObj(defaultSettings);
  return memSettings[SETTINGS_KEY];
}

// ---- 复制文本（优先 Clipboard API，缺失时退回 execCommand 兜底）----
function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
  } catch (_) { /* 退回兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch (_) {
    return Promise.reject(new Error('copy-failed'));
  }
}

// ---- 设置面板 HTML（静态可信内容，无需 DOMPurify）----
function buildSettingsHtml() {
  return `
<div class="dz-settings-block inline-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>${escapeHtml(DISPLAY_NAME)}</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">
    <label class="dz-row-set"><input type="checkbox" id="dz-enabled"> 启用自动美化（关闭后还原为原始文本）</label>
    <label class="dz-row-set"><input type="checkbox" id="dz-allow-html"> 允许卡片内 html 富文本字段（有 DOMPurify 才渲染，否则自动转义）</label>
    <label class="dz-row-set"><input type="checkbox" id="dz-allow-iframe"> 允许卡片内 iframe 字段（仅 http/https，沙箱隔离）</label>
    <button type="button" id="dz-rebeautify" class="dz-btn">用当前设置重新美化当前聊天</button>

    <h4 class="dz-settings-sub">卡片与悬浮窗皮肤</h4>
    <label class="dz-row-set">
      视觉皮肤：
      <select id="dz-card-skin" class="dz-input">
        ${Object.values(SKINS).map((s) => `<option value="${escapeHtml(s.id)}" title="${escapeHtml(s.hint)}">${escapeHtml(s.label)}</option>`).join('')}
      </select>
    </label>
    <p class="dz-hint">切换皮肤即时生效，无需重新美化或刷新。</p>

    <h4 class="dz-settings-sub">岛民名册悬浮窗（M9+：导航 / 美化 / 绑定）</h4>
    <label class="dz-row-set"><input type="checkbox" id="dz-nav-showbtn"> 在魔法棒（🪄）菜单里显示「岛民名册」入口（关闭后可在下方临时打开）</label>
    <button type="button" id="dz-nav-open" class="dz-btn">打开岛民名册悬浮窗</button>

    <h4 class="dz-settings-sub">小手机工坊（M16+：聊天底部模板条）</h4>
    <label class="dz-row-set"><input type="checkbox" id="dz-phone-showbar"> 在聊天底部显示小手机工坊模板条（如果之前被关掉过，这里能重新打开）</label>

    <h4 class="dz-settings-sub">故事摘要页（M26：把整段聊天里的卡片汇总成一页）</h4>
    <button type="button" id="dz-digest-open" class="dz-btn">打开故事摘要页</button>

    <h4 class="dz-settings-sub">抗弱模型 · 格式指令（复制到你的预设 / 角色卡）</h4>
    <p class="dz-hint">${escapeHtml(FORMAT_INSTRUCTION_HINT)}</p>
    <textarea id="dz-instruction" class="dz-instruction" readonly rows="16">${FORMAT_INSTRUCTION}</textarea>
    <button type="button" id="dz-copy-instruction" class="dz-btn">复制格式指令</button>
  </div>
</div>`;
}

// ---- 应用卡片/悬浮窗视觉皮肤：只切 <html> 上的类，纯 CSS 生效，不需要重渲染消息 ----
// ---- 把设置面板挂到扩展设置容器（特性检测容器 ID，失败重试几次）----
let panelMountRetries = 0;
function mountSettingsPanel(ctx, settings) {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById('dz-settings-panel')) return; // 已挂载，避免重复

    const container =
      document.querySelector('#extensions_settings2') ||
      document.querySelector('#extensions_settings');
    if (!container) {
      // 容器可能尚未就绪（不同版本时序不同），稍后重试，最多约 3 秒
      if (panelMountRetries < 30) {
        panelMountRetries++;
        setTimeout(() => mountSettingsPanel(ctx, settings), 100);
      } else {
        console.warn(`[${DISPLAY_NAME}] 未找到扩展设置容器，设置面板未挂载（美化仍正常工作）。`);
      }
      return;
    }

    const wrap = document.createElement('div');
    wrap.id = 'dz-settings-panel';
    wrap.innerHTML = buildSettingsHtml();
    container.appendChild(wrap);
    wireSettingsEvents(wrap, ctx, settings);
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 挂载设置面板失败（已捕获，不影响美化）：`, e);
  }
}

// ---- 绑定设置面板交互 ----
function wireSettingsEvents(root, ctx, settings) {
  const save = (ctx && typeof ctx.saveSettingsDebounced === 'function')
    ? () => { try { ctx.saveSettingsDebounced(); } catch (_) {} }
    : () => {};

  const en = root.querySelector('#dz-enabled');
  const ah = root.querySelector('#dz-allow-html');
  const ai = root.querySelector('#dz-allow-iframe');
  const reBtn = root.querySelector('#dz-rebeautify');
  const copyBtn = root.querySelector('#dz-copy-instruction');
  const navShow = root.querySelector('#dz-nav-showbtn');
  const navOpen = root.querySelector('#dz-nav-open');
  const digestOpen = root.querySelector('#dz-digest-open');
  const skinSel = root.querySelector('#dz-card-skin');
  const phoneShowBar = root.querySelector('#dz-phone-showbar');

  // 用已保存设置初始化勾选状态
  if (en) en.checked = settings.enabled !== false;
  if (ah) ah.checked = !!settings.allowHtml;
  if (ai) ai.checked = !!settings.allowIframe;
  if (navShow) navShow.checked = !(settings.navigator && settings.navigator.showButton === false);
  if (skinSel) skinSel.value = normalizeSkin(settings.cardSkin);
  if (phoneShowBar) phoneShowBar.checked = !(settings.phoneScripts && settings.phoneScripts.showBar === false);

  if (en) en.addEventListener('change', () => {
    settings.enabled = en.checked;
    save();
    // 运行期启停：开启则按当前设置重新美化，关闭则还原原始文本
    if (settings.enabled) reprocessAll(); else restoreAll();
  });

  const onFieldToggle = () => {
    settings.allowHtml = ah ? ah.checked : false;
    settings.allowIframe = ai ? ai.checked : false;
    save();
    if (settings.enabled !== false) reprocessAll(); // 即时应用到当前聊天
  };
  if (ah) ah.addEventListener('change', onFieldToggle);
  if (ai) ai.addEventListener('change', onFieldToggle);

  // 岛民名册开关：显示/隐藏聊天框右侧按钮（关闭后仍可用下方按钮临时打开）
  if (navShow) navShow.addEventListener('change', () => {
    if (!settings.navigator || typeof settings.navigator !== 'object') settings.navigator = {};
    settings.navigator.showButton = navShow.checked;
    save();
    try { setToggleButtonVisible(navShow.checked); } catch (_) {}
  });
  if (navOpen) navOpen.addEventListener('click', () => {
    try { togglePanel(true); } catch (_) {}
  });
  if (digestOpen) digestOpen.addEventListener('click', () => {
    try { openStoryDigest(ctx, settings); } catch (_) {}
  });

  if (skinSel) skinSel.addEventListener('change', () => {
    settings.cardSkin = normalizeSkin(skinSel.value);
    save();
    applySkin(settings.cardSkin);
  });

  if (phoneShowBar) phoneShowBar.addEventListener('change', () => {
    setPhoneBarVisible(phoneShowBar.checked); // 内部会自己 persist，不需要再调用 save()
  });

  if (reBtn) reBtn.addEventListener('click', () => {
    if (settings.enabled !== false) reprocessAll(); else restoreAll();
  });

  if (copyBtn) copyBtn.addEventListener('click', () => {
    copyText(FORMAT_INSTRUCTION).then(() => {
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { copyBtn.textContent = '复制格式指令'; }, 1500);
    }).catch(() => {
      copyBtn.textContent = '复制失败，请手动选择';
      setTimeout(() => { copyBtn.textContent = '复制格式指令'; }, 2000);
    });
  });
}

// ---- 应用就绪后执行（M2+ 在这里挂载渲染管线与设置面板）----
function onReady(ctx) {
  const settings = getSettings(ctx);
  console.log(`[${DISPLAY_NAME}] 初始化完成，挂载渲染管线与设置面板…`);

  // ===== M19：应用已保存的卡片/悬浮窗皮肤（要放在任何卡片渲染之前）=====
  applySkin(settings.cardSkin);

  // ===== M2：增量渲染核心（MutationObserver + 防抖 + 去重 + 清理）=====
  attachIncrementalRenderer(ctx);

  // ===== M5：注册消息处理器（repair → parse → render 经 M2 增量管线逐楼调用）=====
  // settings 来自 getSettings(ctx) 的同一对象引用：面板改动会即时反映到处理器（运行期开关）
  const processor = makeProcessor(settings);
  registerMessageProcessor(processor);

  // ===== M6：挂载设置面板（启用开关 / 允许 HTML·iframe / 内置指令复制）=====
  mountSettingsPanel(ctx, settings);

  // ===== M9：挂载「岛民名册」悬浮窗（拖拽 + 位置记忆 + 三标签页壳；内容由 M10~M13 填充）=====
  attachFloatingPanel(ctx, settings);

  // ===== M10：填充悬浮窗「名册」标签页（搜索/排序/收藏/筛选 + 一键切身份 + 世界/标签分组）=====
  renderRosterPane(ctx, settings);

  // ===== M11：填充悬浮窗「美化」标签页（整体美化自适应基线层 + 设备检测 + 自定义补丁）=====
  renderBeautifyPane(ctx, settings);

  // ===== M12：填充「美化」标签页的「卡片美化自适应」区（检查并重渲染全部卡片）=====
  renderCardAdaptPane(ctx, settings);

  // ===== M13：填充「绑定」标签页（角色 ↔ 世界书 手动绑定/解绑 + 当前绑定列表）=====
  renderBindingPane(ctx, settings);

  // ===== M16-B：挂载「小手机工坊」底部模板条（独立底条 + 三作用域聚合；编辑器/运行器由 M16-C/D 注册）=====
  attachPhoneBar(ctx, settings);

  // ===== M16-C：注册「小手机工坊」全屏编辑器（点底部条「⚙ 管理」打开；运行器由 M16-D 注册）=====
  initPhoneEditor(ctx, settings);

  // ===== M16-D：注册「小手机工坊」运行器（底部条按钮 / 编辑器「试跑」统一走这里）=====
  initPhoneRunner(ctx, settings);

  console.log(`[${DISPLAY_NAME}] 美化处理器已注册（repair→parse→render，逐楼增量美化）。`);
}

// ---- 主入口：SillyTavern 启动时调用（export 供扩展加载器调用）----
export async function init() {
  try {
    const ST = getSillyTavern();
    if (!ST) {
      // 沙箱/非酒馆环境：安全退出，不影响宿主
      console.warn(`[${DISPLAY_NAME}] 未检测到 SillyTavern 全局对象，扩展未激活（不影响酒馆运行）。`);
      return;
    }

    const ctx = ST.getContext();
    if (!ctx) {
      console.warn(`[${DISPLAY_NAME}] getContext() 返回空，扩展未激活。`);
      return;
    }

    // 特性检测事件系统（不同版本 event_types 可能挂在 globalThis 或 ctx 上）
    const eventSource = (ctx && ctx.eventSource) || globalThis.eventSource || null;
    const event_types = globalThis.event_types || (ctx && ctx.event_types) || null;

    getSettings(ctx); // 确保设置已初始化

    if (eventSource && event_types && event_types.APP_READY !== undefined) {
      // APP_READY：应用完全就绪后触发，新监听器挂载后会自动补发一次
      eventSource.on(event_types.APP_READY, () => onReady(ctx));
    } else {
      // 旧版本 / 无事件系统：降级到 DOM 就绪后执行
      if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => onReady(ctx));
      } else {
        onReady(ctx);
      }
    }

    console.log(`[${DISPLAY_NAME}] 入口已加载（版本无关启动成功）。`);
  } catch (e) {
    // 任何意外都不应连累酒馆主程序
    console.error(`[${DISPLAY_NAME}] 初始化异常（已捕获，不影响酒馆）：`, e);
  }
}

// ---- 第三方扩展自启动（酒馆只会 import() 本模块，不会主动调用导出的 init，需要自己触发）----
jQuery(async () => {
  await init();
});
