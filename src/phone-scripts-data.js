// src/phone-scripts-data.js — 小手机工坊 · 数据层（M16-A）
// 纯函数：模板模型 / CRUD / 作用域聚合（同层·全局·角色）/ 命名 JSON 包导出导入。
// 不碰 DOM、不依赖 SillyTavern，可在 node 中单独单测。持久化 IO 由 M16-B/C/D 负责。

import { isNonEmptyString, cloneObj } from './util.js';

export const MODULE_NAME = 'dao-zhu';
export const PHONE_SCRIPT_KIND = 'phone-scripts'; // JSON 包 kind 标识
export const PACK_VERSION = 1;
// 作用域：chat=同层（仅当前聊天） / global=跨层全局 / character=跨层且绑定角色
export const PHONE_SCRIPT_SCOPES = ['chat', 'global', 'character'];
export const SCOPE_LABELS = { chat: '同层(当前聊天)', global: '跨层(全局)', character: '跨层(角色专属)' };
// 运行方式：script=执行 STscript（/ 斜杠命令） / text=仅插入文本到输入框（不执行）
export const PHONE_SCRIPT_EXEC = ['script', 'text'];
export const EXEC_LABELS = { script: '运行 STscript', text: '仅插入文本' };
// 插入方式：replace=替换输入框 / append=联合正文（追加到输入框现有正文）
export const PHONE_SCRIPT_INSERT = ['replace', 'append'];
export const INSERT_LABELS = { replace: '替换(覆盖输入框)', append: '联合正文(追加到正文)' };

// ---- ID 生成（允许测试时显式传入，保证可复现）----
export function uid() {
  return 'ps_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ---- 构造一个规范化的模板 ----
export function makeTemplate({ name, scope = 'chat', code = '', id, exec = 'script', insert = 'append' } = {}) {
  const now = Date.now();
  const safeScope = PHONE_SCRIPT_SCOPES.includes(scope) ? scope : 'chat';
  const safeExec = PHONE_SCRIPT_EXEC.includes(exec) ? exec : 'script';
  const safeInsert = PHONE_SCRIPT_INSERT.includes(insert) ? insert : 'append';
  return {
    id: isNonEmptyString(id) ? String(id) : uid(),
    name: isNonEmptyString(name) ? String(name) : '未命名小手机脚本',
    scope: safeScope,
    exec: safeExec,
    insert: safeInsert,
    code: typeof code === 'string' ? code : '',
    createdAt: now,
    updatedAt: now,
  };
}

// ---- 防御式规范化任意输入为模板（缺字段补默认，异常值兜底）----
export function normalizeTemplate(raw) {
  if (!raw || typeof raw !== 'object') return makeTemplate({});
  const id = isNonEmptyString(raw.id) ? String(raw.id) : uid();
  const scope = PHONE_SCRIPT_SCOPES.includes(raw.scope) ? raw.scope : 'chat';
  const name = isNonEmptyString(raw.name) ? String(raw.name) : '未命名小手机脚本';
  const code = typeof raw.code === 'string' ? raw.code : '';
  const exec = PHONE_SCRIPT_EXEC.includes(raw.exec) ? raw.exec : 'script';
  const insert = PHONE_SCRIPT_INSERT.includes(raw.insert) ? raw.insert : 'append';
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
  return { id, name, scope, exec, insert, code, createdAt, updatedAt };
}

// ---- 校验（用于导入/保存前的严格检查）----
export function validateTemplate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '模板必须是对象' };
  if (!isNonEmptyString(raw.name)) return { ok: false, error: '模板缺少 name' };
  if (!PHONE_SCRIPT_SCOPES.includes(raw.scope)) return { ok: false, error: '作用域非法: ' + String(raw.scope) };
  if (typeof raw.code !== 'string') return { ok: false, error: 'code 必须是字符串' };
  return { ok: true, template: normalizeTemplate(raw) };
}

// ---- CRUD（全部返回新数组，不改原数组）----
export function addTemplate(list, tpl) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const norm = normalizeTemplate(tpl);
  const idx = arr.findIndex((t) => t.id === norm.id);
  if (idx >= 0) arr[idx] = norm; else arr.push(norm);
  return arr;
}

export function updateTemplate(list, id, patch = {}) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const idx = arr.findIndex((t) => t.id === id);
  if (idx < 0) return arr;
  const prev = arr[idx];
  const merged = {
    ...prev,
    ...patch,
    id: prev.id, // id 不可改
    updatedAt: Date.now(),
  };
  arr[idx] = normalizeTemplate(merged);
  return arr;
}

