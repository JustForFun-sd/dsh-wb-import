/**
 * 反向验证：校验器必须能抓出「assistant/message 缺 id」这个 bug。
 * 用修好前的样本（手工构造）测试，确保校验器不再假阳性。
 */
import { validateLifecycle } from './lifecycle-validator.mjs';

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  ✅ ${l}`); } else { fail++; console.log(`  ❌ ${l}${d ? ' → ' + d : ''}`); } };

/** 构造一个最小合法事件流，可选地去掉某个 message.id */
function build({ dropAssistantId = false, dropUserId = false, dropProviderModel = false, dropStream = false, dropTurnReason = false } = {}) {
  const ev = [];
  let seq = 0;
  const push = (type, data, extra) => { ev.push({ type, seq: seq++, time: 1, data, ...extra }); };

  push('permission/preset', { preset: 'workspace-write' });
  push('turn/start', { turn: 1 });
  push('step/start', { turn: 1, step: 1 });
  push('user/message', {
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
    role: 'user',
    ...(dropUserId ? {} : { id: 'user-1' }),
  }, { surfaceOp: 'append' });
  push('assistant/message', {
    turn: 1, step: 1,
    ...(dropStream ? {} : { stream: [] }),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      source: dropProviderModel ? { kind: 'model' } : { kind: 'model', provider: 'workbuddy', model: 'hy3' },
      ...(dropAssistantId ? {} : { id: 'asst-1' }),
    },
  }, { surfaceOp: 'append' });
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', dropTurnReason ? { turn: 1 } : { turn: 1, reason: { kind: 'completed' } });
  return ev;
}

console.log('=== 合法流 ===');
try {
  validateLifecycle(build());
  check('合法流通过', true);
} catch (e) {
  check('合法流通过', false, e.message);
}

console.log('\n=== 复现原 bug：assistant 缺 id ===');
try {
  validateLifecycle(build({ dropAssistantId: true }));
  check('校验器抓出缺 assistant id', false, '未报错 ← 假阳性');
} catch (e) {
  check('校验器抓出缺 assistant id', /lacks an identified message/.test(e.message), e.message);
}

console.log('\n=== 同类：user 缺 id ===');
try {
  validateLifecycle(build({ dropUserId: true }));
  check('校验器抓出缺 user id', false, '未报错 ← 假阳性');
} catch (e) {
  check('校验器抓出缺 user id', /lacks an identified message/.test(e.message), e.message);
}

console.log('\n=== 复现第二个 bug：assistant source 缺 provider/model ===');
try {
  validateLifecycle(build({ dropProviderModel: true }));
  check('校验器抓出缺 provider/model', false, '未报错 ← 假阳性');
} catch (e) {
  check('校验器抓出缺 provider/model', /must have model source/.test(e.message), e.message);
}

console.log('\n=== 复现第三个 bug：assistant 缺 stream ===');
try {
  validateLifecycle(build({ dropStream: true }));
  check('校验器抓出缺 stream', false, '未报错 ← 假阳性');
} catch (e) {
  check('校验器抓出缺 stream', /invalid settlement fields/.test(e.message), e.message);
}

console.log('\n=== 复现第四个 bug：turn/end 缺 reason ===');
try {
  validateLifecycle(build({ dropTurnReason: true }));
  check('校验器抓出缺 turn/end reason', false, '未报错 ← 假阳性');
} catch (e) {
  check('校验器抓出缺 turn/end reason', /lacks reason/.test(e.message), e.message);
}

console.log('\n=== 报错文案对齐宿主 ===');
try {
  validateLifecycle(build({ dropAssistantId: true }));
} catch (e) {
  check('文案含 "lacks an identified message"', e.message.includes('lacks an identified message'));
  check('文案含 seq 位置', /seq \d+/.test(e.message), e.message);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
