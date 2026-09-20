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
import { attachPhoneBar, setPhoneBarVisible, refreshPhoneBar } from './src/phone-scripts-bar.js';
import { initPhoneEditor, openPhoneEditor } from './src/phone-scripts-editor.js';
import { initPhoneRunner } from './src/phone-scripts-runner.js';
import { defaultPhoneScriptsState } from './src/phone-scripts-data.js';
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
  // —— M6 抗弱模型格式指令：内置自动注入（默认开；关掉则退回「手动复制」模式）——
  builtinFormatInstruction: true,
  // —— M17 界面皮肤：cinder(拼贴墨) / paper(拼贴纸，跟随主题) / classic(旧版简洁) ——
  skin: DEFAULT_SKIN,
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
// 结构对齐 SillyTavern 原生扩展（酒馆助手 / 鸡尾酒 等）的可折叠抽屉：
// 用原生 inline-drawer 系列类保证外观一致，但折叠行为由本扩展自己处理
// （刻意不使用 .inline-drawer-toggle，避免与酒馆自带的事件委托重复绑定导致「点一下开又关」）。
export function buildSkinOptionsHtml(selected) {
  const cur = normalizeSkin(selected);
  return Object.keys(SKINS).map((k) => {
    const s = SKINS[k];
    const sel = (k === cur) ? ' selected' : '';
    return `<option value="${escapeHtml(s.id)}"${sel}>${escapeHtml(s.label)}</option>`;
  }).join('');
}

export function buildSettingsHtml() {
  return `
<div class="dz-settings-block inline-drawer">
  <div class="dz-settings-header inline-drawer-header" id="dz-settings-header" role="button" tabindex="0" aria-expanded="false" title="点击展开 / 折叠设置">
    <b>📖 ${escapeHtml(DISPLAY_NAME)}</b>
    <span class="dz-settings-chevron inline-drawer-icon fa-solid fa-circle-chevron-down"></span>
  </div>
  <div class="dz-settings-content" id="dz-settings-content" hidden>

    <h4 class="dz-settings-sub">🎨 界面皮肤</h4>
    <label class="dz-row-set">皮肤
      <select id="dz-skin" class="dz-input">${buildSkinOptionsHtml('cinder')}</select>
    </label>
    <p class="dz-hint" id="dz-skin-hint">${escapeHtml(SKINS[DEFAULT_SKIN].hint)}</p>

    <label class="dz-row-set"><input type="checkbox" id="dz-enabled"> 启用自动美化（关闭后还原为原始文本）</label>
    <label class="dz-row-set"><input type="checkbox" id="dz-allow-html"> 允许卡片内 html 富文本字段（有 DOMPurify 才渲染，否则自动转义）</label>
    <label class="dz-row-set"><input type="checkbox" id="dz-allow-iframe"> 允许卡片内 iframe 字段（仅 http/https，沙箱隔离）</label>
    <button type="button" id="dz-rebeautify" class="dz-btn">用当前设置重新美化当前聊天</button>

    <h4 class="dz-settings-sub">岛民名册悬浮窗（名册 / 美化 / 绑定）</h4>
    <label class="dz-row-set"><input type="checkbox" id="dz-nav-showbtn"> 在聊天输入框原生按钮栏显示「📒 名册」按钮（关闭后可在下方临时打开）</label>
    <button type="button" id="dz-nav-open" class="dz-btn">打开岛民名册悬浮窗</button>

    <h4 class="dz-settings-sub">抗弱模型 · 格式指令（已内置自动注入，无需复制）</h4>
    <p class="dz-hint">${escapeHtml(FORMAT_INSTRUCTION_HINT)}</p>
    <label class="dz-row-set"><input type="checkbox" id="dz-builtin-instr"> 自动内置注入格式指令（关掉则退回「手动复制」模式）</label>
    <button type="button" id="dz-instr-toggle" class="dz-btn">查看 / 隐藏 指令原文</button>
    <textarea id="dz-instruction" class="dz-instruction" readonly rows="12" hidden>${FORMAT_INSTRUCTION}</textarea>
    <button type="button" id="dz-copy-instruction" class="dz-btn">复制格式指令（手动备用）</button>

    <h4 class="dz-settings-sub">📱 小手机工坊（底部模板 / AI 帮写）</h4>
    <label class="dz-row-set"><input type="checkbox" id="dz-phone-showbar"> 显示小手机模板条（聊天输入框上方，点「⚙ 管理」开工坊）</label>
    <button type="button" id="dz-phone-open" class="dz-btn">📱 打开小手机工坊（新建 / 编辑 / AI 帮写）</button>
    <p class="dz-hint">AI 帮写后端：勾选「启用自有 API」并填好三项即用自有 API；否则走酒馆同连接（无需自带 key）。</p>
    <label class="dz-row-set"><input type="checkbox" id="dz-phone-ownapi"> 启用自有 OpenAI 兼容 API</label>
    <label class="dz-row-set">Base URL <input type="text" id="dz-phone-baseurl" class="dz-input" placeholder="https://api.openai.com/v1" /></label>
    <label class="dz-row-set">API Key <input type="password" id="dz-phone-apikey" class="dz-input" placeholder="sk-…（留空则用酒馆同连接）" /></label>
    <label class="dz-row-set">模型 <input type="text" id="dz-phone-model" class="dz-input" placeholder="gpt-4o-mini" /></label>

  </div>
</div>`;
}

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

