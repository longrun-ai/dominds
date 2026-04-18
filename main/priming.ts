import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { PrimingScriptSummary } from '@longrun-ai/kernel/types/priming';
import type {
  AgentThoughtRecord,
  AgentWordsRecord,
  FuncCallRecord,
  FuncResultContentItem,
  FuncResultRecord,
  GenFinishRecord,
  GenStartRecord,
  HumanTextRecord,
  JsonValue,
  NativeToolCallRecord,
  PersistedDialogRecord,
  QuestForSupRecord,
  ReasoningContentItem,
  ReasoningPayload,
  ReasoningSummaryItem,
  RuntimeGuideRecord,
  TellaskCallAnchorRecord,
  TellaskCallRecord,
  TellaskCarryoverRecord,
  TellaskReplyDirective,
  TellaskReplyResolutionRecord,
  TellaskResultRecord,
  ToolResultImageIngestRecord,
  UiOnlyMarkdownRecord,
  WebSearchCallActionRecord,
  WebSearchCallRecord,
} from '@longrun-ai/kernel/types/storage';
import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallerCourseNumber,
  toCallingCourseNumber,
  toCallingGenerationSeqNumber,
  toDialogCourseNumber,
  toRootGenerationAnchor,
} from '@longrun-ai/kernel/types/storage';
import type { DialogPrimingInput, DialogStatusKind } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import type { Dialog } from './dialog';
import { DialogID } from './dialog';
import type { ChatMessage } from './llm/client';
import { parseMarkdownFrontmatter } from './markdown/frontmatter';
import { DialogPersistence } from './persistence';
import { materializeReminder, type Reminder } from './tool';
import { getReminderOwner } from './tools/registry';

const PRIMING_ROOT_DIR = path.resolve(process.cwd(), '.minds', 'priming');
const PRIMING_INDIVIDUAL_DIR = path.resolve(PRIMING_ROOT_DIR, 'individual');
const PRIMING_TEAM_SHARED_DIR = path.resolve(PRIMING_ROOT_DIR, 'team_shared');
const RECENT_PRIMING_DIR = path.resolve(process.cwd(), '.dialogs', 'recent-priming');
const RECENT_PRIMING_MAX = 20;

type StripTs<T> = T extends { ts: string } ? Omit<T, 'ts'> : never;
type PrimingUnsupportedRecord = Extract<
  PersistedDialogRecord,
  {
    type:
      | 'subdialog_created_record'
      | 'reminders_reconciled_record'
      | 'questions4human_reconciled_record'
      | 'pending_subdialogs_reconciled_record'
      | 'subdialog_registry_reconciled_record'
      | 'subdialog_responses_reconciled_record';
  }
>;
type PrimingReplayRecord = StripTs<Exclude<PersistedDialogRecord, PrimingUnsupportedRecord>>;
type PrimingRecordType = PrimingReplayRecord['type'];
type PrimingMarkdownTextField = 'content' | 'tellaskContent' | 'response';

type ParsedPrimingHeading = { kind: 'record'; type: PrimingRecordType };

type ParsedPrimingScript = {
  title?: string;
  applicableMemberIds?: string[];
  reminders?: PrimingReminderSnapshot[];
  records: PrimingReplayRecord[];
};

type PrimingReminderPriority = 'high' | 'medium' | 'low';

type PrimingReminderSnapshot = {
  id?: string;
  content: string;
  ownerName?: string;
  meta?: JsonValue;
  echoback?: boolean;
  scope?: 'dialog' | 'personal' | 'agent_shared';
  renderMode?: 'plain' | 'markdown';
  createdAt?: string;
  priority?: PrimingReminderPriority;
};

type PrimingRecentScriptEntry = {
  scriptRef: string;
  lastUsedAt: string;
};

type PrimingRecentScriptFile = {
  version: 1;
  entries: PrimingRecentScriptEntry[];
};

export type PrimingScriptValidationIssue = {
  path: string;
  error: string;
};

export type PrimingScriptsValidationResult = {
  checked: number;
  failed: number;
  issues: PrimingScriptValidationIssue[];
};

export type PrimingScriptLoadIssue = {
  path: string;
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item));
}

function ensureInside(basePath: string, candidatePath: string): boolean {
  const normalizedBase = basePath.endsWith(path.sep) ? basePath : `${basePath}${path.sep}`;
  const resolved = path.resolve(candidatePath);
  return resolved === path.resolve(basePath) || resolved.startsWith(normalizedBase);
}

function normalizeSlug(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (trimmed === '') return null;
  if (trimmed.startsWith('/')) return null;
  if (trimmed.includes('\u0000')) return null;
  if (trimmed.includes(':')) return null;

  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.' || normalized.startsWith('../')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) return null;
  return normalized;
}

function normalizeScriptRef(raw: string): string | null {
  let trimmed = raw.trim().replace(/\\/g, '/');
  if (trimmed === '') return null;
  if (trimmed.endsWith('.md')) {
    trimmed = trimmed.slice(0, -'.md'.length);
  }
  if (trimmed.startsWith('/')) return null;
  if (trimmed.includes('\u0000')) return null;
  if (trimmed.includes(':')) return null;

  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.' || normalized.startsWith('../')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (parts[0] === 'individual') {
    if (parts.length < 3) return null;
    return normalized;
  }
  if (parts[0] === 'team_shared') {
    if (parts.length < 2) return null;
    return normalized;
  }
  return null;
}

function scriptRefToAbsolutePath(scriptRef: string): string {
  const absPath = path.resolve(PRIMING_ROOT_DIR, `${scriptRef}.md`);
  if (!ensureInside(PRIMING_ROOT_DIR, absPath)) {
    throw new Error(`Priming script path escapes priming root: ${scriptRef}`);
  }
  return absPath;
}

function parseFrontmatter(raw: string): { body: string; frontmatter: Record<string, unknown> } {
  return parseMarkdownFrontmatter(raw, 'priming');
}

function parseApplicableMemberIds(frontmatter: Record<string, unknown>): string[] | undefined {
  const raw = frontmatter['applicableMemberIds'] ?? frontmatter['applicable_members'];
  if (!Array.isArray(raw)) return undefined;
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped.length > 0 ? deduped : undefined;
}

function parseReminderPriority(
  value: unknown,
  context: string,
): PrimingReminderPriority | undefined {
  if (value === undefined) return undefined;
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  throw new Error(`${context}.priority must be high | medium | low when provided`);
}

function parseReminderSnapshots(
  frontmatter: Record<string, unknown>,
): PrimingReminderSnapshot[] | undefined {
  const raw = frontmatter['reminders'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('top-level frontmatter.reminders must be an array when provided');
  }

  const reminders: PrimingReminderSnapshot[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const context = `frontmatter.reminders[${String(index)}]`;
    if (!isRecord(item)) {
      throw new Error(`${context} must be an object`);
    }
    const content =
      typeof item['content'] === 'string'
        ? item['content']
        : (() => {
            throw new Error(`${context}.content must be a string`);
          })();
    if (content.trim() === '') {
      throw new Error(`${context}.content must be a non-empty string`);
    }
    const id = item['id'];
    if (id !== undefined && typeof id !== 'string') {
      throw new Error(`${context}.id must be a string when provided`);
    }
    const ownerName = item['ownerName'];
    if (ownerName !== undefined && (typeof ownerName !== 'string' || ownerName.trim() === '')) {
      throw new Error(`${context}.ownerName must be a non-empty string when provided`);
    }
    const meta = item['meta'];
    if (meta !== undefined && !isJsonValue(meta)) {
      throw new Error(`${context}.meta must be valid JSON-compatible data when provided`);
    }
    const echoback = item['echoback'];
    if (echoback !== undefined && typeof echoback !== 'boolean') {
      throw new Error(`${context}.echoback must be a boolean when provided`);
    }
    const scope = item['scope'];
    if (
      scope !== undefined &&
      scope !== 'dialog' &&
      scope !== 'personal' &&
      scope !== 'agent_shared'
    ) {
      throw new Error(
        `${context}.scope must be "dialog", "personal", or "agent_shared" when provided`,
      );
    }
    const createdAt = item['createdAt'];
    if (createdAt !== undefined && typeof createdAt !== 'string') {
      throw new Error(`${context}.createdAt must be a string when provided`);
    }
    const renderMode = item['renderMode'];
    if (renderMode !== undefined && renderMode !== 'plain' && renderMode !== 'markdown') {
      throw new Error(`${context}.renderMode must be "plain" or "markdown" when provided`);
    }
    const priority = parseReminderPriority(item['priority'], context);
    reminders.push({
      id: typeof id === 'string' ? id : undefined,
      content,
      ownerName: typeof ownerName === 'string' ? ownerName.trim() : undefined,
      meta,
      echoback,
      scope:
        scope === 'dialog' || scope === 'personal' || scope === 'agent_shared' ? scope : undefined,
      renderMode: renderMode === 'plain' || renderMode === 'markdown' ? renderMode : undefined,
      createdAt: typeof createdAt === 'string' ? createdAt : undefined,
      priority,
    });
  }

  return reminders;
}

function reminderToSnapshot(reminder: Reminder): PrimingReminderSnapshot {
  return {
    id: reminder.id,
    content: reminder.content,
    ownerName: reminder.owner?.name,
    meta: reminder.meta,
    echoback: reminder.echoback,
    scope: reminder.scope,
    renderMode: reminder.renderMode ?? 'markdown',
    createdAt: reminder.createdAt,
    priority: reminder.priority,
  };
}

function materializeReminderSnapshot(snapshot: PrimingReminderSnapshot, context: string): Reminder {
  const owner =
    snapshot.ownerName === undefined
      ? undefined
      : (() => {
          const resolved = getReminderOwner(snapshot.ownerName);
          if (!resolved) {
            throw new Error(`${context}.ownerName '${snapshot.ownerName}' is not registered`);
          }
          return resolved;
        })();
  return materializeReminder({
    id: snapshot.id,
    content: snapshot.content,
    owner,
    meta: snapshot.meta,
    echoback: snapshot.echoback,
    scope: snapshot.scope,
    renderMode: snapshot.renderMode ?? 'markdown',
    createdAt: snapshot.createdAt,
    priority: snapshot.priority,
  });
}

function isPrimingRecordType(raw: string): raw is PrimingRecordType {
  return (
    raw === 'agent_thought_record' ||
    raw === 'agent_words_record' ||
    raw === 'ui_only_markdown_record' ||
    raw === 'runtime_guide_record' ||
    raw === 'func_call_record' ||
    raw === 'tellask_call_record' ||
    raw === 'web_search_call_record' ||
    raw === 'tool_result_image_ingest_record' ||
    raw === 'human_text_record' ||
    raw === 'func_result_record' ||
    raw === 'tellask_result_record' ||
    raw === 'quest_for_sup_record' ||
    raw === 'tellask_reply_resolution_record' ||
    raw === 'tellask_call_anchor_record' ||
    raw === 'tellask_carryover_record' ||
    raw === 'gen_start_record' ||
    raw === 'gen_finish_record'
  );
}

