/**
 * dsh-wb-import — host half.
 *
 * 职责：
 *   1. 给前端设置页提供 HTTP 接口（列表 / 导入 / 回滚 / 台账）
 *   2. 保留三个模型工具（wb_list_sessions / wb_import_session / wb_rollback_import）
 *
 * 路由（全部挂在 BASE_PATH 下）：
 *   GET  /dsh-wb-import/sessions      列出 WorkBuddy 会话
 *   GET  /dsh-wb-import/ledger        读导入台账
 *   POST /dsh-wb-import/import        导入 { ids, workspaceDir }
 *   POST /dsh-wb-import/rollback      回滚 { ids?, all?, confirm }
 *
 * 数据安全边界（与纯工具版一致）：
 *   - 导入走宿主 sessionPersistence 服务；不直接写文件
 *   - workspaceDir 必须绝对、无 ".."，不做静默兜底
 *   - 回滚只删台账里记录的 session-wb-* 会话目录
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'wb-import-plugin';
// webServer 必须声明在 inject 里 —— cordis 只有在 inject 列出服务后才把它
// 解析进 ctx；否则 ctx.get('webServer') 返回 undefined，路由注册不了，
// 前端请求会落到 SPA fallback，拿到 HTML/空响应并报 JSON 解析错误。
//
// workspaceRegistry 用于把导入的会话挂进目标工作区。不挂的话会话会落在
// 「未分组」——DSH 只在启动时（bootstrap）按 cwd 自动分组，导入发生在
// 启动之后，所以必须由插件显式 attach。
export const inject = ['tools', 'sessionPersistence', 'webServer', 'workspaceRegistry'];

const BASE_PATH = '/dsh-wb-import';
const DEFAULT_MAX_IMPORT = 20;
const MAX_TOOL_RESULT_CHARS_PER_ITEM = 20_000;
// 每个 zstd 帧装多少条事件。
//
// 两个约束在拉扯：
//   - 帧太大 → 增量读取慢（宿主逐帧解压，读一条事件要解压整帧）
//   - 帧太小 → append 调用次数暴涨，宿主每次 append 都要 fsync 落盘，
//              导入会从几秒变成 30-45 秒（fsync 是真正的瓶颈，实测占 74%）
//
// 实测（15326 条事件，本机）：
//   批次 10 → 1533 帧, 10.0MB, 压缩 197ms, 全量读取 58ms
//   批次 20 →  767 帧,  9.2MB, 压缩 198ms, 全量读取 47ms   ← 最佳平衡
//   批次 30 →  511 帧,  8.8MB, 压缩 196ms, 全量读取 50ms
//   批次 50 →  307 帧,  8.1MB, 压缩 207ms, 全量读取 42ms
// 取 20：fsync 次数比批次 10 少一半，文件小 8%，读取还更快。
const APPEND_BATCH_EVENTS = 20;

// 压缩检查点的前言（和 DSH 自己生成的 checkpoint 一致的语气）。
// 原文仍在日志里，只是 surface 上被替换。
const COMPACTION_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation '
  + 'to free up context. Treat the captured context as established background and build on it '
  + 'without restating it. The full original messages remain in the session log and are still '
  + 'browsable by loading earlier history.';

// 导入会话的 system/message 内容。
// 宿主要求 system/message 是 surface 的第一个节点（protected head）；缺了它，
// 续写时会报 "system/message requires a protected first surface head"。
// 这里放一段中性的说明，不冒充 DSH 自己的系统提示——真正的系统提示由宿主在续写时追加。
const SYSTEM_PROMPT_TEXT =
  'This session was imported from WorkBuddy. The messages below are the original conversation '
  + 'history, preserved verbatim. Continue helping the user from where this history leaves off.';

function logLine(ctx, msg) {
  try {
    const logger = ctx?.logger;
    if (logger && typeof logger.info === 'function') logger.info(`[wb-import] ${msg}`);
  } catch {
    // 日志失败不影响主流程
  }
}

/**
 * 取工作区注册服务。cordis 服务既可 ctx.get(name) 也可 ctx.<name> 属性访问，
 * 两种都试，避免因为取法不对而拿不到。
 */
function getWorkspaceRegistry(ctx) {
  let svc;
  try { svc = ctx.get?.('workspaceRegistry'); } catch { /* ignore */ }
  if (!svc || typeof svc.resolveByPath !== 'function') {
    try { svc = ctx.workspaceRegistry; } catch { /* ignore */ }
  }
  return (svc && typeof svc.resolveByPath === 'function') ? svc : undefined;
}

// ---------------------------------------------------------------------------
// WorkBuddy 侧解析
// ---------------------------------------------------------------------------

function projectsRoot(config) {
  const home = config?.workbuddyHome
    ? String(config.workbuddyHome)
    : path.join(os.homedir(), '.workbuddy');
  return path.join(home, 'projects');
}

/**
 * 判断一段文本是否是 WorkBuddy 注入的"假用户发言"（不是用户真的说的话）。
 * 用于 extractRealInput 和 buildEvents 两层过滤。
 */
function isInjectedUserText(text) {
  if (typeof text !== 'string') return true;
  const t = text.trim();
  if (!t) return true;
  // 整条就是注入块（开标签存在）
  if (/^<(conversation_history_summary|task-notification|system-reminder|cb_summary|previous_assistant_message|available_skills)\b/i.test(t)) return true;
  // 开标签缺失/被截断，但含闭合标签 —— 同样是注入块的残片，整条丢弃。
  // 实测 WorkBuddy 会写出「摘要正文 + </conversation_history_summary>」这种
  // 没有开标签的残片，长度几千字，混进对话会被当成用户的长篇发言。
  if (/<\/(conversation_history_summary|cb_summary|task-notification|previous_assistant_message)>/i.test(t)) return true;
  if (/<(conversation_history_summary|cb_summary)\b/i.test(t)) return true;
  // 上下文压缩后的续接指令
  if (/^Please continue with the conversation based on the summarized context\b/i.test(t)) return true;
  if (/^Please continue from where you left off\b/i.test(t)) return true;
  // 摘要正文的特征开头（没有标签的裸摘要）
  if (/^Summary of the conversation so far\b/i.test(t)) return true;
  if (/^Summary:\s*\n?\s*1\.\s*\*\*Primary Request/i.test(t)) return true;
  // 任务通知的尾部指令（"Use the TaskOutput tool with task_id=..."）——
  // WorkBuddy 把 <task-notification> 块剥掉后剩下的就是这句，
  // 它同样是系统生成的，不是用户说的。
  if (/^Use the TaskOutput tool with task_id=/i.test(t)) return true;
  if (/^Use the TaskOutput\b/i.test(t)) return true;
  return false;
}

/**
 * 从注入块里剥出用户真实输入。
 *
 * WorkBuddy 会把几类「系统注入」塞进 role=user 的记录里，它们不是用户说的话，
 * 原样导入会让对话里出现一堆"用户输入"其实是上下文/通知的假发言：
 *   - <conversation_history_summary>  上下文压缩摘要（会话进行中自动生成的）
 *   - <task-notification>             后台任务完成/失败通知
 *   - <system-reminder> / <cb_summary> 提示块
 * 这些整块丢弃；只有 <user_query> 里的才是真实输入。
 */
function extractRealInput(text) {
  if (typeof text !== 'string') return '';
  const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) {
    const inner = m[1].trim();
    return isInjectedUserText(inner) ? '' : inner;
  }

  const stripped = text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<cb_summary[\s\S]*?<\/cb_summary>/g, '')
    .replace(/<conversation_history_summary[\s\S]*?<\/conversation_history_summary>/g, '')
    .replace(/<task-notification[\s\S]*?<\/task-notification>/g, '')
    .trim();

  if (isInjectedUserText(stripped)) return '';
  return stripped;
}

function readWbRecords(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 跳过坏行（崩溃尾部可能有截断行）
    }
  }
  return out;
}

/**
 * 异步版：读文件用 fs.promises（不阻塞事件循环），JSON 解析按批让出。
 * 大会话（十几 MB）用同步版会把整个响应延迟到解析完成之后。
 */
async function readWbRecordsAsync(file) {
  const raw = await fs.promises.readFile(file, 'utf8');
  const lines = raw.split('\n');
  const out = [];
  const YIELD_EVERY = 2000;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim()) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // 跳过坏行
      }
    }
    if (i > 0 && i % YIELD_EVERY === 0) {
      // 让出事件循环，保证 HTTP 响应能先写出去
      await new Promise((r) => setImmediate(r));
    }
  }
  return out;
}

/**
 * 把 WorkBuddy 记录流规整成线性对话。
 *
 * 配对：parentId 精确 → 同名 FIFO → 兜底 shift。
 * 输出保证：每个 callId 至多一个 result；只有配对成功的 call 才进入 items。
 */
