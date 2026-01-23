/**
 * # Tellask Grammar ("诉请")
 *
 * A primitive, line-based streaming call format designed to be robust under arbitrary
 * upstream chunk boundaries (no backtick/markdown state machine required).
 *
 * ## Rules
 *
 * - Tellask call blocks consist of **lines**.
 * - Any line starting with literal `!?` is a tellask line (prefix is not included in payload).
 * - Any line(s) **without** `!?` prefix are treated as markdown, and also act as separators:
 *   they terminate the current tellask call block (if any).
 *
 * Within a tellask call block:
 * - The first tellask line is the start of the call headline.
 * - The first line MUST start with `!?@<valid-mention-id>` to be considered valid.
 *   Otherwise the block still parses, but is reported as malformed.
 * - While still in headline phase, subsequent tellask lines starting with `!?@` extend
 *   the headline (multiline headline).
 * - Any other tellask lines (starting with `!?` but NOT `!?@`) start/continue the call body.
 *
 * All downstream chunks preserve upstream chunk boundaries unless correctness requires
 * a split (e.g. line-start prefix disambiguation across chunks).
 */

import { generateContentHash } from './utils/id';

import type { TellaskCallValidation, TellaskMalformedReason } from './shared/types/tellask';

export type { TellaskCallValidation, TellaskMalformedReason };

export interface CollectedTellaskCall {
  validation: TellaskCallValidation;
  headLine: string;
  body: string;
  callId: string;
}

export interface TellaskEventsReceiver {
  // Interleaved free text segments between calls are emitted as markdown fragments.
  markdownStart: () => Promise<void>;
  markdownChunk: (chunk: string) => Promise<void>;
  markdownFinish: () => Promise<void>;

  // Start of tellask call block (valid or malformed).
  callStart: (validation: TellaskCallValidation) => Promise<void>;

  // Headline (prefix `!?` removed). Includes all whitespace from upstream.
  callHeadLineChunk: (chunk: string) => Promise<void>;
  callHeadLineFinish: () => Promise<void>;

  // Body (prefix `!?` removed). Includes all whitespace from upstream.
  callBodyStart: () => Promise<void>;
  callBodyChunk: (chunk: string) => Promise<void>;
  callBodyFinish: () => Promise<void>;

  // Finish of tellask call block; callId computed via content-hash for replay correlation.
  callFinish: (callId: string) => Promise<void>;
}

type FirstLineMentionParse =
  | { kind: 'pending_first_char' }
  | { kind: 'pending_mention_chars'; raw: string }
  | { kind: 'resolved'; validation: TellaskCallValidation };

interface ActiveCall {
  kind: 'active';
  validation: TellaskCallValidation | null;
  firstLineMentionParse: FirstLineMentionParse;
  headLine: string;
  body: string;
  callLineIndex: number;
  phase: 'headline' | 'body';
  headLineFinished: boolean;
  bodyStarted: boolean;
  callStartEmitted: boolean;
}

type CallLineRole = 'headline' | 'body';

export class TellaskStreamParser {
  private readonly downstream: TellaskEventsReceiver;

  private callCounter: number = 0;
  private readonly collectedCalls: CollectedTellaskCall[] = [];

  private markdownStarted: boolean = false;
  private markdownChunkBuffer: string = '';

  private activeCall: ActiveCall | null = null;
  private headlineBuffer: string = '';
  private bodyBuffer: string = '';

  private isAtLineStart: boolean = true;
  private lineStartProbe: '' | '!' = '';
  private currentLineKind: 'unknown' | 'markdown' | 'call' = 'unknown';
  private pendingCallLineRole: boolean = false;
  private currentCallLineRole: CallLineRole | null = null;

  constructor(downstream: TellaskEventsReceiver) {
    this.downstream = downstream;
  }

  public async takeUpstreamChunk(chunk: string): Promise<void> {
    let pos = 0;
    while (pos < chunk.length) {
      const char = chunk[pos] ?? '';

      if (this.isAtLineStart && this.currentLineKind === 'unknown') {
        const consumed = await this.processLineStartProbe(char);
        if (consumed) {
          pos += 1;
          continue;
        }
        // Not consumed means we decided the line kind and need to re-process this char
        // with the decided line kind.
      }

      if (this.currentLineKind === 'markdown') {
        await this.processMarkdownChar(char);
        pos += 1;
        continue;
      }

      if (this.currentLineKind === 'call') {
        await this.processCallChar(char);
        pos += 1;
        continue;
      }

      // Fallback: should be unreachable, but keep safe to avoid infinite loops.
      await this.processMarkdownChar(char);
      pos += 1;
    }

    await this.flushAtUpstreamChunkEnd();
  }

