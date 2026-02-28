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
  dialogScope: 'mainline' | 'sideline';
  agent: Team.Member;
  persona: string;
  knowledge: string;
  lessons: string;
  envIntro: string;
  teamIntro: string;
  funcToolRulesText: string;
  policyText: string;
  intrinsicToolUsageText: string;
  toolsetManualIntro: string;
};

type DialogScope = BuildSystemPromptInput['dialogScope'];

type LocalizedValue<T> = Readonly<{
  zh: T;
  en: T;
}>;

function pickLocalized<T>(language: LanguageCode, localized: LocalizedValue<T>): T {
  return language === 'zh' ? localized.zh : localized.en;
}

function buildFbrContextHealthScopeRule(scope: DialogScope, language: LanguageCode): string {
  if (scope === 'mainline') {
    return pickLocalized(language, {
      zh: '- 系统会持续自动监控上下文健康度：没有吃紧/告急提示时，可以安全进行 FBR。如果有吃紧/告急提示，系统会提醒你，应先处理（提炼 + clear_mind）。随后基于当前可观测事实调用 \\`change_mind\\` 更新差遣牒，体现任务最新进展情况。FBR 自诉请正文不要冗余包含差遣牒已有信息。',
      en: '- Before every FBR, the system will automatically alert on context health status: if there are no yellow/red alerts, you can safely proceed with FBR. If there are yellow/red alerts, handle them first (distill + clear_mind). Then call \\`change_mind\\` based on currently observable facts to update the Taskdoc with the latest task progress; do not redundantly include information already present in the Taskdoc in the FBR FBR body.',
    });
  }
  return pickLocalized(language, {
    zh: '- 系统会持续自动监控上下文健康度：没有吃紧/告急提示时，可以安全进行 FBR。如果有吃紧/告急提示，系统会提醒你，应先处理。随后基于当前可观测事实分析是否与差遣牒内容存在差异，并将发现的情况包含在 FBR 自诉请正文中。',
    en: '- Before every FBR, the system will automatically alert on context health status: if there are no yellow/red alerts, you can safely proceed with FBR. If there are yellow/red alerts, handle them first. Then analyze whether currently observable facts differ from the Taskdoc, and include the findings in the FBR FBR body.',
  });
}

function buildFbrPhaseContract(language: LanguageCode): string {
  const lines = pickLocalized(language, {
    zh: [
      '- FBR 必须按“发起 → 逐轮推理 → 上游回帖”三段执行：发起 `freshBootsReasoning` 只代表发起，不代表你已完成推理。',
      '- 发出 `freshBootsReasoning` 后，必须在该 FBR 子对话内按序走完整个 N 轮流程；只有最后一轮才会回帖给上游。',
      '- 若 \\`fbr-effort = N\\`（力度 N，内部映射为 N 次串行推理），等待该 FBR 子对话一次性完整回帖；收到全量回帖后完成提炼并据此做下游决策；不得基于未完成中间轮次提前定稿。',
      '- 每一轮都应给出与此前不同的增量观点；每轮均不得复述前文结论。程序会把该 FBR 全量支线正文在最后一轮合并后回贴到上游。',
    ],
    en: [
      '- FBR MUST follow three phases: “initiate -> serial reasoning rounds -> upstream update”. Calling `freshBootsReasoning` means initiation only, not completed reasoning.',
      '- After calling `freshBootsReasoning`, run all required rounds in that single FBR sideline window; only the final round may post upstream.',
      '- If \\`fbr-effort = N\\` (intensity N, internally mapped to N serial passes), wait for the complete sideline response from the final pass; after receiving the full reply, distill it before downstream action. Do not finalize based on partial passes.',
      '- Every round must add a distinct incremental view. Every round, including the final one, must not repeat conclusions from earlier rounds. Runtime will relay the full accumulated FBR sideline output upstream in a single upstream-visible message.',
    ],
  });
  return lines.join('\n');
}

