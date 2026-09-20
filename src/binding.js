// src/binding.js — M13：绑定工具（角色 ↔ 世界书）
//
// 职责（在 M9 的 #dz-navigator 的 binding 标签页里填空）：
//   1. 手动把“角色 ↔ 世界书”绑定/解绑，写入角色卡权威字段 data.extensions.world；
//      解决用户痛点：“世界书 / 脚本被分开，无法关联到一起”。
//   2. 列出当前绑定状态（已绑定 / 未绑定），可按世界书筛选、可一键解绑。
//
// 设计约束（沿用 v1 硬指标）：
//   - 纯逻辑（buildBindingRow / getBoundRows / getUnboundRows / candidateWorldNames）
//     抽成不依赖 DOM 的函数，可 node 单测；
//   - 列表渲染 O(n) 一次；上千角色也不卡（渲染上限 + 筛选收敛）；
//   - 跨版本特性检测：缺 writeExtensionField / characters 就安全降级，绝不抛错；
//   - 头像 src 由我们拼接并 encodeURIComponent，无外部注入风险。

import { escapeHtml } from './util.js';
import { getPane } from './floating-panel.js';
import {
  refreshCharacterCache,
  getCharacterCache,
  getWorldNames,
} from './navigator-data.js';

const DISPLAY_NAME = '岛主历险记';
const MAX_RENDER = 300;            // 单次渲染上限，超出提示用筛选收敛（保不卡）

// 模块级状态（单例，多次调用只刷新不重建）
let ctxRef = null;
let built = false;
let activeFilter = '';             // '' / 'bound' / 'unbound' / '<worldName>'

// ---- 纯函数：把元数据映射成绑定行视图（不依赖 DOM）----
export function buildBindingRow(meta) {
  const name = (meta && meta.name) ? meta.name : '(无名角色)';
  const initial = (name && name !== '(无名角色)') ? name[0].toUpperCase() : '?';
  const avatar = (meta && meta.avatar) ? `user/avatars/${encodeURIComponent(meta.avatar)}` : '';
  const world = (meta && meta.world) ? meta.world : '';
  return {
    chid: (meta && typeof meta.chid === 'number') ? meta.chid : -1,
    name,
    initial,
    avatar,
    world,
  };
}

// 已绑定（world 非空）的行
export function getBoundRows(chars) {
  return (chars || []).map(buildBindingRow).filter((r) => !!r.world);
}

// 未绑定（world 为空）的行
export function getUnboundRows(chars) {
  return (chars || []).map(buildBindingRow).filter((r) => !r.world);
}