/**
 * 压缩导入：用 WorkBuddy 现成的 <cb_summary> 摘要替代早期历史。
 *
 * 背景：导入的长会话动辄几百万 token，DSH 内置压缩要把整段历史发给 LLM，
 * 必然超限（实测上游直接返回 HTTP 400）。所以改成导入时就把早期内容换成摘要。
 *
 * 做法：
 *   1. 找源记录里**最后一个** <cb_summary>（它覆盖了最多的历史）
 *   2. 该摘要之前的记录 → 丢弃，换成一条摘要消息
 *   3. 摘要之后的记录 → 原文保留（用户选定的「最近 N 轮」）
 *
 * 摘要由 WorkBuddy 自己生成，不需要额外调 LLM —— 快、稳、不花额度。
 *
 * @param records  源记录（时间顺序）
 * @param recentTurns  摘要之后保留多少轮原文（按 user 消息数计）
 * @returns { records: 裁剪后的记录, summary: 摘要文本, droppedRecords: 被替代的记录数 }
 */
/**
 * 压缩导入（replace 模式）：原文全部写入日志，surface 上用 replace 替换。
 *
 * 这是 DSH 自己的压缩机制：日志保留完整历史（能向上翻看全部原文），
 * surface 上用一个 replace 事件把一段范围折叠成摘要（发给模型的是压缩版）。
 *
 * 做法：
 *   1. 找源记录里最后一个 <cb_summary>（它覆盖了最多的历史）
 *   2. 全部原文照常导入（不删任何记录）
 *   3. 在末尾追加一个 replace 事件：
 *        surfaceOp: { op: 'replace', startSeq: <首条>, endSeq: <摘要前一条> }
 *        sourceEventSeqs: [...被替换的所有 surface seq]
 *        data.source: { kind: 'compact-checkpoint', compactionId, sourceCommandId }
 *   4. 摘要之后的最近 N 轮不替换（保持原文可见）
 *
 * 摘要由 WorkBuddy 自己生成，不需要额外调 LLM。
 */
function planCompaction(records, recentTurns) {
  const summaries = [];
  records.forEach((r, i) => {
    if (r.type !== 'message' || r.role !== 'user') return;
    const c = Array.isArray(r.content) ? r.content : [];
    const text = c.filter((x) => x && x.type === 'input_text').map((x) => x.text).join('\n');
    const m = text.match(/<cb_summary>([\s\S]*?)<\/cb_summary>/);
    if (m) summaries.push({ index: i, text: m[1].trim() });
  });

  if (summaries.length === 0) {
    return { summary: null, reason: 'no-summary' };
  }

  const last = summaries[summaries.length - 1];

  // 摘要之后保留 recentTurns 轮：从末尾往前数 user 消息
  let turnCount = 0;
  let keepFrom = records.length;
  for (let i = records.length - 1; i >= last.index; i--) {
    const r = records[i];
    if (r.type === 'message' && r.role === 'user') {
      turnCount += 1;
      if (turnCount >= recentTurns) { keepFrom = i; break; }
    }
  }
  if (keepFrom >= records.length) keepFrom = last.index + 1;

  // 被替换的范围：从会话开头到 keepFrom 之前
  return {
    summary: last.text,
    keepFrom,
    reason: 'ok',
  };
}

/**
 * 把一段历史记录切成折叠段（每段一个 tool/call + tool/result 对）。
 * 每段约 SEGMENT_CHARS 字符，按轮次边界切，保证可读性。
 */
const FOLD_SEGMENT_CHARS = 250_000;

function buildFoldedSegments(records) {
  const segments = [];
  let buf = [];
  let chars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const preview = renderSegmentPreview(buf);
    if (preview.trim()) segments.push({ text: preview, count: buf.length });
    buf = [];
    chars = 0;
  };

  for (const r of records) {
    // 每遇到一个 user 消息就是一个轮次边界：如果当前段已经够大，先切
    if (r.type === 'message' && r.role === 'user' && chars >= FOLD_SEGMENT_CHARS) flush();
    buf.push(r);
    const c = Array.isArray(r.content) ? r.content : [];
    chars += c.reduce((a, b) => a + (b.text || '').length, 0)
      + (typeof r.arguments === 'string' ? r.arguments.length : 0)
      + (typeof r.output === 'string' ? r.output.length : (r.output?.text || '').length);
  }
  flush();
  return segments;
}

/** 把一批源记录渲染成可读文本（用户/助手/工具/思考） */
function renderRecordsAsText(records) {
  const out = [];
  for (const r of records) {
    if (r.type === 'message' && r.role === 'user') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'input_text').map((x) => x.text).join('\n');
      const real = extractRealInput(text);
      if (real) out.push(`【用户】\n${real}`);
      else if (text.trim()) {
        const s = text.match(/<cb_summary>([\s\S]*?)<\/cb_summary>/);
        out.push(`【上下文摘要】\n${(s ? s[1].trim() : text.trim()).slice(0, 30000)}`);
      }
    } else if (r.type === 'message' && r.role === 'assistant') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'output_text').map((x) => x.text).join('\n');
      if (text.trim()) out.push(`【助手】\n${text}`);
    } else if (r.type === 'reasoning') {
      const rc = Array.isArray(r.rawContent) ? r.rawContent : [];
      const text = rc.filter((x) => x && x.type === 'reasoning_text').map((x) => x.text).join('\n');
      if (text.trim()) out.push(`【思考】\n${text}`);
    } else if (r.type === 'function_call') {
      const pd = r.providerData || {};
      const name = r.name || pd.name || 'tool';
      const args = typeof r.arguments === 'string' ? r.arguments : JSON.stringify(r.arguments ?? {});
      out.push(`【调用 ${name}】\n${args}`);
    } else if (r.type === 'function_call_result') {
      const o = r.output || {};
      const text = typeof o === 'string' ? o : (o.text ?? JSON.stringify(o));
      out.push(`【结果】\n${String(text)}`);
    }
  }
  return out.join('\n\n');
}

/**
 * 折叠段的「预览版」：只保留骨架，用来占位 + 让用户知道那一段讲了什么。
 *
 * 为什么不能放全文：DSH 会把所有 surface 节点（含 tool/result）发给模型，
 * 全文塞进去等于没压缩（实测 218k → 1147k）。所以折叠段只放：
 *   - 该段每个用户消息的全文（用户意图是最重要的线索）
 *   - 助手消息的前 200 字（结论摘要）
 *   - 工具调用只留名字
 * 完整原文在 full-text.md 里。
 */
const PREVIEW_ASSISTANT_CHARS = 200;
function renderSegmentPreview(records) {
  const out = [];
  for (const r of records) {
    if (r.type === 'message' && r.role === 'user') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'input_text').map((x) => x.text).join('\n');
      const real = extractRealInput(text);
      if (real) out.push(`【用户】${real.slice(0, 500)}`);
    } else if (r.type === 'message' && r.role === 'assistant') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'output_text').map((x) => x.text).join('\n').trim();
      if (text) out.push(`【助手】${text.slice(0, PREVIEW_ASSISTANT_CHARS)}${text.length > PREVIEW_ASSISTANT_CHARS ? '…' : ''}`);
    } else if (r.type === 'function_call') {
      const pd = r.providerData || {};
      out.push(`· 调用 ${r.name || pd.name || 'tool'}`);
    }
  }
  return out.join('\n');
}

