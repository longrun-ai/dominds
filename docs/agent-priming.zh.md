# Agent Priming（启动脚本）设计

英文版：[English](./agent-priming.md)

## 目标

将 priming 统一为“可编辑、可版本化、可回放”的 Markdown 启动脚本能力。

- 脚本即历史：启动脚本本质上是预置对话历史。
- 忠实复原：脚本默认记录并复原完整技术细节（含 `role=tool` 相关记录、`callId` 等关联字段）。
- 显式选择：创建对话时由用户明确选择，不做隐式注入。
- 可见性可控：可选择是否在 UI 展示由脚本注入的历史气泡。

## 存储布局

脚本统一放在 rtws 的 `.minds/priming/` 下：

- 个人脚本：`.minds/priming/individual/<team-member-id>/<slug>.md`
- 团队共享脚本：`.minds/priming/team_shared/<slug>.md`

约束：

- `slug` 由 `[A-Za-z0-9._-]` 路径段组成，可多级。
- 严禁越界路径（绝对路径、`..`、NUL、非法字符）。
- `scriptRef` 统一形如：
  - `individual/<team-member-id>/<slug>`
  - `team_shared/<slug>`

## 脚本格式（严格）

脚本文件采用 `frontmatter + record 块`。

### 顶层 frontmatter（可选）

```yaml
---
kind: agent_priming_script
version: 3
title: 环境探针启动
applicableMemberIds:
  - ux
---
```

### record 块（必填）

每段必须是：`### record <record-type>`。

严格规则：

- 不存在旧写法，不再支持 `### user` / `### assistant`。
- `func_call_record`：使用三重反引号 `json`，内容是完整 JSON 对象。
- 其它 record：使用 markdown block，建议 6 重反引号（``````markdown）避免和正文里的三反引号冲突。
- 非 `func_call_record` 的 markdown block 可在块内使用 frontmatter 记录元字段；正文映射该 record 的主文本字段（如 `content` / `response` / `result`）。

示例：

````markdown
### record human_text_record

```markdown
---
genseq: 1
msgId: priming-1
grammar: markdown
---

先做环境探针。
```
````

### record func_call_record

```json
{
  "type": "func_call_record",
  "genseq": 1,
  "id": "call_probe_1",
  "name": "exec_command",
  "arguments": {
    "cmd": "uname -a"
  }
}
```

### record func_result_record

```markdown
---
genseq: 1
id: call_probe_1
name: exec_command
---

Darwin ...
```

```

## 关于 `~~~markdown`

`~~~markdown` 的历史动机是避免外层 fenced block 与正文三反引号冲突。当前推荐是 6 重反引号 markdown block；解析器仍接受 `~~~` 与不同长度反引号 fenced 风格，但标准导出采用 6 重反引号（`func_call_record` 除外）。

## 创建对话流程（WebUI）

创建对话 modal 的 priming 区域：

- 下拉列表：展示 recent 脚本（后端按 agent 维护，最多 20 条）。
- `<无> 启动脚本`：不注入启动脚本。
- `更多……`：按输入文本实时后端扫描磁盘匹配；确认后回填下拉并选中。
- `UI 展示` 勾选框：控制是否展示脚本注入的历史气泡。

请求结构：

- `create_dialog` 可带 `priming`：
  - `scriptRefs: string[]`（当前 UI 单选，传 0 或 1 项）
  - `showInUi: boolean`

运行时行为：

- 创建 root dialog 后，按 `scriptRefs` 回放脚本。
- 回放事件写入 `course-1`，并统一标记 `sourceTag: priming_script`。
- 同步注入 `dialog.msgs`，确保后续 LLM 上下文可见。
- `showInUi=false` 时仅隐藏展示，不影响持久化与上下文。

## 保存启动脚本（WebUI）

- toolbar 使用图标按钮“保存启动脚本”。
- 提示输入 `slug`，并显示路径：
  `.minds/priming/individual/<当前-agent-id>/<slug>.md`
- 若目标文件存在，必须确认覆盖。

导出规则：

- 从当前 course 导出完整 record 历史。
- 空历史禁止导出。
- frontmatter 记录来源对话（rootId/selfId/course/status）。

## recent 使用记录

- 后端按 agent 保存：`<rtws>/.dialogs/recent-priming/<agent-id>.json`
- 最多 20 条（写入时裁剪）。
- recent 列表每次从后端读取。
- 仅在“创建对话成功”时记录 recent。
```
