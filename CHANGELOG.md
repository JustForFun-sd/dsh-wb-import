# Changelog

## 0.6.1

- **界面全中文**：设置页文案此前有一份英文版（`COPY.en`），现在统一为中文。
- **工具描述中文**：三个模型工具的说明和参数描述改为中文（含「不要自行调用」等安全约束）。
- **错误消息中文**：用户可见的错误提示（参数校验、路径校验、导入失败）改为中文。
  保留 `absolute` 等关键英文词，便于检索。
- **GitHub About**：`package.json` 的 description 改为中文，仓库简介因此显示中文。

## 0.6.0

- **修复**：单轮会话（或最后一轮）没有生成 `turn/end`，留下永远敞开的 turn。
  宿主校验会判不合法，前端把「打开的轮次」当成还在生成，渲染卡住。
  现在末尾统一关闭最后一个 turn。
- **修复**：`resolveWorkspaceDir` 无条件把 `/` 改写成 `\`，在 Linux 上把
  `/tmp/x` 变成非绝对的 `\tmp\x`。导入和回滚对 workspace key 的理解不一致，
  导致回滚静默删不掉任何东西。现在只在 Windows 上做归一化。
- **安全**：原文导出把调用方给的 session id 直接拼进文件路径。构造的 id
  （如 `../../../evil`）可以把 `full-text.md` 写到会话根目录之外。现在要求
  解析后的路径仍在根目录内且 basename 符合预期，否则拒绝。
- **CI**：新增 GitHub Actions —— 语法检查、package/cordis 校验、两个测试、
  npm 包内容检查、README 链接检查、本机用户名泄露检查（Ubuntu/Windows × Node 20/22）。
  `test/test-import-shape.mjs` 不需要真实会话数据：自己造源会话、导入、再校验产物。
- **安全扫描**：新增 CodeQL（security-extended，push/PR/每周定时/手动触发）。
- **文档**：`docs/会话格式修复记录.md` 随包分发；新增 Issue 模板。

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
