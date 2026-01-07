/**
 * Module: dialog
 *
 * Provides the `Dialog` object for orchestrating conversations:
 * - Tracks messages, agent identity, optional supdialog/subdialog relationships
 * - Receivers for streaming LLM output and tool results
 * - Helpers for spawning subdialogs and prompting human input
 * - Persistence support for dialog state and message history
 *
 * Architecture (Phase 2):
 * - `Dialog` - Abstract base class for all dialogs
 * - `RootDialog` - Root dialog with subdialog registry
 * - `SubDialog` - Subdialog with reference to parent RootDialog
 */
import { inspect } from 'util';
import { SubdialogMutex, type MutexEntry } from './dialog-registry';
import { postDialogEvent } from './evt-registry';
import { ChatMessage, FuncResultMsg } from './llm/client';
import { log } from './log';
import type { SubChan } from './shared/evt';
import type {
  DialogEvent,
  FullRemindersEvent,
  ReminderContent,
  TeammateResponseEvent,
} from './shared/types/dialog';
import type {
  HumanQuestion,
  ProviderData,
  ToolArguments as StoredToolArguments,
} from './shared/types/storage';
import { formatUnifiedTimestamp } from './shared/utils/time';
import type { JsonValue } from './tool';
import { Reminder, ReminderOwner, TextingTool } from './tool';
import {
  addReminderTool,
  changeMindTool,
  clearMindTool,
  deleteReminderTool,
  updateReminderTool,
} from './tools/ctrl';
import { generateDialogID } from './utils/id';

export class DialogID {
  public readonly selfId: string;
  public readonly rootId: string;

  constructor(selfId: string, rootId?: string) {
    this.selfId = selfId;
    this.rootId = rootId || selfId;
    if (typeof selfId !== 'string')
      throw new Error(`Wrong type [${typeof selfId}] passed as dlg id: ${inspect(selfId)}`);
    if (rootId && typeof rootId !== 'string')
      throw new Error(`Wrong type [${typeof rootId}] passed as dlg id: ${inspect(rootId)}`);
  }

  key(): string {
    return this.valueOf();
  }

  valueOf(): string {
    if (!this.rootId || this.rootId === this.selfId) {
      return this.selfId;
    }
    return this.rootId + '#' + this.selfId;
  }

  /**
   * Pretty print representation for debugging and display
   */
  public toString(): string {
    return this.valueOf();
  }

  /**
   * Check equality with another DialogID
   */
  public equals(other: DialogID): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    return this.selfId === other.selfId && this.rootId === other.rootId;
  }

  /**
   * Generate hash code for Map/Set usage
   */
  public hashCode(): string {
    return this.valueOf();
  }
}

/**
 * Represents a pending subdialog summary waiting to be processed when parent dialog resumes
 */
export interface PendingSubdialogSummary {
  subdialogId: DialogID;
  summary: string;
  completedAt: string;
}

/**
 * Phase 6: Pending subdialog record for Type A subdialog supply mechanism.
 * Tracks a subdialog that was created but not yet completed.
 */
export interface PendingSubdialog {
  subdialogId: DialogID;
  createdAt: string;
  headLine: string;
  targetAgentId: string;
  callType: 'A' | 'B' | 'C';
  topicId?: string;
}

/**
 * Phase 6: Subdialog response record for Type A subdialog supply mechanism.
 * Tracks the response from a completed subdialog.
 */
export interface SubdialogResponse {
  subdialogId: DialogID;
  summary: string;
  completedAt: string;
  callType: 'A' | 'B' | 'C';
}

/**
 * Common dialog initialization parameters (shared between RootDialog and SubDialog)
 */
export interface DialogInitParams {
  taskDocPath: string;
  agentId: string;
  initialState?: {
    messages?: ChatMessage[];
    reminders?: Reminder[];
    currentRound?: number;
    createdAt?: string;
    updatedAt?: string;
  };
}

/**
 * Assignment from parent dialog for subdialogs
 */
export interface AssignmentFromSup {
  headLine: string;
  callBody: string;
  originRole: 'user' | 'assistant';
  originMemberId?: string;
}

/**
 * Abstract base class for all dialog types.
 * Contains common properties and methods shared between RootDialog and SubDialog.
 */
export abstract class Dialog {
  public readonly dlgStore: DialogStore;

  // relative path to a specific workspace (usually .md) file,
  // used as mission/plan/progress doc of a round of a dialog
  public taskDocPath: string; // Task document is mandatory for all dialogs

  readonly id: DialogID;
  readonly agentId: string; // team member id
  readonly reminders: Reminder[];
  readonly msgs: ChatMessage[];
  readonly supdialog?: Dialog;
  // present if this is a subdialog created by an autonomous teammate call from a supdialog
  readonly assignmentFromSup?: AssignmentFromSup;

  // Persistence state
  protected _currentRound: number = 1;
  protected _remindersVer: number = 0;
  protected _activeGenSeq?: number;
  protected _status: 'running' | 'completed' | 'archived' = 'running';
  protected _createdAt: string;
  protected _updatedAt: string;
  protected _unsavedMessages: ChatMessage[] = [];
  public subChan?: SubChan<DialogEvent>;
  // Track whether the current round's initial events (user_text, generating_start)
  // have been fully processed. Used to ensure subdialog_final_summary_evt arrives
  // only after parent events are emitted.
  protected _generationStarted: boolean = false;
  // Track the generation sequence when _generationStarted was set
  // Used to ensure proper ordering when multiple generations occur
  protected _generationStartedGenseq: number = 0;

