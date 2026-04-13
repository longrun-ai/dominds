import fs from 'node:fs/promises';
import path from 'node:path';

import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import type {
  DialogMetadataFile,
  FuncResultContentItem,
  HumanQuestion,
  PendingSubdialogStateRecord,
  PendingSubdialogsReconciledRecord,
  PersistedDialogRecord,
  Questions4HumanReconciledRecord,
  ReminderSnapshotItem,
  RemindersReconciledRecord,
  RootDialogMetadataFile,
  RootGenerationAnchor,
  SubdialogCreatedRecord,
  SubdialogRegistryReconciledRecord,
  SubdialogRegistryStateRecord,
  SubdialogResponseStateRecord,
  SubdialogResponsesReconciledRecord,
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
      pendingSubdialogs: boolean;
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
  pendingSubdialogs: ReadonlyArray<PendingSubdialogStateRecord>;
  registryEntries: ReadonlyArray<SubdialogRegistryStateRecord>;
  subdialogResponses: ReadonlyArray<SubdialogResponseStateRecord>;
  childCount: number;
}>;

type ForkSnapshot = Readonly<{
  reminders: ReadonlyArray<Reminder>;
  questions: ReadonlyArray<HumanQuestion>;
  pendingSubdialogs: ReadonlyArray<PendingSubdialogStateRecord>;
  registryEntries: ReadonlyArray<SubdialogRegistryStateRecord>;
  subdialogResponses: ReadonlyArray<SubdialogResponseStateRecord>;
}>;