function getRecordMarkdownTextField(type: PrimingRecordType): PrimingMarkdownTextField | null {
  switch (type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'runtime_guide_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'tellask_result_record':
      return 'content';
    case 'quest_for_sup_record':
      return 'tellaskContent';
    case 'tellask_reply_resolution_record':
    case 'tellask_call_record':
      return null;
    case 'tellask_carryover_record':
      return 'response';
    case 'func_call_record':
    case 'web_search_call_record':
    case 'tool_result_image_ingest_record':
    case 'native_tool_call_record':
    case 'tellask_call_anchor_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return null;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unhandled priming record type in text-field map: ${String(_exhaustive)}`);
    }
  }
}

function parsePrimingHeading(line: string): ParsedPrimingHeading | null {
  const headingMatch = line.match(/^###\s+record\s+([A-Za-z0-9_]+)\s*$/i);
  if (!headingMatch) return null;
  const rawType = headingMatch[1].trim().toLowerCase();
  if (!isPrimingRecordType(rawType)) {
    throw new Error(`Unsupported priming record heading type '${rawType}'`);
  }
  return { kind: 'record', type: rawType };
}

function parseContentBlock(
  lines: string[],
  startIndex: number,
  headingForError: string,
): { content: string; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]?.trim() === '') {
    index += 1;
  }

  const openingLine = lines[index] ?? '';
  const fenceMatch = openingLine.match(/^(`{3,}|~{3,})\s*[^`~]*$/);
  if (fenceMatch) {
    const fence = fenceMatch[1];
    index += 1;
    const block: string[] = [];
    let closed = false;
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === fence) {
        closed = true;
        index += 1;
        break;
      }
      block.push(current);
      index += 1;
    }
    if (!closed) {
      throw new Error(`Priming block is missing closing fence for '${headingForError}'`);
    }
    return { content: block.join('\n'), nextIndex: index };
  }

  const block: string[] = [];
  while (index < lines.length) {
    if (parsePrimingHeading(lines[index] ?? '') !== null) break;
    block.push(lines[index] ?? '');
    index += 1;
  }
  return { content: block.join('\n'), nextIndex: index };
}

function expectIntegerField(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${context}.${key} must be a non-negative integer`);
  }
  return value;
}

function expectStringField(
  record: Record<string, unknown>,
  key: string,
  context: string,
  allowEmpty = false,
): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${context}.${key} must be a string`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
  return value;
}

function parseOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${context}.${key} must be a string when provided`);
  }
  return value;
}

function parseOptionalIntegerField(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${context}.${key} must be a non-negative integer when provided`);
  }
  return value;
}

function parseOptionalLanguageCodeField(
  record: Record<string, unknown>,
  key: string,
  context: string,
): LanguageCode | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value === 'en' || value === 'zh') return value;
  throw new Error(`${context}.${key} must be 'en' | 'zh' when provided`);
}

function parseOptionalSourceTag(
  record: Record<string, unknown>,
  context: string,
): 'priming_script' | undefined {
  const sourceTag = record['sourceTag'];
  if (sourceTag === undefined) return undefined;
  if (sourceTag === 'priming_script') return sourceTag;
  throw new Error(`${context}.sourceTag must be 'priming_script' when provided`);
}

function parseOptionalReasoningPayload(
  value: unknown,
  context: string,
): ReasoningPayload | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${context}.reasoning must be an object when provided`);
  }

  const summaryRaw = value['summary'];
  if (!Array.isArray(summaryRaw)) {
    throw new Error(`${context}.reasoning.summary must be an array`);
  }
  const summary: ReasoningSummaryItem[] = [];
  for (const part of summaryRaw) {
    if (!isRecord(part)) {
      throw new Error(`${context}.reasoning.summary item must be an object`);
    }
    if (part['type'] !== 'summary_text' || typeof part['text'] !== 'string') {
      throw new Error(
        `${context}.reasoning.summary item must be {type:'summary_text',text:string}`,
      );
    }
    summary.push({ type: 'summary_text', text: part['text'] });
  }

  const contentRaw = value['content'];
  let content: ReasoningContentItem[] | undefined;
  if (contentRaw !== undefined) {
    if (!Array.isArray(contentRaw)) {
      throw new Error(`${context}.reasoning.content must be an array when provided`);
    }
    const parsed: ReasoningContentItem[] = [];
    for (const part of contentRaw) {
      if (!isRecord(part) || typeof part['type'] !== 'string' || typeof part['text'] !== 'string') {
        throw new Error(`${context}.reasoning.content item must include type/text strings`);
      }
      if (part['type'] === 'reasoning_text' || part['type'] === 'text') {
        parsed.push({ type: part['type'], text: part['text'] });
        continue;
      }
      throw new Error(`${context}.reasoning.content item.type must be reasoning_text | text`);
    }
    content = parsed;
  }

  const encryptedContentRaw = value['encrypted_content'];
  if (encryptedContentRaw !== undefined && typeof encryptedContentRaw !== 'string') {
    throw new Error(`${context}.reasoning.encrypted_content must be a string when provided`);
  }

  const reasoning: ReasoningPayload = { summary };
  if (content !== undefined) reasoning.content = content;
  if (typeof encryptedContentRaw === 'string') reasoning.encrypted_content = encryptedContentRaw;
  return reasoning;
}

function parseOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string[] | undefined {
  const raw = record[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    throw new Error(`${context}.${key} must be a string[] when provided`);
  }
  return raw;
}

function parseTellaskReplyDirective(
  record: Record<string, unknown>,
  context: string,
): TellaskReplyDirective | undefined {
  const raw = record['tellaskReplyDirective'];
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`${context}.tellaskReplyDirective must be an object when provided`);
  }
  const expectedReplyCallName = raw['expectedReplyCallName'];
  const targetCallId = raw['targetCallId'];
  const tellaskContent = raw['tellaskContent'];
  if (
    expectedReplyCallName !== 'replyTellask' &&
    expectedReplyCallName !== 'replyTellaskSessionless' &&
    expectedReplyCallName !== 'replyTellaskBack'
  ) {
    throw new Error(
      `${context}.tellaskReplyDirective.expectedReplyCallName must be a supported replyTellask* function`,
    );
  }
  if (typeof targetCallId !== 'string') {
    throw new Error(`${context}.tellaskReplyDirective.targetCallId must be a string`);
  }
  if (typeof tellaskContent !== 'string') {
    throw new Error(`${context}.tellaskReplyDirective.tellaskContent must be a string`);
  }
  if (expectedReplyCallName === 'replyTellaskBack') {
    const targetDialogId = raw['targetDialogId'];
    if (typeof targetDialogId !== 'string') {
      throw new Error(`${context}.tellaskReplyDirective.targetDialogId must be a string`);
    }
    return {
      expectedReplyCallName,
      targetCallId,
      targetDialogId,
      tellaskContent,
    };
  }
  return {
    expectedReplyCallName,
    targetCallId,
    tellaskContent,
  };
}

function normalizeWebSearchAction(
  value: unknown,
  context: string,
): WebSearchCallActionRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${context}.action must be an object when provided`);
  }
  const type = value['type'];
  if (type === 'search') {
    const query = value['query'];
    if (query !== undefined && typeof query !== 'string') {
      throw new Error(`${context}.action.query must be a string when provided`);
    }
    return query === undefined ? { type: 'search' } : { type: 'search', query };
  }
  if (type === 'open_page') {
    const url = value['url'];
    if (url !== undefined && typeof url !== 'string') {
      throw new Error(`${context}.action.url must be a string when provided`);
    }
    return url === undefined ? { type: 'open_page' } : { type: 'open_page', url };
  }
  if (type === 'find_in_page') {
    const url = value['url'];
    const pattern = value['pattern'];
    if (url !== undefined && typeof url !== 'string') {
      throw new Error(`${context}.action.url must be a string when provided`);
    }
    if (pattern !== undefined && typeof pattern !== 'string') {
      throw new Error(`${context}.action.pattern must be a string when provided`);
    }
    const action: WebSearchCallActionRecord = { type: 'find_in_page' };
    if (url !== undefined) action.url = url;
    if (pattern !== undefined) action.pattern = pattern;
    return action;
  }
  throw new Error(`${context}.action.type must be search | open_page | find_in_page`);
}

