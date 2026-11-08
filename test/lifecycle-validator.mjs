/**
 * 宿主级生命周期校验器：完整复刻 DSH Relationships 类对会话事件流的校验规则。
 * 源码依据：app.asar 内 dsh-session-format-v3-to-v4.js 的 Relationships（line 540-824）。
 *
 * 覆盖规则：
 *   - turn/start 必须匹配 nextTurn（从 1 开始）；清空工具表
 *   - step/start 必须匹配 open turn 与 nextStep；step/end 后 nextStep+1
 *   - turn/end 必须匹配 open turn、无 open step；closeTools（零未结算 call）
 *   - step/end closeTools：任何未结算 call 都抛错
 *   - assistant/message content 的 tool-call 块 = 广告；同一 callId 不得广告两次
 *   - tool/call：必须已广告、未开始、name/arguments 与广告一致
 *   - tool/result(append)：必须已开始；结算后删除（第二个 result 会抛 no lifecycle）
 *   - assistant/tool/call/tool/result 必须带匹配 open turn/step 的坐标
 *   - seq 稠密、surface 事件必须带 surfaceOp:"append"
 */
export function validateLifecycle(events) {
  let turn = null;
  let step = null;
  let nextTurn = 1;
  let nextStep = 1;
  const tools = new Map();   // id -> { name, arguments, started }

  const requireTurn = (type) => {
    if (turn === null) throw new Error(`${type} is outside an open turn`);
  };
  const requireStep = (type, data) => {
    if (turn === null || step === null || data.turn !== turn || data.step !== step) {
      throw new Error(`${type} does not match an open turn and step`);
    }
  };
  const closeTools = (type) => {
    if (tools.size !== 0) throw new Error(`${type} leaves unresolved tool call ${String(tools.keys().next().value)}`);
    tools.clear();
  };

  for (const [i, event] of events.entries()) {
    if (event.seq !== i) throw new Error(`seq not dense at ${i}`);
    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start':
        if (turn !== null || data.turn !== nextTurn) throw new Error('turn/start does not open the expected turn');
        turn = nextTurn;
        nextStep = 1;
        tools.clear();
        break;
      case 'turn/end':
        if (turn === null || data.turn !== turn || step !== null) throw new Error('turn/end does not match the open turn with no open step');
        // 前端读 data.reason.kind —— 缺失会让整个对话窗口渲染失败
        if (!data.reason || typeof data.reason !== 'object' || typeof data.reason.kind !== 'string') {
          throw new Error(`turn/end at seq ${i} lacks reason (frontend reads reason.kind)`);
        }
        closeTools(event.type);
        turn = null;
        nextTurn += 1;
        break;
      case 'step/start':
        if (turn === null || step !== null || data.turn !== turn || data.step !== nextStep) {
          throw new Error('step/start does not match the open turn and next step');
        }
        step = nextStep;
        break;
      case 'step/end':
        requireStep(event.type, data);
        closeTools(event.type);
        step = null;
        nextStep += 1;
        break;
      case 'assistant/message':
      case 'tool/call':
      case 'tool/result': {
        requireTurn(event.type);
        requireStep(event.type, data);
        // 宿主对每条 message 要求 first-class id（缺失会报
        // "session event at seq N lacks an identified message"）。
        // 这条以前漏掉了，导致假阳性通过。
        if (event.type === 'assistant/message' || event.type === 'tool/result') {
          const msg = data.message;
          if (!msg || typeof msg !== 'object') throw new Error(`${event.type} requires a message object`);
          if (typeof msg.id !== 'string' || msg.id.length === 0) {
            throw new Error(`${event.type} at seq ${i} lacks an identified message (missing message.id)`);
          }
          if (msg.role !== (event.type === 'assistant/message' ? 'assistant' : 'tool')) {
            throw new Error(`${event.type} has the wrong message role: ${msg.role}`);
          }
          if (!Array.isArray(msg.content)) throw new Error(`${event.type} requires an array content`);
          // source 校验（宿主 assertMessageEventShape）
          const src = msg.source;
          if (!src || typeof src !== 'object' || typeof src.kind !== 'string' || src.kind === '') {
            throw new Error(`${event.type} message has invalid source`);
          }
          if (event.type === 'assistant/message') {
            if (src.kind !== 'model' || typeof src.provider !== 'string' || !src.provider
              || typeof src.model !== 'string' || !src.model) {
              throw new Error(`${event.type} at seq ${i} message must have model source`);
            }
          } else {
            if (src.kind !== 'tool' || typeof src.callId !== 'string' || !src.callId) {
              throw new Error(`${event.type} message must have tool source`);
            }
            if (msg.toolCallId !== src.callId) throw new Error(`${event.type} message has mismatched tool call ids`);
          }
        }
        if (event.type === 'assistant/message') {
          const msg = data.message;
          // settlement fields（宿主 assertAssistantSettlementShape）：
          // turn/step 必须是非负整数，stream 必须是数组（空数组合法）。
          if (!Number.isSafeInteger(data.turn) || data.turn < 0) {
            throw new Error(`${event.type} at seq ${i} has invalid settlement fields (turn)`);
          }
          if (!Number.isSafeInteger(data.step) || data.step < 0) {
            throw new Error(`${event.type} at seq ${i} has invalid settlement fields (step)`);
          }
          if (!Array.isArray(data.stream)) {
            throw new Error(`${event.type} at seq ${i} has invalid settlement fields (stream must be an array)`);
          }
          for (const block of msg.content) {
            if (block.type !== 'tool-call') continue;
            if (tools.has(block.id)) throw new Error(`assistant/message repeats advertised tool call ${block.id}`);
            tools.set(block.id, { name: block.name, arguments: block.arguments, started: false });
          }
        } else {
          const msg = event.type === 'tool/result' ? data.message : undefined;
          const id = msg ? msg.toolCallId : data.callId;
          const pending = tools.get(id);
          if (pending === undefined) throw new Error(`${event.type} ${id} has no advertised tool lifecycle`);
          if (msg === undefined) {
            if (pending.started || pending.name !== data.name || pending.arguments !== data.arguments) {
              throw new Error(`tool/call ${id} does not match one advertised tool call`);
            }
            pending.started = true;
          } else {
            if (!pending.started) throw new Error(`tool/result ${id} is not the exact TOOL_NOT_STARTED repair`);
            tools.delete(id);
          }
        }
        break;
      }
      case 'user/message': {
        // 宿主对 user/message 不做 turn/step 坐标校验，但同样要求 first-class id
        if (typeof data.id !== 'string' || data.id.length === 0) {
          throw new Error(`user/message at seq ${i} lacks an identified message (missing id)`);
        }
        if (data.role !== 'user') throw new Error(`user/message has the wrong role: ${data.role}`);
        if (!Array.isArray(data.content)) throw new Error('user/message requires an array content');
        const usrc = data.source;
        if (!usrc || typeof usrc !== 'object' || typeof usrc.kind !== 'string' || usrc.kind === '') {
          throw new Error(`user/message at seq ${i} message has invalid source`);
        }
        break;
      }
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
      case 'session/end-seed':
      // 宿主在会话被续写/打开后追加的运行时事件（导入产物里通常没有）。
      // 它们不参与工具生命周期，原样放行即可。
      case 'agent/inbox/spliced':
      case 'request/header':
      case 'request/context':
      case 'assistant/attempt':
      case 'system/message':
      case 'model/selection':
      case 'goal/change':
      case 'todo/write':
      case 'plan/mode':
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
      case 'compaction/prune':
      case 'llm/retry':
      case 'llm/retry-started':
      case 'session/title-llm-request':
      case 'command/run':
      case 'command/done':
      case 'deliverables/presented':
      case 'feedback/record':
      case 'feedback/message-put':
      case 'feedback/message-delete':
      case 'hook/invoked':
      case 'hook/result':
      case 'working-directory/change':
      case 'workspace/changes':
      case 'agent-preset/selected':
      case 'image/offload':
      case 'job/registered':
      case 'job/settled':
      case 'subagent/catalog':
      case 'subagent/descriptor':
      case 'subagent/model-selection-policy':
      case 'team/member':
      case 'team/message/delivered':
      case 'team/message/queued':
      case 'team/task':
      case 'tool/ptc-dispatch':
      case 'tool/ptc-dispatch-start':
      case 'tool-workflow/agent-start':
      case 'tool-workflow/agent-end':
      case 'tool-workflow/run-start':
      case 'tool-workflow/run-end':
      case 'web/deepseek-search-llm-request':
      case 'schedule/change':
      case 'session-log-deepseek/delivery-accepted':
        break;
      case 'session/title': {
        // 宿主 titleSources：messageSeqs 为空 ⟺ source.kind==='user'；
        // 非空时必须引用更早的、kind=user 的 user/message 事件，且互不重复
        const refs = Array.isArray(data.messageSeqs) ? data.messageSeqs : [];
        const isUser = data.source?.kind === 'user';
        if ((refs.length === 0) !== isUser) throw new Error('session/title messageSeqs must be empty exactly for a user title');
        const seen = new Set();
        for (const ref of refs) {
          if (ref >= events.indexOf(event)) throw new Error('title messageSeqs must cite earlier events');
          if (seen.has(ref)) throw new Error('title messageSeqs must be distinct');
          seen.add(ref);
          const src = events[ref];
          if (src?.type !== 'user/message' || src.data?.source?.kind !== 'user') {
            throw new Error('title messageSeqs must cite human user/message events');
          }
        }
        break;
      }
      default:
        throw new Error(`unexpected event type ${event.type}`);
    }
  }
  return true;
}
