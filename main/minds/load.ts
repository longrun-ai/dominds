/**
 * Module: minds/load
 *
 * Loads agent minds/persona/knowledge/lessons and memory files from `.minds`.
 * Composes the system prompt and aggregates memories with optional hints.
 */
import type { Dirent } from 'fs';
import { access, readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { Dialog } from '../dialog';
import { ChatMessage } from '../llm/client';
import { log } from '../log';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import type { FuncTool, TextingTool, Tool } from '../tool';

async function readAgentMind(id: string, fn: string, noFileDefault: string = '') {
  const mindFn = path.join('.minds', 'team', id, fn);
  try {
    await access(mindFn);
  } catch {
    // no rtws mindset file, attempt builtin minds
    const builtinMindFn = path.join(__dirname, 'builtin', id, fn);
    try {
      return await readFile(builtinMindFn, 'utf-8');
    } catch {
      // no builtin mindset file, fallthrough to trigger direct reading path
    }
  }
  try {
    return await readFile(mindFn, 'utf-8');
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return noFileDefault;
    }
    log.warn(`Failed reading file '${mindFn}':`, error);
  }
  return noFileDefault;
}

export async function loadAgentMinds(
  agentId?: string,
  dialog?: Dialog,
): Promise<{
  team: Team;
  agent: Team.Member;
  systemPrompt: string;
  memories: ChatMessage[];
  agentTools: Tool[];
  textingTools: TextingTool[];
}> {
  let team = await Team.load();
  const agent = agentId === undefined ? team.getDefaultResponder() : team.getMember(agentId);
  if (!agent) throw new Error(`No such agent in team: '${agentId}'`);

  // read disk file afresh, in case the contents have changed by human or ai meanwhile
  const personaRaw = await readAgentMind(agent.id, 'persona.md', 'You are a helpful assistant.');
  const knowledgeRaw = await readAgentMind(agent.id, 'knowledge.md');
  const lessonsRaw = await readAgentMind(agent.id, 'lessons.md');
  const persona = personaRaw && personaRaw.trim() !== '' ? personaRaw : 'None.';
  const knowledge = knowledgeRaw && knowledgeRaw.trim() !== '' ? knowledgeRaw : 'None.';
  const lessons = lessonsRaw && lessonsRaw.trim() !== '' ? lessonsRaw : 'None.';

  // Introduction of all team members (mark "(self)" for the current agent)
  const teamIntro = Object.values(team.members)
    .map((m) => {
      const isSelf = m.id === agent.id ? ' (self)' : '';
      const goforList =
        Array.isArray(m.gofor) && m.gofor.length ? m.gofor.map((t) => `    - ${t}`).join('\n') : '';
      const gofor = goforList ? `\n  - Focus:\n${goforList}` : '';
      return `- Call Sign: @${m.id}${isSelf} - ${m.name}${gofor}`;
    })
    .join('\n');

  // Compose tool list from member's resolved toolsets and tools + built-in human tool
  // Get base tools from agent (excluding intrinsic tools which are now managed by Dialog)
  const baseAgentTools: Tool[] = agent.listTools();

  // Use only base agent tools - intrinsic tools are handled separately via Dialog
  const agentTools: Tool[] = baseAgentTools;

  const textingTools = agentTools.filter((t): t is TextingTool => t.type === 'texter');
  const funcTools = agentTools.filter((t): t is FuncTool => t.type === 'func');

  // Generate tool usage text - keep regular and intrinsic tools completely separate
  let toolUsageText: string;
  let intrinsicToolInstructions: string = '';
  let funcToolUsageText: string = '';
  let funcToolRulesText: string = '';

  // Regular tools (from agent)
  toolUsageText =
    textingTools.length > 0
      ? textingTools.map((tool) => `#### @${tool.name}\n\n${tool.usageDescription}\n`).join('\n')
      : 'No texting tools available.';
  if (funcTools.length > 0) {
    funcToolUsageText = funcTools
      .map((tool) => {
        const req = (tool.parameters.required ?? []).join(', ') || 'None';
        const props = Object.entries(tool.parameters.properties ?? {})
          .map(([k, v]) => `- ${k}: ${v.description ?? 'parameter'}`)
          .join('\n');
        return `#### Function Tool: ${tool.name}\n\n${tool.description || ''}\n\n- Invocation: native function calling with strict JSON arguments\n- Required fields: ${req}\n- Parameters:\n${props}`.trim();
      })
      .join('\n\n');
    funcToolRulesText = `\n- Use native function-calling for all function tools listed; do not attempt texting headlines (e.g., \`@name\`) for these.\n- Provide strict JSON arguments that match the tool schema exactly; include all required fields; no extra fields.`;
  }

  // Intrinsic tools (from dialog, if available)
  if (dialog) {
    intrinsicToolInstructions = dialog.getIntrinsicToolInstructions();
  }

  // asembly the full system prompt
  const systemPrompt = `
# Agent System Prompt

## Identity
- Member ID: \`${agent.id}\`
- Full Name: ${agent.name}

## Persona
${persona}

## Knowledge
${knowledge}

## Lessons
${lessons}

## Team Directory
You collaborate with the following teammates. Use their call signs to address them.

${teamIntro}

## Interaction Abilities
You interact using a simple headline/body grammar with both teammates and "texting" tools.

### Tools vs Teammates
- Tools: trigger with headlines like \`@<tool>\`. Headlines follow strict syntax; bodies are concise and structured. One headline targets one tool.
- Teammates: use natural-language headlines. Bodies can be freeform. Include brief identifiers in headlines for correlation. You can address multiple teammates in one headline.

  ### Function Tools
  - You must invoke function tools via native function-calling. Provide a valid JSON object for the tool's arguments that strictly matches the tool schema (no extra fields, include all required fields).${funcToolRulesText}
  
  ${funcToolUsageText || 'No function tools available.'}

  ### Function Calling vs Texting
  - Do not use native LLM function-calling for teammates or "texting" tools.
  - Use texting tools via headlines that start with \`@<tool>\` at column 0, followed by an optional body; close with \`@/\` when needed.
  - For dialog control (e.g., reminders), use the provided texting tools via headlines; never emit function calls for these.

### Grammar Basics
- A headline at column 0 starting with \`@<name>\` opens a call. The input body continues until a standalone \`@/\` or the next headline.
- Blank line rule: only a blank line immediately following the headline ends the call with an empty body. Blank lines after at least one body line are part of the input body.
- First mention decides call type: the first \`@<name>\` determines whether it is a tool call or a teammates call.
- Safety: wrap literal \`@\` in backticks to avoid accidental calls.

### Teammate Calls
- Prefer multi-teammate calls for parallel expertise. Keep requests specific and role-aware.

### Texting Tools

${toolUsageText}${
    intrinsicToolInstructions
      ? `\n### Dialog Control Tools
${intrinsicToolInstructions}`
      : '\n'
  }
### Examples
- Single tool call (no body)
\`\`\`plain-text
@read_file ~50 logs/error.log
\`\`\`

- Close explicitly
\`\`\`plain-text
@overwrite_file logs/error.log
Log reset.
@/
\`\`\`

- Multi-call (separate)
\`\`\`plain-text
@add_memory caveats/stdio-mcp-console-usage.md
# DON'Ts
- Do NOT write to stdout when using MCP stdio transport.
@/

@read_file !range 235~ logs/error.log
\`\`\`

### Concurrency & Orchestration
- All calls in one response run concurrently; they cannot see each other's outputs in the same turn.
- Design each call to be self-sufficient.
- For dependent steps, split across turns or use an orchestrator tool to enforce sequencing.

### Safety Against Accidental Mentions
- Only lines beginning with \`@\` at column 0 start calls.
- Inline \`@\` has no special meaning.
- When in doubt, wrap text in backticks.
`;

  // composite this list by reading:
  //   - .minds/memory/team_shared/**/*.md
  //   - .minds/memory/individual/<agent.id>/**/*.md
  // one role='assistant' msg per file, add preamble about it's shared or personal
  // lightly hint the use of memory tools on personal mem, in 1st person tongue,
  // for mem tools made available to the agent per its team member spec
  //
  // aggregate shared and personal memories into assistant messages
  const memories: ChatMessage[] = [];
  const groupedMemories: { shared: ChatMessage[]; personal: ChatMessage[] } = {
    shared: [],
    personal: [],
  };
  try {
    interface MemoryFile {
      absolutePath: string;
      relativePath: string;
    }

    async function collectMdFiles(rootDir: string): Promise<MemoryFile[]> {
      const files: MemoryFile[] = [];
      async function walk(dir: string): Promise<void> {
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (err: unknown) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: unknown }).code === 'ENOENT'
          ) {
            return;
          }
          log.warn(`Failed to read directory ${dir}:`, err);
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile() && fullPath.endsWith('.md')) {
            const relativePath = path.relative(rootDir, fullPath);
            files.push({
              absolutePath: fullPath,
              relativePath: relativePath,
            });
          }
        }
      }
      await walk(rootDir);
      return files;
    }

    const sharedFiles = await collectMdFiles('.minds/memory/team_shared');
    const personalFiles = await collectMdFiles(`.minds/memory/individual/${agent.id}`);

    function countWords(text: string): number {
      const trimmed = text.trim();
      if (trimmed === '') return 0;
      return trimmed.split(/\s+/).length;
    }

    const readMemFiles = async (
      files: MemoryFile[],
      scopeLabel: string,
      relevantToolNames: string[],
    ) => {
      for (const file of files) {
        try {
          const content = await readFile(file.absolutePath, 'utf-8');
          const s = await stat(file.absolutePath);
          const lastModified = formatUnifiedTimestamp(new Date(s.mtimeMs));
          const byteSize = s.size;
          const wordCount = countWords(content);
          let preamble = `### ${scopeLabel}\n- Path: \`${file.relativePath}\`\n- Last modified: ${lastModified}\n- Size: ${byteSize} bytes\n- Words: ${wordCount}`;

          // Add tool usage hints if relevant memory tools are available
          const availableTools = agentTools.map((tool) => tool.name).filter(Boolean);
          const availableRelevantTools = relevantToolNames.filter((toolName) =>
            availableTools.includes(toolName),
          );

          if (availableRelevantTools.length > 0) {
            const toolHints = availableRelevantTools.map(
              (toolName) => `@${toolName} ${file.relativePath}`,
            );
            const nestedHints = toolHints.map((h) => `  - ${h}`).join('\n');
            preamble += `\n- Manage with:\n${nestedHints}`;
          }

          const memMsg: ChatMessage = {
            type: 'transient_guide_msg',
            role: 'assistant',
            content: `${preamble}\n---\n${content.trim()}\n`,
          };
          if (scopeLabel.startsWith('Shared')) {
            groupedMemories.shared.push(memMsg);
          } else {
            groupedMemories.personal.push(memMsg);
          }
          memories.push(memMsg);
        } catch (err) {
          log.warn(`Failed to read memory file ${file.absolutePath}:`, err);
        }
      }
    };

    await readMemFiles(sharedFiles, 'Team Shared Memory', [
      'replace_team_memory',
      'drop_team_memory',
    ]);
    await readMemFiles(personalFiles, `Personal Memory (@${agent.id})`, [
      'replace_memory',
      'drop_memory',
    ]);
  } catch (err) {
    log.warn('Failed to load agent memories:', err);
  }

  // Prepend grouped section headers when any memory exists
  const groupedOutput: ChatMessage[] = [];
  if (groupedMemories.shared.length > 0 || groupedMemories.personal.length > 0) {
    groupedOutput.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: '## Memories Summary\n',
    });
    if (groupedMemories.shared.length > 0) {
      const summaryShared = groupedMemories.shared
        .filter((m): m is ChatMessage & { content: string } => 'content' in m)
        .map((m) => {
          const match = m.content.match(/- Path: `([^`]+)`/);
          const p = match ? match[1] : '';
          return `- Shared: ${p}`;
        })
        .join('\n');
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: '### Shared',
      });
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: summaryShared,
      });
    }
    if (groupedMemories.personal.length > 0) {
      const summaryPersonal = groupedMemories.personal
        .filter((m): m is ChatMessage & { content: string } => 'content' in m)
        .map((m) => {
          const match = m.content.match(/- Path: `([^`]+)`/);
          const p = match ? match[1] : '';
          return `- Personal: ${p}`;
        })
        .join('\n');
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: '### Personal\n',
      });
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: summaryPersonal,
      });
    }
  }
  if (groupedMemories.shared.length > 0) {
    groupedOutput.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: '## Shared Memories',
    });
    groupedOutput.push(...groupedMemories.shared);
  }
  if (groupedMemories.personal.length > 0) {
    groupedOutput.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: '## Personal Memories\n',
    });
    groupedOutput.push(...groupedMemories.personal);
  }

  return {
    team,
    agent,
    systemPrompt,
    memories: groupedOutput.length > 0 ? groupedOutput : memories,
    agentTools,
    textingTools,
  };
}