function normalizeFuncResultContentItems(
  value: unknown,
  context: string,
): FuncResultContentItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context}.contentItems must be an array when provided`);
  }
  const parsed: FuncResultContentItem[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['type'] !== 'string') {
      throw new Error(`${context}.contentItems item must be an object with type`);
    }
    if (item['type'] === 'input_text') {
      if (typeof item['text'] !== 'string') {
        throw new Error(`${context}.contentItems.input_text.text must be a string`);
      }
      parsed.push({
        type: 'input_text',
        text: item['text'],
      });
      continue;
    }
    if (item['type'] === 'input_image') {
      const mimeType = item['mimeType'];
      const byteLength = item['byteLength'];
      const artifact = item['artifact'];
      if (typeof mimeType !== 'string') {
        throw new Error(`${context}.contentItems.input_image.mimeType must be a string`);
      }
      if (typeof byteLength !== 'number' || !Number.isFinite(byteLength)) {
        throw new Error(`${context}.contentItems.input_image.byteLength must be a finite number`);
      }
      if (!isRecord(artifact)) {
        throw new Error(`${context}.contentItems.input_image.artifact must be an object`);
      }
      const rootId = artifact['rootId'];
      const selfId = artifact['selfId'];
      const status = artifact['status'];
      const relPath = artifact['relPath'];
      if (
        typeof rootId !== 'string' ||
        typeof selfId !== 'string' ||
        typeof relPath !== 'string' ||
        (status !== 'running' && status !== 'completed' && status !== 'archived')
      ) {
        throw new Error(`${context}.contentItems.input_image.artifact has invalid fields`);
      }
      parsed.push({
        type: 'input_image',
        mimeType,
        byteLength,
        artifact: {
          rootId,
          selfId,
          status,
          relPath,
        },
      });
      continue;
    }
    throw new Error(`${context}.contentItems item type is unsupported`);
  }
  return parsed;
}

function normalizePrimingRecordFromJson(raw: unknown): PrimingReplayRecord {
  if (!isRecord(raw)) {
    throw new Error('Priming record block must be a JSON object');
  }
  const type = raw['type'];
  if (typeof type !== 'string') {
    throw new Error('Priming record.type must be a string');
  }
  const context = `record(${type})`;
  const sourceTag = parseOptionalSourceTag(raw, context);

  switch (type) {
    case 'agent_thought_record': {
      const providerData = raw['provider_data'];
      if (providerData !== undefined && !isRecord(providerData)) {
        throw new Error(`${context}.provider_data must be an object when provided`);
      }
      const reasoning = parseOptionalReasoningPayload(raw['reasoning'], context);
      const record: AgentThoughtRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        content: expectStringField(raw, 'content', context, true),
      };
      if (reasoning !== undefined) {
        record.reasoning = reasoning;
      }
      if (providerData !== undefined) {
        record.provider_data = providerData as AgentThoughtRecord['provider_data'];
      }
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'agent_words_record': {
      const record: AgentWordsRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        content: expectStringField(raw, 'content', context, true),
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'ui_only_markdown_record': {
      const record: UiOnlyMarkdownRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        content: expectStringField(raw, 'content', context, true),
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'runtime_guide_record': {
      const record: RuntimeGuideRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        content: expectStringField(raw, 'content', context, true),
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'func_call_record': {
      const rawArgumentsText = raw['rawArgumentsText'];
      if (typeof rawArgumentsText !== 'string') {
        throw new Error(`${context}.rawArgumentsText must be a string`);
      }
      const record: FuncCallRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        id: expectStringField(raw, 'id', context),
        name: expectStringField(raw, 'name', context),
        rawArgumentsText,
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'tellask_call_record': {
      const base = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        id: expectStringField(raw, 'id', context),
      } as const;
      const name = expectStringField(raw, 'name', context);
      const rawArgumentsText = raw['rawArgumentsText'];
      if (typeof rawArgumentsText !== 'string') {
        throw new Error(`${context}.rawArgumentsText must be a string`);
      }
      const deliveryMode = raw['deliveryMode'];
      if (deliveryMode !== 'tellask_call_start' && deliveryMode !== 'func_call_requested') {
        throw new Error(
          `${context}.deliveryMode must be 'tellask_call_start' | 'func_call_requested'`,
        );
      }
      let record: TellaskCallRecord;
      switch (name) {
        case 'tellaskBack':
        case 'tellask':
        case 'tellaskSessionless':
        case 'replyTellask':
        case 'replyTellaskSessionless':
        case 'replyTellaskBack':
        case 'askHuman':
        case 'freshBootsReasoning': {
          record = { ...base, name, rawArgumentsText, deliveryMode };
          break;
        }
        default:
          throw new Error(`${context}.name must be a supported tellask function`);
      }
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'web_search_call_record': {
      const phase = raw['phase'];
      const source = raw['source'];
      if (phase !== 'added' && phase !== 'done') {
        throw new Error(`${context}.phase must be added | done`);
      }
      if (source !== undefined && source !== 'codex' && source !== 'openai_responses') {
        throw new Error(`${context}.source must be codex | openai_responses when provided`);
      }
      const itemId = raw['itemId'];
      const status = raw['status'];
      if (typeof itemId !== 'string' || itemId.trim() === '') {
        throw new Error(`${context}.itemId must be a non-empty string`);
      }
      if (status !== undefined && typeof status !== 'string') {
        throw new Error(`${context}.status must be a string when provided`);
      }
      const action = normalizeWebSearchAction(raw['action'], context);
      const record: WebSearchCallRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        phase,
      };
      if (source !== undefined) record.source = source;
      record.itemId = itemId.trim();
      if (status !== undefined) record.status = status;
      if (action !== undefined) record.action = action;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'native_tool_call_record': {
      const phase = raw['phase'];
      const source = raw['source'];
      const itemType = raw['itemType'];
      if (phase !== 'added' && phase !== 'done') {
        throw new Error(`${context}.phase must be added | done`);
      }
      if (source !== undefined && source !== 'openai_responses') {
        throw new Error(`${context}.source must be openai_responses when provided`);
      }
      switch (itemType) {
        case 'file_search_call':
        case 'code_interpreter_call':
        case 'image_generation_call':
        case 'mcp_call':
        case 'mcp_list_tools':
        case 'mcp_approval_request':
        case 'custom_tool_call':
          break;
        default:
          throw new Error(`${context}.itemType must be a supported native tool call type`);
      }
      const itemId = raw['itemId'];
      const callId = raw['callId'];
      const status = raw['status'];
      const title = raw['title'];
      const summary = raw['summary'];
      const detail = raw['detail'];
      if (itemId !== undefined && typeof itemId !== 'string') {
        throw new Error(`${context}.itemId must be a string when provided`);
      }
      if (callId !== undefined && typeof callId !== 'string') {
        throw new Error(`${context}.callId must be a string when provided`);
      }
      if (status !== undefined && typeof status !== 'string') {
        throw new Error(`${context}.status must be a string when provided`);
      }
      if (title !== undefined && typeof title !== 'string') {
        throw new Error(`${context}.title must be a string when provided`);
      }
      if (summary !== undefined && typeof summary !== 'string') {
        throw new Error(`${context}.summary must be a string when provided`);
      }
      if (detail !== undefined && typeof detail !== 'string') {
        throw new Error(`${context}.detail must be a string when provided`);
      }
      let record: NativeToolCallRecord;
      const genseq = expectIntegerField(raw, 'genseq', context);
      if (itemType === 'custom_tool_call') {
        if (typeof callId !== 'string' || callId.trim() === '') {
          throw new Error(`${context}.callId must be a non-empty string for custom_tool_call`);
        }
        if (typeof itemId === 'string' && itemId.trim() === '') {
          throw new Error(`${context}.itemId must be non-empty when provided for custom_tool_call`);
        }
        record = {
          ts: '',
          type,
          genseq,
          itemType,
          phase,
          callId: callId.trim(),
        };
        if (typeof itemId === 'string' && itemId.trim() !== '') record.itemId = itemId.trim();
      } else {
        if (callId !== undefined) {
          throw new Error(`${context}.callId is not allowed for non-custom native tool calls`);
        }
        if (typeof itemId !== 'string' || itemId.trim() === '') {
          throw new Error(`${context}.itemId must be a non-empty string for ${String(itemType)}`);
        }
        record = {
          ts: '',
          type,
          genseq,
          itemType,
          phase,
          itemId: itemId.trim(),
        };
      }
      if (source !== undefined) record.source = source;
      if (status !== undefined) record.status = status;
      if (title !== undefined) record.title = title;
      if (summary !== undefined) record.summary = summary;
      if (detail !== undefined) record.detail = detail;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'tool_result_image_ingest_record': {
      const disposition = raw['disposition'];
      if (
        disposition !== 'fed_native' &&
        disposition !== 'fed_provider_transformed' &&
        disposition !== 'filtered_provider_unsupported' &&
        disposition !== 'filtered_model_unsupported' &&
        disposition !== 'filtered_mime_unsupported' &&
        disposition !== 'filtered_size_limit' &&
        disposition !== 'filtered_read_failed' &&
        disposition !== 'filtered_missing'
      ) {
        throw new Error(`${context}.disposition is invalid`);
      }
      const artifactRaw = raw['artifact'];
      if (!isRecord(artifactRaw)) {
        throw new Error(`${context}.artifact must be an object`);
      }
      const rootId = artifactRaw['rootId'];
      const selfId = artifactRaw['selfId'];
      const status = artifactRaw['status'];
      const relPath = artifactRaw['relPath'];
      if (
        typeof rootId !== 'string' ||
        typeof selfId !== 'string' ||
        typeof relPath !== 'string' ||
        (status !== 'running' && status !== 'completed' && status !== 'archived')
      ) {
        throw new Error(`${context}.artifact has invalid fields`);
      }
      const detail = raw['detail'];
      if (detail !== undefined && typeof detail !== 'string') {
        throw new Error(`${context}.detail must be a string when provided`);
      }
      const record: ToolResultImageIngestRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        toolCallId: expectStringField(raw, 'toolCallId', context),
        toolName: expectStringField(raw, 'toolName', context),
        artifact: {
          rootId,
          selfId,
          status,
          relPath,
        },
        provider: expectStringField(raw, 'provider', context),
        model: expectStringField(raw, 'model', context),
        disposition,
        message: expectStringField(raw, 'message', context, true),
      };
      if (detail !== undefined) record.detail = detail;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'human_text_record': {
      const grammar = raw['grammar'];
      if (grammar !== 'markdown') {
        throw new Error(`${context}.grammar must be 'markdown'`);
      }
      const userLanguageCode = parseOptionalLanguageCodeField(raw, 'userLanguageCode', context);
      const q4hAnswerCallId = parseOptionalStringField(raw, 'q4hAnswerCallId', context);
      const tellaskReplyDirective = parseTellaskReplyDirective(raw, context);
      const record: HumanTextRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        msgId: expectStringField(raw, 'msgId', context),
        content: expectStringField(raw, 'content', context, true),
        grammar: 'markdown',
      };
      if (userLanguageCode !== undefined) record.userLanguageCode = userLanguageCode;
      if (q4hAnswerCallId !== undefined) record.q4hAnswerCallId = q4hAnswerCallId;
      if (tellaskReplyDirective !== undefined) record.tellaskReplyDirective = tellaskReplyDirective;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'func_result_record': {
      const record: FuncResultRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        id: expectStringField(raw, 'id', context),
        name: expectStringField(raw, 'name', context),
        content: expectStringField(raw, 'content', context, true),
      };
      const contentItems = normalizeFuncResultContentItems(raw['contentItems'], context);
      if (contentItems) record.contentItems = contentItems;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'tellask_result_record': {
      const callName = raw['callName'];
      if (
        callName !== 'tellaskBack' &&
        callName !== 'tellask' &&
        callName !== 'tellaskSessionless' &&
        callName !== 'askHuman' &&
        callName !== 'freshBootsReasoning'
      ) {
        throw new Error(`${context}.callName is invalid`);
      }
      const status = raw['status'];
      if (status !== 'pending' && status !== 'completed' && status !== 'failed') {
        throw new Error(`${context}.status must be pending | completed | failed`);
      }
      const originCourse = parseOptionalIntegerField(raw, 'originCourse', context);
      const callingGenseq = parseOptionalIntegerField(raw, 'calling_genseq', context);
      const callRaw = raw['call'];
      if (!isRecord(callRaw)) {
        throw new Error(`${context}.call must be an object`);
      }
      const responderRaw = raw['responder'];
      if (!isRecord(responderRaw)) {
        throw new Error(`${context}.responder must be an object`);
      }
      const routeRaw = raw['route'];
      if (routeRaw !== undefined && !isRecord(routeRaw)) {
        throw new Error(`${context}.route must be an object when provided`);
      }
      const route =
        routeRaw === undefined
          ? undefined
          : {
              ...(typeof routeRaw['calleeDialogId'] === 'string'
                ? { calleeDialogId: routeRaw['calleeDialogId'] }
                : routeRaw['calleeDialogId'] === undefined
                  ? {}
                  : (() => {
                      throw new Error(`${context}.route.calleeDialogId must be a string`);
                    })()),
              ...(parseOptionalIntegerField(routeRaw, 'calleeCourse', `${context}.route`) !==
              undefined
                ? {
                    calleeCourse: toCalleeCourseNumber(
                      parseOptionalIntegerField(routeRaw, 'calleeCourse', `${context}.route`)!,
                    ),
                  }
                : {}),
              ...(parseOptionalIntegerField(routeRaw, 'calleeGenseq', `${context}.route`) !==
              undefined
                ? {
                    calleeGenseq: toCalleeGenerationSeqNumber(
                      parseOptionalIntegerField(routeRaw, 'calleeGenseq', `${context}.route`)!,
                    ),
                  }
                : {}),
            };
      const responder = {
        responderId: expectStringField(responderRaw, 'responderId', `${context}.responder`),
        ...(typeof responderRaw['agentId'] === 'string'
          ? { agentId: responderRaw['agentId'] }
          : responderRaw['agentId'] === undefined
            ? {}
            : (() => {
                throw new Error(`${context}.responder.agentId must be a string`);
              })()),
        ...(typeof responderRaw['originMemberId'] === 'string'
          ? { originMemberId: responderRaw['originMemberId'] }
          : responderRaw['originMemberId'] === undefined
            ? {}
            : (() => {
                throw new Error(`${context}.responder.originMemberId must be a string`);
              })()),
      };
      const base = {
        ts: '',
        type,
        callId: expectStringField(raw, 'callId', context),
        status,
        content: expectStringField(raw, 'content', context, true),
        responder,
      } as const;
      const record: TellaskResultRecord = (() => {
        switch (callName) {
          case 'tellask': {
            const mentionList = parseOptionalStringArray(callRaw, 'mentionList', `${context}.call`);
            if (!mentionList) {
              throw new Error(`${context}.call.mentionList is required for tellask`);
            }
            return {
              ...base,
              callName,
              call: {
                tellaskContent: expectStringField(
                  callRaw,
                  'tellaskContent',
                  `${context}.call`,
                  true,
                ),
                mentionList,
                sessionSlug: expectStringField(callRaw, 'sessionSlug', `${context}.call`),
              },
            };
          }
          case 'tellaskSessionless': {
            const mentionList = parseOptionalStringArray(callRaw, 'mentionList', `${context}.call`);
            if (!mentionList) {
              throw new Error(`${context}.call.mentionList is required for tellaskSessionless`);
            }
            if (callRaw['sessionSlug'] !== undefined) {
              throw new Error(
                `${context}.call.sessionSlug must be undefined for tellaskSessionless`,
              );
            }
            return {
              ...base,
              callName,
              call: {
                tellaskContent: expectStringField(
                  callRaw,
                  'tellaskContent',
                  `${context}.call`,
                  true,
                ),
                mentionList,
              },
            };
          }
          case 'tellaskBack':
          case 'askHuman':
          case 'freshBootsReasoning':
            if (callRaw['mentionList'] !== undefined) {
              throw new Error(`${context}.call.mentionList must be undefined for ${callName}`);
            }
            if (callRaw['sessionSlug'] !== undefined) {
              throw new Error(`${context}.call.sessionSlug must be undefined for ${callName}`);
            }
            return {
              ...base,
              callName,
              call: {
                tellaskContent: expectStringField(
                  callRaw,
                  'tellaskContent',
                  `${context}.call`,
                  true,
                ),
              },
            };
        }
      })();
      if (originCourse !== undefined) {
        record.originCourse = toCallingCourseNumber(originCourse);
      }
      if (callingGenseq !== undefined) {
        record.calling_genseq = toCallingGenerationSeqNumber(callingGenseq);
      }
      if (route !== undefined) {
        record.route = route;
      }
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'quest_for_sup_record': {
      const mentionList = parseOptionalStringArray(raw, 'mentionList', context) ?? [];
      const record: QuestForSupRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        mentionList,
        tellaskContent: expectStringField(raw, 'tellaskContent', context, true),
        subDialogId: expectStringField(raw, 'subDialogId', context),
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'tellask_reply_resolution_record': {
      const replyCallName = raw['replyCallName'];
      if (
        replyCallName !== 'replyTellask' &&
        replyCallName !== 'replyTellaskSessionless' &&
        replyCallName !== 'replyTellaskBack'
      ) {
        throw new Error(`${context}.replyCallName must be a supported replyTellask* function`);
      }
      const record: TellaskReplyResolutionRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        callId: expectStringField(raw, 'callId', context),
        replyCallName,
        targetCallId: expectStringField(raw, 'targetCallId', context),
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'tellask_call_anchor_record': {
      const anchorRole = raw['anchorRole'];
      if (anchorRole !== 'assignment' && anchorRole !== 'response') {
        throw new Error(`${context}.anchorRole must be assignment | response`);
      }
      const assignmentCourse = parseOptionalIntegerField(raw, 'assignmentCourse', context);
      const assignmentGenseq = parseOptionalIntegerField(raw, 'assignmentGenseq', context);
      const callerDialogId = raw['callerDialogId'];
      const callerCourse = parseOptionalIntegerField(raw, 'callerCourse', context);
      if (callerDialogId !== undefined && typeof callerDialogId !== 'string') {
        throw new Error(`${context}.callerDialogId must be a string when provided`);
      }
      const baseRecord = {
        ts: '',
        type,
        ...toRootGenerationAnchor({
          rootCourse: expectIntegerField(raw, 'rootCourse', context),
          rootGenseq: expectIntegerField(raw, 'rootGenseq', context),
        }),
        callId: expectStringField(raw, 'callId', context),
        genseq: expectIntegerField(raw, 'genseq', context),
        ...(assignmentCourse !== undefined
          ? { assignmentCourse: toAssignmentCourseNumber(assignmentCourse) }
          : {}),
        ...(assignmentGenseq !== undefined
          ? { assignmentGenseq: toAssignmentGenerationSeqNumber(assignmentGenseq) }
          : {}),
      } as const;
      let record: TellaskCallAnchorRecord;
      switch (anchorRole) {
        case 'assignment':
          if (callerDialogId !== undefined || callerCourse !== undefined) {
            throw new Error(
              `${context} assignment anchor must not provide callerDialogId/callerCourse`,
            );
          }
          record = {
            ...baseRecord,
            anchorRole: 'assignment',
          };
          break;
        case 'response':
          if (typeof callerDialogId !== 'string' || callerDialogId.trim() === '') {
            throw new Error(`${context}.callerDialogId must be a non-empty string for response`);
          }
          if (callerCourse === undefined) {
            throw new Error(`${context}.callerCourse is required for response`);
          }
          record = {
            ...baseRecord,
            anchorRole: 'response',
            callerDialogId,
            callerCourse: toCallerCourseNumber(callerCourse),
          };
          break;
      }
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'tellask_carryover_record': {
      const callName = raw['callName'];
      if (
        callName !== 'tellask' &&
        callName !== 'tellaskSessionless' &&
        callName !== 'askHuman' &&
        callName !== 'freshBootsReasoning'
      ) {
        throw new Error(`${context}.callName is invalid`);
      }
      const status = raw['status'];
      if (status !== 'completed' && status !== 'failed') {
        throw new Error(`${context}.status must be completed | failed`);
      }
      const genseq = expectIntegerField(raw, 'genseq', context);
      const originCourse = expectIntegerField(raw, 'originCourse', context);
      const carryoverCourse = expectIntegerField(raw, 'carryoverCourse', context);
      const mentionList = parseOptionalStringArray(raw, 'mentionList', context);
      const sessionSlug = raw['sessionSlug'];
      const calleeCourse = parseOptionalIntegerField(raw, 'calleeCourse', context);
      const calleeGenseq = parseOptionalIntegerField(raw, 'calleeGenseq', context);
      const calleeDialogId = raw['calleeDialogId'];
      if (calleeDialogId !== undefined && typeof calleeDialogId !== 'string') {
        throw new Error(`${context}.calleeDialogId must be a string when provided`);
      }
      const base = {
        ts: '',
        type,
        genseq,
        originCourse: toCallingCourseNumber(originCourse),
        carryoverCourse: toDialogCourseNumber(carryoverCourse),
        responderId: expectStringField(raw, 'responderId', context),
        tellaskContent: expectStringField(raw, 'tellaskContent', context, true),
        status,
        response: expectStringField(raw, 'response', context, true),
        content: expectStringField(raw, 'content', context, true),
        agentId: expectStringField(raw, 'agentId', context),
        callId: expectStringField(raw, 'callId', context),
        originMemberId: expectStringField(raw, 'originMemberId', context),
      } as const;
      const record: TellaskCarryoverRecord = (() => {
        switch (callName) {
          case 'tellask': {
            if (!Array.isArray(mentionList)) {
              throw new Error(`${context}.mentionList is required for tellask carryover`);
            }
            if (typeof sessionSlug !== 'string' || sessionSlug.trim() === '') {
              throw new Error(`${context}.sessionSlug is required for tellask carryover`);
            }
            return {
              ...base,
              callName,
              sessionSlug: sessionSlug.trim(),
              mentionList,
            };
          }
          case 'tellaskSessionless': {
            if (!Array.isArray(mentionList)) {
              throw new Error(
                `${context}.mentionList is required for tellaskSessionless carryover`,
              );
            }
            if (sessionSlug !== undefined) {
              throw new Error(
                `${context}.sessionSlug must be undefined for tellaskSessionless carryover`,
              );
            }
            return {
              ...base,
              callName,
              mentionList,
            };
          }
          case 'askHuman':
            if (mentionList !== undefined) {
              throw new Error(`${context}.mentionList must be undefined for askHuman carryover`);
            }
            if (sessionSlug !== undefined) {
              throw new Error(`${context}.sessionSlug must be undefined for askHuman carryover`);
            }
            return {
              ...base,
              callName,
            };
          case 'freshBootsReasoning':
            if (mentionList !== undefined) {
              throw new Error(`${context}.mentionList must be undefined for FBR carryover`);
            }
            if (sessionSlug !== undefined) {
              throw new Error(`${context}.sessionSlug must be undefined for FBR carryover`);
            }
            return {
              ...base,
              callName,
            };
        }
      })();
      if (calleeDialogId !== undefined) record.calleeDialogId = calleeDialogId;
      if (calleeCourse !== undefined) {
        record.calleeCourse = toCalleeCourseNumber(calleeCourse);
      }
      if (calleeGenseq !== undefined) {
        record.calleeGenseq = toCalleeGenerationSeqNumber(calleeGenseq);
      }
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'gen_start_record': {
      const record: GenStartRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'gen_finish_record': {
      const contextHealth = raw['contextHealth'];
      const llmGenModel = raw['llmGenModel'];
      if (contextHealth !== undefined && !isRecord(contextHealth)) {
        throw new Error(`${context}.contextHealth must be an object when provided`);
      }
      if (llmGenModel !== undefined && typeof llmGenModel !== 'string') {
        throw new Error(`${context}.llmGenModel must be a string when provided`);
      }
      const record: GenFinishRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
      };
      if (contextHealth !== undefined) {
        record.contextHealth = contextHealth as GenFinishRecord['contextHealth'];
      }
      if (llmGenModel !== undefined) record.llmGenModel = llmGenModel;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    default:
      throw new Error(`Unsupported priming record type '${type}'`);
  }
}

function parseFuncCallRecordPayloadFromBlock(blockContent: string): Record<string, unknown> {
  const normalized = blockContent.trim();
  if (normalized === '') {
    throw new Error('func_call_record block must be a non-empty JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error: unknown) {
    throw new Error(
      `func_call_record block must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error('func_call_record block must be a JSON object');
  }
  const payload: Record<string, unknown> = { ...parsed };
  if (payload['type'] === undefined) {
    payload['type'] = 'func_call_record';
    return payload;
  }
  if (payload['type'] !== 'func_call_record') {
    throw new Error(
      `func_call_record JSON type mismatch: expected 'func_call_record', got '${String(payload['type'])}'`,
    );
  }
  return payload;
}

