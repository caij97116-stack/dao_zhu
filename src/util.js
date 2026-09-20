// src/util.js — 纯工具函数（不依赖 SillyTavern，可单独用 node 测试）
// 这些函数在后续模块（M2 增量渲染 / M4 模糊正则 / M5 渲染容错）中复用。

/**
 * 防抖：在最后一次调用后 wait 毫秒才真正执行。
 * 用于把“消息流式涌入”合并成一次渲染，避免每来一个字符就全量处理。
 * @param {Function} fn
 * @param {number} wait 毫秒
 * @returns {Function}
 */
export function debounce(fn, wait = 150) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

/**
 * HTML 转义：把文本安全地放进 innerHTML，防止裸标签被当作代码显示。
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 判断是否为非空字符串（trim 后长度 > 0）。
 * @param {*} v
 * @returns {boolean}
 */
export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 规范化空白：统一换行符为 \n，并把连续空格/制表符合并为一个空格。
 * 这是后续“模糊匹配 / 格式修复”的基础预处理。
 * @param {string} text
 * @returns {string}
 */
export function normalizeWhitespace(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ');
}

/**
 * 深拷贝（JSON 安全版本），用于复制默认设置对象，避免多实例共享引用。
 * @param {*} o
 * @returns {*}
 */
export function cloneObj(o) {
  try {
    return JSON.parse(JSON.stringify(o));
  } catch (_) {
    return {};
  }
}
