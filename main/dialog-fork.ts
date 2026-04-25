import fs from 'node:fs/promises';
import path from 'node:path';

import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import type {
  DialogAskerStackState,
  DialogMetadataFile,
  FuncResultContentItem,
  HumanQuestion,
  MainDialogMetadataFile,
  PendingSideDialogStateRecord,
  PendingSideDialogsReconciledRecord,
  PersistedDialogRecord,
  Questions4HumanReconciledRecord,
  ReminderSnapshotItem,
  RemindersReconciledRecord,
  RootGenerationAnchor,
  SideDialogAssignmentFromAsker,
  SideDialogCreatedRecord,
  SideDialogMetadataFile,
  SideDialogRegistryReconciledRecord,
  SideDialogRegistryStateRecord,
  SideDialogResponseStateRecord,
  SideDialogResponsesReconciledRecord,
  TellaskReplyDirective,
} from '@longrun-ai/kernel/types/storage';
import { toRootGenerationAnchor } from '@longrun-ai/kernel/types/storage';
import type { DialogStatusKind } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from './dialog';
import { DialogPersistence } from './persistence';
import { materializeReminder, type Reminder } from './tool';
import { generateDialogID } from './utils/id';

type ForkDialogAction =
  | Readonly<{
      kind: 'draft_user_text';
      userText: string;
    }>
  | Readonly<{
      kind: 'restore_pending';
      pendingQ4H: boolean;
      pendingSideDialogs: boolean;
    }>
  | Readonly<{
      kind: 'auto_continue';
    }>;

export type ForkDialogTreeResult = Readonly<{
  rootId: string;
  selfId: string;
  agentId: string;
  taskDocPath: string;
  action: ForkDialogAction;
}>;

type ForkDialogPlan = Readonly<{
  sourceId: DialogID;
  targetId: DialogID;
  metadata: DialogMetadataFile;
  retainedCourses: ReadonlyArray<
    Readonly<{
      course: number;
      events: ReadonlyArray<PersistedDialogRecord>;
    }>
  >;
  currentCourse: number;
  reminders: ReadonlyArray<Reminder>;
  questions: ReadonlyArray<HumanQuestion>;
  pendingSideDialogs: ReadonlyArray<PendingSideDialogStateRecord>;
  registryEntries: ReadonlyArray<SideDialogRegistryStateRecord>;
  sideDialogResponses: ReadonlyArray<SideDialogResponseStateRecord>;
  childCount: number;
}>;

type ForkSnapshot = Readonly<{
  reminders: ReadonlyArray<Reminder>;
  questions: ReadonlyArray<HumanQuestion>;
  pendingSideDialogs: ReadonlyArray<PendingSideDialogStateRecord>;
  registryEntries: ReadonlyArray<SideDialogRegistryStateRecord>;
  sideDialogResponses: ReadonlyArray<SideDialogResponseStateRecord>;
}>;

type IncludedSideDialog = Readonly<{
  sourceId: DialogID;
  targetId: DialogID;
  metadata: SideDialogMetadataFile;
  assignmentFromAsker: SideDialogAssignmentFromAsker;
}>;

const FORK_BASELINE_ANCHOR: RootGenerationAnchor = toRootGenerationAnchor({
  rootCourse: 1,
  rootGenseq: 0,
});

function compareRootAnchor(left: RootGenerationAnchor, right: RootGenerationAnchor): -1 | 0 | 1 {
  if (left.rootCourse < right.rootCourse) return -1;
  if (left.rootCourse > right.rootCourse) return 1;
  if (left.rootGenseq < right.rootGenseq) return -1;
  if (left.rootGenseq > right.rootGenseq) return 1;
  return 0;
}

function anchorAtOrBefore(candidate: RootGenerationAnchor, cutoff: RootGenerationAnchor): boolean {
  return compareRootAnchor(candidate, cutoff) <= 0;
}

function cloneReminderSnapshot(snapshot: ReminderSnapshotItem): Reminder {
  return materializeReminder({
    id: snapshot.id,
    content: snapshot.content,
    owner: undefined,
    meta: snapshot.meta,
    echoback: snapshot.echoback,
    scope: snapshot.scope ?? 'dialog',
    renderMode: snapshot.renderMode ?? 'markdown',
    createdAt: snapshot.createdAt,
    priority: snapshot.priority,
  });
}

