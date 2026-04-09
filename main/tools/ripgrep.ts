/**
 * Module: tools/ripgrep
 *
 * rtws (runtime workspace) search tools backed by `rg` (ripgrep), with low-noise YAML output.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import * as readline from 'node:readline';
import path from 'path';
import { Team } from '../team';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../tool';
import { toolFailure, toolSuccess } from '../tool';

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatYamlCodeBlock(yaml: string): string {
  return `\`\`\`yaml\n${yaml}\n\`\`\``;
}

function okYaml(yaml: string): ToolCallOutput {
  return toolSuccess(formatYamlCodeBlock(yaml));
}

function failYaml(yaml: string): ToolCallOutput {
  return toolFailure(formatYamlCodeBlock(yaml));
}

function yamlFlowStringArray(values: ReadonlyArray<string>): string {
  if (values.length === 0) return '[]';
  return `[${values.map(yamlQuote).join(', ')}]`;
}

function yamlFlowNumberArray(values: ReadonlyArray<number>): string {
  if (values.length === 0) return '[]';
  return `[${values.join(', ')}]`;
}

function requireNonEmptyStringArg(args: ToolArguments, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid arguments: \`${key}\` must be a non-empty string`);
  }
  return value;
}

function optionalStringArg(args: ToolArguments, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid arguments: \`${key}\` must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed;
}

function optionalBooleanArg(args: ToolArguments, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new Error(`Invalid arguments: \`${key}\` must be a boolean`);
  return value;
}

function optionalPositiveIntegerArg(args: ToolArguments, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid arguments: \`${key}\` must be an integer`);
  }
  if (value <= 0) throw new Error(`Invalid arguments: \`${key}\` must be a positive integer`);
  return value;
}

function optionalNonNegativeIntegerArg(args: ToolArguments, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid arguments: \`${key}\` must be an integer`);
  }
  if (value < 0) throw new Error(`Invalid arguments: \`${key}\` must be >= 0`);
  return value;
}

function optionalStringArrayArg(args: ToolArguments, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`Invalid arguments: \`${key}\` must be an array of strings`);
  }
  return value;
}

function dirPatternToRipgrepGlob(pattern: string): string | undefined {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
  if (normalized === '.' || normalized === '') return undefined;
  if (normalized.includes('*')) return normalized;
  if (normalized.endsWith('/**')) return normalized;
  return `${normalized}/**`;
}

function buildAccessControlGlobs(member: Team.Member): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];

  const whitelist = member.read_dirs ?? [];
  for (const pat of whitelist) {
    const glob = dirPatternToRipgrepGlob(pat);
    if (glob) include.push(glob);
  }

  const blacklist = member.no_read_dirs ?? [];
  for (const pat of blacklist) {
    const glob = dirPatternToRipgrepGlob(pat);
    if (glob) exclude.push(glob);
  }

  // Taskdocs are encapsulated and forbidden to all general file tools.
  exclude.push('**/*.tsk');
  exclude.push('**/*.tsk/*');
  exclude.push('**/*.tsk/**');

  // `.dialogs/**` at rtws root is reserved runtime persistence state and hard-denied.
  exclude.push('.dialogs');
  exclude.push('.dialogs/**');

  // `.minds/**` is reserved rtws state and hard-denied for general file tools.
  // Dedicated `.minds/`-scoped tools (team_mgmt) may bypass this with internal_allow_minds=true.
  if (member.internal_allow_minds !== true) {
    exclude.push('.minds');
    exclude.push('.minds/**');
  }

  return { include, exclude };
}

type ForbiddenSearchPath = '.minds' | '.dialogs' | '*.tsk/';

