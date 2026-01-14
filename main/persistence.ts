/**
 * Module: persistence
 *
 * Modern dialog persistence with strong typing and latest.yaml support.
 * Provides file-based storage with append-only events and atomic operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';
import * as yaml from 'yaml';
import { Dialog, DialogID, DialogStore, RootDialog, SubDialog } from './dialog';
import { postDialogEvent } from './evt-registry';
import { ChatMessage, FuncResultMsg } from './llm/client';
import { log } from './log';
import type {
  CodeBlockChunkEvent,
  CodeBlockFinishEvent,
  CodeBlockStartEvent,
  FuncCallStartEvent,
  FunctionResultEvent,
  GeneratingFinishEvent,
  GeneratingStartEvent,
  MarkdownChunkEvent,
  MarkdownFinishEvent,
  MarkdownStartEvent,
  Q4HAnsweredEvent,
  RoundEvent,
  StreamErrorEvent,
  SubdialogEvent,
  TeammateResponseEvent,
  ThinkingChunkEvent,
  ThinkingFinishEvent,
  ThinkingStartEvent,
  ToolCallBodyChunkEvent,
  ToolCallBodyFinishEvent,
  ToolCallBodyStartEvent,
  ToolCallFinishEvent,
  ToolCallHeadlineChunkEvent,
  ToolCallHeadlineFinishEvent,
  ToolCallResponseEvent,
  ToolCallStartEvent,
} from './shared/types/dialog';
import type {
  AgentThoughtRecord,
  AgentWordsRecord,
  DialogLatestFile,
  FuncCallRecord,
  FuncResultRecord,
  HumanQuestion,
  HumanTextRecord,
  PersistedDialogRecord,
  ProviderData,
  Questions4HumanFile,
  ReminderStateFile,
  RootDialogMetadataFile,
  DialogMetadataFile as StorageDialogMetadataFile,
  SubdialogMetadataFile,
  TeammateResponseRecord,
  ToolArguments,
  ToolCallResultRecord,
  UserTextGrammar,
} from './shared/types/storage';
import { formatUnifiedTimestamp } from './shared/utils/time';
import type { JsonObject, JsonValue } from './tool';
import { Reminder } from './tool';
import { getReminderOwner } from './tools/registry';

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAssignmentFromSup(value: unknown): value is SubdialogMetadataFile['assignmentFromSup'] {
  if (!isRecord(value)) return false;
  if (typeof value.headLine !== 'string') return false;
  if (typeof value.callBody !== 'string') return false;
  if (typeof value.originMemberId !== 'string') return false;
  if (typeof value.callerDialogId !== 'string') return false;
  if (typeof value.callId !== 'string') return false;
  return true;
}

function isRootDialogMetadataFile(value: unknown): value is RootDialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (value.supdialogId !== undefined) return false;
  if (value.topicId !== undefined) return false;
  if (value.assignmentFromSup !== undefined) return false;
  return true;
}

function isSubdialogMetadataFile(value: unknown): value is SubdialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (typeof value.supdialogId !== 'string') return false;
  if (value.topicId !== undefined && typeof value.topicId !== 'string') return false;
  if (!isAssignmentFromSup(value.assignmentFromSup)) return false;
  return true;
}

function isDialogMetadataFile(value: unknown): value is DialogMetadataFile {
  return isRootDialogMetadataFile(value) || isSubdialogMetadataFile(value);
}

function isDialogLatestFile(value: unknown): value is DialogLatestFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.currentRound === 'number' &&
    typeof value.lastModified === 'string' &&
    (value.status === 'active' || value.status === 'completed' || value.status === 'archived')
  );
}

function isSubdialogResponseRecord(value: unknown): value is {
  responseId: string;
  subdialogId: string;
  response: string;
  completedAt: string;
  callType: 'A' | 'B' | 'C';
  headLine: string;
  responderId: string;
  originMemberId: string;
  callId: string;
} {
  if (!isRecord(value)) return false;
  if (typeof value.responseId !== 'string') return false;
  if (typeof value.subdialogId !== 'string') return false;
  if (typeof value.response !== 'string') return false;
  if (typeof value.completedAt !== 'string') return false;
  if (value.callType !== 'A' && value.callType !== 'B' && value.callType !== 'C') return false;
  if (typeof value.headLine !== 'string') return false;
  if (typeof value.responderId !== 'string') return false;
  if (typeof value.originMemberId !== 'string') return false;
  if (typeof value.callId !== 'string') return false;
  return true;
}

export interface DialogPersistenceState {
  metadata: DialogMetadataFile;
  currentRound: number;
  messages: ChatMessage[];
  reminders: Reminder[];
}

export interface Questions4Human {
  round: number;
  questions: HumanQuestion[];
  createdAt: string;
  updatedAt: string;
}

// Remove old type definitions - now using shared/types/storage.ts

// Re-export the storage types for backward compatibility
// Re-export the storage types for backward compatibility
export type DialogMetadataFile = StorageDialogMetadataFile;
export type { PersistedDialogRecord } from './shared/types/storage';

import { TextingEventsReceiver, TextingStreamParser } from './texting';
import { generateDialogID } from './utils/id';

/**
 * Uses append-only pattern for events, exceptional overwrite for reminders
 */
export class DiskFileDialogStore extends DialogStore {
  private readonly dialogId: DialogID;

  constructor(dialogId: DialogID) {
    super();
    this.dialogId = dialogId;
  }

  // === DialogStore interface methods (for compatibility) ===