  // Pending subdialog summaries - stored until parent dialog resumes
  // This enables detached subdialog driving where summaries are deferred
  protected _pendingSubdialogSummaries: PendingSubdialogSummary[] = [];

  // Phase 11: Suspension state for Type A subdialog mechanism
  // Tracks whether this dialog is in normal state, suspended, or resuming from suspension
  protected _suspensionState: 'active' | 'suspended' | 'resumed' = 'active';

  // Current callId for TEXTING TOOL CALL correlation
  // - Set during call_start_evt (from TextingEventsReceiver)
  // - Retrieved during tool response (for receiveToolResponse callId parameter)
  // - Enables frontend to attach result INLINE to the calling section
  // - NOT used for teammate calls (which use calleeDialogId instead)
  protected _currentCallId: string | null = null;

  // Phase 14: Type C Subdialog suspension state
  protected _isSuspendedForSubdialogs: boolean = false;
  protected _pendingSubdialogCallIds: Set<string> = new Set();

  constructor(
    dlgStore: DialogStore,
    taskDocPath: string,
    id: DialogID | undefined,
    agentId: string,
    supdialog?: Dialog,
    assignmentFromSup?: AssignmentFromSup,
    initialState?: DialogInitParams['initialState'],
  ) {
    // Validate required parameters
    if (!taskDocPath || taskDocPath.trim() === '') {
      throw new Error('Task document path is required for creating a dialog');
    }

    this.dlgStore = dlgStore;
    this.taskDocPath = taskDocPath.trim();
    if (id === undefined) {
      const generatedId = generateDialogID();
      id = new DialogID(generatedId);
    }
    this.id = id;
    this.agentId = agentId;
    this.reminders = initialState?.reminders || [];
    this.msgs = initialState?.messages || [];
    this.supdialog = supdialog;
    this.assignmentFromSup = assignmentFromSup
      ? {
          headLine: assignmentFromSup.headLine,
          callBody: assignmentFromSup.callBody,
          originRole: assignmentFromSup.originRole ?? 'assistant',
          originMemberId: assignmentFromSup.originMemberId,
        }
      : undefined;

    // Initialize persistence state
    const now = formatUnifiedTimestamp(new Date());
    this._createdAt = initialState?.createdAt || now;
    this._updatedAt = initialState?.updatedAt || now;
    this._currentRound = initialState?.currentRound || 1;
  }

  public get remindersVer() {
    return this._remindersVer;
  }

  /**
   * Get the current callId for TEXTING TOOL CALL correlation
   *
   * Call Types:
   * - Texting Tool Call (@tool_name): callId is set during call_start_evt, used for inline result
   * - Teammate Call (@agentName): Uses calleeDialogId, not callId
   *
   * @returns The current callId for tool correlation, or null if no active tool call
   */
  public getCurrentCallId(): string | null {
    return this._currentCallId;
  }

  /**
   * Set the current callId (called during call_finish_evt for texting tool calls)
   *
   * @param callId - The correlation ID from TextingEventsReceiver.callFinish()
   */
  public setCurrentCallId(callId: string): void {
    this._currentCallId = callId;
  }

  /**
   * Clear the current callId (called after tool response is sent)
   */
  public clearCurrentCallId(): void {
    this._currentCallId = null;
  }

  // Phase 14: Type C Subdialog suspension methods

  public get isSuspendedForSubdialogs(): boolean {
    return this._isSuspendedForSubdialogs;
  }

  public suspendForSubdialogResponses(callIds: string[]): void {
    this._pendingSubdialogCallIds = new Set(callIds);
    this._isSuspendedForSubdialogs = true;
  }

  public markSubdialogResponseReceived(callId: string): boolean {
    this._pendingSubdialogCallIds.delete(callId);
    if (this._pendingSubdialogCallIds.size === 0) {
      this._isSuspendedForSubdialogs = false;
      return true;
    }
    return false;
  }

  /**
   * Abstract method for creating subdialogs.
   * Implemented by RootDialog to create SubDialog instances.
   */
  abstract createSubDialog(
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options?: { originRole: 'user' | 'assistant'; originMemberId?: string; callId?: string },
  ): Promise<SubDialog>;

  /**
   * Post a dialog event using the standard event registry.
   */
  postEvent(event: DialogEvent): void {
    postDialogEvent(this, event);
  }

  // - return true if human response has been collected and incorporated into the msgs, thus
  // should continue generating next llm messages immediately;
  //
  // Reminder management methods
  public addReminder(
    content: string,
    owner?: ReminderOwner,
    meta?: JsonValue,
    position?: number,
  ): void {
    const reminder: Reminder = { content, owner, meta };
    const insertIndex = position !== undefined ? position : this.reminders.length;
    if (insertIndex < 0 || insertIndex > this.reminders.length) {
      throw new Error(
        `Invalid reminder position ${insertIndex}. Valid range: 0-${this.reminders.length}`,
      );
    }
    this.reminders.splice(insertIndex, 0, reminder);
    this._updatedAt = formatUnifiedTimestamp(new Date());

    // Increment version for conditional event emission in driver
    this._remindersVer++;
  }

