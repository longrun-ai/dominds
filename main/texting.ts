/**
 * # Texting Grammar
 *
 * This module implements a streaming parser for a conversational text format that supports
 * mentions, tool calls, code blocks, and markdown text. The parser processes text in chunks
 * and emits structured events to a receiver interface.
 *
 * ## Core Grammar Rules
 *
 * The parser recognizes three main content types that can be interleaved:
 *
 * 1. **Free Text (Markdown)** - Regular conversational content
 *    - Emitted as markdown fragments between calls and code blocks
 *    - Starts with `markdownStart()` and ends with `markdownFinish()`
 *    - Content is buffered and emitted in chunks via `markdownChunk()`
 *
 * 2. **Texting Calls** - Tool/agent invocation commands
 *    - Syntax: `!!@mention command arguments` at column 0 (no leading spaces)
 *    - **Mention Syntax**: `@` followed by mention name
 *      - **Valid characters**: Alphanumeric (a-z, A-Z, 0-9), Unicode letters/digits, underscore (`_`), hyphen (`-`), dot (`.`) for namespace separation
 *      - **Trailing dot**: a trailing `.` is treated as punctuation and ignored for mention parsing
 *      - **Invalid characters** (mention ends when encountered): space, newline, tab, colon (`:`), and any other non-valid character
 *      - Examples: `@tool1`, `@user1`, `@namespace.tool1`, `@user_name`, `@user-name`
 *    - First mention determines the target
 *    - May have an optional body after the headline
 *    - Terminated by `!!@/` or start of next call at line boundary
 *
 * 3. **Code Blocks** - Triple-quoted content
 *    - Syntax: ```[infoLine]\ncontent\n```
 *    - Info line (e.g., `javascript`, `python`) is optional
 *    - Content is treated literally, no markdown processing
 *
 * ## Call Body Processing Rules
 *
 * The parser implements sophisticated body content handling:
 *
 * ### Call Body Types
 * - **Regular Body**: Non-triple-quoted content
 *   - All content including `@mentions` and `` `backticks` `` treated as literal text
 *   - Only `!!@/` at line start can terminate the call
 *
 * - **Triple-Quoted Body**: Body that starts with triple backticks
 *   - Opening triple backticks are preserved verbatim in `callBodyStart(infoLine)`
 *   - Content including nested triple backticks is preserved literally
 *   - Call terminates at closing triple backticks followed by newline/end
 *
 * ### Call Termination Rules
 * - **!!@/ termination**: Explicit termination marker, works in streaming scenarios
 * - **Line-boundary `!!@`**: New call starting at column 0 (only in non-triple-quoted bodies)
 * - **End-of-input**: Automatic termination in `finalize()`
 *
 * ## Streaming Behavior
 *
 * The parser is designed for real-time streaming:
 * - Processes input character by character in chunks
 * - Emits downstream chunks aligned to upstream chunk boundaries when possible
 * - Handles chunk boundaries intelligently (no content loss)
 * - Supports pending state for markers that span chunks (`!!@/` termination)
 *
 * ## Event Sequence Rules
 *
 * Valid event sequences follow these patterns:
 *
 * **Call Events:**
 * ```
 * callStart(firstMention)
 * callHeadLineChunk()*          // One or more chunks
 * callHeadLineFinish()
 * [callBodyStart(infoLine)?]    // Optional, only if body exists
 * [callBodyChunk()*]            // Optional, only if body exists
 * [callBodyFinish(endQuote)?]   // Optional, only if body exists
 * callFinish()
 * ```
 *
 * **Markdown Events:**
 * ```
 * markdownStart()
 * markdownChunk()*              // One or more chunks
 * markdownFinish()
 * ```
 *
 * **Code Block Events:**
 * ```
 * codeBlockStart(infoLine)
 * codeBlockChunk()*             // One or more chunks
 * codeBlockFinish(endQuote)
 * ```
 *
 * ## Mode Transitions
 *
 * The parser operates in six modes with well-defined transitions:
 *
 * - **FREE_TEXT**: Processing regular text, looks for `!!@` or triple backticks
 * - **TEXTING_CALL_HEADLINE**: Processing call headline, accumulates first mention
 * - **TEXTING_CALL_BEFORE_BODY**: Between headline and body, detects body type
 * - **TEXTING_CALL_BODY**: Processing call body content
 * - **CODE_BLOCK_INFO**: Reading code block info line
 * - **CODE_BLOCK_CONTENT**: Processing code block content
 *
 * ## Character Classification
 *
 * The parser classifies characters for efficient processing:
 * - **AT** (`@`): Mention/call indicators
 * - **NEWLINE** (`\n`): Line boundaries for call termination
 * - **SPACE** (` `): Whitespace handling
 * - **BACKTICK** (`` ` ``): Code block detection
 * - **OTHER**: All other characters
 *
 * ## Implementation Notes
 *
 * - **Chunking**: No fixed internal chunk size; downstream chunks generally follow upstream boundaries
 * - **State Management**: Complex state tracking for mentions, backticks, and mode transitions
 * - **Edge Cases**: Handles empty chunks, special characters, Unicode, and boundary conditions
 * - **Performance**: Optimized for streaming scenarios with minimal look-ahead
 * - **Memory**: Bounded buffers prevent memory growth during long streams
 */

export interface CollectedTextingCall {
  firstMention: string;
  headLine: string;
  body: string;
  callId: string;
}

export interface TextingEventsReceiver {
  // interleaved free text segments between calls and code-blocks are emitted as markdown fragments
  markdownStart: () => Promise<void>;
  markdownChunk: (chunk: string) => Promise<void>;
  markdownFinish: () => Promise<void>;

  // start of texting call - firstMention determines target
  callStart: (firstMention: string) => Promise<void>;

  // include all white spaces from upstream
  callHeadLineChunk: (chunk: string) => Promise<void>;
  callHeadLineFinish: () => Promise<void>;

  // could be a tripple quoted body, or not
  // infoLine includes the leading triple quote, if present
  callBodyStart: (infoLine?: string) => Promise<void>;

  // include all white spaces from upstream
  callBodyChunk: (chunk: string) => Promise<void>;

  // could be a tripple quoted body, or not
  // endQuote be the triple quote, if present
  callBodyFinish: (endQuote?: string) => Promise<void>;

  // finish of texting call, maps 1:1 to callBodyFinish()
  // callId is computed at finish via content-hash for replay correlation
  callFinish: (callId: string) => Promise<void>;

  // triple quoted code blocks
  codeBlockStart: (infoLine: string) => Promise<void>;
  codeBlockChunk: (chunk: string) => Promise<void>;
  codeBlockFinish: (endQuote: string) => Promise<void>;
}

import { generateContentHash } from './utils/id';

enum CharType {
  AT = 'AT',
  NEWLINE = 'NEWLINE',
  SPACE = 'SPACE',
  BACKTICK = 'BACKTICK',
  OTHER = 'OTHER',
}

enum BacktickState {
  NONE = 'NONE',
  SINGLE = 'SINGLE',
  DOUBLE = 'DOUBLE',
  TRIPLE_START = 'TRIPLE_START',
  TRIPLE_CONTENT = 'TRIPLE_CONTENT',
}

enum ParserMode {
  FREE_TEXT = 'FREE_TEXT',
  TEXTING_CALL_HEADLINE = 'TEXTING_CALL_HEADLINE',
  TEXTING_CALL_BEFORE_BODY = 'TEXTING_CALL_BEFORE_BODY',
  TEXTING_CALL_BODY = 'TEXTING_CALL_BODY',
  CODE_BLOCK_INFO = 'CODE_BLOCK_INFO',
  CODE_BLOCK_CONTENT = 'CODE_BLOCK_CONTENT',
}

const TEXTING_CALL_PREFIX = '!!@';
const TEXTING_CALL_TERMINATOR = '!!@/';

export class TextingStreamParser {
  private readonly downstream: TextingEventsReceiver;

  // Current callId for tool call correlation (computed at finish via content-hash)
  private currentCallId: string | null = null;

