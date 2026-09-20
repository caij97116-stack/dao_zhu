// src/navigator-roster.js — M10：岛民名册 · 名册区内容
//
// 职责（在 M9 的 #dz-navigator 的 roster 标签页里填空）：
//   1. 列表 + 搜索（名字/标签/世界）+ 排序 + 收藏星标 + 标签/世界筛选；
//   2. 点角色行 → 一键切身份（openCharacterChat），解决“切身份麻烦”；
//   3. 世界视图：按“世界书”和“标签”双维度分组，把关联卡显式聚到一起，
//      解决“卡多找不到 / 世界多找不到适配卡 / 链接的卡脚本找不着”。
//
// 设计约束（沿用 v1 硬指标）：
//   - 纯逻辑（toRowView / groupRows）抽成不依赖 DOM 的函数，可 node 单测；
//   - 列表渲染 O(n) 一次；上千角色也不卡（渲染上限 MAX_RENDER + 筛选/搜索收敛）；
//   - 跨版本特性检测：缺 openCharacterChat / writeExtensionField 就安全降级，绝不抛错；
//   - 头像 src 由我们拼接并 encodeURIComponent，无外部注入风险。

import { escapeHtml } from './util.js';
import { debounce } from './util.js';
import { getPane } from './floating-panel.js';
import {
  refreshCharacterCache,
  getCharacterCache,
  filterCharacters,
  sortCharacters,
  groupByWorld,
  groupByTags,
  getWorldNames,
  getTagNames,
  NO_WORLD,
  NO_TAG,
} from './navigator-data.js';

const DISPLAY_NAME = '岛主历险记';
const MAX_RENDER = 200;            // 单次渲染上限，超出提示用搜索收敛（保不卡）
const LABEL_NO_WORLD = '未关联世界书';
const LABEL_NO_TAG = '无标签';

// ---- 模块级状态（单例，多次调用只刷新不重建）----
let ctxRef = null;
let built = false;
const opts = { query: '', sort: 'name', mode: 'list', world: '', tag: '', favOnly: false };

// ---- 纯函数：把元数据映射成一行展示视图（不依赖 DOM）----
export function toRowView(meta) {
  const name = (meta && meta.name) ? meta.name : '(无名角色)';
  const initial = (name && name !== '(无名角色)') ? name[0].toUpperCase() : '?';
  const avatar = (meta && meta.avatar) ? `user/avatars/${encodeURIComponent(meta.avatar)}` : '';
  return {
    chid: (meta && typeof meta.chid === 'number') ? meta.chid : -1,
    name,
    initial,
    avatar,
    fav: !!(meta && meta.fav),
    tags: (meta && Array.isArray(meta.tags)) ? meta.tags : [],
    world: (meta && meta.world) ? meta.world : '',
  };
}

// ---- 纯函数：把行按视图模式分组（list 不分组；world/tag 双维度）----
export function groupRows(rows, mode) {
  if (mode === 'world') {
    return mapToGroups(groupByWorld(rows || []), NO_WORLD, LABEL_NO_WORLD);
  }
  if (mode === 'tag') {
    return mapToGroups(groupByTags(rows || []), NO_TAG, LABEL_NO_TAG);
  }
  return [{ key: '__all__', label: '', rows: rows || [] }];
}