// 候选世界书名：来自现有角色卡的 world 字段，并特性检测补全 ctx.worlds / ctx.worldNames
export function candidateWorldNames(chars, ctx) {
  const set = new Set(getWorldNames(chars || []));
  try {
    const extra = ctx && (ctx.worlds || ctx.worldNames);
    if (Array.isArray(extra)) {
      for (const w of extra) if (typeof w === 'string' && w.trim()) set.add(w.trim());
    }
  } catch (_) { /* 忽略：缺字段就只用工卡里已有的 */ }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// 全部角色（按名字排序），供下拉与列表使用
function allRowsSorted(chars) {
  return (chars || []).map(buildBindingRow).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- 单行 HTML（头像 / 名字 / 世界徽标 / 解绑按钮；全部 escape）----
function rowHtml(r) {
  const avatarInner = r.avatar
    ? `${escapeHtml(r.initial)}<img class="dz-bind-img" src="${r.avatar}" alt="" onerror="this.remove()">`
    : escapeHtml(r.initial);
  const worldBadge = r.world
    ? `<span class="dz-bind-world">${escapeHtml(r.world)}</span>`
    : '<span class="dz-bind-none">未绑定</span>';
  const unbindBtn = r.world
    ? `<button type="button" class="dz-bind-unbind" data-chid="${r.chid}" title="解绑该世界书">解绑</button>`
    : '';
  return `<div class="dz-bind-row" data-chid="${r.chid}">
    <span class="dz-bind-av">${avatarInner}</span>
    <div class="dz-bind-main">
      <div class="dz-bind-name">${escapeHtml(r.name)}</div>
      <div class="dz-bind-meta">${worldBadge}</div>
    </div>
    ${unbindBtn}
  </div>`;
}

// ---- 重新渲染列表（读取缓存 → 筛选 → 渲染 + 上限）----
function rerender() {
  const pane = getPane('binding');
  if (!pane) return;
  const list = pane.querySelector('#dz-bind-list');
  if (!list) return;

  const chars = getCharacterCache();
  let rows = allRowsSorted(chars);
  if (activeFilter === 'bound') rows = rows.filter((r) => r.world);
  else if (activeFilter === 'unbound') rows = rows.filter((r) => !r.world);
  else if (activeFilter) rows = rows.filter((r) => r.world === activeFilter);

  let html = '';
  let rendered = 0;
  for (const r of rows) {
    if (rendered >= MAX_RENDER) break;
    html += rowHtml(r);
    rendered++;
  }
  if (rows.length > MAX_RENDER) {
    html += `<div class="dz-bind-more">仅显示前 ${MAX_RENDER} 个，请用上方筛选缩小范围（共 ${rows.length} 个）</div>`;
  }
  if (!rows.length) {
    html = `<div class="dz-bind-empty">没有匹配的角色</div>`;
  }
  list.innerHTML = html;

  updateCounts(chars);
}

// 顶部统计：已绑定 / 未绑定 数量
function updateCounts(chars) {
  const pane = getPane('binding');
  if (!pane) return;
  const el = pane.querySelector('#dz-bind-counts');
  if (!el) return;
  const rows = allRowsSorted(chars);
  const bound = rows.filter((r) => r.world).length;
  const unbound = rows.length - bound;
  el.textContent = `已绑定 ${bound} · 未绑定 ${unbound}`;
}

// 填充“选角色”下拉 + 世界书候选 datalist
function populateInputs(pane) {
  const charSel = pane.querySelector('#dz-bind-chid');
  const worldList = pane.querySelector('#dz-bind-worlds');
  if (charSel) {
    const rows = allRowsSorted(getCharacterCache());
    charSel.innerHTML = rows
      .map((r) => `<option value="${r.chid}">${escapeHtml(r.name)}</option>`)
      .join('');
  }
  if (worldList) {
    const names = candidateWorldNames(getCharacterCache(), ctxRef);
    worldList.innerHTML = names
      .map((w) => `<option value="${escapeHtml(w)}"></option>`)
      .join('');
  }
}

// 填充筛选下拉（全部 / 已绑定 / 未绑定 / 各世界书）
function populateFilter(pane) {
  const sel = pane.querySelector('#dz-bind-filter');
  if (!sel) return;
  const names = getWorldNames(getCharacterCache());
  const opts = [
    `<option value="">全部角色</option>`,
    `<option value="bound"${activeFilter === 'bound' ? ' selected' : ''}>仅已绑定</option>`,
    `<option value="unbound"${activeFilter === 'unbound' ? ' selected' : ''}>仅未绑定</option>`,
  ];
  if (names.length) opts.push(`<option value="" disabled>— 按世界书 —</option>`);
  for (const w of names) {
    opts.push(`<option value="${escapeHtml(w)}"${activeFilter === w ? ' selected' : ''}>${escapeHtml(w)}</option>`);
  }
  sel.innerHTML = opts.join('');
}

// 状态提示（闪一下）
function flash(msg) {
  const pane = getPane('binding');
  if (!pane) return;
  const el = pane.querySelector('#dz-bind-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('dz-bind-status-show');
  setTimeout(() => el.classList.remove('dz-bind-status-show'), 2200);
}

// ---- 写绑定（特性检测 writeExtensionField，安全降级）----
async function doBind() {
  const pane = getPane('binding');
  if (!pane) return;
  const chidSel = pane.querySelector('#dz-bind-chid');
  const worldInput = pane.querySelector('#dz-bind-world');
  const chid = Number(chidSel && chidSel.value);
  const world = (worldInput && worldInput.value ? worldInput.value : '').trim();
  if (!Number.isFinite(chid) || chid < 0) { flash('请先选择一个角色'); return; }
  if (!world) { flash('请输入世界书名（可输入新名）'); return; }

  // 即时反馈：写入缓存对象，让名册/绑定两区当次会话同步
  const cache = getCharacterCache();
  const m = cache.find((c) => c.chid === chid);
  if (m) m.world = world;

  try {
    if (ctxRef && typeof ctxRef.writeExtensionField === 'function') {
      await ctxRef.writeExtensionField(chid, 'world', world);
      flash(`已绑定到「${world}」`);
    } else {
      flash('当前酒馆版本不支持写世界书字段，仅本次会话生效');
    }
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 写入世界书绑定失败（已捕获）：`, e);
    flash('写入失败，请手动修改角色卡的世界字段');
  }
  if (worldInput) worldInput.value = '';
  populateInputs(pane);
  populateFilter(pane);
  rerender();
}

// ---- 解绑 ----
async function doUnbind(chid) {
  if (!Number.isFinite(chid) || chid < 0) return;
  const cache = getCharacterCache();
  const m = cache.find((c) => c.chid === chid);
  if (m) m.world = '';
  try {
    if (ctxRef && typeof ctxRef.writeExtensionField === 'function') {
      await ctxRef.writeExtensionField(chid, 'world', '');
      flash('已解绑');
    } else {
      flash('当前版本不支持写字段，仅本次会话生效');
    }
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 解绑世界书失败（已捕获）：`, e);
    flash('解绑失败，请手动修改角色卡');
  }
  rerender();
}

// ---- 构建工具栏（仅一次），并绑定事件 ----
function buildToolbar(pane) {
  pane.innerHTML = `
    <p class="dz-hint">把角色卡与“世界书”绑定到一起，解决世界书 / 脚本被拆散、找不到对应角色卡的问题。绑定写入角色卡权威字段 data.extensions.world，名册区的“按世界书”分组会同步显示。</p>
    <div class="dz-bind-form">
      <select id="dz-bind-chid" class="dz-bind-sel" title="选择角色"></select>
      <input id="dz-bind-world" class="dz-bind-input" list="dz-bind-worlds" placeholder="世界书名（可输入新名）">
      <datalist id="dz-bind-worlds"></datalist>
      <button type="button" id="dz-bind-do" class="dz-btn">绑定</button>
    </div>
    <div class="dz-bind-row2">
      <select id="dz-bind-filter" class="dz-bind-sel" title="筛选"></select>
      <span id="dz-bind-counts" class="dz-bind-counts"></span>
    </div>
    <div id="dz-bind-status" class="dz-bind-status"></div>
    <div id="dz-bind-list" class="dz-bind-list"></div>
  `;

  const chidSel = pane.querySelector('#dz-bind-chid');
  const worldInput = pane.querySelector('#dz-bind-world');
  const doBtn = pane.querySelector('#dz-bind-do');
  const filter = pane.querySelector('#dz-bind-filter');
  const list = pane.querySelector('#dz-bind-list');

  if (doBtn) doBtn.addEventListener('click', () => doBind());
  if (worldInput) worldInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doBind(); }
  });
  if (filter) filter.addEventListener('change', () => { activeFilter = filter.value || ''; rerender(); });

  // 事件委托：点解绑
  if (list) list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chid]');
    if (btn && btn.classList.contains('dz-bind-unbind')) {
      const chid = Number(btn.dataset.chid);
      if (Number.isFinite(chid)) doUnbind(chid);
    }
  });
}