function parseMarkdownRecordPayloadFromBlock(
  recordType: PrimingRecordType,
  blockContent: string,
): Record<string, unknown> {
  const { body, frontmatter } = parseFrontmatter(blockContent);
  if (frontmatter['type'] !== undefined) {
    throw new Error(`record(${recordType}) markdown block must not define 'type' in frontmatter`);
  }

  const payload: Record<string, unknown> = {
    type: recordType,
    ...frontmatter,
  };
  const textField = getRecordMarkdownTextField(recordType);
  if (textField === null) {
    if (body.trim() !== '') {
      throw new Error(`record(${recordType}) does not accept markdown body content`);
    }
    return payload;
  }

  payload[textField] = body;
  if (recordType === 'human_text_record' && payload['grammar'] === undefined) {
    payload['grammar'] = 'markdown';
  }
  return payload;
}

function parseRecordsFromBody(body: string): PrimingReplayRecord[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const records: PrimingReplayRecord[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const heading = parsePrimingHeading(line);
    if (!heading) {
      index += 1;
      continue;
    }
    index += 1;
    const parsedBlock = parseContentBlock(lines, index, `record ${heading.type}`);
    index = parsedBlock.nextIndex;

    const payload =
      heading.type === 'func_call_record'
        ? parseFuncCallRecordPayloadFromBlock(parsedBlock.content)
        : parseMarkdownRecordPayloadFromBlock(heading.type, parsedBlock.content);

    const normalizedRecord = normalizePrimingRecordFromJson(payload);
    if (normalizedRecord.type !== heading.type) {
      throw new Error(
        `Priming record heading type '${heading.type}' does not match parsed type '${normalizedRecord.type}'`,
      );
    }
    records.push(normalizedRecord);
  }
  if (records.length === 0) {
    throw new Error("Priming script must contain at least one '### record <type>' block");
  }
  return records;
}