  public async finalize(): Promise<void> {
    // Resolve any pending single-char probe at start-of-line.
    if (this.isAtLineStart && this.currentLineKind === 'unknown' && this.lineStartProbe === '!') {
      // This is a markdown separator line starting with '!' but not enough chars to be `!?`.
      await this.endActiveCallBlockIfAny();
      this.markdownChunkBuffer += '!';
      this.lineStartProbe = '';
    }

    // End-of-input can terminate a call without a trailing newline.
    if (this.activeCall) {
      await this.resolvePendingFirstLineMentionAtEofIfNeeded();
      await this.endActiveCallBlockIfAny();
    }

    if (this.markdownChunkBuffer.length > 0) {
      if (!this.markdownStarted) {
        await this.downstream.markdownStart();
        this.markdownStarted = true;
      }
      await this.downstream.markdownChunk(this.markdownChunkBuffer);
      this.markdownChunkBuffer = '';
    }
    if (this.markdownStarted) {
      await this.downstream.markdownFinish();
      this.markdownStarted = false;
    }
  }

  public getCollectedCalls(): CollectedTellaskCall[] {
    return [...this.collectedCalls];
  }

  private async processLineStartProbe(char: string): Promise<boolean> {
    // Returns true if the character was consumed as part of probing decision.
    if (this.lineStartProbe === '') {
      if (char === '\n') {
        // Empty line is markdown separator.
        await this.endActiveCallBlockIfAny();
        this.currentLineKind = 'markdown';
        await this.processMarkdownChar(char);
        this.resetLineStateAfterNewline();
        return true;
      }
      this.lineStartProbe = '!';
      if (char !== '!') {
        // First char isn't '!' => markdown line.
        this.lineStartProbe = '';
        await this.endActiveCallBlockIfAny();
        this.currentLineKind = 'markdown';
        // Re-process this char as markdown.
        return false;
      }
      // We saw '!' at column 0; need one more char to decide.
      return true;
    }

    // lineStartProbe === '!' means we already consumed a '!' at strict column 0.
    if (char === '\n') {
      // Line length is 1 => markdown line containing '!\n'.
      this.lineStartProbe = '';
      await this.endActiveCallBlockIfAny();
      this.currentLineKind = 'markdown';
      this.markdownChunkBuffer += '!\n';
      this.resetLineStateAfterNewline();
      return true;
    }

    if (char === '?') {
      // Confirmed call line prefix `!?` at column 0.
      this.lineStartProbe = '';
      await this.ensureCallLineModeStart();
      return true;
    }

    // Not `!?` => markdown line starting with '!' then current char.
    this.lineStartProbe = '';
    await this.endActiveCallBlockIfAny();
    this.currentLineKind = 'markdown';
    this.markdownChunkBuffer += '!' + char;
    this.isAtLineStart = false;
    return true;
  }

  private async ensureCallLineModeStart(): Promise<void> {
    // Transition from markdown to call line: finalize markdown fragment if active.
    if (this.markdownChunkBuffer.length > 0) {
      if (!this.markdownStarted) {
        await this.downstream.markdownStart();
        this.markdownStarted = true;
      }
      await this.downstream.markdownChunk(this.markdownChunkBuffer);
      this.markdownChunkBuffer = '';
    }
    if (this.markdownStarted) {
      await this.downstream.markdownFinish();
      this.markdownStarted = false;
    }

    this.currentLineKind = 'call';
    this.isAtLineStart = false;
    this.pendingCallLineRole = true;
    this.currentCallLineRole = null;

    if (!this.activeCall) {
      this.activeCall = {
        kind: 'active',
        validation: null,
        firstLineMentionParse: { kind: 'pending_first_char' },
        headLine: '',
        body: '',
        callLineIndex: 0,
        phase: 'headline',
        headLineFinished: false,
        bodyStarted: false,
        callStartEmitted: false,
      };
    } else {
      this.activeCall.callLineIndex += 1;
    }
  }