  public deleteReminder(index: number): Reminder {
    if (index < 0 || index >= this.reminders.length) {
      throw new Error(
        `Reminder index ${index} does not exist. Available reminders: 0-${this.reminders.length - 1}`,
      );
    }
    const deleted = this.reminders.splice(index, 1)[0];
    this._updatedAt = formatUnifiedTimestamp(new Date());

    // Increment version for conditional event emission in driver
    this._remindersVer++;

    return deleted;
  }

  public updateReminder(index: number, content: string, meta?: JsonValue): Reminder {
    if (index < 0 || index >= this.reminders.length) {
      throw new Error(
        `Reminder index ${index} does not exist. Available reminders: 0-${this.reminders.length - 1}`,
      );
    }
    const oldReminder = this.reminders[index];
    const updatedReminder: Reminder = {
      content,
      owner: oldReminder.owner,
      meta: meta !== undefined ? meta : oldReminder.meta,
    };
    this.reminders[index] = updatedReminder;
    this._updatedAt = formatUnifiedTimestamp(new Date());

    // Increment version for conditional event emission in driver
    this._remindersVer++;

    return oldReminder;
  }

  public clearReminders(): void {
    this.reminders.length = 0;
    this._updatedAt = formatUnifiedTimestamp(new Date());

    // Increment version for conditional event emission in driver
    this._remindersVer++;
  }

  /**
   * Process reminder updates before LLM generation.
   * Calls updateReminder on each tool that owns reminders to allow them to update/drop/keep their reminders.
   * Returns reminder contents with metadata for the frontend.
   */
  public async processReminderUpdates(): Promise<ReminderContent[]> {
    const indicesToRemove: number[] = [];

    for (let i = 0; i < this.reminders.length; i++) {
      const reminder = this.reminders[i];

      // Skip if the reminder has no owner or the owner doesn't have an updateReminder method
      if (!reminder.owner || !reminder.owner.updateReminder) {
        continue;
      }

      try {
        const result = await reminder.owner.updateReminder(this, reminder);

        switch (result.treatment) {
          case 'drop':
            indicesToRemove.push(i);
            break;
          case 'update':
            if (result.updatedContent !== undefined) {
              const updatedReminder: Reminder = {
                content: result.updatedContent,
                owner: reminder.owner,
                meta: result.updatedMeta !== undefined ? result.updatedMeta : reminder.meta,
              };
              this.reminders[i] = updatedReminder;
            }
            break;
          case 'keep':
            // No action needed
            break;
        }
      } catch (error) {
        log.error(`Error updating reminder from tool ${reminder.owner}:`, error);
        // Continue processing other reminders even if one fails
      }
    }

    // Remove reminders marked for deletion (in reverse order to maintain indices)
    for (let i = indicesToRemove.length - 1; i >= 0; i--) {
      this.reminders.splice(indicesToRemove[i], 1);
    }

    if (indicesToRemove.length > 0) {
      this._updatedAt = formatUnifiedTimestamp(new Date());
    }

    // Centralized persistence - called when emitting event
    this.dlgStore.persistReminders(this, this.reminders);

    const reminders: ReminderContent[] = this.reminders.map((r: Reminder) => ({
      content: r.content,
      meta: r.meta as Record<string, unknown> | undefined,
    }));

    // Emit full_reminders_update event with complete reminder list including metadata
    const fullRemindersEvt: FullRemindersEvent = {
      type: 'full_reminders_update',
      reminders,
    };
    postDialogEvent(this, fullRemindersEvt);

    return reminders;
  }

  // Intrinsic tools management

  /**
   * Get intrinsic control tools available to this dialog's agent.
   * Applies access control: @change_mind is only available to main dialog agents.
   */
  public getIntrinsicTools(): TextingTool[] {
    const baseTools: TextingTool[] = [
      addReminderTool,
      deleteReminderTool,
      updateReminderTool,
      clearMindTool,
    ];

    // @change_mind is only available to main dialog agents (not subdialogs)
    if (!this.supdialog) {
      baseTools.push(changeMindTool);
    }

    return baseTools;
  }