function cloneQuestions(questions: readonly HumanQuestion[]): HumanQuestion[] {
  return questions.map((question) => ({
    ...question,
    callSiteRef: { ...question.callSiteRef },
  }));
}

function clonePendingSideDialogs(
  pendingSideDialogs: readonly PendingSideDialogStateRecord[],
): PendingSideDialogStateRecord[] {
  return pendingSideDialogs.map((entry) => ({
    ...entry,
    mentionList: entry.mentionList ? [...entry.mentionList] : undefined,
  }));
}

function cloneRegistryEntries(
  entries: readonly SideDialogRegistryStateRecord[],
): SideDialogRegistryStateRecord[] {
  return entries.map((entry) => ({ ...entry }));
}

function cloneSideDialogResponses(
  responses: readonly SideDialogResponseStateRecord[],
): SideDialogResponseStateRecord[] {
  return responses.map((response) => ({
    ...response,
    mentionList: response.mentionList ? [...response.mentionList] : undefined,
  }));
}

function rewriteForkTreeDialogSelfId(
  sourceDialogSelfId: string,
  sourceRootId: string,
  targetRootId: string,
): string {
  return sourceDialogSelfId === sourceRootId ? targetRootId : sourceDialogSelfId;
}

function rewriteAssignmentFromAskerForFork(
  assignmentFromAsker: SideDialogAssignmentFromAsker,
  sourceRootId: string,
  targetRootId: string,
): SideDialogAssignmentFromAsker {
  return {
    ...assignmentFromAsker,
    askerDialogId: rewriteForkTreeDialogSelfId(
      assignmentFromAsker.askerDialogId,
      sourceRootId,
      targetRootId,
    ),
    mentionList: assignmentFromAsker.mentionList ? [...assignmentFromAsker.mentionList] : undefined,
    collectiveTargets: assignmentFromAsker.collectiveTargets
      ? [...assignmentFromAsker.collectiveTargets]
      : undefined,
  };
}

function rewriteSideDialogMetadataForFork(
  metadata: SideDialogMetadataFile,
): SideDialogMetadataFile {
  return {
    ...metadata,
  };
}

function rewriteTellaskReplyDirectiveForFork(
  directive: TellaskReplyDirective,
  sourceRootId: string,
  targetRootId: string,
): TellaskReplyDirective {
  return {
    ...directive,
    targetDialogId: rewriteForkTreeDialogSelfId(
      directive.targetDialogId,
      sourceRootId,
      targetRootId,
    ),
  };
}

function rewriteSideDialogAskerStackStateForFork(
  state: DialogAskerStackState,
  sourceRootId: string,
  targetRootId: string,
): DialogAskerStackState {
  return {
    askerStack: state.askerStack.map((frame) => ({
      kind: 'asker_dialog_stack_frame',
      askerDialogId: rewriteForkTreeDialogSelfId(frame.askerDialogId, sourceRootId, targetRootId),
      ...(frame.assignmentFromAsker === undefined
        ? {}
        : {
            assignmentFromAsker: rewriteAssignmentFromAskerForFork(
              frame.assignmentFromAsker,
              sourceRootId,
              targetRootId,
            ),
          }),
      ...(frame.tellaskReplyObligation === undefined
        ? {}
        : {
            tellaskReplyObligation: rewriteTellaskReplyDirectiveForFork(
              frame.tellaskReplyObligation,
              sourceRootId,
              targetRootId,
            ),
          }),
    })),
  };
}

function isForkStateRecord(
  record: PersistedDialogRecord,
):
  | RemindersReconciledRecord
  | Questions4HumanReconciledRecord
  | PendingSideDialogsReconciledRecord
  | SideDialogRegistryReconciledRecord
  | SideDialogResponsesReconciledRecord
  | SideDialogCreatedRecord
  | null {
  switch (record.type) {
    case 'sideDialog_created_record':
    case 'reminders_reconciled_record':
    case 'questions4human_reconciled_record':
    case 'pending_sideDialogs_reconciled_record':
    case 'sideDialog_registry_reconciled_record':
    case 'sideDialog_responses_reconciled_record':
      return record;
    default:
      return null;
  }
}