function parsePrimingScript(raw: string): ParsedPrimingScript {
  const { body, frontmatter } = parseFrontmatter(raw);
  const titleRaw = frontmatter['title'];
  const title =
    typeof titleRaw === 'string' && titleRaw.trim() !== '' ? titleRaw.trim() : undefined;
  const applicableMemberIds = parseApplicableMemberIds(frontmatter);
  const reminders = parseReminderSnapshots(frontmatter);
  const records = parseRecordsFromBody(body);
  return { title, applicableMemberIds, reminders, records };
}

async function listMarkdownFilesRecursively(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  for (const entry of entries) {
    const absPath = path.resolve(dirPath, entry.name);
    if (!ensureInside(dirPath, absPath)) {
      throw new Error(`Invalid file discovered outside expected directory: ${absPath}`);
    }
    if (entry.isDirectory()) {
      const childFiles = await listMarkdownFilesRecursively(absPath);
      files.push(...childFiles);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(absPath);
    }
  }
  return files;
}

export async function validateAllPrimingScriptsInRtws(): Promise<PrimingScriptsValidationResult> {
  const absFiles = await listMarkdownFilesRecursively(PRIMING_ROOT_DIR);
  const sorted = [...absFiles].sort((a, b) => a.localeCompare(b));
  const issues: PrimingScriptValidationIssue[] = [];

  for (const absPath of sorted) {
    const relPath = path.relative(process.cwd(), absPath).replace(/\\/g, '/');
    try {
      const st = await fs.stat(absPath);
      if (!st.isFile()) {
        throw new Error('not a regular file');
      }
      // Validate both path convention and content format.
      parseSummaryFromAbsolutePath(absPath);
      const raw = await fs.readFile(absPath, 'utf-8');
      parsePrimingScript(raw);
    } catch (error: unknown) {
      issues.push({
        path: relPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    checked: sorted.length,
    failed: issues.length,
    issues,
  };
}

function parseSummaryFromAbsolutePath(
  absPath: string,
): Omit<PrimingScriptSummary, 'updatedAt' | 'title'> {
  const rel = path.relative(PRIMING_ROOT_DIR, absPath).replace(/\\/g, '/');
  const relNoExt = rel.toLowerCase().endsWith('.md') ? rel.slice(0, -'.md'.length) : rel;
  const parts = relNoExt.split('/');
  if (parts[0] === 'individual') {
    if (parts.length < 3) {
      throw new Error(`Invalid individual priming script path: ${rel}`);
    }
    const ownerAgentId = parts[1];
    const slug = parts.slice(2).join('/');
    return {
      ref: relNoExt,
      scope: 'individual',
      slug,
      ownerAgentId,
      path: `.minds/priming/${relNoExt}.md`,
    };
  }
  if (parts[0] === 'team_shared') {
    if (parts.length < 2) {
      throw new Error(`Invalid team_shared priming script path: ${rel}`);
    }
    const slug = parts.slice(1).join('/');
    return {
      ref: relNoExt,
      scope: 'team_shared',
      slug,
      path: `.minds/priming/${relNoExt}.md`,
    };
  }
  throw new Error(`Unsupported priming scope in path: ${rel}`);
}

async function loadScriptFromAbsolutePath(absPath: string): Promise<{
  summary: PrimingScriptSummary;
  parsed: ParsedPrimingScript;
}> {
  const st = await fs.stat(absPath);
  if (!st.isFile()) {
    throw new Error(`Priming script is not a file: ${absPath}`);
  }
  const raw = await fs.readFile(absPath, 'utf-8');
  const parsed = parsePrimingScript(raw);
  const summaryWithoutMeta = parseSummaryFromAbsolutePath(absPath);
  const summary: PrimingScriptSummary = {
    ...summaryWithoutMeta,
    title: parsed.title,
    updatedAt: formatUnifiedTimestamp(st.mtime),
  };
  return { summary, parsed };
}

function isScriptApplicableToAgent(
  script: { summary: PrimingScriptSummary; parsed: ParsedPrimingScript },
  agentId: string,
): boolean {
  if (script.summary.scope === 'individual') {
    return script.summary.ownerAgentId === agentId;
  }
  const applicableMemberIds = script.parsed.applicableMemberIds;
  if (!applicableMemberIds || applicableMemberIds.length === 0) {
    return true;
  }
  return applicableMemberIds.includes(agentId);
}

function normalizeRecentUsageAgentId(agentIdRaw: string): string {
  const agentId = agentIdRaw.trim();
  if (agentId === '') {
    throw new Error('agentId is required');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
    throw new Error(
      `agentId '${agentId}' is not allowed for recent-priming file naming; expected [A-Za-z0-9._-]+`,
    );
  }
  return agentId;
}

function resolveRecentUsageFilePath(agentIdRaw: string): string {
  const agentId = normalizeRecentUsageAgentId(agentIdRaw);
  const absPath = path.resolve(RECENT_PRIMING_DIR, `${agentId}.json`);
  if (!ensureInside(RECENT_PRIMING_DIR, absPath)) {
    throw new Error(`Recent-priming path escapes expected directory: ${absPath}`);
  }
  return absPath;
}

async function loadRecentUsage(agentIdRaw: string): Promise<PrimingRecentScriptFile> {
  const filePath = resolveRecentUsageFilePath(agentIdRaw);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error(`recent-priming file must be an object: ${filePath}`);
    }
    if (parsed['version'] !== 1) {
      throw new Error(
        `Unsupported recent-priming version in ${filePath}: ${String(parsed['version'])}`,
      );
    }
    const entriesRaw = parsed['entries'];
    if (!Array.isArray(entriesRaw)) {
      throw new Error(`recent-priming entries must be an array: ${filePath}`);
    }
    const entries: PrimingRecentScriptEntry[] = [];
    for (const entryRaw of entriesRaw) {
      if (!isRecord(entryRaw)) {
        throw new Error(`recent-priming entry must be an object: ${filePath}`);
      }
      const scriptRef =
        typeof entryRaw['scriptRef'] === 'string' ? entryRaw['scriptRef'].trim() : '';
      const lastUsedAt =
        typeof entryRaw['lastUsedAt'] === 'string' ? entryRaw['lastUsedAt'].trim() : '';
      if (!scriptRef || !lastUsedAt) {
        throw new Error(`recent-priming entry has empty fields: ${filePath}`);
      }
      const normalized = normalizeScriptRef(scriptRef);
      if (!normalized) {
        throw new Error(`recent-priming contains invalid scriptRef '${scriptRef}': ${filePath}`);
      }
      entries.push({ scriptRef: normalized, lastUsedAt });
    }
    return { version: 1, entries };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return { version: 1, entries: [] };
    }
    throw error;
  }
}