type IncludedSubdialog = Readonly<{
  sourceId: DialogID;
  targetId: DialogID;
  metadata: Extract<DialogMetadataFile, { supdialogId: string }>;
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

function clonePendingSubdialogs(
  pendingSubdialogs: readonly PendingSubdialogStateRecord[],
): PendingSubdialogStateRecord[] {
  return pendingSubdialogs.map((entry) => ({
    ...entry,
    mentionList: entry.mentionList ? [...entry.mentionList] : undefined,
  }));
}

function cloneRegistryEntries(
  entries: readonly SubdialogRegistryStateRecord[],
): SubdialogRegistryStateRecord[] {
  return entries.map((entry) => ({ ...entry }));
}

function cloneSubdialogResponses(
  responses: readonly SubdialogResponseStateRecord[],
): SubdialogResponseStateRecord[] {
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

function rewriteAssignmentFromSupForFork(
  assignmentFromSup: Extract<DialogMetadataFile, { supdialogId: string }>['assignmentFromSup'],
  sourceRootId: string,
  targetRootId: string,
): Extract<DialogMetadataFile, { supdialogId: string }>['assignmentFromSup'] {
  return {
    ...assignmentFromSup,
    callerDialogId: rewriteForkTreeDialogSelfId(
      assignmentFromSup.callerDialogId,
      sourceRootId,
      targetRootId,
    ),
    mentionList: assignmentFromSup.mentionList ? [...assignmentFromSup.mentionList] : undefined,
    collectiveTargets: assignmentFromSup.collectiveTargets
      ? [...assignmentFromSup.collectiveTargets]
      : undefined,
  };
}

function rewriteSubdialogMetadataForFork(
  metadata: Extract<DialogMetadataFile, { supdialogId: string }>,
  sourceRootId: string,
  targetRootId: string,
): Extract<DialogMetadataFile, { supdialogId: string }> {
  return {
    ...metadata,
    supdialogId: rewriteForkTreeDialogSelfId(metadata.supdialogId, sourceRootId, targetRootId),
    assignmentFromSup: rewriteAssignmentFromSupForFork(
      metadata.assignmentFromSup,
      sourceRootId,
      targetRootId,
    ),
  };
}

function isForkStateRecord(
  record: PersistedDialogRecord,
):
  | RemindersReconciledRecord
  | Questions4HumanReconciledRecord
  | PendingSubdialogsReconciledRecord
  | SubdialogRegistryReconciledRecord
  | SubdialogResponsesReconciledRecord
  | SubdialogCreatedRecord
  | null {
  switch (record.type) {
    case 'subdialog_created_record':
    case 'reminders_reconciled_record':
    case 'questions4human_reconciled_record':
    case 'pending_subdialogs_reconciled_record':
    case 'subdialog_registry_reconciled_record':
    case 'subdialog_responses_reconciled_record':
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
    case 'quest_for_sup_record':
    case 'tellask_reply_resolution_record':
    case 'tellask_call_anchor_record':
    case 'gen_start_record':
    case 'gen_finish_record':
    case 'subdialog_created_record':
    case 'reminders_reconciled_record':
    case 'questions4human_reconciled_record':
    case 'pending_subdialogs_reconciled_record':
    case 'subdialog_registry_reconciled_record':
    case 'subdialog_responses_reconciled_record':
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

function rewriteFuncResultContentItems(
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
    case 'human_text_record':
    case 'quest_for_sup_record':
    case 'tellask_result_record':
    case 'tellask_reply_resolution_record':
    case 'tellask_call_anchor_record':
    case 'tellask_carryover_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return record;
    case 'func_result_record':
      return {
        ...record,
        contentItems: rewriteFuncResultContentItems(record.contentItems, newRootId),
      };
    case 'tool_result_image_ingest_record':
      return {
        ...record,
        artifact: {
          ...record.artifact,
          rootId: newRootId,
        },
      };
    case 'subdialog_created_record':
    case 'reminders_reconciled_record':
    case 'questions4human_reconciled_record':
    case 'pending_subdialogs_reconciled_record':
    case 'subdialog_registry_reconciled_record':
    case 'subdialog_responses_reconciled_record':
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
  pendingSubdialogs: readonly PendingSubdialogStateRecord[];
}): DialogDisplayState {
  if (args.action.kind === 'draft_user_text') {
    return { kind: 'idle_waiting_user' };
  }
  const hasQ4H = args.questions.length > 0;
  const hasSubdialogs = args.pendingSubdialogs.length > 0;
  if (hasQ4H && hasSubdialogs) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input_and_subdialogs' } };
  }
  if (hasQ4H) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  if (hasSubdialogs) {
    return { kind: 'blocked', reason: { kind: 'waiting_for_subdialogs' } };
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
  let latestPending: PendingSubdialogStateRecord[] | null = null;
  let latestRegistry: SubdialogRegistryStateRecord[] | null = null;
  let latestResponses: SubdialogResponseStateRecord[] | null = null;

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
        case 'pending_subdialogs_reconciled_record':
          latestPending = clonePendingSubdialogs(stateRecord.pendingSubdialogs);
          break;
        case 'subdialog_registry_reconciled_record':
          latestRegistry = cloneRegistryEntries(stateRecord.entries);
          break;
        case 'subdialog_responses_reconciled_record':
          latestResponses = cloneSubdialogResponses(stateRecord.responses);
          break;
        case 'subdialog_created_record':
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
    pendingSubdialogs: latestPending ?? [],
    registryEntries: latestRegistry ?? [],
    subdialogResponses: latestResponses ?? [],
  };
}

async function collectIncludedSubdialogs(args: {
  sourceRootId: string;
  sourceStatus: DialogStatusKind;
  cutoffAnchor: RootGenerationAnchor;
  targetRootId: string;
}): Promise<IncludedSubdialog[]> {
  const queue: DialogID[] = [new DialogID(args.sourceRootId)];
  const scannedDialogSelfIds = new Set<string>();
  const included = new Map<string, IncludedSubdialog>();

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
        if (event.type !== 'subdialog_created_record') continue;
        if (!anchorAtOrBefore(event, args.cutoffAnchor)) continue;
        if (included.has(event.subdialogId)) continue;

        const sourceId = new DialogID(event.subdialogId, args.sourceRootId);
        const metadata = await DialogPersistence.loadDialogMetadata(sourceId, args.sourceStatus);
        if (!metadata || metadata.supdialogId === undefined) {
          throw new Error(`Missing included subdialog metadata for ${sourceId.valueOf()}`);
        }
        included.set(event.subdialogId, {
          sourceId,
          targetId: new DialogID(event.subdialogId, args.targetRootId),
          metadata,
        });
        queue.push(sourceId);
      }
    }
  }

  const orderedSelfIds = Array.from(included.keys()).sort();
  const orderedIncluded: IncludedSubdialog[] = [];
  for (const selfId of orderedSelfIds) {
    const item = included.get(selfId);
    if (!item) {
      throw new Error(`Missing ordered included subdialog for ${selfId}`);
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
    const isRootDialog = args.sourceId.selfId === args.sourceId.rootId;
    const retained = events.filter((event, index) => {
      if (isForkStateRecord(event)) {
        return false;
      }
      if (args.truncateRootCourse && course === args.truncateRootCourse.course && isRootDialog) {
        return index < args.truncateRootCourse.keepCount;
      }
      if (!isRootDialog) {
        const recordAnchor = getRecordRootAnchor(event);
        if (recordAnchor === null) {
          throw new Error(
            `fork dialog requires root anchor on subdialog transcript record: dialog=${args.sourceId.valueOf()} course=${String(course)} type=${event.type}`,
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
    pendingSubdialogs: snapshot.pendingSubdialogs,
    registryEntries: snapshot.registryEntries,
    subdialogResponses: snapshot.subdialogResponses,
    childCount: args.childCount,
  };
}

async function appendForkBaselineState(
  plan: ForkDialogPlan,
  baselineSubdialogCreatedRecords: readonly SubdialogCreatedRecord[],
): Promise<void> {
  const baselineTs = formatUnifiedTimestamp(new Date());
  for (const record of baselineSubdialogCreatedRecords) {
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
  const pendingRecord: PendingSubdialogsReconciledRecord = {
    ts: baselineTs,
    type: 'pending_subdialogs_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    pendingSubdialogs: clonePendingSubdialogs(plan.pendingSubdialogs),
  };
  const registryRecord: SubdialogRegistryReconciledRecord = {
    ts: baselineTs,
    type: 'subdialog_registry_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    entries: cloneRegistryEntries(plan.registryEntries),
  };
  const responsesRecord: SubdialogResponsesReconciledRecord = {
    ts: baselineTs,
    type: 'subdialog_responses_reconciled_record',
    ...FORK_BASELINE_ANCHOR,
    responses: cloneSubdialogResponses(plan.subdialogResponses),
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
  baselineRecordsByParentSelfId: ReadonlyMap<string, readonly SubdialogCreatedRecord[]>;
  latestDisableDiligencePush: boolean | undefined;
  latestDiligencePushRemainingBudget: number | undefined;
}): Promise<void> {
  const { plan } = args;
  if (plan.targetId.selfId === plan.targetId.rootId) {
    if (
      plan.metadata.supdialogId !== undefined ||
      plan.metadata.sessionSlug !== undefined ||
      plan.metadata.assignmentFromSup !== undefined
    ) {
      throw new Error(`fork root plan received subdialog metadata: ${plan.targetId.valueOf()}`);
    }
    const rewrittenMetadata: RootDialogMetadataFile = {
      id: plan.targetId.selfId,
      agentId: plan.metadata.agentId,
      taskDocPath: plan.metadata.taskDocPath,
      createdAt: args.now,
      ...(plan.metadata.priming ? { priming: plan.metadata.priming } : {}),
    };
    await DialogPersistence.saveRootDialogMetadata(plan.targetId, rewrittenMetadata, 'running');
  } else {
    if (plan.metadata.supdialogId === undefined) {
      throw new Error(`fork subdialog plan missing supdialog metadata: ${plan.targetId.valueOf()}`);
    }
    const rewrittenMetadata = rewriteSubdialogMetadataForFork(
      plan.metadata,
      plan.sourceId.rootId,
      plan.targetId.rootId,
    );
    await DialogPersistence.ensureSubdialogDirectory(plan.targetId, 'running');
    await DialogPersistence.saveSubdialogMetadata(plan.targetId, rewrittenMetadata, 'running');
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
  await DialogPersistence.savePendingSubdialogs(
    plan.targetId,
    [...plan.pendingSubdialogs],
    undefined,
    'running',
  );
  await DialogPersistence.saveSubdialogRegistry(
    plan.targetId,
    plan.registryEntries.map((entry) => ({
      key: entry.key,
      subdialogId: new DialogID(entry.subdialogId, plan.targetId.rootId),
      agentId: entry.agentId,
      sessionSlug: entry.sessionSlug,
    })),
    'running',
  );
  await DialogPersistence.saveSubdialogResponses(
    plan.targetId,
    [...plan.subdialogResponses],
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
          pendingSubdialogs: plan.pendingSubdialogs,
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
      subdialogCount: plan.childCount,
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

export async function forkRootDialogTreeAtGeneration(args: {
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

  const sourceRootDialogId = new DialogID(sourceRootId);
  const sourceMetadata = await DialogPersistence.loadDialogMetadata(
    sourceRootDialogId,
    args.sourceStatus,
  );
  if (!sourceMetadata) {
    throw new Error(`Root dialog not found: ${sourceRootId} (${args.sourceStatus})`);
  }
  if (sourceMetadata.supdialogId !== undefined) {
    throw new Error(`fork dialog only supports root dialogs: ${sourceRootId}`);
  }

  const targetCourse = Math.floor(args.course);
  const targetGenseq = Math.floor(args.genseq);
  const rootEvents = await DialogPersistence.readCourseEvents(
    sourceRootDialogId,
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
  const latest = await DialogPersistence.loadDialogLatest(sourceRootDialogId, args.sourceStatus);
  const targetRootId = generateDialogID();
  const now = formatUnifiedTimestamp(new Date());

  const includedSubdialogs = await collectIncludedSubdialogs({
    sourceRootId,
    sourceStatus: args.sourceStatus,
    cutoffAnchor,
    targetRootId,
  });

  const childCountByParentSelfId = new Map<string, number>();
  for (const subdialog of includedSubdialogs) {
    childCountByParentSelfId.set(
      subdialog.metadata.supdialogId,
      (childCountByParentSelfId.get(subdialog.metadata.supdialogId) ?? 0) + 1,
    );
  }

  const rootPlan = await buildDialogForkPlan({
    sourceId: sourceRootDialogId,
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
      : rootPlan.questions.length > 0 || rootPlan.pendingSubdialogs.length > 0
        ? {
            kind: 'restore_pending',
            pendingQ4H: rootPlan.questions.length > 0,
            pendingSubdialogs: rootPlan.pendingSubdialogs.length > 0,
          }
        : { kind: 'auto_continue' };

  const subdialogPlans: ForkDialogPlan[] = [];
  for (const subdialog of includedSubdialogs) {
    subdialogPlans.push(
      await buildDialogForkPlan({
        sourceId: subdialog.sourceId,
        targetId: subdialog.targetId,
        sourceStatus: args.sourceStatus,
        sourceMetadata: subdialog.metadata,
        cutoffAnchor,
        childCount: childCountByParentSelfId.get(subdialog.sourceId.selfId) ?? 0,
      }),
    );
  }

  const baselineRecordsByParentSelfId = new Map<string, SubdialogCreatedRecord[]>();
  for (const subdialog of includedSubdialogs) {
    const rewrittenSupdialogId = rewriteForkTreeDialogSelfId(
      subdialog.metadata.supdialogId,
      sourceRootId,
      targetRootId,
    );
    const rewrittenRecord: SubdialogCreatedRecord = {
      ts: now,
      type: 'subdialog_created_record',
      ...FORK_BASELINE_ANCHOR,
      subdialogId: subdialog.targetId.selfId,
      supdialogId: rewrittenSupdialogId,
      agentId: subdialog.metadata.agentId,
      taskDocPath: subdialog.metadata.taskDocPath,
      createdAt: subdialog.metadata.createdAt,
      sessionSlug: subdialog.metadata.sessionSlug,
      assignmentFromSup: rewriteAssignmentFromSupForFork(
        subdialog.metadata.assignmentFromSup,
        sourceRootId,
        targetRootId,
      ),
    };
    const existing = baselineRecordsByParentSelfId.get(rewrittenSupdialogId);
    if (existing) {
      existing.push(rewrittenRecord);
    } else {
      baselineRecordsByParentSelfId.set(rewrittenSupdialogId, [rewrittenRecord]);
    }
  }

  const allPlans = [rootPlan, ...subdialogPlans];
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
