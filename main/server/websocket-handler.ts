/**
 * Module: server/websocket-handler
 *
 * Common WebSocket handling functionality for dialog communication
 */
import type { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { Dialog, DialogID, RootDialog, SubDialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { dialogEventRegistry, postDialogEvent } from '../evt-registry';
import { driveDialogStream } from '../llm/driver';
import { createLogger } from '../log';
import { DialogPersistence, DiskFileDialogStore } from '../persistence';
import { EndOfStream } from '../shared/evt';
import type {
  CreateDialogRequest,
  DialogReadyMessage,
  DisplayDialogRequest,
  DisplayRemindersRequest,
  DisplayRoundRequest,
  DriveDialogByUserAnswer,
  DriveDialogRequest,
  GetQ4HStateRequest,
  Q4HStateResponse,
  WebSocketMessage,
} from '../shared/types';
import type { Q4HAnsweredEvent } from '../shared/types/dialog';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import { generateDialogID } from '../utils/id';

const log = createLogger('websocket-handler');

const wsLiveDlg = new WeakMap<WebSocket, Dialog>();

/**
 * Get error code from unknown error
 */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

/**
 * Restores the parent (supdialog) dialog from persistence.
 * Used when a subdialog needs access to its parent for metadata or registry operations.
 */
async function restoreParentDialog(
  subdialogSelfId: string,
  rootDialogId: string,
): Promise<RootDialog | undefined> {
  const parentIdObj = new DialogID(subdialogSelfId, rootDialogId);

  const parentMetadata = await DialogPersistence.loadDialogMetadata(parentIdObj, 'running');
  if (!parentMetadata) {
    log.debug('Parent dialog metadata not found', undefined, { parentId: subdialogSelfId });
    return undefined;
  }

  const parentState = await DialogPersistence.restoreDialog(parentIdObj, 'running');
  if (!parentState) {
    log.debug('Parent dialog state not found', undefined, { parentId: subdialogSelfId });
    return undefined;
  }

  const parentStore = new DiskFileDialogStore(parentIdObj);
  const parentDialog = new RootDialog(
    parentStore,
    parentMetadata.taskDocPath,
    parentIdObj,
    parentMetadata.agentId,
    {
      messages: parentState.messages,
      reminders: parentState.reminders,
      currentRound: parentState.currentRound,
    },
  );
  globalDialogRegistry.register(parentDialog);
  // Restore TYPE B subdialog registry from disk for parent-call detection
  await parentDialog.loadSubdialogRegistry();
  await parentDialog.loadPendingSubdialogsFromPersistence();
  return parentDialog;
}

/**
 * Cleanup WebSocket client: cancel active forwarder and clear live dialog state
 */
function cleanupWsClient(ws: WebSocket): void {
  const live = wsLiveDlg.get(ws);
  if (live) {
    try {
      live.subChan?.cancel();
    } catch (err) {
      log.warn('Failed to cancel forwarder on cleanupWsClient', err);
    }
    wsLiveDlg.delete(ws);
  }
}

/**
 * Setup WebSocket subscription for real-time dialog events
 * Ensures only one subscription per WebSocket connection
 */
async function setupWebSocketSubscription(ws: WebSocket, dialog: Dialog): Promise<void> {
  // Cancel any existing subscription
  const existingDialog = wsLiveDlg.get(ws);
  if (existingDialog && existingDialog.subChan) {
    try {
      existingDialog.subChan.cancel();
    } catch (err) {
      log.warn('Failed to cancel existing subscription', undefined, err);
    }
  }

  // Store dialog in wsLiveDlg
  wsLiveDlg.set(ws, dialog);

  // Create new subscription for real-time events
  const subChan = dialogEventRegistry.createSubChan(dialog.id);
  dialog.subChan = subChan;

  // Forward events from SubChan to WebSocket
  (async () => {
    try {
      for await (const event of subChan.stream()) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(event));
        } else {
          break;
        }
      }
    } catch (err: unknown) {
      if (err !== EndOfStream) {
        log.warn(`Event forwarding error for dialog ${dialog.id.selfId}:`, err);
      }
    }
  })().catch((err: unknown) => {
    log.warn(`Event forwarding task failed for dialog ${dialog.id.selfId}:`, err);
  });
}