// ---- 主入口：在 onReady 中调用（M12 之后）----
export function renderBindingPane(ctx, settings) {
  try {
    if (typeof document === 'undefined') return;
    const pane = getPane('binding');
    if (!pane) return; // 悬浮窗未挂载则跳过

    ctxRef = ctx;

    // 跨版本兜底：缺角色数据则提示，不抛错（不影响自动美化）
    if (!ctx || !Array.isArray(ctx.characters)) {
      pane.innerHTML = '<p class="dz-hint">未检测到角色数据，绑定功能在当前酒馆版本暂不可用（不影响自动美化）。</p>';
      return;
    }

    if (!built) {
      buildToolbar(pane);
      built = true;
      // 角色/聊天变化 → 刷新缓存并重渲染（与名册区一致）
      const eventSource = (ctx && ctx.eventSource) || globalThis.eventSource || null;
      const event_types = globalThis.event_types || (ctx && ctx.event_types) || null;
      if (eventSource && event_types && event_types.CHAT_CHANGED !== undefined) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
          refreshCharacterCache(ctxRef);
          const p = getPane('binding');
          if (p) { populateInputs(p); populateFilter(p); }
          rerender();
        });
      }
    }

    refreshCharacterCache(ctx);
    populateInputs(pane);
    populateFilter(pane);
    rerender();
  } catch (e) {
    console.error(`[${DISPLAY_NAME}] 渲染绑定区失败（已捕获，不影响美化）：`, e);
  }
}
