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
 * - `SubDialog` - Subdialog with root dialog reference and dynamic supdialog resolution
 */
import { inspect } from 'util';
import { postDialogEvent } from './evt-registry';
import { ChatMessage, FuncResultMsg } from './llm/client';
import { log } from './log';
import { AsyncFifoMutex } from './shared/async-fifo-mutex';
import { getWorkLanguage } from './shared/runtime-language';
import type { ContextHealthSnapshot } from './shared/types/context-health';
import type {
  DialogEvent,
  FullRemindersEvent,
  ReminderContent,
  TeammateResponseEvent,
} from './shared/types/dialog';
import type { LanguageCode } from './shared/types/language';
import type {
  DialogMetadataFile,
  HumanQuestion,
  ProviderData,
  ToolArguments as StoredToolArguments,
  UserTextGrammar,
} from './shared/types/storage';
import type { TellaskCallValidation } from './shared/types/tellask';
import { generateShortId } from './shared/utils/id';
import {
  formatAssignmentFromSupdialog,
  formatTeammateResponseContent,
} from './shared/utils/inter-dialog-format';
import { formatUnifiedTimestamp } from './shared/utils/time';
import type { JsonValue } from './tool';
import { Reminder, ReminderOwner, TellaskTool } from './tool';
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
  response: string;
  completedAt: string;
  callType: 'A' | 'B' | 'C';
}

const globalDialogMutexes: Map<string, AsyncFifoMutex> = new Map();

function getGlobalDialogMutex(dialogId: DialogID): AsyncFifoMutex {
  const key = dialogId.key();
  const existing = globalDialogMutexes.get(key);
  if (existing) return existing;
  const created = new AsyncFifoMutex();
  globalDialogMutexes.set(key, created);
  return created;
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
    contextHealth?: ContextHealthSnapshot;
  };
}

/**
 * Assignment from supdialog for subdialogs
 */
export interface AssignmentFromSup {
  headLine: string;
  callBody: string;
  originMemberId: string;
  callerDialogId: string;
  callId: string;
  collectiveTargets?: string[];
}

/**
 * Abstract base class for all dialog types.
 * Contains common properties and methods shared between RootDialog and SubDialog.
 */
export abstract class Dialog {
  public readonly dlgStore: DialogStore;

  // relative path to a specific workspace (usually .md) file,
  // used as mission/plan/progress doc of a round of a dialog
  public readonly taskDocPath: string; // Task Doc path is immutable for the dialog lifecycle

  readonly id: DialogID;
  readonly agentId: string; // team member id
  readonly reminders: Reminder[];
  readonly msgs: ChatMessage[];

  // Persistence state
  protected _currentRound: number = 1;
  protected _remindersVer: number = 0;
  protected _activeGenSeq?: number;
  protected _activeGenRound?: number;
  protected _createdAt: string;
  protected _updatedAt: string;
  protected _uiLanguage: LanguageCode;
  protected _lastUserLanguageCode: LanguageCode;
  protected _lastContextHealth?: ContextHealthSnapshot;
  // Prompt queued for the next round drive (set by startNewRound).
  protected _upNext?: { prompt: string; msgId: string; userLanguageCode?: LanguageCode };
  // Track whether the current round's initial events (user_text, generating_start)
  // have been fully processed. Used to ensure subdialog_final_response_evt arrives
  // only after parent events are emitted.
  protected _generationStarted: boolean = false;
  // Track the generation sequence when _generationStarted was set
  // Used to ensure proper ordering when multiple generations occur
  protected _generationStartedGenseq: number = 0;

  // Pending subdialog IDs (for auto-revive tracking)
  protected _pendingSubdialogIds: DialogID[] = [];

  // Phase 11: Suspension state for Type A subdialog mechanism
  // Tracks whether this dialog is in normal state, suspended, or resuming from suspension
  protected _suspensionState: 'active' | 'suspended' | 'resumed' = 'active';

  // Keep-going (diligence auto-continue) budget counter (runtime-only).
  // Intentionally not persisted: this is a per-process safety valve, not dialog state.
  public diligenceAutoContinueCount: number = 0;

