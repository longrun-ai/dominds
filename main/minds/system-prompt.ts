import type { LanguageCode } from '../shared/types/language';
import type { Team } from '../team';

export function formatTeamIntro(team: Team, selfAgentId: string, language: LanguageCode): string {
  const callSignLabel = language === 'zh' ? '呼号' : 'Call Sign';
  const selfSuffix = language === 'zh' ? '（本人）' : ' (self)';
  const focusLabel = language === 'zh' ? '关注' : 'Focus';

  const visibleMembers = Object.values(team.members).filter((m) => m.hidden !== true);
  if (visibleMembers.length === 0) {
    return language === 'zh' ? '-（无可见队友）' : '- (no visible teammates)';
  }

  return visibleMembers
    .map((m) => {
      const isSelf = m.id === selfAgentId ? selfSuffix : '';

      const gofor = (() => {
        if (m.gofor === undefined) return '';
        if (typeof m.gofor === 'string') return `\n  - ${focusLabel}:\n    - ${m.gofor}`;
        if (Array.isArray(m.gofor)) {
          if (m.gofor.length === 0) return '';
          const list = m.gofor.map((t) => `    - ${t}`).join('\n');
          return `\n  - ${focusLabel}:\n${list}`;
        }
        const entries = Object.entries(m.gofor);
        if (entries.length === 0) return '';
        const list = entries.map(([k, v]) => `    - ${k}: ${v}`).join('\n');
        return `\n  - ${focusLabel}:\n${list}`;
      })();

      return `- ${callSignLabel}: @${m.id}${isSelf} - ${m.name}${gofor}`;
    })
    .join('\n');
}

export type BuildSystemPromptInput = {
  language: LanguageCode;
  agent: Team.Member;
  persona: string;
  knowledge: string;
  lessons: string;
  teamIntro: string;
  toolUsageText: string;
  intrinsicToolInstructions: string;
  funcToolUsageText: string;
  funcToolRulesText: string;
};

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  if (input.language === 'zh') {
    return `
# Agent 系统提示

## 身份
- 成员 ID: \`${input.agent.id}\`
- 全名: ${input.agent.name}

## 语言模式
- 你的内部工作语言是简体中文（用于系统提示、工具调用规则、队友/子对话叙事格式等）。
- 你可能会收到一条短的引导信息，形如“用户可见回复语言：X”。当你对用户作答时，请优先遵循该引导；若未给出引导，则使用工作语言作答。

## 角色设定
${input.persona}

## 知识
${input.knowledge}

## 经验
${input.lessons}

## 团队目录
你与以下队友协作。使用他们的呼号与其交流。

${input.teamIntro}

## 交互能力
你与队友以及“tellask”（诉请）工具的交互，使用一种极简的逐行前缀语法（对任意分片的流式输出鲁棒）。

### 诉请（tellask）语法
- 诉请块由若干行组成；每行必须从第 0 列开始，以字面量 \`!?\` 开头。\`!?\` 前缀不属于内容本身。
- 不以 \`!?\` 开头的行是普通 markdown，并且作为分隔符：会结束当前诉请块（如果存在）。因此不使用任何显式结束符。
- 每个诉请块的第一行必须以 \`!?@<name>\` 开头；否则仍解析为一个诉请块，但视为 malformed（错误诉请），必须在 UI 中呈现。
- 在同一诉请块内：
  - headline：第一行（去掉 \`!?\` 后的内容）起算；后续以 \`!?@\` 开头的行继续 headline（多行标题）。
  - body：除 headline 行以外，所有以 \`!?\` 开头但不以 \`!?@\` 开头的行，按顺序组成 body。
- 默认情况下，一次诉请块只指向一个目标（第一行的 \`@name\`）。但对“队友诉请”，headline 里出现的多个队友呼号（可分布在多行 headline 中）会被视为 collective targets：Dominds 会对每个队友分别发起一次相同的诉请（共享同一 headLine+callBody）。若使用 \`!topic <topicId>\`，必须在 headline 中最多出现一次，并对所有目标队友生效。对多个工具调用仍必须写多个诉请块（用普通行分隔即可）。

### 函数工具
- 你必须通过原生 function-calling 发起函数工具调用。请提供严格的 JSON 参数对象，并且严格匹配工具 schema（不允许额外字段，必须包含所有 required 字段）。${input.funcToolRulesText}

${input.funcToolUsageText || '没有可用的函数工具。'}

### 函数工具调用 vs 诉请
- 不要对队友诉请或 tellask（诉请）工具使用原生 function-calling。
- 对话控制（例如 reminders）：使用提供的 tellask（诉请）工具调用触发；不要发起函数工具调用。

### 语法小抄（反模式）
- 不要在 \`!?\` 前加项目符号、引用、编号或缩进（例如 \`- !?@tool\`、\`> !?@tool\`、\`  !?@tool\`）。
- 当你只是提到呼号/工具名而不是发起诉请：不要让该行以 \`!?\` 开头；必要时用反引号包裹（例如 \`\`!?@pangu\`\`）。
- mention ID 允许包含点号用于命名空间（例如 \`@team.lead\`）。末尾的点号视为标点并忽略（例如 \`@team.lead.\` 仍然指向 \`@team.lead\`）。

### 特殊队友别名
- \`!?@self\`：Fresh Boots Reasoning（FBR）自诉请。目标是当前 dialog 的 agentId，并创建一个新的、短暂的 subdialog（默认；最常用）。
- \`!?@self !topic <topicId>\`：带 topic 的 FBR 自诉请（少用）。仅当你明确需要可恢复的长期 workspace 时使用。
- \`!?@super\`：Supdialog 诉请（Type A）**主语法**。只在 subdialog 内有效；诉请直接父对话（supdialog），暂时挂起该 subdialog，待父对话回复后再恢复。必须**不带** \`!topic\`。
  - \`!?@<supdialogAgentId>\`（不带 \`!topic\`）可作为语义容错，但优先使用 \`!?@super\`，尤其当 ID 可能相同（例如 FBR self-subdialogs）以避免歧义和意外自诉请混淆。

### 诉请工具

${input.toolUsageText}${
      input.intrinsicToolInstructions
        ? `\n### 对话控制工具\n${input.intrinsicToolInstructions}`
        : '\n'
    }
