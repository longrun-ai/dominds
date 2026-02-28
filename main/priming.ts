import type { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import type { Dialog } from './dialog';
import { DialogID } from './dialog';
import type { ChatMessage } from './llm/client';
import { DialogPersistence } from './persistence';
import type { LanguageCode } from './shared/types/language';
import type { PrimingScriptSummary } from './shared/types/priming';
import type {
  AgentThoughtRecord,
  AgentWordsRecord,
  FuncCallRecord,
  FuncResultContentItem,
  FuncResultRecord,
  GenFinishRecord,
  GenStartRecord,
  HumanTextRecord,
  PersistedDialogRecord,
  QuestForSupRecord,
  ReasoningContentItem,
  ReasoningPayload,
  ReasoningSummaryItem,
  TeammateCallAnchorRecord,
  TeammateCallResultRecord,
  TeammateResponseRecord,
  ToolArguments,
  UiOnlyMarkdownRecord,
  WebSearchCallActionRecord,
  WebSearchCallRecord,
} from './shared/types/storage';
import type { DialogPrimingInput, DialogStatusKind } from './shared/types/wire';
import { formatUnifiedTimestamp } from './shared/utils/time';

const PRIMING_ROOT_DIR = path.resolve(process.cwd(), '.minds', 'priming');
const PRIMING_INDIVIDUAL_DIR = path.resolve(PRIMING_ROOT_DIR, 'individual');
const PRIMING_TEAM_SHARED_DIR = path.resolve(PRIMING_ROOT_DIR, 'team_shared');
const RECENT_PRIMING_DIR = path.resolve(process.cwd(), '.dialogs', 'recent-priming');
const RECENT_PRIMING_MAX = 20;

type StripTs<T> = T extends { ts: string } ? Omit<T, 'ts'> : never;
type PrimingReplayRecord = StripTs<PersistedDialogRecord>;
type PrimingRecordType = PersistedDialogRecord['type'];
type PrimingMarkdownTextField = 'content' | 'tellaskContent' | 'result' | 'response';

type ParsedPrimingHeading = { kind: 'record'; type: PrimingRecordType };

type ParsedPrimingScript = {
  title?: string;
  applicableMemberIds?: string[];
  records: PrimingReplayRecord[];
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

function stripOptionalBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

function parseFrontmatter(raw: string): { body: string; frontmatter: Record<string, unknown> } {
  const normalized = stripOptionalBom(raw).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { body: normalized, frontmatter: {} };
  }
  const endWithBody = normalized.indexOf('\n---\n', 4);
  const endAtEof = normalized.endsWith('\n---') ? normalized.length - '\n---'.length : -1;
  const end = endWithBody >= 0 ? endWithBody : endAtEof;
  if (end < 0) return { body: normalized, frontmatter: {} };

  const frontmatterText = normalized.slice(4, end);
  const body =
    endWithBody >= 0
      ? normalized.slice(end + '\n---\n'.length)
      : normalized.slice(end + '\n---'.length);
  try {
    const parsed = YAML.parse(frontmatterText);
    return { body, frontmatter: isRecord(parsed) ? parsed : {} };
  } catch (error) {
    throw new Error(
      `Invalid priming frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

function isPrimingRecordType(raw: string): raw is PrimingRecordType {
  return (
    raw === 'agent_thought_record' ||
    raw === 'agent_words_record' ||
    raw === 'ui_only_markdown_record' ||
    raw === 'func_call_record' ||
    raw === 'web_search_call_record' ||
    raw === 'human_text_record' ||
    raw === 'func_result_record' ||
    raw === 'quest_for_sup_record' ||
    raw === 'teammate_call_result_record' ||
    raw === 'teammate_call_anchor_record' ||
    raw === 'teammate_response_record' ||
    raw === 'gen_start_record' ||
    raw === 'gen_finish_record'
  );
}

function getRecordMarkdownTextField(type: PrimingRecordType): PrimingMarkdownTextField | null {
  switch (type) {
    case 'agent_thought_record':
    case 'agent_words_record':
    case 'ui_only_markdown_record':
    case 'human_text_record':
    case 'func_result_record':
      return 'content';
    case 'quest_for_sup_record':
      return 'tellaskContent';
    case 'teammate_call_result_record':
      return 'result';
    case 'teammate_response_record':
      return 'response';
    case 'func_call_record':
    case 'web_search_call_record':
    case 'teammate_call_anchor_record':
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
    case 'func_call_record': {
      const argumentsRaw = raw['arguments'];
      if (!isRecord(argumentsRaw)) {
        throw new Error(`${context}.arguments must be an object`);
      }
      const record: FuncCallRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        id: expectStringField(raw, 'id', context),
        name: expectStringField(raw, 'name', context),
        arguments: argumentsRaw as ToolArguments,
      };
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'web_search_call_record': {
      const phase = raw['phase'];
      if (phase !== 'added' && phase !== 'done') {
        throw new Error(`${context}.phase must be added | done`);
      }
      const itemId = raw['itemId'];
      const status = raw['status'];
      if (itemId !== undefined && typeof itemId !== 'string') {
        throw new Error(`${context}.itemId must be a string when provided`);
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
      if (itemId !== undefined) record.itemId = itemId;
      if (status !== undefined) record.status = status;
      if (action !== undefined) record.action = action;
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
      const q4hAnswerCallIds = parseOptionalStringArray(raw, 'q4hAnswerCallIds', context);
      const record: HumanTextRecord = {
        ts: '',
        type,
        genseq: expectIntegerField(raw, 'genseq', context),
        msgId: expectStringField(raw, 'msgId', context),
        content: expectStringField(raw, 'content', context, true),
        grammar: 'markdown',
      };
      if (userLanguageCode !== undefined) record.userLanguageCode = userLanguageCode;
      if (q4hAnswerCallIds) record.q4hAnswerCallIds = q4hAnswerCallIds;
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
    case 'teammate_call_result_record': {
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
      if (status !== 'completed' && status !== 'failed') {
        throw new Error(`${context}.status must be completed | failed`);
      }
      const callingGenseq = parseOptionalIntegerField(raw, 'calling_genseq', context);
      const mentionList = parseOptionalStringArray(raw, 'mentionList', context);
      const record: TeammateCallResultRecord = {
        ts: '',
        type,
        responderId: expectStringField(raw, 'responderId', context),
        callName,
        tellaskContent: expectStringField(raw, 'tellaskContent', context, true),
        status,
        result: expectStringField(raw, 'result', context, true),
        callId: expectStringField(raw, 'callId', context),
      };
      if (callingGenseq !== undefined) record.calling_genseq = callingGenseq;
      if (mentionList) record.mentionList = mentionList;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'teammate_call_anchor_record': {
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
      const record: TeammateCallAnchorRecord = {
        ts: '',
        type,
        anchorRole,
        callId: expectStringField(raw, 'callId', context),
        genseq: expectIntegerField(raw, 'genseq', context),
      };
      if (assignmentCourse !== undefined) record.assignmentCourse = assignmentCourse;
      if (assignmentGenseq !== undefined) record.assignmentGenseq = assignmentGenseq;
      if (callerDialogId !== undefined) record.callerDialogId = callerDialogId;
      if (callerCourse !== undefined) record.callerCourse = callerCourse;
      if (sourceTag) record.sourceTag = sourceTag;
      const { ts: _unusedTs, ...withoutTs } = record;
      return withoutTs;
    }
    case 'teammate_response_record': {
      const callName = raw['callName'];
      if (
        callName !== 'tellaskBack' &&
        callName !== 'tellask' &&
        callName !== 'tellaskSessionless' &&
        callName !== 'freshBootsReasoning'
      ) {
        throw new Error(`${context}.callName is invalid`);
      }
      const status = raw['status'];
      if (status !== 'completed' && status !== 'failed') {
        throw new Error(`${context}.status must be completed | failed`);
      }
      const mentionList = parseOptionalStringArray(raw, 'mentionList', context);
      const sessionSlug = raw['sessionSlug'];
      const callingGenseq = parseOptionalIntegerField(raw, 'calling_genseq', context);
      const calleeCourse = parseOptionalIntegerField(raw, 'calleeCourse', context);
      const calleeGenseq = parseOptionalIntegerField(raw, 'calleeGenseq', context);
      const calleeDialogId = raw['calleeDialogId'];
      if (calleeDialogId !== undefined && typeof calleeDialogId !== 'string') {
        throw new Error(`${context}.calleeDialogId must be a string when provided`);
      }
      const base = {
        ts: '',
        type,
        responderId: expectStringField(raw, 'responderId', context),
        tellaskContent: expectStringField(raw, 'tellaskContent', context, true),
        status,
        response: expectStringField(raw, 'response', context, true),
        agentId: expectStringField(raw, 'agentId', context),
        callId: expectStringField(raw, 'callId', context),
        originMemberId: expectStringField(raw, 'originMemberId', context),
      } as const;
      const record: TeammateResponseRecord = (() => {
        switch (callName) {
          case 'tellask': {
            if (!Array.isArray(mentionList) || mentionList.length < 1) {
              throw new Error(`${context}.mentionList is required for tellask teammate response`);
            }
            if (typeof sessionSlug !== 'string' || sessionSlug.trim() === '') {
              throw new Error(`${context}.sessionSlug is required for tellask teammate response`);
            }
            return {
              ...base,
              callName,
              sessionSlug: sessionSlug.trim(),
              mentionList,
            };
          }
          case 'tellaskSessionless': {
            if (!Array.isArray(mentionList) || mentionList.length < 1) {
              throw new Error(
                `${context}.mentionList is required for tellaskSessionless teammate response`,
              );
            }
            if (sessionSlug !== undefined) {
              throw new Error(
                `${context}.sessionSlug must be undefined for tellaskSessionless teammate response`,
              );
            }
            return {
              ...base,
              callName,
              mentionList,
            };
          }
          case 'tellaskBack':
          case 'freshBootsReasoning': {
            if (mentionList !== undefined) {
              throw new Error(`${context}.mentionList must be undefined for ${callName}`);
            }
            if (sessionSlug !== undefined) {
              throw new Error(`${context}.sessionSlug must be undefined for ${callName}`);
            }
            return {
              ...base,
              callName,
            };
          }
        }
      })();
      if (callingGenseq !== undefined) record.calling_genseq = callingGenseq;
      if (calleeDialogId !== undefined) record.calleeDialogId = calleeDialogId;
      if (calleeCourse !== undefined) record.calleeCourse = calleeCourse;
      if (calleeGenseq !== undefined) record.calleeGenseq = calleeGenseq;
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
  const records = parseRecordsFromBody(body);
  return { title, applicableMemberIds, records };
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
): Promise<{ summary: PrimingScriptSummary; records: PrimingReplayRecord[] }> {
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
    case 'func_call_record':
    case 'web_search_call_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'quest_for_sup_record':
    case 'teammate_call_anchor_record':
    case 'gen_start_record':
    case 'gen_finish_record':
      return { ...record, genseq: mapGenseq(record.genseq) };
    case 'teammate_call_result_record':
      return {
        ...record,
        calling_genseq: remapOptionalGenseq(record.calling_genseq),
      };
    case 'teammate_response_record':
      return {
        ...record,
        calling_genseq: remapOptionalGenseq(record.calling_genseq),
      };
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
    case 'func_call_record':
    case 'web_search_call_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'quest_for_sup_record':
    case 'teammate_call_result_record':
    case 'teammate_call_anchor_record':
    case 'teammate_response_record':
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
    case 'func_call_record':
    case 'web_search_call_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'quest_for_sup_record':
    case 'teammate_call_result_record':
    case 'teammate_call_anchor_record':
    case 'teammate_response_record':
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
      return {
        type: 'ui_only_markdown_msg',
        role: 'assistant',
        genseq: record.genseq,
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
        arguments: JSON.stringify(record.arguments),
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
    case 'teammate_call_result_record': {
      const mentionList =
        record.callName === 'tellask' || record.callName === 'tellaskSessionless'
          ? record.mentionList
          : undefined;
      return {
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: record.responderId,
        mentionList,
        tellaskContent: record.tellaskContent,
        status: record.status,
        callId: record.callId,
        content: record.result,
      };
    }
    case 'teammate_response_record': {
      const mentionList =
        record.callName === 'tellask' || record.callName === 'tellaskSessionless'
          ? record.mentionList
          : undefined;
      return {
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: record.responderId,
        mentionList,
        tellaskContent: record.tellaskContent,
        status: record.status,
        callId: record.callId,
        content: record.response,
      };
    }
    case 'web_search_call_record':
    case 'quest_for_sup_record':
    case 'teammate_call_anchor_record':
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
  let nextGenseq = getNextDialogGenseq(args.dialog);
  for (const scriptRef of normalizedRefs) {
    const loaded = await loadPrimingScriptByRef(scriptRef, agentId);
    const remapped = remapScriptRecordsForReplay(loaded.records, nextGenseq);
    nextGenseq = remapped.nextGenseq;
    allRecords.push(...remapped.records);
  }
  if (allRecords.length === 0) {
    return { appliedScriptRefs: normalizedRefs, appendedMessageCount: 0 };
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
      case 'web_search_call_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['phase'] = record.phase;
        if (record.itemId !== undefined) blockMeta['itemId'] = record.itemId;
        if (record.status !== undefined) blockMeta['status'] = record.status;
        if (record.action !== undefined) blockMeta['action'] = record.action;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        break;
      }
      case 'human_text_record': {
        blockMeta['genseq'] = record.genseq;
        blockMeta['msgId'] = record.msgId;
        blockMeta['grammar'] = record.grammar;
        if (record.userLanguageCode !== undefined)
          blockMeta['userLanguageCode'] = record.userLanguageCode;
        if (record.q4hAnswerCallIds !== undefined)
          blockMeta['q4hAnswerCallIds'] = record.q4hAnswerCallIds;
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
      case 'teammate_call_result_record': {
        blockMeta['responderId'] = record.responderId;
        blockMeta['callName'] = record.callName;
        if (record.mentionList !== undefined) blockMeta['mentionList'] = record.mentionList;
        blockMeta['tellaskContent'] = record.tellaskContent;
        blockMeta['status'] = record.status;
        blockMeta['callId'] = record.callId;
        if (record.calling_genseq !== undefined)
          blockMeta['calling_genseq'] = record.calling_genseq;
        if (record.sourceTag !== undefined) blockMeta['sourceTag'] = record.sourceTag;
        blockBody = record.result;
        break;
      }
      case 'teammate_call_anchor_record': {
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
      case 'teammate_response_record': {
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
          case 'tellaskBack':
          case 'freshBootsReasoning':
            break;
        }
        blockMeta['tellaskContent'] = record.tellaskContent;
        blockMeta['status'] = record.status;
        blockMeta['agentId'] = record.agentId;
        blockMeta['callId'] = record.callId;
        blockMeta['originMemberId'] = record.originMemberId;
        if (record.calling_genseq !== undefined)
          blockMeta['calling_genseq'] = record.calling_genseq;
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
    case 'func_call_record':
    case 'web_search_call_record':
    case 'human_text_record':
    case 'func_result_record':
    case 'quest_for_sup_record':
    case 'teammate_call_result_record':
    case 'teammate_call_anchor_record':
    case 'teammate_response_record':
    case 'gen_start_record':
    case 'gen_finish_record': {
      const { ts: _unusedTs, ...withoutTs } = event;
      return withoutTs;
    }
    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled persisted record type: ${String(_exhaustive)}`);
    }
  }
}

function extractPrimingRecordsFromEvents(events: PersistedDialogRecord[]): PrimingReplayRecord[] {
  return events.map((event) => stripTimestampFromRecord(event));
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