function isPersistedMessageRecord(record: PersistedDialogRecord): boolean {
  switch (record.type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'runtime_guide_record':
    case 'human_text_record':
    case 'func_call_record':
    case 'tellask_call_record':
    case 'func_result_record':
    case 'tellask_result_record':
    case 'tellask_carryover_record':
      return true;
    // UI-only timeline records belong to the retained transcript for replay/forking, but they do
    // not contribute to message-count / context reconstruction semantics.
    case 'web_search_call_record':
    case 'native_tool_call_record':
    case 'tool_result_image_ingest_record':
    case 'user_image_ingest_record':
    case 'sideDialog_request_record':
    case 'tellask_reply_resolution_record':
    case 'tellask_call_anchor_record':
    case 'tellask_call_callee_record':
    case 'gen_start_record':
    case 'gen_finish_record':
    case 'sideDialog_created_record':
    case 'reminders_reconciled_record':
    case 'questions4human_reconciled_record':
    case 'pending_sideDialogs_reconciled_record':
    case 'sideDialog_registry_reconciled_record':
    case 'sideDialog_responses_reconciled_record':
      return false;
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled persisted record while counting messages: ${String(_exhaustive)}`);
    }
  }
}

function getRecordRootAnchor(record: PersistedDialogRecord): RootGenerationAnchor | null {
  const rootCourse =
    'rootCourse' in record && typeof record.rootCourse === 'number' ? record.rootCourse : null;
  const rootGenseq =
    'rootGenseq' in record && typeof record.rootGenseq === 'number' ? record.rootGenseq : null;
  if (rootCourse === null || rootGenseq === null) {
    return null;
  }
  return toRootGenerationAnchor({
    rootCourse,
    rootGenseq,
  });
}

function normalizeDraftUserText(
  events: readonly PersistedDialogRecord[],
  targetGenseq: number,
): string | null {
  const texts = events
    .filter(
      (event): event is Extract<PersistedDialogRecord, { type: 'human_text_record' }> =>
        event.type === 'human_text_record' && event.genseq === targetGenseq,
    )
    .map((event) => event.content.trim())
    .filter((value) => value !== '');
  if (texts.length === 0) return null;
  return texts.join('\n\n');
}

function rewriteContentItemsForFork(
  items: readonly FuncResultContentItem[] | undefined,
  newRootId: string,
): FuncResultContentItem[] | undefined {
  if (!items) return undefined;
  return items.map((item) => {
    switch (item.type) {
      case 'input_text':
        return item;
      case 'input_image':
        return {
          ...item,
          artifact: {
            ...item.artifact,
            rootId: newRootId,
          },
        };
      default: {
        const _exhaustive: never = item;
        return _exhaustive;
      }
    }
  });
}

function rewriteRecordForFork(
  record: PersistedDialogRecord,
  newRootId: string,
): PersistedDialogRecord {
  switch (record.type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'runtime_guide_record':
    case 'func_call_record':
    case 'tellask_call_record':
    // UI-only transcript records are safe to copy verbatim into the forked transcript. They are
    // not part of baseline state reconciliation and must not make forking fail.
    case 'web_search_call_record':
    case 'native_tool_call_record':
    case 'sideDialog_request_record':
    case 'tellask_reply_resolution_record':
    case 'tellask_call_anchor_record':
    case 'tellask_call_callee_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return record;
    case 'human_text_record':
    case 'tellask_result_record':
    case 'tellask_carryover_record':
      return {
        ...record,
        contentItems: rewriteContentItemsForFork(record.contentItems, newRootId),
      };
    case 'func_result_record':
      return {
        ...record,
        contentItems: rewriteContentItemsForFork(record.contentItems, newRootId),
      };
    case 'tool_result_image_ingest_record':
    case 'user_image_ingest_record':
      return {
        ...record,
        artifact: {
          ...record.artifact,
          rootId: newRootId,
        },
      };
    case 'sideDialog_created_record':
    case 'reminders_reconciled_record':
    case 'questions4human_reconciled_record':
    case 'pending_sideDialogs_reconciled_record':
    case 'sideDialog_registry_reconciled_record':
    case 'sideDialog_responses_reconciled_record':
      throw new Error(`Fork transcript copy must not include state record ${record.type}`);
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}

function countMessages(events: readonly PersistedDialogRecord[]): number {
  let count = 0;
  for (const event of events) {
    if (isPersistedMessageRecord(event)) {
      count += 1;
    }
  }
  return count;
}

function countFunctionCalls(events: readonly PersistedDialogRecord[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === 'func_call_record' || event.type === 'tellask_call_record') {
      count += 1;
    }
  }
  return count;
}

function computeRootForkDisplayState(args: {
  action: ForkDialogAction;
  questions: readonly HumanQuestion[];
  pendingSideDialogs: readonly PendingSideDialogStateRecord[];
}): DialogDisplayState {
  if (args.action.kind === 'draft_user_text') {
    return { kind: 'idle_waiting_user' };
  }
  const hasQ4H = args.questions.length > 0;
  const hasSideDialogs = args.pendingSideDialogs.length > 0;
  if (hasQ4H && hasSideDialogs) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input_and_sideDialogs' } };
  }
  if (hasQ4H) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  if (hasSideDialogs) {
    return { kind: 'blocked', reason: { kind: 'waiting_for_sideDialogs' } };
  }
  return { kind: 'stopped', reason: { kind: 'fork_continue_ready' }, continueEnabled: true };
}

async function copyArtifactsIfPresent(
  sourceId: DialogID,
  targetId: DialogID,
  sourceStatus: DialogStatusKind,
): Promise<void> {
  const sourceDir = path.join(
    DialogPersistence.getDialogEventsPath(sourceId, sourceStatus),
    'artifacts',
  );
  const targetDir = path.join(
    DialogPersistence.getDialogEventsPath(targetId, 'running'),
    'artifacts',
  );
  try {
    await fs.access(sourceDir);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return;
    throw error;
  }
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function listDialogCourseNumbers(
  dialogId: DialogID,
  status: DialogStatusKind,
): Promise<number[]> {
  const dialogDir = DialogPersistence.getDialogEventsPath(dialogId, status);
  let entries: { name: string; isFile(): boolean }[] = [];
  try {
    entries = (await fs.readdir(dialogDir, { withFileTypes: true })) as {
      name: string;
      isFile(): boolean;
    }[];
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return [];
    throw error;
  }
  const courses: number[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^course-\d+\.jsonl$/.test(entry.name)) continue;
    courses.push(DialogPersistence.getCourseFromFilename(entry.name));
  }
  courses.sort((a, b) => a - b);
  return courses;
}

async function collectForkSnapshot(
  dialogId: DialogID,
  status: DialogStatusKind,
  cutoffAnchor: RootGenerationAnchor,
): Promise<ForkSnapshot> {
  const courseNumbers = await listDialogCourseNumbers(dialogId, status);
  let latestReminders: ReminderSnapshotItem[] | null = null;
  let latestQuestions: HumanQuestion[] | null = null;
  let latestPending: PendingSideDialogStateRecord[] | null = null;
  let latestRegistry: SideDialogRegistryStateRecord[] | null = null;
  let latestResponses: SideDialogResponseStateRecord[] | null = null;

  for (const course of courseNumbers) {
    const events = await DialogPersistence.readCourseEvents(dialogId, course, status);
    for (const event of events) {
      const stateRecord = isForkStateRecord(event);
      if (!stateRecord) continue;
      if (!anchorAtOrBefore(stateRecord, cutoffAnchor)) continue;
      switch (stateRecord.type) {
        case 'reminders_reconciled_record':
          latestReminders = stateRecord.reminders.map((item) => ({ ...item }));
          break;
        case 'questions4human_reconciled_record':
          latestQuestions = cloneQuestions(stateRecord.questions);
          break;
        case 'pending_sideDialogs_reconciled_record':
          latestPending = clonePendingSideDialogs(stateRecord.pendingSideDialogs);
          break;
        case 'sideDialog_registry_reconciled_record':
          latestRegistry = cloneRegistryEntries(stateRecord.entries);
          break;
        case 'sideDialog_responses_reconciled_record':
          latestResponses = cloneSideDialogResponses(stateRecord.responses);
          break;
        case 'sideDialog_created_record':
          break;
        default: {
          const _exhaustive: never = stateRecord;
          throw new Error(`Unhandled fork snapshot record ${String(_exhaustive)}`);
        }
      }
    }
  }

  return {
    reminders:
      latestReminders !== null ? latestReminders.map((item) => cloneReminderSnapshot(item)) : [],
    questions: latestQuestions ?? [],
    pendingSideDialogs: latestPending ?? [],
    registryEntries: latestRegistry ?? [],
    sideDialogResponses: latestResponses ?? [],
  };
}

async function collectIncludedSideDialogs(args: {
  sourceRootId: string;
  sourceStatus: DialogStatusKind;
  cutoffAnchor: RootGenerationAnchor;
  targetRootId: string;
}): Promise<IncludedSideDialog[]> {
  const queue: DialogID[] = [new DialogID(args.sourceRootId)];
  const scannedDialogSelfIds = new Set<string>();
  const included = new Map<string, IncludedSideDialog>();

  while (queue.length > 0) {
    const ownerDialogId = queue.shift();
    if (!ownerDialogId) break;
    if (scannedDialogSelfIds.has(ownerDialogId.selfId)) continue;
    scannedDialogSelfIds.add(ownerDialogId.selfId);

    const courseNumbers = await listDialogCourseNumbers(ownerDialogId, args.sourceStatus);
    for (const course of courseNumbers) {
      const events = await DialogPersistence.readCourseEvents(
        ownerDialogId,
        course,
        args.sourceStatus,
      );
      for (const event of events) {
        if (event.type !== 'sideDialog_created_record') continue;
        if (!anchorAtOrBefore(event, args.cutoffAnchor)) continue;
        if (included.has(event.sideDialogId)) continue;

        const sourceId = new DialogID(event.sideDialogId, args.sourceRootId);
        const metadata = await DialogPersistence.loadDialogMetadata(sourceId, args.sourceStatus);
        if (!metadata) {
          throw new Error(`Missing included sideDialog metadata for ${sourceId.valueOf()}`);
        }
        const assignmentFromAsker = await DialogPersistence.loadSideDialogAssignmentFromAsker(
          sourceId,
          args.sourceStatus,
        );
        included.set(event.sideDialogId, {
          sourceId,
          targetId: new DialogID(event.sideDialogId, args.targetRootId),
          metadata,
          assignmentFromAsker,
        });
        queue.push(sourceId);
      }
    }
  }

  const orderedSelfIds = Array.from(included.keys()).sort();
  const orderedIncluded: IncludedSideDialog[] = [];
  for (const selfId of orderedSelfIds) {
    const item = included.get(selfId);
    if (!item) {
      throw new Error(`Missing ordered included sideDialog for ${selfId}`);
    }
    orderedIncluded.push(item);
  }
  return orderedIncluded;
}

async function buildDialogForkPlan(args: {
  sourceId: DialogID;
  targetId: DialogID;
  sourceStatus: DialogStatusKind;
  sourceMetadata: DialogMetadataFile;
  cutoffAnchor: RootGenerationAnchor;
  truncateRootCourse?: {
    course: number;
    keepCount: number;
  };
  childCount: number;
}): Promise<ForkDialogPlan> {
  const courseNumbers = await listDialogCourseNumbers(args.sourceId, args.sourceStatus);
  const retainedCourses: Array<{ course: number; events: PersistedDialogRecord[] }> = [];

  for (const course of courseNumbers) {
    const events = await DialogPersistence.readCourseEvents(
      args.sourceId,
      course,
      args.sourceStatus,
    );
    const isMainDialog = args.sourceId.selfId === args.sourceId.rootId;
    const retained = events.filter((event, index) => {
      if (isForkStateRecord(event)) {
        return false;
      }
      if (args.truncateRootCourse && course === args.truncateRootCourse.course && isMainDialog) {
        return index < args.truncateRootCourse.keepCount;
      }
      if (!isMainDialog) {
        const recordAnchor = getRecordRootAnchor(event);
        if (recordAnchor === null) {
          throw new Error(
            `fork dialog requires root anchor on sideDialog transcript record: dialog=${args.sourceId.valueOf()} course=${String(course)} type=${event.type}`,
          );
        }
        return anchorAtOrBefore(recordAnchor, args.cutoffAnchor);
      }
      return true;
    });
    if (retained.length > 0) {
      retainedCourses.push({ course, events: retained });
    }
  }

  const snapshot = await collectForkSnapshot(args.sourceId, args.sourceStatus, args.cutoffAnchor);
  const retainedCurrentCourse =
    retainedCourses.length > 0 ? retainedCourses[retainedCourses.length - 1]!.course : 1;

  return {
    sourceId: args.sourceId,
    targetId: args.targetId,
    metadata: args.sourceMetadata,
    retainedCourses,
    currentCourse: retainedCurrentCourse,
    reminders: snapshot.reminders,
    questions: snapshot.questions,
    pendingSideDialogs: snapshot.pendingSideDialogs,
    registryEntries: snapshot.registryEntries,
    sideDialogResponses: snapshot.sideDialogResponses,
    childCount: args.childCount,
  };
}

async function appendForkBaselineState(
  plan: ForkDialogPlan,
  baselineSideDialogCreatedRecords: readonly SideDialogCreatedRecord[],
): Promise<void> {
  const baselineTs = formatUnifiedTimestamp(new Date());
  for (const record of baselineSideDialogCreatedRecords) {
    await DialogPersistence.appendEvent(plan.targetId, 1, record, 'running');
  }
  const remindersRecord: RemindersReconciledRecord = {
    ts: baselineTs,
    type: 'reminders_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    reminders: plan.reminders.map((reminder) => ({
      id: reminder.id,
      content: reminder.content,
      ownerName: reminder.owner?.name,
      meta: reminder.meta,
      echoback: reminder.echoback,
      scope: reminder.scope ?? 'dialog',
      createdAt: reminder.createdAt ?? baselineTs,
      priority: reminder.priority ?? 'medium',
    })),
  };
  const q4hRecord: Questions4HumanReconciledRecord = {
    ts: baselineTs,
    type: 'questions4human_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    questions: cloneQuestions(plan.questions),
  };
  const pendingRecord: PendingSideDialogsReconciledRecord = {
    ts: baselineTs,
    type: 'pending_sideDialogs_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    pendingSideDialogs: clonePendingSideDialogs(plan.pendingSideDialogs),
  };
  const registryRecord: SideDialogRegistryReconciledRecord = {
    ts: baselineTs,
    type: 'sideDialog_registry_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    entries: cloneRegistryEntries(plan.registryEntries),
  };
  const responsesRecord: SideDialogResponsesReconciledRecord = {
    ts: baselineTs,
    type: 'sideDialog_responses_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    responses: cloneSideDialogResponses(plan.sideDialogResponses),
  };
  await DialogPersistence.appendEvent(plan.targetId, 1, remindersRecord, 'running');
  await DialogPersistence.appendEvent(plan.targetId, 1, q4hRecord, 'running');
  await DialogPersistence.appendEvent(plan.targetId, 1, pendingRecord, 'running');
  await DialogPersistence.appendEvent(plan.targetId, 1, registryRecord, 'running');
  await DialogPersistence.appendEvent(plan.targetId, 1, responsesRecord, 'running');
}

async function persistForkPlan(args: {
  plan: ForkDialogPlan;
  sourceStatus: DialogStatusKind;
  now: string;
  action: ForkDialogAction;
  baselineRecordsByParentSelfId: ReadonlyMap<string, readonly SideDialogCreatedRecord[]>;
  latestDisableDiligencePush: boolean | undefined;
  latestDiligencePushRemainingBudget: number | undefined;
}): Promise<void> {
  const { plan } = args;
  if (plan.targetId.selfId === plan.targetId.rootId) {
    const priming = 'priming' in plan.metadata ? plan.metadata.priming : undefined;
    const rewrittenMetadata: MainDialogMetadataFile = {
      id: plan.targetId.selfId,
      agentId: plan.metadata.agentId,
      taskDocPath: plan.metadata.taskDocPath,
      createdAt: args.now,
      ...(priming ? { priming } : {}),
    };
    await DialogPersistence.saveMainDialogMetadata(plan.targetId, rewrittenMetadata, 'running');
  } else {
    const rewrittenMetadata = rewriteSideDialogMetadataForFork(plan.metadata);
    const sourceAskerStackState = await DialogPersistence.loadSideDialogAskerStackState(
      plan.sourceId,
      args.sourceStatus,
    );
    if (!sourceAskerStackState) {
      throw new Error(`fork sideDialog plan missing asker stack: ${plan.sourceId.valueOf()}`);
    }
    const rewrittenAskerStackState = rewriteSideDialogAskerStackStateForFork(
      sourceAskerStackState,
      plan.sourceId.rootId,
      plan.targetId.rootId,
    );
    await DialogPersistence.ensureSideDialogDirectory(plan.targetId, 'running');
    await DialogPersistence.saveSideDialogAskerStackState(
      plan.targetId,
      rewrittenAskerStackState,
      'running',
    );
    await DialogPersistence.saveSideDialogMetadata(plan.targetId, rewrittenMetadata, 'running');
  }

  const sourceAskerStack = await DialogPersistence.loadDialogAskerStack(
    plan.sourceId,
    args.sourceStatus,
  );
  if (sourceAskerStack.askerStack.length > 0) {
    await DialogPersistence.saveDialogAskerStack(
      plan.targetId,
      rewriteSideDialogAskerStackStateForFork(
        sourceAskerStack,
        plan.sourceId.rootId,
        plan.targetId.rootId,
      ),
      'running',
    );
  }

  for (const course of plan.retainedCourses) {
    for (const event of course.events) {
      await DialogPersistence.appendEvent(
        plan.targetId,
        course.course,
        rewriteRecordForFork(event, plan.targetId.rootId),
        'running',
      );
    }
  }

  await appendForkBaselineState(
    plan,
    args.baselineRecordsByParentSelfId.get(plan.targetId.selfId) ?? [],
  );

  await DialogPersistence._saveReminderState(plan.targetId, [...plan.reminders], 'running');
  await DialogPersistence._saveQuestions4HumanState(plan.targetId, [...plan.questions], 'running');
  await DialogPersistence.savePendingSideDialogs(
    plan.targetId,
    [...plan.pendingSideDialogs],
    undefined,
    'running',
  );
  await DialogPersistence.saveSideDialogRegistry(
    plan.targetId,
    plan.registryEntries.map((entry) => ({
      key: entry.key,
      sideDialogId: new DialogID(entry.sideDialogId, plan.targetId.rootId),
      agentId: entry.agentId,
      sessionSlug: entry.sessionSlug,
    })),
    'running',
  );
  await DialogPersistence.saveSideDialogResponses(
    plan.targetId,
    [...plan.sideDialogResponses],
    undefined,
    'running',
  );

  await copyArtifactsIfPresent(plan.sourceId, plan.targetId, args.sourceStatus);

  const currentCourseEvents =
    plan.retainedCourses.find((item) => item.course === plan.currentCourse)?.events ?? [];
  const displayState =
    plan.targetId.selfId === plan.targetId.rootId
      ? computeRootForkDisplayState({
          action: args.action,
          questions: plan.questions,
          pendingSideDialogs: plan.pendingSideDialogs,
        })
      : { kind: 'idle_waiting_user' as const };

  await DialogPersistence.mutateDialogLatest(plan.targetId, () => ({
    kind: 'replace',
    next: {
      currentCourse: plan.currentCourse,
      lastModified: args.now,
      status: 'active',
      messageCount: countMessages(currentCourseEvents),
      functionCallCount: countFunctionCalls(currentCourseEvents),
      sideDialogCount: plan.childCount,
      generating: false,
      needsDrive: false,
      displayState,
      disableDiligencePush:
        plan.targetId.selfId === plan.targetId.rootId ? args.latestDisableDiligencePush : false,
      diligencePushRemainingBudget:
        plan.targetId.selfId === plan.targetId.rootId
          ? args.latestDiligencePushRemainingBudget
          : undefined,
    },
  }));
}

export async function forkMainDialogTreeAtGeneration(args: {
  sourceRootId: string;
  sourceStatus: DialogStatusKind;
  course: number;
  genseq: number;
}): Promise<ForkDialogTreeResult> {
  const sourceRootId = args.sourceRootId.trim();
  if (sourceRootId === '') {
    throw new Error('sourceRootId is required');
  }
  if (!Number.isFinite(args.course) || args.course <= 0) {
    throw new Error('course must be a positive integer');
  }
  if (!Number.isFinite(args.genseq) || args.genseq <= 0) {
    throw new Error('genseq must be a positive integer');
  }

  const sourceMainDialogId = new DialogID(sourceRootId);
  const sourceMetadata = await DialogPersistence.loadDialogMetadata(
    sourceMainDialogId,
    args.sourceStatus,
  );
  if (!sourceMetadata) {
    throw new Error(`Main dialog not found: ${sourceRootId} (${args.sourceStatus})`);
  }
  const targetCourse = Math.floor(args.course);
  const targetGenseq = Math.floor(args.genseq);
  const rootEvents = await DialogPersistence.readCourseEvents(
    sourceMainDialogId,
    targetCourse,
    args.sourceStatus,
  );
  const targetStartIndex = rootEvents.findIndex(
    (event) =>
      'genseq' in event && typeof event.genseq === 'number' && event.genseq === targetGenseq,
  );
  if (targetStartIndex < 0) {
    throw new Error(
      `Target genseq ${String(targetGenseq)} not found in dialog ${sourceRootId} course ${String(targetCourse)}`,
    );
  }
  const targetStartEvent = rootEvents[targetStartIndex];
  if (!targetStartEvent) {
    throw new Error(
      `Target genseq ${String(targetGenseq)} missing start event in dialog ${sourceRootId} course ${String(targetCourse)}`,
    );
  }

  const cutoffAnchor: RootGenerationAnchor = toRootGenerationAnchor({
    rootCourse: targetCourse,
    rootGenseq: targetGenseq - 1,
  });
  const draftUserText = normalizeDraftUserText(rootEvents, targetGenseq);
  const latest = await DialogPersistence.loadDialogLatest(sourceMainDialogId, args.sourceStatus);
  const targetRootId = generateDialogID();
  const now = formatUnifiedTimestamp(new Date());

  const includedSideDialogs = await collectIncludedSideDialogs({
    sourceRootId,
    sourceStatus: args.sourceStatus,
    cutoffAnchor,
    targetRootId,
  });

  const childCountByParentSelfId = new Map<string, number>();
  for (const sideDialog of includedSideDialogs) {
    const askerDialogId = sideDialog.assignmentFromAsker.askerDialogId;
    childCountByParentSelfId.set(
      askerDialogId,
      (childCountByParentSelfId.get(askerDialogId) ?? 0) + 1,
    );
  }

  const rootPlan = await buildDialogForkPlan({
    sourceId: sourceMainDialogId,
    targetId: new DialogID(targetRootId),
    sourceStatus: args.sourceStatus,
    sourceMetadata,
    cutoffAnchor,
    truncateRootCourse: { course: targetCourse, keepCount: targetStartIndex },
    childCount: childCountByParentSelfId.get(sourceRootId) ?? 0,
  });

  const action: ForkDialogAction =
    draftUserText !== null
      ? { kind: 'draft_user_text', userText: draftUserText }
      : rootPlan.questions.length > 0 || rootPlan.pendingSideDialogs.length > 0
        ? {
            kind: 'restore_pending',
            pendingQ4H: rootPlan.questions.length > 0,
            pendingSideDialogs: rootPlan.pendingSideDialogs.length > 0,
          }
        : { kind: 'auto_continue' };

  const sideDialogPlans: ForkDialogPlan[] = [];
  for (const sideDialog of includedSideDialogs) {
    sideDialogPlans.push(
      await buildDialogForkPlan({
        sourceId: sideDialog.sourceId,
        targetId: sideDialog.targetId,
        sourceStatus: args.sourceStatus,
        sourceMetadata: sideDialog.metadata,
        cutoffAnchor,
        childCount: childCountByParentSelfId.get(sideDialog.sourceId.selfId) ?? 0,
      }),
    );
  }

  const baselineRecordsByParentSelfId = new Map<string, SideDialogCreatedRecord[]>();
  for (const sideDialog of includedSideDialogs) {
    const rewrittenAskerDialogId = rewriteForkTreeDialogSelfId(
      sideDialog.assignmentFromAsker.askerDialogId,
      sourceRootId,
      targetRootId,
    );
    const rewrittenRecord: SideDialogCreatedRecord = {
      ts: now,
      type: 'sideDialog_created_record',
      ...FORK_BASELINE_ANCHOR,
      sideDialogId: sideDialog.targetId.selfId,
      askerDialogId: rewrittenAskerDialogId,
      agentId: sideDialog.metadata.agentId,
      taskDocPath: sideDialog.metadata.taskDocPath,
      createdAt: sideDialog.metadata.createdAt,
      sessionSlug: sideDialog.metadata.sessionSlug,
      assignmentFromAsker: rewriteAssignmentFromAskerForFork(
        sideDialog.assignmentFromAsker,
        sourceRootId,
        targetRootId,
      ),
    };
    const existing = baselineRecordsByParentSelfId.get(rewrittenAskerDialogId);
    if (existing) {
      existing.push(rewrittenRecord);
    } else {
      baselineRecordsByParentSelfId.set(rewrittenAskerDialogId, [rewrittenRecord]);
    }
  }

  const allPlans = [rootPlan, ...sideDialogPlans];
  for (const plan of allPlans) {
    await persistForkPlan({
      plan,
      sourceStatus: args.sourceStatus,
      now,
      action,
      baselineRecordsByParentSelfId,
      latestDisableDiligencePush: latest?.disableDiligencePush,
      latestDiligencePushRemainingBudget: latest?.diligencePushRemainingBudget,
    });
  }

  return {
    rootId: targetRootId,
    selfId: targetRootId,
    agentId: sourceMetadata.agentId,
    taskDocPath: sourceMetadata.taskDocPath,
    action,
  };
}
