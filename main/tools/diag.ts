/**
 * Module: tools/diag
 *
 * Diagnostic tools for developers to inspect internal parsing/streaming behavior.
 */

import type { Dialog } from '../dialog';
import { Team } from '../team';
import { CollectedTextingCall, TextingEventsReceiver, TextingStreamParser } from '../texting';
import type { FuncTool, JsonSchema, ToolArguments } from '../tool';

type VerifyTextingParsingArgs = Readonly<{
  text: string;
  upstreamChunkSize: number;
  chunkSizesPlan: ReadonlyArray<number> | null;
  invarianceChunkSizes: ReadonlyArray<number>;
  randomInvarianceSeeds: ReadonlyArray<number>;
  randomInvarianceMaxChunkSize: number;
  includeEvents: boolean;
  maxEvents: number;
}>;

type UpstreamChunk = Readonly<{
  index: number;
  startPos: number;
  endPos: number;
  size: number;
  contentPreview: string;
}>;

type DiagEvent =
  | { kind: 'markdownStart' }
  | { kind: 'markdownChunk'; chunk: string; upstreamChunkIndex: number; upstreamChunkSize: number }
  | { kind: 'markdownFinish' }
  | { kind: 'callStart'; firstMention: string }
  | {
      kind: 'callHeadLineChunk';
      chunk: string;
      upstreamChunkIndex: number;
      upstreamChunkSize: number;
    }
  | { kind: 'callHeadLineFinish' }
  | { kind: 'callBodyStart'; infoLine: string | null }
  | { kind: 'callBodyChunk'; chunk: string; upstreamChunkIndex: number; upstreamChunkSize: number }
  | { kind: 'callBodyFinish'; endQuote: string | null }
  | { kind: 'callFinish'; callId: string }
  | { kind: 'codeBlockStart'; infoLine: string }
  | {
      kind: 'codeBlockChunk';
      chunk: string;
      upstreamChunkIndex: number;
      upstreamChunkSize: number;
    }
  | { kind: 'codeBlockFinish'; endQuote: string };

type TextingSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'call'; firstMention: string; headLine: string; body: string; callId: string }
  | { kind: 'codeBlock'; infoLine: string; content: string; endQuote: string };

type SegmentDiff =
  | { kind: 'equal' }
  | {
      kind: 'different';
      atIndex: number;
      baseline: TextingSegment | null;
      got: TextingSegment | null;
    };

function parseVerifyTextingParsingArgs(args: ToolArguments): VerifyTextingParsingArgs {
  const text = args.text;
  if (typeof text !== 'string') {
    throw new Error(`verify_texting_parsing.text must be a string`);
  }

  const includeEventsValue = args.include_events;
  const includeEvents =
    includeEventsValue === undefined ? true : includeEventsValue === true ? true : false;

  const maxEventsValue = args.max_events;
  const maxEvents =
    typeof maxEventsValue === 'number' && Number.isInteger(maxEventsValue) && maxEventsValue > 0
      ? maxEventsValue
      : 600;

  const upstreamChunkSizeValue = args.upstream_chunk_size;
  const upstreamChunkSize =
    typeof upstreamChunkSizeValue === 'number' &&
    Number.isInteger(upstreamChunkSizeValue) &&
    upstreamChunkSizeValue > 0
      ? upstreamChunkSizeValue
      : 10;

  const chunkSizesPlanValue = args.chunk_sizes;
  const chunkSizesPlan = parseOptionalIntArray(
    chunkSizesPlanValue,
    'verify_texting_parsing.chunk_sizes',
  );

  const invarianceChunkSizesValue = args.invariance_chunk_sizes;
  const invarianceChunkSizesParsed = parseOptionalIntArray(
    invarianceChunkSizesValue,
    'verify_texting_parsing.invariance_chunk_sizes',
  );
  const invarianceChunkSizes =
    invarianceChunkSizesParsed !== null
      ? invarianceChunkSizesParsed.filter((n) => n > 0)
      : [1, 2, 3, 4, 5, 7, 10, 16, 32];

  const randomSeedsValue = args.random_invariance_seeds;
  const randomInvarianceSeedsParsed = parseOptionalIntArray(
    randomSeedsValue,
    'verify_texting_parsing.random_invariance_seeds',
  );
  const randomInvarianceSeeds =
    randomInvarianceSeedsParsed !== null ? randomInvarianceSeedsParsed : [1, 2, 3, 4, 5, 123, 999];

  const randomMaxValue = args.random_invariance_max_chunk_size;
  const randomInvarianceMaxChunkSize =
    typeof randomMaxValue === 'number' && Number.isInteger(randomMaxValue) && randomMaxValue > 0
      ? randomMaxValue
      : 32;

  return {
    text,
    upstreamChunkSize,
    chunkSizesPlan,
    invarianceChunkSizes,
    randomInvarianceSeeds,
    randomInvarianceMaxChunkSize,
    includeEvents,
    maxEvents,
  };
}