  private readonly _mutex: AsyncFifoMutex;

  // Current callId for tellask tool-call correlation
  // - Set during tool_call_finish_evt (from TellaskStreamParser)
  // - Retrieved during tool response (for receiveToolResponse callId parameter)
  // - Enables frontend to attach result INLINE to the calling section
  // - NOT used for teammate calls (which use calleeDialogId instead)
  protected _currentCallId: string | null = null;

  constructor(
    dlgStore: DialogStore,
    taskDocPath: string,
    id: DialogID | undefined,
    agentId: string,
    initialState?: DialogInitParams['initialState'],
  ) {
    // Validate required parameters
    if (!taskDocPath || taskDocPath.trim() === '') {
      throw new Error('Task Doc path is required for creating a dialog');
    }

    this.dlgStore = dlgStore;
    this.taskDocPath = taskDocPath.trim();
    if (id === undefined) {
      const generatedId = generateDialogID();
      id = new DialogID(generatedId);
    }
    this.id = id;
    this._mutex = getGlobalDialogMutex(this.id);
    this.agentId = agentId;
    this.reminders = initialState?.reminders || [];
    this.msgs = initialState?.messages || [];

    // Initialize persistence state
    const now = formatUnifiedTimestamp(new Date());
    this._createdAt = initialState?.createdAt || now;
    this._updatedAt = initialState?.updatedAt || now;
    this._currentRound = initialState?.currentRound || 1;
    this._uiLanguage = getWorkLanguage();
    this._lastUserLanguageCode = getWorkLanguage();
    this._lastContextHealth = initialState?.contextHealth;
  }

  public setLastContextHealth(snapshot: ContextHealthSnapshot): void {
    this._lastContextHealth = snapshot;
  }

  public getLastContextHealth(): ContextHealthSnapshot | undefined {
    return this._lastContextHealth;
  }

  public get remindersVer() {
    return this._remindersVer;
  }

  public get supdialog(): Dialog | undefined {
    return undefined;
  }

  public getUiLanguage(): LanguageCode {
    return this._uiLanguage;
  }

  public setUiLanguage(language: LanguageCode): void {
    this._uiLanguage = language;
  }

  public getLastUserLanguageCode(): LanguageCode {
    return this._lastUserLanguageCode;
  }

  public setLastUserLanguageCode(language: LanguageCode): void {
    this._lastUserLanguageCode = language;
  }

  /**
   * Get the current callId for tool-call correlation
   *
   * Call Types:
   * - Tool Call (`!?@tool_name`): callId is set during tool_call_start_evt, used for inline result
   * - Teammate Call (@agentName): Uses calleeDialogId, not callId
   *
   * @returns The current callId for tool correlation, or null if no active tool call
   */
  public getCurrentCallId(): string | null {
    return this._currentCallId;
  }

  /**
   * Set the current callId (called during tool_call_finish_evt for tool calls)
   *
   * @param callId - The correlation ID from TellaskEventsReceiver.callFinish()
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

  /**
   * Acquire the dialog mutex. Returns a release callback.
   * FIFO queue ensures fairness when multiple callers wait.
   */
  public async acquire(): Promise<() => void> {
    return await this._mutex.acquire();
  }

  /**
   * Check if the dialog mutex is currently locked.
   */
  public isLocked(): boolean {
    return this._mutex.isLocked();
  }

  /**
   * Check if dialog has pending Q4H questions.
   * Queries persistence for current questions4Human state.
   */
  public async hasPendingQ4H(): Promise<boolean> {
    try {
      const questions = await this.dlgStore.loadQuestions4Human(this.id, this.status);
      return questions.length > 0;
    } catch (err) {
      log.warn('Failed to load Q4H state for pending check', {
        dialogId: this.id.selfId,
        error: err,
      });
      return true;
    }
  }

  /**
   * Check if dialog has pending subdialogs.
   */
  public async hasPendingSubdialogs(): Promise<boolean> {
    try {
      const pending = await this.dlgStore.loadPendingSubdialogs(this.id, this.status);
      return pending.length > 0;
    } catch (err) {
      log.warn('Failed to load pending subdialogs for pending check', {
        dialogId: this.id.selfId,
        error: err,
      });
      return true;
    }
  }