  /**
   * Get instructions for intrinsic tools only.
   * Returns empty string if no intrinsic tools are available for this dialog.
   */
  public getIntrinsicToolInstructions(): string {
    // Provide comprehensive dialog control instructions
    let instructions = `You have access to dialog control capabilities that help you achieve mental clarity and maintain focus on what matters most:

**Mental Clarity Strategy:**
The key to effective AI assistance is maintaining clear focus on goals while filtering out conversational noise. When chat history becomes cluttered with repeated tool failures, debugging attempts, or tangential discussions, your attention gets fragmented. These tools help you regain clarity and redirect focus to productive work.

**Dialog Reminders:**
- @add_reminder: Capture important insights, decisions, or next steps that should persist beyond conversation cleanup
- @update_reminder: Refine your understanding as situations evolve or new information emerges  
- @delete_reminder: Remove completed or obsolete reminders to keep your focus sharp
- @clear_mind: Achieve mental clarity by clearing conversational noise while preserving your reminders and task focus

**Task Context Control:**`;

    if (this.supdialog) {
      // Find main dialog (root dialog) by traversing up the supdialog chain
      let rootDialog = this.supdialog;
      while (rootDialog.supdialog) {
        rootDialog = rootDialog.supdialog;
      }

      // Subdialog restrictions
      instructions += `
- @clear_mind: Restart this subdialog with a clean slate, focusing your attention on the task document and any specific reminder you provide. This clears conversational noise while preserving your reminders and supdialog-call context.
- @change_mind: **Not available in subdialogs.** If you need to change the overall task context or direction, communicate with the main dialog agent (@${rootDialog.agentId}) and ask them to use @change_mind instead.

**Subdialog Guidelines:**
You're operating in a subdialog, which means you're focused on a specific subtask. Your memory and context are scoped to this particular conversation thread. When you complete your subtask or need to escalate decisions, communicate back to the supdialog.`;
    } else {
      // Main dialog capabilities
      instructions += `
- @clear_mind: Restart the conversation with a clean slate, focusing your attention on the task document and any specific reminder you provide. This clears conversational noise while preserving your reminders.
- @change_mind: Fundamentally shift the task direction by updating the task document with new content. This affects all participant agents (yourself and any subdialog agents), giving everyone a refreshed focus while preserving their reminders and supdialog-call information. Use when requirements change or you need to pivot strategy.

**Main Dialog Responsibilities:**
You're the primary dialog agent. You can create subdialogs for specialized tasks, manage the overall conversation flow, and make high-level decisions about task direction and approach.`;
    }

    instructions += `

**Best Practices:**
- **Maintain Mental Clarity:** When conversations become cluttered with debugging, repeated failures, or tangential discussions, use @clear_mind to refocus on what matters
- **Strategic Reminders:** Capture key insights, decisions, and next steps in reminders before clearing your mind - they'll persist and guide your refreshed focus
- **Task Document Focus:** Both @clear_mind and @change_mind redirect attention to the task document (goals, progress, gotchas), ensuring you stay aligned with objectives
- **Proactive Clarity:** Don't wait for conversations to become overwhelming - clear your mind proactively when you sense attention fragmentation
- **Context Preservation:** Remember that clearing your mind preserves reminders and (for subdialogs) supdialog-call information - you lose chat noise, not important context
- **Strategic Pivots:** Use @change_mind when user requirements evolve or you need to fundamentally shift approach - it updates the task document for all agents to restart with refreshed focus`;

    return instructions;
  }

  // only to be used by the driver
  public async addChatMessages(...msgs: ChatMessage[]): Promise<void> {
    this.msgs.push(...msgs);
  }

  // Persistence methods

  /**
   * Get current persistence status
   */
  public get status(): 'running' | 'completed' | 'archived' {
    return this._status;
  }

  /**
   * Get current round number
   */
  public get currentRound(): number {
    return this._currentRound;
  }

  /**
   * Get current generation sequence number
   */
  public get activeGenSeq(): number {
    if (!this._activeGenSeq) {
      throw new Error(`No active genseq, this is bug!!`);
    }
    return this._activeGenSeq;
  }

  public get activeGenSeqOrUndefined(): number | undefined {
    return this._activeGenSeq;
  }

  /**
   * Check if generation has started for the current round.
   * Used to ensure subdialog_final_summary_evt arrives after parent events.
   */
  public get generationStarted(): boolean {
    return this._generationStarted;
  }

  /**
   * Mark generation as started (after user_text event has been emitted).
   * This ensures subdialog_final_summary_evt waits for this signal.
   * @param genseq The generation sequence number when this flag is set
   */
  public markGenerationStarted(genseq?: number): void {
    this._generationStarted = true;
    this._generationStartedGenseq = genseq ?? this._activeGenSeq ?? 0;
  }

  /**
   * Get the genseq when generation was marked as started
   */
  public get generationStartedGenseq(): number {
    return this._generationStartedGenseq;
  }

  /**
   * Add a pending subdialog summary to be processed when parent dialog resumes
   * @param subdialogId The ID of the completed subdialog
   * @param summary The summary text from the subdialog
   */
  public addPendingSubdialogSummary(subdialogId: DialogID, summary: string): void {
    this._pendingSubdialogSummaries.push({
      subdialogId,
      summary,
      completedAt: formatUnifiedTimestamp(new Date()),
    });
  }

  /**
   * Take all pending subdialog summaries and clear the queue
   * Used when parent dialog resumes to process all accumulated summaries
   * @returns Array of pending subdialog summaries
   */
  public takePendingSubdialogSummaries(): PendingSubdialogSummary[] {
    const taken = [...this._pendingSubdialogSummaries];
    this._pendingSubdialogSummaries = [];
    return taken;
  }

  /**
   * Get pending subdialog summaries without clearing the queue
   * @returns Array of pending subdialog summaries
   */
  public getPendingSubdialogSummaries(): PendingSubdialogSummary[] {
    return [...this._pendingSubdialogSummaries];
  }

  /**
   * Phase 11: Get current suspension state
   * @returns 'active' | 'suspended' | 'resumed'
   */
  public getSuspensionState(): 'active' | 'suspended' | 'resumed' {
    return this._suspensionState;
  }