  /**
   * Create subdialog with automatic persistence
   */
  public async createSubDialog(
    supdialog: RootDialog,
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
    },
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    // For subdialogs, use the supdialog's root dialog ID as the root
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);

    // Prepare subdialog store
    const subdialogStore = new DiskFileDialogStore(subdialogId);
    const subdialog = new SubDialog(
      subdialogStore,
      supdialog,
      supdialog.taskDocPath,
      subdialogId,
      targetAgentId,
      {
        headLine,
        callBody,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
      },
      options.topicId,
    );

    // Initial subdialog user prompt is now persisted at first drive (driver.ts)

    // Ensure subdialog directory and persist metadata under supdialog/.subdialogs/
    await this.ensureSubdialogDirectory(subdialogId);
    const metadata: SubdialogMetadataFile = {
      id: subdialogId.selfId,
      agentId: targetAgentId,
      taskDocPath: supdialog.taskDocPath,
      createdAt: formatUnifiedTimestamp(new Date()),
      supdialogId: supdialog.id.selfId,
      topicId: options.topicId,
      assignmentFromSup: {
        headLine,
        callBody,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
      },
    };
    await DialogPersistence.saveSubdialogMetadata(subdialogId, metadata);
    await DialogPersistence.saveDialogMetadata(subdialogId, metadata);

    // Create initial latest.yaml with current round and lastModified info
    await DialogPersistence.saveDialogLatest(subdialogId, {
      currentRound: 1,
      lastModified: formatUnifiedTimestamp(new Date()),
      status: 'active',
      messageCount: 0,
      functionCallCount: 0,
      subdialogCount: 0,
    });

    // Supdialog clarification context is persisted in subdialog metadata (supdialogCall)

    const parentRound = await DialogPersistence.getCurrentRoundNumber(supdialog.id);
    const subdialogCreatedEvt: SubdialogEvent = {
      type: 'subdialog_created_evt',
      dialog: {
        selfId: subdialogId.selfId,
        rootId: subdialogId.rootId,
      },
      timestamp: new Date().toISOString(),
      round: parentRound,
      parentDialog: {
        selfId: supdialog.id.selfId,
        rootId: supdialog.id.rootId,
      },
      subDialog: {
        selfId: subdialogId.selfId,
        rootId: subdialogId.rootId,
      },
      targetAgentId,
      headLine,
      callBody,
    };
    // Post subdialog_created_evt to PARENT's PubChan so frontend can receive it
    // The frontend subscribes to the parent's events, not the subdialog's
    postDialogEvent(supdialog, subdialogCreatedEvt);

    return subdialog;
  }

  /**
   * Receive and handle function call results (includes logging)
   */
  public async receiveFuncResult(dialog: Dialog, funcResult: FuncResultMsg): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    // Persist function result record
    const funcResultRecord: FuncResultRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'func_result_record',
      id: funcResult.id,
      name: funcResult.name,
      content: funcResult.content,
      genseq: dialog.activeGenSeq,
    };
    await this.appendEvent(round, funcResultRecord);

    // Send event to frontend
    const funcResultEvt: FunctionResultEvent = {
      type: 'func_result_evt',
      id: funcResult.id,
      name: funcResult.name,
      content: funcResult.content,
      round,
    };
    postDialogEvent(dialog, funcResultEvt);
  }

  /**
   * LEGACY METHOD: Receive and handle responses from other agents via texting (deprecated)
   *
   * NOTE: This method sends empty callId, which breaks frontend correlation.
   *       Results will NOT display inline. Use receiveToolResponse() instead.
   *
   * @deprecated Use receiveToolResponse() for inline result display
   * @deprecated This method is kept for backward compatibility only
   */
  public async receiveTextingResponse(
    dialog: Dialog,
    responderId: string,
    headLine: string,
    result: string,
    status: 'completed' | 'failed',
    _subdialogId?: DialogID,
  ): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    // Use activeGenSeqOrUndefined to avoid throwing when called outside generation context
    // (e.g., from WebSocket handler for parent-calls)
    const calling_genseq = dialog.activeGenSeqOrUndefined;
    const ev: ToolCallResultRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'tool_call_result_record',
      responderId,
      headLine,
      status,
      result,
      calling_genseq,
      callId: '', // callId will be set by caller via receiveToolResponse
    };
    await this.appendEvent(round, ev);

    const textingResponseEvt: ToolCallResponseEvent = {
      type: 'tool_call_response_evt',
      responderId,
      headLine,
      status,
      result,
      round,
      calling_genseq,
      callId: '', // LEGACY: Empty callId - frontend cannot correlate, result won't display
    };
    postDialogEvent(dialog, textingResponseEvt);
  }

  /**
   * Receive and handle TEXTING TOOL responses with callId for inline result display
   *
   * Call Types:
   * - Texting Tool Call: @tool_name (e.g., @add_reminder, @list_files)
   *   - Result displays INLINE in the same bubble
   *   - Uses callId for correlation between call_start and response
   *   - Uses receiveToolResponse() + callId parameter
   *
   * - Teammate Call: @agentName (e.g., @coder, @tester)
   *   - Result displays in SEPARATE bubble (subdialog response)
   *   - Uses calleeDialogId for correlation
   *   - Uses receiveTeammateResponse() instead
   *
   * @param dialog - The dialog receiving the response
   * @param responderId - ID of the tool/agent that responded (e.g., "add_reminder")
   * @param headLine - Headline of the original tool call
   * @param result - The result content to display
   * @param status - Response status ('completed' | 'failed')
   * @param callId - Correlation ID from call_start_evt (REQUIRED for inline display)
   */
  public async receiveToolResponse(
    dialog: Dialog,
    responderId: string,
    headLine: string,
    result: string,
    status: 'completed' | 'failed',
    callId: string,
  ): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const calling_genseq = dialog.activeGenSeqOrUndefined;
    // Persist record WITH callId for replay correlation
    const ev: ToolCallResultRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'tool_call_result_record',
      responderId,
      headLine,
      status,
      result,
      calling_genseq,
      callId,
    };
    await this.appendEvent(round, ev);

    // Emit ToolCallResponseEvent WITH callId for UI correlation
    const toolResponseEvt: ToolCallResponseEvent = {
      type: 'tool_call_response_evt',
      responderId,
      headLine,
      status,
      result,
      round,
      calling_genseq,
      callId,
    };
    postDialogEvent(dialog, toolResponseEvt);
  }

  /**
   * Receive and handle TEAMMATE CALL responses (separate bubble for @agentName calls)
   *
   * Call Types:
   * - Texting Tool Call: @tool_name (e.g., @add_reminder)
   *   - Result displays INLINE in the same bubble
   *   - Uses callId for correlation
   *   - Uses receiveToolResponse() instead
   *
   * - Teammate Call: @agentName (e.g., @coder, @tester)
   *   - Result displays in SEPARATE bubble (subdialog or supdialog response)
   *   - Uses calleeDialogId for correlation (not callId)
   *   - Uses this method (receiveTeammateResponse)
   *
   * @param dialog - The dialog receiving the response
   * @param responderId - ID of the teammate agent (e.g., "coder")
   * @param headLine - Headline of the original teammate call
   * @param result - The teammate's response content
   * @param status - Response status ('completed' | 'failed')
   * @param calleeDialogId - ID of the callee dialog (subdialog OR supdialog) for navigation links
   */
  public async receiveTeammateResponse(
    dialog: Dialog,
    responderId: string,
    headLine: string,
    result: string,
    status: 'completed' | 'failed',
    calleeDialogId: DialogID | undefined,
    options: {
      response: string;
      agentId: string;
      callId: string;
      originMemberId: string;
    },
  ): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const calling_genseq = dialog.activeGenSeqOrUndefined;
    const calleeDialogSelfId = calleeDialogId ? calleeDialogId.selfId : undefined;
    const response = options.response;
    const agentId = options.agentId;
    const callId = options.callId;
    const originMemberId = options.originMemberId;
    const ev: TeammateResponseRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'teammate_response_record',
      responderId,
      calleeDialogId: calleeDialogSelfId,
      headLine,
      status,
      result,
      calling_genseq,
      response,
      agentId,
      callId,
      originMemberId,
    };
    await this.appendEvent(round, ev);

    const teammateResponseEvt: TeammateResponseEvent = {
      type: 'teammate_response_evt',
      responderId,
      calleeDialogId: calleeDialogSelfId,
      headLine,
      status,
      result,
      round,
      calling_genseq,
      response,
      agentId,
      callId,
      originMemberId,
    };
    postDialogEvent(dialog, teammateResponseEvt);
  }

  /**
   * Ensure subdialog directory exists (delegate to DialogPersistence)
   */
  private async ensureSubdialogDirectory(dialogId: DialogID): Promise<string> {
    return await DialogPersistence.ensureSubdialogDirectory(dialogId);
  }

  /**
   * Append event to round JSONL file (delegate to DialogPersistence)
   */
  private async appendEvent(round: number, event: PersistedDialogRecord): Promise<void> {
    await DialogPersistence.appendEvent(this.dialogId, round, event);
  }

  /**
   * Notify start of LLM generation for frontend bubble management
   * CRITICAL: This must be called BEFORE any substream events (thinking_start, markdown_start, etc.)
   * to ensure proper event ordering on the frontend.
   */
  public async notifyGeneratingStart(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const genseq = dialog.activeGenSeq;
    try {
      const ev: PersistedDialogRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'gen_start_record',
        genseq: genseq,
      };
      await this.appendEvent(round, ev);

      // Emit generating_start_evt event
      // This event MUST be emitted and processed before any substream events
      // to ensure the frontend has created the generation bubble before receiving
      // thinking/markdown/calling events
      const genStartEvt: GeneratingStartEvent = {
        type: 'generating_start_evt',
        round,
        genseq: genseq,
      };
      postDialogEvent(dialog, genStartEvt);

      // Update generating flag in latest.yaml
      await DialogPersistence.updateDialogLatest(this.dialogId, { generating: true });
    } catch (err) {
      log.warn('Failed to persist gen_start event', err);
    }
  }

  /**
   * Notify end of LLM generation for frontend bubble management
   */
  public async notifyGeneratingFinish(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const genseq = dialog.activeGenSeq;
    if (genseq === undefined) {
      throw new Error('Missing active genseq for notifyGeneratingFinish');
    }
    try {
      const ev: PersistedDialogRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'gen_finish_record',
        genseq: genseq,
      };
      await this.appendEvent(round, ev);

      // Emit generating_finish_evt event (this was missing, causing double triggering issue)
      const genFinishEvt: GeneratingFinishEvent = {
        type: 'generating_finish_evt',
        round,
        genseq: genseq,
      };
      postDialogEvent(dialog, genFinishEvt);

      // Update generating flag in latest.yaml
      await DialogPersistence.updateDialogLatest(this.dialogId, { generating: false });
    } catch (err) {
      log.warn('Failed to persist gen_finish event', err);
    }
  }

  // Track saying/thinking content for persistence

  private sayingContent: string = '';
  private thinkingContent: string = '';

  public async sayingStart(dialog: Dialog): Promise<void> {
    // Reset saying content tracker
    this.sayingContent = '';
  }
  public async sayingChunk(dialog: Dialog, chunk: string): Promise<void> {
    // Collect saying content for persistence
    this.sayingContent += chunk;
  }
  public async sayingFinish(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const sayingContent = this.sayingContent.trim();
    // Persist saying content as a message event
    if (sayingContent) {
      const sayingMessageEvent: AgentWordsRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'agent_words_record',
        genseq: dialog.activeGenSeq,
        content: sayingContent,
      };
      await this.appendEvent(round, sayingMessageEvent);
    }
  }

  public async thinkingStart(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    // Reset thinking content tracker
    this.thinkingContent = '';
    const thinkingStartEvt: ThinkingStartEvent = {
      type: 'thinking_start_evt',
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, thinkingStartEvt);
  }
  public async thinkingChunk(dialog: Dialog, chunk: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    // Collect thinking content for persistence
    this.thinkingContent += chunk;
    const thinkingChunkEvt: ThinkingChunkEvent = {
      type: 'thinking_chunk_evt',
      chunk,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, thinkingChunkEvt);
  }
  public async thinkingFinish(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    // Persist thinking content as a message event
    if (this.thinkingContent.trim()) {
      const thinkingMessageEvent: AgentThoughtRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'agent_thought_record',
        genseq: dialog.activeGenSeq,
        content: this.thinkingContent.trim(),
      };
      await this.appendEvent(round, thinkingMessageEvent);
    }
    const thinkingFinishEvt: ThinkingFinishEvent = {
      type: 'thinking_finish_evt',
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, thinkingFinishEvt);
  }

  public async markdownStart(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const markdownStartEvt: MarkdownStartEvent = {
      type: 'markdown_start_evt',
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, markdownStartEvt);
  }
  public async markdownChunk(dialog: Dialog, chunk: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: MarkdownChunkEvent = {
      type: 'markdown_chunk_evt',
      chunk,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }
  public async markdownFinish(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: MarkdownFinishEvent = {
      type: 'markdown_finish_evt',
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async codeBlockStart(dialog: Dialog, infoLine?: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: CodeBlockStartEvent = {
      type: 'codeblock_start_evt',
      infoLine,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }
  public async codeBlockChunk(dialog: Dialog, chunk: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const codeBlockChunkEvt: CodeBlockChunkEvent = {
      type: 'codeblock_chunk_evt',
      chunk,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, codeBlockChunkEvt);
  }
  public async codeBlockFinish(dialog: Dialog, endQuote?: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const codeBlockFinishEvt: CodeBlockFinishEvent = {
      type: 'codeblock_finish_evt',
      endQuote,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, codeBlockFinishEvt);
  }

  // Tool call streaming methods (renamed from calling to tool_call)
  public async callingStart(dialog: Dialog, firstMention: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: ToolCallStartEvent = {
      type: 'tool_call_start_evt',
      firstMention,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async callingHeadlineChunk(dialog: Dialog, chunk: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: ToolCallHeadlineChunkEvent = {
      type: 'tool_call_headline_chunk_evt',
      chunk,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async callingHeadlineFinish(dialog: Dialog): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: ToolCallHeadlineFinishEvent = {
      type: 'tool_call_headline_finish_evt',
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async callingBodyStart(dialog: Dialog, infoLine?: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: ToolCallBodyStartEvent = {
      type: 'tool_call_body_start_evt',
      infoLine,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async callingBodyChunk(dialog: Dialog, chunk: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: ToolCallBodyChunkEvent = {
      type: 'tool_call_body_chunk_evt',
      chunk,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async callingBodyFinish(dialog: Dialog, endQuote?: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: ToolCallBodyFinishEvent = {
      type: 'tool_call_body_finish_evt',
      endQuote,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async callingFinish(dialog: Dialog, callId: string): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const evt: ToolCallFinishEvent = {
      type: 'tool_call_finish_evt',
      callId,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  // Function call events (non-streaming mode - single event captures entire call)
  public async funcCallRequested(
    dialog: Dialog,
    funcId: string,
    funcName: string,
    argumentsStr: string,
  ): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const funcCallEvt: FuncCallStartEvent = {
      type: 'func_call_requested_evt',
      funcId,
      funcName,
      arguments: argumentsStr,
      round,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, funcCallEvt);
  }

  /**
   * Emit stream error for current generation lifecycle (uses active genseq when present)
   */
  public async streamError(dialog: Dialog, error: string): Promise<void> {
    log.error(`Dialog stream error '${error}'`, new Error(), { dialog });

    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;
    const genseq = typeof dialog.activeGenSeq === 'number' ? dialog.activeGenSeq : undefined;

    // Enhanced stream error event with better error classification
    const streamErrorEvent: StreamErrorEvent = {
      type: 'stream_error_evt',
      round,
      genseq,
      error,
    };

    postDialogEvent(dialog, streamErrorEvent);
  }

  /**
   * Start new round (append-only JSONL + exceptional reminder persistence)
   */
  public async startNewRound(dialog: Dialog, _newRoundPrompt: string): Promise<void> {
    const previousRound = dialog.currentRound;
    const newRound = previousRound + 1;

    // Persist reminders state for new round (exceptional overwrite)
    // Use the currently attached dialog's reminders to avoid stale state
    await this.persistReminders(dialog, dialog.reminders || []);

    // Update latest.yaml with new round and lastModified
    await DialogPersistence.updateDialogLatest(this.dialogId, {
      currentRound: newRound,
      lastModified: formatUnifiedTimestamp(new Date()),
    });

    // Post round update event
    const roundUpdateEvt: RoundEvent = {
      type: 'round_update',
      round: newRound,
      totalRounds: newRound,
    };
    postDialogEvent(dialog, roundUpdateEvt);
  }

  /**
   * Persist reminder state (exceptional overwrite pattern)
   * Note: Event emission is handled by processReminderUpdates() in Dialog
   */
  public async persistReminders(dialog: Dialog, reminders: Reminder[]): Promise<void> {
    await DialogPersistence._saveReminderState(this.dialogId, reminders);
  }

  /**
   * Persist a user message to storage
   * Note: The end_of_user_saying_evt is emitted by the driver after user content
   * is rendered and any texting calls are parsed/executed.
   */
  public async persistUserMessage(
    dialog: Dialog,
    content: string,
    msgId: string,
    grammar: UserTextGrammar,
  ): Promise<void> {
    const round = dialog.currentRound;
    // Use activeGenSeqOrUndefined to handle case when genseq hasn't been initialized yet
    const genseq = dialog.activeGenSeqOrUndefined ?? 1;

    const humanEv: HumanTextRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'human_text_record',
      genseq: genseq,
      content: String(content || ''),
      msgId: msgId,
      grammar,
    };
    await this.appendEvent(round, humanEv);

    // Note: end_of_user_saying_evt is now emitted by llm/driver.ts after texting calls complete
  }

  /**
   * Persist an assistant message to storage
   */
  public async persistAgentMessage(
    dialog: Dialog,
    content: string,
    genseq: number,
    type: 'thinking_msg' | 'saying_msg',
    provider_data?: ProviderData,
  ): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;

    const event: AgentThoughtRecord | AgentWordsRecord =
      type === 'thinking_msg'
        ? {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'agent_thought_record',
            genseq,
            content: content || '',
            provider_data,
          }
        : {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'agent_words_record',
            genseq,
            content: content || '',
          };

    await this.appendEvent(round, event);
  }

  /**
   * Persist a function call to storage
   */
  public async persistFunctionCall(
    dialog: Dialog,
    id: string,
    name: string,
    arguments_: ToolArguments,
    genseq: number,
  ): Promise<void> {
    const round = dialog.activeGenRoundOrUndefined ?? dialog.currentRound;

    const funcCallEvent: FuncCallRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'func_call_record',
      genseq,
      id,
      name,
      arguments: arguments_,
    };

    await this.appendEvent(round, funcCallEvent);

    // NOTE: func_call_evt REMOVED - persistence uses FuncCallRecord directly
    // UI display uses func_call_requested_evt instead
  }

  /**
   * Update questions for human state (exceptional overwrite pattern)
   */
  public async updateQuestions4Human(dialog: Dialog, questions: HumanQuestion[]): Promise<void> {
    await DialogPersistence._saveQuestions4HumanState(this.dialogId, questions);
  }

  /**
   * Load Questions for Human state from storage
   */
  public async loadQuestions4Human(dialogId: DialogID): Promise<HumanQuestion[]> {
    return await DialogPersistence.loadQuestions4HumanState(dialogId);
  }

  /**
   * Clear Questions for Human state in storage
   */
  public async clearQuestions4Human(dialog: Dialog): Promise<void> {
    const previousQuestions = await DialogPersistence.loadQuestions4HumanState(dialog.id);
    const previousCount = previousQuestions.length;

    if (previousCount > 0) {
      await DialogPersistence.clearQuestions4HumanState(dialog.id);

      // Emit q4h_answered events for each removed question
      for (const q of previousQuestions) {
        const answeredEvent: Q4HAnsweredEvent = {
          type: 'q4h_answered',
          questionId: q.id,
          dialogId: dialog.id.selfId,
        };
        postDialogEvent(dialog, answeredEvent);
      }
    }
  }

  /**
   * Get current questions for human count for UI decoration
   */
  public async getQuestions4HumanCount(): Promise<number> {
    const questions = await DialogPersistence.loadQuestions4HumanState(this.dialogId);
    return questions.length;
  }

  /**
   * Load current round number from persisted metadata
   */
  public async loadCurrentRound(dialogId: DialogID): Promise<number> {
    return await DialogPersistence.getCurrentRoundNumber(dialogId, 'running');
  }

  /**
   * Get next sequence number for generation
   */
  public async getNextSeq(dialogId: DialogID, round: number): Promise<number> {
    return await DialogPersistence.getNextSeq(dialogId, round, 'running');
  }

  /**
   * Send dialog events directly to a specific WebSocket connection for dialog restoration
   * CRITICAL: This bypasses PubChan to ensure only the requesting session receives restoration events
   * Unlike replayDialogEvents(), this sends events directly to ws.send() instead of postDialogEvent()
   * @param ws - WebSocket connection to send events to
   * @param dialog - Dialog object containing metadata
   * @param round - Optional round number (uses dialog.currentRound if not provided)
   * @param totalRounds - Optional total rounds count (defaults to round/currentRound)
   */
  public async sendDialogEventsDirectly(
    ws: WebSocket,
    dialog: Dialog,
    round?: number,
    totalRounds?: number,
  ): Promise<void> {
    try {
      // Use provided round or fallback to dialog.currentRound (which may be stale for new Dialog objects)
      const currentRound = round ?? dialog.currentRound;
      const effectiveTotalRounds = totalRounds ?? currentRound;
      const persistenceEvents = await DialogPersistence.readRoundEvents(
        dialog.id,
        currentRound,
        'running',
      );

      // Send round_update event directly to this WebSocket only
      ws.send(
        JSON.stringify({
          type: 'round_update',
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          round: currentRound,
          totalRounds: effectiveTotalRounds,
        }),
      );

      // Events are already in chronological order from JSONL file (append-only pattern)

      // Send each persistence event directly to the requesting WebSocket
      for (const event of persistenceEvents) {
        await this.sendEventDirectlyToWebSocket(ws, dialog, currentRound, event);
      }

      // Rehydrate reminders from dialog state
      const dialogState = await DialogPersistence.restoreDialog(dialog.id, 'running');
      const rehydrated: Reminder[] = (dialogState?.reminders ?? []).map((r) => {
        const ownerName =
          r.owner?.name ??
          (isJsonObject(r.meta) && r.meta.type === 'daemon' ? 'shellCmd' : undefined);
        const owner = ownerName ? getReminderOwner(ownerName) : undefined;
        return { content: r.content, owner, meta: r.meta };
      });
      dialog.reminders.length = 0;
      dialog.reminders.push(...rehydrated);
    } catch (error) {
      log.error(`Failed to send dialog events directly for ${dialog.id.selfId}:`, error);
      throw error;
    }
  }

  /**
   * Send a single persistence event directly to a WebSocket connection
   * CRITICAL: Avoid PubChan completely for dialog restoration to the single client's display_dialog request
   */
  private async sendEventDirectlyToWebSocket(
    ws: WebSocket,
    dialog: Dialog,
    round: number,
    event: PersistedDialogRecord,
  ): Promise<void> {
    switch (event.type) {
      case 'human_text_record': {
        const genseq = event.genseq;
        const content = event.content || '';
        const grammar: UserTextGrammar = event.grammar ?? 'texting';

        if (content) {
          if (grammar === 'texting') {
            const receiver: TextingEventsReceiver = {
              markdownStart: async () => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'markdown_start_evt',
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              markdownChunk: async (chunk: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'markdown_chunk_evt',
                      chunk,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              markdownFinish: async () => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'markdown_finish_evt',
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              callStart: async (first: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call_start_evt',
                      firstMention: first,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              callHeadLineChunk: async (chunk: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call_headline_chunk_evt',
                      chunk,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              callHeadLineFinish: async () => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call_headline_finish_evt',
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              callBodyStart: async (infoLine?: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call_body_start_evt',
                      infoLine,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              callBodyChunk: async (chunk: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call_body_chunk_evt',
                      chunk,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              callBodyFinish: async (endQuote?: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call_body_finish_evt',
                      endQuote,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              callFinish: async (_callId: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'tool_call_finish_evt',
                      callId: _callId,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              codeBlockStart: async (infoLine: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'codeblock_start_evt',
                      infoLine,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              codeBlockChunk: async (chunk: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'codeblock_chunk_evt',
                      chunk,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
              codeBlockFinish: async (endQuote: string) => {
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'codeblock_finish_evt',
                      endQuote,
                      round,
                      genseq,
                      dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                      timestamp: event.ts,
                    }),
                  );
                }
              },
            };

            // Parse user content through TextingStreamParser (same as live mode)
            const streamingParser = new TextingStreamParser(receiver);
            await streamingParser.takeUpstreamChunk(content);
            await streamingParser.finalize();
          } else {
            if (ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: 'markdown_start_evt',
                  round,
                  genseq,
                  dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                  timestamp: event.ts,
                }),
              );
              ws.send(
                JSON.stringify({
                  type: 'markdown_chunk_evt',
                  chunk: content,
                  round,
                  genseq,
                  dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                  timestamp: event.ts,
                }),
              );
              ws.send(
                JSON.stringify({
                  type: 'markdown_finish_evt',
                  round,
                  genseq,
                  dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                  timestamp: event.ts,
                }),
              );
            }
          }
        }

        // Emit end_of_user_saying_evt to signal frontend to render <hr/> separator
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'end_of_user_saying_evt',
              round,
              genseq,
              msgId: event.msgId,
              content,
              grammar,
              dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
              timestamp: event.ts,
            }),
          );
        }
        break;
      }

      case 'gen_start_record': {
        // Create generating_start_evt event using persisted genseq directly
        const genStartWireEvent = {
          type: 'generating_start_evt',
          round,
          genseq: event.genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        // Send directly to WebSocket (NO PubChan emission)
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(genStartWireEvent));
        }
        break;
      }

      case 'gen_finish_record': {
        // Create generating_finish_evt event using persisted genseq directly
        const genFinishWireEvent = {
          type: 'generating_finish_evt',
          round,
          genseq: event.genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        // Send directly to WebSocket (NO PubChan emission)
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(genFinishWireEvent));
        }
        break;
      }

      case 'agent_thought_record': {
        // Replay thinking content as thinking events
        const content = event.content || '';
        if (content) {
          // Start thinking phase
          const thinkingStartEvent = {
            type: 'thinking_start_evt',
            round,
            genseq: event.genseq,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };

          if (ws.readyState === 1) {
            ws.send(JSON.stringify(thinkingStartEvent));
          }

          const thinkingChunks = this.createOptimalChunks(content);
          for (const chunk of thinkingChunks) {
            const thinkingChunkEvent = {
              type: 'thinking_chunk_evt',
              chunk,
              round,
              genseq: event.genseq,
              dialog: {
                selfId: dialog.id.selfId,
                rootId: dialog.id.rootId,
              },
              timestamp: event.ts,
            };
            if (ws.readyState === 1) {
              ws.send(JSON.stringify(thinkingChunkEvent));
            }
          }

          // Finish thinking phase
          const thinkingFinishEvent = {
            type: 'thinking_finish_evt',
            round,
            genseq: event.genseq,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };
          if (ws.readyState === 1) {
            ws.send(JSON.stringify(thinkingFinishEvent));
          }
        }
        break;
      }

      case 'agent_words_record': {
        // Replay assistant text using ad-hoc event receiver with closure-based WebSocket access
        const content = event.content || '';
        if (content) {
          // Create ad-hoc receiver similar to driver pattern with closure-based WebSocket access
          const receiver: TextingEventsReceiver = {
            markdownStart: async () => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'markdown_start_evt',
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            markdownChunk: async (chunk: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'markdown_chunk_evt',
                    chunk,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            markdownFinish: async () => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'markdown_finish_evt',
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            callStart: async (first: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_call_start_evt',
                    firstMention: first,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            callHeadLineChunk: async (chunk: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_call_headline_chunk_evt',
                    chunk,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            callHeadLineFinish: async () => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_call_headline_finish_evt',
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            callBodyStart: async (infoLine?: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_call_body_start_evt',
                    infoLine,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            callBodyChunk: async (chunk: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_call_body_chunk_evt',
                    chunk,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            callBodyFinish: async (endQuote?: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_call_body_finish_evt',
                    endQuote,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            callFinish: async (callId: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'tool_call_finish_evt',
                    callId,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            codeBlockStart: async (infoLine: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'codeblock_start_evt',
                    infoLine,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            codeBlockChunk: async (chunk: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'codeblock_chunk_evt',
                    chunk,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
            codeBlockFinish: async (endQuote: string) => {
              if (ws.readyState === 1) {
                ws.send(
                  JSON.stringify({
                    type: 'codeblock_finish_evt',
                    endQuote,
                    round,
                    genseq: event.genseq,
                    dialog: {
                      selfId: dialog.id.selfId,
                      rootId: dialog.id.rootId,
                    },
                    timestamp: event.ts,
                  }),
                );
              }
            },
          };

          // Use the same TextingStreamParser that live streaming uses
          const streamingParser = new TextingStreamParser(receiver);

          // Stream the content through the parser to ensure consistent event emission
          await streamingParser.takeUpstreamChunk(content);
          await streamingParser.finalize();
        }
        break;
      }

      case 'func_call_record': {
        // Handle function call events from persistence
        // NOTE: func_call_evt REMOVED - emit func_call_requested_evt for UI instead
        const funcCall = {
          type: 'func_call_requested_evt',
          funcId: event.id,
          funcName: event.name,
          arguments: JSON.stringify(event.arguments),
          round,
          genseq: event.genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(funcCall));
        }
        break;
      }

      case 'func_result_record': {
        // Handle function result events from persistence
        const funcResult = {
          type: 'func_result_evt',
          id: event.id,
          name: event.name,
          content: event.content,
          round,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(funcResult));
        }
        break;
      }

      case 'quest_for_sup_record': {
        // Handle subdialog creation requests
        const subdialogCreatedEvent = {
          type: 'subdialog_created_evt',
          dialog: {
            // Add dialog field for proper event routing
            selfId: event.subDialogId,
            rootId: dialog.id.rootId,
          },
          parentDialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          subDialog: {
            selfId: event.subDialogId,
            rootId: dialog.id.rootId, // Use parent's rootId for subdialog's rootId
          },
          targetAgentId: 'unknown', // Will be resolved during actual subdialog creation
          headLine: event.headLine,
          callBody: event.callBody,
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(subdialogCreatedEvent));
        }
        break;
      }

      case 'tool_call_result_record': {
        // Handle tool call results (renamed from texting_call_result_record)
        const responseEvent = {
          type: 'tool_call_response_evt',
          responderId: event.responderId,
          headLine: event.headLine,
          status: event.status,
          result: event.result,
          callId: event.callId || '',
          round,
          calling_genseq: event.calling_genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(responseEvent));
        }
        break;
      }

      case 'teammate_response_record': {
        // Handle teammate response events (separate bubble for @teammate calls)
        const teammateResponseEvent = {
          type: 'teammate_response_evt',
          responderId: event.responderId,
          calleeDialogId: event.calleeDialogId,
          headLine: event.headLine,
          status: event.status,
          result: event.result,
          response: event.response,
          agentId: event.agentId,
          callId: event.callId,
          originMemberId: event.originMemberId,
          round,
          calling_genseq: event.calling_genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(teammateResponseEvent));
        }
        break;
      }

      default:
        // Unknown event type - log but don't crash
        log.warn(`Unknown persistence event type during direct WebSocket send`, undefined, event);
        break;
    }
  }

  /**
   * Create optimal text chunks for websocket transmission
   * Splits content into 1MB pieces for efficient websocket streaming
   */
  private createOptimalChunks(content: string, maxChunk: number = 1000000): string[] {
    const chunks: string[] = [];
    let remaining = content.trim();

    while (remaining.length > 0) {
      // Use 1MB chunks for optimal websocket transmission
      const targetSize = Math.min(remaining.length, maxChunk);
      const chunk = remaining.slice(0, targetSize);

      chunks.push(chunk);
      remaining = remaining.slice(chunk.length).trim();
    }

    return chunks.filter((chunk) => chunk.length > 0);
  }
}

/**
 * Utility class for managing dialog persistence
 */
export class DialogPersistence {
  private static readonly DIALOGS_DIR = '.dialogs';
  private static readonly RUN_DIR = 'run';
  private static readonly DONE_DIR = 'done';
  private static readonly ARCHIVE_DIR = 'archive';
  private static readonly SUBDIALOGS_DIR = 'subdialogs';

  // Workspace directory from -C flag, defaults to process.cwd() if not set
  private static _workspaceRoot: string | undefined;

  /**
   * Set the workspace root directory (called during server startup with -C flag)
   */
  static setWorkspaceRoot(dir: string): void {
    this._workspaceRoot = dir;
  }

  /**
   * Get the workspace root directory
   */
  static getWorkspaceRoot(): string {
    return this._workspaceRoot ?? process.cwd();
  }

  /**
   * Get the base dialogs directory path
   */
  static getDialogsRootDir(): string {
    return path.join(this.getWorkspaceRoot(), this.DIALOGS_DIR);
  }

  /**
   * Save dialog state to JSON file for persistence (internal use only)
   */
  private static async saveDialogState(state: DialogPersistenceState): Promise<void> {
    try {
      const dialogPath = await this.ensureRootDialogDirectory(new DialogID(state.metadata.id));

      // Save state as JSON file
      const stateFile = path.join(dialogPath, 'state.json');
      await fs.promises.writeFile(
        stateFile,
        JSON.stringify(
          {
            metadata: state.metadata,
            currentRound: state.currentRound,
            messages: state.messages,
            reminders: state.reminders,
            savedAt: formatUnifiedTimestamp(new Date()),
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch (error) {
      log.error(`Failed to save dialog state for ${state.metadata.id}:`, error);
      throw error;
    }
  }

  /**
   * Load dialog state from JSON file
   */
  static async loadDialogState(dialogId: DialogID): Promise<DialogPersistenceState | null> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, 'running');
      const stateFile = path.join(dialogPath, 'state.json');

      // Check if state file exists
      try {
        await fs.promises.access(stateFile);
      } catch {
        log.warn(`No state file found for dialog ${dialogId.selfId}, returning null`);
        return null;
      }

      const stateData = JSON.parse(await fs.promises.readFile(stateFile, 'utf-8'));

      return {
        metadata: stateData.metadata,
        currentRound: stateData.currentRound,
        messages: stateData.messages,
        reminders: stateData.reminders || [],
      };
    } catch (error) {
      log.error(`Failed to load dialog state for root ${dialogId.selfId}:`, error);
      return null;
    }
  }

  /**
   * Get the full path for a dialog directory
   */
  static getRootDialogPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
    if (dialogId.rootId !== dialogId.selfId) {
      throw new Error('Expected root dialog id');
    }
    let statusDir: string;
    if (status === 'running') {
      statusDir = this.RUN_DIR;
    } else if (status === 'completed') {
      statusDir = this.DONE_DIR;
    } else {
      statusDir = this.ARCHIVE_DIR;
    }
    return path.join(this.getDialogsRootDir(), statusDir, dialogId.selfId);
  }

  /**
   * Get the events/state directory for a dialog (composite ID for subdialogs)
   */
  static getDialogEventsPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
    // Root dialogs store events under their own directory.
    // Subdialogs store events under the root's subdialogs/<self> directory.
    if (dialogId.rootId === dialogId.selfId) {
      return this.getRootDialogPath(dialogId, status);
    }
    return this.getSubdialogPath(dialogId, status);
  }

  /**
   * Get the path for a subdialog within a supdialog
   */
  static getSubdialogPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('Expected subdialog id (self differs from root)');
    }
    const rootPath = this.getRootDialogPath(new DialogID(dialogId.rootId), status);
    return path.join(rootPath, this.SUBDIALOGS_DIR, dialogId.selfId);
  }

  /**
   * Ensure dialog directory structure exists
   */
  static async ensureRootDialogDirectory(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<string> {
    const dialogPath = this.getRootDialogPath(dialogId, status);

    try {
      await fs.promises.mkdir(dialogPath, { recursive: true });
      return dialogPath;
    } catch (error) {
      log.error(`Failed to create dialog directory ${dialogPath}:`, error);
      throw error;
    }
  }

  /**
   * Ensure subdialog directory structure exists
   */
  static async ensureSubdialogDirectory(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<string> {
    const subdialogPath = this.getSubdialogPath(dialogId, status);

    try {
      await fs.promises.mkdir(subdialogPath, { recursive: true });
      return subdialogPath;
    } catch (error) {
      log.error(`Failed to create subdialog directory ${subdialogPath}:`, error);
      throw error;
    }
  }

  /**
   * Mark a dialog as completed
   */
  static async markDialogCompleted(dialogId: DialogID): Promise<void> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, 'running');
      const completedPath = this.getRootDialogPath(dialogId, 'completed');

      await fs.promises.mkdir(completedPath, { recursive: true });

      // Move files from current to completed
      const files = await fs.promises.readdir(dialogPath);
      for (const file of files) {
        const src = path.join(dialogPath, file);
        const dest = path.join(completedPath, file);
        await fs.promises.rename(src, dest);
      }
    } catch (error) {
      log.error(`Failed to mark dialog ${dialogId} as completed:`, error);
      throw error;
    }
  }

  /**
   * List all dialog IDs by scanning for dialog.yaml files and validating their IDs
   */
  static async listDialogs(
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<string[]> {
    try {
      const statusDir = this.getDialogsRootDir();
      const specificDir = path.join(
        statusDir,
        status === 'running'
          ? this.RUN_DIR
          : status === 'completed'
            ? this.DONE_DIR
            : this.ARCHIVE_DIR,
      );

      const validDialogIds: string[] = [];

      // Recursively find all dialog.yaml files
      const findDialogYamls = async (dirPath: string, relativePath: string = ''): Promise<void> => {
        try {
          const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);

            if (entry.isDirectory()) {
              // Recursively search subdirectories
              await findDialogYamls(fullPath, entryRelativePath);
            } else if (entry.name === 'dialog.yaml') {
              // Found a dialog.yaml file, record its ID regardless of nesting structure
              try {
                const content = await fs.promises.readFile(fullPath, 'utf-8');
                const parsed = yaml.parse(content);
                if (parsed?.id && typeof parsed.id === 'string') {
                  validDialogIds.push(parsed.id);
                }
              } catch (yamlError) {
                log.warn(`🔍 listDialogs: Failed to parse dialog.yaml at ${fullPath}:`, yamlError);
              }
            }
          }
        } catch (error) {
          log.warn(`🔍 listDialogs: Error reading directory ${dirPath}:`, error);
        }
      };

      try {
        // Check if directory exists before trying to read it
        const dirExists = await fs.promises
          .stat(specificDir)
          .then(() => true)
          .catch(() => false);
        if (dirExists) {
          await findDialogYamls(specificDir);
        }
        return validDialogIds;
      } catch (error) {
        log.warn(
          `🔍 listDialogs: Error processing directory ${specificDir}:`,
          error instanceof Error ? error.message : String(error),
        );
        return [];
      }
    } catch (error) {
      log.error('Failed to list dialogs:', error);
      return [];
    }
  }

  // === NEW JSONL ROUND-BASED METHODS ===

  /**
   * Append event to round JSONL file (append-only pattern)
   */
  static async appendEvent(
    dialogId: DialogID,
    round: number,
    event: PersistedDialogRecord,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const roundFilename = this.getRoundFilename(round);
      const roundFilePath = path.join(dialogPath, roundFilename);

      // Ensure directory exists
      await fs.promises.mkdir(dialogPath, { recursive: true });

      // Atomic append operation
      const eventLine = JSON.stringify(event) + '\n';
      await fs.promises.appendFile(roundFilePath, eventLine, 'utf-8');

      // Update latest.yaml with new lastModified timestamp
      await this.updateDialogLatest(
        dialogId,
        {
          lastModified: formatUnifiedTimestamp(new Date()),
          currentRound: round,
        },
        status,
      );
    } catch (error) {
      log.error(`Failed to append event to dialog ${dialogId} round ${round}:`, error);
      throw error;
    }
  }

  /**
   * Read all events from round JSONL file
   */
  static async readRoundEvents(
    dialogId: DialogID,
    round: number,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<PersistedDialogRecord[]> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const roundFilename = this.getRoundFilename(round);
      const roundFilePath = path.join(dialogPath, roundFilename);

      try {
        const content = await fs.promises.readFile(roundFilePath, 'utf-8');
        const events: PersistedDialogRecord[] = [];

        for (const line of content.trim().split('\n')) {
          if (line.trim()) {
            events.push(JSON.parse(line));
          }
        }

        return events;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          // Round file doesn't exist - return empty array
          return [];
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to read round events for dialog ${dialogId} round ${round}:`, error);
      throw error;
    }
  }

  /**
   * Compute next sequence number for a round by scanning existing events
   */
  static async getNextSeq(
    dialogId: DialogID,
    round: number,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<number> {
    const events = await this.readRoundEvents(dialogId, round, status);
    let maxSeq = 0;
    for (const ev of events) {
      if ('genseq' in ev && typeof ev.genseq === 'number' && ev.genseq > maxSeq) {
        maxSeq = ev.genseq;
      }
    }
    return maxSeq + 1;
  }

  /**
   * Get current round number from latest.yaml (performance optimization)
   * UI navigation can assume natural numbering schema back to 1
   */
  static async getCurrentRoundNumber(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<number> {
    try {
      const latest = await this.loadDialogLatest(dialogId, status);
      return latest?.currentRound || 1;
    } catch (error) {
      log.error(`Failed to get current round for dialog ${dialogId}:`, error);
      return 1;
    }
  }

  /**
   * Save reminder state (exceptional overwrite pattern) (internal use only)
   */
  public static async _saveReminderState(
    dialogId: DialogID,
    reminders: Reminder[],
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      await fs.promises.mkdir(dialogPath, { recursive: true });
      const remindersFilePath = path.join(dialogPath, 'reminders.json');

      const reminderState: ReminderStateFile = {
        reminders: reminders.map((r, index) => ({
          id: `reminder-${index}`,
          content: r.content,
          createdAt: formatUnifiedTimestamp(new Date()),
          priority: 'medium',
        })),
        updatedAt: formatUnifiedTimestamp(new Date()),
      };

      // Atomic write operation
      const tempFile = remindersFilePath + '.tmp';
      await fs.promises.writeFile(tempFile, JSON.stringify(reminderState, null, 2), 'utf-8');
      await fs.promises.rename(tempFile, remindersFilePath);
    } catch (error) {
      log.error(`Failed to save reminder state for dialog ${dialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load reminder state
   */
  static async loadReminderState(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<Reminder[]> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const remindersFilePath = path.join(dialogPath, 'reminders.json');

      try {
        const content = await fs.promises.readFile(remindersFilePath, 'utf-8');
        const reminderState: ReminderStateFile = JSON.parse(content);
        return reminderState.reminders.map((r) => ({
          id: r.id,
          content: r.content,
          createdAt: r.createdAt,
          priority: r.priority as 'high' | 'medium' | 'low',
        }));
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          // reminders.json doesn't exist - return empty array
          return [];
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to load reminder state for dialog ${dialogId}:`, error);
      return [];
    }
  }

  /**
   * Save questions for human state (exceptional overwrite pattern) (internal use only)
   */
  public static async _saveQuestions4HumanState(
    dialogId: DialogID,
    questions: HumanQuestion[],
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const questionsFilePath = path.join(dialogPath, 'q4h.yaml');

      const questionsState: Questions4HumanFile = {
        questions,
        updatedAt: formatUnifiedTimestamp(new Date()),
      };

      // Atomic write operation
      const tempFile = questionsFilePath + '.tmp';
      const yamlContent = yaml.stringify(questionsState);
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await fs.promises.rename(tempFile, questionsFilePath);
    } catch (error) {
      log.error(`Failed to save q4h.yaml for dialog ${dialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load questions for human state
   */
  static async loadQuestions4HumanState(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<HumanQuestion[]> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const questionsFilePath = path.join(dialogPath, 'q4h.yaml');

      try {
        const content = await fs.promises.readFile(questionsFilePath, 'utf-8');
        const questionsState: Questions4HumanFile = yaml.parse(content);
        return questionsState.questions;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          // q4h.yaml doesn't exist - return empty array
          return [];
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to load q4h.yaml for dialog ${dialogId}:`, error);
      return [];
    }
  }

  /**
   * Load all Q4H questions from all running dialogs (for global Q4H display)
   * Returns array of questions with their dialog context for frontend display
   */
  static async loadAllQ4HState(): Promise<
    Array<{
      id: string;
      dialogId: string;
      rootId: string;
      agentId: string;
      taskDocPath: string;
      headLine: string;
      bodyContent: string;
      askedAt: string;
      callSiteRef: { round: number; messageIndex: number };
    }>
  > {
    try {
      // Get all running dialogs
      const dialogIds = await this.listDialogs('running');
      const allQuestions: Array<{
        id: string;
        dialogId: string;
        rootId: string;
        agentId: string;
        taskDocPath: string;
        headLine: string;
        bodyContent: string;
        askedAt: string;
        callSiteRef: { round: number; messageIndex: number };
      }> = [];

      for (const dialogId of dialogIds) {
        try {
          const dialogIdObj = new DialogID(dialogId);
          const questions = await this.loadQuestions4HumanState(dialogIdObj, 'running');
          const metadata = await this.loadDialogMetadata(dialogIdObj, 'running');

          if (metadata && questions.length > 0) {
            for (const q of questions) {
              allQuestions.push({
                ...q,
                dialogId: dialogId,
                rootId: dialogIdObj.rootId,
                agentId: metadata.agentId,
                taskDocPath: metadata.taskDocPath,
              });
            }
          }
        } catch (err) {
          log.warn(`Failed to load Q4H for dialog ${dialogId}:`, err);
        }
      }

      return allQuestions;
    } catch (error) {
      log.error('Failed to load all Q4H state:', error);
      return [];
    }
  }

  public static async clearQuestions4HumanState(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const questionsFilePath = path.join(dialogPath, 'q4h.yaml');
      let previousCount = 0;
      let existingQuestions: HumanQuestion[] = [];
      try {
        existingQuestions = await this.loadQuestions4HumanState(dialogId, status);
        previousCount = existingQuestions.length;
      } catch (err) {
        log.debug('No existing questions state found, using default count', err);
      }
      await fs.promises.rm(questionsFilePath, { force: true });

      // Emit q4h_answered events for each removed question
      const { postDialogEventById } = await import('./evt-registry');
      for (const q of existingQuestions) {
        const answeredEvent: Q4HAnsweredEvent = {
          type: 'q4h_answered',
          questionId: q.id,
          dialogId: dialogId.valueOf(),
        };
        postDialogEventById(dialogId, answeredEvent);
      }
    } catch (error) {
      log.error(`Failed to clear q4h.yaml for dialog ${dialogId}:`, error);
    }
  }

  // === PHASE 6: SUBDIALOG SUPPLY PERSISTENCE ===

  /**
   * Save pending subdialogs for Type A supply mechanism.
   * Tracks subdialogs that were created but not yet completed.
   */
  static async savePendingSubdialogs(
    rootDialogId: DialogID,
    pendingSubdialogs: Array<{
      subdialogId: string;
      createdAt: string;
      headLine: string;
      targetAgentId: string;
      callType: 'A' | 'B' | 'C';
      topicId?: string;
    }>,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      await fs.promises.mkdir(dialogPath, { recursive: true });
      const filePath = path.join(dialogPath, 'pending-subdialogs.json');

      // Atomic write operation
      const tempFile = filePath + '.tmp';
      await fs.promises.writeFile(tempFile, JSON.stringify(pendingSubdialogs, null, 2), 'utf-8');
      await fs.promises.rename(tempFile, filePath);
    } catch (error) {
      log.error(`Failed to save pending subdialogs for dialog ${rootDialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load pending subdialogs for Type A supply mechanism.
   */
  static async loadPendingSubdialogs(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<
    Array<{
      subdialogId: string;
      createdAt: string;
      headLine: string;
      targetAgentId: string;
      callType: 'A' | 'B' | 'C';
      topicId?: string;
    }>
  > {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const filePath = path.join(dialogPath, 'pending-subdialogs.json');

      try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to load pending subdialogs for dialog ${rootDialogId}:`, error);
      return [];
    }
  }

  /**
   * Get the path for storing subdialog responses (supports both root and subdialog parents).
   * For Type C subdialogs created inside another subdialog, responses are stored at the parent's level.
   */
  static getDialogResponsesPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
    // Root dialogs store responses in their own directory.
    // Subdialogs store responses in the parent's location (root or subdialog).
    if (dialogId.rootId === dialogId.selfId) {
      // Root dialog: use root's directory
      return this.getRootDialogPath(dialogId, status);
    }
    // Subdialog: store in parent's subdialogs directory
    // The parent is always identified by rootId (could be root or parent subdialog)
    const parentSelfId = dialogId.rootId;
    const rootPath = this.getRootDialogPath(new DialogID(parentSelfId), status);
    return path.join(rootPath, this.SUBDIALOGS_DIR, dialogId.selfId);
  }

  /**
   * Save subdialog responses for Type A supply mechanism.
   * Tracks responses from completed subdialogs.
   */
  static async saveSubdialogResponses(
    rootDialogId: DialogID,
    responses: Array<{
      responseId: string;
      subdialogId: string;
      response: string;
      completedAt: string;
      callType: 'A' | 'B' | 'C';
      headLine: string;
      responderId: string;
      originMemberId: string;
      callId: string;
    }>,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      await fs.promises.mkdir(dialogPath, { recursive: true });
      const filePath = path.join(dialogPath, 'subdialog-responses.json');

      // Atomic write operation
      const tempFile = filePath + '.tmp';
      await fs.promises.writeFile(tempFile, JSON.stringify(responses, null, 2), 'utf-8');
      await fs.promises.rename(tempFile, filePath);
    } catch (error) {
      log.error(`Failed to save subdialog responses for dialog ${rootDialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load subdialog responses for Type A supply mechanism.
   */
  static async loadSubdialogResponses(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<
    Array<{
      responseId: string;
      subdialogId: string;
      response: string;
      completedAt: string;
      callType: 'A' | 'B' | 'C';
      headLine: string;
      responderId: string;
      originMemberId: string;
      callId: string;
    }>
  > {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const filePath = path.join(dialogPath, 'subdialog-responses.json');
      const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

      try {
        const results: Array<{
          responseId: string;
          subdialogId: string;
          response: string;
          completedAt: string;
          callType: 'A' | 'B' | 'C';
          headLine: string;
          responderId: string;
          originMemberId: string;
          callId: string;
        }> = [];

        const tryReadArray = async (p: string): Promise<unknown[]> => {
          try {
            const content = await fs.promises.readFile(p, 'utf-8');
            const parsed: unknown = JSON.parse(content);
            return Array.isArray(parsed) ? parsed : [];
          } catch (error) {
            if (getErrorCode(error) === 'ENOENT') {
              return [];
            }
            throw error;
          }
        };

        const primary = await tryReadArray(filePath);
        const inflight = await tryReadArray(inflightPath);
        for (const item of [...primary, ...inflight]) {
          if (isSubdialogResponseRecord(item)) {
            results.push(item);
          }
        }

        // Deduplicate by responseId (primary wins over inflight order is irrelevant)
        const byId = new Map<string, (typeof results)[number]>();
        for (const r of results) {
          byId.set(r.responseId, r);
        }
        return Array.from(byId.values());
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to load subdialog responses for dialog ${rootDialogId}:`, error);
      return [];
    }
  }

  static async loadSubdialogResponsesQueue(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<
    Array<{
      responseId: string;
      subdialogId: string;
      response: string;
      completedAt: string;
      callType: 'A' | 'B' | 'C';
      headLine: string;
      responderId: string;
      originMemberId: string;
      callId: string;
    }>
  > {
    try {
      const dialogPath = this.getDialogResponsesPath(dialogId, status);
      const filePath = path.join(dialogPath, 'subdialog-responses.json');
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isSubdialogResponseRecord);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  static async appendSubdialogResponse(
    dialogId: DialogID,
    response: {
      responseId: string;
      subdialogId: string;
      response: string;
      completedAt: string;
      callType: 'A' | 'B' | 'C';
      headLine: string;
      responderId: string;
      originMemberId: string;
      callId: string;
    },
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const existing = await this.loadSubdialogResponsesQueue(dialogId, status);
    existing.push(response);
    await this.saveSubdialogResponses(dialogId, existing, status);
  }

  static async takeSubdialogResponses(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<
    Array<{
      responseId: string;
      subdialogId: string;
      response: string;
      completedAt: string;
      callType: 'A' | 'B' | 'C';
      headLine: string;
      responderId: string;
      originMemberId: string;
      callId: string;
    }>
  > {
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    await fs.promises.mkdir(dialogPath, { recursive: true });

    const filePath = path.join(dialogPath, 'subdialog-responses.json');
    const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

    // If a previous processing file exists, merge it back so it will be re-processed.
    try {
      await fs.promises.access(inflightPath);
      await this.rollbackTakenSubdialogResponses(dialogId, status);
    } catch {
      // no-op
    }

    try {
      await fs.promises.rename(filePath, inflightPath);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }

    try {
      const raw = await fs.promises.readFile(inflightPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isSubdialogResponseRecord);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  static async commitTakenSubdialogResponses(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');
    await fs.promises.rm(inflightPath, { force: true });
  }

  static async rollbackTakenSubdialogResponses(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    await fs.promises.mkdir(dialogPath, { recursive: true });

    const filePath = path.join(dialogPath, 'subdialog-responses.json');
    const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

    let inflight: unknown[] = [];
    try {
      const raw = await fs.promises.readFile(inflightPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      inflight = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }

    let primary: unknown[] = [];
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      primary = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
    }

    const merged = [...inflight, ...primary].filter(isSubdialogResponseRecord);
    const byId = new Map<string, (typeof merged)[number]>();
    for (const r of merged) {
      byId.set(r.responseId, r);
    }
    const result = Array.from(byId.values());

    const tempFile = filePath + '.tmp';
    await fs.promises.writeFile(tempFile, JSON.stringify(result, null, 2), 'utf-8');
    await fs.promises.rename(tempFile, filePath);
    await fs.promises.rm(inflightPath, { force: true });
  }

  /**
   * Save root dialog metadata (write-once pattern)
   */
  static async saveRootDialogMetadata(
    dialogId: DialogID,
    metadata: RootDialogMetadataFile,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, status);

      // Ensure dialog directory exists first
      await fs.promises.mkdir(dialogPath, { recursive: true });

      // Atomic write operation
      const metadataFilePath = path.join(dialogPath, 'dialog.yaml');
      const tempFile = metadataFilePath + '.tmp';
      const yamlContent = yaml.stringify(metadata);
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await fs.promises.rename(tempFile, metadataFilePath);
    } catch (error) {
      log.error(`Failed to save dialog YAML for dialog ${dialogId}:`, error);
      throw error;
    }
  }

  /**
   * Save dialog metadata (universal - works with any DialogID)
   */
  static async saveDialogMetadata(
    dialogId: DialogID,
    metadata: DialogMetadataFile,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    if (dialogId.rootId === dialogId.selfId) {
      if (!isRootDialogMetadataFile(metadata)) {
        throw new Error(`Expected root dialog metadata for ${dialogId.selfId}`);
      }
      return this.saveRootDialogMetadata(dialogId, metadata, status);
    }

    // For subdialogs, delegate to saveSubdialogMetadata
    if (!isSubdialogMetadataFile(metadata)) {
      throw new Error(`Expected subdialog metadata for ${dialogId.selfId}`);
    }
    return this.saveSubdialogMetadata(dialogId, metadata, status);
  }

  /**
   * Save dialog metadata (legacy - use saveRootDialogMetadata instead)
   * @deprecated
   */
  static async _saveDialogMetadata(
    dialogId: DialogID,
    metadata: RootDialogMetadataFile,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    return this.saveRootDialogMetadata(dialogId, metadata, status);
  }

  /**
   * Save subdialog metadata under the supdialog's .subdialogs directory
   */
  static async saveSubdialogMetadata(
    dialogId: DialogID,
    metadata: SubdialogMetadataFile,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const subPath = this.getSubdialogPath(dialogId, status);
      const metadataFilePath = path.join(subPath, 'dialog.yaml');

      await fs.promises.mkdir(subPath, { recursive: true });

      const tempFile = metadataFilePath + '.tmp';
      const yamlContent = yaml.stringify(metadata);
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await fs.promises.rename(tempFile, metadataFilePath);
    } catch (error) {
      log.error(
        `Failed to save subdialog YAML for ${dialogId.selfId} under root dialog ${dialogId.rootId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Update assignmentFromSup for an existing subdialog.
   * Persists both subdialog metadata locations for consistency.
   */
  static async updateSubdialogAssignment(
    dialogId: DialogID,
    assignment: SubdialogMetadataFile['assignmentFromSup'],
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('updateSubdialogAssignment expects a subdialog id');
    }
    const metadata = await this.loadDialogMetadata(dialogId, status);
    if (!metadata || !isSubdialogMetadataFile(metadata)) {
      throw new Error(`Missing dialog metadata for subdialog ${dialogId.selfId}`);
    }
    const next: SubdialogMetadataFile = {
      ...metadata,
      assignmentFromSup: assignment,
    };
    await this.saveSubdialogMetadata(dialogId, next, status);
    await this.saveDialogMetadata(dialogId, next, status);
  }

  /**
   * Load root dialog metadata
   */
  static async loadRootDialogMetadata(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogMetadataFile | null> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, status);
      const metadataFilePath = path.join(dialogPath, 'dialog.yaml');

      try {
        const content = await fs.promises.readFile(metadataFilePath, 'utf-8');
        const parsed: unknown = yaml.parse(content);

        if (!isDialogMetadataFile(parsed)) {
          throw new Error(`Invalid dialog metadata in ${metadataFilePath}`);
        }

        // Validate that the ID in the file matches the expected dialogId
        if (parsed.id !== dialogId.selfId) {
          log.warn(
            `Dialog ID mismatch in ${metadataFilePath}: expected ${dialogId.selfId}, got ${parsed.id}`,
          );
          return null;
        }

        return parsed;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return null;
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to load dialog YAML for dialog ${dialogId.selfId}:`, error);
      return null;
    }
  }

  /**
   * Load dialog metadata (universal - works with any DialogID)
   */
  static async loadDialogMetadata(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogMetadataFile | null> {
    // For root dialogs, use the selfId
    // For subdialogs, this is more complex - we need to find the root metadata
    if (dialogId.rootId === dialogId.selfId) {
      return this.loadRootDialogMetadata(dialogId, status);
    }

    // For subdialogs, we need to load from the subdialog location
    const subdialogPath = this.getSubdialogPath(dialogId, status);
    const metadataFilePath = path.join(subdialogPath, 'dialog.yaml');

    try {
      const content = await fs.promises.readFile(metadataFilePath, 'utf-8');
      const parsed: unknown = yaml.parse(content);
      if (!isDialogMetadataFile(parsed)) {
        throw new Error(`Invalid dialog metadata in ${metadataFilePath}`);
      }
      return parsed;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Save latest.yaml with current round and lastModified info
   */
  static async saveDialogLatest(
    dialogId: DialogID,
    latest: DialogLatestFile,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      // Ensure directory exists before writing (handles race conditions and new dialogs)
      await fs.promises.mkdir(dialogPath, { recursive: true });

      const tempFile = latestFilePath + '.tmp';
      const yamlContent = yaml.stringify(latest);
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');

      // Rename with retry logic for filesystem sync issues
      await this.renameWithRetry(tempFile, latestFilePath, yamlContent);

      // todo: publish RoundEvent here or where more suitable?
    } catch (error) {
      log.error(`Failed to save latest.yaml for dialog ${dialogId.selfId}:`, error);
      throw error;
    }
  }

  /**
   * Rename with retry logic to handle filesystem sync issues
   */
  private static async renameWithRetry(
    source: string,
    destination: string,
    yamlContent: string,
    maxRetries: number = 5,
  ): Promise<void> {
    let lastError: Error | undefined;
    const destinationDir = path.dirname(destination);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Ensure directory exists (handles race conditions)
        await fs.promises.mkdir(destinationDir, { recursive: true });

        // Check if source file exists, re-create if missing
        try {
          await fs.promises.access(source);
        } catch {
          // Source file missing - re-create it
          await fs.promises.writeFile(source, yamlContent, 'utf-8');
        }

        await fs.promises.rename(source, destination);
        return;
      } catch (error) {
        lastError = error as Error;
        if (getErrorCode(error) !== 'ENOENT' || attempt === maxRetries) {
          throw error;
        }
        // Exponential backoff for ENOENT (race condition or sync issue)
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
    throw lastError;
  }

  /**
   * Load latest.yaml for current round and lastModified info
   */
  static async loadDialogLatest(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogLatestFile | null> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      const content = await fs.promises.readFile(latestFilePath, 'utf-8');
      const parsed: unknown = yaml.parse(content);
      if (!isDialogLatestFile(parsed)) {
        throw new Error(`Invalid latest.yaml in ${latestFilePath}`);
      }
      return parsed;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Update dialog latest info (current round and lastModified)
   */
  static async updateDialogLatest(
    dialogId: DialogID,
    updates: Partial<Omit<DialogLatestFile, 'currentRound' | 'lastModified'>> & {
      currentRound?: number;
      lastModified?: string;
    },
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogLatestFile> {
    const existing = (await this.loadDialogLatest(dialogId, status)) || {
      currentRound: 1,
      lastModified: formatUnifiedTimestamp(new Date()),
      status: 'active',
    };

    const updated: DialogLatestFile = {
      ...existing,
      ...updates,
      lastModified: updates.lastModified || formatUnifiedTimestamp(new Date()),
    };

    await this.saveDialogLatest(dialogId, updated, status);
    return updated;
  }

  static async setNeedsDrive(
    dialogId: DialogID,
    needsDrive: boolean,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    await this.updateDialogLatest(dialogId, { needsDrive }, status);
  }

  static async getNeedsDrive(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<boolean> {
    const latest = await this.loadDialogLatest(dialogId, status);
    return latest?.needsDrive === true;
  }

  // === FILE SYSTEM UTILITIES ===

  /**
   * Get round filename from round number
   */
  static getRoundFilename(round: number): string {
    return `round-${round.toString().padStart(3, '0')}.jsonl`;
  }

  /**
   * Extract round number from filename
   */
  static getRoundFromFilename(filename: string): number {
    const match = filename.match(/^round-(\d+)\.jsonl$/);
    if (!match) {
      throw new Error(`Invalid round filename: ${filename}`);
    }
    return parseInt(match[1], 10);
  }

  /**
   * Get dialog status from file system path
   */
  static getStatusFromPath(dialogPath: string): 'running' | 'completed' | 'archived' {
    const parentDir = path.basename(path.dirname(dialogPath));
    if (parentDir === this.RUN_DIR) return 'running';
    if (parentDir === this.DONE_DIR) return 'completed';
    if (parentDir === this.ARCHIVE_DIR) return 'archived';
    throw new Error(`Unknown dialog status from path: ${parentDir}`);
  }

  static async loadQuestions4Human(
    dialogId: DialogID,
    round: number,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<Questions4Human | null> {
    const questions = await this.loadQuestions4HumanState(dialogId, status);
    return {
      round,
      questions,
      createdAt: formatUnifiedTimestamp(new Date()),
      updatedAt: formatUnifiedTimestamp(new Date()),
    };
  }

  /**
   * Count subdialogs under a root dialog (no single-layer listing exposed)
   */
  static async countAllSubdialogsUnderRoot(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<number> {
    try {
      const rootPath = this.getRootDialogPath(rootDialogId, status);
      const subdialogsPath = path.join(rootPath, this.SUBDIALOGS_DIR);
      try {
        const entries = await fs.promises.readdir(subdialogsPath, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).length;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return 0;
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to count all subdialogs under root ${rootDialogId.selfId}:`, error);
      return 0;
    }
  }

  // === HIERARCHICAL DIALOG RESTORATION ===

  /**
   * Restore complete dialog tree from disk
   */
  static async restoreDialogTree(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogPersistenceState | null> {
    try {
      // First restore the root dialog
      const rootState = await this.restoreDialog(rootDialogId, status);
      if (!rootState) {
        return null;
      }

      // Recursively restore subdialogs
      const rootPath = this.getRootDialogPath(rootDialogId, status);
      const subdialogsPath = path.join(rootPath, this.SUBDIALOGS_DIR);
      let subdialogIds: string[] = [];
      try {
        const entries = await fs.promises.readdir(subdialogsPath, { withFileTypes: true });
        subdialogIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (err) {
        if (getErrorCode(err) !== 'ENOENT') {
          throw err;
        }
      }
      for (const subdialogId of subdialogIds) {
        await this.restoreDialogTree(new DialogID(subdialogId, rootDialogId.rootId), status);
      }

      return rootState;
    } catch (error) {
      log.error(`Failed to restore dialog tree for ${rootDialogId.valueOf()}:`, error);
      return null;
    }
  }

  /**
   * Restore dialog from disk using JSONL events (optimized: only latest round loaded)
   * For historical rounds, use loadRoundEvents() on-demand for UI navigation
   */
  static async restoreDialog(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogPersistenceState | null> {
    try {
      const metadata = await this.loadDialogMetadata(dialogId, status);
      if (!metadata) {
        log.debug(`No metadata found for dialog ${dialogId}`);
        return null;
      }

      const reminders = await this.loadReminderState(dialogId, status);
      // Only load latest round for dialog state restoration
      const currentRound = await this.getCurrentRoundNumber(dialogId, status);
      const latestEvents = await this.readRoundEvents(dialogId, currentRound, status);

      const reconstructedState = await this.rebuildFromEvents(
        latestEvents,
        metadata,
        reminders,
        currentRound,
      );

      return reconstructedState;
    } catch (error) {
      log.error(`Failed to restore dialog ${dialogId}:`, error);
      return null;
    }
  }

  /**
   * Load specific round events for UI navigation (on-demand)
   */
  static async loadRoundEvents(
    dialogId: DialogID,
    round: number,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<PersistedDialogRecord[]> {
    return await this.readRoundEvents(dialogId, round, status);
  }

  /**
   * Reconstruct dialog state from JSONL events (optimized: only latest round needed)
   */
  static async rebuildFromEvents(
    events: PersistedDialogRecord[],
    metadata: DialogMetadataFile,
    reminders: Reminder[],
    currentRound: number,
  ): Promise<DialogPersistenceState> {
    // Events are already in chronological order from JSONL file (append-only pattern)
    const messages: ChatMessage[] = [];

    // Simple, straightforward mapping to reconstruct messages from persisted events
    for (const event of events) {
      switch (event.type) {
        case 'agent_thought_record': {
          // Convert agent thought to ChatMessage
          messages.push({
            type: 'thinking_msg',
            role: 'assistant',
            genseq: event.genseq,
            content: event.content,
            provider_data: event.provider_data,
          });
          break;
        }

        case 'agent_words_record': {
          // Convert agent words to ChatMessage
          messages.push({
            type: 'saying_msg',
            role: 'assistant',
            genseq: event.genseq,
            content: event.content,
          });
          break;
        }

        case 'human_text_record': {
          // Convert human text to prompting message
          messages.push({
            type: 'prompting_msg',
            role: 'user',
            genseq: event.genseq,
            msgId: event.msgId,
            content: event.content,
            grammar: event.grammar ?? 'texting',
          });
          break;
        }

        case 'func_call_record': {
          // Convert function call to ChatMessage
          messages.push({
            type: 'func_call_msg',
            role: 'assistant',
            genseq: event.genseq,
            id: event.id,
            name: event.name,
            arguments: event.arguments ? JSON.stringify(event.arguments) : '{}',
          });
          break;
        }

        case 'func_result_record': {
          // Convert function result to ChatMessage
          messages.push({
            type: 'func_result_msg',
            role: 'tool',
            genseq: event.genseq,
            id: event.id,
            name: event.name,
            content: event.content,
          });
          break;
        }

        case 'tool_call_result_record': {
          // Convert tool call result to ChatMessage
          messages.push({
            type: 'call_result_msg',
            role: 'tool',
            responderId: event.responderId,
            headLine: event.headLine,
            status: event.status,
            content: event.result,
          });
          break;
        }

        case 'teammate_response_record': {
          // Convert teammate response to ChatMessage (teammate - separate bubble)
          // Note: Teammate responses are stored as separate records but use same message type
          messages.push({
            type: 'call_result_msg',
            role: 'tool',
            responderId: event.responderId,
            headLine: event.headLine,
            status: event.status,
            content: event.result,
          });
          break;
        }

        // gen_start_record and gen_finish_record are control events, not message content
        // They don't need to be converted to ChatMessage objects
        case 'gen_start_record':
        case 'gen_finish_record':
        case 'quest_for_sup_record':
          // These events are handled separately in dialog restoration
          // Skip them for message reconstruction
          break;

        default:
          log.warn(`Unknown event type in rebuildFromEvents`, undefined, { event });
          break;
      }
    }

    return {
      metadata,
      currentRound,
      messages,
      reminders,
    };
  }

  /**
   * Move dialog between status directories (run/done/archive)
   */
  static async moveDialogStatus(
    dialogId: DialogID,
    fromStatus: 'running' | 'completed' | 'archived',
    toStatus: 'running' | 'completed' | 'archived',
  ): Promise<void> {
    try {
      const fromPath = path.join(
        this.getDialogsRootDir(),
        fromStatus === 'running'
          ? this.RUN_DIR
          : fromStatus === 'completed'
            ? this.DONE_DIR
            : this.ARCHIVE_DIR,
        dialogId.selfId,
      );
      const toPath = path.join(
        this.getDialogsRootDir(),
        toStatus === 'running'
          ? this.RUN_DIR
          : toStatus === 'completed'
            ? this.DONE_DIR
            : this.ARCHIVE_DIR,
        dialogId.selfId,
      );

      // Ensure destination directory exists
      await fs.promises.mkdir(toPath, { recursive: true });

      // Move all files and directories
      const entries = await fs.promises.readdir(fromPath, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(fromPath, entry.name);
        const destPath = path.join(toPath, entry.name);
        await fs.promises.rename(srcPath, destPath);
      }
    } catch (error) {
      log.error(`Failed to move dialog ${dialogId} from ${fromStatus} to ${toStatus}:`, error);
      throw error;
    }
  }

  // === REGISTRY PERSISTENCE ===

  /**
   * Save subdialog registry (TYPE B entries).
   */
  static async saveSubdialogRegistry(
    rootDialogId: DialogID,
    entries: Array<{
      key: string;
      subdialogId: DialogID;
      agentId: string;
      topicId?: string;
    }>,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const registryFilePath = path.join(dialogPath, 'registry.yaml');

      await fs.promises.mkdir(dialogPath, { recursive: true });

      const serializableEntries = entries.map((entry) => ({
        key: entry.key,
        subdialogId: entry.subdialogId.selfId,
        agentId: entry.agentId,
        topicId: entry.topicId,
      }));

      const tempFile = registryFilePath + '.tmp';
      const yamlContent = yaml.stringify({ entries: serializableEntries });
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await fs.promises.rename(tempFile, registryFilePath);
    } catch (error) {
      log.error(`Failed to save subdialog registry for dialog ${rootDialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load subdialog registry.
   */
  static async loadSubdialogRegistry(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<
    Array<{
      key: string;
      subdialogId: DialogID;
      agentId: string;
      topicId?: string;
    }>
  > {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const registryFilePath = path.join(dialogPath, 'registry.yaml');

      const content = await fs.promises.readFile(registryFilePath, 'utf-8');
      const parsed: unknown = yaml.parse(content);

      if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
        log.warn(`Invalid registry.yaml format for dialog ${rootDialogId}`);
        return [];
      }

      const entries = parsed.entries.map((entry: unknown) => {
        if (!isRecord(entry)) {
          throw new Error('Invalid registry entry');
        }
        return {
          key: entry.key as string,
          subdialogId: new DialogID(entry.subdialogId as string, rootDialogId.rootId),
          agentId: entry.agentId as string,
          topicId: entry.topicId as string | undefined,
        };
      });

      return entries;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      log.error(`Failed to load subdialog registry for dialog ${rootDialogId}:`, error);
      return [];
    }
  }
}