function buildTeammateTellaskPhaseContract(language: LanguageCode): string {
  const lines = pickLocalized(language, {
    zh: [
      '- 队友诉请必须遵循“发起 → 等待 → 判定 → 续推”四段协议：若目标未达成，立即发出下一轮诉请推进。',
      '- 对队友诉请而言，收到回贴即表示该轮调用已结束；不存在“对方仍在后台继续执行同一诉请”的默认语义。要继续必须显式再发一轮诉请函数（通常 \\`tellask\\` 复用同一 \\`sessionSlug\\`）。',
      '- 只有在存在明确 pending tellask 时，才可声明“等待回贴/等待结果”；否则必须执行下一动作（直接诉请或本地执行）。',
      '- 能由队友诉请完成的执行性工作，禁止转交 \\`askHuman\\` 做“转发员”；当你写“让 @X 执行 Y”时，必须在同一回复内直接发出 \\`tellask\\` 或 \\`tellaskSessionless\\`。',
      '- 当你在诉请正文里定义“回贴格式/交付格式”时，必须明确写入：`Dominds 会自动注入回贴标记，禁止手写标记`；不得要求被诉请者手写 `【最终完成】` / `【tellaskBack】` / FBR 标记。',
      '- 当你处于队友诉请触发的支线且需要澄清时，必须使用 \\`tellaskBack\\` 回问上游诉请者；\\`tellaskBack\\` 不携带 \\`sessionSlug\\`。',
      '- 回贴文本标记由运行时在跨对话传递正文中按语义自动添加（例如 `tellaskBack` / `最终完成` / FBR 标记）；该传递正文会进入目标智能体上下文，且 UI 与其一致。你不应手写这些标记。',
    ],
    en: [
      '- Teammate Tellasks MUST follow four phases: “initiate -> wait -> judge -> continue”. If the objective is not met, immediately send the next Tellask round.',
      '- For teammate Tellasks, a delivered response closes that call round; there is no default “still running in background” state for the same Tellask. To continue, emit a new Tellask function call explicitly (usually \\`tellask\\` with the same \\`sessionSlug\\`).',
      '- You may claim “waiting for reply/result” only when a concrete pending Tellask exists; otherwise execute the next action now (direct Tellask or local action).',
      '- Do not use \\`askHuman\\` as a relay for executable teammate work. If you write “ask @X to do Y”, emit \\`tellask\\` or \\`tellaskSessionless\\` in the same response.',
      '- When you define a “reply/delivery format” inside tellask body, you must explicitly include: `Dominds auto-injects reply markers; do not hand-write markers`; do not require the responder to hand-write `【最终完成】` / `【tellaskBack】` / FBR markers.',
      '- When you are in a teammate-triggered sideline and need clarification, you MUST issue \\`tellaskBack\\` to ask back upstream; \\`tellaskBack\\` must not carry \\`sessionSlug\\`.',
      '- Reply markers are auto-added by runtime in the inter-dialog transfer payload (for example ask-back / final delivery / FBR markers); that same transfer payload is what the target agent receives in context and what UI shows. Do not hand-write markers.',
    ],
  });
  return lines.join('\n');
}

function buildSidelineUpstreamReplyMarkerRules(language: LanguageCode): string {
  const lines = pickLocalized(language, {
    zh: [
      '- 本规则仅用于当前支线向上游诉请者回贴，不适用于你发起新的 tellask。',
      '- 当当前支线完成全部目标并回贴上游时，运行时会在传递正文中添加【最终完成】并投递给上游。',
      '- 当前支线未完成/不确定/阻塞时，不得发普通文本中间汇报；必须发起 \\`tellaskBack({ tellaskContent: "..." })\\`，并在 \\`tellaskContent\\` 中给出具体问题。',
      '- 例外：FBR 支线为工具禁用模式（不得调用 \\`tellaskBack\\`）；其回贴标记也由运行时在传递正文中注入。',
    ],
    en: [
      '- This rule applies only when posting upstream from the current sideline, not when initiating a new tellask.',
      '- When the current sideline has fully completed its objectives and posts upstream, runtime injects 【最终完成】 into the transfer payload sent upstream.',
      '- If the current sideline is unfinished/uncertain/blocked, do not post a plain-text progress update upstream; emit \\`tellaskBack({ tellaskContent: "..." })\\` and put concrete questions in \\`tellaskContent\\`.',
      '- Exception: FBR sideline is tool-less (no \\`tellaskBack\\`); its reply marker is also injected by runtime into the transfer payload.',
    ],
  });
  return lines.join('\n');
}

