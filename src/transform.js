// src/transform.js — M4：模糊正则 + 多兜底（把卡片文本解析为结构化数据）
//
// 职责（对应需求四“模糊匹配 + 多套兜底” + 需求二“不漏”）：
//   消费 M3 修好的文本，把 [card]...[/card] 解析成可在 M5 渲染的结构化数据。
//   即使 M3 没跑、或仍有轻微漂移，这里也用多套正则兜底，尽量“抓到、不漏”。
//
// 兜底分层（多套规则，逐层降级）：
//   Tier 1（主规则）：成对标签 [card]...[/card]，标签内 \s* 容忍大小写/空格；非贪婪匹配每块。
//   Tier 2（漏闭合兜底）：仅开启标签 [card]... 到“下一个开启标签”或文本结尾，捕获未闭合块。
//   Tier 3（字段兜底）：字段行 key=value / key:value / key：value 自动识别；非字段行归入 __notes。
//
// 性能（对应“数百/上千层不卡、逐层渲染完成”硬约束）：
//   - 默认先过 M3 repair（廉价跳过 + 线性扫描），再一次性 matchAll 解析，均为 O(n)；
//   - 纯函数、无 DOM、无副作用，天然适配 M2 增量管线“每楼只处理一次”。

import { isNonEmptyString } from './util.js';
import { repairMessage } from './repair.js';

const BLOCK_RE = /\[\s*card\s*\]([\s\S]*?)\[\s*\/\s*card\s*\]/gi; // 主规则：成对标签
const OPEN_RE = /\[\s*card\s*\]/gi;                                // 兜底：仅开启标签
const FIELD_RE = /^\s*([^=:：]+?)\s*[:：=]\s*(.+?)\s*$/;           // 字段行（= : ：皆可，值非空）
// 空值字段行：`key=` / `key:` 后面什么都没有。
// 弱模型偶尔会留一个空字段（比如 `__notes=` 或 `备注=` 后面忘了填）。
// 不单独识别的话，这一行会被当成「裸文本行」落进 __notes，
// 结果界面上直接显示字面量 `__notes=` —— 既难看又像 bug。
// 这里识别为空字段并**丢弃**（不写 fields，避免被当成真值渲染），与「空备注不产出节点」保持一致。
const EMPTY_FIELD_RE = /^\s*[^=:：\s][^=:：]*?\s*[:：=]\s*$/;

// 解析单张卡片正文为多字段结构
function parseCardBody(body) {
  const fields = {};
  const order = [];
  const lines = String(body).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const fm = FIELD_RE.exec(t); // 非全局，每次从头匹配
    if (fm) {
      const key = fm[1].trim();
      const val = fm[2].trim();
      if (!(key in fields)) order.push(key);
      fields[key] = val;
    } else if (EMPTY_FIELD_RE.test(t)) {
      // 空值字段行：直接跳过（丢弃），不当成文本内容
      continue;
    } else {
      // 非字段行（如纯文本描述）归入 __notes。
      // 注意：__notes 有两条来源——「裸文本行」走这里（数组），
      // 「AI 显式写的 __notes=… 字段行」走上面的字段分支（字符串）。
      // 若显式那条先出现，这里再 push 就会撞成 TypeError（旧版直接抛异常、整楼美化失败），
      // 所以先判断类型：是数组就续上，是字符串/其它就先归一成数组再接。
      if (!('__notes' in fields)) { fields.__notes = []; order.push('__notes'); }
      else if (!Array.isArray(fields.__notes)) { fields.__notes = [String(fields.__notes)]; }
      fields.__notes.push(t);
    }
  }
  return { fields, order, raw: body };
}

// 兜底：把“仅开启、无闭合”的文本切成卡片段（开启标签间 / 到结尾）
function parseDangling(text) {
  const segments = [];
  const cards = [];
  const opens = [...text.matchAll(new RegExp(OPEN_RE.source, 'gi'))];
  if (opens.length === 0) {
    segments.push({ type: 'text', value: text });
    return { segments, cards };
  }
  let cursor = 0;
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i];
    if (open.index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, open.index) });
    }
    const bodyStart = open.index + open[0].length;
    const bodyEnd = (i + 1 < opens.length) ? opens[i + 1].index : text.length;
    const body = text.slice(bodyStart, bodyEnd);
    const data = parseCardBody(body);
    data._dangling = true; // 标记：来自漏闭合兜底路径
    segments.push({ type: 'card', value: text.slice(open.index, bodyEnd), data });
    cards.push(data);
    cursor = bodyEnd;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  return { segments, cards };
}

/**
 * 把消息文本解析为「正文段」与「卡片段」交错的结构。
 * @param {string} text 原始或已修复的消息文本
 * @param {{ repair?: boolean }} [opts] repair=true（默认）先过 M3 修复再解析
 * @returns {{ segments: Array<{type:'text'|'card', value:string, data?:object}>, cards: object[], repaired: (string[]|null) }}
 */
export function parseCards(text, opts = {}) {
  const doRepair = opts.repair !== false;
  let work = text;
  let repaired = null;
  if (doRepair) {
    const r = repairMessage(text);
    work = r.text;
    repaired = r.fixes; // 即使为空数组也返回，便于上层知晓是否经过修复
  }

  const segments = [];
  const cards = [];
  if (!isNonEmptyString(work)) {
    return { segments, cards, repaired };
  }

  // Tier 1：成对标签（主规则）
  const re = new RegExp(BLOCK_RE.source, 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(work)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', value: work.slice(last, m.index) });
    }
    const data = parseCardBody(m[1]);
    segments.push({ type: 'card', value: m[0], data });
    cards.push(data);
    last = m.index + m[0].length;
  }

  if (last < work.length) {
    // Tier 2：剩余文本里的漏闭合 [card]（兜底）
    const tail = work.slice(last);
    const tailSegs = parseDangling(tail);
    segments.push(...tailSegs.segments);
    cards.push(...tailSegs.cards);
  }

  if (segments.length === 0) {
    // 完全没有卡片：整段当正文
    segments.push({ type: 'text', value: work });
  }

  return { segments, cards, repaired };
}

// 便捷：只取卡片数组（默认先修复）
export function extractCards(text, opts = {}) {
  return parseCards(text, opts).cards;
}