function parseOptionalIntArray(value: unknown, name: string): ReadonlyArray<number> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of integers if provided`);
  }
  const out: number[] = [];
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new Error(`${name} must be an array of integers if provided`);
    }
    out.push(v);
  }
  return out;
}

function previewText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

class DiagTextingReceiver implements TextingEventsReceiver {
  public readonly events: DiagEvent[] = [];

  private currentUpstreamChunkIndex = -1;
  private currentUpstreamChunkSize = 0;

  public setUpstreamChunkContext(index: number, size: number): void {
    this.currentUpstreamChunkIndex = index;
    this.currentUpstreamChunkSize = size;
  }

  private upstreamCtx(): { upstreamChunkIndex: number; upstreamChunkSize: number } {
    return {
      upstreamChunkIndex: this.currentUpstreamChunkIndex,
      upstreamChunkSize: this.currentUpstreamChunkSize,
    };
  }

  async markdownStart(): Promise<void> {
    this.events.push({ kind: 'markdownStart' });
  }
  async markdownChunk(chunk: string): Promise<void> {
    this.events.push({ kind: 'markdownChunk', chunk, ...this.upstreamCtx() });
  }
  async markdownFinish(): Promise<void> {
    this.events.push({ kind: 'markdownFinish' });
  }

  async callStart(firstMention: string): Promise<void> {
    this.events.push({ kind: 'callStart', firstMention });
  }
  async callHeadLineChunk(chunk: string): Promise<void> {
    this.events.push({ kind: 'callHeadLineChunk', chunk, ...this.upstreamCtx() });
  }
  async callHeadLineFinish(): Promise<void> {
    this.events.push({ kind: 'callHeadLineFinish' });
  }
  async callBodyStart(infoLine?: string): Promise<void> {
    this.events.push({ kind: 'callBodyStart', infoLine: infoLine === undefined ? null : infoLine });
  }
  async callBodyChunk(chunk: string): Promise<void> {
    this.events.push({ kind: 'callBodyChunk', chunk, ...this.upstreamCtx() });
  }
  async callBodyFinish(endQuote?: string): Promise<void> {
    this.events.push({
      kind: 'callBodyFinish',
      endQuote: endQuote === undefined ? null : endQuote,
    });
  }
  async callFinish(callId: string): Promise<void> {
    this.events.push({ kind: 'callFinish', callId });
  }

  async codeBlockStart(infoLine: string): Promise<void> {
    this.events.push({ kind: 'codeBlockStart', infoLine });
  }
  async codeBlockChunk(chunk: string): Promise<void> {
    this.events.push({ kind: 'codeBlockChunk', chunk, ...this.upstreamCtx() });
  }
  async codeBlockFinish(endQuote: string): Promise<void> {
    this.events.push({ kind: 'codeBlockFinish', endQuote });
  }
}

function segmentsDiff(
  baseline: ReadonlyArray<TextingSegment>,
  got: ReadonlyArray<TextingSegment>,
): SegmentDiff {
  const maxLen = Math.max(baseline.length, got.length);
  for (let i = 0; i < maxLen; i++) {
    const aSeg = i < baseline.length ? baseline[i] : null;
    const bSeg = i < got.length ? got[i] : null;
    if (aSeg === null || bSeg === null) {
      return { kind: 'different', atIndex: i, baseline: aSeg, got: bSeg };
    }
    if (!segmentEqual(aSeg, bSeg)) {
      return { kind: 'different', atIndex: i, baseline: aSeg, got: bSeg };
    }
  }
  return { kind: 'equal' };
}

function segmentEqual(a: TextingSegment, b: TextingSegment): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'markdown':
      return a.text === (b as { kind: 'markdown'; text: string }).text;
    case 'call': {
      const bb = b as {
        kind: 'call';
        firstMention: string;
        headLine: string;
        body: string;
        callId: string;
      };
      return (
        a.firstMention === bb.firstMention &&
        a.headLine === bb.headLine &&
        a.body === bb.body &&
        a.callId === bb.callId
      );
    }
    case 'codeBlock': {
      const bb = b as { kind: 'codeBlock'; infoLine: string; content: string; endQuote: string };
      return a.infoLine === bb.infoLine && a.content === bb.content && a.endQuote === bb.endQuote;
    }
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

function eventsToSegments(events: ReadonlyArray<DiagEvent>): TextingSegment[] {
  const segments: TextingSegment[] = [];

  let currentMarkdown: { kind: 'markdown'; text: string } | null = null;
  let currentCall: {
    kind: 'call';
    firstMention: string;
    headLine: string;
    body: string;
    callId: string;
  } | null = null;
  let currentCodeBlock: {
    kind: 'codeBlock';
    infoLine: string;
    content: string;
    endQuote: string;
  } | null = null;

  for (const ev of events) {
    switch (ev.kind) {
      case 'markdownStart':
        currentMarkdown = { kind: 'markdown', text: '' };
        break;
      case 'markdownChunk': {
        const text = ev.chunk;
        if (!currentMarkdown) currentMarkdown = { kind: 'markdown', text: '' };
        currentMarkdown.text += text;
        break;
      }
      case 'markdownFinish':
        if (currentMarkdown) segments.push(currentMarkdown);
        currentMarkdown = null;
        break;

      case 'callStart':
        currentCall = {
          kind: 'call',
          firstMention: ev.firstMention,
          headLine: '',
          body: '',
          callId: '',
        };
        break;
      case 'callHeadLineChunk': {
        if (!currentCall)
          currentCall = { kind: 'call', firstMention: '', headLine: '', body: '', callId: '' };
        currentCall.headLine += ev.chunk;
        break;
      }
      case 'callBodyChunk': {
        if (!currentCall)
          currentCall = { kind: 'call', firstMention: '', headLine: '', body: '', callId: '' };
        currentCall.body += ev.chunk;
        break;
      }
      case 'callFinish':
        if (currentCall) {
          currentCall.callId = ev.callId;
          segments.push(currentCall);
        }
        currentCall = null;
        break;

      case 'codeBlockStart':
        currentCodeBlock = { kind: 'codeBlock', infoLine: ev.infoLine, content: '', endQuote: '' };
        break;
      case 'codeBlockChunk': {
        if (!currentCodeBlock)
          currentCodeBlock = { kind: 'codeBlock', infoLine: '', content: '', endQuote: '' };
        currentCodeBlock.content += ev.chunk;
        break;
      }
      case 'codeBlockFinish':
        if (!currentCodeBlock)
          currentCodeBlock = {
            kind: 'codeBlock',
            infoLine: '',
            content: '',
            endQuote: ev.endQuote,
          };
        currentCodeBlock.endQuote = ev.endQuote;
        segments.push(currentCodeBlock);
        currentCodeBlock = null;
        break;

      case 'callHeadLineFinish':
      case 'callBodyStart':
      case 'callBodyFinish':
        break;

      default: {
        const _exhaustive: never = ev;
        void _exhaustive;
        break;
      }
    }
  }

  if (currentMarkdown) segments.push(currentMarkdown);
  if (currentCall) segments.push(currentCall);
  if (currentCodeBlock) segments.push(currentCodeBlock);
  return segments;
}

function verifyEventSequence(events: ReadonlyArray<DiagEvent>): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  let markdownActive = false;
  let callActive = false;
  let callHeadlineFinished = false;
  let callBodyActive = false;
  let codeBlockActive = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    switch (ev.kind) {
      case 'markdownStart':
        if (markdownActive) issues.push(`event[${i}]: markdownStart while markdownActive`);
        markdownActive = true;
        break;
      case 'markdownChunk':
        if (!markdownActive) issues.push(`event[${i}]: markdownChunk without markdownStart`);
        break;
      case 'markdownFinish':
        if (!markdownActive) issues.push(`event[${i}]: markdownFinish without markdownStart`);
        markdownActive = false;
        break;

      case 'callStart':
        if (callActive) issues.push(`event[${i}]: callStart while callActive`);
        callActive = true;
        callHeadlineFinished = false;
        callBodyActive = false;
        break;
      case 'callHeadLineChunk':
        if (!callActive) issues.push(`event[${i}]: callHeadLineChunk without callStart`);
        if (callHeadlineFinished)
          issues.push(`event[${i}]: callHeadLineChunk after callHeadLineFinish`);
        break;
      case 'callHeadLineFinish':
        if (!callActive) issues.push(`event[${i}]: callHeadLineFinish without callStart`);
        callHeadlineFinished = true;
        break;
      case 'callBodyStart':
        if (!callActive) issues.push(`event[${i}]: callBodyStart without callStart`);
        if (!callHeadlineFinished)
          issues.push(`event[${i}]: callBodyStart before callHeadLineFinish`);
        if (callBodyActive) issues.push(`event[${i}]: callBodyStart while callBodyActive`);
        callBodyActive = true;
        break;
      case 'callBodyChunk':
        if (!callBodyActive) issues.push(`event[${i}]: callBodyChunk without callBodyStart`);
        break;
      case 'callBodyFinish':
        if (!callBodyActive) issues.push(`event[${i}]: callBodyFinish without callBodyStart`);
        callBodyActive = false;
        break;
      case 'callFinish':
        if (!callActive) issues.push(`event[${i}]: callFinish without callStart`);
        if (callBodyActive) issues.push(`event[${i}]: callFinish while callBodyActive`);
        callActive = false;
        callHeadlineFinished = false;
        callBodyActive = false;
        break;

      case 'codeBlockStart':
        if (codeBlockActive) issues.push(`event[${i}]: codeBlockStart while codeBlockActive`);
        codeBlockActive = true;
        break;
      case 'codeBlockChunk':
        if (!codeBlockActive) issues.push(`event[${i}]: codeBlockChunk without codeBlockStart`);
        break;
      case 'codeBlockFinish':
        if (!codeBlockActive) issues.push(`event[${i}]: codeBlockFinish without codeBlockStart`);
        codeBlockActive = false;
        break;

      default: {
        const _exhaustive: never = ev;
        void _exhaustive;
        issues.push(`event[${i}]: unknown event`);
        break;
      }
    }
  }

  if (markdownActive) issues.push(`end: markdownActive not finished`);
  if (callActive) issues.push(`end: callActive not finished`);
  if (callBodyActive) issues.push(`end: callBodyActive not finished`);
  if (codeBlockActive) issues.push(`end: codeBlockActive not finished`);

  return { ok: issues.length === 0, issues };
}

function makeXorShift32(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}

function splitIntoRandomChunks(inputLength: number, seed: number, maxChunkSize: number): number[] {
  const sizes: number[] = [];
  const next = makeXorShift32(seed);
  let remaining = inputLength;

  while (remaining > 0) {
    const r = next();
    const size = 1 + (r % Math.max(1, maxChunkSize));
    const actual = Math.min(size, remaining);
    sizes.push(actual);
    remaining -= actual;
  }

  return sizes;
}

async function parseTextingWithChunkPlan(
  input: string,
  chunkSizesPlan: ReadonlyArray<number> | null,
  upstreamChunkSize: number,
): Promise<{
  upstreamChunks: UpstreamChunk[];
  events: DiagEvent[];
  segments: TextingSegment[];
  collectedCalls: CollectedTextingCall[];
  chunkPlanUsed: number[];
  chunkPlanExtendedToCoverRemainder: boolean;
}> {
  const receiver = new DiagTextingReceiver();
  const parser = new TextingStreamParser(receiver);

  const upstreamChunks: UpstreamChunk[] = [];
  const chunkPlanUsed: number[] = [];
  let chunkPlanExtendedToCoverRemainder = false;

  const plan =
    chunkSizesPlan !== null
      ? [...chunkSizesPlan]
      : buildFixedChunkPlan(input.length, upstreamChunkSize);

  let pos = 0;
  for (let idx = 0; idx < plan.length; idx++) {
    const sz = plan[idx] ?? 0;
    const remaining = input.length - pos;
    const actual = sz <= 0 ? 0 : Math.min(sz, remaining);
    const chunk = actual <= 0 ? '' : input.substring(pos, pos + actual);

    receiver.setUpstreamChunkContext(upstreamChunks.length, actual);
    upstreamChunks.push({
      index: upstreamChunks.length,
      startPos: pos,
      endPos: pos + actual,
      size: actual,
      contentPreview: previewText(chunk, 80),
    });
    chunkPlanUsed.push(actual);

    await parser.takeUpstreamChunk(chunk);
    pos += actual;
    if (pos >= input.length) break;
  }

  if (pos < input.length) {
    const remaining = input.substring(pos);
    receiver.setUpstreamChunkContext(upstreamChunks.length, remaining.length);
    upstreamChunks.push({
      index: upstreamChunks.length,
      startPos: pos,
      endPos: input.length,
      size: remaining.length,
      contentPreview: previewText(remaining, 80),
    });
    chunkPlanUsed.push(remaining.length);
    chunkPlanExtendedToCoverRemainder = true;
    await parser.takeUpstreamChunk(remaining);
  }

  await parser.finalize();
  const collectedCalls = parser.getCollectedCalls();
  const events = receiver.events;
  const segments = eventsToSegments(events);

  return {
    upstreamChunks,
    events,
    segments,
    collectedCalls,
    chunkPlanUsed,
    chunkPlanExtendedToCoverRemainder,
  };
}

function buildFixedChunkPlan(inputLen: number, chunkSize: number): number[] {
  if (inputLen <= 0) return [];
  const size = Math.max(1, chunkSize);
  const out: number[] = [];
  let remaining = inputLen;
  while (remaining > 0) {
    const actual = Math.min(size, remaining);
    out.push(actual);
    remaining -= actual;
  }
  return out;
}

function computeChunkingMetrics(
  events: ReadonlyArray<DiagEvent>,
  upstreamChunks: ReadonlyArray<UpstreamChunk>,
): {
  upstreamChunks: number;
  downstreamChunkEvents: number;
  upstreamChunksWithDownstreamChunkEvents: number;
  upstreamChunksWithMultipleDownstreamChunkEvents: number;
  downstreamChunkEventsWithSmallerSizeThanUpstream: number;
  examples: Array<{
    eventKind: string;
    upstreamChunkIndex: number;
    upstreamChunkSize: number;
    downstreamChunkSize: number;
    downstreamPreview: string;
  }>;
} {
  const counts = new Map<number, number>();
  let downstreamChunkEvents = 0;
  let smallerThanUpstream = 0;
  const examples: Array<{
    eventKind: string;
    upstreamChunkIndex: number;
    upstreamChunkSize: number;
    downstreamChunkSize: number;
    downstreamPreview: string;
  }> = [];

  for (const ev of events) {
    if (
      ev.kind !== 'markdownChunk' &&
      ev.kind !== 'callHeadLineChunk' &&
      ev.kind !== 'callBodyChunk' &&
      ev.kind !== 'codeBlockChunk'
    ) {
      continue;
    }
    downstreamChunkEvents++;
    const prev = counts.get(ev.upstreamChunkIndex) ?? 0;
    counts.set(ev.upstreamChunkIndex, prev + 1);
    const downstreamSize = ev.chunk.length;
    if (ev.upstreamChunkSize > 0 && downstreamSize < ev.upstreamChunkSize) {
      smallerThanUpstream++;
      if (examples.length < 12) {
        examples.push({
          eventKind: ev.kind,
          upstreamChunkIndex: ev.upstreamChunkIndex,
          upstreamChunkSize: ev.upstreamChunkSize,
          downstreamChunkSize: downstreamSize,
          downstreamPreview: previewText(ev.chunk, 60),
        });
      }
    }
  }

  let withDownstream = 0;
  let withMultiple = 0;
  for (const chunk of upstreamChunks) {
    const cnt = counts.get(chunk.index) ?? 0;
    if (cnt > 0) withDownstream++;
    if (cnt > 1) withMultiple++;
  }

  return {
    upstreamChunks: upstreamChunks.length,
    downstreamChunkEvents,
    upstreamChunksWithDownstreamChunkEvents: withDownstream,
    upstreamChunksWithMultipleDownstreamChunkEvents: withMultiple,
    downstreamChunkEventsWithSmallerSizeThanUpstream: smallerThanUpstream,
    examples,
  };
}

const verifyTextingParsingSchema: JsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Raw texting/saying text to parse.' },
    upstream_chunk_size: {
      type: 'integer',
      description:
        'Fixed upstream chunk size used when chunk_sizes is not provided (simulates streaming). Default: 10.',
    },
    chunk_sizes: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Explicit upstream chunk-size plan (like tests/texting/realtime.ts). May include 0 for empty chunks.',
    },
    invariance_chunk_sizes: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Upstream chunk sizes to verify invariance against baseline single-chunk parse (like tests/texting/parsing.ts).',
    },
    random_invariance_seeds: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Seeds used to generate random chunk plans to verify invariance (like tests/texting/parsing.ts).',
    },
    random_invariance_max_chunk_size: {
      type: 'integer',
      description: 'Max upstream chunk size used when generating random chunk plans. Default: 32.',
    },
    include_events: {
      type: 'boolean',
      description:
        'When true, include raw downstream events (truncated by max_events). Default: true.',
    },
    max_events: {
      type: 'integer',
      description:
        'Max number of events to include in output when include_events=true. Default: 600.',
    },
  },
  required: ['text'],
  additionalProperties: false,
};

export const verifyTextingParsingTool: FuncTool = {
  type: 'func',
  name: 'verify_texting_parsing',
  description:
    'Parse a raw texting/saying text block via TextingStreamParser and return structured segments + streaming diagnostics.',
  descriptionI18n: {
    en: 'Parse a raw texting/saying text block via TextingStreamParser and return structured segments + streaming diagnostics.',
    zh: '将一段原始 texting/saying 文本交给 TextingStreamParser 解析，并返回结构化片段与流式诊断结果。',
  },
  parameters: verifyTextingParsingSchema,
  argsValidation: 'dominds',
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string> => {
    try {
      const parsed = parseVerifyTextingParsingArgs(args);

      const primary = await parseTextingWithChunkPlan(
        parsed.text,
        parsed.chunkSizesPlan,
        parsed.upstreamChunkSize,
      );

      const seq = verifyEventSequence(primary.events);
      const chunking = computeChunkingMetrics(primary.events, primary.upstreamChunks);

      const baselineChunkSize = Math.max(1, parsed.text.length);
      const baseline = await parseTextingWithChunkPlan(parsed.text, null, baselineChunkSize);

      const invarianceFailures: Array<{
        upstreamChunkSize: number;
        diff: SegmentDiff;
      }> = [];
      for (const sz of parsed.invarianceChunkSizes) {
        const actualSize = Math.max(1, sz);
        const got = await parseTextingWithChunkPlan(parsed.text, null, actualSize);
        const diff = segmentsDiff(baseline.segments, got.segments);
        if (diff.kind !== 'equal') {
          invarianceFailures.push({ upstreamChunkSize: actualSize, diff });
        }
      }

      const randomFailures: Array<{
        seed: number;
        maxChunkSize: number;
        chunkPlanPreview: string;
        diff: SegmentDiff;
      }> = [];
      for (const seed of parsed.randomInvarianceSeeds) {
        const plan = splitIntoRandomChunks(
          parsed.text.length,
          seed,
          parsed.randomInvarianceMaxChunkSize,
        );
        const got = await parseTextingWithChunkPlan(parsed.text, plan, parsed.upstreamChunkSize);
        const diff = segmentsDiff(baseline.segments, got.segments);
        if (diff.kind !== 'equal') {
          randomFailures.push({
            seed,
            maxChunkSize: parsed.randomInvarianceMaxChunkSize,
            chunkPlanPreview: previewText(plan.join(','), 120),
            diff,
          });
        }
      }

      const ok = seq.ok && invarianceFailures.length === 0 && randomFailures.length === 0;

      const output: Record<string, unknown> = {
        ok,
        caller: { id: caller.id, name: caller.name },
        input: {
          length: parsed.text.length,
          upstream_chunk_size: parsed.upstreamChunkSize,
          chunk_sizes_plan_provided: parsed.chunkSizesPlan !== null,
        },
        primary: {
          chunk_plan_used: primary.chunkPlanUsed,
          chunk_plan_extended_to_cover_remainder: primary.chunkPlanExtendedToCoverRemainder,
          upstream_chunks: primary.upstreamChunks,
          segments: primary.segments,
          collected_calls: primary.collectedCalls,
          events: parsed.includeEvents
            ? {
                total: primary.events.length,
                truncated_to: Math.min(primary.events.length, parsed.maxEvents),
                items: primary.events.slice(0, parsed.maxEvents),
              }
            : undefined,
        },
        baseline: {
          upstream_chunk_size: baselineChunkSize,
          segments: baseline.segments,
        },
        analysis: {
          event_sequence: seq,
          chunking_metrics: chunking,
          invariance: {
            checked_sizes: parsed.invarianceChunkSizes.map((n) => Math.max(1, n)),
            failures: invarianceFailures,
          },
          random_invariance: {
            seeds: parsed.randomInvarianceSeeds,
            max_chunk_size: parsed.randomInvarianceMaxChunkSize,
            failures: randomFailures,
          },
        },
      };

      return JSON.stringify(output, null, 2);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      return JSON.stringify(
        {
          ok: false,
          error: { message, stack },
        },
        null,
        2,
      );
    }
  },
};