function normalizeWb(records) {
  let title = null;
  const calls = [];
  const results = [];

  // 折叠段（压缩导入生成的早期原文）→ 直接转成 tool 对，不走配对逻辑
  const foldedItems = [];
  for (const r of records) {
    if (!r.__isFoldedSegment) continue;
    const id = `folded-${foldedItems.length + 1}`;
    foldedItems.push({
      kind: 'tool-call', id,
      name: 'read_history_segment',
      args: JSON.stringify({ segment: foldedItems.length + 1, records: r.__recordCount ?? 0 }),
      ts: r.__ts ?? Date.now(),
    });
    foldedItems.push({
      kind: 'tool-result', callId: id,
      name: 'read_history_segment',
      text: r.__text ?? '',
      ts: r.__ts ?? Date.now(),
    });
  }

  for (const r of records) {
    // ai-title 可能出现多条（会话进行中 WorkBuddy 会改写标题）。
    // 取第一条 = 会话的原始标题，与用户在 WorkBuddy 里看到的初始命名一致；
    // 取最后一条会把中途改过的标题带过来，导致导入后名字对不上。
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && title === null) title = r.aiTitle;

    if (r.type === 'function_call') {
      const pd = r.providerData || {};
      calls.push({
        id: r.id,
        name: r.name || pd.name || 'tool',
        args: typeof r.arguments === 'string' ? r.arguments : JSON.stringify(r.arguments ?? {}),
        ts: r.timestamp,
        model: typeof pd.model === 'string' && pd.model.trim() ? pd.model.trim() : null,
      });
    } else if (r.type === 'function_call_result') {
      const o = r.output || {};
      results.push({
        name: r.name || (r.providerData || {}).name,
        parentId: r.parentId,
        text: typeof o === 'string' ? o : (o.text ?? JSON.stringify(o)),
        ts: r.timestamp,
      });
    }
  }

  const pending = [...calls];
  const pairedResults = new Map();
  const usedCallIds = new Set();
  const dropped = { duplicateResults: 0, unmatchedResults: 0, unpairedCalls: 0 };

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    let matched;
    const exact = pending.findIndex((c) => c.id === res.parentId);
    if (exact >= 0) matched = pending.splice(exact, 1)[0];
    if (!matched) {
      const byName = pending.findIndex((c) => c.name === res.name);
      if (byName >= 0) matched = pending.splice(byName, 1)[0];
    }
    if (!matched && pending.length) matched = pending.shift();
    if (!matched) { dropped.unmatchedResults += 1; continue; }
    if (usedCallIds.has(matched.id)) { dropped.duplicateResults += 1; continue; }
    usedCallIds.add(matched.id);
    pairedResults.set(i, matched);
  }
  dropped.unpairedCalls = pending.length;

  // 第二遍：call 的输出位置跟随它的 result（相邻对），
  // 规避 WorkBuddy 落盘时 result 先于 call、user 记录插在两者之间、重复行三种脏模式。
  const items = [];
  let ri = 0;
  // 折叠段排在最前（它们在源里就是早期内容）
  items.push(...foldedItems);
  // 会话级模型兜底：WorkBuddy 每条记录都带 providerData.model，
  // 取第一个见到的作为 fallback，避免个别记录缺模型时 source 不合法。
  let sessionModel = null;
  let sessionProvider = 'workbuddy';

  for (const r of records) {
    const pd = r.providerData || {};
    if (!sessionModel && typeof pd.model === 'string' && pd.model.trim()) sessionModel = pd.model.trim();

    if (r.type === 'message' && r.role === 'user') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'input_text').map((x) => x.text).join('\n');
      // 压缩导入生成的摘要记录要保留（它本身就是 <conversation_history_summary>，
      // 会被注入过滤拦掉，所以走白名单）。
      if (r.__isCompactionSummary) {
        items.push({ kind: 'user', text, ts: r.timestamp, isSummary: true });
      } else {
        const real = extractRealInput(text);
        if (real) items.push({ kind: 'user', text: real, ts: r.timestamp });
      }
    } else if (r.type === 'message' && r.role === 'assistant') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'output_text').map((x) => x.text).join('\n');
      if (text.trim()) {
        items.push({
          kind: 'assistant', text, ts: r.timestamp,
          model: typeof pd.model === 'string' && pd.model.trim() ? pd.model.trim() : null,
        });
      }
    } else if (r.type === 'reasoning') {
      const rc = Array.isArray(r.rawContent) ? r.rawContent : [];
      const text = rc.filter((x) => x && x.type === 'reasoning_text').map((x) => x.text).join('\n');
      if (text.trim()) {
        items.push({
          kind: 'reasoning', text, ts: r.timestamp,
          model: typeof pd.model === 'string' && pd.model.trim() ? pd.model.trim() : null,
        });
      }
    } else if (r.type === 'function_call_result') {
      const call = pairedResults.get(ri);
      ri += 1;
      if (call) {
        const res = results[ri - 1];
        items.push({ kind: 'tool-call', id: call.id, name: call.name, args: call.args, ts: res.ts, model: call.model });
        items.push({ kind: 'tool-result', callId: call.id, name: call.name, args: call.args, text: res.text, ts: res.ts, model: call.model });
      }
    }
  }

  return { title, items, dropped, sessionModel, sessionProvider };
}

/**
 * 会话元信息缓存：key = 路径 + mtime + size。只缓存标题。
 */
const metaCache = new Map();
const META_CACHE_MAX = 500;