async function saveRecentUsage(agentIdRaw: string, file: PrimingRecentScriptFile): Promise<void> {
  const filePath = resolveRecentUsageFilePath(agentIdRaw);
  await fs.mkdir(RECENT_PRIMING_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
}

export async function recordRecentPrimingUsage(
  agentIdRaw: string,
  scriptRefs: string[],
): Promise<void> {
  const agentId = normalizeRecentUsageAgentId(agentIdRaw);
  const now = formatUnifiedTimestamp(new Date());
  const usage = await loadRecentUsage(agentId);
  const byKey = new Map<string, PrimingRecentScriptEntry>();
  for (const entry of usage.entries) {
    byKey.set(entry.scriptRef, entry);
  }
  for (const ref of scriptRefs) {
    const normalized = normalizeScriptRef(ref);
    if (!normalized) {
      throw new Error(`Invalid scriptRef in recent usage update: ${ref}`);
    }
    byKey.set(normalized, {
      scriptRef: normalized,
      lastUsedAt: now,
    });
  }

  const nextEntries = Array.from(byKey.values()).sort((a, b) => {
    if (a.lastUsedAt === b.lastUsedAt) {
      return a.scriptRef.localeCompare(b.scriptRef);
    }
    return a.lastUsedAt > b.lastUsedAt ? -1 : 1;
  });

  await saveRecentUsage(agentId, {
    version: 1,
    entries: nextEntries.slice(0, RECENT_PRIMING_MAX),
  });
}

type LoadScriptSummaryByRefResult =
  | { kind: 'found'; summary: PrimingScriptSummary }
  | { kind: 'skip' }
  | { kind: 'warn'; issue: PrimingScriptLoadIssue };

function warningPathFromScriptRef(scriptRefRaw: string): string {
  const normalized = normalizeScriptRef(scriptRefRaw);
  if (normalized) return `.minds/priming/${normalized}.md`;
  const fallback = scriptRefRaw.trim();
  return fallback !== '' ? fallback : '<empty-script-ref>';
}

function warningPathFromAbsolutePath(absPath: string): string {
  return path.relative(process.cwd(), absPath).replace(/\\/g, '/');
}

function toIssue(error: unknown, pathText: string): PrimingScriptLoadIssue {
  return {
    path: pathText,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function loadScriptSummaryByRefForAgent(
  scriptRefRaw: string,
  agentIdRaw: string,
): Promise<LoadScriptSummaryByRefResult> {
  try {
    const loaded = await loadPrimingScriptByRef(scriptRefRaw, agentIdRaw);
    return { kind: 'found', summary: loaded.summary };
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (
        error.message.includes('not applicable') ||
        error.message.includes('Invalid priming script ref') ||
        error.message.includes('ENOENT')
      ) {
        return { kind: 'skip' };
      }
    }
    return {
      kind: 'warn',
      issue: toIssue(error, warningPathFromScriptRef(scriptRefRaw)),
    };
  }
}

export async function listApplicablePrimingScripts(agentIdRaw: string): Promise<{
  recent: PrimingScriptSummary[];
  warnings: PrimingScriptLoadIssue[];
}> {
  const agentId = agentIdRaw.trim();
  if (agentId === '') {
    throw new Error('agentId is required for listing priming scripts');
  }

  const recentUsage = await loadRecentUsage(agentId);
  const recent: PrimingScriptSummary[] = [];
  const warnings: PrimingScriptLoadIssue[] = [];
  const seen = new Set<string>();
  for (const entry of recentUsage.entries) {
    if (seen.has(entry.scriptRef)) continue;
    seen.add(entry.scriptRef);
    const loaded = await loadScriptSummaryByRefForAgent(entry.scriptRef, agentId);
    if (loaded.kind === 'skip') continue;
    if (loaded.kind === 'warn') {
      warnings.push(loaded.issue);
      continue;
    }
    recent.push(loaded.summary);
  }

  return { recent, warnings };
}

export async function searchApplicablePrimingScripts(args: {
  agentId: string;
  query: string;
  limit?: number;
}): Promise<{
  scripts: PrimingScriptSummary[];
  warnings: PrimingScriptLoadIssue[];
}> {
  const agentId = args.agentId.trim();
  if (agentId === '') {
    throw new Error('agentId is required for searching priming scripts');
  }
  const query = args.query.trim().toLowerCase();
  if (query === '') {
    return { scripts: [], warnings: [] };
  }
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
      ? Math.floor(args.limit)
      : 50;

  const individualDir = path.resolve(PRIMING_INDIVIDUAL_DIR, agentId);
  const individualFiles = await listMarkdownFilesRecursively(individualDir);
  const teamSharedFiles = await listMarkdownFilesRecursively(PRIMING_TEAM_SHARED_DIR);

  const matched: PrimingScriptSummary[] = [];
  const warnings: PrimingScriptLoadIssue[] = [];
  for (const absPath of [...individualFiles, ...teamSharedFiles]) {
    let script: { summary: PrimingScriptSummary; parsed: ParsedPrimingScript };
    try {
      script = await loadScriptFromAbsolutePath(absPath);
    } catch (error: unknown) {
      warnings.push(toIssue(error, warningPathFromAbsolutePath(absPath)));
      continue;
    }
    if (!isScriptApplicableToAgent(script, agentId)) continue;
    const summary = script.summary;
    const title = typeof summary.title === 'string' ? summary.title.toLowerCase() : '';
    if (
      !summary.slug.toLowerCase().includes(query) &&
      !summary.ref.toLowerCase().includes(query) &&
      !title.includes(query)
    ) {
      continue;
    }
    matched.push(summary);
  }

  matched.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.ref.localeCompare(b.ref);
    return a.updatedAt > b.updatedAt ? -1 : 1;
  });
  return { scripts: matched.slice(0, limit), warnings };
}

export async function loadPrimingScriptByRef(
  scriptRefRaw: string,
  agentIdRaw: string,
): Promise<{
  summary: PrimingScriptSummary;
  reminders: Reminder[];
  records: PrimingReplayRecord[];
}> {
  const agentId = agentIdRaw.trim();
  if (agentId === '') {
    throw new Error('agentId is required');
  }
  const scriptRef = normalizeScriptRef(scriptRefRaw);
  if (!scriptRef) {
    throw new Error(`Invalid priming script ref: ${scriptRefRaw}`);
  }

  const absPath = scriptRefToAbsolutePath(scriptRef);
  if (!ensureInside(PRIMING_ROOT_DIR, absPath)) {
    throw new Error(`Priming script path escapes priming root: ${scriptRef}`);
  }
  const loaded = await loadScriptFromAbsolutePath(absPath);
  if (!isScriptApplicableToAgent(loaded, agentId)) {
    throw new Error(`Priming script is not applicable to agent '${agentId}': ${scriptRef}`);
  }
  return {
    summary: loaded.summary,
    reminders: (loaded.parsed.reminders ?? []).map((item, index) =>
      materializeReminderSnapshot(
        item,
        `priming script '${scriptRef}' frontmatter.reminders[${String(index)}]`,
      ),
    ),
    records: loaded.parsed.records,
  };
}

function remapRecordGenseq(
  record: PrimingReplayRecord,
  mapGenseq: (value: number) => number,
): PrimingReplayRecord {
  const remapOptionalGenseq = (value: number | undefined): number | undefined => {
    if (typeof value !== 'number') return undefined;
    return mapGenseq(value);
  };

  switch (record.type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'runtime_guide_record':
    case 'func_call_record':
    case 'tellask_call_record':
    case 'web_search_call_record':
    case 'tool_result_image_ingest_record':
    case 'native_tool_call_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'quest_for_sup_record':
    case 'tellask_call_anchor_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return { ...record, genseq: mapGenseq(record.genseq) };
    case 'tellask_result_record':
      return {
        ...record,
        calling_genseq:
          record.calling_genseq !== undefined
            ? toCallingGenerationSeqNumber(remapOptionalGenseq(record.calling_genseq)!)
            : undefined,
      };
    case 'tellask_reply_resolution_record':
    case 'tellask_carryover_record':
      return { ...record, genseq: mapGenseq(record.genseq) };
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled priming record in remapRecordGenseq: ${String(_exhaustive)}`);
    }
  }
}

function remapScriptRecordsForReplay(
  records: PrimingReplayRecord[],
  nextGenseqStart: number,
): { records: PrimingReplayRecord[]; nextGenseq: number } {
  const genseqMap = new Map<number, number>();
  let nextGenseq = nextGenseqStart;
  const mapGenseq = (value: number): number => {
    const existing = genseqMap.get(value);
    if (existing !== undefined) return existing;
    const assigned = nextGenseq;
    genseqMap.set(value, assigned);
    nextGenseq += 1;
    return assigned;
  };
  const remapped = records.map((record) => remapRecordGenseq(record, mapGenseq));
  return { records: remapped, nextGenseq };
}

function getNextDialogGenseq(dialog: Dialog): number {
  let maxGenseq = 0;
  for (const msg of dialog.msgs) {
    const candidate =
      'genseq' in msg && typeof msg.genseq === 'number' && Number.isFinite(msg.genseq)
        ? msg.genseq
        : 0;
    if (candidate > maxGenseq) maxGenseq = candidate;
  }
  return maxGenseq + 1;
}

function addPrimingSourceTag(record: PrimingReplayRecord): PrimingReplayRecord {
  switch (record.type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'runtime_guide_record':
    case 'func_call_record':
    case 'tellask_call_record':
    case 'web_search_call_record':
    case 'tool_result_image_ingest_record':
    case 'native_tool_call_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'tellask_result_record':
    case 'quest_for_sup_record':
    case 'tellask_reply_resolution_record':
    case 'tellask_call_anchor_record':
    case 'tellask_carryover_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return { ...record, sourceTag: 'priming_script' };
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled priming record in addPrimingSourceTag: ${String(_exhaustive)}`);
    }
  }
}

function withTimestamp(record: PrimingReplayRecord, ts: string): PersistedDialogRecord {
  switch (record.type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'runtime_guide_record':
    case 'func_call_record':
    case 'tellask_call_record':
    case 'web_search_call_record':
    case 'tool_result_image_ingest_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'tellask_result_record':
    case 'quest_for_sup_record':
    case 'tellask_reply_resolution_record':
    case 'tellask_call_anchor_record':
    case 'tellask_carryover_record':
    case 'native_tool_call_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return { ts, ...record };
    default: {
      const _exhaustive: never = record;
      throw new Error(`Unhandled priming record in withTimestamp: ${String(_exhaustive)}`);
    }
  }
}