  // Call counter for content-hash generation (ensures deterministic but unique callIds)
  private callCounter: number = 0;

  constructor(downstream: TextingEventsReceiver) {
    this.downstream = downstream;
  }

  private markdownStarted = false;

  // Parser state
  private mode: ParserMode = ParserMode.FREE_TEXT;
  private backtickState: BacktickState = BacktickState.NONE;
  private backtickCount = 0;
  private inSingleBacktick = false;
  private backtickRunStartedAtLineStart = false;

  // Free text state
  private markdownChunkBuffer = '';

  // Call state
  private hasBody = false;
  private isTripleQuotedBody = false;
  private tripleQuotedBodyOpen = false;
  private tripleQuotedBodyClose = false;
  private tripleQuotedBodyFenceLength = 3;
  private tripleQuotedBodyClosingCandidateActive = false;
  private tripleQuotedBodyClosingCandidateBackticks = 0;

  // Headline processing state
  private headlineBuffer = '';
  private firstMentionAccumulator = '';
  private headlineFinished = false;
  private expectingFirstMention = true; // Track if we're expecting a new first mention
  private headlineHasContent = false;
  private callStartEmitted = false;
  private pendingHeadlineNewline = false;
  private pendingHeadlineNewlineWhitespace = '';

  // Body processing state
  private bodyChunkBuffer = '';
  private isAtLineStart = true;
  private pendingLineStartMarker: '' | '!' | '!!' | '!!@' = '';
  private pendingLineStartMarkerWasLineStart = false;
  private pendingInitialBackticks = 0; // Backticks seen before deciding body type
  private beforeBodyWhitespaceBuffer = ''; // Whitespace/newlines observed in BEFORE_BODY (replayed if body exists)

  // Code block state
  private codeBlockChunkBuffer = '';
  private codeBlockInfoAccumulator = '';
  private currentCodeBlockFenceLength = 3;
  private pendingCodeBlockLineStartBackticks = '';
  private pendingCodeBlockLineStartWhitespace = '';

  // Call collection
  private collectedCalls: Array<{
    firstMention: string;
    headLine: string;
    body: string;
    callId: string;
  }> = [];
  private currentCall: {
    firstMention: string;
    headLine: string;
    body: string;
    callId: string;
  } | null = null;

  private ensureCurrentCall(): {
    firstMention: string;
    headLine: string;
    body: string;
    callId: string;
  } {
    if (this.currentCall) return this.currentCall;
    this.callStartEmitted = false; // Reset when starting new call
    this.currentCall = { firstMention: '', headLine: '', body: '', callId: '' };
    return this.currentCall;
  }

