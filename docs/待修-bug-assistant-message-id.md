# 待修 bug：assistant/message 缺 message.id

日期：2026-11-07 22:30
状态：**已定位，未修**（用户要求先重启，不打断界面）

---

## 报错原文

```
历史加载失败: stored session "session-wb-430ad333-d03c-4f54-bc06-526c2feb6291" is corrupt:
stored session "session-wb-430ad333-d03c-4f54-bc06-526c2feb6291" failed validation:
Error: session event at seq 6 lacks an identified message (gateway/internal)
```

## 根因（已确认）

`seq 6` 是第一条 `assistant/message`。插件的 message 对象**没有 `id` 字段**：

```js
// lib/index.js:302 —— 无 id
message: { role: 'assistant', content, source: { kind: 'model' } },

// lib/index.js:311-314 —— 无 id
message: {
  role: 'assistant',
  content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.args }],
  source: { kind: 'model' },
},

// lib/index.js:375-378 —— 无 id
message: {
  role: 'assistant',
  content: [{ type: 'reasoning', text: pendingReasoning.join('\n') }],
  source: { kind: 'model' },
},
```

对比：`user/message` 和 `tool/result` 都带了 `id: randomUUID()`，只有 assistant 漏了。

宿主校验器要求每条 message 有 first-class `id`（`assertV4ToolResultMessage` 里就有
`requires a first-class message with a string id` 的同类检查）。

## 影响

- 导入的会话**在宿主加载时校验失败** → 打开报 corrupt
- 侧边栏显示「未命名」（因为没有有效投影）

## 修法

给三处 assistant message 都加 `id: randomUUID()`：

1. `emitAssistant()` 里的 `message`（line ~302）
2. `settleCall()` 里 tool-call 广告消息的 `message`（line ~311）
3. 尾部 reasoning 兜底消息的 `message`（line ~375）

## 修完要验证

- 重新跑 `test-full-lifecycle.mjs`（146 个会话）
- **新增断言**：每个 assistant/message 的 message.id 必须是非空字符串
- 补进宿主级校验器 `lifecycle-validator.mjs`：检查 message.id 存在性
- 修完同步 `sync-to-profile.cjs`，再在**安装副本**上跑测试

## 当前磁盘状态

```
~/.dsh/sessions 下有 4 个 session-wb-*（本次导入，都是坏的）：
  session-wb-0de99e16-2ce3-4b36-a727-091a1459966c
  session-wb-430ad333-d03c-4f54-bc06-526c2feb6291
  session-wb-52cb310a-82fd-44de-aa65-a85c6fffb496
  session-wb-a3dcdaf2-e081-4372-ba4a-69cc12d0e836
```

**修好后应先回滚这 4 个**，再重新导入验证。

## 教训

之前的校验器只查了 seq 稠密、surfaceOp、工具三连，**没查 message.id**。
这和之前漏掉 `webServer` inject、漏掉 `Relationships` 生命周期是同一类问题：
**校验器覆盖不全 → 假阳性通过**。

下一轮应把宿主 `assertV4ToolResultMessage` / message 结构校验的规则全部补进校验器。