export function removeTemplate(list, id) {
  const arr = Array.isArray(list) ? list.slice() : [];
  return arr.filter((t) => t.id !== id);
}

export function getTemplate(list, id) {
  if (!Array.isArray(list)) return undefined;
  return list.find((t) => t.id === id);
}

// ---- 聚合三作用域来源为统一展示列表（每个模板携带自身 scope 标签）----
// sources = { global: [], chat: [], character: [] }
// 返回合并后的数组；重复 id 以 character > chat > global 优先级去重。
export function collectTemplates(sources = {}) {
  const buckets = {
    global: Array.isArray(sources.global) ? sources.global : [],
    chat: Array.isArray(sources.chat) ? sources.chat : [],
    character: Array.isArray(sources.character) ? sources.character : [],
  };
  const byId = new Map(); // id -> {tpl, priority}
  const prio = { global: 0, chat: 1, character: 2 };
  for (const scope of PHONE_SCRIPT_SCOPES) {
    for (const raw of buckets[scope]) {
      const tpl = normalizeTemplate(raw);
      const hit = byId.get(tpl.id);
      if (!hit || prio[scope] > hit.priority) {
        byId.set(tpl.id, { tpl: { ...tpl, scope }, priority: prio[scope] });
      }
    }
  }
  return Array.from(byId.values()).map((x) => x.tpl);
}

// ---- 筛选（scope 可选；query 对 name+code 做不区分大小写的子串匹配）----
export function filterTemplates(list, { scope, query } = {}) {
  let arr = Array.isArray(list) ? list.slice() : [];
  if (PHONE_SCRIPT_SCOPES.includes(scope)) arr = arr.filter((t) => t.scope === scope);
  if (isNonEmptyString(query)) {
    const q = query.trim().toLowerCase();
    arr = arr.filter((t) =>
      (t.name || '').toLowerCase().includes(q) ||
      (t.code || '').toLowerCase().includes(q)
    );
  }
  return arr;
}

// ---- 导出为命名 JSON 包 ----
export function exportPack(templates, packName, { version = PACK_VERSION } = {}) {
  const arr = Array.isArray(templates) ? templates.map(normalizeTemplate) : [];
  return {
    app: MODULE_NAME,
    kind: PHONE_SCRIPT_KIND,
    name: isNonEmptyString(packName) ? String(packName) : '未命名小手机脚本',
    version,
    exportedAt: Date.now(),
    templates: arr,
  };
}

// ---- 从 JSON 字符串安全解析包（失败返回 ok:false，不抛异常）----
export function parsePack(text) {
  let obj;
  try {
    obj = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '包内容不是对象' };
  if (obj.kind && obj.kind !== PHONE_SCRIPT_KIND) {
    return { ok: false, error: '包 kind 不匹配: ' + String(obj.kind) };
  }
  const rawList = Array.isArray(obj.templates) ? obj.templates : [];
  const templates = [];
  const errors = [];
  for (const raw of rawList) {
    const v = validateTemplate(raw);
    if (v.ok) templates.push(v.template);
    else errors.push((raw && raw.name) || '(无名)');
  }
  return {
    ok: true,
    pack: obj,
    name: isNonEmptyString(obj.name) ? obj.name : '未命名小手机脚本',
    templates,
    skipped: errors,
  };
}

// ---- 将包合并进既有列表（按 id 覆盖；包优先）----
export function importPack(pack, existing = []) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  const incoming = Array.isArray(pack) ? pack : (pack && pack.templates) || [];
  let added = 0;
  let updated = 0;
  for (const raw of incoming) {
    const v = validateTemplate(raw);
    if (!v.ok) continue;
    const idx = base.findIndex((t) => t.id === v.template.id);
    if (idx >= 0) { base[idx] = v.template; updated++; }
    else { base.push(v.template); added++; }
  }
  return { templates: base, added, updated };
}

// ---- 设置里的默认子状态（M16-F 接入 defaultSettings 用，深拷贝避免共享引用）----
export function defaultPhoneScriptsState() {
  return cloneObj({
    showBar: true,            // 是否在聊天底部显示模板条
    defaultScope: 'chat',     // 新建模板的默认作用域
    ownApi: {                 // 自有 OpenAI 兼容 API（AI 帮写时可选切换）
      enabled: false,
      baseUrl: '',            // 例如 https://api.openai.com/v1
      apiKey: '',
      model: '',
    },
  });
}
