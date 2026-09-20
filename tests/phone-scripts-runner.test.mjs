// tests/phone-scripts-runner.test.mjs — M16-D 运行器单测（纯逻辑 + 跨作用域查模板运行）
// 说明：本环境无真实酒馆 DOM / executeSlashCommands，用 stub（伪输入框 / 伪全局函数）覆盖两条运行路径。
import {
  findInputTextarea, applyTextToInput, runSlashCommands, runTemplate, runTemplateById,
} from '../src/phone-scripts-runner.js';
import { makeTemplate, PHONE_SCRIPT_SCOPES } from '../src/phone-scripts-data.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa === sb) { pass++; } else { fail++; console.error(`  ✗ ${msg} | 期望 ${sb} 实际 ${sa}`); } }

// ---- findInputTextarea（node 无 document → null）----
eq(findInputTextarea(), null, 'node 无 document → null');

// ===================== applyTextToInput（伪输入框）=====================
function fakeTa() {
  return { value: '', events: [], dispatchEvent(ev) { this.events.push(ev && ev.type); } };
}
let ta = fakeTa();
ok(applyTextToInput(ta, '你好', 'replace'), 'applyTextToInput 返回 true');
eq(ta.value, '你好', 'replace 覆盖输入框');
ok(ta.events.includes('input'), 'replace 派发了 input 事件');

ta = fakeTa(); ta.value = '正文A';
ok(applyTextToInput(ta, '模板B', 'append'), 'append 返回 true');
eq(ta.value, '正文A\n模板B', 'append 联合正文（换行连接）');

ta = fakeTa();
ok(applyTextToInput(ta, 'X', 'bogus'), '非法 mode 也返回 true');
eq(ta.value, 'X', '非法 mode 回落 append（基底空）');

ta = null;
ok(applyTextToInput(ta, 'X', 'replace') === false, '空输入框返回 false（安全降级）');

// ===================== runSlashCommands（特性检测全局 executeSlashCommands）=====================
let r = runSlashCommands('/sys x');
ok(r.ok === false && /executeSlashCommands/.test(r.error || ''), '无 executeSlashCommands → ok:false 且明确报错');

let calledWith = null;
const savedFn = (typeof globalThis !== 'undefined') ? globalThis.executeSlashCommands : undefined;
globalThis.executeSlashCommands = (c) => { calledWith = c; };
try {
  r = runSlashCommands('/sys 亮了');
  ok(r.ok === true, '有 executeSlashCommands → ok:true');
  eq(calledWith, '/sys 亮了', 'executeSlashCommands 收到正确代码');
  r = runSlashCommands('');
  ok(r.ok === true, '空代码也可调用（不崩）');
} finally {
  if (savedFn === undefined) { delete globalThis.executeSlashCommands; }
  else { globalThis.executeSlashCommands = savedFn; }
}

// ===================== runTemplate（分发：text / script）=====================
const realDoc = (typeof globalThis !== 'undefined') ? globalThis.document : undefined;
function stubDoc(taEl) {
  globalThis.document = { querySelector: () => taEl };
}
try {
  // text + append
  let mta = fakeTa();
  stubDoc(mta);
  r = runTemplate(null, null, { exec: 'text', insert: 'append', code: '联合' });
  ok(r.ok && r.kind === 'text', 'text 模板运行 ok');
  eq(mta.value, '联合', 'text 模板写入输入框（基底空）');

  // text + replace 覆盖
  mta = fakeTa(); mta.value = '旧正文';
  stubDoc(mta);
  r = runTemplate(null, null, { exec: 'text', insert: 'replace', code: '新' });
  eq(mta.value, '新', 'text replace 覆盖输入框');

  // script（用上面存过的函数）
  let scriptArg = null;
  globalThis.executeSlashCommands = (c) => { scriptArg = c; };
  r = runTemplate(null, null, { exec: 'script', code: '/echo hi' });
  ok(r.ok && r.kind === 'script', 'script 模板运行 ok');
  eq(scriptArg, '/echo hi', 'script 模板交给 executeSlashCommands');
} finally {
  if (realDoc === undefined) { delete globalThis.document; } else { globalThis.document = realDoc; }
  if (savedFn === undefined) { delete globalThis.executeSlashCommands; } else { globalThis.executeSlashCommands = savedFn; }
}

ok(runTemplate(null, null, null).ok === false, '空模板 → ok:false');

// ===================== runTemplateById（跨作用域聚合查模板并运行）=====================
function makeCtx() {
  return {
    chatMetadata: { phoneScripts: { templates: [] } },
    characters: [{ data: { extensions: {} } }],
    characterId: 0,
    saveSettingsDebounced() {},
    writeExtensionField() {},
  };
}
function makeSettings() {
  return { phoneScripts: { templates: [], defaultScope: 'chat', ownApi: { enabled: false } } };
}

// 全局作用域放一个 text 模板
let ctx = makeCtx();
let settings = makeSettings();
const tText = makeTemplate({ name: 'T', scope: 'global', exec: 'text', insert: 'append', code: '模板内容' });
settings.phoneScripts.templates.push(tText);

const realDoc2 = (typeof globalThis !== 'undefined') ? globalThis.document : undefined;
try {
  let mta2 = fakeTa();
  stubDoc(mta2);
  r = runTemplateById(ctx, settings, tText.id);
  ok(r.ok && r.kind === 'text', 'runTemplateById 找到全局 text 模板并运行');
  eq(mta2.value, '模板内容', '全局 text 模板写入输入框');
} finally {
  if (realDoc2 === undefined) { delete globalThis.document; } else { globalThis.document = realDoc2; }
}

// 角色作用域放一个 script 模板
let ctx2 = makeCtx();
let settings2 = makeSettings();
const tScript = makeTemplate({ name: 'S', scope: 'character', exec: 'script', code: '/setinput 跑' });
ctx2.characters[0].data.extensions.phoneScripts = [tScript];
const savedFn2 = globalThis.executeSlashCommands;
let arg2 = null;
globalThis.executeSlashCommands = (c) => { arg2 = c; };
try {
  r = runTemplateById(ctx2, settings2, tScript.id);
  ok(r.ok && r.kind === 'script', 'runTemplateById 找到角色 script 模板并运行');
  eq(arg2, '/setinput 跑', '角色 script 模板交给 executeSlashCommands');
} finally {
  if (savedFn2 === undefined) { delete globalThis.executeSlashCommands; } else { globalThis.executeSlashCommands = savedFn2; }
}

ok(runTemplateById(ctx, settings, '').ok === false, '空 id → ok:false');
ok(runTemplateById(ctx, settings, 'nope').ok === false, '不存在的 id → ok:false');

console.log(`\n— M16-D 结果：${pass} 通过 / ${fail} 失败 —`);
if (fail > 0) process.exit(1);