// ---- 确保 settings.phoneScripts 子状态存在（设置面板要读写它，即使底条暂未挂载）----
function ensurePhoneState(settings) {
  if (!settings.phoneScripts || typeof settings.phoneScripts !== 'object') {
    settings.phoneScripts = defaultPhoneScriptsState();
  }
  const ps = settings.phoneScripts;
  if (!ps.ownApi || typeof ps.ownApi !== 'object') {
    ps.ownApi = { enabled: false, baseUrl: '', apiKey: '', model: '' };
  }
  return ps;
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
  const builtinInstr = root.querySelector('#dz-builtin-instr');
  const instrToggle = root.querySelector('#dz-instr-toggle');
  const instrArea = root.querySelector('#dz-instruction');
  const header = root.querySelector('#dz-settings-header');
  const content = root.querySelector('#dz-settings-content');
  const phoneShow = root.querySelector('#dz-phone-showbar');
  const phoneOpen = root.querySelector('#dz-phone-open');
  const phoneOwn = root.querySelector('#dz-phone-ownapi');
  const phoneBase = root.querySelector('#dz-phone-baseurl');
  const phoneKey = root.querySelector('#dz-phone-apikey');
  const phoneModel = root.querySelector('#dz-phone-model');
  const skinSel = root.querySelector('#dz-skin');
  const skinHint = root.querySelector('#dz-skin-hint');

  // ---- 折叠抽屉：点击标题栏 / 回车 / 空格 均可展开折叠（默认折叠，与原生扩展一致）----
  const setExpanded = (expanded) => {
    if (!header || !content) return;
    content.hidden = !expanded;
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const chev = header.querySelector('.dz-settings-chevron');
    if (chev) chev.style.transform = expanded ? 'rotate(180deg)' : '';
  };
  if (header) {
    header.addEventListener('click', () => setExpanded(content ? content.hidden : true));
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(content ? content.hidden : true); }
    });
  }

  // ---- 小手机工坊：确保 settings.phoneScripts 存在（底条未挂载时也能安全配置）----
  const phoneState = ensurePhoneState(settings);

  // ---- M17 界面皮肤：只换 <html> 上的类，纯 CSS 生效，无需重渲染消息 ----
  const curSkin = normalizeSkin(settings.skin);
  settings.skin = curSkin; // 脏数据（如乱填的字符串）就地归一化，避免下次又回落
  if (skinSel) skinSel.value = curSkin;
  if (skinHint) skinHint.textContent = SKINS[curSkin].hint;
  if (skinSel) skinSel.addEventListener('change', () => {
    settings.skin = normalizeSkin(skinSel.value);
    save();
    try { applySkin(settings.skin); } catch (_) {}
    if (skinHint) skinHint.textContent = SKINS[settings.skin].hint;
  });

  // 用已保存设置初始化勾选状态
  if (en) en.checked = settings.enabled !== false;
  if (ah) ah.checked = !!settings.allowHtml;
  if (ai) ai.checked = !!settings.allowIframe;
  if (builtinInstr) builtinInstr.checked = settings.builtinFormatInstruction !== false;
  if (navShow) navShow.checked = !(settings.navigator && settings.navigator.showButton === false);
  if (phoneShow) phoneShow.checked = phoneState.showBar !== false;
  if (phoneOwn) phoneOwn.checked = !!(phoneState.ownApi && phoneState.ownApi.enabled);
  if (phoneBase) phoneBase.value = (phoneState.ownApi && phoneState.ownApi.baseUrl) || '';
  if (phoneKey) phoneKey.value = (phoneState.ownApi && phoneState.ownApi.apiKey) || '';
  if (phoneModel) phoneModel.value = (phoneState.ownApi && phoneState.ownApi.model) || '';

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

  // 岛民名册开关：显示/隐藏聊天输入框原生按钮栏里的按钮（关闭后仍可用下方按钮临时打开）
  if (navShow) navShow.addEventListener('change', () => {
    if (!settings.navigator || typeof settings.navigator !== 'object') settings.navigator = {};
    settings.navigator.showButton = navShow.checked;
    save();
    try { setToggleButtonVisible(navShow.checked); } catch (_) {}
  });
  if (navOpen) navOpen.addEventListener('click', () => {
    try { togglePanel(true); } catch (_) {}
  });

  // 内置格式指令开关：默认开（自动注入）；关掉则退回手动复制模式
  if (builtinInstr) builtinInstr.addEventListener('change', () => {
    settings.builtinFormatInstruction = builtinInstr.checked;
    save();
    // 开启时：若此前未注册（例如启动时特性检测未通过），这里补注册一次
    if (builtinInstr.checked) {
      try { registerBuiltinFormatInstruction(ctx, settings); } catch (_) {}
    }
  });

  // 指令原文：默认收起（已内置注入，无需常驻占版面），点按钮查看/隐藏
  if (instrToggle && instrArea) {
    instrToggle.addEventListener('click', () => {
      instrArea.hidden = !instrArea.hidden;
      instrToggle.textContent = instrArea.hidden ? '查看 / 隐藏 指令原文' : '收起指令原文';
    });
  }

  // ---- 小手机工坊 ----
  // 显示/隐藏底部模板条
  if (phoneShow) phoneShow.addEventListener('change', () => {
    phoneState.showBar = phoneShow.checked;
    save();
    try { setPhoneBarVisible(phoneShow.checked); } catch (_) {}
  });
  // 打开全屏工坊（新建 / 编辑 / AI 帮写 / 导入导出）
  if (phoneOpen) phoneOpen.addEventListener('click', () => {
    try { openPhoneEditor(ctx, settings, null); } catch (_) {}
  });
  // 自有 OpenAI 兼容 API 三项（勾选启用后才生效）
  const onOwnApiChange = () => {
    phoneState.ownApi = {
      enabled: phoneOwn ? phoneOwn.checked : false,
      baseUrl: phoneBase ? phoneBase.value.trim() : '',
      apiKey: phoneKey ? phoneKey.value : '',
      model: phoneModel ? phoneModel.value.trim() : '',
    };
    save();
  };
  if (phoneOwn) phoneOwn.addEventListener('change', onOwnApiChange);
  if (phoneBase) phoneBase.addEventListener('change', onOwnApiChange);
  if (phoneKey) phoneKey.addEventListener('change', onOwnApiChange);
  if (phoneModel) phoneModel.addEventListener('change', onOwnApiChange);

  if (reBtn) reBtn.addEventListener('click', () => {
    if (settings.enabled !== false) reprocessAll(); else restoreAll();
    try { refreshPhoneBar(); } catch (_) {}
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

// ---- M6 内置抗弱模型格式指令：自动注入聊天系统提示（特性检测 + 安全降级）----
// 设计要点（对应用户诉求「要内置、不要我们手动复制」）：
//   1. 默认开启（settings.builtinFormatInstruction !== false），无需用户把指令粘进预设/角色卡；
//   2. 全程特性检测：只在拿到 eventSource 与 CHAT_COMPLETION_PROMPT 事件时才注册，
//      旧版本没有该事件就静默跳过（面板仍可手动复制做备用），绝不抛错、绝不改用户预设文件；
//   3. 注入动作包 try/catch：任何异常都不影响消息正常发送。
export function registerBuiltinFormatInstruction(ctx, settings) {
  if (!settings || settings.builtinFormatInstruction === false) return; // 用户关掉了 → 手动模式
  const eventSource = (ctx && ctx.eventSource) || globalThis.eventSource || null;
  const event_types = globalThis.event_types || (ctx && ctx.event_types) || null;
  const ev = event_types && event_types.CHAT_COMPLETION_PROMPT;
  if (!eventSource || !ev || typeof eventSource.on !== 'function') return; // 特性检测失败 → 安全降级

  eventSource.on(ev, (prompt) => {
    try {
      if (!Array.isArray(prompt) || prompt.length === 0) return;
      // 优先追加到已有 system 消息；没有则插到最前面一条 system
      const sys = prompt.find((m) => m && m.role === 'system');
      if (sys) {
        sys.content = (sys.content || '') + '\n\n' + FORMAT_INSTRUCTION;
      } else {
        prompt.unshift({ role: 'system', content: FORMAT_INSTRUCTION });
      }
    } catch (_) { /* 忽略：绝不影响消息发送 */ }
  });
}

// ---- 应用就绪后执行（M2+ 在这里挂载渲染管线与设置面板）----
function onReady(ctx) {
  const settings = getSettings(ctx);
  console.log(`[${DISPLAY_NAME}] 初始化完成，挂载渲染管线与设置面板…`);

  // ===== M2：增量渲染核心（MutationObserver + 防抖 + 去重 + 清理）=====
  attachIncrementalRenderer(ctx);

  // ===== M5：注册消息处理器（repair → parse → render 经 M2 增量管线逐楼调用）=====
  // settings 来自 getSettings(ctx) 的同一对象引用：面板改动会即时反映到处理器（运行期开关）
  const processor = makeProcessor(settings);
  registerMessageProcessor(processor);

  // ===== M6：挂载设置面板（启用开关 / 允许 HTML·iframe / 格式指令内置状态）=====
  mountSettingsPanel(ctx, settings);

  // ===== M17：应用界面皮肤（拼贴美学；纯 CSS，切换无需重渲染）=====
  try { applySkin(settings.skin); } catch (_) {}

  // ===== M6：内置抗弱模型格式指令 —— 自动注入聊天系统提示（默认开，无需手动复制）=====
  registerBuiltinFormatInstruction(ctx, settings);

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
// 防御式检测 jQuery：酒馆环境必存在，故行为等同「自启动原版」；node 单测环境无 jQuery 时安全跳过。
if (typeof jQuery !== 'undefined') {
  jQuery(async () => {
    await init();
  });
}