function primingRecordToChatMessage(record: PrimingReplayRecord): ChatMessage | null {
  switch (record.type) {
    case 'agent_thought_record':
      return {
        type: 'thinking_msg',
        role: 'assistant',
        genseq: record.genseq,
        content: record.content,
        reasoning: record.reasoning,
        provider_data: record.provider_data,
      };
    case 'agent_words_record':
      return {
        type: 'saying_msg',
        role: 'assistant',
        genseq: record.genseq,
        content: record.content,
      };
    case 'ui_only_markdown_record':
      return null;
    case 'runtime_guide_record':
      return {
        type: 'transient_guide_msg',
        role: 'assistant',
        content: record.content,
      };
    case 'human_text_record':
      return {
        type: 'prompting_msg',
        role: 'user',
        genseq: record.genseq,
        msgId: record.msgId,
        content: record.content,
        grammar: 'markdown',
      };
    case 'func_call_record':
      return {
        type: 'func_call_msg',
        role: 'assistant',
        genseq: record.genseq,
        id: record.id,
        name: record.name,
        arguments: record.rawArgumentsText,
      };
    case 'tellask_call_record':
      return {
        type: 'func_call_msg',
        role: 'assistant',
        genseq: record.genseq,
        id: record.id,
        name: record.name,
        arguments: record.rawArgumentsText,
      };
    case 'func_result_record':
      return {
        type: 'func_result_msg',
        role: 'tool',
        genseq: record.genseq,
        id: record.id,
        name: record.name,
        content: record.content,
        contentItems: record.contentItems,
      };
    case 'tellask_result_record':
      return {
        type: 'tellask_result_msg',
        role: 'tool',
        callId: record.callId,
        callName: record.callName,
        status: record.status,
        content: record.content,
        ...(record.originCourse !== undefined ? { originCourse: record.originCourse } : {}),
        ...(record.calling_genseq !== undefined ? { calling_genseq: record.calling_genseq } : {}),
        call: record.call,
        responder: record.responder,
        ...(record.route ? { route: record.route } : {}),
        responderId: record.responder.responderId,
        ...(record.callName === 'tellask' || record.callName === 'tellaskSessionless'
          ? { mentionList: record.call.mentionList }
          : {}),
        tellaskContent: record.call.tellaskContent,
        ...(record.callName === 'tellask' ? { sessionSlug: record.call.sessionSlug } : {}),
        ...(record.responder.agentId ? { agentId: record.responder.agentId } : {}),
        ...(record.responder.originMemberId
          ? { originMemberId: record.responder.originMemberId }
          : {}),
        ...(record.route?.calleeDialogId ? { calleeDialogId: record.route.calleeDialogId } : {}),
        ...(record.route?.calleeCourse !== undefined
          ? { calleeCourse: record.route.calleeCourse }
          : {}),
        ...(record.route?.calleeGenseq !== undefined
          ? { calleeGenseq: record.route.calleeGenseq }
          : {}),
      };
    case 'tellask_carryover_record':
      return {
        type: 'tellask_carryover_msg',
        role: 'user',
        genseq: record.genseq,
        content: record.content,
        originCourse: record.originCourse,
        carryoverCourse: record.carryoverCourse,
        responderId: record.responderId,
        callName: record.callName,
        tellaskContent: record.tellaskContent,
        status: record.status,
        response: record.response,
        agentId: record.agentId,
        callId: record.callId,
        originMemberId: record.originMemberId,
        ...(record.callName === 'tellask'
          ? {
              mentionList: record.mentionList,
              sessionSlug: record.sessionSlug,
            }
          : record.callName === 'tellaskSessionless'
            ? {
                mentionList: record.mentionList,
              }
            : {}),
        ...(record.calleeDialogId ? { calleeDialogId: record.calleeDialogId } : {}),
        ...(record.calleeCourse !== undefined ? { calleeCourse: record.calleeCourse } : {}),
        ...(record.calleeGenseq !== undefined ? { calleeGenseq: record.calleeGenseq } : {}),
      };
    case 'web_search_call_record':
    case 'tool_result_image_ingest_record':
    case 'native_tool_call_record':
    case 'quest_for_sup_record':
    case 'tellask_call_anchor_record':
    case 'tellask_reply_resolution_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return null;
    default: {
      const _exhaustive: never = record;
      throw new Error(
        `Unhandled priming record in primingRecordToChatMessage: ${String(_exhaustive)}`,
      );
    }
  }
}

export async function applyPrimingScriptsToDialog(args: {
  dialog: Dialog;
  agentId: string;
  status: DialogStatusKind;
  priming: DialogPrimingInput;
}): Promise<{
  appliedScriptRefs: string[];
  appendedMessageCount: number;
}> {
  const agentId = args.agentId.trim();
  if (agentId === '') {
    throw new Error('agentId is required');
  }

  const normalizedRefs: string[] = [];
  const seen = new Set<string>();
  for (const raw of args.priming.scriptRefs) {
    const normalized = normalizeScriptRef(raw);
    if (!normalized) {
      throw new Error(`Invalid priming script ref: ${raw}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedRefs.push(normalized);
  }
  if (normalizedRefs.length === 0) {
    return { appliedScriptRefs: [], appendedMessageCount: 0 };
  }

  const allRecords: PrimingReplayRecord[] = [];
  const allReminders: Reminder[] = [];
  let nextGenseq = getNextDialogGenseq(args.dialog);
  for (const scriptRef of normalizedRefs) {
    const loaded = await loadPrimingScriptByRef(scriptRef, agentId);
    const remapped = remapScriptRecordsForReplay(loaded.records, nextGenseq);
    nextGenseq = remapped.nextGenseq;
    allReminders.push(...loaded.reminders);
    allRecords.push(...remapped.records);
  }
  if (allRecords.length === 0) {
    return { appliedScriptRefs: normalizedRefs, appendedMessageCount: 0 };
  }

  if (allReminders.length > 0) {
    args.dialog.reminders.splice(0, args.dialog.reminders.length, ...allReminders);
    await DialogPersistence._saveReminderState(
      args.dialog.id,
      [...args.dialog.reminders],
      args.status,
    );
    await DialogPersistence.appendRemindersReconciledRecord(
      args.dialog.id,
      args.dialog.reminders,
      {
        kind: 'root_anchor',
        rootAnchor: toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 0 }),
      },
      args.status,
    );
  }

  for (const record of allRecords) {
    const withSourceTag = addPrimingSourceTag(record);
    const persisted = withTimestamp(withSourceTag, formatUnifiedTimestamp(new Date()));
    await DialogPersistence.appendEvent(args.dialog.id, 1, persisted, args.status);
    const chatMessage = primingRecordToChatMessage(withSourceTag);
    if (chatMessage !== null) {
      args.dialog.msgs.push(chatMessage);
    }
  }

  await recordRecentPrimingUsage(agentId, normalizedRefs);
  return {
    appliedScriptRefs: normalizedRefs,
    appendedMessageCount: allRecords.length,
  };
}

function formatScriptMarkdown(args: {
  frontmatter: Record<string, unknown>;
  records: PrimingReplayRecord[];
}): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(YAML.stringify(args.frontmatter).trimEnd());
  lines.push('---');
  lines.push('');
  lines.push('# Agent Priming Script');
  lines.push('');
  lines.push('## Records');
  lines.push('');

  for (const record of args.records) {
    lines.push(`### record ${record.type}`);
    if (record.type === 'func_call_record') {
      lines.push('```json');
      lines.push(JSON.stringify(record, null, 2));
      lines.push('```');
      lines.push('');
      continue;
    }

    const markdownFence = '``````';
    const blockMeta: Record<string, unknown> = {};
    let blockBody: string | undefined;
    switch (record.type) {
      case 'agent_thought_record': {
        blockMeta['genseq'] = record.genseq;
        if (record.reasoning !== undefined) blockMeta['reasoning'] = record.reasoning;
        if (record.provider_data !== undefined) blockMeta['provider_data'] = record.provider_data;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.content;
        break;
      }
      case 'agent_words_record': {
        blockMeta['genseq'] = record.genseq;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.content;
        break;
      }
      case 'ui_only_markdown_record': {
        blockMeta['genseq'] = record.genseq;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.content;
        break;
      }
      case 'runtime_guide_record': {
        blockMeta['genseq'] = record.genseq;
        blockBody = record.content;
        break;
      }
      case 'web_search_call_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['phase'] = record.phase;
        if (record.source !== undefined) blockMeta['source'] = record.source;
        if (record.itemId !== undefined) blockMeta['itemId'] = record.itemId;
        if (record.status !== undefined) blockMeta['status'] = record.status;
        if (record.action !== undefined) blockMeta['action'] = record.action;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        break;
      }
      case 'tool_result_image_ingest_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['toolCallId'] = record.toolCallId;
        blockMeta['toolName'] = record.toolName;
        blockMeta['artifact'] = record.artifact;
        blockMeta['provider'] = record.provider;
        blockMeta['model'] = record.model;
        blockMeta['disposition'] = record.disposition;
        if (record.detail !== undefined) blockMeta['detail'] = record.detail;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.message;
        break;
      }
      case 'human_text_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['msgId'] = record.msgId;
        blockMeta['grammar'] = record.grammar;
        if (record.userLanguageCode !== undefined)
          blockMeta['userLanguageCode'] = record.userLanguageCode;
        // Preserve this technical continuation marker verbatim in priming dumps for debugging.
        if (record.q4hAnswerCallId !== undefined)
          blockMeta['q4hAnswerCallId'] = record.q4hAnswerCallId;
        if (record.tellaskReplyDirective !== undefined)
          blockMeta['tellaskReplyDirective'] = record.tellaskReplyDirective;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.content;
        break;
      }
      case 'func_result_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['id'] = record.id;
        blockMeta['name'] = record.name;
        if (record.contentItems !== undefined) blockMeta['contentItems'] = record.contentItems;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.content;
        break;
      }
      case 'quest_for_sup_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['mentionList'] = record.mentionList;
        blockMeta['subDialogId'] = record.subDialogId;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.tellaskContent;
        break;
      }
      case 'tellask_call_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['id'] = record.id;
        blockMeta['name'] = record.name;
        blockMeta['deliveryMode'] = record.deliveryMode;
        blockMeta['rawArgumentsText'] = record.rawArgumentsText;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = '';
        break;
      }
      case 'tellask_reply_resolution_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['callId'] = record.callId;
        blockMeta['replyCallName'] = record.replyCallName;
        blockMeta['targetCallId'] = record.targetCallId;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        break;
      }
      case 'tellask_call_anchor_record': {
        blockMeta['anchorRole'] = record.anchorRole;
        blockMeta['callId'] = record.callId;
        blockMeta['genseq'] = record.genseq;
        if (record.assignmentCourse !== undefined)
          blockMeta['assignmentCourse'] = record.assignmentCourse;
        if (record.assignmentGenseq !== undefined)
          blockMeta['assignmentGenseq'] = record.assignmentGenseq;
        if (record.callerDialogId !== undefined)
          blockMeta['callerDialogId'] = record.callerDialogId;
        if (record.callerCourse !== undefined) blockMeta['callerCourse'] = record.callerCourse;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        break;
      }
      case 'tellask_result_record': {
        blockMeta['callId'] = record.callId;
        blockMeta['callName'] = record.callName;
        blockMeta['status'] = record.status;
        if (record.originCourse !== undefined) blockMeta['originCourse'] = record.originCourse;
        blockMeta['call'] = record.call;
        blockMeta['responder'] = record.responder;
        if (record.calling_genseq !== undefined)
          blockMeta['calling_genseq'] = record.calling_genseq;
        if (record.route !== undefined) blockMeta['route'] = record.route;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.content;
        break;
      }
      case 'tellask_carryover_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['originCourse'] = record.originCourse;
        blockMeta['carryoverCourse'] = record.carryoverCourse;
        blockMeta['responderId'] = record.responderId;
        blockMeta['callName'] = record.callName;
        switch (record.callName) {
          case 'tellask':
            blockMeta['sessionSlug'] = record.sessionSlug;
            blockMeta['mentionList'] = record.mentionList;
            break;
          case 'tellaskSessionless':
            blockMeta['mentionList'] = record.mentionList;
            break;
          case 'askHuman':
          case 'freshBootsReasoning':
            break;
        }
        blockMeta['tellaskContent'] = record.tellaskContent;
        blockMeta['status'] = record.status;
        blockMeta['agentId'] = record.agentId;
        blockMeta['callId'] = record.callId;
        blockMeta['originMemberId'] = record.originMemberId;
        blockMeta['content'] = record.content;
        if (record.calleeDialogId !== undefined)
          blockMeta['calleeDialogId'] = record.calleeDialogId;
        if (record.calleeCourse !== undefined) blockMeta['calleeCourse'] = record.calleeCourse;
        if (record.calleeGenseq !== undefined) blockMeta['calleeGenseq'] = record.calleeGenseq;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.response;
        break;
      }
      case 'gen_start_record': {
        blockMeta['genseq'] = record.genseq;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        break;
      }
      case 'gen_finish_record': {
        blockMeta['genseq'] = record.genseq;
        if (record.contextHealth !== undefined) blockMeta['contextHealth'] = record.contextHealth;
        if (record.llmGenModel !== undefined) blockMeta['llmGenModel'] = record.llmGenModel;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        break;
      }
      case 'native_tool_call_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['itemType'] = record.itemType;
        blockMeta['phase'] = record.phase;
        if (record.source !== undefined) blockMeta['source'] = record.source;
        if (record.itemId !== undefined) blockMeta['itemId'] = record.itemId;
        if (record.itemType === 'custom_tool_call') blockMeta['callId'] = record.callId;
        if (record.status !== undefined) blockMeta['status'] = record.status;
        if (record.title !== undefined) blockMeta['title'] = record.title;
        if (record.summary !== undefined) blockMeta['summary'] = record.summary;
        if (record.detail !== undefined) blockMeta['detail'] = record.detail;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        break;
      }
      default: {
        const _exhaustive: never = record;
        throw new Error(`Unhandled priming record in formatScriptMarkdown: ${String(_exhaustive)}`);
      }
    }

    lines.push(`${markdownFence}markdown`);
    lines.push('---');
    lines.push(YAML.stringify(blockMeta).trimEnd());
    lines.push('---');
    if (blockBody !== undefined) {
      lines.push(blockBody);
    }
    lines.push(markdownFence);
    lines.push('');
  }

  return lines.join('\n');
}