function buildTellaskReplyMarkerScopePolicy(
  language: LanguageCode,
  dialogScope: DialogScope,
): string[] {
  if (dialogScope === 'sideline') {
    return [
      ...pickLocalized(language, {
        zh: [
          '- 回贴文本标记由运行时在跨对话传递正文中自动添加（常规完成=【最终完成】；FBR=【FBR-直接回复】或【FBR-仅推理】）；该正文直接进入上游上下文，且 UI 展示与其一致。你无需、也不应手写标记。',
          '- 若你在正文中给下游写“回贴格式”，必须写明“Dominds 自动注入标记，禁止手写”；不得要求下游手写任何标记。',
          '- 当前支线未完成/不确定/阻塞时：必须调用 \\`tellaskBack({ tellaskContent: "..." })\\`，不得发普通文本中间汇报。',
          '- 仅当确认当前支线已完成全部目标并回贴上游时，运行时才会在传递正文中标注【最终完成】。',
        ],
        en: [
          '- Reply markers are runtime-added in the inter-dialog transfer payload (regular completed reply = 【最终完成】; FBR = 【FBR-直接回复】 or 【FBR-仅推理】); this payload is delivered to upstream context and shown identically in UI. Do not hand-write markers.',
          '- If you define a reply format for downstream, you must state “Dominds auto-injects markers; do not hand-write them”; do not require downstream to hand-write any marker.',
          '- If the current sideline is unfinished/uncertain/blocked: you must call \\`tellaskBack({ tellaskContent: "..." })\\` instead of posting a plain-text progress update.',
          '- Runtime marks 【最终完成】 inside the transfer payload only when the current sideline has fully completed its objectives and posts upstream.',
        ],
      }),
    ];
  }
  return [
    pickLocalized(language, {
      zh: '- 发起 \\`tellask\\` / \\`tellaskSessionless\\` 时，\\`tellaskContent\\` 必须是业务正文，不应手写任何回贴标记；若写回贴格式，必须显式要求“禁止手写，Dominds 自动注入标记”。',
      en: '- When initiating \\`tellask\\` / \\`tellaskSessionless\\`, \\`tellaskContent\\` must stay as business body and must not hand-write reply markers; if you specify a reply format, explicitly require “no hand-written markers, Dominds auto-injects markers”.',
    }),
  ];
}

function buildTellaskCollaborationProtocol(
  language: LanguageCode,
  dialogScope: DialogScope,
): string {
  const lines: string[] = [
    ...pickLocalized(language, {
      zh: [
        '- Tellask 统一走函数工具通道：\\`tellaskBack\\` / \\`tellask\\` / \\`tellaskSessionless\\` / \\`askHuman\\` / \\`freshBootsReasoning\\`。',
        '- 对队友诉请默认使用 \\`tellask\\` 并复用 \\`sessionSlug\\`；仅在确认一次性诉请足够时才使用 \\`tellaskSessionless\\`，且需说明理由。',
        '- 例外优先级（强制）：\\`tellaskBack\\` 仅用于回问上游诉请者，不适用队友长线默认规则，也不携带 \\`sessionSlug\\`。',
      ],
      en: [
        '- Tellask must use the function-tool channel: \\`tellaskBack\\` / \\`tellask\\` / \\`tellaskSessionless\\` / \\`askHuman\\` / \\`freshBootsReasoning\\`.',
        '- For teammate tellasks, default to \\`tellask\\` and continue with the same \\`sessionSlug\\`; use \\`tellaskSessionless\\` only for justified one-shot calls.',
        '- Mandatory exception precedence: \\`tellaskBack\\` is ask-back-only and outside the teammate-session default; it does not carry \\`sessionSlug\\`.',
      ],
    }),
    ...buildTellaskReplyMarkerScopePolicy(language, dialogScope),
    pickLocalized(language, {
      zh: '- 队友诉请阶段协议（强制）：',
      en: '- Teammate Tellask phase contract (mandatory):',
    }),
    buildTeammateTellaskPhaseContract(language),
  ];
  if (dialogScope === 'sideline') {
    lines.push(
      pickLocalized(language, {
        zh: '- 支线对话交付规则（强制）：',
        en: '- Sideline completion rule (mandatory):',
      }),
      buildSidelineUpstreamReplyMarkerRules(language),
    );
  }
  return lines.join('\n');
}