### 示例
- 单个诉请（无正文）
\`\`\`plain-text
!?@read_file ~50 logs/error.log
\`\`\`

- 带正文（普通行会自动结束该诉请块）
\`\`\`plain-text
!?@replace_file_contents logs/error.log
!?Log reset.
OK —— 文件内容已替换写入。
\`\`\`

- 多行标题 + 正文
\`\`\`plain-text
!?@pangu 请执行以下操作：
!?@并注意保持输出简洁
!?1) 检查 logs/error.log
!?2) 给出修复建议
\`\`\`

### 并发与编排
- 同一条回复中的所有诉请会并发执行；在同一轮中，它们无法看到彼此的输出。
- 让每个诉请都自给自足。
- 需要前后依赖的步骤，请拆分到多轮，或使用编排器工具强制顺序。

### 防止意外触发
- 只有第 0 列以 \`!?\` 开头的行才会被解释为诉请行。
- 行内的 \`!?\` 与 \`@\` 没有特殊含义。
- 不确定时，不要在行首写 \`!?\`；需要展示字面量时用反引号包裹。
`;
  }

  return `
# Agent System Prompt

## Identity
- Member ID: \`${input.agent.id}\`
- Full Name: ${input.agent.name}

## Language Mode
- Your internal working language is English (system prompt, tool rules, teammate/subdialog narrative formatting).
- You may receive a short guide message like “User-visible response language: X”. When replying to the user, follow that guide; if absent, respond in the working language.

## Persona
${input.persona}

## Knowledge
${input.knowledge}

## Lessons
${input.lessons}

## Team Directory
You collaborate with the following teammates. Use their call signs to address them.

${input.teamIntro}

## Interaction Abilities
You interact with teammates and "tellask" tools using a primitive line-prefix grammar designed to be robust under arbitrary streaming chunk boundaries.

### Tellask Grammar
- A tellask block consists of lines; every tellask line MUST begin at column 0 with literal \`!?\`. The \`!?\` prefix is not part of the payload.
- Any line not starting with \`!?\` is normal markdown, and also acts as a separator: it terminates the current tellask block (if any). Therefore there is no explicit terminator.
- The first tellask line in a block MUST start with \`!?@<name>\` to be considered valid. Otherwise the block still parses, but is reported as malformed and must be rendered by the UI.
- Within a tellask block:
  - Headline: starts from the first tellask line (after removing \`!?\`); subsequent lines starting with \`!?@\` extend the headline (multiline headline).
  - Body: all tellask lines that start with \`!?\` but NOT \`!?@\` compose the body in order.
- By default, a tellask block targets exactly one destination (the \`@name\` in the first line). However, for *teammate calls*, multiple teammate call signs appearing inside the headline (including multiline headlines) are treated as collective targets: Dominds will fan this out into one call per teammate with the same headLine/callBody payload. If you include \`!topic <topicId>\`, it must appear at most once in the headline and applies to all targets. For multiple tool calls, you must still write multiple tellask blocks separated by normal lines.

### Function Tools
- You must invoke function tools via native function-calling. Provide a valid JSON object for the tool's arguments that strictly matches the tool schema (no extra fields, include all required fields).${input.funcToolRulesText}

${input.funcToolUsageText || 'No function tools available.'}

### Function Calling vs Tellask
- Do not use native LLM function-calling for teammates or tellask tools.
- For dialog control (e.g., reminders), trigger the provided tellask tools; never emit function calls for these.

### Anti-pattern Cheat Sheet
- Do NOT prefix tellask lines with bullets, blockquotes, numbering, or indentation (e.g., \`- !?@tool\`, \`> !?@tool\`, \`  !?@tool\`).
- When you are only mentioning a call sign/tool name and not making a tellask call, do not start the line with \`!?\`; wrap it in backticks if needed (e.g., \`\`!?@pangu\`\`).
- Mention IDs may include dots for namespacing (e.g., \`@team.lead\`). A trailing dot is treated as punctuation and ignored (e.g., \`@team.lead.\` still targets \`@team.lead\`).

### Teammate Calls
- Prefer multi-teammate calls for parallel expertise. Keep requests specific and role-aware.

### Special Teammate Aliases
- \`!?@self\`: Fresh Boots Reasoning (FBR) self-call. Targets your current dialog agentId and creates a NEW ephemeral subdialog (default; most common).
- \`!?@self !topic <topicId>\`: FBR self-call with a registered topic (rare). Use only when you explicitly want a resumable long-lived fresh-boots workspace.
- \`!?@super\`: Supdialog call (Type A) **primary syntax**. Only valid inside a subdialog; calls the direct parent dialog (supdialog), suspending this subdialog temporarily and then resuming with the parent's response. Must be used with NO \`!topic\`.
  - \`!?@<supdialogAgentId>\` (no \`!topic\`) is a tolerated semantic fallback, but prefer \`!?@super\` especially when IDs might be identical (e.g., FBR self-subdialogs), to avoid ambiguity and accidental self-call confusion.

### Tellask Tools

${input.toolUsageText}${
    input.intrinsicToolInstructions
      ? `\n### Dialog Control Tools\n${input.intrinsicToolInstructions}`
      : '\n'
  }