  private async processMarkdownChar(char: string): Promise<void> {
    // Markdown content includes all characters verbatim.
    this.markdownChunkBuffer += char;
    if (char === '\n') {
      this.resetLineStateAfterNewline();
    } else {
      this.isAtLineStart = false;
    }
  }

  private async processCallChar(char: string): Promise<void> {
    const call = this.activeCall;
    if (!call) {
      // Should never happen: call line implies active call. Fall back to markdown.
      await this.processMarkdownChar(char);
      return;
    }

    if (this.pendingCallLineRole) {
      const role = this.decideCallLineRole(call, char);
      this.pendingCallLineRole = false;
      this.currentCallLineRole = role;

      if (role === 'body') {
        if (call.phase === 'headline') {
          await this.finishHeadlineIfNeeded();
          await this.startBodyIfNeeded();
          call.phase = 'body';
        }
      }
    }

    // First line mention validation is based on the first tellask line only.
    if (call.callLineIndex === 0 && call.phase === 'headline') {
      await this.processFirstLineMentionParse(char);
    }

    if (this.currentCallLineRole === 'headline') {
      this.headlineBuffer += char;
    } else {
      this.bodyBuffer += char;
    }

    if (char === '\n') {
      this.resetLineStateAfterNewline();
    } else {
      this.isAtLineStart = false;
    }
  }

  private decideCallLineRole(call: ActiveCall, firstCharAfterPrefix: string): CallLineRole {
    if (call.phase === 'body') return 'body';
    if (call.callLineIndex === 0) return 'headline';
    return firstCharAfterPrefix === '@' ? 'headline' : 'body';
  }

  private async processFirstLineMentionParse(char: string): Promise<void> {
    const call = this.activeCall;
    if (!call) return;

    const parse = call.firstLineMentionParse;
    if (parse.kind === 'resolved') return;

    if (parse.kind === 'pending_first_char') {
      if (char === '\n') {
        await this.resolveFirstLineMention({ kind: 'malformed', reason: 'missing_mention_prefix' });
        return;
      }
      if (char !== '@') {
        await this.resolveFirstLineMention({ kind: 'malformed', reason: 'missing_mention_prefix' });
        return;
      }
      call.firstLineMentionParse = { kind: 'pending_mention_chars', raw: '' };
      return;
    }

    if (parse.kind === 'pending_mention_chars') {
      if (this.isValidMentionChar(char)) {
        call.firstLineMentionParse = { kind: 'pending_mention_chars', raw: parse.raw + char };
        return;
      }

      const trimmed = this.trimTrailingDots(parse.raw);
      if (trimmed.length > 0) {
        await this.resolveFirstLineMention({ kind: 'valid', firstMention: trimmed });
      } else {
        await this.resolveFirstLineMention({ kind: 'malformed', reason: 'invalid_mention_id' });
      }
      return;
    }
  }

  private async resolveFirstLineMention(validation: TellaskCallValidation): Promise<void> {
    const call = this.activeCall;
    if (!call) return;

    call.validation = validation;
    call.firstLineMentionParse = { kind: 'resolved', validation };
    if (!call.callStartEmitted) {
      call.callStartEmitted = true;
      await this.downstream.callStart(validation);
    }
    await this.flushHeadlineBuffer();
  }

  private async resolvePendingFirstLineMentionAtEofIfNeeded(): Promise<void> {
    const call = this.activeCall;
    if (!call) return;
    if (call.callLineIndex !== 0) return;

    const parse = call.firstLineMentionParse;
    if (parse.kind === 'resolved') return;

    if (parse.kind === 'pending_first_char') {
      await this.resolveFirstLineMention({ kind: 'malformed', reason: 'missing_mention_prefix' });
      return;
    }

    if (parse.kind === 'pending_mention_chars') {
      const trimmed = this.trimTrailingDots(parse.raw);
      if (trimmed.length > 0) {
        await this.resolveFirstLineMention({ kind: 'valid', firstMention: trimmed });
      } else {
        await this.resolveFirstLineMention({ kind: 'malformed', reason: 'invalid_mention_id' });
      }
    }
  }