function buildFbrGuidelines(language: LanguageCode, dialogScope: DialogScope): string {
  const fbrContextHealthRule = buildFbrContextHealthScopeRule(dialogScope, language);
  const fbrPhaseContract = buildFbrPhaseContract(language);
  const lines = pickLocalized(language, {
    zh: [
      '- FBR 由 \\`freshBootsReasoning\\` 触发，不属于普通队友诉请分类；请按本节规则执行。',
      '- FBR 不可调用 \\`tellaskBack\\`；其回贴标记由运行时在跨对话传递正文中自动注入。',
      '- FBR 禁止一切 tellask（包括 \\`tellaskBack\\` / \\`tellask\\` / \\`tellaskSessionless\\` / \\`askHuman\\`）。',
      '- 当用户明确要求“做一次 FBR/扪心自问”，对话主理人必须发起 \\`freshBootsReasoning\\`。',
      fbrContextHealthRule,
      '- FBR 的标准入口是 \\`freshBootsReasoning({ tellaskContent, effort? })\\`；禁止用 \\`tellask\\` / \\`tellaskSessionless\\` 对自己发起 self-target 诉请来替代。',
      '- 当用户自然语言里明确给了 FBR 力度（例如“做 fbr x6”/“做一次 6x fbr”），应把该力度映射到 \\`effort\\`（例如 \\`effort: 6\\`）；若未指定力度，按工具说明中的动态默认值传参。',
      '- 发起 FBR 时，\\`tellaskContent\\` 只写目标、事实、约束与证据，不要预设分析方向（例如固定问题清单/指定分析框架）。推理方向必须交由 FBR 支线自主拓展。',
      '- 发起前自检（强制）：若正文出现“请从以下维度/按以下方面/按步骤 1..N 分析”等预设提纲语句，必须先改写再调用 \\`freshBootsReasoning\\`；否则视为违规调用。',
      '- 发起正文推荐模板（强制遵循语义）：\\`目标\\` / \\`事实\\` / \\`约束\\` / \\`证据\\`（可选 \\`未知项\\`）。正文应是事实陈述，不是对 FBR 支线下达“按维度/按步骤分析”的命令。',
      '- 典型反例（禁止）：\\`请从以下维度分析\\`、\\`按步骤 1..N 推理\\`、\\`每个维度至少 N 轮\\`。出现这些句式时，必须先改写为中性事实描述。',
      '- 即使用户未明确要求，在诉诸 \\`askHuman\\`（Q4H）之前，若感觉目标不够清晰或难以决定下一步行动，应首先发起一次扪心自问，充分总结当前对话上下文的事实情况作为 FBR 正文；在收到该次 FBR 回贴前，不要提前下最终行动决策。',
      '- FBR 阶段协议（强制）：',
      fbrPhaseContract,
      '- 鼓励 FBR 自我建议立即获取哪些未明事实，得到建议利用当前对话工具获取，再补足上下文迭代 FBR 直到获得清晰的下一步行动思路。',
    ],
    en: [
      '- FBR is triggered by \\`freshBootsReasoning\\`, not by normal teammate tellasks; follow this section’s rules.',
      '- FBR cannot call \\`tellaskBack\\`; its reply marker is injected by runtime into the inter-dialog transfer payload.',
      '- FBR forbids all tellask calls (including \\`tellaskBack\\` / \\`tellask\\` / \\`tellaskSessionless\\` / \\`askHuman\\`).',
      '- When the user explicitly requests “do an FBR / fresh boots reasoning”, the Dialog Responder must call \\`freshBootsReasoning\\`.',
      fbrContextHealthRule,
      '- The standard FBR entry is \\`freshBootsReasoning({ tellaskContent, effort? })\\`; do not emulate FBR via self-targeted \\`tellask\\` / \\`tellaskSessionless\\`.',
      '- When the user gives an explicit FBR intensity in natural language (for example “do fbr x6” / “run one 6x fbr”), map it to \\`effort\\` (for example \\`effort: 6\\`); when the user does not specify intensity, pass the dynamic default described in the tool documentation.',
      '- When initiating FBR, keep \\`tellaskContent\\` to goals, facts, constraints, and evidence only; do not predefine analysis directions (for example fixed question checklists or prescribed frameworks). Reasoning directions must be expanded autonomously by the FBR sideline.',
      '- Pre-call self-check (mandatory): if the body contains scaffolded directives such as “from the following dimensions/aspects” or stepwise templates (“analyze in steps 1..N”), rewrite first, then call \\`freshBootsReasoning\\`; otherwise the call is a protocol violation.',
      '- Recommended body template (semantic MUST): \\`Goal\\` / \\`Facts\\` / \\`Constraints\\` / \\`Evidence\\` (optional \\`Unknowns\\`). The body should present neutral facts, not command the FBR sideline to analyze by fixed dimensions or steps.',
      '- Forbidden patterns: “from the following dimensions”, “analyze in steps 1..N”, “at least N rounds per dimension”. Rewrite these into neutral factual context before calling FBR.',
      '- Even without an explicit request, before resorting to \\`askHuman\\` (Q4H), if the goal is unclear or deciding the next action is difficult, you should first initiate FBR and summarize current dialog facts as the FBR body; do not finalize the next action before that FBR feedback returns.',
      '- FBR phase contract (mandatory):',
      fbrPhaseContract,
      '- Encourage FBR to recommend which missing facts to obtain immediately; then use the current dialog’s tools to fetch them, update context, and iterate FBR until a clear next action emerges.',
    ],
  });
  return lines.join('\n');
}