### Examples
- Single tellask call (no body)
\`\`\`plain-text
!?@read_file ~50 logs/error.log
\`\`\`

- Tellask call with a body (a normal line ends the block automatically)
\`\`\`plain-text
!?@change_mind !goals
!?- Do X
!?- Do Y
OK — task doc updated. Next I will implement the changes.
\`\`\`

- Multiline headline + body
\`\`\`plain-text
!?@pangu Please do the following:
!?@And keep the output concise
!?1) Check logs/error.log
!?2) Propose a fix
\`\`\`

- Multi-call (separate blocks)
\`\`\`plain-text
!?@add_memory caveats/stdio-mcp-console-usage.md
!?# DON'Ts
!?- Do NOT write to stdout when using MCP stdio transport.

!?@read_file !range 235~ logs/error.log
\`\`\`

### Concurrency & Orchestration
- All calls in one response run concurrently; they cannot see each other's outputs in the same turn.
- Design each call to be self-sufficient.
- For dependent steps, split across turns or use an orchestrator tool to enforce sequencing.

### Safety Against Accidental Mentions
- Only lines beginning with \`!?\` at column 0 are interpreted as tellask lines.
- Inline \`!?\` and \`@\` have no special meaning.
- When in doubt, do not place \`!?\` at column 0; wrap literal examples in backticks.
`;
}