  /**
   * Phase 11: Set suspension state
   * @param state The new suspension state
   */
  public setSuspensionState(state: 'active' | 'suspended' | 'resumed'): void {
    this._suspensionState = state;
    this._updatedAt = formatUnifiedTimestamp(new Date());
  }

  public get createdAt(): string {
    return this._createdAt;
  }

  public get updatedAt(): string {
    return this._updatedAt;
  }

  /**
   * Start a new round - clears conversational noise, Q4H, and increments round counter.
   * This is the single entry point for mental clarity operations (@clear_mind, @change_mind).
   */
  public async startNewRound(): Promise<void> {
    // Clear all messages and Q4H questions for mental clarity
    this.msgs.length = 0;
    this._unsavedMessages.length = 0;
    await this.dlgStore.clearQuestions4Human(this);

    // Delegate to DialogStore for round start persistence
    if (this.dlgStore) {
      await this.dlgStore.startNewRound(this);
    }

    const storeRound = this.dlgStore
      ? await this.dlgStore.loadCurrentRound(this.id)
      : this._currentRound + 1;
    this._currentRound = storeRound;
    this._updatedAt = formatUnifiedTimestamp(new Date());
  }

  // Proxy methods for DialogStore - route calls through dialog object instead of direct dlgStore access
  public async receiveFuncResult(result: FuncResultMsg): Promise<void> {
    return await this.dlgStore.receiveFuncResult(this, result);
  }

  public async notifyGeneratingStart(): Promise<void> {
    if (typeof this._activeGenSeq === 'number') {
      this._activeGenSeq++;
    } else {
      // Get next sequence number from store
      const genseq = await this.dlgStore.getNextSeq(this.id, this.currentRound);
      this._activeGenSeq = genseq;
    }

    // Mark generation as started with the actual genseq
    // This ensures subdialog_final_summary_evt waits for both user_text and generating_start_evt
    this.markGenerationStarted();

    await this.dlgStore.notifyGeneratingStart(this);
  }

