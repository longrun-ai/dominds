/**
 * Module: llm/driver
 *
 * Drives dialog streaming end-to-end:
 * - Loads minds/tools, selects generator, streams outputs
 * - Parses texting/code blocks, executes tools, handles human prompts
 * - Supports autonomous teammate calls: when an agent mentions a teammate (e.g., @cmdr), a subdialog is created and driven; the parent logs the initiating assistant bubble and system creation/result, while subdialog conversation stays in the subdialog
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AssignmentFromSup } from '../dialog';
import { Dialog, DialogID, RootDialog, SubDialog } from '../dialog';

import { inspect } from 'util';
import { globalDialogRegistry } from '../dialog-global-registry';
import { extractErrorDetails, log } from '../log';
import { loadAgentMinds } from '../minds/load';
import { DialogPersistence, DiskFileDialogStore } from '../persistence';
import type { NewQ4HAskedEvent } from '../shared/types/dialog';
import type { HumanQuestion } from '../shared/types/storage';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import {
  CollectedTextingCall,
  TextingEventsReceiver,
  TextingStreamParser,
  extractMentions,
} from '../texting';
import type { ToolArguments } from '../tool';
import { FuncTool, TextingTool, Tool, validateArgs } from '../tool';
import { getTool } from '../tools/registry';
import { generateDialogID } from '../utils/id';
import { formatTaskDocContent } from '../utils/task-doc';
import {
  ChatMessage,
  FuncCallMsg,
  FuncResultMsg,
  LlmConfig,
  SayingMsg,
  TextingCallResultMsg,
  ThinkingMsg,
} from './client';
import { getLlmGenerator } from './gen/registry';

// === HUMAN PROMPT TYPE ===

export interface HumanPrompt {
  content: string;
  msgId: string; // Message ID for tracking and error recovery (required for all human text)
  skipTextingParse?: boolean;
}

// === SUSPENSION AND RESUMPTION INTERFACES ===

export interface DialogSuspension {
  rootDialogId: string;
  subdialogIds: string[];
  pendingQuestions: PendingQuestion[];
  suspensionPoint: string; // Where the dialog was suspended
  suspendedAt: string;
  parentDialogId?: string; // If this is a subdialog suspension
}

export interface PendingQuestion {
  id: string;
  rootDialogId: string;
  subdialogId?: string; // undefined for root dialog questions
  question: string;
  context: string;
  askedAt: string;
  priority: 'low' | 'medium' | 'high';
}

// === PENDING SUBDIALOG RECORD TYPE ===
type PendingSubdialogRecordType = {
  subdialogId: string;
  createdAt: string;
  headLine: string;
  targetAgentId: string;
  callType: 'A' | 'B' | 'C';
  topicId?: string;
};

export interface ResumptionContext {
  // Which dialog(s) to respond to
  targetType: 'root' | 'subdialog' | 'multiple' | 'hierarchy';
  rootDialogId?: string;
  subdialogIds?: string[];

  // What type of response
  responseType: 'answer' | 'followup' | 'retry' | 'new_message';

  // Response data
  humanResponse?: HumanPrompt;
  newMessage?: HumanPrompt;
  retryContext?: {
    toolName: string;
    previousArgs: ToolArguments;
    errorContext: string;
  };
}

export interface DialogTree {
  rootDialogId: string;
  subdialogs: Map<string, SubdialogInfo>;
  suspensionMap: Map<string, DialogSuspension>;
}

export interface SubdialogInfo {
  id: string;
  parentDialogId: string;
  agentId: string;
  headLine: string;
  status: 'active' | 'suspended' | 'completed' | 'failed';
  round: number;
  createdAt: string;
}

function showErrorToAi(err: unknown): string {
  try {
    if (err instanceof Error) {
      return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
    }

    if (typeof err === 'string') {
      const s = err.trim();
      return s.length > 500 ? s.slice(0, 497) + '...' : s;
    }
    return inspect(err, { depth: 5, breakLength: 120, compact: false, sorted: true });
  } catch (fallbackErr) {
    return `Unknown error of type ${typeof err}`;
  }
}

/**
 * Validate streaming configuration for a team member.
 * Streaming supports function tools; no restrictions to enforce here.
 */
function validateStreamingConfiguration(_agent: Team.Member, _agentTools: Tool[]): void {}

function formatAssignmentVerbatim(headLine: string, callBody: string): string {
  const hasHead = headLine.trim() !== '';
  const hasBody = callBody.trim() !== '';
  if (hasHead && hasBody) {
    return `${headLine}\n\n${callBody}`;
  }
  if (hasHead) {
    return headLine;
  }
  return callBody;
}

function formatSubdialogAssignmentForModel(
  supdialogAgentId: string,
  headLine: string,
  callBody: string,
): string {
  const trimmedHead = headLine.trim();
  const trimmedBody = callBody.trim();
  const intro = `@${supdialogAgentId} is asking you`;
  if (trimmedHead !== '' && trimmedBody !== '') {
    return `${intro}, ${headLine}\n\n${callBody}`;
  }
  if (trimmedHead !== '') {
    return `${intro}, ${headLine}`;
  }
  if (trimmedBody !== '') {
    return `${intro}:\n${callBody}`;
  }
  return `${intro}.`;
}

function formatSubdialogUserPrompt(
  supdialogAgentId: string,
  headLine: string,
  callBody: string,
): string {
  return formatSubdialogAssignmentForModel(supdialogAgentId, headLine, callBody);
}

function resolveCallerLabel(assignment: AssignmentFromSup, callerDialog?: Dialog): string {
  if (assignment.originRole === 'user') {
    return assignment.originMemberId;
  }
  if (callerDialog) {
    return callerDialog.agentId;
  }
  return assignment.originMemberId;
}

function formatSupdialogCallPrompt(
  subdialogAgentId: string,
  headLine: string,
  callBody: string,
): string {
  const assignment = formatAssignmentVerbatim(headLine, callBody);
  return `Subdialog @${subdialogAgentId} requests:\n${assignment}`;
}

// === UNIFIED STREAMING HANDLERS ===

/**
 * Create a TextingEventsReceiver for unified saying event emission.
 * Handles @mentions, codeblocks, and markdown using TextingStreamParser.
 * Used by both streaming and non-streaming modes.
 */
export function createSayingEventsReceiver(dlg: Dialog): TextingEventsReceiver {
  return {
    markdownStart: async () => {
      await dlg.markdownStart();
    },
    markdownChunk: async (chunk: string) => {
      await dlg.markdownChunk(chunk);
    },
    markdownFinish: async () => {
      await dlg.markdownFinish();
    },
    callStart: async (first: string) => {
      await dlg.callingStart(first);
    },
    callHeadLineChunk: async (chunk: string) => {
      await dlg.callingHeadlineChunk(chunk);
    },
    callHeadLineFinish: async () => {
      await dlg.callingHeadlineFinish();
    },
    callBodyStart: async (infoLine?: string) => {
      await dlg.callingBodyStart(infoLine);
    },
    callBodyChunk: async (chunk: string) => {
      await dlg.callingBodyChunk(chunk);
    },
    callBodyFinish: async (endQuote?: string) => {
      await dlg.callingBodyFinish(endQuote);
    },
    callFinish: async (callId: string) => {
      await dlg.callingFinish(callId);
    },
    codeBlockStart: async (infoLine: string) => {
      await dlg.codeBlockStart(infoLine);
    },
    codeBlockChunk: async (chunk: string) => {
      await dlg.codeBlockChunk(chunk);
    },
    codeBlockFinish: async (endQuote: string) => {
      await dlg.codeBlockFinish(endQuote);
    },
  };
}

/**
 * Emit thinking events for a thinking message (non-streaming mode).
 * Emits thinkingStart, thinkingChunk with full content, and thinkingFinish.
 * Returns the extracted signature for caller to use.
 */
export async function emitThinkingEvents(
  dlg: Dialog,
  content: string,
): Promise<string | undefined> {
  if (!content.trim()) return undefined;

  await dlg.thinkingStart();
  await dlg.thinkingChunk(content);
  await dlg.thinkingFinish();

  // Extract and return signature for caller to use
  const signatureMatch = content.match(/<thinking[^>]*>(.*?)<\/thinking>/s);
  return signatureMatch?.[1]?.trim();
}

/**
 * Emit saying events using TextingStreamParser for @mentions/codeblocks (non-streaming mode).
 * Processes the entire content at once, handling all markdown/call/code events.
 */
export async function emitSayingEvents(
  dlg: Dialog,
  content: string,
): Promise<CollectedTextingCall[]> {
  if (!content.trim()) return [];

  const receiver = createSayingEventsReceiver(dlg);
  const parser = new TextingStreamParser(receiver);
  parser.takeUpstreamChunk(content);
  parser.finalize();

  return parser.getCollectedCalls();
}

// TODO: certain scenarios should pass `waitInQue=true`:
//        - supdialog call for clarification
/**
 * Drive a dialog stream with the following phases:
 *
 * Phase 1 - Lock Acquisition:
 *   - Attempt to acquire exclusive lock for the dialog using mutex
 *   - If dialog is already being driven, either wait in queue or throw error
 *
 * Phase 2 - Human Prompt Processing (first iteration only):
 *   - If humanPrompt is provided, add it as a prompting_msg
 *   - Persist user message to storage
 *
 * Phase 3 - User Texting Calls Collection & Execution:
 *   - Parse user text for @mentions and code blocks using TextingStreamParser
 *   - Execute texting tools (agent-to-agent calls, intrinsic tools)
 *   - Handle subdialog creation for @teammate mentions
 *
 * Phase 4 - Context Building:
 *   - Load agent minds (team, agent, system prompt, memories, tools)
 *   - Build context messages: memories, task doc, assignment from supdialog, dialog msgs
 *   - Process and render reminders
 *
 * Phase 5 - LLM Generation:
 *   - For streaming=false: Generate all messages at once
 *   - For streaming=true: Stream responses with thinking/saying events
 *
 * Phase 6 - Function/Texting Call Execution:
 *   - Execute function calls (non-streaming mode)
 *   - Execute texting calls (streaming mode)
 *   - Collect and persist results
 *
 * Phase 7 - Loop or Complete:
 *   - Check if more generation iterations are needed
 *   - Continue loop if new function calls or tool outputs exist
 *   - Break and release lock when complete
 */
