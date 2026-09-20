// src/skin.js — M17：情绪拼贴皮肤层（把「整页美化稿」改造成扩展可用的皮肤）
//
// 背景：外部给来的是一份「独立整页 HTML 美化稿」（Cinder 色系 + 笔记本打孔 / 胶带 /
// 回形针 / 灰度照片 / 衬线标题 / 噪点质感）。整页稿不能直接塞进酒馆，会出大问题：
//   1. body::before/after 全屏 fixed 覆盖层 → 会盖住整个酒馆聊天区；
//   2. `* { margin:0; padding:0 }` → 重置掉酒馆与所有第三方扩展的排版；
//   3. 写死黑底黑字 → 无视 SillyTavern 主题，亮色主题下直接瞎掉；
//   4. 外链 Unsplash 图片 / Google 字体 → 离线不可用，还有隐私与加载失败问题；
//   5. 展示型 demo 组件（hero / palette / photo-stack）与本扩展的卡片结构对不上。
//
// 所以这里只「翻译它的质感」，不改它的作用域：
//   - 作用域限定在 html 上的皮肤类（`dz-skin-collage` + 具体配色类），
//     所有 CSS 选择器都以 .dz- 元素为终点，**绝不命中酒馆原生 DOM**；
//   - 配色走 CSS 变量：cinder 忠实原稿暗色调，paper 则跟随酒馆主题变量再叠质感；
//   - 只用系统字体与内联 SVG 噪点，零外链；
//   - 皮肤切换只换 class，不需要重渲染消息（纯 CSS 生效），上千楼也不卡。
//
// 设计约束（沿用本扩展一贯硬指标）：
//   - 纯函数（normalizeSkin / skinClassesOf / describeSkin）可在 node 单测；
//   - 特性检测 + try/catch：拿不到 document 或 documentElement 就安全 no-op；
//   - 未知/损坏的皮肤值一律回落默认，绝不因设置脏数据让界面变空白。

// ---- 皮肤定义（id → 元信息）----
// classes：要挂到 <html> 上的类。collage 为「质感通用层」，cinder/paper 为「配色层」，
// 这样质感 CSS 只写一份，配色差异靠变量覆盖，后续加配色不用复制整段样式。
export const SKINS = Object.freeze({
  cinder: Object.freeze({
    id: 'cinder',
    label: '拼贴 · 墨（Cinder 暗色）',
    hint: '忠实美化稿：暗色纸面 + 打孔 / 胶带 / 回形针 / 噪点，最出片。',
    classes: Object.freeze(['dz-skin-collage', 'dz-skin-cinder']),
  }),
  paper: Object.freeze({
    id: 'paper',
    label: '拼贴 · 纸（跟随酒馆主题）',
    hint: '同样的拼贴质感，但底色/文字跟随你当前的酒馆主题，亮色主题也不刺眼。',
    classes: Object.freeze(['dz-skin-collage', 'dz-skin-paper']),
  }),
  classic: Object.freeze({
    id: 'classic',
    label: '经典（旧版简洁）',
    hint: '回到 M16 之前的简洁描边卡片，不加任何质感。',
    classes: Object.freeze([]),
  }),
});

export const DEFAULT_SKIN = 'cinder';

// 所有可能出现过的皮肤类（用于切换时清理，避免旧类残留叠加）
export function allSkinClasses() {
  const set = new Set();
  for (const k of Object.keys(SKINS)) {
    for (const c of SKINS[k].classes) set.add(c);
  }
  return Array.from(set);
}

/**
 * 归一化皮肤值：非法/损坏一律回落默认皮肤。
 * @param {unknown} value
 * @returns {string} 合法皮肤 id
 */
export function normalizeSkin(value) {
  if (typeof value !== 'string') return DEFAULT_SKIN;
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SKINS, key) ? key : DEFAULT_SKIN;
}

/**
 * 取某皮肤要挂到 <html> 上的类名数组。
 * @param {unknown} value
 * @returns {string[]}
 */
export function skinClassesOf(value) {
  return Array.from(SKINS[normalizeSkin(value)].classes);
}

/**
 * 皮肤展示名（设置面板 / 日志用）。
 * @param {unknown} value
 * @returns {string}
 */
export function describeSkin(value) {
  return SKINS[normalizeSkin(value)].label;
}

/**
 * 皮肤说明（设置面板提示用）。
 * @param {unknown} value
 * @returns {string}
 */
export function skinHintOf(value) {
  return SKINS[normalizeSkin(value)].hint;
}

/**
 * 把皮肤应用到文档根节点（只增删 .dz-skin-* 类，不动酒馆任何 DOM）。
 * @param {unknown} value 皮肤 id
 * @param {Document} [doc] 默认 globalThis.document；缺失则安全 no-op
 * @returns {string} 实际生效的皮肤 id
 */
export function applySkin(value, doc) {
  const id = normalizeSkin(value);
  const classes = skinClassesOf(id);
  try {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const root = d && d.documentElement;
    if (!root || typeof root.classList === 'undefined') return id; // 非浏览器环境：安全降级
    for (const c of allSkinClasses()) root.classList.remove(c);
    for (const c of classes) root.classList.add(c);
  } catch (_) { /* 忽略：皮肤失败不应影响任何功能 */ }
  return id;
}