/**
 * Handle incoming WebSocket messages
 */
export async function handleWebSocketMessage(
  ws: WebSocket,
  packet: WebSocketMessage,
): Promise<void> {
  try {
    switch (packet.type) {
      case 'create_dialog':
        await handleCreateDialog(ws, packet);
        break;

      case 'display_dialog':
        await handleDisplayDialog(ws, packet);
        break;

      case 'get_q4h_state':
        await handleGetQ4HState(ws, packet);
        break;

      case 'display_reminders':
        await handleDisplayReminders(ws, packet);
        break;

      case 'display_round':
        await handleDisplayRound(ws, packet);
        break;

      case 'drive_dlg_by_user_msg':
        await handleUserMsg2Dlg(ws, packet);
        break;

      case 'drive_dialog_by_user_answer':
        await handleUserAnswer2Q4H(ws, packet);
        break;

      default:
        log.warn('Unknown WebSocket packet type:', undefined, packet.type);
        ws.send(
          JSON.stringify({
            type: 'error',
            error: `Unknown packet type: ${packet.type}`,
          }),
        );
    }
  } catch (error) {
    log.error('Error processing WebSocket packet:', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
  }
}

/**
 * Handle dialog creation via WebSocket
 */
async function handleCreateDialog(ws: WebSocket, packet: CreateDialogRequest): Promise<void> {
  try {
    const { agentId, taskDocPath } = packet;

    // Validate that taskDocPath is provided (it's now mandatory)
    if (!taskDocPath || taskDocPath.trim() === '') {
      throw new Error('Task document path is required for creating a dialog');
    }

    // Auto-fill default_responder if no agentId provided
    let finalAgentId = agentId;
    if (!finalAgentId) {
      try {
        const teamConfig = await Team.load();
        finalAgentId = teamConfig.defaultResponder;

        if (!finalAgentId) {
          throw new Error('No default_responder configured in team.yaml');
        }
      } catch (error) {
        throw new Error(
          `Failed to load team configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    const generatedId = generateDialogID();
    // For root dialogs, self and root are the same
    const dialogId = new DialogID(generatedId);

    // Import Dialog and DiskFileDialogStore

    // Create DiskFileDialogStore for file-based persistence
    const dialogUI = new DiskFileDialogStore(dialogId);

    // Create RootDialog instance with the new store
    const dialog = new RootDialog(dialogUI, taskDocPath, dialogId, finalAgentId);
    globalDialogRegistry.register(dialog);
    // Setup WebSocket subscription for real-time events
    await setupWebSocketSubscription(ws, dialog);

    // Persist dialog metadata and latest.yaml (write-once pattern)
    const metadata = {
      id: dialogId.selfId,
      agentId: finalAgentId,
      taskDocPath: taskDocPath,
      createdAt: formatUnifiedTimestamp(new Date()),
    };
    await DialogPersistence.saveDialogMetadata(new DialogID(dialogId.selfId), metadata);

    // Create initial latest.yaml with current round and lastModified info
    await DialogPersistence.saveDialogLatest(new DialogID(dialogId.selfId), {
      currentRound: 1,
      lastModified: formatUnifiedTimestamp(new Date()),
      status: 'active',
      messageCount: 0,
      functionCallCount: 0,
      subdialogCount: 0,
    });

    // Send dialog_ready with full info so frontend can track the active dialog
    const response: DialogReadyMessage = {
      type: 'dialog_ready',
      dialog: {
        selfId: dialogId.selfId,
        rootId: dialogId.rootId,
      },
      agentId: finalAgentId,
      taskDocPath: taskDocPath,
    };
    ws.send(JSON.stringify(response));
  } catch (error) {
    log.warn('Failed to create dialog', undefined, error);
    ws.send(
      JSON.stringify({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error creating dialog',
      }),
    );
  }
}

/**
 * Handle dialog retrieval via WebSocket
 */
async function handleDisplayDialog(ws: WebSocket, packet: DisplayDialogRequest): Promise<void> {
  try {
    const { dialog: dialogIdent } = packet;

    if (!dialogIdent) {
      throw new Error('dialog is required');
    }

    // Extract dialog ID from DialogIdent
    let dialogId = dialogIdent.selfId;
    let rootDialogId = dialogIdent.rootId;

    // Handle case where dialogIdent properties might be objects instead of strings
    if (typeof dialogId !== 'string' || typeof rootDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: 'Invalid dialog identifiers for display_dialog: selfId/rootId must be strings',
        }),
      );
      return;
    }

    // IMPORTANT: cancel any existing event forwarder before emitting restoration events.
    // Otherwise, the same client can receive overlapping "replay" and "live" streams,
    // which surfaces as duplicate generation lifecycle events on the frontend.
    const existing = wsLiveDlg.get(ws);
    if (existing && existing.subChan) {
      const existingId = existing.id;
      const isSameDialog = existingId.selfId === dialogId && existingId.rootId === rootDialogId;
      if (isSameDialog) {
        log.warn(
          'display_dialog: refreshing the same dialog; cancelling existing subscription to prevent duplicate stream events',
          undefined,
          { dialogId, rootDialogId },
        );
      } else {
        log.debug(
          'display_dialog: switching dialogs; cancelling previous subscription',
          undefined,
          {
            previousDialogId: existingId.valueOf(),
            nextDialogId: new DialogID(dialogId, rootDialogId).valueOf(),
          },
        );
      }
      cleanupWsClient(ws);
    }

    // Use DialogPersistence to load dialog from file system
    // CRITICAL FIX: Use dialogId (not rootDialogId) to load the correct dialog/subdialog events
    // For subdialogs, this ensures we load events from subdialog's own round file, not parent's
    const dialogState = await DialogPersistence.restoreDialog(
      new DialogID(dialogId, rootDialogId),
      'running',
    );

    if (!dialogState) {
      throw new Error('Dialog not found');
    }

    // Load metadata
    const metadata = await DialogPersistence.loadDialogMetadata(
      new DialogID(dialogId, rootDialogId),
      'running',
    );
    if (!metadata) {
      throw new Error('Dialog metadata not found');
    }

    const decidedRound =
      (await DialogPersistence.getCurrentRoundNumber(
        new DialogID(dialogId, rootDialogId),
        'running',
      )) ||
      (dialogState.currentRound ?? 1);

    // Create the actual dialog object and store it in wsLiveDlg
    const dialogIdObj = new DialogID(dialogId, rootDialogId);
    const store = new DiskFileDialogStore(dialogIdObj);

    // Whether it's a root dialog is decided by selfId and rootId
    const isRoot = dialogIdObj.selfId === dialogIdObj.rootId;
    let supdialog: RootDialog | undefined;

    if (metadata.supdialogId) {
      if (isRoot) {
        log.warn('Root dialog has supdialogId in metadata', undefined, {
          dialogId: dialogIdObj.selfId,
          supdialogId: metadata.supdialogId,
        });
      }
      try {
        supdialog = await restoreParentDialog(metadata.supdialogId, rootDialogId);
      } catch (err) {
        log.warn('Failed to restore supdialog for display_dialog', undefined, {
          subdialogId: dialogId,
          parentId: metadata.supdialogId,
          error: err,
        });
      }
    } else if (!isRoot) {
      log.error('Subdialog missing supdialogId in metadata', undefined, {
        dialogId: dialogIdObj.selfId,
        rootId: dialogIdObj.rootId,
      });
    }

    let dialog: Dialog;
    let rootDialog: RootDialog | undefined;
    if (!isRoot && supdialog) {
      // This is a subdialog
      dialog = new SubDialog(
        store,
        supdialog,
        metadata.taskDocPath,
        dialogIdObj,
        metadata.agentId,
        metadata.topicId,
        metadata.assignmentFromSup,
      );
    } else {
      // This is a root dialog (or fallback if parent restore failed)
      rootDialog = new RootDialog(store, metadata.taskDocPath, dialogIdObj, metadata.agentId);
      dialog = rootDialog;
      globalDialogRegistry.register(rootDialog);

      // Restore TYPE B subdialog registry BEFORE sending events (which may trigger teammate calls)
      await rootDialog.loadSubdialogRegistry();
      await rootDialog.loadPendingSubdialogsFromPersistence();
    }

    // CRITICAL FIX: Send dialog events directly to requesting WebSocket only
    // This bypasses PubChan to ensure only the requesting session receives restoration events
    // Pass decidedRound explicitly since dialog.currentRound defaults to 1 for new Dialog objects
    try {
      await store.sendDialogEventsDirectly(ws, dialog, decidedRound);
    } catch (err) {
      log.warn(`Failed to send dialog events directly for ${dialogId}:`, err);
    }

    // Setup WebSocket subscription for real-time events (live generation only)
    await setupWebSocketSubscription(ws, dialog);

    // Send dialog_ready with full info so frontend knows the current dialog ID
    const dialogReadyResponse: DialogReadyMessage = {
      type: 'dialog_ready',
      dialog: {
        selfId: dialogId,
        rootId: rootDialogId,
      },
      agentId: metadata.agentId,
      taskDocPath: metadata.taskDocPath,
      supdialogId: metadata.supdialogId,
      topicId: metadata.topicId,
      assignmentFromSup: metadata.assignmentFromSup,
    };
    ws.send(JSON.stringify(dialogReadyResponse));

    // Emit Q4H state to ensure frontend has current questions count
    // Load Q4H from ALL running dialogs for global display (not just this dialog)
    try {
      const allQuestions = await DialogPersistence.loadAllQ4HState();

      // Transform to questions_count_update format
      const questions = allQuestions.map((q) => ({
        id: q.id,
        dialogId: q.dialogId,
        headLine: q.headLine,
        bodyContent: q.bodyContent,
        askedAt: q.askedAt,
        callSiteRef: q.callSiteRef,
      }));

      // Emit new_q4h_asked events for each question (full sync on dialog display)
      for (const q of questions) {
        const newQ4HEvent = {
          type: 'new_q4h_asked',
          question: q,
        };
        ws.send(JSON.stringify(newQ4HEvent));
      }
    } catch (err) {
      log.warn(`Failed to emit Q4H state for ${dialogIdObj}:`, err);
    }

    // Proactively emit reminders for the newly active dialog
    // todo: maybe emit only to the requestiong websocket, not publish via PubChan as curr impl
    try {
      await dialog.processReminderUpdates();
    } catch (err) {
      log.warn(`Failed to emit proactive reminders for ${dialogIdObj}:`, err);
    }
  } catch (error) {
    log.warn('Failed to handle display_dialog', error);
  }
}

/**
 * Handle Q4H state request via WebSocket
 * Fetches Q4H questions from ALL running dialogs for global display
 */
async function handleGetQ4HState(ws: WebSocket, _packet: GetQ4HStateRequest): Promise<void> {
  try {
    // Load Q4H from all running dialogs
    const allQuestions = await DialogPersistence.loadAllQ4HState();

    // Transform to questions_count_update format
    // The frontend expects questions with dialogId field
    const questions = allQuestions.map((q) => ({
      id: q.id,
      dialogId: q.dialogId,
      headLine: q.headLine,
      bodyContent: q.bodyContent,
      askedAt: q.askedAt,
      callSiteRef: q.callSiteRef,
    }));

    // Send single response packet with all questions (not PubChan events)
    const response: Q4HStateResponse = {
      type: 'q4h_state_response',
      questions,
    };
    ws.send(JSON.stringify(response));
  } catch (error) {
    log.warn('Failed to handle get_q4h_state', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error getting Q4H state',
      }),
    );
  }
}

async function handleDisplayReminders(
  ws: WebSocket,
  packet: DisplayRemindersRequest,
): Promise<void> {
  try {
    const live = wsLiveDlg.get(ws);
    if (!live) {
      log.warn('No live dialog found for display_reminders');

      return;
    }

    if (live.id.selfId !== packet.dialog.selfId) {
      log.warn(
        `Dialog ${packet.dialog} for reminders is not current live (live dialog is ${live.id})`,
      );

      return;
    }

    await live.processReminderUpdates();
  } catch (error: unknown) {
    log.warn('Failed to display reminders', error);
  }
}

async function handleDisplayRound(ws: WebSocket, packet: DisplayRoundRequest): Promise<void> {
  try {
    const { dialog, round } = packet;
    if (!dialog || typeof round !== 'number') {
      throw new Error('dialog and round are required');
    }

    // Extract dialog ID from DialogIdent
    let dialogIdStr = dialog.selfId;
    let rootDialogIdStr = dialog.rootId;

    // Handle case where dialog properties might be objects instead of strings
    if (typeof dialogIdStr !== 'string' || typeof rootDialogIdStr !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: 'Invalid dialog identifiers for display_round: selfId/rootId must be strings',
        }),
      );
      return;
    }

    const dialogId = new DialogID(dialogIdStr, rootDialogIdStr);

    const totalRounds =
      (await DialogPersistence.getCurrentRoundNumber(dialogId, 'running')) || round;

    try {
      const metadata = await DialogPersistence.loadDialogMetadata(dialogId, 'running');
      if (!metadata) {
        log.warn('Metadata not found for display_round', undefined, {
          dialogId: dialogId.selfId,
        });
        return;
      }

      const dialogUI = new DiskFileDialogStore(dialogId);

      // Whether it's a root dialog is decided by selfId and rootId
      const isRoot = dialogId.selfId === dialogId.rootId;
      let supdialog: RootDialog | undefined;

      if (metadata.supdialogId) {
        if (isRoot) {
          log.warn('Root dialog has supdialogId in metadata', undefined, {
            dialogId: dialogId.selfId,
            supdialogId: metadata.supdialogId,
          });
        }
        try {
          supdialog = await restoreParentDialog(metadata.supdialogId, dialogId.rootId);
        } catch (err) {
          log.warn('Failed to restore supdialog for display_round', undefined, {
            dialogId: dialogId.selfId,
            parentId: metadata.supdialogId,
            error: err,
          });
        }
      } else if (!isRoot) {
        log.error('Subdialog missing supdialogId in metadata', undefined, {
          dialogId: dialogId.selfId,
          rootId: dialogId.rootId,
        });
      }

      let dialog: Dialog;
      let rootDialog: RootDialog | undefined;
      if (!isRoot && supdialog) {
        // This is a subdialog
        dialog = new SubDialog(
          dialogUI,
          supdialog,
          metadata.taskDocPath,
          dialogId,
          metadata.agentId,
          metadata.topicId,
          metadata.assignmentFromSup,
        );
      } else {
        // This is a root dialog (or fallback if parent restore failed)
        rootDialog = new RootDialog(dialogUI, metadata.taskDocPath, dialogId, metadata.agentId);
        dialog = rootDialog;
        globalDialogRegistry.register(rootDialog);
        // Restore TYPE B subdialog registry from disk
        await rootDialog.loadSubdialogRegistry();
        await rootDialog.loadPendingSubdialogsFromPersistence();
      }
      postDialogEvent(dialog, {
        type: 'round_update',
        round: round,
        totalRounds,
      });
    } catch (err) {
      log.warn('Failed to emit round_update for display_round', err);
    }
  } catch (error) {
    log.warn('Failed to handle display_round', error);
  }
}

/**
 * Handle message sending via WebSocket
 */
async function handleUserMsg2Dlg(ws: WebSocket, packet: DriveDialogRequest): Promise<void> {
  try {
    const { dialog: dialogIdent, content, msgId } = packet;

    // Basic validation
    if (!dialogIdent || !content || !msgId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: 'dialog, content, and msgId are required',
        }),
      );
      return;
    }

    // Extract dialog ID from DialogIdent
    const dialogId = dialogIdent.selfId;
    const rootDialogId = dialogIdent.rootId;

    // Validate dialog identifiers
    if (typeof dialogId !== 'string' || typeof rootDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          error:
            'Invalid dialog identifiers for drive_dlg_by_user_msg: selfId/rootId must be strings',
        }),
      );
      return;
    }

    // Check if dialog is already in wsLiveDlg and properly initialized
    const existingDialog = wsLiveDlg.get(ws);
    if (
      existingDialog &&
      existingDialog.id.selfId === dialogId &&
      existingDialog.id.rootId === rootDialogId
    ) {
      await driveDialogStream(existingDialog, { content, msgId, grammar: 'texting' }, true);
      return;
    }

    // Dialog not found in wsLiveDlg - try to restore from disk
    // This enables sending messages to subdialogs and dialogs that aren't currently active
    try {
      const metadata = await DialogPersistence.loadDialogMetadata(
        new DialogID(dialogId, rootDialogId),
        'running',
      );
      if (!metadata) {
        ws.send(
          JSON.stringify({
            type: 'error',
            error: `Dialog ${dialogId} not found`,
          }),
        );
        return;
      }

      // Load dialog state from disk
      const dialogState = await DialogPersistence.restoreDialog(
        new DialogID(dialogId, rootDialogId),
        'running',
      );
      if (!dialogState) {
        ws.send(
          JSON.stringify({
            type: 'error',
            error: `Failed to restore dialog state for ${dialogId}`,
          }),
        );
        return;
      }

      // Create DialogID and store for the target dialog
      const dialogIdObj = new DialogID(dialogId, rootDialogId);
      const store = new DiskFileDialogStore(dialogIdObj);

      // Whether it's a root dialog is decided by selfId and rootId
      const isRoot = dialogIdObj.selfId === dialogIdObj.rootId;
      let supdialog: RootDialog | undefined;

      if (metadata.supdialogId) {
        if (isRoot) {
          log.warn('Root dialog has supdialogId in metadata', undefined, {
            dialogId: dialogIdObj.selfId,
            supdialogId: metadata.supdialogId,
          });
        }
        try {
          supdialog = await restoreParentDialog(metadata.supdialogId, rootDialogId);
        } catch (err) {
          log.warn('Failed to restore supdialog for subdialog', undefined, {
            subdialogId: dialogId,
            parentId: metadata.supdialogId,
            error: err,
          });
          // Continue without parent - parent-call detection will not work but dialog will function
        }
      } else if (!isRoot) {
        log.error('Subdialog missing supdialogId in metadata', undefined, {
          dialogId: dialogIdObj.selfId,
          rootId: dialogIdObj.rootId,
        });
      }

      let dialog: Dialog;
      let rootDialog: RootDialog | undefined;
      if (!isRoot && supdialog) {
        // This is a subdialog
        dialog = new SubDialog(
          store,
          supdialog,
          metadata.taskDocPath,
          dialogIdObj,
          metadata.agentId,
          metadata.topicId,
          metadata.assignmentFromSup,
          {
            messages: dialogState.messages,
            reminders: dialogState.reminders,
            currentRound: dialogState.currentRound,
          },
        );
      } else {
        // This is a root dialog (or fallback if parent restore failed)
        rootDialog = new RootDialog(store, metadata.taskDocPath, dialogIdObj, metadata.agentId, {
          messages: dialogState.messages,
          reminders: dialogState.reminders,
          currentRound: dialogState.currentRound,
        });
        dialog = rootDialog;
        globalDialogRegistry.register(rootDialog);
        // Restore TYPE B subdialog registry from disk
        await rootDialog.loadSubdialogRegistry();
        await rootDialog.loadPendingSubdialogsFromPersistence();
      }

      // Normal flow: emit events for user message
      await driveDialogStream(dialog, { content, msgId, grammar: 'texting' }, true);
      return;
    } catch (restoreError) {
      log.warn('Failed to restore dialog for message:', restoreError);
      ws.send(
        JSON.stringify({
          type: 'error',
          error: `Cannot send message to dialog ${dialogId}: dialog is not the currently active dialog and could not be restored`,
        }),
      );
      return;
    }
  } catch (error) {
    // Log the error at warning level in the backend console
    log.warn(
      `Failed to drive dialog ${packet?.dialog?.selfId} with user message: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error,
    );

    // Send error response to client
    ws.send(
      JSON.stringify({
        type: 'error',
        error: `Failed to process message: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }),
    );
  }
}

/**
 * Handle user answer to a Q4H (Questions for Human) question
 * Validates questionId, clears q4h.yaml entry, and resumes dialog with user's answer
 */
async function handleUserAnswer2Q4H(ws: WebSocket, packet: DriveDialogByUserAnswer): Promise<void> {
  try {
    const { dialog: dialogIdent, content, msgId, questionId } = packet;

    // Basic validation
    if (!dialogIdent || !content || !msgId || !questionId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: 'dialog, content, msgId, and questionId are required',
        }),
      );
      return;
    }

    // Extract dialog ID from DialogIdent
    const dialogId = dialogIdent.selfId;
    const rootDialogId = dialogIdent.rootId;

    // Validate dialog identifiers
    if (typeof dialogId !== 'string' || typeof rootDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          error:
            'Invalid dialog identifiers for drive_dialog_by_user_answer: selfId/rootId must be strings',
        }),
      );
      return;
    }

    // Load dialog metadata
    const metadata = await DialogPersistence.loadDialogMetadata(
      new DialogID(dialogId, rootDialogId),
      'running',
    );
    if (!metadata) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: `Dialog ${dialogId} not found`,
        }),
      );
      return;
    }

    // Load current questions from q4h.yaml
    const questions = await DialogPersistence.loadQuestions4HumanState(
      new DialogID(dialogId, rootDialogId),
    );

    // Validate questionId exists
    const questionIndex = questions.findIndex((q) => q.id === questionId);
    if (questionIndex === -1) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: `Question ${questionId} not found in dialog ${dialogId}`,
        }),
      );
      return;
    }

    // Remove answered question from the list
    questions.splice(questionIndex, 1);

    // Save updated questions to q4h.yaml
    if (questions.length > 0) {
      await DialogPersistence._saveQuestions4HumanState(
        new DialogID(dialogId, rootDialogId),
        questions,
      );
    } else {
      // No more questions - remove the q4h.yaml file
      await DialogPersistence.clearQuestions4HumanState(new DialogID(dialogId, rootDialogId));
    }

    // Emit questions_count_update event with updated count
    const { postDialogEvent } = await import('../evt-registry');

    // Create a temporary dialog object for event emission
    const dialogIdObj = new DialogID(dialogId, rootDialogId);
    const store = new DiskFileDialogStore(dialogIdObj);

    // Whether it's a root dialog is decided by selfId and rootId
    const isRoot = dialogIdObj.selfId === dialogIdObj.rootId;
    let supdialog: RootDialog | undefined;

    if (metadata.supdialogId) {
      if (isRoot) {
        log.warn('Root dialog has supdialogId in metadata', undefined, {
          dialogId: dialogIdObj.selfId,
          supdialogId: metadata.supdialogId,
        });
      }
      try {
        supdialog = await restoreParentDialog(metadata.supdialogId, rootDialogId);
      } catch (err) {
        log.warn('Failed to restore parent for Q4H event', err);
      }
    } else if (!isRoot) {
      log.error('Subdialog missing supdialogId in metadata', undefined, {
        dialogId: dialogIdObj.selfId,
        rootId: dialogIdObj.rootId,
      });
    }

    let dialog: Dialog;
    let rootDialog: RootDialog | undefined;
    if (!isRoot && supdialog) {
      dialog = new SubDialog(
        store,
        supdialog,
        metadata.taskDocPath,
        dialogIdObj,
        metadata.agentId,
        metadata.topicId,
        metadata.assignmentFromSup,
      );
    } else {
      rootDialog = new RootDialog(store, metadata.taskDocPath, dialogIdObj, metadata.agentId);
      dialog = rootDialog;
      globalDialogRegistry.register(rootDialog);
      // Restore TYPE B subdialog registry from disk
      await rootDialog.loadSubdialogRegistry();
      await rootDialog.loadPendingSubdialogsFromPersistence();
    }

    // Emit q4h_answered event for answered question
    const answeredEvent: Q4HAnsweredEvent = {
      type: 'q4h_answered',
      questionId,
      dialogId,
    };
    postDialogEvent(dialog, answeredEvent);

    // Now resume the dialog with the user's answer using handleUserMsg2Dlg pattern
    // This will process the answer and continue the dialog
    const dialogState = await DialogPersistence.restoreDialog(
      new DialogID(dialogId, rootDialogId),
      'running',
    );
    if (!dialogState) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: `Failed to restore dialog state for ${dialogId}`,
        }),
      );
      return;
    }

    // Create the dialog object
    const restoredDialogIdObj = new DialogID(dialogId, rootDialogId);
    const restoredStore = new DiskFileDialogStore(restoredDialogIdObj);

    // Use already calculated isRoot
    let restoredSupdialog: RootDialog | undefined;

    if (metadata.supdialogId) {
      if (isRoot) {
        log.warn('Root dialog has supdialogId in metadata', undefined, {
          dialogId: restoredDialogIdObj.selfId,
          supdialogId: metadata.supdialogId,
        });
      }
      try {
        restoredSupdialog = await restoreParentDialog(metadata.supdialogId, rootDialogId);
      } catch (err) {
        log.warn('Failed to restore parent for dialog resumption', err);
      }
    } else if (!isRoot) {
      log.error('Subdialog missing supdialogId in metadata', undefined, {
        dialogId: restoredDialogIdObj.selfId,
        rootId: restoredDialogIdObj.rootId,
      });
    }

    let restoredDialog: Dialog;
    let restoredRootDialog: RootDialog | undefined;
    if (!isRoot && restoredSupdialog) {
      restoredDialog = new SubDialog(
        restoredStore,
        restoredSupdialog,
        metadata.taskDocPath,
        restoredDialogIdObj,
        metadata.agentId,
        metadata.topicId,
        metadata.assignmentFromSup,
        {
          messages: dialogState.messages,
          reminders: dialogState.reminders,
          currentRound: dialogState.currentRound,
        },
      );
    } else {
      restoredRootDialog = new RootDialog(
        restoredStore,
        metadata.taskDocPath,
        restoredDialogIdObj,
        metadata.agentId,
        {
          messages: dialogState.messages,
          reminders: dialogState.reminders,
          currentRound: dialogState.currentRound,
        },
      );
      restoredDialog = restoredRootDialog;
      globalDialogRegistry.register(restoredRootDialog);
      // Restore TYPE B subdialog registry from disk
      await restoredRootDialog.loadSubdialogRegistry();
      await restoredRootDialog.loadPendingSubdialogsFromPersistence();
    }

    // Resume the dialog with the user's answer
    wsLiveDlg.set(ws, restoredDialog);
    await driveDialogStream(restoredDialog, { content, msgId, grammar: 'texting' }, true);
  } catch (error) {
    log.error('Error processing Q4H user answer:', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        error: `Failed to process Q4H answer: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }),
    );
  }
}

/**
 * Setup WebSocket server with dialog handling
 */
export function setupWebSocketServer(httpServer: Server, clients: Set<WebSocket>): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: 'welcome',
        message: 'Connected to dialog server',
        timestamp: formatUnifiedTimestamp(new Date()),
      }),
    );

    ws.on('message', async (data: Buffer) => {
      try {
        const packet: unknown = JSON.parse(data.toString());
        if (!isRecord(packet) || typeof packet.type !== 'string') {
          throw new Error('Invalid packet format');
        }
        await handleWebSocketMessage(ws, packet as unknown as WebSocketMessage);
      } catch (error) {
        log.error('Error handling WebSocket packet:', error);
        ws.send(
          JSON.stringify({
            type: 'error',
            packet: 'Invalid packet format',
            timestamp: formatUnifiedTimestamp(new Date()),
          }),
        );
      }
    });

    ws.on('close', () => {
      clients.delete(ws);

      // Clean up client subscriptions
      cleanupWsClient(ws);
    });

    ws.on('error', (error) => {
      log.error('WebSocket error:', error);
      clients.delete(ws);

      // Clean up client subscriptions on error
      cleanupWsClient(ws);
    });
  });

  return wss;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Clean up all event channels and subscriptions
 */
export function cleanupEventSystems(): void {
  // Clear all WebSocket subscriptions (WeakMap will be garbage collected)
  // Just trigger cleanup of the event channel registry
  dialogEventRegistry.cleanup();
}

// Register cleanup on process exit
process.on('SIGINT', () => {
  cleanupEventSystems();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupEventSystems();
  process.exit(0);
});