function mapToGroups(map, specialKey, specialLabel) {
  const out = [];
  for (const [key, rows] of map.entries()) {
    out.push({ key, label: key === specialKey ? specialLabel : key, rows });
  }
  out.sort((a, b) => {
    if (a.key === specialKey) return 1;
    if (b.key === specialKey) return -1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

// ---- 单行的 HTML（头像/名字/世界徽标/标签/收藏星标；全部 escape）----
function rowHtml(r, activeChid) {
  const avatarInner = r.avatar
    ? `${escapeHtml(r.initial)}<img class="dz-ros-img" src="${r.avatar}" alt="" onerror="this.remove()">`
    : escapeHtml(r.initial);
  const worldBadge = r.world ? `<span class="dz-ros-world">${escapeHtml(r.world)}</span>` : '';
  const tagsHtml = (r.tags || []).slice(0, 4)
    .map((t) => `<span class="dz-ros-tag">${escapeHtml(t)}</span>`).join('');
  const favCls = r.fav ? ' dz-ros-fav-on' : '';
  const activeCls = (r.chid === activeChid) ? ' dz-ros-active' : '';
  return `<div class="dz-ros-row${activeCls}" data-chid="${r.chid}">
    <span class="dz-ros-av">${avatarInner}</span>
    <div class="dz-ros-main">
      <div class="dz-ros-name">${escapeHtml(r.name)}</div>
      <div class="dz-ros-meta">${worldBadge}${tagsHtml}</div>
    </div>
    <button type="button" class="dz-ros-fav${favCls}" data-fav="${r.chid}" title="收藏">${r.fav ? '★' : '☆'}</button>
  </div>`;
}

// ---- 重新渲染列表（读取缓存 → 筛选/排序/分组 → 渲染 + 上限）----
function rerender() {
  const pane = getPane('roster');
  if (!pane) return;
  const list = pane.querySelector('#dz-roster-list');
  if (!list) return;

  const chars = getCharacterCache();
  let rows = filterCharacters(chars, {
    query: opts.query, tag: opts.tag, world: opts.world, favOnly: opts.favOnly,
  });
  rows = sortCharacters(rows, opts.sort);
  const viewRows = rows.map(toRowView);
  const groups = groupRows(viewRows, opts.mode);

  let html = '';
  let rendered = 0;
  for (const g of groups) {
    if (opts.mode !== 'list') {
      html += `<div class="dz-ros-group">${escapeHtml(g.label)} <span class="dz-ros-count">${g.rows.length}</span></div>`;
    }
    for (const r of g.rows) {
      if (rendered >= MAX_RENDER) break;
      html += rowHtml(r, currentChid());
      rendered++;
    }
    if (rendered >= MAX_RENDER) break;
  }

  if (rows.length > MAX_RENDER) {
    html += `<div class="dz-ros-more">仅显示前 ${MAX_RENDER} 个，请搜索/筛选缩小范围（共 ${rows.length} 个）</div>`;
  }
  if (!rows.length) {
    html = `<div class="dz-ros-empty">没有匹配的角色</div>`;
  }
  list.innerHTML = html;
}

function currentChid() {
  return (ctxRef && typeof ctxRef.characterId === 'number') ? ctxRef.characterId : -1;
}

// ---- 切角色（特性检测，安全降级）----
function switchTo(chid) {
  try {
    if (ctxRef && typeof ctxRef.openCharacterChat === 'function') {
      ctxRef.openCharacterChat(chid);
    } else if (ctxRef && typeof ctxRef.selectCharacterById === 'function') {
      ctxRef.selectCharacterById(chid);
    } else {
      console.warn(`[${DISPLAY_NAME}] 当前酒馆版本不支持程序切换角色（缺 openCharacterChat），请手动切换。`);
    }
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 切换角色失败（已捕获）：`, e);
  }
}

// ---- 收藏切换（写角色卡 extensions.fav，缺 API 则仅本次会话生效）----
async function toggleFav(chid, newVal) {
  const cache = getCharacterCache();
  const m = cache.find((c) => c.chid === chid);
  if (m) m.fav = newVal; // 即时反馈
  try {
    if (ctxRef && typeof ctxRef.writeExtensionField === 'function') {
      await ctxRef.writeExtensionField(chid, 'fav', newVal);
    }
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 写入收藏失败（已捕获）：`, e);
  }
  rerender();
}

// ---- 填充筛选下拉（世界/标签来自全量缓存，不受当前筛选影响）----
function populateFilters(pane) {
  const worldSel = pane.querySelector('#dz-ros-world');
  const tagSel = pane.querySelector('#dz-ros-tag');
  if (worldSel) {
    const names = getWorldNames(getCharacterCache());
    const cur = opts.world;
    worldSel.innerHTML = `<option value="">全部世界</option>` +
      names.map((w) => `<option value="${escapeHtml(w)}"${w === cur ? ' selected' : ''}>${escapeHtml(w)}</option>`).join('');
  }
  if (tagSel) {
    const names = getTagNames(getCharacterCache());
    const cur = opts.tag;
    tagSel.innerHTML = `<option value="">全部标签</option>` +
      names.map((t) => `<option value="${escapeHtml(t)}"${t === cur ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
  }
}

// ---- 构建工具栏（仅一次），并绑定事件 ----
function buildToolbar(pane) {
  pane.innerHTML = `
    <div class="dz-ros-toolbar">
      <input type="search" id="dz-ros-search" class="dz-ros-search" placeholder="搜索 名字 / 标签 / 世界">
      <div class="dz-ros-row2">
        <select id="dz-ros-sort" title="排序">
          <option value="name">按名字</option>
          <option value="fav">收藏优先</option>
          <option value="recent">最近聊天</option>
          <option value="mostChats">聊天最多</option>
        </select>
        <select id="dz-ros-view" title="视图">
          <option value="list">列表</option>
          <option value="world">按世界书</option>
          <option value="tag">按标签</option>
        </select>
        <label class="dz-ros-favonly"><input type="checkbox" id="dz-ros-favonly"> 仅收藏</label>
      </div>
      <div class="dz-ros-row2">
        <select id="dz-ros-world" title="世界筛选"></select>
        <select id="dz-ros-tag" title="标签筛选"></select>
      </div>
    </div>
    <div id="dz-roster-list" class="dz-ros-list"></div>
  `;

  const search = pane.querySelector('#dz-ros-search');
  const sort = pane.querySelector('#dz-ros-sort');
  const view = pane.querySelector('#dz-ros-view');
  const favOnly = pane.querySelector('#dz-ros-favonly');
  const worldSel = pane.querySelector('#dz-ros-world');
  const tagSel = pane.querySelector('#dz-ros-tag');
  const list = pane.querySelector('#dz-roster-list');

  const onSearch = debounce(() => { opts.query = search.value || ''; rerender(); }, 120);
  search.addEventListener('input', onSearch);
  sort.addEventListener('change', () => { opts.sort = sort.value; rerender(); });
  view.addEventListener('change', () => { opts.mode = view.value; rerender(); });
  favOnly.addEventListener('change', () => { opts.favOnly = favOnly.checked; rerender(); });
  worldSel.addEventListener('change', () => { opts.world = worldSel.value; rerender(); });
  tagSel.addEventListener('change', () => { opts.tag = tagSel.value; rerender(); });

  // 事件委托：点星标收藏；点行切角色
  list.addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      const chid = Number(favBtn.dataset.fav);
      const on = favBtn.classList.contains('dz-ros-fav-on');
      toggleFav(chid, !on);
      return;
    }
    const row = e.target.closest('[data-chid]');
    if (row) {
      const chid = Number(row.dataset.chid);
      if (Number.isFinite(chid)) switchTo(chid);
    }
  });

  // 同步控件初始值
  search.value = opts.query;
  sort.value = opts.sort;
  view.value = opts.mode;
  favOnly.checked = opts.favOnly;
}

// ---- 主入口：在 onReady 中调用（M9 之后）----
export function renderRosterPane(ctx, settings) {
  try {
    if (typeof document === 'undefined') return;
    const pane = getPane('roster');
    if (!pane) return; // 悬浮窗未挂载则跳过

    ctxRef = ctx;

    // 跨版本兜底：缺角色数据则提示，不抛错（不影响自动美化）
    if (!ctx || !Array.isArray(ctx.characters)) {
      pane.innerHTML = '<p class="dz-hint">未检测到角色数据，名册功能在当前酒馆版本暂不可用（不影响自动美化）。</p>';
      return;
    }

    if (!built) {
      buildToolbar(pane);
      built = true;
      // 角色/聊天变化 → 刷新缓存并重渲染
      const eventSource = (ctx && ctx.eventSource) || globalThis.eventSource || null;
      const event_types = globalThis.event_types || (ctx && ctx.event_types) || null;
      if (eventSource && event_types && event_types.CHAT_CHANGED !== undefined) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
          refreshCharacterCache(ctxRef);
          populateFilters(pane);
          rerender();
        });
      }
    }

    refreshCharacterCache(ctx);
    populateFilters(pane);
    rerender();
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 渲染名册区失败（已捕获，不影响美化）：`, e);
  }
}
