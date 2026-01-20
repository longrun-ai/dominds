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
 *    - Syntax: `@mention command arguments` at the start of a line (leading spaces allowed)
 *    - **Mention Syntax**: `@` followed by mention name
 *      - **Valid characters**: Alphanumeric (a-z, A-Z, 0-9), Unicode letters/digits, underscore (`_`), hyphen (`-`), dot (`.`) for namespace separation
 *      - **Trailing dot**: a trailing `.` is treated as punctuation and ignored for mention parsing
 *      - **Invalid characters** (mention ends when encountered): space, newline, tab, colon (`:`), and any other non-valid character
 *      - Examples: `@tool1`, `@user1`, `@namespace.tool1`, `@user_name`, `@user-name`
 *    - First mention determines the target
 *    - May have an optional body after the headline
 *    - Terminated by `@/` or start of next call at line boundary
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
 *   - Only `@/` at line start can terminate the call
 *
 * - **Triple-Quoted Body**: Body that starts with triple backticks
 *   - Opening triple backticks are preserved verbatim in `callBodyStart(infoLine)`
 *   - Content including nested triple backticks is preserved literally
 *   - Call terminates at closing triple backticks followed by newline/end
 *
 * ### Call Termination Rules
 * - **@/ termination**: Explicit termination marker, works in streaming scenarios
 * - **Line-boundary @**: New call starting at line start (only in non-triple-quoted bodies)
 * - **End-of-input**: Automatic termination in `finalize()`
 *
 * ## Streaming Behavior
 *
 * The parser is designed for real-time streaming:
 * - Processes input character by character in chunks
 * - Emits downstream chunks aligned to upstream chunk boundaries when possible
 * - Handles chunk boundaries intelligently (no content loss)
 * - Supports pending state for markers that span chunks (`@/` termination)
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
 * - **FREE_TEXT**: Processing regular text, looks for `@` or triple backticks
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

  // Free text state
  private markdownChunkBuffer = '';

  // Call state
  private hasBody = false;
  private isTripleQuotedBody = false;
  private tripleQuotedBodyOpen = false;
  private tripleQuotedBodyClose = false;

  // Headline processing state
  private headlineBuffer = '';
  private firstMentionAccumulator = '';
  private headlineFinished = false;
  private expectingFirstMention = true; // Track if we're expecting a new first mention
  private headlineHasContent = false;
  private callStartEmitted = false;
  private pendingHeadlineNewline = false;
  private pendingHeadlineNewlineWhitespace = '';
  private pendingHeadlineNewlineSawAt = false;

  // Body processing state
  private bodyChunkBuffer = '';
  private isAtLineStart = true;
  private pendingAtTermination = false; // Track potential @/ termination spanning chunks
  private pendingAtWasLineStart = false; // Track whether deferred @ was at line start
  private pendingInitialBackticks = 0; // Backticks seen before deciding body type

  // Code block state
  private codeBlockChunkBuffer = '';
  private codeBlockInfoAccumulator = '';

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
    this.bodyChunkBuffer = '';
    this.pendingAtTermination = false;
    this.pendingAtWasLineStart = false;
    this.headlineHasContent = false;
    this.pendingHeadlineNewline = false;
    this.pendingHeadlineNewlineWhitespace = '';
    this.pendingHeadlineNewlineSawAt = false;
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
    if (this.markdownChunkBuffer) {
      if (!this.markdownStarted) {
        await this.downstream.markdownStart();
        this.markdownStarted = true;
      }
      await this.downstream.markdownChunk(this.markdownChunkBuffer);
      this.markdownChunkBuffer = '';
    }

    if (this.codeBlockChunkBuffer) {
      await this.flushCodeBlockBuffer();
    }

    if (this.mode === ParserMode.CODE_BLOCK_CONTENT) {
      await this.downstream.codeBlockFinish('');
      this.mode = ParserMode.FREE_TEXT;
    }

    if (this.mode === ParserMode.TEXTING_CALL_HEADLINE) {
      if (this.headlineBuffer.trim() === '@/') {
        this.headlineBuffer = '';
        this.mode = ParserMode.FREE_TEXT;
      }
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
      if (this.currentCall) {
        await this.emitCallFinish();
      }
    } else if (this.mode === ParserMode.TEXTING_CALL_BODY) {
      await this.flushBodyBuffer();
      await this.downstream.callBodyFinish(this.isTripleQuotedBody ? '```' : undefined);

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
    // Check for @ mentions anywhere in free text
    if (charType === CharType.AT) {
      // Update backtick state for @ character - this handles toggling inSingleBacktick
      // if we just saw a single backtick before this @.
      this.updateBacktickState(charType);

      if (!this.inSingleBacktick) {
        const canStartMention = this.isAtLineStart;
        if (!canStartMention) {
          this.markdownChunkBuffer += char;
          this.isAtLineStart = false;
          return position + 1;
        }
        if (position + 1 < chunk.length && chunk[position + 1] === '/') {
          this.markdownChunkBuffer += '@/';
          return position + 2;
        }
        if (this.markdownChunkBuffer) {
          if (this.isAtLineStart) {
            if (!this.markdownStarted) {
              await this.downstream.markdownStart();
              this.markdownStarted = true;
            }
            await this.downstream.markdownChunk(this.markdownChunkBuffer);
            this.markdownChunkBuffer = '';
            await this.downstream.markdownFinish();
            this.markdownStarted = false;
          }
        }

        // Start a new call - switch to HEADLINE mode
        // Return current position so the main loop reprocesses this @ in HEADLINE mode
        this.mode = ParserMode.TEXTING_CALL_HEADLINE;
        this.headlineBuffer = '';
        this.headlineFinished = false;
        this.headlineHasContent = false;

        // Return current position to reprocess this @ in the new HEADLINE mode
        // The main loop will detect the mode change and continue from this position
        return position;
      } else {
        // Inside single backticks, treat @ as regular markdown content
        this.markdownChunkBuffer += char;
        this.isAtLineStart = false;
        return position + 1;
      }
    }

    // Check for triple backticks to transition to code block
    if (charType === CharType.BACKTICK) {
      // Update backtick state and check for triple backticks
      this.updateBacktickState(charType);

      // Add backtick to buffer
      this.markdownChunkBuffer += char;

      if (this.backtickState === BacktickState.TRIPLE_START && this.backtickCount >= 3) {
        // Remove the triple backticks from markdown buffer before emitting
        const cleanBuffer = this.markdownChunkBuffer.replace(/`{3,}$/, '');
        if (cleanBuffer.length > 0) {
          if (!this.markdownStarted) {
            await this.downstream.markdownStart();
            this.markdownStarted = true;
          }
          await this.downstream.markdownChunk(cleanBuffer);
        }
        // Always close an open markdown segment before starting a code block, even if the
        // fence completion occurs at an upstream chunk boundary and the cleaned buffer is empty.
        if (this.markdownStarted) {
          await this.downstream.markdownFinish();
          this.markdownStarted = false;
        }
        this.markdownChunkBuffer = '';

        // Transition to code block mode
        this.mode = ParserMode.CODE_BLOCK_INFO;
        this.codeBlockInfoAccumulator = '';
        this.backtickState = BacktickState.NONE;
        this.backtickCount = 0;
        this.inSingleBacktick = false; // Reset backtick state when entering code block

        return position + 1;
      }

      this.isAtLineStart = false;
      return position + 1;
    } else {
      // Regular markdown processing for non-backtick characters
      this.markdownChunkBuffer += char;

      // Update backtick state for non-backtick characters
      this.updateBacktickState(charType);
    }

    this.isAtLineStart =
      charType === CharType.NEWLINE || (this.isAtLineStart && charType === CharType.SPACE);
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
      if (this.pendingHeadlineNewlineSawAt) {
        if (char === '/') {
          if (this.hasValidFirstMention()) {
            const firstMention = this.firstMentionAccumulator.substring(1);
            await this.emitCallStart(firstMention);
            this.firstMentionAccumulator = '';
            this.expectingFirstMention = false;
          }

          await this.flushHeadlineBuffer();
          await this.downstream.callHeadLineFinish();
          this.headlineFinished = true;
          this.hasBody = false;
          await this.emitCallFinish();

          this.pendingHeadlineNewline = false;
          this.pendingHeadlineNewlineWhitespace = '';
          this.pendingHeadlineNewlineSawAt = false;
          this.mode = ParserMode.FREE_TEXT;
          return position + 1; // Skip past /
        }

        // Not a terminator: treat as headline continuation with the deferred '@'.
        this.headlineBuffer += `\n${this.pendingHeadlineNewlineWhitespace}@`;
        this.pendingHeadlineNewline = false;
        this.pendingHeadlineNewlineWhitespace = '';
        this.pendingHeadlineNewlineSawAt = false;
        return position;
      }

      if (char === ' ' || char === '\t') {
        this.pendingHeadlineNewlineWhitespace += char;
        return position + 1;
      }

      if (charType === CharType.AT) {
        // Special case: a standalone call terminator line (`@/`) must not be treated as
        // a headline continuation.
        if (position + 1 >= chunk.length) {
          // Defer decision to the next upstream chunk.
          this.pendingHeadlineNewlineSawAt = true;
          return position + 1;
        }
        if (position + 1 < chunk.length && chunk[position + 1] === '/') {
          if (this.hasValidFirstMention()) {
            const firstMention = this.firstMentionAccumulator.substring(1);
            await this.emitCallStart(firstMention);
            this.firstMentionAccumulator = '';
            this.expectingFirstMention = false;
          }

          await this.flushHeadlineBuffer();
          await this.downstream.callHeadLineFinish();
          this.headlineFinished = true;
          this.hasBody = false;
          await this.emitCallFinish();

          this.pendingHeadlineNewline = false;
          this.pendingHeadlineNewlineWhitespace = '';
          this.pendingHeadlineNewlineSawAt = false;
          this.mode = ParserMode.FREE_TEXT;
          return position + 2; // Skip past @/
        }

        // Multi-line headline continuation: include the deferred newline + any indentation.
        this.headlineBuffer += `\n${this.pendingHeadlineNewlineWhitespace}`;
        this.pendingHeadlineNewline = false;
        this.pendingHeadlineNewlineWhitespace = '';
        this.pendingHeadlineNewlineSawAt = false;
        return position;
      }

      // Anything else starts the body (newline is the separator, not headline content).
      this.pendingHeadlineNewline = false;
      this.pendingHeadlineNewlineWhitespace = '';
      this.pendingHeadlineNewlineSawAt = false;

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

      // Look ahead to see if the next non-empty line starts with @ (another mention) or triple backticks
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
            await this.downstream.callBodyStart('```');
            this.bodyChunkBuffer = '```';
            this.mode = ParserMode.TEXTING_CALL_BODY;
            return checkPos;
          }
        }
      }

      // Look ahead to determine if this is continuation of headline or start of body
      let foundNonWhitespace = false;
      let sawExtraNewline = false;
      while (aheadPos < chunk.length) {
        const nextChar = chunk[aheadPos];
        if (nextChar === '@') {
          if (sawExtraNewline) {
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
            await this.emitCallFinish();
            this.mode = ParserMode.TEXTING_CALL_HEADLINE;
            this.firstMentionAccumulator = '';
            this.headlineBuffer = '';
            this.headlineFinished = false;
            this.expectingFirstMention = true;
            this.headlineHasContent = false;
            return aheadPos;
          } else {
            // Special case: a standalone call terminator line (`@/`) must not be treated as
            // a headline continuation. Without this, `@/` can be swallowed into the headline
            // and the call never terminates, producing malformed event sequences downstream.
            if (aheadPos + 1 < chunk.length && chunk[aheadPos + 1] === '/') {
              // End headline, then terminate the call (no body).
              if (this.hasValidFirstMention()) {
                const firstMention = this.firstMentionAccumulator.substring(1);
                await this.emitCallStart(firstMention);
                this.firstMentionAccumulator = '';
                this.expectingFirstMention = false;
              }

              await this.flushHeadlineBuffer();
              await this.downstream.callHeadLineFinish();
              this.headlineFinished = true;
              this.hasBody = false;
              await this.emitCallFinish();

              this.mode = ParserMode.FREE_TEXT;
              return aheadPos + 2; // Skip past @/
            }

            this.expectingFirstMention = false;
            this.headlineBuffer += char;
            this.isAtLineStart = true;
            return position + 1;
          }
        } else if (nextChar === ' ' || nextChar === '\t' || nextChar === '\n') {
          aheadPos++;
          if (nextChar === '\n') sawExtraNewline = true;
        } else {
          // Found actual content that isn't @ - this indicates end of headline, start of body
          foundNonWhitespace = true;
          break;
        }
      }

      if (foundNonWhitespace || aheadPos >= chunk.length) {
        if (foundNonWhitespace) {
          // End of headline, start of body
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
          this.mode = ParserMode.TEXTING_CALL_BEFORE_BODY;
          return position + 1;
        }

        // End of chunk: defer decision to next upstream chunk so headline continuation vs body
        // is independent of chunk sizes.
        this.pendingHeadlineNewline = true;
        this.pendingHeadlineNewlineWhitespace = '';
        return position + 1;
      } else {
        // End of chunk, finalize headline to allow body detection in the next chunk
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
        return position + 1;
      }
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
    // Handle pending @ at end-of-chunk (could be @/ terminator or start of a new call).
    if (this.pendingAtTermination) {
      this.pendingAtTermination = false;
      if (char === '/') {
        // Treat as @/ terminator for the current call.
        this.mode = ParserMode.FREE_TEXT;
        return position + 1;
      }

      // Treat as start of a new call. Seed headline parsing with the deferred '@' and
      // continue parsing from the current character.
      await this.emitCallFinish();
      this.mode = ParserMode.TEXTING_CALL_HEADLINE;
      this.firstMentionAccumulator = '@';
      this.headlineBuffer = '@';
      this.headlineFinished = false;
      this.expectingFirstMention = true;
      this.headlineHasContent = false;
      this.hasBody = false;
      this.isTripleQuotedBody = false;
      this.tripleQuotedBodyOpen = false;
      this.bodyChunkBuffer = '';
      this.pendingInitialBackticks = 0;
      return await this.processTextingCallHeadlineChunk(chunk, position, char, charType);
    }

    // Handle @/ termination marker
    // (the / character itself is handled above via the pendingAtTermination block)
    if (charType === CharType.SPACE) {
      let aheadPos = position;
      while (aheadPos < chunk.length) {
        const nextChar = chunk[aheadPos];
        const nextType = this.getCharType(nextChar);
        if (nextType === CharType.BACKTICK) {
          let count = 0;
          let checkPos = aheadPos;
          while (checkPos < chunk.length && chunk[checkPos] === '`') {
            count++;
            checkPos++;
          }
          if (count >= 3) {
            this.hasBody = true;
            this.isTripleQuotedBody = true;
            this.tripleQuotedBodyOpen = true;
            await this.downstream.callBodyStart('```');
            this.bodyChunkBuffer = '```';
            this.mode = ParserMode.TEXTING_CALL_BODY;
            return aheadPos + 3;
          }
        }
        if (nextType === CharType.AT) {
          await this.emitCallFinish();
          this.mode = ParserMode.TEXTING_CALL_HEADLINE;
          this.firstMentionAccumulator = '';
          this.headlineBuffer = '';
          this.headlineFinished = false;
          this.expectingFirstMention = true;
          return aheadPos;
        }
        if (nextType === CharType.SPACE || nextType === CharType.NEWLINE) {
          aheadPos++;
          continue;
        }
        this.hasBody = true;
        await this.downstream.callBodyStart();
        this.mode = ParserMode.TEXTING_CALL_BODY;
        this.bodyChunkBuffer = '';
        return position + 1;
      }
      return position + 1;
    }
    // Look for quote start
    if (charType === CharType.BACKTICK) {
      // Update backtick state first to ensure we have the correct state
      this.updateBacktickState(charType);

      // Check for triple backticks
      if (this.backtickState === BacktickState.TRIPLE_START && this.backtickCount === 3) {
        // Triple quoted body - include verbatim infoLine and triple quotes
        this.hasBody = true;
        this.isTripleQuotedBody = true;
        this.tripleQuotedBodyOpen = true;
        await this.downstream.callBodyStart('```');
        // Include the opening triple backticks in the body content
        this.bodyChunkBuffer = '```';
        this.pendingInitialBackticks = 0;
        this.mode = ParserMode.TEXTING_CALL_BODY;
        // Reset backtick state
        this.backtickCount = 0;
        this.backtickState = BacktickState.NONE;
        return position + 1;
      }
      // Buffer initial backticks and wait for decision in subsequent characters
      this.pendingInitialBackticks++;
      return position + 1;
    }

    // Look for newline - this might indicate start of body, but we need to check ahead
    if (charType === CharType.NEWLINE) {
      // Look ahead to see if the next non-empty content is @ (indicating new call) or something else (indicating body)
      let aheadPos = position + 1;
      while (aheadPos < chunk.length) {
        const nextChar = chunk[aheadPos];
        const nextCharType = this.getCharType(nextChar);

        if (nextCharType === CharType.BACKTICK) {
          // Check if we have triple backticks starting at this position
          let backtickCount = 0;
          let checkPos = aheadPos;
          while (checkPos < chunk.length && chunk[checkPos] === '`') {
            backtickCount++;
            checkPos++;
          }

          if (backtickCount >= 3) {
            // Found triple backticks - this is a triple quoted body

            this.hasBody = true;
            this.isTripleQuotedBody = true;
            this.tripleQuotedBodyOpen = true;
            await this.downstream.callBodyStart('```');
            this.bodyChunkBuffer = '```';
            this.mode = ParserMode.TEXTING_CALL_BODY;
            return aheadPos + 3;
          }
        }

        if (nextCharType === CharType.AT) {
          // Check if this @ is at the very beginning of the line (line start)
          // If so, it might indicate a new call, otherwise it's part of body content
          let atLineStart = true;
          let checkPos = aheadPos - 1;
          while (checkPos > position) {
            if (chunk[checkPos] !== '\n' && chunk[checkPos] !== ' ' && chunk[checkPos] !== '\t') {
              atLineStart = false;
              break;
            }
            checkPos--;
          }

          if (atLineStart) {
            // Check if this is @/ (call terminator) - should NOT start a new call
            if (aheadPos + 1 < chunk.length && chunk[aheadPos + 1] === '/') {
              // @/ at line start terminates the call, no body content
              this.hasBody = false;
              // Emit headline finish before call finish
              if (this.headlineBuffer) {
                await this.downstream.callHeadLineFinish();
              }
              this.headlineFinished = true;
              await this.emitCallFinish();

              // Switch to free text mode - @/ terminates the call, doesn't start a new one
              this.mode = ParserMode.FREE_TEXT;
              return aheadPos + 2; // Skip past @/
            }

            // Next content is @ at line start (not @/) - this indicates no body, just finish the call
            this.hasBody = false;
            // Emit headline finish before call finish
            if (this.headlineBuffer) {
              await this.downstream.callHeadLineFinish();
            }
            this.headlineFinished = true;
            await this.emitCallFinish();

            // Start processing as new call
            this.mode = ParserMode.TEXTING_CALL_HEADLINE;
            this.firstMentionAccumulator = '';
            this.headlineBuffer = '';
            this.headlineFinished = false;
            this.expectingFirstMention = true;
            return aheadPos; // Return the position of the @ so it gets reprocessed
          } else {
            // @ is not at line start, treat as body content
            // Emit headline finish before body start
            if (this.headlineBuffer) {
              await this.downstream.callHeadLineFinish();
            }
            this.headlineFinished = true;
            this.hasBody = true;
            await this.downstream.callBodyStart();
            this.mode = ParserMode.TEXTING_CALL_BODY;
            this.bodyChunkBuffer = '';
            return position + 1;
          }
        } else if (nextCharType === CharType.NEWLINE || nextCharType === CharType.SPACE) {
          aheadPos++;
        } else {
          // Found actual content - this is a body
          this.hasBody = true;
          await this.downstream.callBodyStart();
          this.mode = ParserMode.TEXTING_CALL_BODY;
          this.bodyChunkBuffer = '';
          return position + 1;
        }
      }

      return position + 1;
    }

    // Handle @ symbol - this indicates a new call
    if (charType === CharType.AT) {
      if (position + 1 >= chunk.length) {
        // Defer: could be @/ terminator or start of next call.
        await this.emitCallFinish();
        this.pendingAtTermination = true;
        return position + 1;
      }

      if (position + 1 < chunk.length && chunk[position + 1] === '/') {
        await this.emitCallFinish();
        this.mode = ParserMode.FREE_TEXT;
        return position + 2;
      }

      await this.emitCallFinish();
      this.mode = ParserMode.TEXTING_CALL_HEADLINE;
      this.firstMentionAccumulator = '';
      this.headlineBuffer = '';
      this.headlineFinished = false;
      this.expectingFirstMention = true;
      this.headlineHasContent = false;
      this.hasBody = false;
      this.isTripleQuotedBody = false;
      this.tripleQuotedBodyOpen = false;
      this.bodyChunkBuffer = '';
      this.pendingInitialBackticks = 0;
      return position;
    }

    // Any other character means there IS a body - start processing it
    await this.downstream.callBodyStart();
    this.mode = ParserMode.TEXTING_CALL_BODY;
    // Seed body buffer with any pending initial backticks, then reprocess current char
    if (this.pendingInitialBackticks > 0) {
      this.bodyChunkBuffer = '`'.repeat(this.pendingInitialBackticks);
      this.pendingInitialBackticks = 0;
    } else {
      this.bodyChunkBuffer = '';
    }
    // When transitioning to BODY mode, the current character is NOT at line start
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
    // Handle @/ termination for streaming calls (this should always work)
    // Check for @/ in current chunk first
    if (char === '@' && position + 1 < chunk.length && chunk[position + 1] === '/') {
      // End the call here
      await this.flushBodyBuffer();
      await this.downstream.callBodyFinish();
      await this.emitCallFinish();

      // Switch to free text for remaining content
      this.mode = ParserMode.FREE_TEXT;
      // Check if we have content before clearing the buffer
      const hasMarkdownContent = this.markdownChunkBuffer.length > 0;
      this.markdownChunkBuffer = '';

      // Only start markdown if we actually have content to process
      if (hasMarkdownContent) {
        this.markdownStarted = true;
        await this.downstream.markdownStart();
      } else {
        this.markdownStarted = false; // Ensure we don't have stale state
      }

      return position + 2; // Skip both @ and /
    }

    // Check for @ at end of chunk (termination marker might span chunks)
    if (char === '@' && position + 1 >= chunk.length) {
      // This @ is at the end of the chunk - defer decision to next chunk
      this.pendingAtTermination = true;
      this.pendingAtWasLineStart = this.isAtLineStart;
      return position + 1;
    }

    // If we had a pending @ termination and current char is /, end the call
    if (this.pendingAtTermination && char === '/') {
      this.pendingAtTermination = false;
      this.pendingAtWasLineStart = false;
      // Don't add @ or / to body buffer
      await this.flushBodyBuffer();
      await this.downstream.callBodyFinish();
      await this.emitCallFinish();

      // Switch to free text for remaining content
      this.mode = ParserMode.FREE_TEXT;
      // Check if we have content before clearing the buffer
      const hasMarkdownContent = this.markdownChunkBuffer.length > 0;
      this.markdownChunkBuffer = '';

      // Only start markdown if we actually have content to process
      if (hasMarkdownContent) {
        this.markdownStarted = true;
        await this.downstream.markdownStart();
      } else {
        this.markdownStarted = false; // Ensure we don't have stale state
      }

      return position + 1; // Skip the /
    }

    // Clear pending termination flag for any other character and include the deferred '@'
    if (this.pendingAtTermination) {
      this.pendingAtTermination = false;
      const wasLineStart = this.pendingAtWasLineStart;
      this.pendingAtWasLineStart = false;

      // If the deferred '@' was at line start, it may actually be a new call (not literal body).
      // Decide using the first character after '@': '/' => terminator (handled above); otherwise new call.
      if (wasLineStart) {
        const canStartNewCallFromBody =
          !this.tripleQuotedBodyOpen && this.backtickState === BacktickState.NONE;

        if (canStartNewCallFromBody) {
          await this.flushBodyBuffer();
          await this.downstream.callBodyFinish();
          await this.emitCallFinish();

          this.mode = ParserMode.TEXTING_CALL_HEADLINE;
          this.firstMentionAccumulator = '@';
          this.headlineBuffer = '@';
          this.headlineFinished = false;
          this.expectingFirstMention = true;
          this.headlineHasContent = false;

          return await this.processTextingCallHeadlineChunk(chunk, position, char, charType);
        }
      }

      this.bodyChunkBuffer += '@';
    }

    // Handle @ symbols that start new calls at line boundaries.
    //
    // IMPORTANT: Do NOT disable this behavior just because the body contains triple backticks.
    // Triple backticks are allowed as literal content in non-triple-quoted bodies, and multiple
    // calls may appear back-to-back without an explicit `@/` terminator.
    //
    // Only wholly triple-quoted bodies (started with `callBodyStart('```')`) should prevent
    // line-boundary `@` from terminating the call.
    if (charType === CharType.AT && this.isAtLineStart) {
      const canStartNewCallFromBody =
        !this.tripleQuotedBodyOpen && this.backtickState === BacktickState.NONE;

      if (canStartNewCallFromBody) {
        await this.flushBodyBuffer();
        await this.downstream.callBodyFinish();
        await this.emitCallFinish();

        this.mode = ParserMode.TEXTING_CALL_HEADLINE;
        this.firstMentionAccumulator = '';
        this.headlineBuffer = '';
        this.headlineFinished = false;
        this.expectingFirstMention = true;

        return await this.processTextingCallHeadlineChunk(chunk, position, char, charType);
      }
    }

    // In call bodies, ALL content including triple backticks should be treated as literal
    // Don't allow code block transitions within call bodies

    // Add character to body buffer
    this.bodyChunkBuffer += char;

    // For wholly triple quoted bodies, check if we've encountered a potential closing pattern
    // Look for triple backticks followed by newline (or end of input)
    if (
      this.isTripleQuotedBody &&
      this.backtickState === BacktickState.TRIPLE_START &&
      this.backtickCount === 3
    ) {
      // Check if this is followed by a newline or end of input
      const nextChar = position + 1 < chunk.length ? chunk[position + 1] : null;
      if (nextChar === '\n' || nextChar === null) {
        await this.flushBodyBuffer();
        await this.downstream.callBodyFinish('```');
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

        return position + 1;
      }
    }

    // For wholly triple quoted bodies, ensure we flush the content regularly to capture all content
    // including the outer triple backticks that were added when the body was started

    // Update backtick state but don't use it for transitions in call bodies
    this.updateBacktickState(charType);

    this.isAtLineStart =
      charType === CharType.NEWLINE || (this.isAtLineStart && charType === CharType.SPACE);
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
    // Check for closing triple backticks
    if (charType === CharType.BACKTICK) {
      this.backtickCount++;
      if (this.backtickCount === 1) {
        this.backtickState = BacktickState.SINGLE;
      } else if (this.backtickCount === 2) {
        this.backtickState = BacktickState.DOUBLE;
      } else if (this.backtickCount === 3) {
        this.backtickState = BacktickState.TRIPLE_START;

        // Remove the previous two backticks from the buffer (they were added before)
        if (this.codeBlockChunkBuffer.endsWith('``')) {
          this.codeBlockChunkBuffer = this.codeBlockChunkBuffer.slice(0, -2);
        }

        // Flush any remaining content
        if (this.codeBlockChunkBuffer) {
          await this.downstream.codeBlockChunk(this.codeBlockChunkBuffer);
          this.codeBlockChunkBuffer = '';
        }

        // End the code block
        await this.downstream.codeBlockFinish('');

        // Switch to free text (don't automatically start markdown unless there's content)
        this.mode = ParserMode.FREE_TEXT;
        this.markdownChunkBuffer = '';
        // Don't set markdownStarted = true here - let free text processing handle it naturally

        // Reset backtick state
        this.backtickCount = 0;
        this.backtickState = BacktickState.NONE;

        return position + 1; // Skip the third backtick
      } else {
        this.backtickState = BacktickState.TRIPLE_CONTENT;
      }
    } else {
      // Update backtick state for non-backtick characters (reset count)
      this.updateBacktickState(charType);

      this.codeBlockChunkBuffer += char;
    }

    this.isAtLineStart = charType === CharType.NEWLINE;
    return position + 1;
  }

  // Backtick state management
  private updateBacktickState(charType: CharType): void {
    if (charType === CharType.BACKTICK) {
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
        await this.flushCodeBlockBuffer();
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
