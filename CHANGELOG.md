# Changelog

## 0.5.2

- **UI**：导入按钮移到所有选项下方（全宽）——先定选项，再按动作
- **UI**：会话列表整行可点击（不用瞄准小复选框），选中行高亮

## 0.5.1

- **修复**：`compaction/start` 要求 `turn` 等于当前打开的 turn。
  会话常在轮次中途结束（末尾没有 `turn/end`），此时写 `turn: null` 会报
  "compaction/start does not match the open turn"。现在压缩前先补 `turn/end`。

## 0.5.0

- **压缩改用 `surfaceOp: "replace"` 模式**：原文全部保留在日志里，
  surface 上折叠成摘要。向上翻能看全部原文，发给模型的是压缩版。
  （之前的做法是不写原文，导致向上翻很快就到头）
- **压缩事件成组配对**：`compaction/start` → `compaction/summary` →
  `user/message replace(...)` → `compaction/end`，`compactionId` 一致

## 0.4.2

- **修复**：压缩时 `ai-title` 记录被切掉，导致导入后标题变成「未命名」。
  现在把被切掉的 `ai-title` 全部捞回来。

## 0.4.1

- 折叠段（已被 0.5.0 取代）

## 0.4.0

- **压缩导入**：用 WorkBuddy 现成摘要替代早期历史（不调 LLM）
- **异步导入**：`POST /import` 立即返回 jobId，前端轮询 `/import/status`
- 原文自动导出到 `full-text.md`

## 0.3.0

- 导入产物分批写帧（批次 20），fsync 次数少一半，导入快 42%
- 修复标题取最后一条 `ai-title` 的问题（应取第一条 = 原始标题）
- 过滤系统注入的假用户发言（摘要 / 通知 / 续接指令）

## 0.2.0

- 图形界面（设置页）
- 应用内目录浏览器（适配 `browse` 后端的 `directoryPicker`）
- 新建目录按钮（用应用内输入框，不用 `window.prompt`）
- 投影缓存写入（侧边栏直接显示标题）
- 导入后挂进目标工作区（`attachSession`）

## 0.1.0

- 初始版本：三个模型工具 + 台账 + 回滚