  /**
   * Check if dialog can be driven (not suspended for Q4H or subdialogs).
   */
  public async canDrive(): Promise<boolean> {
    const hasQ4H = await this.hasPendingQ4H();
    const hasSubdialogs = await this.hasPendingSubdialogs();
    return !hasQ4H && !hasSubdialogs;
  }

  /**
   * Get suspension status for logging/debugging.
   */
  public async getSuspensionStatus(): Promise<{
    q4h: boolean;
    subdialogs: boolean;
    canDrive: boolean;
  }> {
    const hasQ4H = await this.hasPendingQ4H();
    const hasSubdialogs = await this.hasPendingSubdialogs();
    return {
      q4h: hasQ4H,
      subdialogs: hasSubdialogs,
      canDrive: !hasQ4H && !hasSubdialogs,
    };
  }

  public get pendingSubdialogIds(): ReadonlyArray<DialogID> {
    return this._pendingSubdialogIds;
  }

  public addPendingSubdialogs(ids: DialogID[]): void {
    this._pendingSubdialogIds.push(...ids);
  }

  public removePendingSubdialog(id: DialogID): void {
    this._pendingSubdialogIds = this._pendingSubdialogIds.filter(
      (pending) => pending.selfId !== id.selfId,
    );
  }

  public clearPendingSubdialogs(): void {
    this._pendingSubdialogIds = [];
  }

  /**
   * Load pending subdialogs from persistence into memory.
   * Used during crash recovery to restore suspension state.
   */
  public async loadPendingSubdialogsFromPersistence(): Promise<void> {
    try {
      const pending = await this.dlgStore.loadPendingSubdialogs(this.id, this.status);
      this.clearPendingSubdialogs();
      this.addPendingSubdialogs(pending.map((record) => record.subdialogId));
    } catch (err) {
      log.warn('Failed to load pending subdialogs from persistence', {
        dialogId: this.id.selfId,
        error: err,
      });
    }
  }

  /**
   * Abstract method for creating subdialogs.
   * Implemented by RootDialog to create SubDialog instances.
   */
  abstract createSubDialog(
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
      collectiveTargets?: string[];
    },
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