function normalizeRelFromRtwsRoot(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isEncapsulatedTaskPath(relFromRoot: string): boolean {
  const normalized = normalizeRelFromRtwsRoot(relFromRoot);
  return /(^|\/)[^/]+\.tsk(\/|$)/.test(normalized);
}

function detectRootReservedPath(
  relFromRoot: string,
): Exclude<ForbiddenSearchPath, '*.tsk/'> | null {
  const normalized = normalizeRelFromRtwsRoot(relFromRoot);
  if (normalized === '.minds' || normalized.startsWith('.minds/')) return '.minds';
  if (normalized === '.dialogs' || normalized.startsWith('.dialogs/')) return '.dialogs';
  return null;
}

function detectForbiddenRipgrepSearchPath(
  member: Team.Member,
  searchPath: string,
): ForbiddenSearchPath | null {
  const cwd = path.resolve(process.cwd());
  const abs = path.resolve(cwd, searchPath);
  const relFromRoot = path.relative(cwd, abs);
  if (isEncapsulatedTaskPath(relFromRoot)) return '*.tsk/';
  const reserved = detectRootReservedPath(relFromRoot);
  if (!reserved) return null;
  if (reserved === '.minds' && member.internal_allow_minds === true) return null;
  return reserved;
}

function normalizeGlobToken(glob: string): string {
  return glob
    .trim()
    .replace(/\\/g, '/')
    .replace(/^!+/, '')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function detectForbiddenPathFromGlob(
  member: Team.Member,
  glob: string,
): ForbiddenSearchPath | null {
  const normalized = normalizeGlobToken(glob);
  if (normalized === '') return null;

  if (/(^|\/)[^/]*\.tsk(\/|$)/.test(normalized)) return '*.tsk/';
  if (normalized === '.dialogs' || normalized.startsWith('.dialogs/')) return '.dialogs';
  if (
    (normalized === '.minds' || normalized.startsWith('.minds/')) &&
    member.internal_allow_minds !== true
  ) {
    return '.minds';
  }

  return null;
}

function detectForbiddenRipgrepGlobs(
  member: Team.Member,
  globs: ReadonlyArray<string>,
): ForbiddenSearchPath | null {
  for (const glob of globs) {
    const forbidden = detectForbiddenPathFromGlob(member, glob);
    if (forbidden) return forbidden;
  }
  return null;
}

function detectForbiddenRipgrepRawArgs(
  member: Team.Member,
  rawRgArgs: ReadonlyArray<string>,
): ForbiddenSearchPath | null {
  for (let i = 0; i < rawRgArgs.length; i++) {
    const tok = rawRgArgs[i] ?? '';
    let globPattern: string | null = null;

    if (tok === '--glob' || tok === '--iglob' || tok === '-g') {
      const next = rawRgArgs[i + 1];
      if (typeof next === 'string') {
        globPattern = next;
        i += 1;
      }
    } else if (tok.startsWith('--glob=')) {
      globPattern = tok.slice('--glob='.length);
    } else if (tok.startsWith('--iglob=')) {
      globPattern = tok.slice('--iglob='.length);
    } else if (tok.startsWith('-g') && tok.length > 2) {
      globPattern = tok.slice(2);
    }

    if (!globPattern) continue;
    const forbidden = detectForbiddenPathFromGlob(member, globPattern);
    if (forbidden) return forbidden;
  }
  return null;
}

function formatForbiddenSearchPathAccessDeniedYaml(
  mode: 'files' | 'count' | 'snippets',
  pattern: string,
  searchPath: string,
  forbiddenPath: ForbiddenSearchPath,
): ToolCallOutput {
  const summary =
    forbiddenPath === '.minds'
      ? 'ACCESS_DENIED: `.minds/**` is reserved rtws state for team config/memory/assets. Use `team_mgmt_ripgrep_*` (or other `team_mgmt_*`) for `.minds/**`.'
      : forbiddenPath === '.dialogs'
        ? 'ACCESS_DENIED: `.dialogs/**` at rtws root is reserved dialog/runtime persistence and is not searchable by general `ripgrep_*` tools. For Dominds debugging, reproduce under a nested rtws (e.g. `ux-rtws/.dialogs/**`).'
        : 'ACCESS_DENIED: `*.tsk/` is an encapsulated Taskdoc path and is hard-denied for general `ripgrep_*` tools.';
  const yaml = [
    `status: error`,
    `pattern: ${yamlQuote(pattern)}`,
    `mode: ${mode}`,
    `path: ${yamlQuote(searchPath)}`,
    `error: ACCESS_DENIED`,
    `reserved_path: ${yamlQuote(forbiddenPath)}`,
    `summary: ${yamlQuote(summary)}`,
  ].join('\n');
  return failYaml(yaml);
}

type RipgrepCase = 'smart' | 'sensitive' | 'insensitive';

type RipgrepBaseOptions = Readonly<{
  globs: ReadonlyArray<string>;
  caseMode: RipgrepCase;
  fixedStrings: boolean;
  includeHidden: boolean;
  followSymlinks: boolean;
}>;

type RipgrepFilesOptions = RipgrepBaseOptions & Readonly<{ maxFiles: number }>;
type RipgrepCountOptions = RipgrepBaseOptions & Readonly<{ maxFiles: number }>;
type RipgrepSnippetsOptions = RipgrepBaseOptions &
  Readonly<{ maxResults: number; contextBefore: number; contextAfter: number }>;

const RIPGREP_SNIPPET_TEXT_CHAR_LIMIT = 400;
const RIPGREP_SNIPPET_OUTPUT_CHAR_LIMIT = 200_000;
const RIPGREP_SNIPPET_RESULTS_CHAR_BUDGET = RIPGREP_SNIPPET_OUTPUT_CHAR_LIMIT - 2048;
const RIPGREP_STDERR_CHAR_LIMIT = 16_000;

type RipgrepSnippetResult = Readonly<{
  path: string;
  line: number;
  col: number;
  match: string;
  before?: ReadonlyArray<string>;
  after?: ReadonlyArray<string>;
}>;

type RipgrepRenderedSnippetText = Readonly<{
  text: string;
  truncated: boolean;
  originalChars: number;
}>;

type RipgrepRenderedSnippetResult = Readonly<{
  yaml: string;
  textTruncated: boolean;
  originalTextChars: number;
}>;

function truncateRipgrepSnippetText(
  text: string,
  maxChars = RIPGREP_SNIPPET_TEXT_CHAR_LIMIT,
): RipgrepRenderedSnippetText {
  if (text.length <= maxChars) return { text, truncated: false, originalChars: text.length };
  const suffix = `...[truncated ${text.length - maxChars} chars]`;
  if (suffix.length >= maxChars) {
    return { text: suffix.slice(0, maxChars), truncated: true, originalChars: text.length };
  }
  const keepChars = maxChars - suffix.length;
  return {
    text: `${text.slice(0, keepChars)}${suffix}`,
    truncated: true,
    originalChars: text.length,
  };
}

function sumNumbers(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function renderRipgrepSnippetResult(result: RipgrepSnippetResult): RipgrepRenderedSnippetResult {
  const match = truncateRipgrepSnippetText(result.match);
  const renderedBefore = (result.before ?? []).map((line) => truncateRipgrepSnippetText(line));
  const renderedAfter = (result.after ?? []).map((line) => truncateRipgrepSnippetText(line));
  const beforeOriginalChars = renderedBefore.map((line) => line.originalChars);
  const afterOriginalChars = renderedAfter.map((line) => line.originalChars);
  const textTruncated =
    match.truncated ||
    renderedBefore.some((line) => line.truncated) ||
    renderedAfter.some((line) => line.truncated);
  const reasons = textTruncated ? ['per_text_char_limit'] : [];
  const originalTextChars =
    match.originalChars + sumNumbers(beforeOriginalChars) + sumNumbers(afterOriginalChars);

  return {
    yaml: [
      `  - path: ${yamlQuote(result.path)}`,
      `    line: ${result.line}`,
      `    col: ${result.col}`,
      `    text_truncated: ${textTruncated}`,
      `    match: ${yamlQuote(match.text)}`,
      ...(result.before
        ? [`    before: ${yamlFlowStringArray(renderedBefore.map((line) => line.text))}`]
        : []),
      ...(result.after
        ? [`    after: ${yamlFlowStringArray(renderedAfter.map((line) => line.text))}`]
        : []),
      `    truncation:`,
      `      applied: ${textTruncated}`,
      `      reasons: ${yamlFlowStringArray(reasons)}`,
      `      match_original_chars: ${match.originalChars}`,
      `      before_original_chars: ${yamlFlowNumberArray(beforeOriginalChars)}`,
      `      after_original_chars: ${yamlFlowNumberArray(afterOriginalChars)}`,
    ].join('\n'),
    textTruncated,
    originalTextChars,
  };
}

function fitRipgrepSnippetResults(results: ReadonlyArray<RipgrepSnippetResult>): Readonly<{
  rendered: readonly string[];
  textTruncated: boolean;
  outputCharsTruncated: boolean;
  textTrimmedResultCount: number;
  shownOriginalTextChars: number;
  omittedOriginalTextChars: number;
  omittedResultsByOutputBudget: number;
}> {
  const rendered: string[] = [];
  let usedChars = 0;
  let textTruncated = false;
  let outputCharsTruncated = false;
  let textTrimmedResultCount = 0;
  let shownOriginalTextChars = 0;
  let omittedOriginalTextChars = 0;
  let omittedResultsByOutputBudget = 0;

  for (let idx = 0; idx < results.length; idx += 1) {
    const result = results[idx];
    const next = renderRipgrepSnippetResult(result);
    textTruncated = textTruncated || next.textTruncated;
    if (next.textTruncated) textTrimmedResultCount += 1;
    const nextChars = next.yaml.length + (rendered.length > 0 ? 1 : 0);
    if (usedChars + nextChars > RIPGREP_SNIPPET_RESULTS_CHAR_BUDGET) {
      outputCharsTruncated = true;
      omittedResultsByOutputBudget = results.length - idx;
      omittedOriginalTextChars += next.originalTextChars;
      for (let rest = idx + 1; rest < results.length; rest += 1) {
        omittedOriginalTextChars += renderRipgrepSnippetResult(results[rest]).originalTextChars;
      }
      break;
    }
    rendered.push(next.yaml);
    usedChars += nextChars;
    shownOriginalTextChars += next.originalTextChars;
  }

  if (rendered.length < results.length && !outputCharsTruncated) {
    outputCharsTruncated = true;
    omittedResultsByOutputBudget = results.length - rendered.length;
  }

  return {
    rendered,
    textTruncated,
    outputCharsTruncated,
    textTrimmedResultCount,
    shownOriginalTextChars,
    omittedOriginalTextChars,
    omittedResultsByOutputBudget,
  };
}

function buildRipgrepSnippetSummary(input: {
  totalMatches: number;
  shownResults: number;
  maxResults: number;
  truncatedByMatchLimit: boolean;
  truncatedByOutputChars: boolean;
  textTruncated: boolean;
}): string {
  if (input.totalMatches === 0) return 'No matches.';
  if (input.truncatedByMatchLimit && input.truncatedByOutputChars) {
    return `Found ${input.totalMatches} matches; showing ${input.shownResults} snippets within max_results/output limits (truncated=true).`;
  }
  if (input.truncatedByOutputChars) {
    return `Found ${input.totalMatches} matches; showing ${input.shownResults} snippets within output size limit (truncated=true).`;
  }
  if (input.truncatedByMatchLimit) {
    return `Showing first ${input.maxResults} of ${input.totalMatches} matches (truncated=true).`;
  }
  if (input.textTruncated) {
    return `Found ${input.totalMatches} matches; long snippet lines were trimmed for readability.`;
  }
  return `Found ${input.totalMatches} matches.`;
}

function formatRipgrepSnippetYaml(input: {
  pattern: string;
  searchPath: string;
  globs: ReadonlyArray<string>;
  caseMode: RipgrepCase;
  fixedStrings: boolean;
  maxResults: number;
  fileCount: number;
  totalMatches: number;
  results: ReadonlyArray<RipgrepSnippetResult>;
}): ToolCallOutput {
  const fitted = fitRipgrepSnippetResults(input.results);
  const truncatedByMatchLimit = input.totalMatches > input.maxResults;
  const truncated = truncatedByMatchLimit || fitted.outputCharsTruncated || fitted.textTruncated;
  const truncationReasons: string[] = [];
  if (truncatedByMatchLimit) truncationReasons.push('max_results');
  if (fitted.outputCharsTruncated) truncationReasons.push('output_char_budget');
  if (fitted.textTruncated) truncationReasons.push('per_text_char_limit');
  const summary = buildRipgrepSnippetSummary({
    totalMatches: input.totalMatches,
    shownResults: fitted.rendered.length,
    maxResults: input.maxResults,
    truncatedByMatchLimit,
    truncatedByOutputChars: fitted.outputCharsTruncated,
    textTruncated: fitted.textTruncated,
  });

  const yaml = [
    `status: ok`,
    `pattern: ${yamlQuote(input.pattern)}`,
    `mode: snippets`,
    `path: ${yamlQuote(input.searchPath)}`,
    ...(input.globs.length > 0 ? [`globs: ${yamlFlowStringArray(input.globs)}`] : []),
    `case: ${input.caseMode}`,
    `fixed_strings: ${input.fixedStrings}`,
    `regex: ${!input.fixedStrings}`,
    `truncated: ${truncated}`,
    `truncated_by_output_chars: ${fitted.outputCharsTruncated}`,
    `snippet_text_truncated: ${fitted.textTruncated}`,
    `limits:`,
    `  max_results: ${input.maxResults}`,
    `  max_output_chars: ${RIPGREP_SNIPPET_OUTPUT_CHAR_LIMIT}`,
    `  per_text_char_limit: ${RIPGREP_SNIPPET_TEXT_CHAR_LIMIT}`,
    `totals:`,
    `  files_matched: ${input.fileCount}`,
    `  matches: ${input.totalMatches}`,
    `  shown_results: ${fitted.rendered.length}`,
    `truncation:`,
    `  applied: ${truncated}`,
    `  reasons: ${yamlFlowStringArray(truncationReasons)}`,
    `  text_trimmed_result_count: ${fitted.textTrimmedResultCount}`,
    `  omitted_results_by_output_budget: ${fitted.omittedResultsByOutputBudget}`,
    `  shown_original_text_chars: ${fitted.shownOriginalTextChars}`,
    `  omitted_original_text_chars: ${fitted.omittedOriginalTextChars}`,
    `summary: ${yamlQuote(summary)}`,
    `results:`,
    ...fitted.rendered,
  ].join('\n');
  return okYaml(yaml);
}

function defaultBaseOptions(): RipgrepBaseOptions {
  return {
    globs: [],
    caseMode: 'smart',
    fixedStrings: false,
    includeHidden: false,
    followSymlinks: false,
  };
}

function parseRipgrepCaseModeArg(args: ToolArguments, defaultValue: RipgrepCase): RipgrepCase {
  const raw = optionalStringArg(args, 'case');
  if (raw === undefined) return defaultValue;
  if (raw === 'smart' || raw === 'sensitive' || raw === 'insensitive') return raw;
  throw new Error("Invalid arguments: `case` must be one of: 'smart', 'sensitive', 'insensitive'");
}

function baseRgArgs(options: RipgrepBaseOptions, member: Team.Member): string[] {
  const args: string[] = ['--no-messages', '--color=never'];
  if (options.includeHidden) args.push('--hidden');
  if (options.followSymlinks) args.push('--follow');

  if (options.caseMode === 'smart') args.push('--smart-case');
  if (options.caseMode === 'sensitive') args.push('--case-sensitive');
  if (options.caseMode === 'insensitive') args.push('--ignore-case');

  if (options.fixedStrings) args.push('--fixed-strings');

  const access = buildAccessControlGlobs(member);
  for (const inc of access.include) {
    args.push('--glob', inc);
  }
  for (const exc of access.exclude) {
    args.push('--glob', `!${exc}`);
  }

  for (const glob of options.globs) {
    args.push('--glob', glob);
  }

  return args;
}

function appendTruncatedText(
  state: { text: string; omittedChars: number },
  chunk: string,
  maxChars: number,
): void {
  if (state.text.length >= maxChars) {
    state.omittedChars += chunk.length;
    return;
  }
  const remainingChars = maxChars - state.text.length;
  if (chunk.length <= remainingChars) {
    state.text += chunk;
    return;
  }
  state.text += chunk.slice(0, remainingChars);
  state.omittedChars += chunk.length - remainingChars;
}

function formatTruncatedText(state: { text: string; omittedChars: number }): string {
  if (state.omittedChars === 0) return state.text;
  const suffix = `\n...[truncated ${state.omittedChars} chars]`;
  return `${state.text}${suffix}`;
}

async function runRgLines(
  args: string[],
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  return await new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (!child.stdout || !child.stderr) {
      reject(new Error('rg failed to create stdio pipes'));
      return;
    }

    const stderrState = { text: '', omittedChars: 0 };
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let processClosed = false;
    let processCloseCode: number | null = null;
    let processCloseSignal: NodeJS.Signals | null = null;
    let stdoutConsumed = false;
    let settled = false;

    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rl.close();
      if (!child.killed) child.kill();
      reject(error);
    };

    const resolveOnce = (): void => {
      if (settled || !processClosed || !stdoutConsumed) return;
      settled = true;
      const stderrText = formatTruncatedText(stderrState).trim();
      if (processCloseSignal) {
        reject(new Error(`rg terminated by signal ${processCloseSignal}`));
        return;
      }
      if (processCloseCode !== null && processCloseCode !== 0 && processCloseCode !== 1) {
        const summary = stderrText === '' ? `rg exited with code ${processCloseCode}` : stderrText;
        reject(new Error(summary));
        return;
      }
      resolve();
    };

    child.on('error', (err: unknown) => rejectOnce(err));
    child.stdout.on('error', (err: Error) => rejectOnce(err));
    child.stderr.on('error', (err: Error) => rejectOnce(err));
    child.stderr.on('data', (chunk: Buffer | string) => {
      appendTruncatedText(
        stderrState,
        typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
        RIPGREP_STDERR_CHAR_LIMIT,
      );
    });
    child.on('close', (code, signal) => {
      processClosed = true;
      processCloseCode = code;
      processCloseSignal = signal;
      resolveOnce();
    });

    void (async () => {
      try {
        for await (const line of rl) {
          if (line === '') continue;
          await onLine(line);
        }
        stdoutConsumed = true;
        resolveOnce();
      } catch (error: unknown) {
        rejectOnce(error);
      }
    })();
  });
}