  private async emitCallStart(firstMention: string): Promise<void> {
    const call = this.ensureCurrentCall();
    if (call.firstMention && call.firstMention !== firstMention) {
      throw new Error(
        `TextingStreamParser: callStart mention mismatch: '${call.firstMention}' vs '${firstMention}'`,
      );
    }
    call.firstMention = firstMention;
    if (this.markdownChunkBuffer) {
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
    // callId will be computed at emitCallFinish using content-hash
    // This ensures replay generates the same callId for correlation
    await this.downstream.callStart(firstMention);
    this.callStartEmitted = true;
  }

  private async emitCallFinish(): Promise<void> {
    const hadCallStart = this.callStartEmitted;
    this.callStartEmitted = false;
    if (!this.currentCall || !hadCallStart || !this.currentCall.firstMention) {
      this.currentCall = null;
      return;
    }
    const done = this.currentCall;
    this.currentCall = null;
    // Compute callId using content-hash for deterministic replay correlation.
    //
    // IMPORTANT: Normalize line endings and trim trailing whitespace so callId remains stable
    // across (a) streaming chunk boundaries and (b) persistence/replay, which may not preserve
    // trailing newlines verbatim in agent_words_record content.
    const normalizeForHash = (value: string): string => value.replace(/\r\n/g, '\n').trimEnd();
    const content = `${normalizeForHash(done.firstMention.trim())}\n${normalizeForHash(done.headLine)}\n${normalizeForHash(done.body)}`;
    this.callCounter++;
    done.callId = generateContentHash(content, this.callCounter);
    this.currentCallId = done.callId;
    this.collectedCalls.push(done);
    await this.downstream.callFinish(done.callId);
  }

  private enterHeadlineAfterExplicitPrefix(): void {
    this.mode = ParserMode.TEXTING_CALL_HEADLINE;
    this.firstMentionAccumulator = '@';
    this.headlineBuffer = '@';
    this.headlineFinished = false;
    this.expectingFirstMention = true;
    this.headlineHasContent = false;

    this.hasBody = false;
    this.isTripleQuotedBody = false;
    this.tripleQuotedBodyOpen = false;
    this.tripleQuotedBodyClose = false;
    this.tripleQuotedBodyFenceLength = 3;
    this.tripleQuotedBodyClosingCandidateActive = false;
    this.tripleQuotedBodyClosingCandidateBackticks = 0;
    this.bodyChunkBuffer = '';
    this.pendingInitialBackticks = 0;
    this.beforeBodyWhitespaceBuffer = '';
  }

  private async endCurrentCallFromBodyToFreeText(): Promise<void> {
    await this.flushBodyBuffer();
    await this.downstream.callBodyFinish();
    await this.emitCallFinish();
    this.mode = ParserMode.FREE_TEXT;

    // Keep markdown streaming state consistent with the legacy behavior.
    const hasMarkdownContent = this.markdownChunkBuffer.length > 0;
    this.markdownChunkBuffer = '';
    if (hasMarkdownContent) {
      this.markdownStarted = true;
      await this.downstream.markdownStart();
    } else {
      this.markdownStarted = false;
    }
  }

  private async endCurrentCallFromBodyToNewCall(): Promise<void> {
    await this.flushBodyBuffer();
    await this.downstream.callBodyFinish();
    await this.emitCallFinish();
    this.enterHeadlineAfterExplicitPrefix();
  }

  private abortCallToMarkdown(): void {
    if (this.headlineBuffer) {
      this.markdownChunkBuffer += this.headlineBuffer;
    }
    this.headlineBuffer = '';
    this.firstMentionAccumulator = '';
    this.headlineFinished = false;
    this.expectingFirstMention = true;
    this.callStartEmitted = false;
    this.currentCall = null;
    this.hasBody = false;
    this.isTripleQuotedBody = false;
    this.tripleQuotedBodyOpen = false;
    this.tripleQuotedBodyClose = false;
    this.tripleQuotedBodyFenceLength = 3;
    this.tripleQuotedBodyClosingCandidateActive = false;
    this.tripleQuotedBodyClosingCandidateBackticks = 0;
    this.bodyChunkBuffer = '';
    this.pendingLineStartMarker = '';
    this.pendingLineStartMarkerWasLineStart = false;
    this.headlineHasContent = false;
    this.pendingHeadlineNewline = false;
    this.pendingHeadlineNewlineWhitespace = '';
    this.beforeBodyWhitespaceBuffer = '';
    this.mode = ParserMode.FREE_TEXT;
  }

  private normalizeFirstMentionAccumulator(): void {
    while (this.firstMentionAccumulator.length > 1 && this.firstMentionAccumulator.endsWith('.')) {
      this.firstMentionAccumulator = this.firstMentionAccumulator.slice(0, -1);
    }
  }

  private hasValidFirstMention(): boolean {
    return this.firstMentionAccumulator.length > 1;
  }

  public async takeUpstreamChunk(chunk: string): Promise<void> {
    let position = 0;

    while (position < chunk.length) {
      const char = chunk[position];
      const charType = this.getCharType(char);
      const currentMode = this.mode;

      switch (this.mode) {
        case ParserMode.FREE_TEXT:
          position = await this.processFreeTextChunk(chunk, position, char, charType);
          break;
        case ParserMode.TEXTING_CALL_HEADLINE:
          position = await this.processTextingCallHeadlineChunk(chunk, position, char, charType);
          break;
        case ParserMode.TEXTING_CALL_BEFORE_BODY:
          position = await this.processTextingCallBeforeBodyChunk(chunk, position, char, charType);
          break;
        case ParserMode.TEXTING_CALL_BODY:
          position = await this.processTextingCallBodyChunk(chunk, position, char, charType);
          break;
        case ParserMode.CODE_BLOCK_INFO:
          position = await this.processCodeBlockInfoChar(chunk, position, char, charType);
          break;
        case ParserMode.CODE_BLOCK_CONTENT:
          position = await this.processCodeBlockContentChunk(chunk, position, char, charType);
          break;
      }

      // If mode changed during processing, restart processing from current position
      // This ensures the new mode processes the remaining characters correctly
      if (this.mode !== currentMode) {
        // Mode changed, restart the loop to process remaining characters with new mode
        continue;
      }
    }

    await this.flushAtUpstreamChunkEnd();
  }

  public async finalize(): Promise<void> {
    // If an upstream chunk ended mid-marker, flush it as literal content on finalize.
    if (this.pendingLineStartMarker !== '') {
      const pending = this.pendingLineStartMarker;
      this.pendingLineStartMarker = '';
      this.pendingLineStartMarkerWasLineStart = false;

      if (this.mode === ParserMode.FREE_TEXT) {
        this.markdownChunkBuffer += pending;
      } else if (this.mode === ParserMode.TEXTING_CALL_BEFORE_BODY) {
        this.hasBody = true;
        await this.downstream.callBodyStart();
        this.mode = ParserMode.TEXTING_CALL_BODY;
        this.bodyChunkBuffer = `${this.beforeBodyWhitespaceBuffer}${pending}`;
        this.beforeBodyWhitespaceBuffer = '';
        this.isAtLineStart = false;
      } else if (this.mode === ParserMode.TEXTING_CALL_BODY) {
        this.bodyChunkBuffer += pending;
      }
    }

    if (this.markdownChunkBuffer) {
      if (!this.markdownStarted) {
        await this.downstream.markdownStart();
        this.markdownStarted = true;
      }
      await this.downstream.markdownChunk(this.markdownChunkBuffer);
      this.markdownChunkBuffer = '';
    }

    // Resolve any pending line-start fence candidate in a code block at EOF.
    if (this.mode === ParserMode.CODE_BLOCK_CONTENT && this.pendingCodeBlockLineStartBackticks) {
      if (this.pendingCodeBlockLineStartBackticks.length >= this.currentCodeBlockFenceLength) {
        if (this.codeBlockChunkBuffer) {
          await this.flushCodeBlockBuffer();
        }
        await this.downstream.codeBlockFinish('');
        this.mode = ParserMode.FREE_TEXT;
      } else {
        this.codeBlockChunkBuffer +=
          this.pendingCodeBlockLineStartBackticks + this.pendingCodeBlockLineStartWhitespace;
      }
      this.pendingCodeBlockLineStartBackticks = '';
      this.pendingCodeBlockLineStartWhitespace = '';
    }

    if (this.codeBlockChunkBuffer) {
      await this.flushCodeBlockBuffer();
    }

    if (this.mode === ParserMode.CODE_BLOCK_CONTENT) {
      await this.downstream.codeBlockFinish('');
      this.mode = ParserMode.FREE_TEXT;
    }

    // If we ended while still deciding whether a call has a body and we saw leading backticks,
    // treat them as the body start (fenced if length >= 3).
    if (this.mode === ParserMode.TEXTING_CALL_BEFORE_BODY && this.pendingInitialBackticks > 0) {
      const openingFenceLength = this.pendingInitialBackticks;
      const openingFence = '`'.repeat(openingFenceLength);
      this.pendingInitialBackticks = 0;

      this.hasBody = true;
      if (openingFenceLength >= 3) {
        this.isTripleQuotedBody = true;
        this.tripleQuotedBodyOpen = true;
        this.tripleQuotedBodyFenceLength = openingFenceLength;
        this.tripleQuotedBodyClosingCandidateActive = false;
        this.tripleQuotedBodyClosingCandidateBackticks = 0;
        await this.downstream.callBodyStart(openingFence);
      } else {
        await this.downstream.callBodyStart();
      }

      this.mode = ParserMode.TEXTING_CALL_BODY;
      this.bodyChunkBuffer = `${this.beforeBodyWhitespaceBuffer}${openingFence}`;
      this.beforeBodyWhitespaceBuffer = '';
      this.isAtLineStart = false;
    }

    if (this.mode === ParserMode.TEXTING_CALL_HEADLINE) {
      if (!this.callStartEmitted) {
        this.normalizeFirstMentionAccumulator();
      }
      if (!this.callStartEmitted && !this.hasValidFirstMention()) {
        this.abortCallToMarkdown();
      } else {
        if (!this.callStartEmitted && this.hasValidFirstMention()) {
          const firstMention = this.firstMentionAccumulator.substring(1);
          await this.emitCallStart(firstMention);
          this.firstMentionAccumulator = '';
          this.expectingFirstMention = false;
        }
        await this.flushHeadlineBuffer();
        await this.downstream.callHeadLineFinish();
        this.headlineFinished = true;

        // Only emit callFinish if a call was actually started (currentCall has firstMention)
        if (this.currentCall?.firstMention) {
          await this.emitCallFinish();
        }
      }
    } else if (this.mode === ParserMode.TEXTING_CALL_BEFORE_BODY) {
      // Only emit callFinish if a call was actually started (this.currentCall exists)
      this.beforeBodyWhitespaceBuffer = '';
      this.pendingInitialBackticks = 0;
      if (this.currentCall) {
        await this.emitCallFinish();
      }
    } else if (this.mode === ParserMode.TEXTING_CALL_BODY) {
      await this.flushBodyBuffer();
      await this.downstream.callBodyFinish(
        this.isTripleQuotedBody
          ? '`'.repeat(
              this.tripleQuotedBodyClosingCandidateActive &&
                this.tripleQuotedBodyClosingCandidateBackticks >= this.tripleQuotedBodyFenceLength
                ? this.tripleQuotedBodyClosingCandidateBackticks
                : this.tripleQuotedBodyFenceLength,
            )
          : undefined,
      );

      // Only emit callFinish if a call was actually started (this.currentCall exists)
      if (this.currentCall) {
        await this.emitCallFinish();
      }
    }

    if (this.markdownChunkBuffer) {
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

  public getCollectedCalls(): CollectedTextingCall[] {
    return [...this.collectedCalls];
  }

  // Character type detection
  private getCharType(char: string): CharType {
    if (char === '@') return CharType.AT;
    if (char === '\n') return CharType.NEWLINE;
    if (char === ' ') return CharType.SPACE;
    if (char === '`') return CharType.BACKTICK;
    return CharType.OTHER;
  }

  // Check if character is valid for mention names
  private isValidMentionChar(char: string): boolean {
    const charCode = char.charCodeAt(0);
    return (
      // ASCII alphanumeric: a-z, A-Z, 0-9
      (charCode >= 48 && charCode <= 57) || // 0-9
      (charCode >= 65 && charCode <= 90) || // A-Z
      (charCode >= 97 && charCode <= 122) || // a-z
      // Special allowed characters
      char === '_' ||
      char === '-' ||
      char === '.' ||
      // Unicode letters and digits
      /\p{L}/u.test(char) ||
      /\p{N}/u.test(char)
    );
  }

  // Free text processing
  private async processFreeTextChunk(
    chunk: string,
    position: number,
    char: string,
    charType: CharType,
  ): Promise<number> {
    // If a backtick run just ended at strict column 0 and is long enough, it starts a fenced
    // code block. We must decide only when the run ends (on a non-backtick character) so
    // 4+ backticks work correctly in streaming mode.
    if (charType !== CharType.BACKTICK) {
      const endedBacktickRunCount = this.backtickCount;
      const endedBacktickRunStartedAtLineStart = this.backtickRunStartedAtLineStart;
      const wasInSingleBacktick = this.inSingleBacktick;

      if (
        !wasInSingleBacktick &&
        endedBacktickRunStartedAtLineStart &&
        endedBacktickRunCount >= 3 &&
        this.markdownChunkBuffer.endsWith('`'.repeat(endedBacktickRunCount))
      ) {
        // Drop the entire opening fence from markdown output.
        this.markdownChunkBuffer = this.markdownChunkBuffer.slice(0, -endedBacktickRunCount);

        if (this.markdownChunkBuffer.length > 0) {
          if (!this.markdownStarted) {
            await this.downstream.markdownStart();
            this.markdownStarted = true;
          }
          await this.downstream.markdownChunk(this.markdownChunkBuffer);
        }
        if (this.markdownStarted) {
          await this.downstream.markdownFinish();
          this.markdownStarted = false;
        }

        this.markdownChunkBuffer = '';
        this.currentCodeBlockFenceLength = endedBacktickRunCount;
        this.pendingCodeBlockLineStartBackticks = '';
        this.pendingCodeBlockLineStartWhitespace = '';
        this.mode = ParserMode.CODE_BLOCK_INFO;
        this.codeBlockInfoAccumulator = '';

        // Reset backtick state on transition.
        this.backtickCount = 0;
        this.backtickState = BacktickState.NONE;
        this.inSingleBacktick = false;
        this.backtickRunStartedAtLineStart = false;

        // Re-process the current character as the first char of the code-block info line.
        return position;
      }
    }

    // Update backtick state for non-backtick characters (this handles toggling inSingleBacktick
    // when we just saw a single backtick before the current character).
    if (charType !== CharType.BACKTICK) {
      this.updateBacktickState(charType);
    }

    // Texting call headlines are explicitly marked with `!!@` at line start.
    // Plain `@...` must remain regular text to avoid misinterpretation.
    if (
      !this.inSingleBacktick &&
      (this.pendingLineStartMarker !== '' || (this.isAtLineStart && char === '!'))
    ) {
      // Continue a pending `!!@` prefix that spanned upstream chunks.
      if (this.pendingLineStartMarker !== '') {
        const wasLineStart = this.pendingLineStartMarkerWasLineStart;
        const pending = this.pendingLineStartMarker;
        this.pendingLineStartMarker = '';
        this.pendingLineStartMarkerWasLineStart = false;

        if (wasLineStart) {
          if (pending === '!') {
            if (char === '!') {
              this.pendingLineStartMarker = '!!';
              this.pendingLineStartMarkerWasLineStart = true;
              return position + 1;
            }
            this.markdownChunkBuffer += '!';
            this.isAtLineStart = false;
            return position; // reprocess current char as normal text
          }
          if (pending === '!!') {
            if (char === '@') {
              this.pendingLineStartMarker = '!!@';
              this.pendingLineStartMarkerWasLineStart = true;
              return position + 1;
            }
            this.markdownChunkBuffer += '!!';
            this.isAtLineStart = false;
            return position;
          }
          if (pending === '!!@') {
            if (char === '/') {
              // `!!@/` in FREE_TEXT is a literal string, NOT a call terminator.
              this.markdownChunkBuffer += TEXTING_CALL_TERMINATOR;
              this.isAtLineStart = false;
              return position + 1;
            }
            if (this.isValidMentionChar(char)) {
              // Start a new call: the downstream parser still expects headline content starting with '@'.
              this.mode = ParserMode.TEXTING_CALL_HEADLINE;
              this.firstMentionAccumulator = '@';
              this.headlineBuffer = '@';
              this.headlineFinished = false;
              this.expectingFirstMention = true;
              this.headlineHasContent = false;
              return await this.processTextingCallHeadlineChunk(chunk, position, char, charType);
            }
            // Not a valid mention start: treat `!!@` literally.
            this.markdownChunkBuffer += TEXTING_CALL_PREFIX;
            this.isAtLineStart = false;
            return position;
          }
        }

        // If the marker wasn't at line start, always treat it literally.
        this.markdownChunkBuffer += pending;
        this.isAtLineStart = false;
        return position;
      }

      // New `!!@` marker candidate at line start.
      if (this.isAtLineStart && char === '!') {
        if (position + 1 >= chunk.length) {
          this.pendingLineStartMarker = '!';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 1;
        }
        if (chunk[position + 1] !== '!') {
          this.markdownChunkBuffer += '!';
          this.isAtLineStart = false;
          return position + 1;
        }
        if (position + 2 >= chunk.length) {
          this.pendingLineStartMarker = '!!';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 2;
        }
        if (chunk[position + 2] !== '@') {
          this.markdownChunkBuffer += '!';
          this.isAtLineStart = false;
          return position + 1;
        }
        if (position + 3 >= chunk.length) {
          this.pendingLineStartMarker = '!!@';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 3;
        }
        const nextChar = chunk[position + 3];
        if (nextChar === '/') {
          this.markdownChunkBuffer += TEXTING_CALL_TERMINATOR;
          this.isAtLineStart = false;
          return position + 4;
        }
        if (this.isValidMentionChar(nextChar)) {
          this.mode = ParserMode.TEXTING_CALL_HEADLINE;
          this.firstMentionAccumulator = '@';
          this.headlineBuffer = '@';
          this.headlineFinished = false;
          this.expectingFirstMention = true;
          this.headlineHasContent = false;
          return await this.processTextingCallHeadlineChunk(
            chunk,
            position + 3,
            nextChar,
            this.getCharType(nextChar),
          );
        }
        // `!!@` followed by invalid mention starter: treat `!!@` literally and continue.
        this.markdownChunkBuffer += TEXTING_CALL_PREFIX;
        this.isAtLineStart = false;
        return position + 3;
      }
    }

    // Track backticks verbatim in FREE_TEXT. (Opening fences are handled when the run ends.)
    if (charType === CharType.BACKTICK) {
      this.updateBacktickState(charType);

      this.markdownChunkBuffer += char;

      this.isAtLineStart = false;
      return position + 1;
    } else {
      // Regular markdown processing for non-backtick characters
      this.markdownChunkBuffer += char;
    }

    // Strict column-0 semantics: a call headline/terminator must start at the very first column.
    // Any leading whitespace means we're no longer at line start.
    this.isAtLineStart = charType === CharType.NEWLINE;
    return position + 1;
  }

  // Call headline processing
  private async processTextingCallHeadlineChunk(
    chunk: string,
    position: number,
    char: string,
    charType: CharType,
  ): Promise<number> {
    this.ensureCurrentCall();

    if (this.pendingHeadlineNewline) {
      // We saw a newline at the end of an upstream chunk while parsing the headline.
      // Decide in the next chunk whether this newline belongs to the headline (multi-line headline)
      // or is the headline/body separator.
      if (char === ' ' || char === '\t') {
        this.pendingHeadlineNewlineWhitespace += char;
        return position + 1;
      }

      if (charType === CharType.AT) {
        // Multi-line headline continuation: include the deferred newline + any indentation.
        this.headlineBuffer += `\n${this.pendingHeadlineNewlineWhitespace}`;
        this.pendingHeadlineNewline = false;
        this.pendingHeadlineNewlineWhitespace = '';
        return position;
      }

      // Anything else starts the body (newline is the separator, not headline content).
      //
      // IMPORTANT: the whitespace immediately after the newline might actually be the first-line
      // indentation of the call body (e.g. a tool body that starts with two spaces). When the
      // newline falls exactly on an upstream chunk boundary, we must NOT drop this whitespace.
      this.beforeBodyWhitespaceBuffer = this.pendingHeadlineNewlineWhitespace;
      this.pendingHeadlineNewline = false;
      this.pendingHeadlineNewlineWhitespace = '';

      if (this.hasValidFirstMention()) {
        const firstMention = this.firstMentionAccumulator.substring(1);
        await this.emitCallStart(firstMention);
        this.firstMentionAccumulator = '';
        this.expectingFirstMention = false;
      }
      await this.flushHeadlineBuffer();
      await this.downstream.callHeadLineFinish();
      this.headlineFinished = true;
      this.mode = ParserMode.TEXTING_CALL_BEFORE_BODY;
      this.isAtLineStart = true;
      return position;
    }

    if (charType === CharType.AT) {
      // Update backtick state for @ character
      this.updateBacktickState(charType);

      if (!this.inSingleBacktick) {
        // Handle @ character when firstMentionAccumulator is empty (e.g., after mode switch from FREE_TEXT)
        // In this case, we need to set firstMentionAccumulator to '@' so the subsequent characters are accumulated
        if (this.firstMentionAccumulator === '') {
          this.firstMentionAccumulator = '@';
          this.headlineBuffer += '@';
          return position + 1;
        }
        // Only start a new mention if we're expecting one
        if (this.expectingFirstMention) {
          this.firstMentionAccumulator = '@';
          this.headlineBuffer += '@'; // Add @ to headline buffer too
          return position + 1;
        } else {
          // We're in headline mode, treat @ as regular content
          // Only add @ if not already at the start of headlineBuffer (avoids double-add when space follows mention)
          if (!this.headlineBuffer.endsWith('@')) {
            this.headlineBuffer += '@';
          }

          return position + 1;
        }
      } else {
        // Inside single backticks, treat @ as regular headline content
        this.headlineBuffer += char;
        this.headlineHasContent = true;
        return position + 1;
      }
    }

    if (charType === CharType.NEWLINE) {
      if (!this.callStartEmitted) {
        this.normalizeFirstMentionAccumulator();
      }
      if (!this.callStartEmitted && !this.hasValidFirstMention()) {
        this.abortCallToMarkdown();
        return position;
      }
      // Update backtick state for newline character
      this.updateBacktickState(charType);

      // Look ahead to see if the body starts with triple backticks, or if this is a multi-line headline.
      let aheadPos = position + 1;

      // First, check for triple backticks after the newline (wholly triple quoted body)
      if (aheadPos < chunk.length) {
        const nextChar = chunk[aheadPos];
        if (nextChar === '`') {
          // Check if we have triple backticks starting after the newline
          let backtickCount = 0;
          let checkPos = aheadPos;
          while (checkPos < chunk.length && chunk[checkPos] === '`') {
            backtickCount++;
            checkPos++;
          }

          if (backtickCount >= 3) {
            // Found triple backticks - this is a wholly triple quoted body

            // Ensure callStart is called before finishing
            if (this.hasValidFirstMention()) {
              const firstMention = this.firstMentionAccumulator.substring(1);
              await this.emitCallStart(firstMention);
              this.firstMentionAccumulator = '';
              this.expectingFirstMention = false;
            }

            await this.flushHeadlineBuffer();
            await this.downstream.callHeadLineFinish();
            this.headlineFinished = true;

            // Start triple quoted body
            this.hasBody = true;
            this.isTripleQuotedBody = true;
            this.tripleQuotedBodyOpen = true;
            this.tripleQuotedBodyFenceLength = backtickCount;
            this.tripleQuotedBodyClosingCandidateActive = false;
            this.tripleQuotedBodyClosingCandidateBackticks = 0;
            const fence = '`'.repeat(backtickCount);
            await this.downstream.callBodyStart(fence);
            this.bodyChunkBuffer = fence;
            this.mode = ParserMode.TEXTING_CALL_BODY;
            return checkPos;
          }
        }
      }

      // Multi-line headline continuation is allowed only when the next non-whitespace character
      // is `@` AND there is no extra blank line.
      while (aheadPos < chunk.length) {
        const nextChar = chunk[aheadPos];
        if (nextChar === ' ' || nextChar === '\t') {
          aheadPos++;
          continue;
        }
        if (nextChar === '\n') {
          break;
        }
        if (nextChar === '@') {
          this.expectingFirstMention = false;
          this.headlineBuffer += char;
          this.isAtLineStart = true;
          return position + 1;
        }
        break;
      }

      if (aheadPos >= chunk.length) {
        // End of chunk: defer decision to next upstream chunk so headline continuation vs body
        // is independent of chunk sizes.
        this.pendingHeadlineNewline = true;
        this.pendingHeadlineNewlineWhitespace = '';
        return position + 1;
      }

      // End of headline, start of body (or no-body path handled in BEFORE_BODY mode).
      if (this.hasValidFirstMention()) {
        const firstMention = this.firstMentionAccumulator.substring(1);
        await this.emitCallStart(firstMention);
        this.firstMentionAccumulator = '';
        this.expectingFirstMention = false;
      }

      await this.flushHeadlineBuffer();
      await this.downstream.callHeadLineFinish();
      this.headlineFinished = true;
      this.mode = ParserMode.TEXTING_CALL_BEFORE_BODY;
      this.isAtLineStart = true;
      this.beforeBodyWhitespaceBuffer = '';
      return position + 1;
    }

    if (!this.isValidMentionChar(char)) {
      // Update backtick state for non-mention characters (like backticks)
      this.updateBacktickState(charType);

      // Handle @ character when firstMentionAccumulator is empty (e.g., after mode switch from FREE_TEXT)
      if (char === '@') {
        this.firstMentionAccumulator = '@';
        this.headlineBuffer += '@';
        return position + 1;
      }

      if (!this.callStartEmitted) {
        this.normalizeFirstMentionAccumulator();
      }
      if (!this.callStartEmitted && !this.hasValidFirstMention()) {
        this.abortCallToMarkdown();
        return position;
      }

      // Only trigger callStart if we have a non-empty first mention AND haven't already emitted it
      if (this.hasValidFirstMention() && !this.callStartEmitted) {
        // More than just '@'
        // Start the call with the first mention (remove @ prefix)
        const firstMention = this.firstMentionAccumulator.substring(1); // Remove '@'
        await this.emitCallStart(firstMention);
      }

      // Clear first mention since we're now in headline content
      this.firstMentionAccumulator = '';
      this.expectingFirstMention = false; // No longer expecting a new first mention

      // Add the character to headline buffer
      // Avoid adding '@' here if headlineBuffer already ends with '@' (prevents double-add)
      if (char !== '@' || !this.headlineBuffer.endsWith('@')) {
        this.headlineBuffer += char;
      }

      return position + 1;
    }

    // Accumulate first mention if character is valid for mention names
    if (this.firstMentionAccumulator !== '') {
      const charCode = char.charCodeAt(0);
      const isValid =
        // ASCII alphanumeric: a-z, A-Z, 0-9
        (charCode >= 48 && charCode <= 57) || // 0-9
        (charCode >= 65 && charCode <= 90) || // A-Z
        (charCode >= 97 && charCode <= 122) || // a-z
        // Special allowed characters
        char === '_' ||
        char === '-' ||
        char === '.' ||
        // Unicode letters and digits
        /\p{L}/u.test(char) ||
        /\p{N}/u.test(char);

      if (isValid) {
        this.firstMentionAccumulator += char;
      } else {
        // Invalid character for mention - treat as end of mention
        // Only emit callStart if we haven't already
        if (this.firstMentionAccumulator.length > 1 && !this.callStartEmitted) {
          // More than just '@'
          const firstMention = this.firstMentionAccumulator.substring(1); // Remove '@'
          await this.emitCallStart(firstMention);
        }
        this.firstMentionAccumulator = '';
        this.expectingFirstMention = false;
      }
    }

    this.headlineBuffer += char;
    this.headlineHasContent = true;

    return position + 1;
  }

  // Call before body processing
  private async processTextingCallBeforeBodyChunk(
    chunk: string,
    position: number,
    char: string,
    charType: CharType,
  ): Promise<number> {
    // This mode runs after the headline. We ignore leading whitespace/newlines while deciding:
    // - whether a body exists
    // - or this call ends and the next call begins (or an explicit terminator appears)

    // Resolve a pending `!!@` marker that spanned upstream chunks.
    if (this.pendingLineStartMarker !== '' && this.pendingLineStartMarkerWasLineStart) {
      const pending = this.pendingLineStartMarker;
      this.pendingLineStartMarker = '';
      this.pendingLineStartMarkerWasLineStart = false;

      if (pending === '!') {
        if (char === '!') {
          this.pendingLineStartMarker = '!!';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 1;
        }
        await this.downstream.callBodyStart();
        this.mode = ParserMode.TEXTING_CALL_BODY;
        this.bodyChunkBuffer = `${this.beforeBodyWhitespaceBuffer}!`;
        this.beforeBodyWhitespaceBuffer = '';
        this.isAtLineStart = false;
        return position;
      }

      if (pending === '!!') {
        if (char === '@') {
          this.pendingLineStartMarker = '!!@';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 1;
        }
        await this.downstream.callBodyStart();
        this.mode = ParserMode.TEXTING_CALL_BODY;
        this.bodyChunkBuffer = `${this.beforeBodyWhitespaceBuffer}!!`;
        this.beforeBodyWhitespaceBuffer = '';
        this.isAtLineStart = false;
        return position;
      }

      if (pending === '!!@') {
        if (char === '/') {
          await this.emitCallFinish();
          this.mode = ParserMode.FREE_TEXT;
          this.isAtLineStart = false;
          this.beforeBodyWhitespaceBuffer = '';
          this.pendingInitialBackticks = 0;
          return position + 1;
        }
        if (this.isValidMentionChar(char)) {
          await this.emitCallFinish();
          this.beforeBodyWhitespaceBuffer = '';
          this.pendingInitialBackticks = 0;
          this.enterHeadlineAfterExplicitPrefix();
          return await this.processTextingCallHeadlineChunk(chunk, position, char, charType);
        }
        await this.downstream.callBodyStart();
        this.mode = ParserMode.TEXTING_CALL_BODY;
        this.bodyChunkBuffer = `${this.beforeBodyWhitespaceBuffer}!!@`;
        this.beforeBodyWhitespaceBuffer = '';
        this.isAtLineStart = false;
        return position;
      }
    }

    // Track line start while buffering whitespace. We must preserve this whitespace if a body exists,
    // but discard it if we conclude there is no body (next call / explicit terminator).
    if (char === ' ' || char === '\t') {
      this.beforeBodyWhitespaceBuffer += char;
      this.isAtLineStart = false;
      return position + 1;
    }
    if (charType === CharType.NEWLINE) {
      this.beforeBodyWhitespaceBuffer += char;
      this.isAtLineStart = true;
      return position + 1;
    }

    // `!!@...` at line start indicates the next call (no body).
    // `!!@/` at line start explicitly terminates the current call (no body).
    if (this.isAtLineStart && char === '!') {
      // If we don't have enough characters to decide, defer to the next upstream chunk.
      if (position + 1 >= chunk.length) {
        this.pendingLineStartMarker = '!';
        this.pendingLineStartMarkerWasLineStart = true;
        return position + 1;
      }
      if (chunk[position + 1] === '!') {
        if (position + 2 >= chunk.length) {
          this.pendingLineStartMarker = '!!';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 2;
        }
        if (chunk[position + 2] === '@') {
          if (position + 3 >= chunk.length) {
            this.pendingLineStartMarker = '!!@';
            this.pendingLineStartMarkerWasLineStart = true;
            return position + 3;
          }
          const nextChar = chunk[position + 3];
          if (nextChar === '/') {
            await this.emitCallFinish();
            this.mode = ParserMode.FREE_TEXT;
            this.isAtLineStart = false;
            this.beforeBodyWhitespaceBuffer = '';
            this.pendingInitialBackticks = 0;
            return position + 4;
          }
          if (this.isValidMentionChar(nextChar)) {
            await this.emitCallFinish();
            this.beforeBodyWhitespaceBuffer = '';
            this.pendingInitialBackticks = 0;
            this.enterHeadlineAfterExplicitPrefix();
            return await this.processTextingCallHeadlineChunk(
              chunk,
              position + 3,
              nextChar,
              this.getCharType(nextChar),
            );
          }
        }
      }
      // Not a valid marker: treat as body content.
    }

    // Look for a backtick-fenced body start. We must wait until the run ends to support 4+ backticks.
    if (charType === CharType.BACKTICK) {
      this.pendingInitialBackticks++;
      this.isAtLineStart = false;
      return position + 1;
    }

    if (this.pendingInitialBackticks > 0) {
      const openingFenceLength = this.pendingInitialBackticks;
      const openingFence = '`'.repeat(openingFenceLength);
      this.pendingInitialBackticks = 0;

      if (openingFenceLength >= 3) {
        this.hasBody = true;
        this.isTripleQuotedBody = true;
        this.tripleQuotedBodyOpen = true;
        this.tripleQuotedBodyFenceLength = openingFenceLength;
        this.tripleQuotedBodyClosingCandidateActive = false;
        this.tripleQuotedBodyClosingCandidateBackticks = 0;
        await this.downstream.callBodyStart(openingFence);
        this.bodyChunkBuffer = `${this.beforeBodyWhitespaceBuffer}${openingFence}`;
        this.beforeBodyWhitespaceBuffer = '';
        this.mode = ParserMode.TEXTING_CALL_BODY;
        return position;
      }

      // Not a fenced body: treat the leading backticks as literal body content.
      await this.downstream.callBodyStart();
      this.mode = ParserMode.TEXTING_CALL_BODY;
      this.bodyChunkBuffer = `${this.beforeBodyWhitespaceBuffer}${openingFence}`;
      this.beforeBodyWhitespaceBuffer = '';
      this.isAtLineStart = false;
      return position;
    }

    // Any other non-whitespace character starts a regular body.
    await this.downstream.callBodyStart();
    this.mode = ParserMode.TEXTING_CALL_BODY;
    this.bodyChunkBuffer =
      this.beforeBodyWhitespaceBuffer +
      (this.pendingInitialBackticks > 0 ? '`'.repeat(this.pendingInitialBackticks) : '');
    this.beforeBodyWhitespaceBuffer = '';
    this.pendingInitialBackticks = 0;
    this.isAtLineStart = false;
    return position;
  }

  // Call body processing
  private async processTextingCallBodyChunk(
    chunk: string,
    position: number,
    char: string,
    charType: CharType,
  ): Promise<number> {
    const canStartNewCallFromBody =
      !this.tripleQuotedBodyOpen && this.backtickState === BacktickState.NONE;

    // Resolve pending `!!@` marker spanning upstream chunks.
    if (
      canStartNewCallFromBody &&
      this.pendingLineStartMarker !== '' &&
      this.pendingLineStartMarkerWasLineStart
    ) {
      const pending = this.pendingLineStartMarker;
      this.pendingLineStartMarker = '';
      this.pendingLineStartMarkerWasLineStart = false;

      if (pending === '!') {
        if (char === '!') {
          this.pendingLineStartMarker = '!!';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 1;
        }
        this.bodyChunkBuffer += '!';
        this.isAtLineStart = false;
      } else if (pending === '!!') {
        if (char === '@') {
          this.pendingLineStartMarker = '!!@';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 1;
        }
        this.bodyChunkBuffer += '!!';
        this.isAtLineStart = false;
      } else if (pending === '!!@') {
        if (char === '/') {
          await this.endCurrentCallFromBodyToFreeText();
          this.isAtLineStart = false;
          return position + 1;
        }
        if (this.isValidMentionChar(char)) {
          await this.endCurrentCallFromBodyToNewCall();
          return await this.processTextingCallHeadlineChunk(chunk, position, char, charType);
        }
        // Not a valid mention start: treat the pending marker literally inside the body.
        this.bodyChunkBuffer += TEXTING_CALL_PREFIX;
        this.isAtLineStart = false;
      }
    }

    // Detect `!!@...` at line boundaries to start the next call (implicit terminator),
    // and `!!@/` to explicitly end the current call.
    if (canStartNewCallFromBody && this.isAtLineStart && char === '!') {
      // Defer if the marker spans the upstream chunk boundary.
      if (position + 1 >= chunk.length) {
        this.pendingLineStartMarker = '!';
        this.pendingLineStartMarkerWasLineStart = true;
        return position + 1;
      }
      if (chunk[position + 1] === '!') {
        if (position + 2 >= chunk.length) {
          this.pendingLineStartMarker = '!!';
          this.pendingLineStartMarkerWasLineStart = true;
          return position + 2;
        }
        if (chunk[position + 2] === '@') {
          if (position + 3 >= chunk.length) {
            this.pendingLineStartMarker = '!!@';
            this.pendingLineStartMarkerWasLineStart = true;
            return position + 3;
          }

          const afterAt = chunk[position + 3];
          if (afterAt === '/') {
            await this.endCurrentCallFromBodyToFreeText();
            this.isAtLineStart = false;
            return position + 4;
          }

          if (this.isValidMentionChar(afterAt)) {
            await this.endCurrentCallFromBodyToNewCall();
            return await this.processTextingCallHeadlineChunk(
              chunk,
              position + 3,
              afterAt,
              this.getCharType(afterAt),
            );
          }
        }
      }
    }

    // In call bodies, ALL content including triple backticks should be treated as literal
    // Don't allow code block transitions within call bodies

    // For backtick-fenced bodies, close only when a line contains ONLY a backtick fence (no other chars).
    // The newline after the closing fence is not part of the body and must be re-processed as FREE_TEXT.
    if (
      this.isTripleQuotedBody &&
      charType === CharType.NEWLINE &&
      this.tripleQuotedBodyClosingCandidateActive &&
      this.tripleQuotedBodyClosingCandidateBackticks >= this.tripleQuotedBodyFenceLength
    ) {
      await this.flushBodyBuffer();
      await this.downstream.callBodyFinish(
        '`'.repeat(this.tripleQuotedBodyClosingCandidateBackticks),
      );
      await this.emitCallFinish();

      // Switch to free text for remaining content
      this.mode = ParserMode.FREE_TEXT;
      const hasMarkdownContent = this.markdownChunkBuffer.length > 0;
      this.markdownChunkBuffer = '';

      if (hasMarkdownContent) {
        this.markdownStarted = true;
        await this.downstream.markdownStart();
      } else {
        this.markdownStarted = false;
      }

      // Reset backtick state and flags
      this.backtickCount = 0;
      this.backtickState = BacktickState.NONE;
      this.tripleQuotedBodyOpen = false;
      this.tripleQuotedBodyClosingCandidateActive = false;
      this.tripleQuotedBodyClosingCandidateBackticks = 0;

      return position;
    }

    // Add character to body buffer
    this.bodyChunkBuffer += char;

    // Track a potential closing fence line (strict column 0 within the body).
    if (this.isTripleQuotedBody) {
      if (this.isAtLineStart && charType === CharType.BACKTICK) {
        this.tripleQuotedBodyClosingCandidateActive = true;
        this.tripleQuotedBodyClosingCandidateBackticks = 1;
      } else if (this.tripleQuotedBodyClosingCandidateActive && charType === CharType.BACKTICK) {
        this.tripleQuotedBodyClosingCandidateBackticks++;
      } else if (charType === CharType.NEWLINE) {
        this.tripleQuotedBodyClosingCandidateActive = false;
        this.tripleQuotedBodyClosingCandidateBackticks = 0;
      } else if (this.tripleQuotedBodyClosingCandidateActive) {
        // Any non-backtick character cancels a closing-fence candidate for this line.
        this.tripleQuotedBodyClosingCandidateActive = false;
        this.tripleQuotedBodyClosingCandidateBackticks = 0;
      }
    }

    // For wholly triple quoted bodies, ensure we flush the content regularly to capture all content
    // including the outer triple backticks that were added when the body was started

    // Update backtick state but don't use it for transitions in call bodies
    this.updateBacktickState(charType);

    // Strict column-0 semantics: `!!@...` and `!!@/` are recognized only at column 0.
    this.isAtLineStart = charType === CharType.NEWLINE;
    return position + 1;
  }

  // Code block info processing
  private async processCodeBlockInfoChar(
    chunk: string,
    position: number,
    char: string,
    charType: CharType,
  ): Promise<number> {
    if (charType === CharType.NEWLINE) {
      // Info line complete, start content
      await this.downstream.codeBlockStart(this.codeBlockInfoAccumulator);
      this.mode = ParserMode.CODE_BLOCK_CONTENT;
      this.codeBlockInfoAccumulator = '';
      // The newline becomes part of content buffer
      this.codeBlockChunkBuffer = char;
      this.isAtLineStart = true;
      this.pendingCodeBlockLineStartBackticks = '';
      this.pendingCodeBlockLineStartWhitespace = '';
      this.backtickCount = 0;
      this.backtickState = BacktickState.NONE;
      this.backtickRunStartedAtLineStart = false;

      return position + 1;
    }

    // Accumulate info line
    this.codeBlockInfoAccumulator += char;
    return position + 1;
  }

  // Code block content processing
  private async processCodeBlockContentChunk(
    chunk: string,
    position: number,
    char: string,
    charType: CharType,
  ): Promise<number> {
    // Closing fences are recognized ONLY at strict column 0 (line start, no leading whitespace).
    // The closing fence must be a run of backticks with length >= the opening fence length.
    // Trailing whitespace after the fence is allowed, but the fence line must otherwise be empty.

    const isWhitespace = char === ' ' || char === '\t';

    // If we're currently buffering a potential closing fence at line start, continue to buffer until
    // we can decide (newline, or a non-whitespace character that makes it not a fence).
    if (this.pendingCodeBlockLineStartBackticks.length > 0) {
      if (charType === CharType.BACKTICK && this.pendingCodeBlockLineStartWhitespace.length === 0) {
        this.pendingCodeBlockLineStartBackticks += '`';
        this.isAtLineStart = false;
        return position + 1;
      }

      if (isWhitespace) {
        if (this.pendingCodeBlockLineStartBackticks.length >= this.currentCodeBlockFenceLength) {
          this.pendingCodeBlockLineStartWhitespace += char;
          this.isAtLineStart = false;
          return position + 1;
        }
        // Too short to be a closing fence: flush the buffered backticks as literal content.
        this.codeBlockChunkBuffer += this.pendingCodeBlockLineStartBackticks;
        this.pendingCodeBlockLineStartBackticks = '';
        this.pendingCodeBlockLineStartWhitespace = '';
        // Fall through: treat this whitespace as regular content.
      } else if (charType === CharType.NEWLINE) {
        if (this.pendingCodeBlockLineStartBackticks.length >= this.currentCodeBlockFenceLength) {
          if (this.codeBlockChunkBuffer) {
            await this.downstream.codeBlockChunk(this.codeBlockChunkBuffer);
            this.codeBlockChunkBuffer = '';
          }
          await this.downstream.codeBlockFinish('');
          this.mode = ParserMode.FREE_TEXT;
          this.markdownChunkBuffer = '';
          this.pendingCodeBlockLineStartBackticks = '';
          this.pendingCodeBlockLineStartWhitespace = '';
          this.isAtLineStart = true;
          return position;
        }

        // Not a closing fence: emit the buffered content as literal.
        this.codeBlockChunkBuffer +=
          this.pendingCodeBlockLineStartBackticks + this.pendingCodeBlockLineStartWhitespace + '\n';
        this.pendingCodeBlockLineStartBackticks = '';
        this.pendingCodeBlockLineStartWhitespace = '';
        this.isAtLineStart = true;
        return position + 1;
      } else {
        // Some other character makes it not a closing fence: flush buffered content and continue.
        this.codeBlockChunkBuffer +=
          this.pendingCodeBlockLineStartBackticks + this.pendingCodeBlockLineStartWhitespace;
        this.pendingCodeBlockLineStartBackticks = '';
        this.pendingCodeBlockLineStartWhitespace = '';
        // Fall through to handle current char normally.
      }
    }

    // Start buffering a potential closing fence only at strict column 0.
    if (this.isAtLineStart && charType === CharType.BACKTICK) {
      this.pendingCodeBlockLineStartBackticks = '`';
      this.pendingCodeBlockLineStartWhitespace = '';
      this.isAtLineStart = false;
      return position + 1;
    }

    this.codeBlockChunkBuffer += char;
    this.isAtLineStart = charType === CharType.NEWLINE;
    return position + 1;
  }

  // Backtick state management
  private updateBacktickState(charType: CharType): void {
    if (charType === CharType.BACKTICK) {
      if (this.backtickCount === 0) {
        this.backtickRunStartedAtLineStart = this.isAtLineStart;
      }
      this.backtickCount++;
      if (this.backtickCount === 1) {
        this.backtickState = BacktickState.SINGLE;
      } else if (this.backtickCount === 2) {
        this.backtickState = BacktickState.DOUBLE;
      } else if (this.backtickCount === 3) {
        this.backtickState = BacktickState.TRIPLE_START;
      } else {
        this.backtickState = BacktickState.TRIPLE_CONTENT;
      }
    } else {
      // If we saw exactly one backtick before this non-backtick character,
      // toggle the inSingleBacktick state. This handles inline code like `@mention`.
      if (this.backtickCount === 1) {
        this.inSingleBacktick = !this.inSingleBacktick;
      }
      this.backtickCount = 0;
      this.backtickState = BacktickState.NONE;
      this.backtickRunStartedAtLineStart = false;
    }
  }

  // Buffer flushing methods
  private async flushHeadlineBuffer(): Promise<void> {
    if (this.headlineBuffer) {
      if (!this.callStartEmitted) {
        // Don't emit chunks before start event - buffer them
        return;
      }
      const call = this.ensureCurrentCall();
      call.headLine += this.headlineBuffer;
      await this.downstream.callHeadLineChunk(this.headlineBuffer);
      this.headlineBuffer = '';
    }
  }

  private async flushBodyBuffer(): Promise<void> {
    if (this.bodyChunkBuffer) {
      const call = this.ensureCurrentCall();
      call.body += this.bodyChunkBuffer;
      await this.downstream.callBodyChunk(this.bodyChunkBuffer);
      this.bodyChunkBuffer = '';
    }
  }

  private async flushCodeBlockBuffer(): Promise<void> {
    if (this.codeBlockChunkBuffer) {
      await this.downstream.codeBlockChunk(this.codeBlockChunkBuffer);
      this.codeBlockChunkBuffer = '';
    }
  }

  private async flushAtUpstreamChunkEnd(): Promise<void> {
    switch (this.mode) {
      case ParserMode.FREE_TEXT:
        if (this.markdownChunkBuffer) {
          // If the upstream chunk ends with 1–2 backticks, defer emitting those backticks until
          // the next chunk so we can disambiguate inline-code vs triple-backtick fences.
          //
          // This is one of the few correctness-driven cases where we intentionally do NOT emit
          // exactly at upstream chunk boundaries.
          if (this.backtickCount > 0) {
            const suffix = '`'.repeat(this.backtickCount);
            if (this.markdownChunkBuffer.endsWith(suffix)) {
              const prefix = this.markdownChunkBuffer.slice(0, -suffix.length);
              if (prefix.length > 0) {
                if (!this.markdownStarted) {
                  await this.downstream.markdownStart();
                  this.markdownStarted = true;
                }
                await this.downstream.markdownChunk(prefix);
              }
              this.markdownChunkBuffer = suffix;
              break;
            }
          }
          if (!this.markdownStarted) {
            await this.downstream.markdownStart();
            this.markdownStarted = true;
          }
          await this.downstream.markdownChunk(this.markdownChunkBuffer);
          this.markdownChunkBuffer = '';
        }
        break;
      case ParserMode.TEXTING_CALL_HEADLINE:
        await this.flushHeadlineBuffer();
        break;
      case ParserMode.TEXTING_CALL_BEFORE_BODY:
        break;
      case ParserMode.TEXTING_CALL_BODY:
        await this.flushBodyBuffer();
        break;
      case ParserMode.CODE_BLOCK_INFO:
        break;
      case ParserMode.CODE_BLOCK_CONTENT:
        if (this.codeBlockChunkBuffer) {
          // If the upstream chunk ends with 1–2 backticks, defer emitting those backticks until
          // the next chunk so we can disambiguate literal backticks vs a closing fence at line start.
          //
          // This mirrors the FREE_TEXT behavior and is required for chunk-size invariance.
          if (this.backtickCount > 0) {
            const suffix = '`'.repeat(this.backtickCount);
            if (this.codeBlockChunkBuffer.endsWith(suffix)) {
              const prefix = this.codeBlockChunkBuffer.slice(0, -suffix.length);
              if (prefix.length > 0) {
                await this.downstream.codeBlockChunk(prefix);
              }
              this.codeBlockChunkBuffer = suffix;
              break;
            }
          }
          await this.downstream.codeBlockChunk(this.codeBlockChunkBuffer);
          this.codeBlockChunkBuffer = '';
        }
        break;
    }
  }
}

/**
 * Helper function to extract mentions from a text string.
 * Returns an array of mention strings (without the @ symbol).
 *
 * **Mention Syntax**:
 * - `@` followed by valid name characters:
 *   - Alphanumeric characters (a-z, A-Z, 0-9)
 *   - Unicode letters and digits
 *   - Underscore (`_`) and hyphen (`-`)
 *   - Dot (`.`) for namespace separation
 * - Mention ends when invalid character encountered: space, newline, tab, colon (`:`), etc.
 * - Mention IDs may include dots for namespaces; a trailing dot is treated as punctuation and ignored.
 *
 * Respects backtick quoting - mentions inside backtick-quoted content are ignored.
 */
export function extractMentions(text: string): string[] {
  const mentions: string[] = [];
  let backtickState = BacktickState.NONE;
  let backtickCount = 0;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    // Update backtick state following the same logic as the streaming parser
    if (char === '`') {
      switch (backtickState) {
        case BacktickState.NONE:
          backtickCount = 1;
          backtickState = BacktickState.SINGLE;
          break;
        case BacktickState.SINGLE:
          backtickCount++;
          if (backtickCount === 3) {
            backtickState = BacktickState.TRIPLE_START;
          } else {
            // For single backticks, encountering another backtick ends the quoted section
            backtickState = BacktickState.NONE;
            backtickCount = 0;
          }
          break;
        case BacktickState.TRIPLE_CONTENT:
          backtickCount = 1;
          backtickState = BacktickState.SINGLE;
          break;
      }
    } else {
      if (backtickState === BacktickState.SINGLE && backtickCount < 3) {
        // Single backtick mode - stay in single mode until we hit another backtick
        // Don't change state on non-backtick characters
      } else if (backtickState === BacktickState.TRIPLE_START) {
        backtickState = BacktickState.TRIPLE_CONTENT;
      }
    }

    // Only process @ symbols when not in quoted content
    if (char === '@' && backtickState === BacktickState.NONE) {
      // Look ahead to extract the mention
      let j = i + 1;
      let mention = '';

      // Extract valid mention characters following the @
      // Valid: alphanumeric, Unicode letters/digits, underscore, hyphen, dot
      while (j < text.length) {
        const nextChar = text[j];
        const charCode = nextChar.charCodeAt(0);

        // Check if character is valid in mention name
        const isValid =
          // ASCII alphanumeric: a-z, A-Z, 0-9
          (charCode >= 48 && charCode <= 57) || // 0-9
          (charCode >= 65 && charCode <= 90) || // A-Z
          (charCode >= 97 && charCode <= 122) || // a-z
          // Special allowed characters
          nextChar === '_' ||
          nextChar === '-' ||
          nextChar === '.' ||
          // Unicode letters and digits (simplified check - will match most common Unicode)
          /\p{L}/u.test(nextChar) || // Unicode letter
          /\p{N}/u.test(nextChar); // Unicode number

        if (!isValid) {
          // Invalid character - end of mention
          break;
        }

        mention += nextChar;
        j++;
      }

      if (mention.length > 0) {
        let trimmed = mention;
        while (trimmed.endsWith('.')) {
          trimmed = trimmed.slice(0, -1);
        }
        if (trimmed.length > 0) {
          mentions.push(trimmed);
        }
      }

      // Skip to the end of the mention
      i = j - 1;
    }

    i++;
  }

  return mentions;
}