    // Centralized persistence - called when emitting event.
    // Must be awaited to avoid overlapping writes (reminders.json.tmp rename races).
    try {
      await this.dlgStore.persistReminders(this, this.reminders);
    } catch (err) {
      log.warn('Failed to persist reminders', err, { dialogId: this.id.valueOf() });
    }

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
   * Applies access control: !?@change_mind is only available to main dialog agents.
   */
  public getIntrinsicTools(): TellaskTool[] {
    const baseTools: TellaskTool[] = [
      addReminderTool,
      deleteReminderTool,
      updateReminderTool,
      clearMindTool,
    ];

    // !?@change_mind is only available to main dialog agents (not subdialogs)
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
- !?@add_reminder: Capture important insights, decisions, or next steps that should persist beyond conversation cleanup
- !?@update_reminder: Refine your understanding as situations evolve or new information emerges  
- !?@delete_reminder: Remove completed or obsolete reminders to keep your focus sharp
- !?@clear_mind: Achieve mental clarity by clearing conversational noise while preserving your reminders and task focus

**Task Context Control:**`;

    if (this.supdialog) {
      // Find main dialog (root dialog) by traversing up the supdialog chain
      let rootDialog = this.supdialog;
      while (rootDialog.supdialog) {
        rootDialog = rootDialog.supdialog;
      }

      // Subdialog restrictions
      instructions += `
- !?@clear_mind: Restart this subdialog with a clean slate, focusing your attention on the task document and any specific reminder you provide. This clears conversational noise while preserving your reminders and supdialog-call context.
- !?@change_mind: **Not available in subdialogs.** If you need to change the overall task context or direction, communicate with the main dialog agent (@${rootDialog.agentId}) and ask them to use !?@change_mind instead.

**Subdialog Guidelines:**
You're operating in a subdialog, which means you're focused on a specific subtask. Your memory and context are scoped to this particular conversation thread. When you complete your subtask or need to escalate decisions, communicate back to the supdialog.`;
    } else {
      // Main dialog capabilities
      instructions += `
- !?@clear_mind: Restart the conversation with a clean slate, focusing your attention on the task document and any specific reminder you provide. This clears conversational noise while preserving your reminders.
- !?@change_mind: Update the shared Task Doc content for this dialog tree (no round reset). This affects all participant agents (yourself and any subdialog agents). For Task Docs (\`*.tsk/\`), each !?@change_mind call MUST target exactly one section: \`!?@change_mind !goals\` / \`!constraints\` / \`!progress\`. You may issue multiple !?@change_mind calls in a single message to update multiple sections.

**Main Dialog Responsibilities:**
You're the primary dialog agent. You can create subdialogs for specialized tasks, manage the overall conversation flow, and make high-level decisions about task direction and approach.`;
    }

    instructions += `

**Best Practices:**
- **Maintain Mental Clarity:** When conversations become cluttered with debugging, repeated failures, or tangential discussions, use !?@clear_mind to refocus on what matters
- **Strategic Reminders:** Capture key insights, decisions, and next steps in reminders before clearing your mind - they'll persist and guide your refreshed focus
- **Task Document Focus:** Keep the task document authoritative (goals / constraints / progress). Use !?@change_mind to update it explicitly; use !?@clear_mind when you need a new round.
- **Proactive Clarity:** Don't wait for conversations to become overwhelming - clear your mind proactively when you sense attention fragmentation
- **Context Preservation:** Remember that clearing your mind preserves reminders and (for subdialogs) supdialog-call information - you lose chat noise, not important context
- **Strategic Pivots:** Use !?@change_mind when requirements evolve or you need to adjust constraints/progress; it updates the shared task document for all agents immediately.`;

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
  public abstract get status(): 'running' | 'completed' | 'archived';

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

  public get activeGenRoundOrUndefined(): number | undefined {
    return this._activeGenRound;
  }

  /**
   * Check if generation has started for the current round.
   * Used to ensure subdialog_final_response_evt arrives after parent events.
   */
  public get generationStarted(): boolean {
    return this._generationStarted;
  }

  /**
   * Mark generation as started (after user_text event has been emitted).
   * This ensures subdialog_final_response_evt waits for this signal.
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

  private setUpNextPrompt(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new Error('newRoundPrompt is required to start a new round');
    }
    this._upNext = {
      prompt: trimmed,
      msgId: generateShortId(),
      userLanguageCode: this._lastUserLanguageCode,
    };
  }

  public hasUpNext(): boolean {
    return this._upNext !== undefined;
  }

  public takeUpNext():
    | { prompt: string; msgId: string; userLanguageCode?: LanguageCode }
    | undefined {
    const next = this._upNext;
    this._upNext = undefined;
    return next;
  }

  /**
   * Start a new round - clears conversational noise, Q4H, and increments round counter.
   * Queues a new-round prompt for the driver to consume on the next drive cycle.
   * This is the single entry point for mental clarity operations (!?@clear_mind, !?@change_mind).
   */
  public async startNewRound(newRoundPrompt: string): Promise<void> {
    const trimmedPrompt = newRoundPrompt.trim();
    if (!trimmedPrompt) {
      throw new Error('newRoundPrompt is required to start a new round');
    }

    // Clear all messages and Q4H questions for mental clarity
    this.msgs.length = 0;

    await this.dlgStore.clearQuestions4Human(this);

    // Delegate to DialogStore for round start persistence
    if (this.dlgStore) {
      await this.dlgStore.startNewRound(this, trimmedPrompt);
    }

    const storeRound = this.dlgStore
      ? await this.dlgStore.loadCurrentRound(this.id)
      : this._currentRound + 1;
    this._currentRound = storeRound;
    this._updatedAt = formatUnifiedTimestamp(new Date());

    // Principle: user should see what the model sees.
    // For subdialogs, include the original supdialog assignment together with the new-round prompt
    // as the first user message in the new round (persisted by the driver).
    const combinedPrompt =
      this instanceof SubDialog
        ? `${formatAssignmentFromSupdialog({
            fromAgentId: this.assignmentFromSup.originMemberId,
            toAgentId: this.agentId,
            headLine: this.assignmentFromSup.headLine,
            callBody: this.assignmentFromSup.callBody,
            language: getWorkLanguage(),
            collectiveTargets: this.assignmentFromSup.collectiveTargets ?? [this.agentId],
          })}\n---\n${trimmedPrompt}`
        : trimmedPrompt;
    this.setUpNextPrompt(combinedPrompt);
  }

  // Proxy methods for DialogStore - route calls through dialog object instead of direct dlgStore access
  public async receiveFuncResult(result: FuncResultMsg): Promise<void> {
    return await this.dlgStore.receiveFuncResult(this, result);
  }

  public async notifyGeneratingStart(): Promise<void> {
    // Capture the generation's starting round so any events emitted during this generation
    // remain attributed to the correct round even if a tool mutates dialog.currentRound
    // mid-generation (e.g., !?@clear_mind).
    this._activeGenRound = this.currentRound;
    if (typeof this._activeGenSeq === 'number') {
      this._activeGenSeq++;
    } else {
      // Get next sequence number from store
      const genseq = await this.dlgStore.getNextSeq(this.id, this.currentRound);
      this._activeGenSeq = genseq;
    }

    // Mark generation as started with the actual genseq
    // This ensures subdialog_final_response_evt waits for both user_text and generating_start_evt
    this.markGenerationStarted();

    await this.dlgStore.notifyGeneratingStart(this);
  }

  public async notifyGeneratingFinish(contextHealth?: ContextHealthSnapshot): Promise<void> {
    if (contextHealth) {
      this._lastContextHealth = contextHealth;
    }
    try {
      await this.dlgStore.notifyGeneratingFinish(this, contextHealth);
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
    this._activeGenRound = undefined;
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

  // Function call events (non-streaming mode - single event captures entire call)
  public async funcCallRequested(
    funcId: string,
    funcName: string,
    argumentsStr: string,
  ): Promise<void> {
    await this.dlgStore.funcCallRequested(this, funcId, funcName, argumentsStr);
  }

  // Tellask call events (streaming mode - `!?@...` blocks)
  public async callingStart(validation: TellaskCallValidation): Promise<void> {
    await this.dlgStore.callingStart(this, validation);
  }

  public async callingHeadlineChunk(chunk: string): Promise<void> {
    await this.dlgStore.callingHeadlineChunk(this, chunk);
  }

  public async callingHeadlineFinish(): Promise<void> {
    await this.dlgStore.callingHeadlineFinish(this);
  }

  public async callingBodyStart(): Promise<void> {
    await this.dlgStore.callingBodyStart(this);
  }

  public async callingBodyChunk(chunk: string): Promise<void> {
    await this.dlgStore.callingBodyChunk(this, chunk);
  }

  public async callingBodyFinish(): Promise<void> {
    await this.dlgStore.callingBodyFinish(this);
  }

  public async callingFinish(callId: string): Promise<void> {
    // Store callId for tool call correlation
    this.setCurrentCallId(callId);
    await this.dlgStore.callingFinish(this, callId);
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
    status: 'completed' | 'failed',
    subdialogId: DialogID | undefined,
    options: {
      response: string;
      agentId: string;
      callId: string;
      originMemberId: string;
    },
  ): Promise<void> {
    return await this.dlgStore.receiveTeammateResponse(
      this,
      responderId,
      headLine,
      status,
      subdialogId,
      options,
    );
  }

  public async updateQuestions4Human(questions: HumanQuestion[]): Promise<void> {
    return await this.dlgStore.updateQuestions4Human(this, questions);
  }

  public async persistUserMessage(
    content: string,
    msgId: string,
    grammar: UserTextGrammar,
    userLanguageCode?: LanguageCode,
  ): Promise<void> {
    return await this.dlgStore.persistUserMessage(this, content, msgId, grammar, userLanguageCode);
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
   * Post subdialog completion response to this dialog.
   * Phase 14: No wait - emit immediately with virtual gen markers for Type C subdialogs
   */
  public async postSubdialogResponse(subdialogId: DialogID, response: string): Promise<void> {
    try {
      let responderId = subdialogId.rootId;
      let responderAgentId: string | undefined;
      let headLine = response;
      let originMemberId = responderId;
      let callId = '';
      try {
        const metadata = await this.dlgStore.loadDialogMetadata(subdialogId, 'running');
        if (metadata) {
          if (metadata.agentId) {
            responderId = metadata.agentId;
            responderAgentId = metadata.agentId;
            originMemberId = metadata.agentId;
          }
          if (metadata.assignmentFromSup) {
            headLine = metadata.assignmentFromSup.headLine;
            originMemberId = metadata.assignmentFromSup.originMemberId;
            callId = metadata.assignmentFromSup.callId;
          }
        }
      } catch (err) {
        log.warn('Failed to load subdialog metadata for response labeling', {
          dialogId: this.id.selfId,
          subdialogId: subdialogId.selfId,
          error: err,
        });
      }
      if (callId.trim() === '') {
        log.warn('Missing callId for subdialog response', undefined, {
          dialogId: this.id.selfId,
          subdialogId: subdialogId.selfId,
        });
      }
      if (headLine.trim() === '') {
        headLine = response;
      }

      // NO WAIT - emit immediately with virtual gen markers

      // Emit virtual generating_start_evt for subdialog response bubble
      await this.notifyGeneratingStart();

      const formattedResult = formatTeammateResponseContent({
        responderId,
        requesterId: originMemberId,
        originalCallHeadLine: headLine,
        responseBody: response,
        language: getWorkLanguage(),
      });

      // Emit TeammateResponseEvent
      const evt: TeammateResponseEvent = {
        type: 'teammate_response_evt',
        responderId,
        calleeDialogId: subdialogId.selfId,
        headLine,
        status: 'completed',
        result: formattedResult,
        round: this.currentRound,
        response,
        agentId: responderAgentId ?? responderId,
        callId,
        originMemberId,
      };
      postDialogEvent(this, evt);

      // Emit virtual generating_finish_evt
      await this.notifyGeneratingFinish();
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
 * Stores the root dialog for registry and lookup, and resolves its effective supdialog dynamically.
 */
export class SubDialog extends Dialog {
  public readonly rootDialog: RootDialog;
  public readonly topicId?: string;
  public assignmentFromSup: AssignmentFromSup;
  protected readonly _supdialog: Dialog;

  constructor(
    dlgStore: DialogStore,
    rootDialog: RootDialog,
    taskDocPath: string,
    id: DialogID | undefined,
    agentId: string,
    assignmentFromSup: AssignmentFromSup,
    topicId?: string,
    initialState?: DialogInitParams['initialState'],
  ) {
    super(dlgStore, taskDocPath, id, agentId, initialState);
    this.rootDialog = rootDialog;
    this.topicId = topicId;
    this.assignmentFromSup = assignmentFromSup;
    const resolvedSupdialog = rootDialog.lookupDialog(assignmentFromSup.callerDialogId);
    if (resolvedSupdialog && resolvedSupdialog.id.selfId === this.id.selfId) {
      log.warn(
        'SubDialog assignmentFromSup.callerDialogId resolved to self; falling back to root',
        {
          dialogId: this.id.selfId,
          callerDialogId: assignmentFromSup.callerDialogId,
        },
      );
      this._supdialog = rootDialog;
    } else if (resolvedSupdialog) {
      this._supdialog = resolvedSupdialog;
    } else {
      // If we can't resolve the caller dialog in the in-memory registry, fall back to root.
      // This can happen when restoring a dialog tree without restoring the full parent chain.
      log.warn(
        'SubDialog failed to resolve callerDialogId in root registry; falling back to root',
        {
          dialogId: this.id.selfId,
          callerDialogId: assignmentFromSup.callerDialogId,
          rootId: rootDialog.id.rootId,
        },
      );
      this._supdialog = rootDialog;
    }
    this.rootDialog.registerDialog(this);
  }

  public override get supdialog(): Dialog {
    return this._supdialog;
  }

  public override get status(): 'running' | 'completed' | 'archived' {
    return this.rootDialog.status;
  }

  /**
   * Create a subdialog under the same root dialog tree.
   * The new subdialog's effective supdialog is resolved via AssignmentFromSup.callerDialogId.
   */
  async createSubDialog(
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
      collectiveTargets?: string[];
    },
  ): Promise<SubDialog> {
    return await this.rootDialog.createSubDialog(targetAgentId, headLine, callBody, options);
  }
}

/**
 * RootDialog - The main/root dialog that can create and manage subdialogs.
 * Uses in-memory registries for O(1) dialog and Type B lookup.
 */
export class RootDialog extends Dialog {
  private _status: 'running' | 'completed' | 'archived' = 'running';

  // Tracks all dialogs in this dialog tree for O(1) lookup
  private _localRegistry: Map<string, Dialog> = new Map();
  // Tracks TYPE B registered subdialogs by agentId!topicId
  private _subdialogRegistry: Map<string, SubDialog> = new Map();

  constructor(
    dlgStore: DialogStore,
    taskDocPath: string,
    id: DialogID | undefined,
    agentId: string,
    initialState?: DialogInitParams['initialState'],
  ) {
    super(dlgStore, taskDocPath, id, agentId, initialState);
    this.registerDialog(this);
  }

  public override get status(): 'running' | 'completed' | 'archived' {
    return this._status;
  }

  public setPersistenceStatus(status: 'running' | 'completed' | 'archived'): void {
    this._status = status;
  }

  /**
   * Register a dialog (self or subdialog) in the local registry.
   */
  registerDialog(dialog: Dialog): void {
    this._localRegistry.set(dialog.id.selfId, dialog);
  }

  /**
   * Lookup a dialog by selfId in the local registry.
   */
  lookupDialog(selfId: string): Dialog | undefined {
    return this._localRegistry.get(selfId);
  }

  /**
   * Get all registered dialogs in this dialog tree.
   */
  getAllDialogs(): Dialog[] {
    return Array.from(this._localRegistry.values());
  }

  /**
   * Remove a dialog from the local registry.
   */
  unregisterDialog(selfId: string): void {
    this._localRegistry.delete(selfId);
  }

  /**
   * Generate a registry key from agentId and topicId.
   */
  static makeSubdialogKey(agentId: string, topicId: string): string {
    return `${agentId}!${topicId}`;
  }

  /**
   * Register a TYPE B subdialog for resumption.
   */
  registerSubdialog(subdialog: SubDialog): void {
    if (!subdialog.topicId) {
      return;
    }
    const key = RootDialog.makeSubdialogKey(subdialog.agentId, subdialog.topicId);
    this._subdialogRegistry.set(key, subdialog);
    this.registerDialog(subdialog);
  }

  /**
   * Lookup a TYPE B subdialog by agentId and topicId.
   */
  lookupSubdialog(agentId: string, topicId: string): SubDialog | undefined {
    const key = RootDialog.makeSubdialogKey(agentId, topicId);
    return this._subdialogRegistry.get(key);
  }

  /**
   * Remove a TYPE B subdialog from registry.
   */
  unregisterSubdialog(agentId: string, topicId: string): boolean {
    const key = RootDialog.makeSubdialogKey(agentId, topicId);
    const subdialog = this._subdialogRegistry.get(key);
    if (subdialog) {
      this._localRegistry.delete(subdialog.id.selfId);
      return this._subdialogRegistry.delete(key);
    }
    return false;
  }

  /**
   * Get all registered subdialogs.
   */
  getRegisteredSubdialogs(): SubDialog[] {
    return Array.from(this._subdialogRegistry.values());
  }

  /**
   * Create a new subdialog for autonomous teammate calls.
   */
  async createSubDialog(
    targetAgentId: string,
    headLine: string,
    callBody: string,
    options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
      collectiveTargets?: string[];
    },
  ): Promise<SubDialog> {
    return await this.dlgStore.createSubDialog(this, targetAgentId, headLine, callBody, options);
  }

  /**
   * Save subdialog registry to disk (registry.yaml).
   */
  async saveSubdialogRegistry(): Promise<void> {
    const entries = Array.from(this._subdialogRegistry.entries()).map(([key, subdialog]) => ({
      key,
      subdialogId: subdialog.id,
      agentId: subdialog.agentId,
      topicId: subdialog.topicId,
    }));
    await this.dlgStore.saveSubdialogRegistry(this.id, entries, this.status);
  }

  /**
   * Load subdialog registry from disk (registry.yaml).
   */
  async loadSubdialogRegistry(): Promise<void> {
    await this.dlgStore.loadSubdialogRegistry(this, this.status);
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
    options: {
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      topicId?: string;
      collectiveTargets?: string[];
    },
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    // For subdialogs, use the supdialog's root dialog ID as the root
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);
    return new SubDialog(
      this,
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
        collectiveTargets: options.collectiveTargets,
      },
      options.topicId,
    );
  }

  /**
   * Receive and handle LLM generation streams (Markdown stream + tellask call stream)
   */

  /**
   * Notify start of LLM generation lifecycle (generating_start_evt)
   */
  public async notifyGeneratingStart(_dialog: Dialog): Promise<void> {}

  /**
   * Notify end of LLM generation lifecycle (generating_finish_evt)
   */
  public async notifyGeneratingFinish(
    _dialog: Dialog,
    _contextHealth?: ContextHealthSnapshot,
  ): Promise<void> {}

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
    _status: 'completed' | 'failed',
    _subdialogId: DialogID | undefined,
    _options: {
      response: string;
      agentId: string;
      callId: string;
      originMemberId: string;
    },
  ): Promise<void> {}

  public async updateQuestions4Human(_dialog: Dialog, _questions: HumanQuestion[]): Promise<void> {}

  /**
   * Load Questions for Human state from storage
   */
  public async loadQuestions4Human(
    _dialogId: DialogID,
    _status: 'running' | 'completed' | 'archived',
  ): Promise<HumanQuestion[]> {
    return [];
  }

  public async loadDialogMetadata(
    _dialogId: DialogID,
    _status: 'running' | 'completed' | 'archived',
  ): Promise<DialogMetadataFile | null> {
    return null;
  }

  public async loadPendingSubdialogs(
    _dialogId: DialogID,
    _status: 'running' | 'completed' | 'archived',
  ): Promise<PendingSubdialog[]> {
    return [];
  }

  public async saveSubdialogRegistry(
    _rootDialogId: DialogID,
    _entries: Array<{
      key: string;
      subdialogId: DialogID;
      agentId: string;
      topicId?: string;
    }>,
    _status: 'running' | 'completed' | 'archived',
  ): Promise<void> {}

  public async loadSubdialogRegistry(
    _rootDialog: RootDialog,
    _status: 'running' | 'completed' | 'archived',
  ): Promise<void> {}

  /**
   * Clear Questions for Human state in storage
   */
  public async clearQuestions4Human(_dialog: Dialog): Promise<void> {}

  // Tellask call streaming methods
  public async callingStart(_dialog: Dialog, _validation: TellaskCallValidation): Promise<void> {}
  public async callingHeadlineChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  public async callingHeadlineFinish(_dialog: Dialog): Promise<void> {}
  public async callingBodyStart(_dialog: Dialog): Promise<void> {}
  public async callingBodyChunk(_dialog: Dialog, _chunk: string): Promise<void> {}
  public async callingBodyFinish(_dialog: Dialog): Promise<void> {}
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
    _grammar: UserTextGrammar,
    _userLanguageCode?: LanguageCode,
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
  public async startNewRound(_dialog: Dialog, _newRoundPrompt: string): Promise<void> {}

  /**
   * Handle stream error
   */
  public async streamError(_dialog: Dialog, _error: string): Promise<void> {}
}