  private async finishHeadlineIfNeeded(): Promise<void> {
    const call = this.activeCall;
    if (!call) return;
    if (call.headLineFinished) return;

    if (!call.callStartEmitted) {
      // If the first line did not contain a mention terminator, we resolve at boundary.
      await this.resolvePendingFirstLineMentionAtEofIfNeeded();
    }

    await this.flushHeadlineBuffer();
    await this.downstream.callHeadLineFinish();
    call.headLineFinished = true;
  }

  private async startBodyIfNeeded(): Promise<void> {
    const call = this.activeCall;
    if (!call) return;
    if (call.bodyStarted) return;
    await this.downstream.callBodyStart();
    call.bodyStarted = true;
  }

  private async endActiveCallBlockIfAny(): Promise<void> {
    const call = this.activeCall;
    if (!call) return;

    // If the first line never encountered an invalid mention delimiter, ensure we still resolve.
    await this.resolvePendingFirstLineMentionAtEofIfNeeded();

    await this.finishHeadlineIfNeeded();

    if (call.bodyStarted) {
      await this.flushBodyBuffer();
      await this.downstream.callBodyFinish();
    }

    const validation = call.validation ?? { kind: 'malformed', reason: 'missing_mention_prefix' };
    const callId = generateContentHash(
      `tellask\n${validation.kind === 'valid' ? validation.firstMention : ''}\n${call.headLine}\n${call.body}`,
      this.callCounter++,
    );
    this.collectedCalls.push({
      validation,
      headLine: call.headLine,
      body: call.body,
      callId,
    });
    await this.downstream.callFinish(callId);

    this.activeCall = null;
    this.headlineBuffer = '';
    this.bodyBuffer = '';
    this.pendingCallLineRole = false;
    this.currentCallLineRole = null;
  }

  private resetLineStateAfterNewline(): void {
    this.isAtLineStart = true;
    this.lineStartProbe = '';
    this.currentLineKind = 'unknown';
    this.pendingCallLineRole = false;
    this.currentCallLineRole = null;
  }

  private async flushHeadlineBuffer(): Promise<void> {
    const call = this.activeCall;
    if (!call) return;
    if (!call.callStartEmitted) return;
    if (this.headlineBuffer.length === 0) return;

    call.headLine += this.headlineBuffer;
    await this.downstream.callHeadLineChunk(this.headlineBuffer);
    this.headlineBuffer = '';
  }

  private async flushBodyBuffer(): Promise<void> {
    const call = this.activeCall;
    if (!call) return;
    if (this.bodyBuffer.length === 0) return;

    call.body += this.bodyBuffer;
    await this.downstream.callBodyChunk(this.bodyBuffer);
    this.bodyBuffer = '';
  }

  private async flushAtUpstreamChunkEnd(): Promise<void> {
    if (this.markdownChunkBuffer.length > 0) {
      if (!this.markdownStarted) {
        await this.downstream.markdownStart();
        this.markdownStarted = true;
      }
      await this.downstream.markdownChunk(this.markdownChunkBuffer);
      this.markdownChunkBuffer = '';
    }

    const call = this.activeCall;
    if (call) {
      if (call.callLineIndex === 0) {
        const parse = call.firstLineMentionParse;
        if (parse.kind === 'pending_mention_chars' && parse.raw.length > 0) {
          // Do nothing: we cannot resolve until a delimiter/newline/EOF.
        }
      }
      await this.flushHeadlineBuffer();
      if (call.bodyStarted) {
        await this.flushBodyBuffer();
      }
    }
  }

  private isValidMentionChar(char: string): boolean {
    const charCode = char.charCodeAt(0);
    return (
      // ASCII alphanumeric: a-z, A-Z, 0-9
      (charCode >= 48 && charCode <= 57) ||
      (charCode >= 65 && charCode <= 90) ||
      (charCode >= 97 && charCode <= 122) ||
      // Special allowed characters
      char === '_' ||
      char === '-' ||
      char === '.' ||
      // Unicode letters and digits
      /\p{L}/u.test(char) ||
      /\p{N}/u.test(char)
    );
  }

  private trimTrailingDots(value: string): string {
    let out = value;
    while (out.endsWith('.')) out = out.slice(0, -1);
    return out;
  }
}