function stripTimestampFromRecord(event: PersistedDialogRecord): PrimingReplayRecord {
  switch (event.type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'runtime_guide_record':
    case 'func_call_record':
    case 'tellask_call_record':
    case 'web_search_call_record':
    case 'tool_result_image_ingest_record':
    case 'native_tool_call_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'tellask_result_record':
    case 'quest_for_sup_record':
    case 'tellask_call_anchor_record':
    case 'tellask_carryover_record':
    case 'gen_start_record':
    case 'gen_finish_record': {
      const { ts: _unusedTs, ...withoutTs } = event;
      return withoutTs;
    }
    case 'subdialog_created_record':
    case 'reminders_reconciled_record':
    case 'questions4human_reconciled_record':
    case 'pending_subdialogs_reconciled_record':
    case 'subdialog_registry_reconciled_record':
    case 'subdialog_responses_reconciled_record':
    case 'tellask_reply_resolution_record':
      throw new Error(`Record type ${event.type} is not supported in priming scripts`);
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled persisted record type: ${String(_exhaustive)}`);
    }
  }
}

function extractPrimingRecordsFromEvents(events: PersistedDialogRecord[]): PrimingReplayRecord[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'subdialog_created_record':
      case 'reminders_reconciled_record':
      case 'questions4human_reconciled_record':
      case 'pending_subdialogs_reconciled_record':
      case 'subdialog_registry_reconciled_record':
      case 'subdialog_responses_reconciled_record':
        return [];
      default:
        return [stripTimestampFromRecord(event)];
    }
  });
}

export async function saveDialogCourseAsIndividualPrimingScript(args: {
  dialogId: DialogID;
  status: DialogStatusKind;
  course: number;
  slug: string;
  overwrite?: boolean;
}): Promise<{
  script: PrimingScriptSummary;
  messageCount: number;
  path: string;
}> {
  const normalizedSlug = normalizeSlug(args.slug);
  if (!normalizedSlug) {
    throw new Error('slug must be non-empty and use [A-Za-z0-9._-] path segments');
  }
  if (!Number.isFinite(args.course) || args.course <= 0) {
    throw new Error(`Invalid course number: ${String(args.course)}`);
  }

  const metadata = await DialogPersistence.loadDialogMetadata(args.dialogId, args.status);
  if (!metadata) {
    throw new Error(`Dialog not found: ${args.dialogId.valueOf()} in ${args.status}`);
  }
  const ownerAgentId = metadata.agentId.trim();
  if (ownerAgentId === '') {
    throw new Error(`Dialog metadata missing agentId for ${args.dialogId.valueOf()}`);
  }

  const events = await DialogPersistence.readCourseEvents(args.dialogId, args.course, args.status);
  const records = extractPrimingRecordsFromEvents(events);
  if (records.length === 0) {
    throw new Error(
      `Cannot save priming script from empty course history: dialog=${args.dialogId.valueOf()} course=${String(args.course)}`,
    );
  }

  const scriptRef = `individual/${ownerAgentId}/${normalizedSlug}`;
  const absPath = scriptRefToAbsolutePath(scriptRef);
  const parentDir = path.dirname(absPath);
  if (!ensureInside(PRIMING_INDIVIDUAL_DIR, parentDir)) {
    throw new Error(`Priming script directory escapes individual scope: ${parentDir}`);
  }

  const now = formatUnifiedTimestamp(new Date());
  const reminders = await DialogPersistence.loadReminderState(args.dialogId, args.status);
  const frontmatter: Record<string, unknown> = {
    kind: 'agent_priming_script',
    version: 3,
    title: normalizedSlug.split('/').pop() ?? normalizedSlug,
    ownerAgentId,
    generatedAt: now,
    sourceDialog: {
      rootId: args.dialogId.rootId,
      selfId: args.dialogId.selfId,
      course: Math.floor(args.course),
      status: args.status,
    },
  };
  if (reminders.length > 0) {
    frontmatter['reminders'] = reminders.map((item) => reminderToSnapshot(item));
  }
  const markdown = formatScriptMarkdown({ frontmatter, records });

  await fs.mkdir(parentDir, { recursive: true });
  const writeMode = args.overwrite === true ? 'w' : 'wx';
  try {
    await fs.writeFile(absPath, markdown, { encoding: 'utf-8', flag: writeMode });
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    if (code === 'EEXIST' && args.overwrite !== true) {
      const fileExistsError = new Error(`Priming script already exists: ${scriptRef}`);
      (fileExistsError as { code?: string }).code = 'PRIMING_SCRIPT_EXISTS';
      throw fileExistsError;
    }
    throw error;
  }
  const st = await fs.stat(absPath);

  const script: PrimingScriptSummary = {
    ref: scriptRef,
    scope: 'individual',
    slug: normalizedSlug,
    title: typeof frontmatter['title'] === 'string' ? frontmatter['title'] : undefined,
    path: `.minds/priming/${scriptRef}.md`,
    ownerAgentId,
    updatedAt: formatUnifiedTimestamp(st.mtime),
  };
  await recordRecentPrimingUsage(ownerAgentId, [scriptRef]);
  return {
    script,
    messageCount: records.length,
    path: absPath,
  };
}

export function normalizePrimingConfig(
  raw: unknown,
): { ok: true; priming: DialogPrimingInput } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'priming must be an object' };
  }
  const showInUi = raw['showInUi'];
  if (typeof showInUi !== 'boolean') {
    return { ok: false, error: 'priming.showInUi must be a boolean' };
  }
  const scriptRefsRaw = raw['scriptRefs'];
  if (!Array.isArray(scriptRefsRaw)) {
    return { ok: false, error: 'priming.scriptRefs must be a string array' };
  }
  const scriptRefs: string[] = [];
  const seen = new Set<string>();
  for (const item of scriptRefsRaw) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'priming.scriptRefs must contain only strings' };
    }
    const normalized = normalizeScriptRef(item);
    if (!normalized) {
      return { ok: false, error: `Invalid priming script ref: ${item}` };
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    scriptRefs.push(normalized);
  }
  return {
    ok: true,
    priming: {
      showInUi,
      scriptRefs,
    },
  };
}

export function normalizePrimingScriptRef(raw: string): string | null {
  return normalizeScriptRef(raw);
}

export function normalizePrimingSlug(raw: string): string | null {
  return normalizeSlug(raw);
}

export function getRootDialogPrimingConfig(
  metadata: unknown,
): { scriptRefs: string[]; showInUi: boolean } | undefined {
  if (!isRecord(metadata)) return undefined;
  const priming = metadata['priming'];
  if (!isRecord(priming)) return undefined;
  if (!Array.isArray(priming['scriptRefs'])) return undefined;
  if (typeof priming['showInUi'] !== 'boolean') return undefined;

  const scriptRefs: string[] = [];
  for (const item of priming['scriptRefs']) {
    if (typeof item !== 'string') return undefined;
    const normalized = normalizeScriptRef(item);
    if (!normalized) return undefined;
    scriptRefs.push(normalized);
  }

  return {
    scriptRefs,
    showInUi: priming['showInUi'],
  };
}

export function buildRootDialogPrimingMetadata(
  priming: DialogPrimingInput | undefined,
): { scriptRefs: string[]; showInUi: boolean } | undefined {
  if (!priming) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of priming.scriptRefs) {
    const scriptRef = normalizeScriptRef(raw);
    if (!scriptRef) {
      throw new Error(`Invalid priming script ref for metadata: ${raw}`);
    }
    if (seen.has(scriptRef)) continue;
    seen.add(scriptRef);
    normalized.push(scriptRef);
  }
  if (normalized.length === 0) return undefined;
  return {
    scriptRefs: normalized,
    showInUi: priming.showInUi,
  };
}
