# dsh-wb-import

把 **WorkBuddy** 的历史会话导入 **DeepSeek Harness (DSH)**。

带图形界面：浏览 WorkBuddy 会话、勾选要导入的、选目标工作区、一键导入。
导入的会话可以回滚；长会话可以选择压缩导入（保留完整原文，只压缩发给模型的上下文）。

---

## 为什么需要它

WorkBuddy 和 DSH 是两套独立的智能体系统，会话格式完全不同、互不相通。
如果你在 WorkBuddy 里积累了大量历史会话，想在 DSH 里继续用，需要做格式转换。

这个插件做这件事——而且做得足够小心：

- 导入的会话能正常打开、能继续对话
- 标题、工作区归属都对
- 记录台账，随时可回滚
- 原文完整保留，向上翻能看到全部历史

---

## 安装

```bash
# 在你的 DSH profile 目录里
cd ~/.dsh/profiles/<profile>     # Windows: %USERPROFILE%\.dsh\profiles\<profile>
npm install <path-or-git-url-of-this-repo>
```

然后在 profile 的 `package.json` 里把这个插件加进 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-wb-import"]
    }
  }
}
```

重启 DSH。

---

## 使用

### 图形界面

打开 **设置 → 插件 → WorkBuddy 导入**。

```
┌─ WorkBuddy 导入 ──────────────────────────── 146 条 ─┐
│ [筛选标题…]  [刷新列表]                    已选 0 个 │
│ ┌──────────────────────────────────────────────────┐│
│ │ ☐ 标题              大小   更新时间  工作区      ││
│ │ ☑ 调研 X 部署方案   3.2MB  11-08      spark      ││
│ │ ☐ 收集 Y 报告       1.1MB  11-07      misc       ││
│ └──────────────────────────────────────────────────┘│
│ 导入到哪个工作区目录                                 │
│ [D:\Users\me\DSH\workspace]  [浏览…]                 │
│ ☐ 压缩导入（长会话用，保留原文+压缩上下文）  [40] 轮 │
│                                                      │
│ [          导入选中的会话          ]                 │
│ ────────────────────────────────────────────────────│
│ 导入台账（可回滚）                        [回滚选中] │
└──────────────────────────────────────────────────────┘
```

**整行都能点**——点标题、大小、时间任意位置都能选中，不用瞄准小复选框。

### 模型工具

也可以让模型调用：

| 工具 | 作用 |
|---|---|
| `wb_list_sessions` | 列出 WorkBuddy 会话 |
| `wb_import_session` | 导入指定会话（**需要用户明确同意**） |
| `wb_rollback_import` | 回滚（删掉导入的会话） |

---

## 压缩导入

### 为什么需要

WorkBuddy 的会话经常有几百万 token。直接导入会远超模型上下文窗口，
**没法继续对话**。

### 怎么做

插件用 **WorkBuddy 自己生成的摘要**（`<cb_summary>`）把早期历史折叠起来，
但**原文全部保留在会话日志里**——用 DSH 自己的 `surfaceOp: "replace"` 机制：

```
日志（session.v4.jsonl.zstd）：  完整原文，一条不删
surface（发给模型）：            早期折叠成摘要，最近 N 轮保留原文
```

**结果**：
- 向上翻「加载更早」→ **能看全部原文**
- 发给模型 → **压缩后的上下文**（几十万 token）

和 DSH 自己的压缩行为完全一致。

### 效果参考

一个 178 轮、7048k token 的会话：

| | 数值 |
|---|---|
| 日志全文 | 13.79M 字符（可翻看） |
| surface 折叠后 | 0.55M 字符 ≈ 189k token（发给模型） |

### 前提

源会话里要有 `<cb_summary>`。WorkBuddy 会在上下文压缩时生成它。
从没被压缩过的会话没有摘要，压缩会失败并明确提示。

---

## 安全设计

导入会**写入真实的 DSH 会话库**，所以做了这些保护：

- **台账**：每次导入记录到 `~/.dsh/wb-import-ledger.json`，可精确回滚
- **回滚只删自己创建的**：只删 `session-wb-*` 前缀的会话，且有 5 道校验
  （路径绝对、无 `..`、父目录匹配、台账来源等）
- **不静默兜底**：工作区路径不合法就明确报错，不会猜测
- **不自动导入**：工具描述明确写"Do NOT call it on your own initiative"，
  必须用户明确同意
- **原文导出**：压缩导入时把原文导出到 `full-text.md`，多一份备份

---

## 已知限制

- 只导入 `message` / `reasoning` / `function_call*` / `ai-title` 这几类记录；
  附件、文件历史快照不迁移
- 跨模型继续对话时，思考内容降级为普通文本
- 工具调用都归到 `step=1`（WorkBuddy 没有 step 概念）
- 压缩依赖 WorkBuddy 的摘要，没有摘要的会话不能压缩

---

## 技术细节

如果你要改这个插件，**先读 [docs/会话格式修复记录.md](docs/会话格式修复记录.md)**——
那里记录了 DSH 会话格式的 10 个坑，每个都对应一段校验器源码，是本项目最有参考价值的部分。
（这份文档随 npm 包一起分发。）

要点：

- DSH 有**两套校验**：宿主加载校验 + 前端渲染校验。前者过了不代表后者能过
- `assistant/message` 必须有 `message.id`、`source.provider/model`、`stream`
- `turn/end` 必须有 `reason`
- 每轮要有几十上百个 step（不是整轮一个）
- 压缩事件必须成组：`compaction/start` → `compaction/summary` →
  `user/message replace(...)` → `compaction/end`
- `compaction/start` 的 `turn` 必须等于当前打开的 turn

---

## License

MIT
