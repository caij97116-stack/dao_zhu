// src/navigator-data.js — M8 数据层（纯函数，不依赖 SillyTavern，可 node 单测）
//
// 职责：把 SillyTavern 的 characters 数组，提炼成「岛民名册」悬浮窗需要的轻量元数据，
//       并提供分组 / 筛选 / 排序 / 世界书清单等纯函数。
// 设计约束（沿用 v1 硬指标）：
//   - 纯函数：不碰 DOM、不读全局，输入决定输出，便于 node 单测；
//   - O(n) 线性扫描，上千角色也不卡；
//   - 对字段缺失 / 类型异常做防御，绝不抛错（返回安全默认值）。

// 特殊分组键（保证 Map 键唯一，不与真实世界名 / 标签冲突）
export const NO_WORLD = '__no_world__';
export const NO_TAG = '__no_tag__';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从单个角色对象提取元数据（纯函数）。
 * @param {object} character SillyTavern 的 characters[i]
 * @param {number} chid 在 characters 数组中的下标（即 openCharacterChat 用的 id）
 * @returns {object}
 */
export function buildCharacterMeta(character, chid = -1) {
  const c = character && typeof character === 'object' ? character : {};
  const data = c.data && typeof c.data === 'object' ? c.data : {};
  const ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t) => typeof t === 'string' && t.length > 0)
    : [];

  const worldRaw = ext.world;
  const world = typeof worldRaw === 'string' && worldRaw.trim() ? worldRaw.trim() : '';

  const name = typeof c.name === 'string' && c.name.trim()
    ? c.name.trim()
    : (typeof c.ch_name === 'string' && c.ch_name.trim() ? c.ch_name.trim() : '(无名角色)');

  const fav = !!(ext.fav || c.fav);

  return {
    chid: typeof chid === 'number' ? chid : -1,
    name,
    avatar: typeof c.avatar === 'string' ? c.avatar : '',
    fav,
    tags,
    world,
    lastChat: num(c.date_last_chat ?? data.date_last_chat),
    dateAdded: num(c.date_added ?? data.date_added),
    chatSize: num(c.chat_size ?? data.data_size),
  };
}

/**
 * 从 ctx（SillyTavern 上下文）批量提取角色元数据。
 * @param {object} ctx getContext() 返回的对象
 * @returns {object[]}
 */
export function getCharactersWithMeta(ctx) {
  const chars = ctx && Array.isArray(ctx.characters) ? ctx.characters : [];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    out.push(buildCharacterMeta(chars[i], i));
  }
  return out;
}

/** 按关联世界书分组：返回 Map<worldName|NO_WORLD, meta[]> */
export function groupByWorld(chars) {
  const map = new Map();
  if (!Array.isArray(chars)) return map;
  for (const c of chars) {
    const key = c.world ? c.world : NO_WORLD;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return map;
}

/** 按标签分组：一个角色可同时属于多个标签组；无标签归入 NO_TAG */
export function groupByTags(chars) {
  const map = new Map();
  if (!Array.isArray(chars)) return map;
  for (const c of chars) {
    const tags = c.tags && c.tags.length ? c.tags : [NO_TAG];
    for (const t of tags) {
      if (!map.has(t)) map.set(t, []);
      map.get(t).push(c);
    }
  }
  return map;
}

/** 收集所有出现过的世界书名（去重 + 排序） */
export function getWorldNames(chars) {
  const s = new Set();
  for (const c of chars || []) if (c.world) s.add(c.world);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
}

/** 收集所有出现过的标签（去重 + 排序） */
export function getTagNames(chars) {
  const s = new Set();
  for (const c of chars || []) for (const t of (c.tags || [])) s.add(t);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
}

/**
 * 筛选角色。
 * @param {object[]} chars
 * @param {object} opts { query, tag, world, favOnly }
 */
export function filterCharacters(chars, opts = {}) {
  const q = (opts.query || '').toString().trim().toLowerCase();
  const tag = opts.tag || '';
  const world = opts.world || '';
  const favOnly = !!opts.favOnly;
  return (chars || []).filter((c) => {
    if (favOnly && !c.fav) return false;
    if (world && c.world !== world) return false;
    if (tag && !(c.tags || []).includes(tag)) return false;
    if (q) {
      const hay = `${c.name} ${(c.tags || []).join(' ')} ${c.world || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * 排序角色。
 * @param {object[]} chars
 * @param {string} sortBy name | fav | recent | mostChats
 */
export function sortCharacters(chars, sortBy = 'name') {
  const arr = (chars || []).slice();
  switch (sortBy) {
    case 'fav':
      arr.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || a.name.localeCompare(b.name));
      break;
    case 'recent':
      arr.sort((a, b) => (b.lastChat - a.lastChat) || a.name.localeCompare(b.name));
      break;
    case 'mostChats':
      arr.sort((a, b) => (b.chatSize - a.chatSize) || a.name.localeCompare(b.name));
      break;
    case 'name':
    default:
      arr.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return arr;
}

// ---- 轻量缓存：避免每次打开悬浮窗都全量重建（刷新由事件触发）----
let _cache = null;
export function refreshCharacterCache(ctx) {
  _cache = getCharactersWithMeta(ctx);
  return _cache;
}
export function getCharacterCache() {
  return _cache || [];
}