function readHead(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const n = Math.min(maxBytes, st.size);
    const buf = Buffer.allocUnsafe(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.slice(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function metaFor(file, mtime, size) {
  const key = `${file}|${mtime}|${size}`;
  const hit = metaCache.get(key);
  if (hit) return hit;

  const meta = { title: null, parseError: null };
  try {
    const recs = [];
    for (const line of readHead(file, 512 * 1024).split('\n')) {
      if (!line.trim()) continue;
      try { recs.push(JSON.parse(line)); } catch { /* 截断行 */ }
    }
    const aiTitle = recs.find((r) => r.type === 'ai-title' && typeof r.aiTitle === 'string');
    if (aiTitle) meta.title = aiTitle.aiTitle;
    if (!meta.title) {
      for (const r of recs) {
        if (r.type === 'message' && r.role === 'user') {
          const c = Array.isArray(r.content) ? r.content : [];
          const text = c.filter((x) => x && x.type === 'input_text').map((x) => x.text).join('\n');
          const real = extractRealInput(text);
          if (real) { meta.title = real.slice(0, 60).replace(/\s+/g, ' ').trim(); break; }
        }
      }
    }
  } catch (e) {
    meta.parseError = e?.message ?? String(e);
  }

  if (metaCache.size >= META_CACHE_MAX) {
    const first = metaCache.keys().next().value;
    if (first !== undefined) metaCache.delete(first);
  }
  metaCache.set(key, meta);
  return meta;
}

function scanFiles(config) {
  const root = projectsRoot(config);
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(root, proj.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        out.push({
          id: f.replace(/\.jsonl$/, ''),
          file,
          project: proj.name,
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch { continue; }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------
// DSH 侧事件构造
// ---------------------------------------------------------------------------

/**
 * 构造 DSH v4 事件流（工具调用为宿主 Relationships 要求的严格三连）。
 * 见 lib/index.js 历史版本的详细注释：广告 → tool/call → tool/result。
 */
/** 扫一遍事件流，返回末尾仍未关闭的 turn（没有则 null） */
function detectOpenTurn(events) {
  let open = null;
  for (const e of events) {
    if (e.type === 'turn/start') open = e.data.turn;
    else if (e.type === 'turn/end') open = null;
  }
  return open;
}

/** 扫一遍事件流，返回末尾仍未关闭的 step（没有则 null） */
function openStepOf(events) {
  let openStep = null;
  let openTurn = null;
  for (const e of events) {
    if (e.type === 'turn/start') { openTurn = e.data.turn; openStep = null; }
    else if (e.type === 'turn/end') { openTurn = null; openStep = null; }
    else if (e.type === 'step/start') openStep = e.data.step;
    else if (e.type === 'step/end') openStep = null;
  }
  return openTurn !== null ? openStep : null;
}

function buildEvents(items, title, defaults = {}, compaction = null) {
  // assistant/message 的 source 必须是完整的 model source：
  //   { kind:'model', provider:'<非空>', model:'<非空>' }
  // 只写 kind 会被宿主判为 "message must have model source"。
  const fallbackProvider = (typeof defaults.provider === 'string' && defaults.provider.trim())
    ? defaults.provider.trim() : 'workbuddy';
  const fallbackModel = (typeof defaults.model === 'string' && defaults.model.trim())
    ? defaults.model.trim() : 'unknown';
  /** 构造一条 assistant 的 model source（优先用该条记录自己的模型） */
  const modelSource = (model) => ({
    kind: 'model',
    provider: fallbackProvider,
    model: (typeof model === 'string' && model.trim()) ? model.trim() : fallbackModel,
  });
  const events = [];
  let seq = 0;
  const push = (type, time, data, extra) => {
    const e = { type, seq: seq++, time, data };
    if (extra) Object.assign(e, extra);
    events.push(e);
  };

  const t0 = items.length ? (items[0].ts ?? Date.now()) : Date.now();
  push('permission/preset', t0, { preset: 'workspace-write' });
  push('sandbox/mode', t0, { mode: 'workspace-write' });
  push('approval/policy', t0, { policy: 'ask' });

  let turn = 0;
  let step = 0;
  let openStep = false;
  let pendingReasoning = [];
  let pendingModel = null;   // 与 pendingReasoning 同源记录的模型
  let firstUserSeq = null;
  let systemHeadPushed = false;   // system/message 只插一次，作为 surface 头
  const adverts = [];
  let droppedOrphans = 0;

  // DSH 的对话是按 step 组织的：一轮里有几十上百个 step，
  // 每个 step 装「一次模型输出 + 它的工具调用/结果」。
  // 本机会话一轮 196 个 step，而把整轮塞进一个 step 会让前端渲染失败
  // （只显示"加载更早"、控制台报 reading 'kind'）。
  // 所以这里每次 beginStep() 都开一个新的 step。
  const beginStep = (time) => {
    if (turn === 0) { turn = 1; push('turn/start', time, { turn }); }
    closeStep(time);
    step += 1;
    openStep = true;
    push('step/start', time, { turn, step });
    // system/message 必须是 surface 的第一个节点（protected head）。
    // 放在 beginStep 里，保证「第一个 step 一开就插」，不依赖有没有 user 消息
    // —— 有的会话开头是 assistant/reasoning，第一条 user 消息在很后面。
    if (!systemHeadPushed) {
      systemHeadPushed = true;
      push('system/message', time, {
        turn, step,
        message: {
          role: 'system',
          content: [{ type: 'text', text: SYSTEM_PROMPT_TEXT }],
          source: { kind: 'system-prompt' },
          id: randomUUID(),
        },
      }, { surfaceOp: 'append' });
    }
  };

  /** 开一个新的 turn（先关旧的），返回后调用者应紧接着 beginStep */
  const startTurn = (time) => {
    closeStep(time);
    if (turn > 0) push('turn/end', time, { turn, reason: { kind: 'completed' } });
    turn += 1;
    step = 0;
    openStep = false;
    push('turn/start', time, { turn });
  };
  const closeStep = (time) => {
    if (openStep) { push('step/end', time, { turn, step }); openStep = false; }
  };

  const emitAssistant = (time, text, model) => {
    beginStep(time);
    const content = [];
    if (pendingReasoning.length) {
      content.push({ type: 'reasoning', text: pendingReasoning.join('\n') });
      pendingReasoning = [];
    }
    content.push({ type: 'text', text });
    push('assistant/message', time, {
      turn, step,
      // stream 必须是数组（宿主的 settlement fields 校验）；内容不校验，
      // 空数组合法 —— 它是流式渲染记录，导入的历史没有增量可放。
      stream: [],
      // message.id 必须存在：宿主校验器会报 "lacks an identified message"
      message: { role: 'assistant', content, source: modelSource(model), id: randomUUID() },
    }, { surfaceOp: 'append' });
    closeStep(time);
  };

  const settleCall = (call, resultText, time) => {
    beginStep(time);
    push('assistant/message', time, {
      turn, step,
      stream: [],
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.args }],
        source: modelSource(call.model),
        id: randomUUID(),
      },
    }, { surfaceOp: 'append' });
    push('tool/call', time, { turn, step, callId: call.id, name: call.name, arguments: call.args });
    const full = String(resultText);
    const truncated = full.length > MAX_TOOL_RESULT_CHARS_PER_ITEM;
    const text = truncated
      ? full.slice(0, MAX_TOOL_RESULT_CHARS_PER_ITEM)
        + `\n\n[wb-import: 工具结果超过 ${MAX_TOOL_RESULT_CHARS_PER_ITEM} 字符，此处截断；完整内容见原 WorkBuddy 会话 ${call.id}]`
      : full;
    push('tool/result', time, {
      turn, step,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: call.id },
        toolCallId: call.id,
        content: [{ type: 'text', text }],
        isError: false,
        id: randomUUID(),
      },
    }, { surfaceOp: 'append' });
    closeStep(time);
  };

  for (const it of items) {
    const t = Number.isFinite(it.ts) ? it.ts : t0;
    if (it.kind === 'user') {
      if (adverts.length) { droppedOrphans += adverts.length; adverts.length = 0; }
      // 二次兜底：即使上游漏过滤，这里也拦掉系统注入的"假用户发言"
      // （上下文压缩摘要 / 续接指令 / 任务通知）。它们不是用户说的。
      // 例外：压缩导入生成的摘要记录本身就是要保留的。
      const rawText = String(it.text ?? '');
      if (!it.isSummary && isInjectedUserText(rawText)) { droppedOrphans += 0; continue; }
      closeStep(t);
      // 新轮次：startTurn 关旧轮、开新轮（带 turn/end 的 reason），
      // beginStep 再开第一个 step 并插入 system 头。
      // 这样 system/message 一定排在这条 user 消息之前（surface 的第一个节点）。
      startTurn(t);
      beginStep(t);
      const userSeq = seq;
      if (firstUserSeq === null) firstUserSeq = userSeq;
      push('user/message', t, {
        content: [{ type: 'text', text: it.text }],
        source: { kind: 'user' },
        role: 'user',
        id: randomUUID(),
      }, { surfaceOp: 'append' });
    } else if (it.kind === 'reasoning') {
      pendingReasoning.push(it.text);
      if (it.model) pendingModel = it.model;
    } else if (it.kind === 'assistant') {
      emitAssistant(t, it.text, it.model);
    } else if (it.kind === 'tool-call') {
      adverts.push(it);
    } else if (it.kind === 'tool-result') {
      const idx = adverts.findIndex((a) => a.id === it.callId);
      if (idx < 0) { droppedOrphans += 1; continue; }
      const call = adverts.splice(idx, 1)[0];
      settleCall(call, it.text, t);
    }
  }
  if (adverts.length) droppedOrphans += adverts.length;

  if (pendingReasoning.length && turn > 0) {
    beginStep(t0);
    push('assistant/message', t0, {
      turn, step,
      stream: [],
      message: {
        role: 'assistant',
        content: [{ type: 'reasoning', text: pendingReasoning.join('\n') }],
        source: modelSource(pendingModel),
        id: randomUUID(),
      },
    }, { surfaceOp: 'append' });
    pendingReasoning = [];
  }
  closeStep(t0);
  // 关掉最后一个 turn。只在遇到下一条 user 消息时才关 turn 的话，
  // 单轮会话（或最后一轮）会留下永远敞开的 turn —— 宿主校验会判不合法，
  // 而且前端把「打开的轮次」当成还在生成，渲染会卡住。
  if (turn > 0) {
    push('turn/end', t0, { turn, reason: { kind: 'completed' } });
    turn = 0;
    step = 0;
    openStep = false;
  }

  // title 事件放在会话前部（第一条 assistant/message 之前），与真实 DSH 会话一致
  // —— 真实会话里 title 在 index 14-15，紧跟 request/context。放在末尾
  // （step/end 与 turn/end 之间）会夹进 turn 收尾区，前端渲染容易卡住。
  if (title && firstUserSeq !== null) {
    const titleEvent = {
      type: 'session/title',
      seq: 0,
      time: t0,
      data: {
        title: String(title).slice(0, 200),
        messageSeqs: [firstUserSeq],
        source: { kind: 'fallback' },
      },
    };
    let insertAt = events.findIndex((e) => e.type === 'assistant/message');
    if (insertAt < 0) insertAt = Math.min(15, events.length);
    events.splice(insertAt, 0, titleEvent);
    // 重排 seq，保持稠密。
    // 注意：重排会改变 insertAt 之后所有事件的 seq，所以引用 seq 的字段
    // 也要同步修正 —— messageSeqs 里存的是重排前的位置。
    // （当前 title 总插在第一条 assistant 之前，而第一条 user 更早，
    //  所以实际上不受影响；但会话开头是 assistant 时就会错位，所以显式处理。）
    const shiftRef = (n) => (typeof n === 'number' && n >= insertAt ? n + 1 : n);
    for (const e of events) {
      if (Array.isArray(e.data?.messageSeqs)) e.data.messageSeqs = e.data.messageSeqs.map(shiftRef);
      if (Array.isArray(e.sourceEventSeqs)) e.sourceEventSeqs = e.sourceEventSeqs.map(shiftRef);
      if (e.surfaceOp && typeof e.surfaceOp === 'object') {
        e.surfaceOp.startSeq = shiftRef(e.surfaceOp.startSeq);
        e.surfaceOp.endSeq = shiftRef(e.surfaceOp.endSeq);
      }
      if (e.data?.shadowedRange) {
        e.data.shadowedRange.start = shiftRef(e.data.shadowedRange.start);
        e.data.shadowedRange.end = shiftRef(e.data.shadowedRange.end);
      }
      if (Array.isArray(e.data?.shadowedSeqs)) e.data.shadowedSeqs = e.data.shadowedSeqs.map(shiftRef);
    }
    events.forEach((e, i) => { e.seq = i; });
  }

  // 压缩（replace 模式）：原文全部保留在日志里，末尾追加一组压缩事件，
  // 把 [首条 surface .. 摘要前一条] 这一段在 surface 上折叠成摘要。
  //
  // 必须成组出现，否则宿主报 "compaction checkpoint has no matching compaction/start"：
  //   compaction/start  { compactionId, sourceCommandId, turn }
  //   compaction/summary
  //   user/message      replace(...)，source.compactionId 与 start 一致
  //   compaction/end    { compactionId, sourceCommandId, turn }
  let compactionApplied = null;
  if (compaction && compaction.reason === 'ok') {
    // 找出被替换范围内的 surface 节点（只折叠 surface 事件）
    const shadowed = events.filter((e) => e.surfaceOp !== undefined && e.seq < compaction.shadowedEndSeq);
    if (shadowed.length > 0) {
      const first = shadowed[0].seq;
      const lastSeq = shadowed[shadowed.length - 1].seq;
      const compactionId = randomUUID();
      const sourceCommandId = 'cmd-wb-import-1';

      // compaction/start 的 turn 必须等于「当前打开的 turn」。
      // 会话常在轮次中途结束（末尾没有 turn/end），此时 open turn 不是 null ——
      // 写 null 会被宿主判为 "compaction/start does not match the open turn"。
      // 所以先把末尾未关闭的 turn 关掉（补 step/end + turn/end），
      // 让 open turn 变成 null，再写压缩事件组。
      const openTurn = detectOpenTurn(events);
      if (openTurn !== null) {
        if (openStepOf(events) !== null) {
          events.push({ type: 'step/end', seq: events.length, time: t0, data: { turn: openTurn, step: openStepOf(events) } });
        }
        events.push({ type: 'turn/end', seq: events.length, time: t0, data: { turn: openTurn, reason: { kind: 'interrupted' } } });
      }

      events.push({
        type: 'compaction/start',
        seq: events.length,
        time: t0,
        data: { compactionId, sourceCommandId, turn: null },
      });
      events.push({
        type: 'compaction/summary',
        seq: events.length,
        time: t0,
        data: {
          compactionId,
          sourceCommandId,
          summary: [{ type: 'text', text: compaction.summary }],
          rawOutput: [{ type: 'text', text: compaction.summary }],
          llmStreamCall: false,
          shadowedRange: { start: first, end: lastSeq },
          shadowedSeqs: shadowed.map((e) => e.seq),
          shadowedTokenCount: 0,
        },
      });
      events.push({
        type: 'user/message',
        seq: events.length,
        time: t0,
        surfaceOp: { op: 'replace', startSeq: first, endSeq: lastSeq },
        sourceEventSeqs: shadowed.map((e) => e.seq),
        data: {
          content: [{
            type: 'text',
            text: `${COMPACTION_PREAMBLE}\n\n${compaction.summary}`,
          }],
          source: {
            kind: 'compact-checkpoint',
            compactionId,
            sourceCommandId,
          },
          role: 'user',
          id: randomUUID(),
        },
      });
      events.push({
        type: 'compaction/end',
        seq: events.length,
        time: t0,
        data: { compactionId, sourceCommandId, turn: null },
      });

      compactionApplied = {
        startSeq: first,
        endSeq: lastSeq,
        shadowedCount: shadowed.length,
      };
    }
  }
  return { events, droppedOrphans, compactionApplied };
}

// ---------------------------------------------------------------------------
// 路径与台账
// ---------------------------------------------------------------------------

function isAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  if (p.startsWith('/')) return true;
  return false;
}

function resolveWorkspaceDir(value) {
  if (!isAbsolutePath(value)) throw new Error(`workspaceDir 必须是绝对路径（absolute）；收到的是 ${JSON.stringify(value)}`);
  if (value.split(/[\\/]+/).some((s) => s === '..')) throw new Error('workspaceDir 不能包含 ".." 段');
  // Windows 上把盘符大写、分隔符统一成反斜杠，让 projectKey 和后续路径校验稳定。
  // 非 Windows 平台必须保持原样 —— 把 POSIX 的 "/tmp/x" 改成 "\tmp\x" 会让
  // 路径不再绝对，导入和回滚都会失败。
  if (process.platform === 'win32') {
    return value.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`).replace(/\//g, '\\');
  }
  return value;
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function ledgerPath() {
  return path.join(dshHome(), 'wb-import-ledger.json');
}

function readLedger() {
  const file = ledgerPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { version: 1, entries: [] };
    throw new Error(`cannot read import ledger ${file}: ${err?.message ?? err}`);
  }
  // 容忍 BOM：外部工具（如 PowerShell Set-Content）可能写入 UTF-8 BOM，
  // 那会让 JSON.parse 直接失败。剥掉它，而不是判台账损坏。
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`import ledger ${file} is corrupt; refusing to touch it. (${err?.message ?? err})`);
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`import ledger ${file} has an unexpected shape; refusing to touch it.`);
  }
  return parsed;
}

function writeLedger(ledger) {
  const file = ledgerPath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function appendLedger(entries) {
  if (entries.length === 0) return;
  const ledger = readLedger();
  const index = new Map(ledger.entries.map((e, i) => [e.dshId, i]));
  for (const e of entries) {
    const row = { ...e, at: Date.now() };
    if (index.has(e.dshId)) ledger.entries[index.get(e.dshId)] = row;
    else { index.set(e.dshId, ledger.entries.length); ledger.entries.push(row); }
  }
  writeLedger(ledger);
}

function projectKey(cwd) {
  let readable = '';
  let sepRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sepRun) readable += '-';
      sepRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      sepRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      sepRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

function projCacheRoot() {
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
}

/**
 * 写一份投影缓存，让导入的会话在侧边栏直接显示标题。
 *
 * 为什么需要：DSH 侧边栏的会话标题读的是投影缓存（session_projcache/<id>.json），
 * 不是会话日志里的 session/title 事件。缓存只在会话被打开过一次时才由宿主生成，
 * 所以新导入的会话在列表里会显示成"未命名"，直到你点开一次。
 *
 * 格式（已对照真实缓存文件核实）：
 *   { version: 7, record: { identity, rows } }
 *   identity: { formatVersion:4, createdAt, cwd, isSeeded, inheritedEventCount }
 *   rows.title: { ver: 1, seq: <标题事件的 seq>, val: <标题文本> }
 *
 * identity 必须与会话 header 精确匹配（formatVersion/createdAt/cwd/isSeeded/inheritedEventCount），
 * 否则宿主会判为不匹配并忽略这份缓存 —— 那就等于没写，不会造成损坏。
 * 写失败只降级为警告：缓存是性能优化，不是会话数据的必要条件。
 */
function writeProjectionCache(header, titleSeq, titleText) {
  const dir = projCacheRoot();
  const file = path.join(dir, `${header.id}.json`);
  const record = {
    version: 7,
    record: {
      identity: {
        formatVersion: header.version,
        createdAt: header.createdAt,
        ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
        isSeeded: header.isSeeded,
        inheritedEventCount: 0,
      },
      rows: {
        title: { ver: 1, seq: titleSeq, val: titleText },
      },
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 删除投影缓存条目（回滚时用） */
function removeProjectionCache(sessionId) {
  const file = path.join(projCacheRoot(), `${sessionId}.json`);
  try {
    if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); return true; }
  } catch { /* 删不掉就算了：缓存缺失只会让标题暂时空白 */ }
  return false;
}

// ---------------------------------------------------------------------------
// 核心操作（工具与 HTTP 共用）
// ---------------------------------------------------------------------------

/**
 * 把源会话原文导出成 Markdown，放在 DSH 会话目录旁边。
 * 压缩导入会丢掉早期原文，这份文件是"原文备查"。
 *
 * 位置：~/.dsh/sessions/<projectKey>/<sessionId>/full-text.md
 * （和 session.v4.jsonl.zstd 同目录，DSH 不会把它当会话文件读）
 */
function writeFullTextExport(records, title, sourceId, cwd) {
  const lines = [];
  lines.push(`# ${title || sourceId}`);
  lines.push('');
  lines.push(`- 源会话：\`${sourceId}\``);
  lines.push(`- 工作区：\`${cwd}\``);
  lines.push(`- 导出时间：${new Date().toISOString()}`);
  lines.push(`- 说明：这是导入前的**完整原文**。压缩导入只把早期历史换成了摘要，原文在这里。`);
  lines.push('');
  lines.push('---');
  lines.push('');

  let turn = 0;
  for (const r of records) {
    if (r.type === 'message' && r.role === 'user') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'input_text').map((x) => x.text).join('\n');
      const real = extractRealInput(text);
      // 注入块也要留档（标注出来），但单独成段
      if (real) {
        turn += 1;
        lines.push(`## 轮 ${turn} · 用户`);
        lines.push('');
        lines.push(real);
        lines.push('');
      } else if (text.trim()) {
        const summary = text.match(/<cb_summary>([\s\S]*?)<\/cb_summary>/);
        lines.push(`## 轮 ${turn || 1} · 〔系统注入〕`);
        lines.push('');
        lines.push(summary ? summary[1].trim() : text.trim().slice(0, 20000));
        lines.push('');
      }
    } else if (r.type === 'message' && r.role === 'assistant') {
      const c = Array.isArray(r.content) ? r.content : [];
      const text = c.filter((x) => x && x.type === 'output_text').map((x) => x.text).join('\n');
      if (text.trim()) {
        lines.push(`### 助手`);
        lines.push('');
        lines.push(text);
        lines.push('');
      }
    } else if (r.type === 'reasoning') {
      const rc = Array.isArray(r.rawContent) ? r.rawContent : [];
      const text = rc.filter((x) => x && x.type === 'reasoning_text').map((x) => x.text).join('\n');
      if (text.trim()) {
        lines.push(`<details><summary>思考</summary>`);
        lines.push('');
        lines.push(text);
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    } else if (r.type === 'function_call') {
      const pd = r.providerData || {};
      const name = r.name || pd.name || 'tool';
      const args = typeof r.arguments === 'string' ? r.arguments : JSON.stringify(r.arguments ?? {}, null, 2);
      lines.push(`<details><summary>🔧 ${name}</summary>`);
      lines.push('');
      lines.push('```');
      lines.push(args.slice(0, 4000));
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    } else if (r.type === 'function_call_result') {
      const o = r.output || {};
      const text = typeof o === 'string' ? o : (o.text ?? JSON.stringify(o));
      lines.push(`<details><summary>↳ 结果</summary>`);
      lines.push('');
      lines.push('```');
      lines.push(String(text).slice(0, 8000));
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  const dir = path.join(sessionsRoot(), projectKey(cwd), `session-wb-${sourceId}`);
  // sourceId 来自调用方给的 sessionIds，直接拼进路径前必须确认它不会穿越目录。
  const rootResolved = path.resolve(sessionsRoot());
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(rootResolved + path.sep) || path.basename(resolvedDir) !== `session-wb-${sourceId}`) {
    throw new Error(`refusing to export: unsafe session id ${JSON.stringify(sourceId)}`);
  }
  fs.mkdirSync(resolvedDir, { recursive: true });
  const file = path.join(resolvedDir, 'full-text.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// 异步导入任务
// ---------------------------------------------------------------------------

/** 内存里的任务表（只保存最近 N 个，避免无限增长） */
const IMPORT_JOBS = new Map();
const MAX_KEPT_JOBS = 20;

function createImportJob(body) {
  const id = randomUUID();
  const sessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
  const job = {
    id,
    state: 'pending',
    total: sessionIds.length,
    done: 0,
    progress: [],
    results: [],
    error: null,
    startedAt: Date.now(),
  };
  IMPORT_JOBS.set(id, job);

  // 清理过老的任务
  if (IMPORT_JOBS.size > MAX_KEPT_JOBS) {
    const oldest = [...IMPORT_JOBS.entries()]
      .filter(([, j]) => j.state !== 'running' && j.state !== 'pending')
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [k] of oldest.slice(0, IMPORT_JOBS.size - MAX_KEPT_JOBS)) IMPORT_JOBS.delete(k);
  }

  return job;
}

function launchImportJob(ctx, config, body, job) {
  if (job.state !== 'pending') return;
  job.state = 'running';
  (async () => {
    try {
      const out = await doImport(ctx, config, body, {
        onProgress: (p) => {
          job.done = p.done;
          job.progress.push({ id: p.id, phase: p.phase, ok: p.ok });
        },
      });
      job.results = out.results ?? [];
      job.state = out.ok ? 'done' : 'failed';
      job.error = out.ok ? null : (out.error ?? 'import failed');
    } catch (e) {
      job.state = 'failed';
      job.error = String(e?.message ?? e);
    }
  })();
}

function getImportJob(jobId) {
  return IMPORT_JOBS.get(jobId);
}

/**
 * 前置校验：非法参数必须在响应里立即拒绝，而不是让前端拿到一个
 * "pending" 的任务、再在轮询里才发现路径不合法。
 * 只做便宜检查（不读文件、不碰磁盘写入）。
 */
function validateImportRequest(config, body) {
  const maxImportCount = Number(config?.maxImportCount ?? DEFAULT_MAX_IMPORT);
  const sessionIds = body?.sessionIds;
  if (!Array.isArray(sessionIds)) return 'sessionIds 必须是数组';
  const ids = [...new Set(sessionIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
  if (ids.length === 0) return '没有提供 sessionIds';
  if (ids.length > maxImportCount) return `会话太多：${ids.length} > ${maxImportCount}`;
  try {
    resolveWorkspaceDir(body?.workspaceDir);
  } catch (err) {
    return `${err?.message ?? err}（不做静默兜底）`;
  }
  return null;
}

async function doImport(ctx, config, { sessionIds, workspaceDir, compact, recentTurns, exportFullText }, exec) {
  const maxImportCount = Number(config?.maxImportCount ?? DEFAULT_MAX_IMPORT);
  if (!Array.isArray(sessionIds)) return { ok: false, error: 'sessionIds 必须是数组' };
  const ids = [...new Set(sessionIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
  if (ids.length === 0) return { ok: false, error: '没有提供 sessionIds' };
  if (ids.length > maxImportCount) return { ok: false, error: `too many sessions: ${ids.length} > ${maxImportCount}` };

  let cwd;
  try {
    cwd = resolveWorkspaceDir(workspaceDir);
  } catch (err) {
    return { ok: false, error: `${err?.message ?? err} (no silent fallback)` };
  }

  const persistence = ctx.sessionPersistence;
  if (!persistence || typeof persistence.create !== 'function') {
    return { ok: false, error: 'sessionPersistence 服务不可用' };
  }

  const files = scanFiles(config);
  const byId = new Map(files.map((r) => [r.id, r]));
  const results = [];
  const manifest = [];
  let ok = 0;

  let processed = 0;
  for (const id of ids) {
    exec?.signal?.throwIfAborted();
    exec?.onProgress?.({ id, phase: 'start', done: processed });
    const meta = byId.get(id);
    if (!meta) {
      results.push({ id, ok: false, error: '找不到该会话' });
      processed += 1;
      exec?.onProgress?.({ id, phase: 'failed', done: processed, ok: false });
      continue;
    }

    let handle;
    let created = false;
    let appended = 0;
    try {
      const allRecords = await readWbRecordsAsync(meta.file);

      // 压缩导入（replace 模式）：原文全部照常导入，末尾加一个 replace 事件
      // 把早期范围在 surface 上折叠成摘要。向上翻能看原文，模型只看到压缩版。
      let compaction = null;
      if (compact === true) {
        const turns = Number.isInteger(recentTurns) && recentTurns > 0 ? recentTurns : 40;
        compaction = planCompaction(allRecords, turns);
        if (compaction.reason === 'ok') {
          // 把 keepFrom 换成「被替换范围」的结束 seq：原文全部保留，
          // 只记下要折叠到哪里。真正的 seq 要等事件构建完才知道，见下面。
          compaction.keepFromRecords = compaction.keepFrom;
          compaction.shadowedEndRecordIndex = compaction.keepFrom;
        } else compaction = { ...compaction, applied: false };
      }

      const norm = normalizeWb(allRecords);
      if (norm.items.length === 0) {
        results.push({ id, ok: false, error: '没有可导入的消息' });
        continue;
      }

      // 原文导出（备查）——replace 模式下原文仍在日志里，但导出更方便搜索
      let exportPath = null;
      let exportWarning;
      if (compact === true && exportFullText !== false) {
        try {
          exportPath = writeFullTextExport(allRecords, norm.title, id, cwd);
        } catch (expErr) {
          exportWarning = expErr?.message ?? String(expErr);
        }
      }

      // 需要知道「折叠到哪个 seq」：先把被替换范围的记录数换算成事件 seq。
      // 简单做法：先构建一次事件，数出前 keepFrom 条记录产生了多少个事件。
      let compactionPlan = null;
      if (compaction && compaction.reason === 'ok') {
        const headItems = normalizeWb(allRecords.slice(0, compaction.keepFromRecords)).items;
        const headEvents = buildEvents(headItems, null, {
          provider: norm.sessionProvider,
          model: norm.sessionModel,
        }).events;
        // 被替换范围 = 这些事件里的 surface 节点
        const surfaceSeqs = headEvents.filter((e) => e.surfaceOp !== undefined).map((e) => e.seq);
        if (surfaceSeqs.length > 0) {
          compactionPlan = {
            summary: compaction.summary,
            shadowedEndSeq: surfaceSeqs[surfaceSeqs.length - 1] + 1,
            reason: 'ok',
          };
        }
      }

      const { events, droppedOrphans, compactionApplied } = buildEvents(norm.items, norm.title, {
        provider: norm.sessionProvider,
        model: norm.sessionModel,
      }, compactionPlan);
      const dshId = `session-wb-${id}`;
      const header = {
        version: 4, id: dshId,
        createdAt: norm.items[0].ts ?? Date.now(),
        cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
      };

      handle = await persistence.create(header, { signal: exec?.signal });
      created = true;
      // 分批 append：每批一个 zstd 帧。
      // 一次性 append 全部事件只会压成一个巨型帧，宿主的解码器是逐帧解码的，
      // 于是每次读一条事件都要解压整帧 —— 大会话翻页会慢到不可用。
      // 宿主自己也是按小批次追加的（真实会话有几百上千帧），这里对齐这个形态。
      for (let offset = 0; offset < events.length; offset += APPEND_BATCH_EVENTS) {
        exec?.signal?.throwIfAborted();
        await handle.append(events.slice(offset, offset + APPEND_BATCH_EVENTS), { signal: exec?.signal });
      }
      appended = events.length;
      await handle.flush({ signal: exec?.signal });

      // 写投影缓存，让侧边栏直接显示标题（而不是"未命名"）。
      // 缓存是性能优化：写失败不影响会话本身，只降级为警告。
      let cacheWarning;
      try {
        const titleEvent = events.find((e) => e.type === 'session/title');
        if (titleEvent) {
          writeProjectionCache(header, titleEvent.seq, titleEvent.data.title);
        }
      } catch (cacheErr) {
        cacheWarning = cacheErr?.message ?? String(cacheErr);
        logLine(ctx, `projection cache write failed for ${id}: ${cacheWarning}`);
      }

      // 把会话挂进目标工作区。
      // DSH 只在启动时（bootstrap）按 cwd 自动分组；导入发生在启动之后，
      // 不显式 attach 的话会话会落在「未分组」。
      let workspaceWarning;
      try {
        const registry = getWorkspaceRegistry(ctx);
        if (!registry) {
          workspaceWarning = 'workspaceRegistry service unavailable';
        } else {
          const entity = await registry.resolveByPath(cwd);
          if (!entity) {
            workspaceWarning = `no workspace registered for ${cwd}`;
          } else {
            await entity.attachSession(dshId);
          }
        }
      } catch (wsErr) {
        workspaceWarning = wsErr?.message ?? String(wsErr);
        logLine(ctx, `workspace attach failed for ${id}: ${workspaceWarning}`);
      }

      ok += 1;
      manifest.push({ dshId, sourceId: id, cwd, events: events.length });
      results.push({
        id, ok: true, dshId, events: events.length,
        dropped: { ...norm.dropped, orphanBoundary: droppedOrphans },
        title: norm.title,
        cacheWarning,
        compaction: compactionApplied ? {
          applied: true,
          shadowedCount: compactionApplied.shadowedCount,
          startSeq: compactionApplied.startSeq,
          endSeq: compactionApplied.endSeq,
          summaryChars: (compaction?.summary ?? '').length,
          recentTurns: Number.isInteger(recentTurns) && recentTurns > 0 ? recentTurns : 40,
        } : (compaction ? { applied: false, reason: compaction.reason ?? 'no surface nodes' } : undefined),
        exportPath,
        exportWarning,
        workspaceWarning,
      });
    } catch (err) {
      const msg = err?.message ?? String(err);
      const alreadyExists = /already exists|SessionAlreadyExists/i.test(msg);
      if (alreadyExists) created = false;
      results.push({ id, ok: false, error: msg, alreadyExists });
      if (!alreadyExists && created) {
        manifest.push({ dshId: `session-wb-${id}`, sourceId: id, cwd, events: appended, partial: true });
      }
    } finally {
      if (handle) {
        try { await handle.close(); } catch (closeErr) {
          const why = closeErr?.message ?? String(closeErr);
          logLine(ctx, `close failed for ${id}: ${why}`);
          // close 失败不能覆盖已成功的结果，但要如实告知用户（写租约可能未释放）
          const row = results.find((r) => r.id === id);
          if (row) row.closeWarning = why;
        }
      }
    }
    processed += 1;
    const doneRow = results[results.length - 1];
    exec?.onProgress?.({ id, phase: 'done', done: processed, ok: doneRow?.ok === true });
  }

  let ledgerError = null;
  if (manifest.length) {
    try {
      appendLedger(manifest.map((m) => ({ dshId: m.dshId, sourceId: m.sourceId, cwd: m.cwd, events: m.events, partial: !!m.partial })));
    } catch (ledgerErr) {
      ledgerError = ledgerErr?.message ?? String(ledgerErr);
      logLine(ctx, `ledger write failed: ${ledgerError}`);
    }
  }

  // 台账写失败要如实上报：没有台账就没有回滚依据
  return { ok: true, imported: ok, total: ids.length, cwd, results, manifest, ledgerError };
}

async function doRollback({ ids, all, confirm }, ctx) {
  const ledger = readLedger();
  if (ledger.entries.length === 0) return { ok: true, empty: true, entries: [] };

  if (confirm !== true) {
    return { ok: true, entries: ledger.entries, deleted: 0, skipped: [] };
  }

  let targets;
  if (all === true) targets = ledger.entries;
  else {
    const want = new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
    targets = ledger.entries.filter((e) => want.has(e.dshId));
  }
  if (targets.length === 0) return { ok: true, entries: [], deleted: 0, skipped: [] };

  const root = sessionsRoot();
  const removed = [];
  const skipped = [];
  const rootResolved = path.resolve(root);

  for (const e of targets) {
    if (typeof e.dshId !== 'string' || !e.dshId.startsWith('session-wb-')) {
      skipped.push({ dshId: e.dshId, reason: 'not created by this plugin' });
      continue;
    }
    if (!isAbsolutePath(e.cwd)) {
      skipped.push({ dshId: e.dshId, reason: 'ledger cwd is not absolute' });
      continue;
    }
    const key = projectKey(e.cwd);
    const dir = path.join(root, key, e.dshId);
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(rootResolved + path.sep)) { skipped.push({ dshId: e.dshId, reason: 'path escapes sessions root' }); continue; }
    if (path.basename(resolved) !== e.dshId) { skipped.push({ dshId: e.dshId, reason: 'directory name mismatch' }); continue; }
    const normCwd = path.win32.normalize(e.cwd);
    if (normCwd.includes('..')) { skipped.push({ dshId: e.dshId, reason: 'cwd contains ..' }); continue; }
    if (key.includes('..') || key === '--root--' || key.length <= 4) { skipped.push({ dshId: e.dshId, reason: `bad workspace key ${key}` }); continue; }
    if (path.dirname(resolved) !== path.join(rootResolved, key)) { skipped.push({ dshId: e.dshId, reason: 'parent is not the expected workspace dir' }); continue; }

    try {
      // 先从工作区摘除（否则工作区表里会留下指向已删会话的条目）
      try {
        const registry = getWorkspaceRegistry(ctx);
        if (registry) {
          const entity = await registry.resolveByPath(e.cwd);
          if (entity) await entity.detachSession(e.dshId);
        }
      } catch (wsErr) {
        logLine(ctx, `workspace detach failed for ${e.dshId}: ${wsErr?.message ?? wsErr}`);
      }

      if (!fs.existsSync(resolved)) {
        // 目录已经没了，但缓存可能还在 —— 一起清掉，否则侧边栏留幽灵条目
        removeProjectionCache(e.dshId);
        removed.push(e.dshId);
        continue;
      }
      fs.rmSync(resolved, { recursive: true, force: true });
      // 同步清掉投影缓存，否则侧边栏会留下指向已删会话的幽灵条目
      removeProjectionCache(e.dshId);
      removed.push(e.dshId);
    } catch (err) {
      skipped.push({ dshId: e.dshId, reason: `delete failed: ${err?.message ?? err}` });
    }
  }

  if (removed.length) {
    writeLedger({ version: 1, entries: ledger.entries.filter((e) => !removed.includes(e.dshId)) });
  }
  return { ok: true, entries: targets, deleted: removed.length, removed, skipped };
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function strictInt(value, label, { min, max, fallback }) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} must be an integer; got ${JSON.stringify(value)}`);
  if (min !== undefined && value < min) throw new Error(`${label} must be >= ${min}; got ${value}`);
  if (max !== undefined && value > max) throw new Error(`${label} must be <= ${max}; got ${value}`);
  return value;
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig ?? {};
  logLine(ctx, `mounted workbuddyHome=${config.workbuddyHome ?? '(default)'} maxImport=${config.maxImportCount ?? DEFAULT_MAX_IMPORT}`);

  // ---- HTTP 路由（给前端设置页用）----
  // cordis 服务既可 ctx.get(name) 也可 ctx.<name> 属性访问；两种都试，
  // 避免因为取法不对导致路由压根没注册（前端只会看到空响应）。
  let server;
  try { server = ctx.get?.('webServer'); } catch { /* ignore */ }
  if (!server || typeof server.register !== 'function') {
    try { server = ctx.webServer; } catch { /* ignore */ }
  }
  logLine(ctx, `webServer service: ${server ? (typeof server.register === 'function' ? 'available' : 'present-but-no-register') : 'MISSING'}`);
  const disposers = [];
  if (server && typeof server.register === 'function') {
    // 注意：res 是 node:http 的原生 ServerResponse。
    // 这里必须把失败原因写出来 —— 之前 catch 吞掉异常，前端只会看到空响应
    // （"Unexpected end of JSON input"），根本不知道发生了什么。
    const sendJson = (res, code, body) => {
      let payload;
      try {
        payload = JSON.stringify(body);
      } catch (e) {
        payload = JSON.stringify({ ok: false, error: `serialize failed: ${e?.message ?? e}` });
        code = 500;
      }
      try {
        if (!res.headersSent) {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
        }
        res.end(payload);
      } catch (e) {
        logLine(ctx, `sendJson failed: ${e?.message ?? e}`);
        try { res.destroy(); } catch { /* ignore */ }
      }
    };
    const readBody = (req) => new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });

    const routes = [
      // 自检路由：前端拿不到数据时先打这个，看 host 侧到底在不在
      [`${BASE_PATH}/health`, async (req, res) => {
        sendJson(res, 200, {
          ok: true,
          version: '0.2.0',
          workbuddyRoot: projectsRoot(config),
          rootExists: fs.existsSync(projectsRoot(config)),
          dshHome: dshHome(),
          routes: [...routes.map(([p]) => p)],
        });
      }],

      [`${BASE_PATH}/sessions`, async (req, res) => {
        if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { ok: false, error: '请求方法不对' });
        try {
          const files = scanFiles(config);
          const rows = files.map((r) => {
            const m = metaFor(r.file, r.mtime, r.size);
            return {
              id: r.id,
              title: m.title || '',
              project: r.project,
              size: r.size,
              sizeText: formatSize(r.size),
              mtime: r.mtime,
              updated: formatDate(r.mtime),
              parseError: m.parseError,
            };
          });
          sendJson(res, 200, { ok: true, root: projectsRoot(config), sessions: rows });
        } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }],

      [`${BASE_PATH}/ledger`, async (req, res) => {
        if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { ok: false, error: '请求方法不对' });
        try {
          const ledger = readLedger();
          sendJson(res, 200, {
            ok: true,
            entries: ledger.entries.map((e) => ({ ...e, atText: e.at ? formatDate(e.at) : '' })),
          });
        } catch (e) { sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }); }
      }],

      // 异步导入：立即返回任务 id，前端轮询 /import/status。
      // 压缩导入要读源文件 + 生成摘要记录 + 导出原文，可能花几十秒；
      // 同步等待会让前端卡住、也可能被网关超时打断。
      [`${BASE_PATH}/import`, async (req, res) => {
        if (String(req?.method ?? 'POST').toUpperCase() !== 'POST') return sendJson(res, 405, { ok: false, error: '请求方法不对' });
        try {
          const body = await readBody(req);
          // 非法参数立即拒绝（不创建任务）
          const invalid = validateImportRequest(config, body);
          if (invalid) return sendJson(res, 400, { ok: false, error: invalid });
          const job = createImportJob(body);
          // 先把响应写完，再启动任务。
          // 关键：用 setImmediate 把任务排到 IO 阶段之后 —— res.end() 只是把数据
          // 交给 socket，真正的 flush 也在 IO 阶段；如果任务同步插在中间，
          // 客户端会等到任务跑完才收到响应，异步就白做了。
          sendJson(res, 200, { ok: true, jobId: job.id, total: job.total, state: job.state });
          setImmediate(() => launchImportJob(ctx, config, body, job));
        } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }],

      [`${BASE_PATH}/import/status`, async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const jobId = url.searchParams.get('jobId') || '';
          const job = getImportJob(jobId);
          if (!job) return sendJson(res, 404, { ok: false, error: `unknown job ${jobId}` });
          sendJson(res, 200, {
            ok: true,
            jobId: job.id,
            state: job.state,
            total: job.total,
            done: job.done,
            progress: job.progress,
            results: job.state === 'done' ? job.results : job.results,
            error: job.error,
          });
        } catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }],

      [`${BASE_PATH}/rollback`, async (req, res) => {
        if (String(req?.method ?? 'POST').toUpperCase() !== 'POST') return sendJson(res, 405, { ok: false, error: '请求方法不对' });
        try {
          const body = await readBody(req);
          sendJson(res, 200, await doRollback(body, ctx));
        } catch (e) { sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }); }
      }],
    ];

    for (const [p, handler] of routes) {
      try {
        const dispose = server.register({ kind: 'exact', path: p, handler });
        if (typeof dispose === 'function') disposers.push(dispose);
        logLine(ctx, `route ready: ${p}`);
      } catch (error) {
        logLine(ctx, `cannot answer ${p}: ${error?.message ?? error}`);
      }
    }
  } else {
    logLine(ctx, 'no web server: settings UI routes unavailable (tools still work)');
  }

  // ---- 模型工具（与 UI 共用核心逻辑）----
  ctx.tools.register({
    name: 'wb_list_sessions',
    description:
      '列出本机保存的 WorkBuddy 历史会话（只读，按时间从新到旧）：标题、大小、工作区和会话 id。'
      + '可按关键词和/或数量过滤。只列不导入。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '只返回标题包含该文本的会话（不区分大小写）。' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少个会话（默认 30）。' },
        minBytes: { type: 'integer', minimum: 0, description: '跳过小于该字节数的会话（默认 0）。' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = strictInt(args.limit, 'limit', { min: 1, max: 200, fallback: 30 });
      const minBytes = strictInt(args.minBytes, 'minBytes', { min: 0, fallback: 0 });
      const kw = typeof args.keyword === 'string' ? args.keyword.toLowerCase() : '';

      const files = scanFiles(config);
      if (files.length === 0) return `No WorkBuddy sessions found under ${projectsRoot(config)}.`;

      let rows = files.filter((r) => r.size >= minBytes);
      if (kw) rows = rows.filter((r) => (metaFor(r.file, r.mtime, r.size).title || '').toLowerCase().includes(kw));
      const total = rows.length;
      const shown = rows.slice(0, limit);

      const lines = [`WorkBuddy sessions: ${total} match(es) out of ${files.length} total.`, `Data root: ${projectsRoot(config)}`, ''];
      for (const r of shown) {
        const m = metaFor(r.file, r.mtime, r.size);
        lines.push(`- ${m.title || '(无标题)'}`);
        lines.push(`  id=${r.id}  size=${formatSize(r.size)}  updated=${formatDate(r.mtime)}`);
        lines.push(`  workspace=${r.project}`);
        if (m.parseError) lines.push(`  ⚠ 读取元信息失败: ${m.parseError}`);
      }
      if (total > shown.length) {
        lines.push('');
        lines.push(`(showing ${shown.length} of ${total}; raise limit or narrow keyword)`);
      }
      lines.push('');
      lines.push('Only the user decides which ids (if any) to import; do not import on your own.');
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'wb_import_session',
    description:
      '把选中的 WorkBuddy 历史会话导入 DeepSeek Harness。'
      + '这会写入真实的 DSH 会话库。不要自行调用：'
      + '只有用户明确给出了会话 id 和目标工作区，并在对话里确认了导入，才可以调用。'
      + '必须提供 sessionIds 和明确的绝对路径 workspaceDir（不要猜）。',
    parameters: {
      type: 'object',
      properties: {
        sessionIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: '要导入的 WorkBuddy 会话 id。' },
        workspaceDir: { type: 'string', description: '导入的会话归到哪个绝对目录下。' },
        compact: {
          type: 'boolean',
          description: '用 WorkBuddy 已生成的摘要折叠早期历史，让会话还能继续对话。'
            + '完整原文会导出到会话文件旁的 full-text.md。',
        },
        recentTurns: {
          type: 'integer', minimum: 1,
          description: '配合 compact 使用：最近多少轮保留原文（默认 40）。',
        },
      },
      required: ['sessionIds', 'workspaceDir'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const out = await doImport(ctx, config, args, exec);
      if (!out.ok) return `Refusing to import: ${out.error}`;
      const lines = [`Imported ${out.imported} / ${out.total}. Target workspace: ${out.cwd}`, ''];
      if (out.ledgerError) {
        lines.push(`⚠ 回滚台账写入失败，这次导入无法用 wb_rollback_import 撤销: ${out.ledgerError}`);
        lines.push('');
      }
      for (const r of out.results) {
        if (r.ok) {
          const d = r.dropped;
          const note = (d.duplicateResults || d.unmatchedResults || d.unpairedCalls || d.orphanBoundary)
            ? `（丢弃：重复结果 ${d.duplicateResults}、无主结果 ${d.unmatchedResults}、未配对调用 ${d.unpairedCalls}、边界孤儿 ${d.orphanBoundary}）`
            : '';
          lines.push(`✓ ${r.id} → ${r.dshId}: ${r.events} events${note}`);
          if (r.cacheWarning) lines.push(`   ⚠ 标题缓存写入失败（侧边栏可能显示"未命名"，点开会话一次即可恢复）: ${r.cacheWarning}`);
          if (r.workspaceWarning) lines.push(`   ⚠ 未挂进目标工作区（会话可能落在"未分组"）: ${r.workspaceWarning}`);
          if (r.compaction?.applied) {
            lines.push(`   📦 压缩导入（replace）：seq ${r.compaction.startSeq}~${r.compaction.endSeq}（${r.compaction.shadowedCount} 个 surface 节点）折叠成摘要（${r.compaction.summaryChars} 字符），保留最近 ${r.compaction.recentTurns} 轮原文；完整原文仍在日志里，可向上翻看`);
          } else if (r.compaction && !r.compaction.applied) {
            lines.push(`   ⚠ 压缩未生效（源里没有可用摘要）: ${r.compaction.reason}`);
          }
          if (r.exportPath) lines.push(`   📄 原文已导出: ${r.exportPath}`);
          if (r.exportWarning) lines.push(`   ⚠ 原文导出失败: ${r.exportWarning}`);
          if (r.closeWarning) lines.push(`   ⚠ close 失败（会话可能仍可用，但写租约未释放）: ${r.closeWarning}`);
        } else {
          lines.push(`✗ ${r.id}: ${r.error}${r.alreadyExists ? ' (already imported)' : ''}`);
        }
      }
      if (out.manifest.length) {
        lines.push('');
        lines.push(`Rollback manifest (recorded to ${ledgerPath()}):`);
        for (const m of out.manifest) lines.push(`  ${m.partial ? '[PARTIAL] ' : ''}${m.dshId}  cwd=${m.cwd}`);
        lines.push('');
        lines.push('要撤销请用 wb_rollback_import。');
      }
      return lines.join('\n');
    },
  });

  ctx.tools.register({
    name: 'wb_rollback_import',
    description:
      '撤销台账里记录的 WorkBuddy 导入。不给 ids 时只列出记录了什么。'
      + '给了 ids（或 all=true）时，只删除这些条目对应的 session-wb-* 目录。'
      + '绝不碰原生 DSH 会话。需要 confirm=true。',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要移除的导入会话 id。' },
        all: { type: 'boolean', description: '移除全部已记录的导入。' },
        confirm: { type: 'boolean', description: '必须为 true 才真正删除。' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      let out;
      try { out = await doRollback(args, ctx); } catch (e) { return `Cannot roll back: ${e?.message ?? e}`; }
      if (out.empty) return 'Ledger is empty — nothing was ever imported by this plugin.';
      if (args.confirm !== true) {
        const lines = [`Recorded imports (${out.entries.length}); nothing deleted (confirm not set):`, ''];
        for (const e of out.entries) lines.push(`  ${e.partial ? '[PARTIAL] ' : ''}${e.dshId}  cwd=${e.cwd}  at=${e.at ? formatDate(e.at) : '?'}`);
        lines.push('');
        lines.push('Call again with confirm=true and ids=[...] (or all=true) to delete.');
        return lines.join('\n');
      }
      const lines = [`Rolled back ${out.deleted} / ${out.entries.length}.`, ''];
      for (const id of out.removed || []) lines.push(`✓ 已删除 ${id}`);
      if (out.skipped?.length) {
        lines.push('');
        lines.push('Skipped (refused for safety):');
        for (const s of out.skipped) lines.push(`  ⚠ ${s.dshId} (${s.reason})`);
      }
      return lines.join('\n');
    },
  });

  ctx.effect(() => () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    logLine(ctx, 'disposed');
  }, 'wb-import-plugin: cleanup');
}
