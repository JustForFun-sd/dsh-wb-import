/**
 * 自包含的结构测试：不依赖任何真实会话数据。
 *
 * 用插件自己的代码生成一份导入产物（喂假的 sessionPersistence），
 * 再用宿主级校验器验它。CI 里跑这个就能防止格式回归。
 */
import { pathToFileURL } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateLifecycle } from './lifecycle-validator.mjs';

const SANDBOX = process.env.DSH_TEST_HOME || join(process.cwd(), '.ci-home');
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
process.env.DSH_HOME = SANDBOX;

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' -> ' + detail : ''}`); }
};

// --- 造一份最小的 WorkBuddy 源会话 ---
const WB_HOME = join(SANDBOX, 'wb');
const PROJ = join(WB_HOME, 'projects', 'd-me-WorkBuddy');
mkdirSync(PROJ, { recursive: true });

const SRC_ID = '00000000-0000-4000-8000-000000000001';
const records = [
  { type: 'session-meta', sessionId: SRC_ID },
  { type: 'ai-title', aiTitle: 'CI 示例会话' },
  {
    type: 'message', role: 'user', timestamp: 1_700_000_000_000,
    content: [{ type: 'input_text', text: '<user_query>你好</user_query>' }],
    providerData: { model: 'hy3' },
  },
  {
    type: 'message', role: 'assistant', timestamp: 1_700_000_001_000,
    content: [{ type: 'output_text', text: '你好，我是助手。' }],
    providerData: { model: 'hy3' },
  },
  {
    type: 'function_call', id: 'call-1', name: 'Bash',
    arguments: JSON.stringify({ command: 'echo hi' }),
    timestamp: 1_700_000_002_000, providerData: { model: 'hy3' },
  },
  {
    type: 'function_call_result', parentId: 'call-1', name: 'Bash',
    output: { text: 'hi' }, timestamp: 1_700_000_003_000,
  },
];
writeFileSync(join(PROJ, `${SRC_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

// --- 加载插件 ---
const mod = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href);

const captured = [];
const tools = [];
const ctx = {
  logger: { info: () => {} },
  tools: { register(d) { tools.push(d); return () => {}; } },
  effect() { return () => {}; },
  on() {},
  get() { return undefined; },
  sessionPersistence: {
    async create(header) {
      const rec = { header, events: [] };
      captured.push(rec);
      return {
        async append(events) { rec.events.push(...events); },
        async flush() {},
        async close() {},
      };
    },
  },
};

console.log('== plugin shape ==');
mod.apply(ctx, { workbuddyHome: WB_HOME });
check('exports name', typeof mod.name === 'string' && mod.name.length > 0);
check('inject lists sessionPersistence', Array.isArray(mod.inject) && mod.inject.includes('sessionPersistence'));
check('registers wb_list_sessions', tools.some((t) => t.name === 'wb_list_sessions'));
check('registers wb_import_session', tools.some((t) => t.name === 'wb_import_session'));
check('registers wb_rollback_import', tools.some((t) => t.name === 'wb_rollback_import'));

console.log('\n== import produces a valid session ==');
const imp = tools.find((t) => t.name === 'wb_import_session');
const out = await imp.execute({
  sessionIds: [SRC_ID],
  // 必须是绝对路径。直接用 path.resolve 的结果（Linux 是 /tmp/..., Windows 是 D:\...）
  workspaceDir: resolve(SANDBOX),
}, {});

check('import reports success', /^Imported 1 \/ 1/.test(out), out.split('\n')[0]);
const rec = captured[0];
check('header has version 4', rec?.header?.version === 4, String(rec?.header?.version));
check('header id is prefixed', String(rec?.header?.id ?? '').startsWith('session-wb-'));

const events = rec.events;
check('events non-empty', events.length > 0, String(events.length));

console.log('\n== lifecycle validation ==');
let validated = false, msg = '';
try { validateLifecycle(events); validated = true; } catch (e) { msg = e.message; }
check('passes host lifecycle rules', validated, msg);

console.log('\n== required fields ==');
const title = events.find((e) => e.type === 'session/title');
check('has session/title', title !== undefined);
check('title text is the ai-title', title?.data?.title === 'CI 示例会话', String(title?.data?.title));

const assistantMsgs = events.filter((e) => e.type === 'assistant/message');
check('assistant messages have message.id',
  assistantMsgs.length > 0 && assistantMsgs.every((e) => typeof e.data.message.id === 'string' && e.data.message.id));
check('assistant source carries provider+model',
  assistantMsgs.every((e) => e.data.message.source.provider && e.data.message.source.model));
check('assistant has stream array', assistantMsgs.every((e) => Array.isArray(e.data.stream)));

const turnEnds = events.filter((e) => e.type === 'turn/end');
check('every turn/end carries reason',
  turnEnds.length > 0 && turnEnds.every((e) => e.data.reason && typeof e.data.reason.kind === 'string'));

const surface = events.filter((e) => e.surfaceOp !== undefined);
check('surface events use append', surface.every((e) => e.surfaceOp === 'append' || typeof e.surfaceOp === 'object'));
check('seq is dense', events.every((e, i) => e.seq === i));

console.log('\n== tool lifecycle ==');
const calls = events.filter((e) => e.type === 'tool/call');
const results = events.filter((e) => e.type === 'tool/result');
check('tool call emitted', calls.length === 1, String(calls.length));
check('tool result emitted', results.length === 1, String(results.length));
check('result matches callId', results[0]?.data?.message?.toolCallId === calls[0]?.data?.callId);

console.log('\n== rollback ==');
const rb = tools.find((t) => t.name === 'wb_rollback_import');
const rbOut = await rb.execute({ ids: [rec.header.id], confirm: true }, {});
check('rollback removes it', /Rolled back 1/.test(rbOut), rbOut.split('\n')[0]);

rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