  public async notifyGeneratingFinish(): Promise<void> {
    try {
      await this.dlgStore.notifyGeneratingFinish(this);
    } catch (err) {
      log.warn('notifyGeneratingFinish failed', undefined, {
        genseq: this._activeGenSeq,
        error: err,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // Reset generation tracking for the next round
    this._generationStarted = false;
    this._generationStartedGenseq = 0;
  }

  public async streamError(error: string): Promise<void> {
    if (this.dlgStore) {
      await this.dlgStore.streamError(this, error);
    }
  }

  public async thinkingStart(): Promise<void> {
    await this.dlgStore.thinkingStart(this);
  }

  public async thinkingChunk(chunk: string): Promise<void> {
    await this.dlgStore.thinkingChunk(this, chunk);
  }

  public async markdownStart(): Promise<void> {
    await this.dlgStore.markdownStart(this);
  }

  public async markdownChunk(chunk: string): Promise<void> {
    await this.dlgStore.markdownChunk(this, chunk);
  }

  public async thinkingFinish(): Promise<void> {
    await this.dlgStore.thinkingFinish(this);
  }

  public async markdownFinish(): Promise<void> {
    await this.dlgStore.markdownFinish(this);
  }

  public async sayingStart(): Promise<void> {
    await this.dlgStore.sayingStart(this);
  }

  public async sayingChunk(chunk: string): Promise<void> {
    await this.dlgStore.sayingChunk(this, chunk);
    // No frontend event needed - frontend gets content through streaming parser
  }

  public async sayingFinish(): Promise<void> {
    await this.dlgStore.sayingFinish(this);
  }

  public async codeBlockStart(infoLine?: string): Promise<void> {
    await this.dlgStore.codeBlockStart(this, infoLine);
  }
  public async codeBlockChunk(chunk: string): Promise<void> {
    await this.dlgStore.codeBlockChunk(this, chunk);
  }
  public async codeBlockFinish(endQuote?: string): Promise<void> {
    await this.dlgStore.codeBlockFinish(this, endQuote);
  }

  // Function call events (non-streaming mode - single event captures entire call)
  public async funcCallRequested(
    funcId: string,
    funcName: string,
    argumentsStr: string,
  ): Promise<void> {
    await this.dlgStore.funcCallRequested(this, funcId, funcName, argumentsStr);
  }

  // Tool call events (streaming mode - @tool_name mentions)
  public async callingStart(firstMention: string): Promise<void> {
    await this.dlgStore.callingStart(this, firstMention);
  }

  public async callingHeadlineChunk(chunk: string): Promise<void> {
    await this.dlgStore.callingHeadlineChunk(this, chunk);
  }

  public async callingHeadlineFinish(): Promise<void> {
    await this.dlgStore.callingHeadlineFinish(this);
  }

  public async callingBodyStart(infoLine?: string): Promise<void> {
    await this.dlgStore.callingBodyStart(this, infoLine);
  }

  public async callingBodyChunk(chunk: string): Promise<void> {
    await this.dlgStore.callingBodyChunk(this, chunk);
  }

  public async callingBodyFinish(endQuote?: string): Promise<void> {
    await this.dlgStore.callingBodyFinish(this, endQuote);
  }

  public async callingFinish(callId: string): Promise<void> {
    // Store callId for tool call correlation
    this.setCurrentCallId(callId);
    await this.dlgStore.callingFinish(this, callId);
  }

  public async receiveTextingResponse(
    responderId: string,
    headLine: string,
    result: string,
    status: 'completed' | 'failed',
    subdialogId?: DialogID,
  ): Promise<void> {
    return await this.dlgStore.receiveTextingResponse(
      this,
      responderId,
      headLine,
      result,
      status,
      subdialogId,
    );
  }

  /**
   * Receive tool response with callId for inline correlation
   */
  public async receiveToolResponse(
    responderId: string,
    headLine: string,
    result: string,
    status: 'completed' | 'failed',
    callId: string,
  ): Promise<void> {
    return await this.dlgStore.receiveToolResponse(
      this,
      responderId,
      headLine,
      result,
      status,
      callId,
    );
  }

  /**
   * Receive teammate response (separate bubble for @teammate calls)
   */
  public async receiveTeammateResponse(
    responderId: string,
    headLine: string,
    result: string,
    status: 'completed' | 'failed',
    subdialogId?: DialogID,
  ): Promise<void> {
    return await this.dlgStore.receiveTeammateResponse(
      this,
      responderId,
      headLine,
      result,
      status,
      subdialogId,
    );
  }

  public async updateQuestions4Human(questions: HumanQuestion[]): Promise<void> {
    return await this.dlgStore.updateQuestions4Human(this, questions);
  }

  public async persistUserMessage(content: string, msgId: string): Promise<void> {
    return await this.dlgStore.persistUserMessage(this, content, msgId);
  }

  public async persistAgentMessage(
    content: string,
    genseq: number,
    type: 'thinking_msg' | 'saying_msg',
    provider_data?: ProviderData,
  ): Promise<void> {
    return await this.dlgStore.persistAgentMessage(this, content, genseq, type, provider_data);
  }

  public async persistFunctionCall(
    id: string,
    name: string,
    arguments_: StoredToolArguments,
    genseq: number,
  ): Promise<void> {
    return await this.dlgStore.persistFunctionCall(this, id, name, arguments_, genseq);
  }

  /**
   * Post subdialog completion summary to this dialog
   * Phase 14: No wait - emit immediately with virtual gen markers for Type C subdialogs
   */
  public async postSubdialogSummary(
    subdialogId: DialogID,
    summary: string,
    callId?: string,
  ): Promise<void> {
    try {
      // NO WAIT - emit immediately with virtual gen markers

      // Emit virtual generating_start_evt for subdialog response bubble
      await this.notifyGeneratingStart();

      // Emit TeammateResponseEvent
      const evt: TeammateResponseEvent = {
        type: 'teammate_response_evt',
        responderId: subdialogId.rootId,
        calleeDialogId: subdialogId.selfId,
        headLine: summary.slice(0, 100) + (summary.length > 100 ? '...' : ''),
        status: 'completed',
        result: summary,
        round: this.currentRound,
        summary,
        agentId: subdialogId.rootId,
        callId: callId ?? undefined,
      };
      postDialogEvent(this, evt);

      // Emit virtual generating_finish_evt
      await this.notifyGeneratingFinish();

      // Check if parent is suspended waiting for Type C responses
      if (this._isSuspendedForSubdialogs && callId) {
        const shouldResume = this.markSubdialogResponseReceived(callId);
        if (shouldResume) {
          log.info(`All Type C responses received for dialog ${this.id.selfId}, resuming...`);
        }
      }
    } catch (err) {
      log.warn('Failed to post teammate_response_evt event', undefined, {
        error: err,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * SubDialog - A subdialog created by a RootDialog for autonomous teammate calls.
 * Contains a reference to its parent RootDialog for registry and completion reporting.
 */
export class SubDialog extends Dialog {
  public readonly supdialog: RootDialog;
  public readonly topicId?: string;

  constructor(
    supdialog: RootDialog,
    taskDocPath: string,
    id: DialogID | undefined,
    agentId: string,
    assignmentFromSup?: AssignmentFromSup,
    initialState?: DialogInitParams['initialState'],
  ) {
    super(supdialog.dlgStore, taskDocPath, id, agentId, supdialog, assignmentFromSup, initialState);
    this.supdialog = supdialog;
    // topicId is optional - can be used to track specific conversation topics
  }

  /**
   * Create a subdialog - subdialogs cannot create other subdialogs.
   * This delegates to the parent RootDialog.
   */
  async createSubDialog(
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options?: { originRole: 'user' | 'assistant'; originMemberId?: string },
  ): Promise<SubDialog> {
    return await this.supdialog.createSubDialog(targetAgentId, headLine, callBody, options);
  }
}

/**
 * RootDialog - The main/root dialog that can create and manage subdialogs.
 * Uses SubdialogMutex for tracking subdialogs by agentId and topicId.
 */
export class RootDialog extends Dialog {
  // Phase 13: SubdialogMutex for tracking subdialogs by agentId and topicId.
  // This is the single source of truth for subdialog registry.
  private readonly _subdialogMutex: SubdialogMutex = new SubdialogMutex();

  constructor(
    dlgStore: DialogStore,
    taskDocPath: string,
    id: DialogID | undefined,
    agentId: string,
    initialState?: DialogInitParams['initialState'],
  ) {
    super(dlgStore, taskDocPath, id, agentId, undefined, undefined, initialState);
  }

  /**
   * Get the Phase 13 SubdialogMutex for agentId/topicId based tracking.
   * This is the single source of truth for subdialog registry.
   */
  get subdialogMutex(): SubdialogMutex {
    return this._subdialogMutex;
  }

  /**
   * Register a subdialog in the Phase 13 SubdialogMutex by agentId and topicId.
   * Uses lock() to acquire mutex when subdialog starts being driven.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @param subdialogId - The DialogID of the subdialog
   * @returns The created MutexEntry
   */
  registerSubdialogByTopic(agentId: string, topicId: string, subdialogId: DialogID): MutexEntry {
    return this._subdialogMutex.lock(agentId, topicId, subdialogId);
  }

  /**
   * Lookup a subdialog by agentId and topicId using the Phase 13 SubdialogMutex.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns The MutexEntry if found, null otherwise
   */
  lookupSubdialogByTopic(agentId: string, topicId: string): MutexEntry | null {
    return this._subdialogMutex.lookup(agentId, topicId);
  }

  /**
   * Release mutex lock when subdialog completes LLM generation.
   * Uses unlock() instead of markDone().
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns True if mutex was released, false if entry not found
   */
  unlockMutexByTopic(agentId: string, topicId: string): boolean {
    return this._subdialogMutex.unlock(agentId, topicId);
  }

  /**
   * Remove a subdialog entry from the mutex registry.
   * @param agentId - The agent ID
   * @param topicId - The topic ID
   * @returns True if an entry was removed
   */
  removeSubdialogByTopic(agentId: string, topicId: string): boolean {
    return this._subdialogMutex.remove(agentId, topicId);
  }

  /**
   * Create a new subdialog for autonomous teammate calls.
   * Note: Registration in SubdialogMutex is handled by the driver when subdialog starts being driven.
   */
  async createSubDialog(
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options?: { originRole: 'user' | 'assistant'; originMemberId?: string; callId?: string },
  ): Promise<SubDialog> {
    return await this.dlgStore.createSubDialog(this, targetAgentId, headLine, callBody, options);
  }

  /**
   * Save the subdialog mutex registry to disk.
   * Uses DialogPersistence to persist the registry to registry.yaml.
   * CORRECTED: Uses 'locked' field instead of 'status'.
   */
  async saveRegistry(): Promise<void> {
    const { DialogPersistence } = await import('./persistence');
    const entries = this._subdialogMutex.getAll();
    // Convert to mutable array for persistence
    const serializableEntries = entries.map((entry) => ({
      key: entry.key,
      subdialogId: entry.subdialogId,
      createdAt: entry.createdAt,
      lastAccessedAt: entry.lastAccessedAt,
      locked: entry.locked,
    }));
    await DialogPersistence.saveRegistry(this.id, serializableEntries);
  }

  /**
   * Restore the subdialog mutex registry from disk.
   * Uses DialogPersistence to load the registry from registry.yaml.
   * Called when a RootDialog is loaded from persistence.
   * CORRECTED: Uses 'locked' field and unlock() instead of 'status' and markDone().
   */
  async restoreRegistry(): Promise<void> {
    const { DialogPersistence } = await import('./persistence');
    const entries = await DialogPersistence.loadRegistry(this.id);

    for (const entry of entries) {
      this._subdialogMutex.lock(
        entry.key.split('!')[0] ?? '',
        entry.key.split('!')[1] ?? '',
        entry.subdialogId,
      );
      // Unlock if entry was not locked
      if (!entry.locked) {
        this._subdialogMutex.unlock(entry.key.split('!')[0] ?? '', entry.key.split('!')[1] ?? '');
      }
    }
  }
}

/**
 * The UI showing a dialog in realtime
 */
export abstract class DialogStore {
  /**
   * almost certainly, the subclass should override this method to be (sub)dialog structure aware
   *
   * impl here serves for demo purpose only
   *
   * @param supdialog
   * @param targetAgentId
   * @param headLine
   * @param callBody
   * @returns
   */
  public async createSubDialog(
    supdialog: RootDialog,
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options?: { originRole: 'user' | 'assistant'; originMemberId?: string; callId?: string },
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    // For subdialogs, use the supdialog's root dialog ID as the root
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);
    return new SubDialog(supdialog, supdialog.taskDocPath, subdialogId, targetAgentId, {
      headLine,
      callBody,
      originRole: options?.originRole ?? 'assistant',
      originMemberId: options?.originMemberId,
    });
  }

  /**
   * Receive and handle LLM generation streams (FreeTextingStream, CodeBlockStream, TextingCallStream)
   */

  /**
   * Notify start of LLM generation lifecycle (generating_start_evt)
   */
  public async notifyGeneratingStart(_dialog: Dialog): Promise<void> {}

  /**
   * Notify end of LLM generation lifecycle (generating_finish_evt)
   */
  public async notifyGeneratingFinish(_dialog: Dialog): Promise<void> {}

  // Explicit phase notifications (driver-driven)
  public thinkingStart(_dialog: Dialog): void {}
  public thinkingChunk(_dialog: Dialog, _chunk: string): void {}
  public thinkingFinish(_dialog: Dialog): void {}
  public markdownStart(_dialog: Dialog): void {}
  public markdownChunk(_dialog: Dialog, _chunk: string): void {}
  public markdownFinish(_dialog: Dialog): void {}

  // Saying streaming methods (different from markdown)
  public sayingStart(_dialog: Dialog): void {}
  public sayingChunk(_dialog: Dialog, _chunk: string): void {}
  public sayingFinish(_dialog: Dialog): void {}

  public async receiveFuncResult(_dialog: Dialog, _funcResult: FuncResultMsg): Promise<void> {}
  public async receiveTextingResponse(
    _dialog: Dialog,
    _responderId: string,
    _headLine: string,
    _result: string,
    _status: 'completed' | 'failed',
    _subdialogId?: DialogID,
  ): Promise<void> {}

  /**
   * Receive tool response with callId for inline correlation
   */
  public async receiveToolResponse(
    _dialog: Dialog,
    _responderId: string,
    _headLine: string,
    _result: string,
    _status: 'completed' | 'failed',
    _callId: string,
  ): Promise<void> {}

  /**
   * Receive teammate response (separate bubble for @teammate calls)
   */
  public async receiveTeammateResponse(
    _dialog: Dialog,
    _responderId: string,
    _headLine: string,
    _result: string,
    _status: 'completed' | 'failed',
    _subdialogId?: DialogID,
  ): Promise<void> {}

  public async updateQuestions4Human(_dialog: Dialog, _questions: HumanQuestion[]): Promise<void> {}

  /**
   * Load Questions for Human state from storage
   */
  public async loadQuestions4Human(_dialogId: DialogID): Promise<HumanQuestion[]> {
    return [];
  }

  /**
   * Clear Questions for Human state in storage
   */
  public async clearQuestions4Human(_dialog: Dialog): Promise<void> {}

  // Code block streaming methods
  public async codeBlockStart(_dialog: Dialog, _infoLine?: string): Promise<void> {}
  public async codeBlockChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  public async codeBlockFinish(_dialog: Dialog, _endQuote?: string): Promise<void> {}

  // Tool call streaming methods
  public async callingStart(_dialog: Dialog, _firstMention: string): Promise<void> {}
  public async callingHeadlineChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  public async callingHeadlineFinish(_dialog: Dialog): Promise<void> {}
  public async callingBodyStart(_dialog: Dialog, _infoLine?: string): Promise<void> {}
  public async callingBodyChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  public async callingBodyFinish(_dialog: Dialog, _endQuote?: string): Promise<void> {}
  public async callingFinish(_dialog: Dialog, _callId: string): Promise<void> {}

  // Function call event (non-streaming mode - single event)
  public async funcCallRequested(
    _dialog: Dialog,
    _funcId: string,
    _funcName: string,
    _argumentsStr: string,
  ): Promise<void> {}

  /**
   * Load current round number from persisted metadata
   * This method should be implemented by subclasses to read from storage
   */
  public async loadCurrentRound(_dialogId: DialogID): Promise<number> {
    // Default implementation returns 1
    return 1;
  }

  /**
   * Get next sequence number for generation
   * This method should be implemented by subclasses for sequence allocation
   */
  public async getNextSeq(_dialogId: DialogID, _round: number): Promise<number> {
    // Default implementation returns 1
    return 1;
  }

  /**
   * Persist reminders to storage (event emission handled by processReminderUpdates)
   */
  public async persistReminders(_dialog: Dialog, _reminders: Reminder[]): Promise<void> {}

  /**
   * Persist a user message to storage
   */
  public async persistUserMessage(
    _dialog: Dialog,
    _content: string,
    _msgId: string,
  ): Promise<void> {}

  /**
   * Persist an assistant message to storage
   */
  public async persistAgentMessage(
    _dialog: Dialog,
    _content: string,
    _genseq: number,
    _type: 'thinking_msg' | 'saying_msg',
    _provider_data?: ProviderData,
  ): Promise<void> {}

  /**
   * Persist a function call to storage
   */
  public async persistFunctionCall(
    _dialog: Dialog,
    _id: string,
    _name: string,
    _arguments: StoredToolArguments,
    _genseq: number,
  ): Promise<void> {}

  /**
   * Start a new round in storage
   */
  public async startNewRound(_dialog: Dialog): Promise<void> {}

  /**
   * Handle stream error
   */
  public async streamError(_dialog: Dialog, _error: string): Promise<void> {}

  /**
   * Persist pending subdialog summaries to storage
   */
  public async persistPendingSubdialogSummaries(
    _dialog: Dialog,
    _summaries: PendingSubdialogSummary[],
  ): Promise<void> {}

  /**
   * Load pending subdialog summaries from storage
   */
  public async loadPendingSubdialogSummaries(_dialog: Dialog): Promise<PendingSubdialogSummary[]> {
    return [];
  }

  /**
   * Clear persisted pending subdialog summaries
   */
  public async clearPendingSubdialogSummaries(_dialog: Dialog): Promise<void> {}
}