export async function driveDialogStream(
  dlg: Dialog,
  humanPrompt?: HumanPrompt,
  waitInQue: boolean = false,
): Promise<void> {
  if (!waitInQue && dlg.isLocked()) {
    throw new Error(`Dialog busy driven, see how it proceeded and try again.`);
  }

  const release = await dlg.acquire();
  try {
    const shouldReportToCaller =
      dlg instanceof SubDialog &&
      humanPrompt !== undefined &&
      humanPrompt.skipTextingParse !== true;
    const before = shouldReportToCaller ? getLastAssistantMessage(dlg.msgs) : null;
    await _driveDialogStream(dlg, humanPrompt);
    if (shouldReportToCaller) {
      await reportSubdialogResponseToCaller(dlg, before);
    }
  } finally {
    release();
  }
}

/**
 * Backend coroutine that continuously drives dialogs.
 * Uses dynamic canDrive() checks instead of stored suspend state.
 */
export async function runBackendDriver(): Promise<void> {
  while (true) {
    try {
      const dialogsToDrive = globalDialogRegistry.getDialogsNeedingDrive();

      for (const rootDialog of dialogsToDrive) {
        try {
          globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId);
          if (await rootDialog.canDrive()) {
            const release = await rootDialog.acquire();
            try {
              await driveDialogToSuspension(rootDialog);

              const status = await rootDialog.getSuspensionStatus();
              if (status.subdialogs) {
                log.info(`Dialog ${rootDialog.id.rootId} suspended, waiting for subdialogs`);
              }
              if (status.q4h) {
                log.info(`Dialog ${rootDialog.id.rootId} awaiting Q4H answer`);
              }
            } finally {
              release();
            }
          }
        } catch (err) {
          log.error(`Error driving dialog ${rootDialog.id.rootId}:`, err, undefined, {
            dialogId: rootDialog.id.rootId,
          });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (loopErr) {
      log.error('Error in backend driver loop:', loopErr);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Drive a dialog until it suspends or completes.
 * Called with mutex already acquired.
 */
async function driveDialogToSuspension(dlg: Dialog): Promise<void> {
  try {
    await _driveDialogStream(dlg);
  } catch (err) {
    log.warn(`Error in driveDialogToSuspension for ${dlg.id.selfId}:`, err);
    throw err;
  }
}

/**
 * Frontend-triggered revive check (crash-recovery).
 */
export async function checkAndReviveSuspendedDialogs(): Promise<void> {
  const allDialogs = globalDialogRegistry.getAll();

  for (const rootDialog of allDialogs) {
    if (rootDialog.hasPendingSubdialogs()) {
      const allSatisfied = await areAllSubdialogsSatisfied(rootDialog.id);

      if (allSatisfied) {
        rootDialog.clearPendingSubdialogs();
        globalDialogRegistry.markNeedsDrive(rootDialog.id.rootId);
        log.info(`All subdialogs complete for ${rootDialog.id.rootId}, auto-reviving`);
      }
    }

    const subdialogs = rootDialog.getAllDialogs().filter((d) => d !== rootDialog);
    for (const subdialog of subdialogs) {
      const hasAnswer = await checkQ4HAnswered(subdialog.id);
      if (hasAnswer && !(await subdialog.hasPendingQ4H())) {
        globalDialogRegistry.markNeedsDrive(rootDialog.id.rootId);
        log.info(`Q4H answered for subdialog ${subdialog.id.selfId}, auto-reviving`);
      }
    }
  }
}

async function checkQ4HAnswered(dialogId: DialogID): Promise<boolean> {
  try {
    const { DialogPersistence } = await import('../persistence');
    const questions = await DialogPersistence.loadQuestions4HumanState(dialogId);
    return questions.length === 0;
  } catch (err) {
    log.warn(`Error checking Q4H state ${dialogId.key()}:`, err);
    return false;
  }
}

async function _driveDialogStream(dlg: Dialog, humanPrompt?: HumanPrompt): Promise<void> {
  let pubRemindersVer = dlg.remindersVer;

  let genIterNo = 0;
  while (true) {
    genIterNo++;

    // reload the agent's minds from disk every round, in case the disk files changed by human or ai meanwhile
    const { team, agent, systemPrompt, memories, agentTools, textingTools } = await loadAgentMinds(
      dlg.agentId,
      dlg,
    );

    // reload cfgs every round, in case it's been updated by human or ai meanwhile

    // Validate streaming configuration
    try {
      validateStreamingConfiguration(agent, agentTools);
    } catch (error) {
      log.warn(`Streaming configuration error for agent ${dlg.agentId}:`, error);
      throw error;
    }

    // Validate that required provider and model are configured

    // Validate that required provider and model are configured
    const provider = agent.provider ?? team.memberDefaults.provider;
    const model = agent.model ?? team.memberDefaults.model;

    if (!provider) {
      const error = new Error(
        `Configuration Error: No provider configured for agent '${dlg.agentId}'. Please specify a provider in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
      );
      log.warn(`Provider not configured for agent ${dlg.agentId}`, error);
      throw error;
    }

    if (!model) {
      const error = new Error(
        `Configuration Error: No model configured for agent '${dlg.agentId}'. Please specify a model in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
      );
      log.warn(`Model not configured for agent ${dlg.agentId}`, error);
      throw error;
    }

    const llmCfg = await LlmConfig.load();
    const providerCfg = llmCfg.getProvider(provider);
    if (!providerCfg) {
      const error = new Error(
        `Provider configuration error: Provider '${provider}' not found for agent '${dlg.agentId}'. Please check .minds/llm.yaml and .minds/team.yaml configuration.`,
      );
      log.warn(`Provider not found for agent ${dlg.agentId}`, error);
      throw error;
    }

    const llmGen = getLlmGenerator(providerCfg.apiType);
    if (!llmGen) {
      const error = new Error(
        `LLM generator not found: API type '${providerCfg.apiType}' for provider '${provider}' in agent '${dlg.agentId}'. Please check .minds/llm.yaml configuration.`,
      );
      log.warn(`LLM generator not found for agent ${dlg.agentId}`, error);
      throw error;
    }

    const funcTools: FuncTool[] = agentTools.filter((t): t is FuncTool => t.type === 'func');

    let suspendForHuman = false;
    let promptContent = '';

    try {
      await dlg.notifyGeneratingStart();

      if (humanPrompt && genIterNo == 1) {
        promptContent = humanPrompt.content;
        const msgId = humanPrompt.msgId;

        await dlg.addChatMessages({
          type: 'prompting_msg',
          role: 'user',
          genseq: dlg.activeGenSeq,
          content: promptContent,
          msgId: msgId,
        });
        // Persist user message to storage FIRST
        // This emits user_text event immediately for proper frontend ordering
        await dlg.persistUserMessage(promptContent, msgId);

        if (!humanPrompt.skipTextingParse) {
          // Collect and execute texting calls from user text using streaming parser
          // Combine agent texting tools with intrinsic reminder tools
          const allTextingTools = [...textingTools, ...dlg.getIntrinsicTools()];
          const collectedUserCalls = await emitSayingEvents(dlg, promptContent);
          const userResult = await executeTextingCalls(
            dlg,
            agent,
            allTextingTools,
            collectedUserCalls,
            'user',
          );

          if (userResult.toolOutputs.length > 0) {
            await dlg.addChatMessages(...userResult.toolOutputs);
          }
          if (userResult.suspend) {
            suspendForHuman = true;
          }

          // No teammate-call fallback here: rely exclusively on TextingStreamParser.

          if (userResult.subdialogsCreated.length > 0) {
            dlg.addPendingSubdialogs(userResult.subdialogsCreated);
          }
        }

        try {
          const { postDialogEvent } = await import('../evt-registry');
          postDialogEvent(dlg, {
            type: 'end_of_user_saying_evt',
            round: dlg.currentRound,
            genseq: dlg.activeGenSeq,
          });
        } catch (err) {
          log.warn('Failed to emit end_of_user_saying_evt', err);
        }
      }

      if (suspendForHuman) {
        break;
      }

      // use fresh memory + updated msgs from dialog object
      // Build ctxMsgs messages in logical order, then inject reminders as late as possible:
      // 1) memories
      // 2) task doc (user)
      // 3) assignment from supdialog (user)
      // 4) historical dialog msgs
      // Finally, render reminders and place them immediately before the last 'user' message
      // so they are salient for the next response without polluting earlier context.
      const taskDocMsg: ChatMessage | undefined = dlg.taskDocPath
        ? await formatTaskDocContent(dlg.taskDocPath)
        : undefined;
      let assignmentFromSupMsg: ChatMessage | undefined;
      if (dlg instanceof SubDialog && dlg.assignmentFromSup) {
        const assignment = dlg.assignmentFromSup;
        const callerDialog = resolveCallerDialog(dlg, assignment);
        const callerLabel = resolveCallerLabel(assignment, callerDialog ?? undefined);
        assignmentFromSupMsg = {
          type: 'environment_msg',
          role: 'user',
          content: formatSubdialogAssignmentForModel(
            callerLabel,
            assignment.headLine,
            assignment.callBody,
          ),
        };
      }

      const ctxMsgs: ChatMessage[] = [
        ...memories,
        ...(taskDocMsg ? [taskDocMsg] : []),
        ...(assignmentFromSupMsg ? [assignmentFromSupMsg] : []),
        ...dlg.msgs,
      ];

      await dlg.processReminderUpdates();
      const renderedReminders: ChatMessage[] =
        dlg.reminders.length > 0
          ? await Promise.all(
              dlg.reminders.map(async (reminder, index): Promise<ChatMessage> => {
                if (reminder.owner) {
                  return await reminder.owner.renderReminder(dlg, reminder, index);
                }
                return {
                  type: 'transient_guide_msg',
                  role: 'assistant',
                  content: `Here I have reminder #${index + 1}, I should assess whether it's still relevant and issue \`@delete_reminder ${index + 1}\` immediately if deemed not.
---
${reminder.content}`,
                };
              }),
            )
          : [];

      const reminderIntro: ChatMessage = {
        type: 'transient_guide_msg',
        role: 'assistant',
        content: `I have ${dlg.reminders.length} reminder${dlg.reminders.length > 1 ? 's' : ''} available for my memory management.

I can manage these anytime to maintain context across dialog rounds:
- @add_reminder [<position>]\n<content>
- @update_reminder <number>\n<new content>
- @delete_reminder <number>

Using @clear_mind or @change_mind would start a new round of dialog - this helps me keep my mindset clear while reminders carry important info to new rounds.

Tip: I can use @clear_mind with a body, and that body will be added as a new reminder, while I'm in a new dialog round without old messages.`,
      };

      if (renderedReminders.length > 0 || dlg.reminders.length === 0) {
        let insertIndex = -1;
        for (let i = ctxMsgs.length - 1; i >= 0; i--) {
          const m = ctxMsgs[i];
          if (m && m.type === 'prompting_msg' && m.role === 'user') {
            insertIndex = i;
            break;
          }
        }
        if (insertIndex >= 0) {
          ctxMsgs.splice(insertIndex, 0, reminderIntro, ...renderedReminders);
        } else {
          ctxMsgs.push(reminderIntro, ...renderedReminders);
        }
      }

      if (agent.streaming === false) {
        const nonStreamMsgs = await llmGen.genMoreMessages(
          providerCfg,
          agent,
          systemPrompt,
          funcTools,
          ctxMsgs,
          dlg.activeGenSeq,
        );
        const assistantMsgs = nonStreamMsgs.filter(
          (m): m is SayingMsg | ThinkingMsg => m.type === 'saying_msg' || m.type === 'thinking_msg',
        );
        const collectedAssistantCalls: CollectedTextingCall[] = [];

        if (assistantMsgs.length > 0) {
          await dlg.addChatMessages(...assistantMsgs);

          for (const msg of assistantMsgs) {
            if (
              msg.role === 'assistant' &&
              msg.genseq !== undefined &&
              (msg.type === 'thinking_msg' || msg.type === 'saying_msg')
            ) {
              // Only persist saying_msg - thinking_msg is persisted via thinkingFinish
              if (msg.type === 'saying_msg') {
                await dlg.persistAgentMessage(msg.content, msg.genseq, 'saying_msg');
              }

              // Emit thinking events using shared handler (non-streaming mode)
              if (msg.type === 'thinking_msg') {
                await emitThinkingEvents(dlg, msg.content);
              }

              // Emit saying events using shared TextingStreamParser integration
              if (msg.type === 'saying_msg') {
                const calls = await emitSayingEvents(dlg, msg.content);
                collectedAssistantCalls.push(...calls);
              }
            }
          }
        }

        let assistantToolOutputsCount = 0;
        if (collectedAssistantCalls.length > 0) {
          const allTextingTools = [...textingTools, ...dlg.getIntrinsicTools()];
          const assistantResult = await executeTextingCalls(
            dlg,
            agent,
            allTextingTools,
            collectedAssistantCalls,
            'assistant',
          );
          assistantToolOutputsCount = assistantResult.toolOutputs.length;
          if (assistantResult.toolOutputs.length > 0) {
            await dlg.addChatMessages(...assistantResult.toolOutputs);
          }
          if (assistantResult.suspend) {
            suspendForHuman = true;
          }
          if (assistantResult.subdialogsCreated.length > 0) {
            dlg.addPendingSubdialogs(assistantResult.subdialogsCreated);
          }
        }

        const funcCalls = nonStreamMsgs.filter((m): m is FuncCallMsg => m.type === 'func_call_msg');
        const funcResults: FuncResultMsg[] = [];

        const functionPromises = funcCalls.map(async (func) => {
          // Use the genseq from the func_call_msg to ensure tool results share the same generation sequence
          // This is critical for correct grouping in reconstructAnthropicContext()
          const callGenseq = func.genseq;
          // Use the LLM-allocated unique id for tracking
          // This id comes from func_call_msg and is the proper unique identifier
          const callId = func.id;

          // argsStr is still needed for UI event (funcCallRequested)
          const argsStr =
            typeof func.arguments === 'string'
              ? func.arguments
              : JSON.stringify(func.arguments ?? {});

          const tool = agentTools.find(
            (t): t is FuncTool => t.type === 'func' && t.name === func.name,
          );
          if (!tool) {
            const errorResult: FuncResultMsg = {
              type: 'func_result_msg',
              id: func.id,
              name: func.name,
              content: `Tool '${func.name}' not found`,
              role: 'tool',
              genseq: callGenseq,
            };
            await dlg.receiveFuncResult(errorResult);
            return;
          }

          let rawArgs: unknown = {};
          if (typeof func.arguments === 'string' && func.arguments.trim()) {
            try {
              rawArgs = JSON.parse(func.arguments);
            } catch (parseErr) {
              rawArgs = null;
              log.warn('Failed to parse function arguments as JSON', {
                funcName: func.name,
                arguments: func.arguments,
                error: parseErr,
              });
            }
          }

          const validation = validateArgs(tool.parameters, rawArgs);
          let result: FuncResultMsg;
          if (validation.ok) {
            const argsObj = rawArgs as ToolArguments;

            // Emit func_call_requested event to build the func-call section UI
            try {
              await dlg.funcCallRequested(func.id, func.name, argsStr);
            } catch (err) {
              log.warn('Failed to emit func_call_requested event', err);
            }

            try {
              await dlg.persistFunctionCall(func.id, func.name, argsObj, callGenseq);
            } catch (err) {
              log.warn('Failed to persist function call', err);
            }

            try {
              const content = await tool.call(dlg, agent, argsObj);
              result = {
                type: 'func_result_msg',
                id: func.id,
                name: func.name,
                content: String(content),
                role: 'tool',
                genseq: callGenseq,
              };
            } catch (err) {
              result = {
                type: 'func_result_msg',
                id: func.id,
                name: func.name,
                content: `Function '${func.name}' execution failed: ${showErrorToAi(err)}`,
                role: 'tool',
                genseq: callGenseq,
              };
            }
          } else {
            result = {
              type: 'func_result_msg',
              id: func.id,
              name: func.name,
              content: `Invalid arguments: ${validation.error}`,
              role: 'tool',
              genseq: callGenseq,
            };
          }

          await dlg.receiveFuncResult(result);
          funcResults.push(result);
        });

        const allFuncResults = await Promise.all(functionPromises);

        await Promise.resolve();

        // Add function calls AND results to dialog messages so LLM sees tool context in next iteration
        // Both are needed: func_call_msg for the tool definition, func_result_msg for the output
        if (funcCalls.length > 0) {
          await dlg.addChatMessages(...funcCalls);
        }
        if (funcResults.length > 0) {
          await dlg.addChatMessages(...funcResults);
        }

        if (suspendForHuman) {
          break;
        }

        // Check if we should continue to another generation iteration.
        // We continue if:
        // 1. There are function calls
        // 2. There are assistant tool outputs from texting calls
        const shouldContinue =
          funcCalls.length > 0 ||
          assistantToolOutputsCount > 0 ||
          (funcResults.length > 0 && funcCalls.length === 0);
        if (!shouldContinue) {
          break;
        }

        continue;
      } else {
        const newMsgs: ChatMessage[] = [];
        const streamedFuncCalls: FuncCallMsg[] = [];

        // Track thinking content for signature extraction during streaming
        let currentThinkingContent = '';
        let currentThinkingSignature = '';
        let currentSayingContent = '';

        // Create receiver using shared helper (unified TextingStreamParser integration)
        const receiver = createSayingEventsReceiver(dlg);

        // Direct streaming parser that forwards events without state tracking
        const parser = new TextingStreamParser(receiver);

        try {
          await llmGen.genToReceiver(
            providerCfg,
            agent,
            systemPrompt,
            funcTools,
            ctxMsgs,
            {
              thinkingStart: async () => {
                currentThinkingContent = '';
                currentThinkingSignature = '';
                await dlg.thinkingStart();
              },
              thinkingChunk: async (chunk: string) => {
                currentThinkingContent += chunk;
                // Extract Anthropic thinking signature from content
                const signatureMatch = currentThinkingContent.match(
                  /<thinking[^>]*>(.*?)<\/thinking>/s,
                );
                if (signatureMatch && signatureMatch[1]) {
                  currentThinkingSignature = signatureMatch[1].trim();
                }
                await dlg.thinkingChunk(chunk);
              },
              thinkingFinish: async () => {
                // Create thinking message with genseq and signature
                const genseq = dlg.activeGenSeq;
                if (genseq) {
                  const thinkingMessage: ThinkingMsg = {
                    type: 'thinking_msg',
                    role: 'assistant',
                    genseq,
                    content: currentThinkingContent,
                    provider_data: currentThinkingSignature
                      ? { signature: currentThinkingSignature }
                      : undefined,
                  };
                  newMsgs.push(thinkingMessage);
                }
                await dlg.thinkingFinish();
              },
              sayingStart: async () => {
                currentSayingContent = '';
                await dlg.sayingStart();
              },
              sayingChunk: async (chunk: string) => {
                currentSayingContent += chunk;
                parser.takeUpstreamChunk(chunk);
                // Dialog store handles persistence - maintain ordering guarantee
                await dlg.sayingChunk(chunk);
              },
              sayingFinish: async () => {
                parser.finalize();

                const sayingMessage: SayingMsg = {
                  type: 'saying_msg',
                  role: 'assistant',
                  genseq: dlg.activeGenSeq,
                  content: currentSayingContent,
                };
                newMsgs.push(sayingMessage);

                await dlg.sayingFinish();
              },
              funcCall: async (callId: string, name: string, args: string) => {
                const genseq = dlg.activeGenSeq;
                if (genseq === undefined) {
                  return;
                }
                streamedFuncCalls.push({
                  type: 'func_call_msg',
                  role: 'assistant',
                  genseq,
                  id: callId,
                  name,
                  arguments: args,
                });
              },
            },
            dlg.activeGenSeq,
          );
        } catch (err) {
          log.error(`LLM gen error:`, err);
          const errText = extractErrorDetails(err).message;
          try {
            await dlg.streamError(errText);
          } catch (emitErr) {
            log.warn('Failed to emit stream_error_evt via dlg.streamError', emitErr);
          }
        }

        // Execute collected calls concurrently after streaming completes
        const collectedCalls = parser.getCollectedCalls();

        if (collectedCalls.length > 0 && !collectedCalls[0].callId) {
          throw new Error(
            'Collected calls missing callId - parser should have allocated one per call',
          );
        }

        const results = await Promise.all(
          collectedCalls.map((call) =>
            executeTextingCall(
              dlg,
              agent,
              textingTools,
              call.firstMention,
              call.headLine,
              call.body,
              'assistant',
              call.callId,
            ),
          ),
        );

        // Combine results from all concurrent calls and track tool outputs for termination logic
        let toolOutputsCount = 0;
        for (const result of results) {
          if (result.toolOutputs.length > 0) {
            toolOutputsCount += result.toolOutputs.length;
            newMsgs.push(...result.toolOutputs);
          }
          if (result.suspend) {
            suspendForHuman = true;
          }
        }

        const funcResults: FuncResultMsg[] = [];
        if (streamedFuncCalls.length > 0) {
          const functionPromises = streamedFuncCalls.map(async (func) => {
            // Use the genseq from the func_call_msg to ensure tool results share the same generation sequence
            // This is critical for correct grouping in reconstructAnthropicContext()
            const callGenseq = func.genseq;
            // Use the LLM-allocated unique id for tracking
            // This id comes from func_call_msg and is the proper unique identifier
            const callId = func.id;

            // argsStr is still needed for UI event (funcCallRequested)
            const argsStr =
              typeof func.arguments === 'string'
                ? func.arguments
                : JSON.stringify(func.arguments ?? {});

            const tool = agentTools.find(
              (t): t is FuncTool => t.type === 'func' && t.name === func.name,
            );
            if (!tool) {
              const errorResult: FuncResultMsg = {
                type: 'func_result_msg',
                id: func.id,
                name: func.name,
                content: `Tool '${func.name}' not found`,
                role: 'tool',
                genseq: callGenseq,
              };
              await dlg.receiveFuncResult(errorResult);
              return;
            }

            let rawArgs: unknown = {};
            if (typeof func.arguments === 'string' && func.arguments.trim()) {
              try {
                rawArgs = JSON.parse(func.arguments);
              } catch (parseErr) {
                rawArgs = null;
                log.warn('Failed to parse function arguments as JSON', {
                  funcName: func.name,
                  arguments: func.arguments,
                  error: parseErr,
                });
              }
            }

            const validation = validateArgs(tool.parameters, rawArgs);
            let result: FuncResultMsg;
            if (validation.ok) {
              const argsObj = rawArgs as ToolArguments;

              // Emit func_call_requested event to build the func-call section UI
              try {
                await dlg.funcCallRequested(func.id, func.name, argsStr);
              } catch (err) {
                log.warn('Failed to emit func_call_requested event', err);
              }

              try {
                await dlg.persistFunctionCall(func.id, func.name, argsObj, callGenseq);
              } catch (err) {
                log.warn('Failed to persist function call', err);
              }

              try {
                const content = await tool.call(dlg, agent, argsObj);
                result = {
                  type: 'func_result_msg',
                  id: func.id,
                  name: func.name,
                  content: String(content),
                  role: 'tool',
                  genseq: callGenseq,
                };
              } catch (err) {
                result = {
                  type: 'func_result_msg',
                  id: func.id,
                  name: func.name,
                  content: `Function '${func.name}' execution failed: ${showErrorToAi(err)}`,
                  role: 'tool',
                  genseq: callGenseq,
                };
              }
            } else {
              result = {
                type: 'func_result_msg',
                id: func.id,
                name: func.name,
                content: `Invalid arguments: ${validation.error}`,
                role: 'tool',
                genseq: callGenseq,
              };
            }

            await dlg.receiveFuncResult(result);
            funcResults.push(result);
          });

          await Promise.all(functionPromises);
        }

        if (streamedFuncCalls.length > 0) {
          newMsgs.push(...streamedFuncCalls);
        }
        if (funcResults.length > 0) {
          newMsgs.push(...funcResults);
        }

        await dlg.addChatMessages(...newMsgs);

        // After tool execution, check latest remindersVer with published info,
        // publish new version to propagate updated reminders to ui
        if (dlg.remindersVer > pubRemindersVer) {
          try {
            await dlg.processReminderUpdates();
            pubRemindersVer = dlg.remindersVer;
          } catch (err) {
            log.warn('Failed to propagate reminder text after tools', err);
          }
        }

        await Promise.resolve();

        if (suspendForHuman) {
          break;
        }

        const shouldContinue =
          toolOutputsCount > 0 || streamedFuncCalls.length > 0 || funcResults.length > 0;
        if (!shouldContinue) {
          break;
        }
      }
    } finally {
      await dlg.notifyGeneratingFinish();
    }
  }

  return;
} // Close while loop

// Dialog stream has completed - no need to mark queue as complete since we're using receivers

// === SINGLE DIALOG HIERARCHY RESTORATION API ===

/**
 * Single API for restoring the complete dialog hierarchy (main dialog + all subdialogs)
 * This is the only public restoration API - all serialization is implicit
 */
export async function restoreDialogHierarchy(rootDialogId: string): Promise<{
  rootDialog: Dialog;
  subdialogs: Map<string, Dialog>;
  summary: {
    totalMessages: number;
    totalRounds: number;
    completionStatus: 'incomplete' | 'complete' | 'failed';
  };
}> {
  try {
    // Required modules are already imported statically

    // Load metadata to determine if this is a subdialog
    const metadata = await DialogPersistence.loadRootDialogMetadata(
      new DialogID(rootDialogId),
      'running',
    );

    // Assert that the loaded metadata matches the expected root dialog
    if (metadata?.supdialogId) {
      throw new Error(
        `Expected root dialog ${rootDialogId} but found subdialog metadata with supdialogId: ${metadata.supdialogId}`,
      );
    }

    // Create DialogID: for root dialog, use dialogId as both self and root
    const restoredRootDialogId = new DialogID(rootDialogId);

    // Restore the full dialog tree
    const dialogTree = await DialogPersistence.restoreDialogTree(new DialogID(rootDialogId));
    if (!dialogTree) {
      throw new Error(`Failed to restore dialog hierarchy for ${rootDialogId}`);
    }

    // Create all dialog instances with proper relationships
    const rootStore = new DiskFileDialogStore(restoredRootDialogId);
    const rootDialog = new RootDialog(
      rootStore,
      dialogTree.metadata.taskDocPath,
      restoredRootDialogId,
      dialogTree.metadata.agentId,
      {
        messages: dialogTree.messages,
        reminders: dialogTree.reminders,
        currentRound: dialogTree.currentRound,
      },
    );
    globalDialogRegistry.register(rootDialog);
    await rootDialog.loadPendingSubdialogsFromPersistence();

    // Restore all subdialogs in the hierarchy
    const subdialogs = new Map<string, Dialog>();
    const allSubdialogIds = await (async () => {
      const rootPath = DialogPersistence.getRootDialogPath(restoredRootDialogId, 'running');
      const subPath = path.join(rootPath, DialogPersistence['SUBDIALOGS_DIR']);
      try {
        const entries = await fs.promises.readdir(subPath, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        log.warn(`Failed to read subdialogs directory: ${subPath}, returning empty array`);
        return [];
      }
    })();

    for (const subdialogId of allSubdialogIds) {
      const subdialogState = await DialogPersistence.restoreDialog(
        new DialogID(subdialogId, restoredRootDialogId.rootId),
      );
      if (subdialogState) {
        // Create DialogID for subdialog: parent ID is the root dialog ID
        const restoredSubdialogId = new DialogID(subdialogId, rootDialog.id.rootId);
        const subdialogStore = new DiskFileDialogStore(restoredSubdialogId);
        const subdialog = new SubDialog(
          subdialogStore,
          rootDialog,
          subdialogState.metadata.taskDocPath,
          restoredSubdialogId,
          subdialogState.metadata.agentId,
          subdialogState.metadata.topicId,
          subdialogState.metadata.assignmentFromSup,
          {
            messages: subdialogState.messages,
            reminders: subdialogState.reminders,
            currentRound: subdialogState.currentRound,
          },
        );

        subdialogs.set(subdialogId, subdialog);
      }
    }

    // Calculate summary statistics
    const summary: {
      totalMessages: number;
      totalRounds: number;
      completionStatus: 'failed' | 'incomplete' | 'complete';
    } = {
      totalMessages:
        dialogTree.messages.length +
        Array.from(subdialogs.values()).reduce((sum, d) => sum + d.msgs.length, 0),
      totalRounds:
        dialogTree.currentRound +
        Math.max(...Array.from(subdialogs.values()).map((d) => d.currentRound), 0),
      completionStatus: 'incomplete',
    };

    return {
      rootDialog,
      subdialogs,
      summary,
    };
  } catch (error) {
    log.error(`Failed to restore dialog hierarchy for ${rootDialogId}:`, error);
    throw error;
  }
}

// === TEAMMATE CALL TYPE SYSTEM (Phase 5) ===
// === PHASE 11 EXTENSION: Type A for subdialog calling its DIRECT parent (supdialog) ===

/**
 * Result of parsing a teammate call pattern.
 * Three types based on the call syntax:
 * - Type A: @<supdialogAgentId> - subdialog calling its direct parent (supdialog suspension)
 * - Type B: @<agentId> !topic <topicId> - creates/resumes registered subdialog
 * - Type C: @<agentId> - creates transient unregistered subdialog
 */
export type TeammateCallParseResult = TeammateCallTypeA | TeammateCallTypeB | TeammateCallTypeC;

/**
 * Type A: Supdialog suspension call.
 * Syntax: @<supdialogAgentId> (when subdialog calls its direct parent)
 * Suspends the subdialog, drives the supdialog for one round, returns response to subdialog.
 * Only triggered when the @agentId matches the current dialog's supdialog.agentId.
 */
export interface TeammateCallTypeA {
  type: 'A';
  agentId: string;
}

/**
 * Type B: Registered subdialog call with topic.
 * Syntax: @<agentId> !topic <topicId>
 * Creates or resumes a registered subdialog, tracked in registry.yaml.
 */
export interface TeammateCallTypeB {
  type: 'B';
  agentId: string;
  topicId: string;
}

/**
 * Type C: Transient subdialog call (unregistered).
 * Syntax: @<agentId> (without !topic)
 * Creates a one-off subdialog that moves to done/ on completion.
 */
export interface TeammateCallTypeC {
  type: 'C';
  agentId: string;
}

function isValidTopicId(topicId: string): boolean {
  const segments = topicId.split('.');
  if (segments.length === 0) return false;
  return segments.every((segment) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(segment));
}

function extractTopicIdFromHeadline(headLine: string, firstMention: string): string | null {
  const mentionToken = `@${firstMention}`;
  const mentionIndex = headLine.indexOf(mentionToken);
  if (mentionIndex < 0) return null;
  const afterMention = headLine.slice(mentionIndex + mentionToken.length);
  const trimmed = afterMention.trimStart();
  if (!trimmed.startsWith('!topic')) return null;
  const rest = trimmed.slice('!topic'.length).trimStart();
  if (!rest) return null;
  const match = rest.match(/^([a-zA-Z][a-zA-Z0-9_-]*(?:\\.[a-zA-Z0-9_-]+)*)/);
  if (!match) return null;
  const topicId = match[1] ?? '';
  return isValidTopicId(topicId) ? topicId : null;
}

/**
 * Parse a teammate call pattern and return the appropriate type result.
 *
 * Patterns:
 * - @<supdialogAgentId> (in subdialog context, matching supdialog.agentId) → Type A (supdialog suspension)
 * - @<agentId> !topic <topicId> → Type B (registered subdialog)
 * - @<agentId> → Type C (transient subdialog)
 *
 * @param firstMention The first teammate mention extracted by the streaming parser (e.g., "cmdr")
 * @param headLine The full headline text from the streaming parser
 * @param currentDialog Optional current dialog context to detect Type A (subdialog calling parent)
 * @returns The parsed TeammateCallParseResult
 */
export function parseTeammateCall(
  firstMention: string,
  headLine: string,
  currentDialog?: Dialog,
): TeammateCallParseResult {
  const topicId = extractTopicIdFromHeadline(headLine, firstMention);
  if (topicId) {
    return {
      type: 'B',
      agentId: firstMention,
      topicId,
    };
  }

  // Phase 11: Check if this is a Type A call (subdialog calling its direct parent)
  // Type A only applies when:
  // 1. A current dialog context is provided
  // 2. The current dialog is a SubDialog (has a supdialog)
  // 3. The @agentId matches the supdialog's agentId
  if (
    currentDialog &&
    currentDialog.supdialog &&
    firstMention === currentDialog.supdialog.agentId
  ) {
    return {
      type: 'A',
      agentId: firstMention,
    };
  }

  // Type C: Any @agentId is a transient subdialog call
  return {
    type: 'C',
    agentId: firstMention,
  };
}

// === CONVENIENCE METHODS USING SINGLE RESTORATION API ===

/**
 * Continue dialog with human response (uses single restoration API)
 */
export async function continueDialogWithHumanResponse(
  rootDialogId: string,
  humanPrompt: HumanPrompt,
  options?: {
    targetSubdialogId?: string;
    continuationType?: 'answer' | 'followup' | 'retry' | 'new_message';
  },
): Promise<void> {
  try {
    // Restore the complete dialog hierarchy (pure restoration, no continuation)
    const result = await restoreDialogHierarchy(rootDialogId);

    // Then perform continuation separately
    if (options?.targetSubdialogId && result.subdialogs.has(options.targetSubdialogId)) {
      // Continue specific subdialog
      const targetSubdialog = result.subdialogs.get(options.targetSubdialogId)!;
      await driveDialogStream(targetSubdialog, humanPrompt);
    } else {
      // Continue root dialog
      await driveDialogStream(result.rootDialog, humanPrompt);
    }
  } catch (error) {
    log.error(`Failed to continue dialog with human response:`, error);
    throw error;
  }
}

/**
 * Continue root dialog with followup message (uses single restoration API)
 */
export async function continueRootDialog(
  rootDialogId: string,
  humanPrompt: HumanPrompt,
): Promise<void> {
  try {
    // Restore the complete dialog hierarchy (pure restoration, no continuation)
    const result = await restoreDialogHierarchy(rootDialogId);

    // Then perform continuation separately
    await driveDialogStream(result.rootDialog, humanPrompt);
  } catch (error) {
    log.error(`Failed to continue root dialog:`, error);
    throw error;
  }
}

/**
 * Unified function to extract the last assistant message from an array of messages.
 * Prefers saying_msg over thinking_msg, returns full content without truncation.
 *
 * @param messages Array of chat messages to search
 * @param defaultMessage Default message if no assistant message found
 * @returns The extracted message content or default
 */
function extractLastAssistantResponse(
  messages: Array<{ type: string; content?: string }>,
  defaultMessage: string,
): string {
  let responseText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'saying_msg' && typeof msg.content === 'string') {
      responseText = msg.content;
      break;
    }
    if (msg.type === 'thinking_msg' && typeof msg.content === 'string') {
      responseText = msg.content;
      // Keep looking for a saying_msg which is more complete
    }
  }

  // If no assistant message found, use the default
  if (!responseText) {
    responseText = defaultMessage;
  }

  return responseText;
}

/**
 * Extract response from a completed subdialog's messages.
 * Returns the full last assistant message (saying_msg preferred over thinking_msg).
 */
async function extractSubdialogResponse(subdialogId: DialogID): Promise<string> {
  try {
    const subdialogState = await DialogPersistence.restoreDialog(subdialogId, 'running');
    if (!subdialogState) {
      log.warn('Could not restore subdialog for response extraction', {
        subdialogId: subdialogId.key(),
      });
      return 'Subdialog completed without producing output.';
    }

    return extractLastAssistantResponse(
      subdialogState.messages,
      'Subdialog completed without producing output.',
    );
  } catch (err) {
    log.warn('Failed to extract subdialog response', {
      subdialogId: subdialogId.key(),
      error: err,
    });
    return 'Subdialog completed with errors.';
  }
}

/**
 * Helper function to drive a subdialog to completion and extract response.
 *
 * @param parentDialog The parent dialog that created/owns the subdialog
 * @param subdialog The subdialog to drive
 * @returns The response string from the subdialog
 */
async function driveSubdialogToCompletion(
  subdialog: SubDialog,
  humanPrompt?: HumanPrompt,
  waitInQue: boolean = true,
): Promise<string> {
  await driveDialogStream(subdialog, humanPrompt, waitInQue);
  const responseText = await extractSubdialogResponse(subdialog.id);
  return responseText;
}

/**
 * Phase 11: Extract response from supdialog's current messages for Type A mechanism.
 * Used when a subdialog calls its parent (supdialog) and needs the parent's response.
 * Unlike extractSubdialogResponse which reads from persistence, this reads from the
 * in-memory dialog object which contains the latest messages after driving.
 *
 * @param supdialog The supdialog that was just driven
 * @returns The response text from the supdialog's last assistant message
 */
async function extractSupdialogResponseForTypeA(supdialog: Dialog): Promise<string> {
  try {
    return extractLastAssistantResponse(
      supdialog.msgs,
      'Supdialog completed without producing output.',
    );
  } catch (err) {
    log.warn('Failed to extract supdialog response for Type A', { error: err });
    return 'Supdialog completed with errors.';
  }
}

type LastAssistantMessage = {
  content: string;
  genseq: number;
};

function getLastAssistantMessage(messages: ChatMessage[]): LastAssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (
      (msg.type === 'saying_msg' || msg.type === 'thinking_msg') &&
      typeof msg.content === 'string'
    ) {
      return { content: msg.content, genseq: msg.genseq };
    }
  }
  return null;
}

function resolveCallerDialog(subdialog: SubDialog, assignment?: AssignmentFromSup): Dialog | null {
  const rootDialog = subdialog.supdialog instanceof RootDialog ? subdialog.supdialog : undefined;
  if (!rootDialog) {
    return null;
  }
  const callerDialogId = assignment?.callerDialogId;
  if (callerDialogId) {
    const candidate = rootDialog.lookupDialog(callerDialogId);
    if (candidate) {
      return candidate;
    }
  }
  return rootDialog;
}

async function updateSubdialogAssignment(
  subdialog: SubDialog,
  assignment: AssignmentFromSup,
): Promise<void> {
  subdialog.assignmentFromSup = assignment;
  await DialogPersistence.updateSubdialogAssignment(subdialog.id, assignment);
}

async function reportSubdialogResponseToCaller(
  subdialog: SubDialog,
  before: LastAssistantMessage | null,
): Promise<void> {
  const assignment = subdialog.assignmentFromSup;
  if (!assignment) {
    return;
  }
  const callerDialog = resolveCallerDialog(subdialog, assignment);
  if (!callerDialog) {
    return;
  }
  const after = getLastAssistantMessage(subdialog.msgs);
  if (!after) {
    return;
  }
  if (before && before.genseq === after.genseq && before.content === after.content) {
    return;
  }
  const responseText = after.content;
  const headLine =
    assignment.headLine && assignment.headLine.trim() !== ''
      ? assignment.headLine
      : 'Subdialog response';
  const responseContent = `Teammate response received from @${subdialog.agentId} for call "${headLine}". Do not re-issue this call unless asked.\n\n${responseText}`;
  const originRole = assignment.originRole;
  const originMemberId = assignment.originMemberId;

  await callerDialog.receiveTeammateResponse(
    subdialog.agentId,
    headLine,
    responseContent,
    'completed',
    subdialog.id,
    {
      response: responseText,
      agentId: subdialog.agentId,
      callId: assignment.callId,
      originRole,
      originMemberId,
    },
  );
}

// === PHASE 6: SUBDIALOG SUPPLY MECHANISM ===

/**
 * Create a Type A subdialog for supdialog suspension.
 * Creates subdialog, persists pending record, and returns suspended promise.
 *
 * Type A: Supdialog suspension call where subdialog calls parent and parent suspends.
 *
 * @param supdialog The parent dialog making the call
 * @param targetAgentId The agent to handle the subdialog
 * @param headLine The headline for the subdialog
 * @param callBody The body content for the subdialog
 * @returns Promise resolving when subdialog is created and pending record saved
 */
export async function createSubdialogForSupdialog(
  supdialog: RootDialog,
  targetAgentId: string,
  headLine: string,
  callBody: string,
  callId: string,
): Promise<void> {
  try {
    // Create the subdialog
    const subdialog = await supdialog.createSubDialog(targetAgentId, headLine, callBody, {
      originRole: 'assistant',
      originMemberId: supdialog.agentId,
      callerDialogId: supdialog.id.selfId,
      callId,
    });
    supdialog.addPendingSubdialogs([subdialog.id]);

    // Persist pending subdialog record
    const pendingRecord: PendingSubdialogRecordType = {
      subdialogId: subdialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      headLine,
      targetAgentId,
      callType: 'A',
    };

    // Load existing pending subdialogs and add new one
    const existingPending = await DialogPersistence.loadPendingSubdialogs(supdialog.id);
    existingPending.push(pendingRecord);
    await DialogPersistence.savePendingSubdialogs(supdialog.id, existingPending);

    // Drive the subdialog asynchronously
    void (async () => {
      try {
        const initPrompt: HumanPrompt = {
          content: formatSubdialogUserPrompt(supdialog.agentId, headLine, callBody),
          msgId: generateDialogID(),
          skipTextingParse: true,
        };
        await driveDialogStream(subdialog, initPrompt, true);
        const responseText = await extractSubdialogResponse(subdialog.id);
        await supplyResponseToSupdialog(supdialog, subdialog.id, responseText, 'A', callId);
      } catch (err) {
        log.warn('Type A subdialog processing error:', err);
      }
    })();
  } catch (error) {
    log.error('Failed to create Type A subdialog for supdialog', {
      supdialogId: supdialog.id.selfId,
      targetAgentId,
      error,
    });
    throw error;
  }
}

/**
 * Create a Type B registered subdialog with registry lookup/register.
 * Creates or resumes a registered subdialog tracked in registry.yaml.
 *
 * Type B: @<agentId> !topic <topicId> - Creates/resumes registered subdialog.
 *
 * @param rootDialog The root dialog making the call
 * @param agentId The agent to handle the subdialog
 * @param topicId The topic identifier for registry lookup
 * @param headLine The headline for the subdialog
 * @param callBody The body content for the subdialog
 * @param originRole Origin role for the subdialog
 * @returns Promise resolving when subdialog is created/registered
 */
/**
 * Supply a response from a completed subdialog to the parent dialog.
 * Writes the response to persistence for later incorporation.
 *
 * @param parentDialog The parent dialog that created the subdialog
 * @param subdialogId The ID of the completed subdialog
 * @param responseText The full response text from the subdialog
 * @param callType The call type ('A', 'B', or 'C')
 * @param callId Optional callId for Type C subdialog tracking
 */
export async function supplyResponseToSupdialog(
  parentDialog: Dialog,
  subdialogId: DialogID,
  responseText: string,
  callType: 'A' | 'B' | 'C',
  callId?: string,
): Promise<void> {
  try {
    const response = {
      subdialogId: subdialogId.selfId,
      summary: responseText,
      completedAt: formatUnifiedTimestamp(new Date()),
      callType,
    };

    // Load existing responses and add new one
    const existingResponses = await DialogPersistence.loadSubdialogResponses(parentDialog.id);
    existingResponses.push(response);
    await DialogPersistence.saveSubdialogResponses(parentDialog.id, existingResponses);

    // Remove from pending subdialogs
    const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(parentDialog.id);
    let pendingRecord: PendingSubdialogRecordType | undefined;
    for (const pending of pendingSubdialogs) {
      if (pending.subdialogId === subdialogId.selfId) {
        pendingRecord = pending;
        break;
      }
    }
    const filteredPending = pendingSubdialogs.filter((p) => p.subdialogId !== subdialogId.selfId);
    await DialogPersistence.savePendingSubdialogs(parentDialog.id, filteredPending);

    let responderId = subdialogId.rootId;
    let responderAgentId: string | undefined;
    let headLine = responseText;
    let originRole: 'user' | 'assistant' = 'assistant';
    let originMemberId: string | undefined;

    try {
      let metadata = await DialogPersistence.loadDialogMetadata(subdialogId, 'running');
      if (!metadata) {
        metadata = await DialogPersistence.loadDialogMetadata(subdialogId, 'completed');
      }
      if (metadata?.assignmentFromSup) {
        originRole = metadata.assignmentFromSup.originRole;
        originMemberId = metadata.assignmentFromSup.originMemberId;
        if (!pendingRecord) {
          const assignmentHead = metadata.assignmentFromSup.headLine;
          if (typeof assignmentHead === 'string' && assignmentHead.trim() !== '') {
            headLine = assignmentHead;
          }
        }
      }
      if (!pendingRecord && metadata && typeof metadata.agentId === 'string') {
        if (metadata.agentId.trim() !== '') {
          responderId = metadata.agentId;
          responderAgentId = metadata.agentId;
        }
      }
    } catch (err) {
      log.warn('Failed to load subdialog metadata for response record', {
        parentId: parentDialog.id.selfId,
        subdialogId: subdialogId.selfId,
        error: err,
      });
    }

    if (!originMemberId) {
      originMemberId = originRole === 'assistant' ? parentDialog.agentId : 'human';
    }

    if (pendingRecord) {
      responderId = pendingRecord.targetAgentId;
      responderAgentId = pendingRecord.targetAgentId;
      headLine = pendingRecord.headLine;
    }

    if (headLine.trim() === '') {
      headLine = responseText.slice(0, 100) + (responseText.length > 100 ? '...' : '');
    }

    const responseContent = `Teammate response received from @${responderId} for call "${headLine}". Do not re-issue this call unless asked.\n\n${responseText}`;
    const resultMsg: TextingCallResultMsg = {
      type: 'call_result_msg',
      role: 'tool',
      responderId,
      headLine,
      status: 'completed',
      content: responseContent,
    };
    await parentDialog.addChatMessages(resultMsg);

    const resolvedAgentId = responderAgentId ?? responderId;
    const resolvedOriginMemberId =
      originMemberId ?? (originRole === 'assistant' ? parentDialog.agentId : 'human');
    const resolvedCallId = callId ?? '';

    await parentDialog.receiveTeammateResponse(
      responderId,
      headLine,
      responseContent,
      'completed',
      subdialogId,
      {
        response: responseText,
        agentId: resolvedAgentId,
        callId: resolvedCallId,
        originRole,
        originMemberId: resolvedOriginMemberId,
      },
    );

    // Remove from parent's pending list (in-memory)
    parentDialog.removePendingSubdialog(subdialogId);

    // Auto-revive when pending list is empty
    if (!parentDialog.hasPendingSubdialogs()) {
      parentDialog.clearPendingSubdialogs();
      log.info(
        `All Type ${callType} subdialogs complete, parent ${parentDialog.id.selfId} auto-reviving`,
      );
      const resumePrompt: HumanPrompt = {
        content: responseContent,
        msgId: generateDialogID(),
        skipTextingParse: true,
      };
      void driveDialogStream(parentDialog, resumePrompt, true);
    }
  } catch (error) {
    log.error('Failed to supply subdialog response', {
      parentId: parentDialog.id.selfId,
      subdialogId: subdialogId.selfId,
      error,
    });
    throw error;
  }
}

/**
 * Check if all pending Type A subdialogs are satisfied (have responses).
 *
 * @param rootDialogId The root dialog ID to check
 * @returns Promise<boolean> True if all Type A subdialogs have responses
 */
export async function areAllSubdialogsSatisfied(rootDialogId: DialogID): Promise<boolean> {
  try {
    const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(rootDialogId);
    const responses = await DialogPersistence.loadSubdialogResponses(rootDialogId);

    // Check if any pending subdialogs have responses
    const pendingIds = new Set(pendingSubdialogs.map((p) => p.subdialogId));
    const respondedIds = new Set(responses.map((r) => r.subdialogId));

    // Check if all pending subdialogs have been responded to
    for (const pendingId of pendingIds) {
      if (!respondedIds.has(pendingId)) {
        return false;
      }
    }

    return true;
  } catch (error) {
    log.error('Failed to check subdialog satisfaction', {
      rootDialogId: rootDialogId.selfId,
      error,
    });
    return false;
  }
}

/**
 * Incorporate subdialog responses into the parent dialog and resume.
 * Reads responses from persistence and clears them after incorporation.
 *
 * @param rootDialog The root dialog to resume
 * @returns Promise<Array<{ subdialogId: string; summary: string; callType: 'A' | 'B' | 'C' }>>
 *   Array of incorporated responses (summary holds full response text)
 */
export async function incorporateSubdialogResponses(rootDialog: RootDialog): Promise<
  Array<{
    subdialogId: string;
    summary: string;
    callType: 'A' | 'B' | 'C';
  }>
> {
  try {
    const responses = await DialogPersistence.loadSubdialogResponses(rootDialog.id);

    // Incorporate each response
    for (const response of responses) {
      const subdialogId = new DialogID(response.subdialogId, rootDialog.id.rootId);

      // Add to parent's pending summaries
      rootDialog.addPendingSubdialogSummary(subdialogId, response.summary);

      // Emit subdialog summary event (payload contains full response text)
      await rootDialog.postSubdialogSummary(subdialogId, response.summary);
    }

    // Clear responses after incorporation
    await DialogPersistence.saveSubdialogResponses(rootDialog.id, []);

    // Clear pending subdialogs that have been responded to
    const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(rootDialog.id);
    const respondedIds = new Set(responses.map((r) => r.subdialogId));
    const filteredPending = pendingSubdialogs.filter((p) => !respondedIds.has(p.subdialogId));
    await DialogPersistence.savePendingSubdialogs(rootDialog.id, filteredPending);

    return responses;
  } catch (error) {
    log.error('Failed to incorporate subdialog responses', {
      rootDialogId: rootDialog.id.selfId,
      error,
    });
    throw error;
  }
}

/**
 * Collect texting calls using the streaming parser, then execute them
 */
async function executeTextingCalls(
  dlg: Dialog,
  agent: Team.Member,
  textingTools: TextingTool[],
  collectedCalls: CollectedTextingCall[],
  originRole: 'user' | 'assistant',
): Promise<{ suspend: boolean; toolOutputs: ChatMessage[]; subdialogsCreated: DialogID[] }> {
  // Execute collected calls concurrently
  const results = await Promise.all(
    collectedCalls.map((call) =>
      executeTextingCall(
        dlg,
        agent,
        textingTools,
        call.firstMention,
        call.headLine,
        call.body,
        originRole,
        call.callId,
      ),
    ),
  );

  // Combine results from all concurrent calls
  const suspend = results.some((result) => result.suspend);
  const toolOutputs = results.flatMap((result) => result.toolOutputs);
  const subdialogsCreated = results.flatMap((result) => result.subdialogsCreated);

  return { suspend, toolOutputs, subdialogsCreated };
}

/**
 * Execute a single texting call using Phase 5 3-Type Taxonomy.
 * Handles Type A (supdialog suspension), Type B (registered subdialog), and Type C (transient subdialog).
 */
async function executeTextingCall(
  dlg: Dialog,
  agent: Team.Member,
  textingTools: TextingTool[],
  firstMention: string,
  headLine: string,
  body: string,
  originRole: 'user' | 'assistant',
  callId: string,
): Promise<{
  toolOutputs: ChatMessage[];
  suspend: boolean;
  subdialogsCreated: DialogID[];
}> {
  const toolOutputs: ChatMessage[] = [];
  let suspend = false;
  const subdialogsCreated: DialogID[] = [];

  const team = await Team.load();
  const intrinsicTools = dlg.getIntrinsicTools();
  const member = team.getMember(firstMention);

  // === Q4H: Handle @human teammate calls (Questions for Human) ===
  // Q4H works for both user-initiated and assistant-initiated @human calls
  const isQ4H = firstMention === 'human';
  if (isQ4H) {
    try {
      // Create HumanQuestion entry
      const questionId = `q4h-${generateDialogID()}`;
      const question: HumanQuestion = {
        id: questionId,
        headLine: headLine.trim(),
        bodyContent: body.trim(),
        askedAt: formatUnifiedTimestamp(new Date()),
        callSiteRef: {
          round: dlg.currentRound,
          messageIndex: dlg.msgs.length,
        },
      };

      // Load existing questions and add new one
      const existingQuestions = await DialogPersistence.loadQuestions4HumanState(dlg.id);
      const previousCount = existingQuestions.length;
      existingQuestions.push(question);

      // Save to q4h.yaml
      await DialogPersistence._saveQuestions4HumanState(dlg.id, existingQuestions);

      // Emit new_q4h_asked event
      const newQuestionEvent: NewQ4HAskedEvent = {
        type: 'new_q4h_asked',
        question: {
          id: question.id,
          dialogId: dlg.id.selfId,
          headLine: question.headLine,
          bodyContent: question.bodyContent,
          askedAt: question.askedAt,
          callSiteRef: question.callSiteRef,
        },
      };

      // Import postDialogEvent for event emission
      const { postDialogEvent } = await import('../evt-registry');
      postDialogEvent(dlg, newQuestionEvent);

      // Return empty output and suspend for human answer
      return { toolOutputs, suspend: true, subdialogsCreated: [] };
    } catch (q4hErr: unknown) {
      const errMsg = q4hErr instanceof Error ? q4hErr.message : String(q4hErr);
      const errStack = q4hErr instanceof Error ? q4hErr.stack : '';
      log.error('Q4H: Failed to register question', q4hErr, {
        dialogId: dlg.id.selfId,
        headLine: headLine.substring(0, 100),
      });
      // Don't throw - allow fallback to "Unknown call" handler
    }
  }

  if (member) {
    // This is a teammate call - parse using Phase 5 taxonomy
    // Parse the call text to determine type A/B/C
    const parseResult = parseTeammateCall(firstMention, headLine, dlg);

    // Phase 11: Type A handling - subdialog calling its direct parent (supdialog)
    // This suspends the subdialog, drives the supdialog for one round, then returns to subdialog
    if (parseResult.type === 'A') {
      // Verify this is a subdialog with a supdialog
      if (dlg.supdialog) {
        const supdialog = dlg.supdialog;

        // Suspend the subdialog
        dlg.setSuspensionState('suspended');

        try {
          const supPrompt: HumanPrompt = {
            content: formatSupdialogCallPrompt(dlg.agentId, headLine, body),
            msgId: generateDialogID(),
            skipTextingParse: true,
          };
          // Drive the supdialog for one round (queue if already driving)
          await driveDialogStream(supdialog, supPrompt, true);

          // Extract response from supdialog's last assistant message
          const responseText = await extractSupdialogResponseForTypeA(supdialog);
          const responseContent = `Teammate response received from @${parseResult.agentId} for call "${headLine}". Do not re-issue this call unless asked.\n\n${responseText}`;

          // Resume the subdialog with the supdialog's response
          dlg.setSuspensionState('resumed');

          const resultMsg: TextingCallResultMsg = {
            type: 'call_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            headLine,
            status: 'completed',
            content: responseContent,
          };
          toolOutputs.push(resultMsg);
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            headLine,
            responseContent,
            'completed',
            supdialog.id,
            {
              response: responseText,
              agentId: parseResult.agentId,
              callId,
              originRole,
              originMemberId: originRole === 'assistant' ? dlg.agentId : 'human',
            },
          );
        } catch (err) {
          log.warn('Type A supdialog processing error:', err);
          // Resume the subdialog even on error
          dlg.setSuspensionState('resumed');
          const errorText = `❌ **Error processing request to @${parseResult.agentId}:**\n\n${showErrorToAi(err)}`;
          const resultMsg: TextingCallResultMsg = {
            type: 'call_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            headLine,
            status: 'failed',
            content: errorText,
          };
          toolOutputs.push(resultMsg);
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            headLine,
            errorText,
            'failed',
            supdialog.id,
            {
              response: errorText,
              agentId: parseResult.agentId,
              callId,
              originRole,
              originMemberId: originRole === 'assistant' ? dlg.agentId : 'human',
            },
          );
        }
      } else {
        log.warn('Type A call on dialog without supdialog, falling back to Type C', {
          dialogId: dlg.id.selfId,
        });
        // Fall through to Type C handling
      }
    } else if (parseResult.type === 'B') {
      // Type B: Registered subdialog with topic (root registry, caller can be root or subdialog)
      const callerDialog = dlg;
      const rootDialog =
        dlg instanceof RootDialog
          ? dlg
          : dlg.supdialog instanceof RootDialog
            ? dlg.supdialog
            : undefined;

      if (!rootDialog) {
        log.warn('Type B call without root dialog, falling back to Type C', {
          dialogId: dlg.id.selfId,
        });
        try {
          const callerLabel = originRole === 'assistant' ? dlg.agentId : 'human';
          const sub = await dlg.createSubDialog(parseResult.agentId, headLine, body, {
            originRole,
            originMemberId: originRole === 'assistant' ? dlg.agentId : 'human',
            callerDialogId: callerDialog.id.selfId,
            callId,
            topicId: parseResult.topicId,
          });

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'C',
            topicId: parseResult.topicId,
          };
          const existingPending = await DialogPersistence.loadPendingSubdialogs(dlg.id);
          existingPending.push(pendingRecord);
          await DialogPersistence.savePendingSubdialogs(dlg.id, existingPending);

          const task = (async () => {
            try {
              const initPrompt: HumanPrompt = {
                content: formatSubdialogUserPrompt(callerLabel, headLine, body),
                msgId: generateDialogID(),
                skipTextingParse: true,
              };
              const responseText = await driveSubdialogToCompletion(sub, initPrompt);
              await supplyResponseToSupdialog(dlg, sub.id, responseText, 'C', callId);
            } catch (err) {
              log.warn('Type B fallback subdialog processing error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(sub.id);
          suspend = true;
        } catch (err) {
          log.warn('Type B fallback subdialog creation error:', err);
        }
      } else {
        const originMemberId = originRole === 'assistant' ? dlg.agentId : 'human';
        const callerLabel = originMemberId;
        const assignment: AssignmentFromSup = {
          headLine,
          callBody: body,
          originRole,
          originMemberId,
          callerDialogId: callerDialog.id.selfId,
          callId,
        };

        const existingSubdialog = rootDialog.lookupSubdialog(
          parseResult.agentId,
          parseResult.topicId,
        );

        const pendingOwner = callerDialog;

        if (existingSubdialog) {
          const resumePrompt: HumanPrompt = {
            content: formatSubdialogUserPrompt(callerLabel, headLine, body),
            msgId: generateDialogID(),
            skipTextingParse: true,
          };
          try {
            await updateSubdialogAssignment(existingSubdialog, assignment);
          } catch (err) {
            log.warn('Failed to update registered subdialog assignment', err);
          }

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: existingSubdialog.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'B',
            topicId: parseResult.topicId,
          };
          const existingPending = await DialogPersistence.loadPendingSubdialogs(pendingOwner.id);
          existingPending.push(pendingRecord);
          await DialogPersistence.savePendingSubdialogs(pendingOwner.id, existingPending);

          const task = (async () => {
            try {
              const responseText = await driveSubdialogToCompletion(
                existingSubdialog,
                resumePrompt,
              );
              await supplyResponseToSupdialog(
                pendingOwner,
                existingSubdialog.id,
                responseText,
                'B',
                callId,
              );
            } catch (err) {
              log.warn('Type B registered subdialog resumption error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(existingSubdialog.id);
          suspend = true;
        } else {
          const sub = await rootDialog.createSubDialog(parseResult.agentId, headLine, body, {
            originRole,
            originMemberId,
            callerDialogId: callerDialog.id.selfId,
            callId,
            topicId: parseResult.topicId,
          });
          rootDialog.registerSubdialog(sub);
          await rootDialog.saveSubdialogRegistry();

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'B',
            topicId: parseResult.topicId,
          };
          const existingPending = await DialogPersistence.loadPendingSubdialogs(pendingOwner.id);
          existingPending.push(pendingRecord);
          await DialogPersistence.savePendingSubdialogs(pendingOwner.id, existingPending);

          const task = (async () => {
            try {
              const initPrompt: HumanPrompt = {
                content: formatSubdialogUserPrompt(callerLabel, headLine, body),
                msgId: generateDialogID(),
                skipTextingParse: true,
              };
              const responseText = await driveSubdialogToCompletion(sub, initPrompt);
              await supplyResponseToSupdialog(pendingOwner, sub.id, responseText, 'B', callId);
            } catch (err) {
              log.warn('Type B subdialog processing error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(sub.id);
          suspend = true;
        }
      }
    }

    // Type C: Transient subdialog (unregistered)
    if (parseResult.type === 'C') {
      const mentions = Array.from(new Set(extractMentions(headLine)));
      const targets = mentions.filter((m) => !!team.getMember(m));
      const callerLabel = originRole === 'assistant' ? dlg.agentId : 'human';

      for (const tgt of targets) {
        try {
          const sub = await dlg.createSubDialog(tgt, headLine, body, {
            originRole,
            originMemberId: originRole === 'assistant' ? dlg.agentId : 'human',
            callerDialogId: dlg.id.selfId,
            callId,
          });
          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: tgt,
            callType: 'C',
          };
          const existingPending = await DialogPersistence.loadPendingSubdialogs(dlg.id);
          existingPending.push(pendingRecord);
          await DialogPersistence.savePendingSubdialogs(dlg.id, existingPending);

          const task = (async () => {
            try {
              const initPrompt: HumanPrompt = {
                content: formatSubdialogUserPrompt(callerLabel, headLine, body),
                msgId: generateDialogID(),
                skipTextingParse: true,
              };
              const responseText = await driveSubdialogToCompletion(sub, initPrompt);
              await supplyResponseToSupdialog(dlg, sub.id, responseText, 'C', callId);
              // Type C: Move to done/ on completion (handled by subdialog completion)
            } catch (err) {
              log.warn('Type C subdialog processing error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(sub.id);
        } catch (err) {
          log.warn('Subdialog creation error:', err);
        }
      }

      if (subdialogsCreated.length > 0) {
        suspend = true;
      }
    }
  } else {
    // Not a team member - check for texting tools
    let tool =
      textingTools.find((t) => t.name === firstMention) ||
      intrinsicTools.find((t) => t.name === firstMention);
    if (!tool) {
      try {
        const globalTool = getTool(firstMention);
        switch (globalTool?.type) {
          case 'texter':
            tool = globalTool;
            break;
          case 'func':
            log.warn(`Function tool "${globalTool.name}" should not be called as texting tool!`);
            break;
        }
      } catch (toolErr) {
        // Fall through
      }
    }
    if (tool) {
      try {
        const raw = await tool.call(dlg, agent, headLine, body);

        // Always use what the tool returned
        if (raw.messages) {
          toolOutputs.push(...raw.messages);
        }

        // Emit tool response with callId (inline bubble) - callId is for UI correlation only
        await dlg.receiveToolResponse(
          firstMention,
          headLine,
          raw.status === 'completed' ? (raw.result ?? 'OK') : raw.result,
          raw.status,
          callId,
        );

        // Clear callId after response
        dlg.clearCurrentCallId();

        if (tool.backfeeding && !raw.messages) {
          log.warn(
            `Texting tool @${firstMention} returned empty output while backfeeding=true`,
            undefined,
            { headLine },
          );
        }
      } catch (e) {
        const msg = `❌ **Error executing @${firstMention}**\n\n- Head: ${headLine}\n- Detail: ${showErrorToAi(e)}\n\n**Body**\n\n\`\`\`\n${body}\n\`\`\``;
        toolOutputs.push({
          type: 'environment_msg',
          role: 'user',
          content: msg,
        });

        // Create error message (no callId - for LLM context only)
        const errorMsg: TextingCallResultMsg = {
          type: 'call_result_msg',
          role: 'tool',
          responderId: firstMention,
          headLine,
          status: 'failed',
          content: msg,
        };
        toolOutputs.push(errorMsg);

        // Emit tool response with callId for UI correlation
        await dlg.receiveToolResponse(firstMention, headLine, msg, 'failed', callId);

        // Clear callId after response
        dlg.clearCurrentCallId();
      }
    } else {
      const msg = `❌ **Unknown call** \`@${firstMention}\`\n- Head: ${headLine}`;
      toolOutputs.push({
        type: 'environment_msg',
        role: 'user',
        content: msg,
      });

      // Create error message for LLM context
      const errorMsg: TextingCallResultMsg = {
        type: 'call_result_msg',
        role: 'tool',
        responderId: firstMention,
        headLine,
        status: 'failed',
        content: msg,
      };
      toolOutputs.push(errorMsg);

      // Generate synthetic callId for unknown call (no actual call was made)
      const unknownCallId = `unknown:${firstMention}:${headLine}`;
      dlg.setCurrentCallId(unknownCallId);

      // Emit tool response with callId for inline display (like tool failures)
      await dlg.receiveToolResponse(firstMention, headLine, msg, 'failed', unknownCallId);

      // Clear synthetic callId after response
      dlg.clearCurrentCallId();
      log.warn(`Unknown call @${firstMention} | Head: ${headLine}`);
    }
  }

  return { toolOutputs, suspend, subdialogsCreated };
}