function buildTellaskInteractionRules(language: LanguageCode): string {
  const lines = pickLocalized(language, {
    zh: [
      '- \\`tellaskBack\\`：仅用于支线回问上游诉请者。',
      '- \\`tellask\\`：用于可恢复的长线诉请（必须提供 \\`targetAgentId\\` / \\`sessionSlug\\` / \\`tellaskContent\\`）。',
      '- \\`tellaskSessionless\\`：用于一次性诉请（必须提供 \\`targetAgentId\\` / \\`tellaskContent\\`）。',
      '- \\`askHuman\\`：用于 Q4H（向人类请求必要澄清/决策/授权/缺失输入）。',
      '- \\`freshBootsReasoning\\`：用于发起扪心自问（FBR）支线（\\`tellaskContent\\` 必填，\\`effort\\` 可选）。',
    ],
    en: [
      '- \\`tellaskBack\\`: ask back upstream from a sideline dialog only.',
      '- \\`tellask\\`: resumable tellask (requires \\`targetAgentId\\` / \\`sessionSlug\\` / \\`tellaskContent\\`).',
      '- \\`tellaskSessionless\\`: one-shot tellask (requires \\`targetAgentId\\` / \\`tellaskContent\\`).',
      '- \\`askHuman\\`: Q4H for necessary clarification/decision/authorization/missing input.',
      '- \\`freshBootsReasoning\\`: starts an FBR sideline dialog (requires \\`tellaskContent\\`, optional \\`effort\\`).',
    ],
  });
  return lines.join('\n');
}

