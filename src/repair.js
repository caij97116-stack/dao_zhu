// src/repair.js — M3：格式校验 + 自动修复中间层
//
// 职责（对应需求四“格式校验+自动修复” + 需求二“兜底”）：
//   在正则 / M4 解析之前，先把 AI 输出里常见的“格式漂移”自动修好，
//   让后续正则总能拿到结构干净的文本，避免因轻微波动导致“正文爆代码”。
//
// 支持的修复：
//   1) 换行统一（\r\n / \r → \n）—— 兼容不同系统的换行差异
//   2) 标签大小写 / 标签内多余空格：[CARD] [ card ] [/Card] → [card] [/card]
//   3) 漏写闭合标签 [card]...（EOF 或下一个 [card] 出现时自动补 [/card]）
//   4) 悬挂的闭合标签（没有对应开启的 [/card]）→ 丢弃，避免裸标签
//   5) 卡片内部行：裁剪首尾空白、丢弃空行、合并行内多余空格、去掉分隔符(= : ：)两侧空格
//
// 性能（对应“数百/上千层不卡、逐层渲染完成”的硬约束）：
//   - containsCard() 先做廉价存在性检查，无卡片语法的消息（绝大多数）直接原样返回，零解析成本；
//   - 解析为单次线性扫描（O(n) 行），无嵌套正则回溯；
//   - 纯函数、无 DOM、无副作用，天然适配 M2 的“每楼只处理一次”增量管线；
//   - 卡片外的普通正文一律原样保留，绝不触达，避免无谓开销与误伤。

import { isNonEmptyString } from './util.js';

const TAG_NAME = 'card';
// 锚定到整行：防止 [card] / [/card] 嵌在正文里被误判
const OPEN_RE = /^\s*\[\s*card\s*\]\s*$/i;
const CLOSE_RE = /^\s*\[\s*\/\s*card\s*\]\s*$/i;
// 廉价存在性检查（不锚定），只用于“有没有卡片语法”的快速判定
// 同时认开启标签 [card] 与闭合标签 [/card]，避免“只有闭合标签”的情况被漏掉
const HAS_CARD_RE = /\[\s*\/?\s*card\s*\]/i;

// 仅统一换行（不合并整段空格，避免破坏卡片外的普通正文）
function toLf(text) {
  return text.replace(/\r\n?/g, '\n');
}

export function containsCard(raw) {
  if (!isNonEmptyString(raw)) return false;
  return HAS_CARD_RE.test(raw);
}

function isOpenTag(trimmedLine) {
  return OPEN_RE.test(trimmedLine);
}

function isCloseTag(trimmedLine) {
  return CLOSE_RE.test(trimmedLine);
}

// 卡片内部一行：裁剪 + 合并空格 + 分隔符两侧去空格（全角冒号转半角）
function normalizeCardLine(line) {
  let s = line.trim().replace(/\s+/g, ' ');
  if (s.length === 0) return s;
  s = s.replace(/：/g, ':'); // 全角冒号 → 半角
  s = s.replace(/^([^=:]+?)\s*([=:])\s*(.*)$/, '$1$2$3'); // 去掉分隔符两侧空格
  return s;
}

/**
 * 校验并修复一条消息里的卡片格式。
 * @param {string} raw 原始消息文本（可能含普通正文 + 卡片）
 * @returns {{ text: string, repaired: boolean, fixes: string[] }}
 *   text    修复后的文本（无卡片语法或已干净则原样返回）
 *   repaired 是否发生过修复
 *   fixes    可读的修复说明（便于调试 / 透明化）
 */
export function repairMessage(raw) {
  if (!isNonEmptyString(raw)) {
    return { text: raw || '', repaired: false, fixes: [] };
  }
  // 廉价前置检查：没有卡片语法就原样返回（绝大多数消息走这里，零成本）
  if (!containsCard(raw)) {
    return { text: raw, repaired: false, fixes: [] };
  }

  const fixes = [];
  const lines = toLf(raw).split('\n');
  const out = [];
  let inCard = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (isOpenTag(trimmed)) {
      if (inCard) {
        // 上一个块没闭合 → 自动补闭合（处理重叠 / 连续开启）
        out.push('[/' + TAG_NAME + ']');
        fixes.push('自动补全缺失的闭合标签 [/' + TAG_NAME + ']（上一块未闭合）');
      }
      out.push('[' + TAG_NAME + ']');
      inCard = true;
      continue;
    }

    if (isCloseTag(trimmed)) {
      if (!inCard) {
        // 悬挂闭合标签 → 丢弃，避免裸代码
        fixes.push('丢弃无对应开启标签的 [/' + TAG_NAME + ']，避免裸代码');
        continue;
      }
      out.push('[/' + TAG_NAME + ']');
      inCard = false;
      continue;
    }

    // 普通行
    if (inCard) {
      const n = normalizeCardLine(lines[i]);
      if (n.length === 0) continue; // 丢弃卡片内部空行
      out.push(n);
    } else {
      out.push(lines[i]); // 卡片外正文原样保留
    }
  }

  // EOF 仍有未闭合的块 → 补闭合
  if (inCard) {
    out.push('[/' + TAG_NAME + ']');
    fixes.push('在文本末尾自动补全缺失的闭合标签 [/' + TAG_NAME + ']');
  }

  const text = out.join('\n');
  const repaired = text !== raw || fixes.length > 0;

  return { text, repaired, fixes };
}