async function loadFileLines(relPath: string): Promise<string[]> {
  const abs = path.resolve(process.cwd(), relPath);
  const text = await fs.readFile(abs, 'utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

async function runRipgrepFiles(
  caller: Team.Member,
  pattern: string,
  searchPath: string,
  options: RipgrepFilesOptions,
): Promise<ToolCallOutput> {
  const forbiddenPath = detectForbiddenRipgrepSearchPath(caller, searchPath);
  if (forbiddenPath) {
    return formatForbiddenSearchPathAccessDeniedYaml('files', pattern, searchPath, forbiddenPath);
  }
  const forbiddenGlob = detectForbiddenRipgrepGlobs(caller, options.globs);
  if (forbiddenGlob) {
    return formatForbiddenSearchPathAccessDeniedYaml('files', pattern, searchPath, forbiddenGlob);
  }

  const args = [...baseRgArgs(options, caller), '--files-with-matches', '--', pattern, searchPath];

  try {
    let totalFiles = 0;
    const results: Array<{ path: string }> = [];
    await runRgLines(args, (line) => {
      totalFiles++;
      if (results.length < options.maxFiles) results.push({ path: line });
    });
    const truncated = totalFiles > options.maxFiles;
    const summary =
      totalFiles === 0
        ? 'No matches.'
        : truncated
          ? `Found ${totalFiles} files; showing first ${options.maxFiles} (truncated=true).`
          : `Found ${totalFiles} files.`;

    const yaml = [
      `status: ok`,
      `pattern: ${yamlQuote(pattern)}`,
      `mode: files`,
      `path: ${yamlQuote(searchPath)}`,
      ...(options.globs.length > 0 ? [`globs: ${yamlFlowStringArray(options.globs)}`] : []),
      `case: ${options.caseMode}`,
      `fixed_strings: ${options.fixedStrings}`,
      `regex: ${!options.fixedStrings}`,
      `truncated: ${truncated}`,
      `limits:`,
      `  max_files: ${options.maxFiles}`,
      `totals:`,
      `  files_matched: ${totalFiles}`,
      `summary: ${yamlQuote(summary)}`,
      `results:`,
      ...results.map((r) => `  - path: ${yamlQuote(r.path)}`),
    ].join('\n');
    return okYaml(yaml);
  } catch (error: unknown) {
    return failYaml(
      [
        `status: error`,
        `pattern: ${yamlQuote(pattern)}`,
        `mode: files`,
        `path: ${yamlQuote(searchPath)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
  }
}

export const ripgrepFilesTool: FuncTool = {
  type: 'func',
  name: 'ripgrep_files',
  description: 'Search file paths containing a pattern (rg-backed).',
  descriptionI18n: {
    en: 'Search file paths containing a pattern (rg-backed).',
    zh: '搜索包含匹配内容的文件路径（rg 驱动）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      fixed_strings: { type: 'boolean' },
      max_files: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<ToolCallOutput> => {
    const pattern = requireNonEmptyStringArg(args, 'pattern');
    const searchPath = optionalStringArg(args, 'path') ?? '.';
    const globs = optionalStringArrayArg(args, 'globs') ?? [];
    const caseMode = parseRipgrepCaseModeArg(args, 'smart');
    const fixedStrings = optionalBooleanArg(args, 'fixed_strings') ?? false;
    const includeHidden = optionalBooleanArg(args, 'include_hidden') ?? false;
    const followSymlinks = optionalBooleanArg(args, 'follow_symlinks') ?? false;
    const maxFiles = optionalPositiveIntegerArg(args, 'max_files') ?? 50;

    const options: RipgrepFilesOptions = {
      globs,
      caseMode,
      fixedStrings,
      includeHidden,
      followSymlinks,
      maxFiles,
    };

    return await runRipgrepFiles(caller, pattern, searchPath, options);
  },
};

async function runRipgrepCount(
  caller: Team.Member,
  pattern: string,
  searchPath: string,
  options: RipgrepCountOptions,
): Promise<ToolCallOutput> {
  const forbiddenPath = detectForbiddenRipgrepSearchPath(caller, searchPath);
  if (forbiddenPath) {
    return formatForbiddenSearchPathAccessDeniedYaml('count', pattern, searchPath, forbiddenPath);
  }
  const forbiddenGlob = detectForbiddenRipgrepGlobs(caller, options.globs);
  if (forbiddenGlob) {
    return formatForbiddenSearchPathAccessDeniedYaml('count', pattern, searchPath, forbiddenGlob);
  }

  const args = [...baseRgArgs(options, caller), '--count-matches', '--', pattern, searchPath];

  try {
    let totalFiles = 0;
    let totalMatches = 0;
    const results: Array<{ path: string; count: number }> = [];
    await runRgLines(args, (line) => {
      const idx = line.lastIndexOf(':');
      if (idx <= 0) return;
      const p = line.slice(0, idx);
      const rawCount = line.slice(idx + 1);
      const count = Number.parseInt(rawCount, 10);
      if (!Number.isFinite(count)) return;
      totalFiles++;
      totalMatches += count;
      if (results.length < options.maxFiles) results.push({ path: p, count });
    });
    const truncated = totalFiles > options.maxFiles;
    const summary =
      totalMatches === 0
        ? 'No matches.'
        : truncated
          ? `Counted ${totalMatches} matches in ${totalFiles} files; showing first ${options.maxFiles} files (truncated=true).`
          : `Counted ${totalMatches} matches in ${totalFiles} files.`;

    const yaml = [
      `status: ok`,
      `pattern: ${yamlQuote(pattern)}`,
      `mode: count`,
      `path: ${yamlQuote(searchPath)}`,
      ...(options.globs.length > 0 ? [`globs: ${yamlFlowStringArray(options.globs)}`] : []),
      `case: ${options.caseMode}`,
      `fixed_strings: ${options.fixedStrings}`,
      `regex: ${!options.fixedStrings}`,
      `truncated: ${truncated}`,
      `limits:`,
      `  max_files: ${options.maxFiles}`,
      `totals:`,
      `  files_matched: ${totalFiles}`,
      `  matches: ${totalMatches}`,
      `summary: ${yamlQuote(summary)}`,
      `results:`,
      ...results.map((r) => `  - path: ${yamlQuote(r.path)}\n    count: ${r.count}`),
    ].join('\n');
    return okYaml(yaml);
  } catch (error: unknown) {
    return failYaml(
      [
        `status: error`,
        `pattern: ${yamlQuote(pattern)}`,
        `mode: count`,
        `path: ${yamlQuote(searchPath)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
  }
}

export const ripgrepCountTool: FuncTool = {
  type: 'func',
  name: 'ripgrep_count',
  description: 'Count matches per file (rg-backed).',
  descriptionI18n: {
    en: 'Count matches per file (rg-backed).',
    zh: '统计每个文件的匹配数量（rg 驱动）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      fixed_strings: { type: 'boolean' },
      max_files: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<ToolCallOutput> => {
    const pattern = requireNonEmptyStringArg(args, 'pattern');
    const searchPath = optionalStringArg(args, 'path') ?? '.';
    const globs = optionalStringArrayArg(args, 'globs') ?? [];
    const caseMode = parseRipgrepCaseModeArg(args, 'smart');
    const fixedStrings = optionalBooleanArg(args, 'fixed_strings') ?? false;
    const includeHidden = optionalBooleanArg(args, 'include_hidden') ?? false;
    const followSymlinks = optionalBooleanArg(args, 'follow_symlinks') ?? false;
    const maxFiles = optionalPositiveIntegerArg(args, 'max_files') ?? 200;

    const options: RipgrepCountOptions = {
      globs,
      caseMode,
      fixedStrings,
      includeHidden,
      followSymlinks,
      maxFiles,
    };

    return await runRipgrepCount(caller, pattern, searchPath, options);
  },
};

async function runRipgrepSnippets(
  caller: Team.Member,
  pattern: string,
  searchPath: string,
  options: RipgrepSnippetsOptions,
): Promise<ToolCallOutput> {
  const forbiddenPath = detectForbiddenRipgrepSearchPath(caller, searchPath);
  if (forbiddenPath) {
    return formatForbiddenSearchPathAccessDeniedYaml(
      'snippets',
      pattern,
      searchPath,
      forbiddenPath,
    );
  }
  const forbiddenGlob = detectForbiddenRipgrepGlobs(caller, options.globs);
  if (forbiddenGlob) {
    return formatForbiddenSearchPathAccessDeniedYaml(
      'snippets',
      pattern,
      searchPath,
      forbiddenGlob,
    );
  }

  const args = [...baseRgArgs(options, caller), '--vimgrep', '--', pattern, searchPath];

  try {
    let totalMatches = 0;
    const fileSet = new Set<string>();
    const results: Array<{
      path: string;
      line: number;
      col: number;
      match: string;
      before: string[];
      after: string[];
    }> = [];
    const fileCache = new Map<string, string[]>();

    await runRgLines(args, async (line) => {
      totalMatches++;
      const first = line.indexOf(':');
      if (first <= 0) return;
      const second = line.indexOf(':', first + 1);
      if (second <= first) return;
      const third = line.indexOf(':', second + 1);
      if (third <= second) return;
      const filePath = line.slice(0, first);
      const lineStr = line.slice(first + 1, second);
      const colStr = line.slice(second + 1, third);
      const text = line.slice(third + 1);
      const ln = Number.parseInt(lineStr, 10);
      const col = Number.parseInt(colStr, 10);
      if (!Number.isFinite(ln) || !Number.isFinite(col)) return;
      fileSet.add(filePath);

      if (results.length >= options.maxResults) return;
      let lines = fileCache.get(filePath);
      if (!lines) {
        lines = await loadFileLines(filePath).catch(() => []);
        fileCache.set(filePath, lines);
      }
      const idx0 = ln - 1;
      const before = lines.slice(Math.max(0, idx0 - options.contextBefore), idx0);
      const after = lines.slice(idx0 + 1, idx0 + 1 + options.contextAfter);
      results.push({ path: filePath, line: ln, col, match: text, before, after });
    });

    return formatRipgrepSnippetYaml({
      pattern,
      searchPath,
      globs: options.globs,
      caseMode: options.caseMode,
      fixedStrings: options.fixedStrings,
      maxResults: options.maxResults,
      fileCount: fileSet.size,
      totalMatches,
      results,
    });
  } catch (error: unknown) {
    return failYaml(
      [
        `status: error`,
        `pattern: ${yamlQuote(pattern)}`,
        `mode: snippets`,
        `path: ${yamlQuote(searchPath)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
  }
}

export const ripgrepSnippetsTool: FuncTool = {
  type: 'func',
  name: 'ripgrep_snippets',
  description: 'Search snippets with line/col (rg-backed).',
  descriptionI18n: {
    en: 'Search snippets with line/col (rg-backed).',
    zh: '搜索并显示带行列的匹配片段（rg 驱动）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      fixed_strings: { type: 'boolean' },
      context_before: { type: 'integer' },
      context_after: { type: 'integer' },
      max_results: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<ToolCallOutput> => {
    const pattern = requireNonEmptyStringArg(args, 'pattern');
    const searchPath = optionalStringArg(args, 'path') ?? '.';
    const globs = optionalStringArrayArg(args, 'globs') ?? [];
    const caseMode = parseRipgrepCaseModeArg(args, 'smart');
    const fixedStrings = optionalBooleanArg(args, 'fixed_strings') ?? false;
    const includeHidden = optionalBooleanArg(args, 'include_hidden') ?? false;
    const followSymlinks = optionalBooleanArg(args, 'follow_symlinks') ?? false;
    const maxResults = optionalPositiveIntegerArg(args, 'max_results') ?? 50;
    const contextBefore = optionalNonNegativeIntegerArg(args, 'context_before') ?? 1;
    const contextAfter = optionalNonNegativeIntegerArg(args, 'context_after') ?? 1;

    const options: RipgrepSnippetsOptions = {
      globs,
      caseMode,
      fixedStrings,
      includeHidden,
      followSymlinks,
      maxResults,
      contextBefore,
      contextAfter,
    };

    return await runRipgrepSnippets(caller, pattern, searchPath, options);
  },
};

export const ripgrepFixedTool: FuncTool = {
  type: 'func',
  name: 'ripgrep_fixed',
  description:
    'Fixed-string ripgrep convenience tool (routes to ripgrep_files/ripgrep_snippets/ripgrep_count with fixed_strings=true).',
  descriptionI18n: {
    en: 'Fixed-string ripgrep convenience tool (routes to ripgrep_files/ripgrep_snippets/ripgrep_count with fixed_strings=true).',
    zh: '固定字符串 ripgrep 便捷工具（等同于对 ripgrep_files/ripgrep_snippets/ripgrep_count 使用 fixed_strings=true）。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      literal: { type: 'string' },
      path: { type: 'string' },
      mode: { type: 'string' },
      globs: { type: 'array', items: { type: 'string' } },
      case: { type: 'string' },
      max_files: { type: 'integer' },
      max_results: { type: 'integer' },
      context_before: { type: 'integer' },
      context_after: { type: 'integer' },
      include_hidden: { type: 'boolean' },
      follow_symlinks: { type: 'boolean' },
    },
    required: ['literal'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<ToolCallOutput> => {
    const literal = requireNonEmptyStringArg(args, 'literal');
    const searchPath = optionalStringArg(args, 'path') ?? '.';
    const modeRaw = optionalStringArg(args, 'mode') ?? 'snippets';
    if (modeRaw !== 'files' && modeRaw !== 'snippets' && modeRaw !== 'count') {
      throw new Error("Invalid arguments: `mode` must be one of: 'files', 'snippets', 'count'");
    }

    const globs = optionalStringArrayArg(args, 'globs') ?? [];
    const caseMode = parseRipgrepCaseModeArg(args, 'smart');
    const includeHidden = optionalBooleanArg(args, 'include_hidden') ?? false;
    const followSymlinks = optionalBooleanArg(args, 'follow_symlinks') ?? false;

    const base: RipgrepBaseOptions = {
      globs,
      caseMode,
      fixedStrings: true,
      includeHidden,
      followSymlinks,
    };

    if (modeRaw === 'files') {
      const maxFiles = optionalPositiveIntegerArg(args, 'max_files') ?? 50;
      const options: RipgrepFilesOptions = { ...base, maxFiles };
      return await runRipgrepFiles(caller, literal, searchPath, options);
    }

    if (modeRaw === 'count') {
      const maxFiles = optionalPositiveIntegerArg(args, 'max_files') ?? 200;
      const options: RipgrepCountOptions = { ...base, maxFiles };
      return await runRipgrepCount(caller, literal, searchPath, options);
    }

    const maxResults = optionalPositiveIntegerArg(args, 'max_results') ?? 50;
    const contextBefore = optionalNonNegativeIntegerArg(args, 'context_before') ?? 1;
    const contextAfter = optionalNonNegativeIntegerArg(args, 'context_after') ?? 1;
    const options: RipgrepSnippetsOptions = { ...base, maxResults, contextBefore, contextAfter };
    return await runRipgrepSnippets(caller, literal, searchPath, options);
  },
};

const DISALLOWED_RG_ARGS = new Set(['--pre', '--pre-glob']);

async function runRipgrepSearch(
  caller: Team.Member,
  pattern: string,
  searchPath: string,
  rawRgArgs: ReadonlyArray<string>,
): Promise<ToolCallOutput> {
  const forbiddenPath = detectForbiddenRipgrepSearchPath(caller, searchPath);
  if (forbiddenPath) {
    return formatForbiddenSearchPathAccessDeniedYaml(
      'snippets',
      pattern,
      searchPath,
      forbiddenPath,
    );
  }
  const forbiddenInArgs = detectForbiddenRipgrepRawArgs(caller, rawRgArgs);
  if (forbiddenInArgs) {
    return formatForbiddenSearchPathAccessDeniedYaml(
      'snippets',
      pattern,
      searchPath,
      forbiddenInArgs,
    );
  }

  for (const tok of rawRgArgs) {
    if (DISALLOWED_RG_ARGS.has(tok)) {
      return failYaml(
        `status: error\nerror: DISALLOWED_ARG\nsummary: ${yamlQuote(`Disallowed rg arg: ${tok}`)}`,
      );
    }
    if (
      tok === '--json' ||
      tok === '--count' ||
      tok === '--count-matches' ||
      tok === '--files-with-matches' ||
      tok === '--files'
    ) {
      return failYaml(
        `status: error\nerror: DISALLOWED_ARG\nsummary: ${yamlQuote(`Disallowed rg output arg: ${tok}`)}`,
      );
    }
  }

  const options: RipgrepSnippetsOptions = {
    ...defaultBaseOptions(),
    fixedStrings: false,
    maxResults: 50,
    contextBefore: 1,
    contextAfter: 1,
  };

  const rgArgs = [
    ...baseRgArgs(options, caller),
    ...rawRgArgs,
    '--vimgrep',
    '--',
    pattern,
    searchPath,
  ];

  try {
    let totalMatches = 0;
    const fileSet = new Set<string>();
    const results: Array<{ path: string; line: number; col: number; match: string }> = [];
    await runRgLines(rgArgs, (line) => {
      totalMatches++;
      const first = line.indexOf(':');
      if (first <= 0) return;
      const secondColon = line.indexOf(':', first + 1);
      if (secondColon <= first) return;
      const thirdColon = line.indexOf(':', secondColon + 1);
      if (thirdColon <= secondColon) return;
      const filePath = line.slice(0, first);
      const lineStr = line.slice(first + 1, secondColon);
      const colStr = line.slice(secondColon + 1, thirdColon);
      const text = line.slice(thirdColon + 1);
      const ln = Number.parseInt(lineStr, 10);
      const col = Number.parseInt(colStr, 10);
      if (!Number.isFinite(ln) || !Number.isFinite(col)) return;
      fileSet.add(filePath);
      if (results.length < options.maxResults)
        results.push({ path: filePath, line: ln, col, match: text });
    });

    return formatRipgrepSnippetYaml({
      pattern,
      searchPath,
      globs: [],
      caseMode: 'smart',
      fixedStrings: false,
      maxResults: options.maxResults,
      fileCount: fileSet.size,
      totalMatches,
      results,
    });
  } catch (error: unknown) {
    return failYaml(
      [
        `status: error`,
        `pattern: ${yamlQuote(pattern)}`,
        `mode: snippets`,
        `path: ${yamlQuote(searchPath)}`,
        `error: FAILED`,
        `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
      ].join('\n'),
    );
  }
}

export const ripgrepSearchTool: FuncTool = {
  type: 'func',
  name: 'ripgrep_search',
  description:
    'Escape hatch: run rg-style search (snippets output, with a limited allowlist). Output is normalized to YAML snippets mode.',
  descriptionI18n: {
    en: 'Escape hatch: run rg-style search (snippets output, with a limited allowlist). Output is normalized to YAML snippets mode.',
    zh: '逃生舱：运行 rg 风格搜索（片段输出，参数白名单）。输出归一为 YAML snippets 模式。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      rg_args: { type: 'array', items: { type: 'string' } },
    },
    required: ['pattern'],
  },
  argsValidation: 'dominds',
  call: async (_dlg, caller, args): Promise<ToolCallOutput> => {
    const pattern = requireNonEmptyStringArg(args, 'pattern');
    const searchPath = optionalStringArg(args, 'path') ?? '.';
    const rgArgs = optionalStringArrayArg(args, 'rg_args') ?? [];
    return await runRipgrepSearch(caller, pattern, searchPath, rgArgs);
  },
};