function buildFunctionToolRules(language: LanguageCode, funcToolRulesText: string): string {
  const lines = pickLocalized(language, {
    zh: [
      '- 回答必须基于可观测事实；为获取事实优先使用可用工具，缺乏观测事实时明确说明并请求/补充获取，不得臆测。',
      `- 你必须通过原生 function-calling 发起函数工具调用。请提供严格的 JSON 参数对象，并尽量匹配工具 schema。Dominds 会对 schema 做 best-effort 校验（例如 required / additionalProperties:false / 基础 type / primitive enum / primitive const）；其余复杂关键字（pattern/format/min/max/oneOf 等）与语义约束以工具报错为准。${funcToolRulesText}`,
      '- 若遇到权限/沙盒/工具不可用：按要求申请升级或发起 Q4H；禁止编造结果。',
    ],
    en: [
      '- Answers must be grounded in observed facts. Use available tools to obtain facts; if facts are missing, say so and request/obtain them—do not guess.',
      `- You must invoke function tools via native function-calling. Provide a valid JSON object for the tool's arguments and match the tool schema as closely as possible. Dominds performs best-effort schema validation (for example required / additionalProperties:false / basic types / primitive enum / primitive const); other complex keywords (pattern/format/min/max/oneOf etc.) and semantic constraints are enforced via tool errors.${funcToolRulesText}`,
      '- If a tool is unavailable due to permissions/sandboxing, request escalation or ask Q4H; do not fabricate results.',
    ],
  });
  return lines.join('\n');
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const collaborationProtocol = buildTellaskCollaborationProtocol(
    input.language,
    input.dialogScope,
  );
  const fbrGuidelines = buildFbrGuidelines(input.language, input.dialogScope);
  const tellaskInteractionRules = buildTellaskInteractionRules(input.language);
  const functionToolRules = buildFunctionToolRules(input.language, input.funcToolRulesText);

  if (input.language === 'zh') {
    return `
# Agent 系统提示

## 身份
- 成员 ID: \`${input.agent.id}\`
- 全名: ${input.agent.name}

## 语言模式
- 你的内部工作语言是简体中文（用于系统提示、工具调用规则、队友/支线对话叙事格式等）。
- 你可能会收到一条短的引导信息，形如"用户可见回复语言：X"。当你对用户作答时，请优先遵循该引导；若未给出引导，则使用工作语言作答。

## 消息类型
- 以 \`[系统通知]\` 或 \`[System notification]\` 开头的消息是**系统通知**，不是用户输入。
- 系统通知不需要你直接回复给用户，但需要你根据通知内容执行相应的操作（如维护提醒项、调用 clear_mind 等）。

## 指令优先级与冲突处理
- 优先级：系统 > 差遣牒 > 用户 > 工具回执。
- 发生冲突时：说明冲突并优先执行高优先级；若需要决策/授权/缺失输入，发起 Q4H。

## 术语表

- 诉请（Tellask）：对智能体的结构化请求。
- 提及列表（mentionList）：仅用于 \`tellask\` / \`tellaskSessionless\` 的队友目标列表（\`@<agentId>\`）。
- 诉请内容（tellaskContent）：tellask 系列函数的正文参数，用于承载上下文/约束/验收。
- 对话主理人（Dialog Responder）：负责当前对话推进与输出的智能体。
- 诉请者（tellasker）：发出诉请的对话主理人。
- 被诉请者（tellaskee）：接收诉请的对话主理人/队友。
- 回问诉请（TellaskBack）：支线对话用 \`tellaskBack\` 回问诉请者以澄清。
- 扪心自问（FBR）：由 \`freshBootsReasoning\` 触发的“无工具”支线推理机制。
- Q4H（Question for Human）：通过 \`askHuman\` 向人类请求必要的澄清/决策/授权/缺失输入。
- 长线诉请（Tellask Session）：使用 \`tellask\` + \`sessionSlug\` 的可恢复多轮协作。
- 一次性诉请（Fresh Tellask）：一次性、不可恢复的诉请。
- 主线对话（Mainline dialog）：承载共享差遣牒并负责整体推进的对话。
- 支线对话（Sideline dialog）：为分项任务临时创建的工作对话。
- 差遣牒（Taskdoc）：共享任务契约，包含必要的 goals/constraints/progress 章节以及可选更多的额外章节。

## 角色设定

${input.persona}

## 知识

${input.knowledge}

## 经验

${input.lessons}

## 运行环境

${input.envIntro}

## 团队目录

**Q4H 机制**：通过 \`askHuman\` 发起向人类请求（澄清/决策/授权/缺失输入），或汇报当前环境中无法由智能体自主完成的阻塞事项。
**注意**：不要把可由智能体完成的执行性工作外包给 \`askHuman\`。Q4H 请求应尽量最小化、可验证（给出需要的具体信息、预期格式/选项），并在得到答复后继续由智能体自主完成后续工作。
**补充**：像“发起队友诉请/推进迭代/收集回贴”这类常规协作动作属于智能体的自主工作流，不要向 \`askHuman\` 询问“是否要执行”；直接执行并在必要时汇报进度即可。

你与以下智能体队友协作。使用他们的呼号与其交流、安排分项工作。

${input.teamIntro}

## 全局策略

${input.policyText}

## 协作协议（Tellask 与函数工具边界）

${collaborationProtocol}

## FBR 使用准则

${fbrGuidelines}

## 内置工具

${input.intrinsicToolUsageText}

## 工具集手册

${input.toolsetManualIntro}

## 交互协议

### Tellask Special Functions（队友/FBR/Q4H）
${tellaskInteractionRules}

### 函数工具（仅原生 function-calling）
${functionToolRules}
`;
  }

  return `
# Agent System Prompt

## Identity
- Member ID: \`${input.agent.id}\`
- Full Name: ${input.agent.name}

## Language Model
- Your internal working language is English (system prompt, tool rules, teammate/sideline-dialog narrative formatting).
- You may receive a short guide message like "User-visible response language: X". When replying to the user, follow that guide; if absent, respond in the working language.

## Message Types
- Messages starting with \`[系统通知]\` or \`[System notification]\` are **system notifications**, not user input.
System notifications convey important state changes (e.g., context caution/critical, Diligence Push triggered). Read carefully and follow the instructions.

## Instruction Priority & Conflicts
- Priority order: system > taskdoc > user > tool outputs.
- On conflict: state the conflict and follow the higher-priority instruction; if a decision/authorization/input is needed, ask Q4H.

## Glossary

- Tellask: a structured request addressed to an agent.
- Mention list (\`mentionList\`): teammate targets for \`tellask\` / \`tellaskSessionless\` only (\`@<agentId>\`).
- Tellask content (\`tellaskContent\`): main call payload carrying context/constraints/acceptance.
- Dialog Responder: the role responsible for driving a dialog and producing responses.
- tellasker: the Dialog Responder that issued the Tellask.
- tellaskee: the Dialog Responder/agent that receives the Tellask.
- TellaskBack: a sideline uses \`tellaskBack\` to ask the tellasker for clarification.
- Fresh Boots Reasoning (FBR): a tool-less sideline reasoning mechanism triggered by \`freshBootsReasoning\`.
- Q4H (Question for Human): use \`askHuman\` to request necessary clarification/decision/authorization/missing input from a human.
- Tellask Session: resumable multi-turn work using \`tellask\` with \`sessionSlug\`.
- Fresh Tellask: a one-shot, non-resumable Tellask.
- Mainline dialog: the dialog that owns the shared Taskdoc and overall progress.
- Sideline dialog: a temporary dialog for a subtask.
- Taskdoc: the shared task contract with required goals/constraints/progress sections plus optional extra sections.

## Persona

${input.persona}

## Knowledge

${input.knowledge}

## Lessons

${input.lessons}

## Runtime Environment

${input.envIntro}

## Team Directory

**Q4H mechanism**: Use \`askHuman\` when you need clarification/decision/authorization/missing inputs from a human, or when reporting blockers that cannot be completed autonomously in the current environment.
**Note**: Do not outsource executable work through \`askHuman\`. Keep Q4H requests minimal and verifiable (ask for specific info, expected format/options), then continue the remaining work autonomously after receiving the answer.
**Addendum**: Routine coordination actions (e.g., tellasking teammates, driving iterations, collecting replies) are part of the agent’s autonomous workflow; do not use \`askHuman\` for permission-seeking on those actions. Execute and report progress when needed.

You collaborate with the following teammates. Use their call signs to address them.

${input.teamIntro}

## Global Policies

${input.policyText}

## Collaboration Protocol (Tellask vs Function Tools)

${collaborationProtocol}

## FBR Usage Guidelines

${fbrGuidelines}

## Intrinsic Tools

${input.intrinsicToolUsageText}

## Toolset Manuals

${input.toolsetManualIntro}

## Interaction Protocols

### Tellask Special Functions (teammates/FBR/Q4H)
${tellaskInteractionRules}

### Function Tools (native function-calling only)
${functionToolRules}
`;
}
