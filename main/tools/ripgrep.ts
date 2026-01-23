/**
 * Module: tools/ripgrep
 *
 * Workspace search tools backed by `rg` (ripgrep), with low-noise YAML output.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { ChatMessage } from '../llm/client';
import { getWorkLanguage } from '../shared/runtime-language';
import { Team } from '../team';
import { TellaskTool, TellaskToolCallResult } from '../tool';

function ok(result: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'completed', result, messages };
}

function failed(result: string, messages?: ChatMessage[]): TellaskToolCallResult {
  return { status: 'failed', result, messages };
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatYamlCodeBlock(yaml: string): string {
  return `\`\`\`yaml\n${yaml}\n\`\`\``;
}

function yamlFlowStringArray(values: ReadonlyArray<string>): string {
  if (values.length === 0) return '[]';
  return `[${values.map(yamlQuote).join(', ')}]`;
}

function splitCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  const flush = (): void => {
    if (current === '') return;
    args.push(current);
    current = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? '';
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (!inSingle && ch === '\\') {
      escape = true;
      continue;
    }
    if (!inDouble && ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (!inDouble && ch === "'" && inSingle) {
      inSingle = false;
      continue;
    }
    if (!inSingle && ch === '"' && !inDouble) {
      inDouble = true;
      continue;
    }
    if (!inSingle && ch === '"' && inDouble) {
      inDouble = false;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return args;
}

function quoteCommandArg(value: string): string {
  if (value === '') return '""';
  const needsQuoting = /[\s"\\]/.test(value);
  if (!needsQuoting) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function parseBooleanOption(value: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parseIntegerOption(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function parseGlobsValue(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  const parts = inner.split(',').map((p) => p.trim());
  const globs: string[] = [];
  for (const part of parts) {
    const unquoted =
      (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
        ? part.slice(1, -1)
        : part;
    if (unquoted !== '') globs.push(unquoted);
  }
  return globs;
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

  // Task Docs are encapsulated and forbidden to all general file tools.
  exclude.push('**/*.tsk');
  exclude.push('**/*.tsk/**');

  return { include, exclude };
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

function defaultBaseOptions(): RipgrepBaseOptions {
  return {
    globs: [],
    caseMode: 'smart',
    fixedStrings: false,
    includeHidden: false,
    followSymlinks: false,
  };
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

async function runRgLines(args: string[]): Promise<{ stdoutLines: string[]; stderrText: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
    child.on('error', (err: unknown) => reject(err));
    child.on('close', (_code) => {
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      const stdoutLines = stdoutText.split('\n').filter((l) => l !== '');
      resolve({ stdoutLines, stderrText });
    });
  });
}

function parseRipgrepArgs(
  toolName: string,
  headLine: string,
  defaults: RipgrepBaseOptions & {
    maxFiles?: number;
    maxResults?: number;
    contextBefore?: number;
    contextAfter?: number;
  },
):
  | { ok: true; pattern: string; searchPath: string; options: typeof defaults }
  | { ok: false; yamlError: string } {
  const language = getWorkLanguage();
  const trimmed = headLine.trim();
  if (!trimmed.startsWith(`@${toolName}`)) {
    return {
      ok: false,
      yamlError: [
        `status: error`,
        `error: INVALID_FORMAT`,
        `summary: ${yamlQuote(
          language === 'zh'
            ? `Invalid format. Use !?@${toolName} <pattern> [path] [options].`
            : `Invalid format. Use !?@${toolName} <pattern> [path] [options].`,
        )}`,
      ].join('\n'),
    };
  }

  const afterToolName = trimmed.slice(`@${toolName}`.length).trim();
  const args = splitCommandArgs(afterToolName);
  const pattern = args[0] ?? '';
  if (!pattern) {
    return {
      ok: false,
      yamlError: [
        `status: error`,
        `error: PATTERN_REQUIRED`,
        `summary: ${yamlQuote(language === 'zh' ? 'Pattern required.' : 'Pattern required.')}`,
      ].join('\n'),
    };
  }

  const second = args[1];
  const searchPath = second && !second.includes('=') ? second : '.';
  const optTokens = second && !second.includes('=') ? args.slice(2) : args.slice(1);

  const options: Record<string, unknown> = { ...defaults };

  for (const tok of optTokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    if (key === 'case') {
      if (value === 'smart' || value === 'sensitive' || value === 'insensitive') {
        options.caseMode = value;
      }
    } else if (key === 'fixed_strings') {
      const parsed = parseBooleanOption(value);
      if (parsed !== undefined) options.fixedStrings = parsed;
    } else if (key === 'include_hidden') {
      const parsed = parseBooleanOption(value);
      if (parsed !== undefined) options.includeHidden = parsed;
    } else if (key === 'follow_symlinks') {
      const parsed = parseBooleanOption(value);
      if (parsed !== undefined) options.followSymlinks = parsed;
    } else if (key === 'max_files') {
      const parsed = parseIntegerOption(value);
      if (parsed !== undefined) options.maxFiles = parsed;
    } else if (key === 'max_results') {
      const parsed = parseIntegerOption(value);
      if (parsed !== undefined) options.maxResults = parsed;
    } else if (key === 'context_before') {
      const parsed = parseIntegerOption(value);
      if (parsed !== undefined) options.contextBefore = parsed;
    } else if (key === 'context_after') {
      const parsed = parseIntegerOption(value);
      if (parsed !== undefined) options.contextAfter = parsed;
    } else if (key === 'globs') {
      const parsed = parseGlobsValue(value);
      if (parsed !== undefined) options.globs = parsed;
    }
  }

  return { ok: true, pattern, searchPath, options: options as typeof defaults };
}

async function loadFileLines(relPath: string): Promise<string[]> {
  const abs = path.resolve(process.cwd(), relPath);
  const text = await fs.readFile(abs, 'utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export const ripgrepFilesTool: TellaskTool = {
  type: 'tellask',
  name: 'ripgrep_files',
  backfeeding: true,
  usageDescription: `Search file paths containing a pattern (rg-backed).
Usage: !?@ripgrep_files <pattern> [path] [options]

Options:
  globs=[...]
  case=smart|sensitive|insensitive
  fixed_strings=true|false
  max_files=<n> (default: 50)
  include_hidden=true|false (default: false)
  follow_symlinks=true|false (default: false)`,
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const parsed = parseRipgrepArgs('ripgrep_files', headLine, {
      ...defaultBaseOptions(),
      maxFiles: 50,
    });
    if (!parsed.ok) {
      const content = formatYamlCodeBlock(parsed.yamlError);
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    if (!caller || typeof caller !== 'object') {
      const content = formatYamlCodeBlock(
        `status: error\nerror: INTERNAL\nsummary: ${yamlQuote('Invalid caller.')}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const options = parsed.options as RipgrepFilesOptions;
    const args = [
      ...baseRgArgs(options, caller),
      '--files-with-matches',
      '--',
      parsed.pattern,
      parsed.searchPath,
    ];

    try {
      const { stdoutLines } = await runRgLines(args);
      let totalFiles = 0;
      const results: Array<{ path: string }> = [];
      for (const line of stdoutLines) {
        totalFiles++;
        if (results.length < options.maxFiles) results.push({ path: line });
      }
      const truncated = totalFiles > options.maxFiles;
      const summary =
        totalFiles === 0
          ? 'No matches.'
          : truncated
            ? `Found ${totalFiles} files; showing first ${options.maxFiles} (truncated=true).`
            : `Found ${totalFiles} files.`;

      const yaml = [
        `status: ok`,
        `pattern: ${yamlQuote(parsed.pattern)}`,
        `mode: files`,
        `path: ${yamlQuote(parsed.searchPath)}`,
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
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `pattern: ${yamlQuote(parsed.pattern)}`,
          `mode: files`,
          `path: ${yamlQuote(parsed.searchPath)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const ripgrepCountTool: TellaskTool = {
  type: 'tellask',
  name: 'ripgrep_count',
  backfeeding: true,
  usageDescription: `Count matches per file (rg-backed).
Usage: !?@ripgrep_count <pattern> [path] [options]

Options:
  globs=[...]
  case=smart|sensitive|insensitive
  fixed_strings=true|false
  max_files=<n> (default: 200)
  include_hidden=true|false (default: false)
  follow_symlinks=true|false (default: false)`,
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const parsed = parseRipgrepArgs('ripgrep_count', headLine, {
      ...defaultBaseOptions(),
      maxFiles: 200,
    });
    if (!parsed.ok) {
      const content = formatYamlCodeBlock(parsed.yamlError);
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const options = parsed.options as RipgrepCountOptions;
    const args = [
      ...baseRgArgs(options, caller),
      '--count-matches',
      '--',
      parsed.pattern,
      parsed.searchPath,
    ];

    try {
      const { stdoutLines } = await runRgLines(args);
      let totalFiles = 0;
      let totalMatches = 0;
      const results: Array<{ path: string; count: number }> = [];
      for (const line of stdoutLines) {
        const idx = line.lastIndexOf(':');
        if (idx <= 0) continue;
        const p = line.slice(0, idx);
        const rawCount = line.slice(idx + 1);
        const count = Number.parseInt(rawCount, 10);
        if (!Number.isFinite(count)) continue;
        totalFiles++;
        totalMatches += count;
        if (results.length < options.maxFiles) results.push({ path: p, count });
      }
      const truncated = totalFiles > options.maxFiles;
      const summary =
        totalMatches === 0
          ? 'No matches.'
          : truncated
            ? `Counted ${totalMatches} matches in ${totalFiles} files; showing first ${options.maxFiles} files (truncated=true).`
            : `Counted ${totalMatches} matches in ${totalFiles} files.`;

      const yaml = [
        `status: ok`,
        `pattern: ${yamlQuote(parsed.pattern)}`,
        `mode: count`,
        `path: ${yamlQuote(parsed.searchPath)}`,
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
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `pattern: ${yamlQuote(parsed.pattern)}`,
          `mode: count`,
          `path: ${yamlQuote(parsed.searchPath)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const ripgrepSnippetsTool: TellaskTool = {
  type: 'tellask',
  name: 'ripgrep_snippets',
  backfeeding: true,
  usageDescription: `Search snippets with line/col (rg-backed).
Usage: !?@ripgrep_snippets <pattern> [path] [options]

Options:
  globs=[...]
  case=smart|sensitive|insensitive
  fixed_strings=true|false
  context_before=<n> (default: 1)
  context_after=<n> (default: 1)
  max_results=<n> (default: 50)
  include_hidden=true|false (default: false)
  follow_symlinks=true|false (default: false)`,
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const parsed = parseRipgrepArgs('ripgrep_snippets', headLine, {
      ...defaultBaseOptions(),
      maxResults: 50,
      contextBefore: 1,
      contextAfter: 1,
    });
    if (!parsed.ok) {
      const content = formatYamlCodeBlock(parsed.yamlError);
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
    const options = parsed.options as RipgrepSnippetsOptions;

    const args = [
      ...baseRgArgs(options, caller),
      '--vimgrep',
      '--',
      parsed.pattern,
      parsed.searchPath,
    ];

    try {
      const { stdoutLines } = await runRgLines(args);
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

      for (const line of stdoutLines) {
        totalMatches++;
        const first = line.indexOf(':');
        if (first <= 0) continue;
        const second = line.indexOf(':', first + 1);
        if (second <= first) continue;
        const third = line.indexOf(':', second + 1);
        if (third <= second) continue;
        const filePath = line.slice(0, first);
        const lineStr = line.slice(first + 1, second);
        const colStr = line.slice(second + 1, third);
        const text = line.slice(third + 1);
        const ln = Number.parseInt(lineStr, 10);
        const col = Number.parseInt(colStr, 10);
        if (!Number.isFinite(ln) || !Number.isFinite(col)) continue;
        fileSet.add(filePath);

        if (results.length >= options.maxResults) continue;
        let lines = fileCache.get(filePath);
        if (!lines) {
          lines = await loadFileLines(filePath).catch(() => []);
          fileCache.set(filePath, lines);
        }
        const idx0 = ln - 1;
        const before = lines.slice(Math.max(0, idx0 - options.contextBefore), idx0);
        const after = lines.slice(idx0 + 1, idx0 + 1 + options.contextAfter);
        results.push({ path: filePath, line: ln, col, match: text, before, after });
      }

      const truncated = totalMatches > options.maxResults;
      const summary =
        totalMatches === 0
          ? 'No matches.'
          : truncated
            ? `Showing first ${options.maxResults} of ${totalMatches} matches (truncated=true).`
            : `Found ${totalMatches} matches.`;

      const yaml = [
        `status: ok`,
        `pattern: ${yamlQuote(parsed.pattern)}`,
        `mode: snippets`,
        `path: ${yamlQuote(parsed.searchPath)}`,
        ...(options.globs.length > 0 ? [`globs: ${yamlFlowStringArray(options.globs)}`] : []),
        `case: ${options.caseMode}`,
        `fixed_strings: ${options.fixedStrings}`,
        `regex: ${!options.fixedStrings}`,
        `truncated: ${truncated}`,
        `limits:`,
        `  max_results: ${options.maxResults}`,
        `totals:`,
        `  files_matched: ${fileSet.size}`,
        `  matches: ${totalMatches}`,
        `summary: ${yamlQuote(summary)}`,
        `results:`,
        ...results.map((r) =>
          [
            `  - path: ${yamlQuote(r.path)}`,
            `    line: ${r.line}`,
            `    col: ${r.col}`,
            `    match: ${yamlQuote(r.match)}`,
            `    before: ${yamlFlowStringArray(r.before)}`,
            `    after: ${yamlFlowStringArray(r.after)}`,
          ].join('\n'),
        ),
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `pattern: ${yamlQuote(parsed.pattern)}`,
          `mode: snippets`,
          `path: ${yamlQuote(parsed.searchPath)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};

export const ripgrepFixedTool: TellaskTool = {
  type: 'tellask',
  name: 'ripgrep_fixed',
  backfeeding: true,
  usageDescription: `Fixed-string ripgrep convenience tool.
Usage: !?@ripgrep_fixed <literal> [path] [options]

Options:
  mode=files|snippets|count (default: snippets)
  globs=[...]
  case=smart|sensitive|insensitive
  max_files=<n>
  max_results=<n>
  include_hidden=true|false
  follow_symlinks=true|false`,
  async call(dlg, caller, headLine, inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@ripgrep_fixed')) {
      const content = formatYamlCodeBlock(
        `status: error\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Invalid format. Use !?@ripgrep_fixed <literal> [path] [options].'
            : 'Invalid format. Use !?@ripgrep_fixed <literal> [path] [options].',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@ripgrep_fixed'.length).trim();
    const args = splitCommandArgs(afterToolName);
    const literal = args[0] ?? '';
    if (!literal) {
      const content = formatYamlCodeBlock(
        `status: error\nerror: PATTERN_REQUIRED\nsummary: ${yamlQuote('Pattern required.')}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const second = args[1];
    const searchPath = second && !second.includes('=') ? second : '.';
    const optTokens = second && !second.includes('=') ? args.slice(2) : args.slice(1);

    let mode: 'files' | 'snippets' | 'count' = 'snippets';
    const rewrittenOpts: string[] = [];
    for (const tok of optTokens) {
      const eq = tok.indexOf('=');
      if (eq <= 0) {
        rewrittenOpts.push(tok);
        continue;
      }
      const key = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (key === 'mode' && (value === 'files' || value === 'snippets' || value === 'count')) {
        mode = value;
        continue;
      }
      rewrittenOpts.push(tok);
    }

    const forwardHeadLine = `@ripgrep_${mode} ${quoteCommandArg(literal)} ${quoteCommandArg(
      searchPath,
    )} fixed_strings=true ${rewrittenOpts.join(' ')}`.trim();
    if (mode === 'files')
      return await ripgrepFilesTool.call(dlg, caller, forwardHeadLine, inputBody);
    if (mode === 'count')
      return await ripgrepCountTool.call(dlg, caller, forwardHeadLine, inputBody);
    return await ripgrepSnippetsTool.call(dlg, caller, forwardHeadLine, inputBody);
  },
};

const DISALLOWED_RG_ARGS = new Set(['--pre', '--pre-glob']);

export const ripgrepSearchTool: TellaskTool = {
  type: 'tellask',
  name: 'ripgrep_search',
  backfeeding: true,
  usageDescription: `Escape hatch: run rg-style search (snippets output, with a limited allowlist).
Usage: !?@ripgrep_search <pattern> [path] [rg_args...]

Notes:
  - Output is normalized to YAML snippets mode.
  - Disallowed flags: --pre, --pre-glob`,
  async call(_dlg, caller, headLine, _inputBody): Promise<TellaskToolCallResult> {
    const language = getWorkLanguage();
    const trimmed = headLine.trim();
    if (!trimmed.startsWith('@ripgrep_search')) {
      const content = formatYamlCodeBlock(
        `status: error\nerror: INVALID_FORMAT\nsummary: ${yamlQuote(
          language === 'zh'
            ? 'Invalid format. Use !?@ripgrep_search <pattern> [path] [rg_args...].'
            : 'Invalid format. Use !?@ripgrep_search <pattern> [path] [rg_args...].',
        )}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }

    const afterToolName = trimmed.slice('@ripgrep_search'.length).trim();
    const args = splitCommandArgs(afterToolName);
    const pattern = args[0] ?? '';
    if (!pattern) {
      const content = formatYamlCodeBlock(
        `status: error\nerror: PATTERN_REQUIRED\nsummary: ${yamlQuote('Pattern required.')}`,
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
    const second = args[1];
    const searchPath = second && !second.startsWith('-') ? second : '.';
    const rawRgArgs = second && !second.startsWith('-') ? args.slice(2) : args.slice(1);

    for (const tok of rawRgArgs) {
      if (DISALLOWED_RG_ARGS.has(tok)) {
        const content = formatYamlCodeBlock(
          `status: error\nerror: DISALLOWED_ARG\nsummary: ${yamlQuote(`Disallowed rg arg: ${tok}`)}`,
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
      }
      if (
        tok === '--json' ||
        tok === '--count' ||
        tok === '--count-matches' ||
        tok === '--files-with-matches' ||
        tok === '--files'
      ) {
        const content = formatYamlCodeBlock(
          `status: error\nerror: DISALLOWED_ARG\nsummary: ${yamlQuote(`Disallowed rg output arg: ${tok}`)}`,
        );
        return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
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
      const { stdoutLines } = await runRgLines(rgArgs);
      let totalMatches = 0;
      const fileSet = new Set<string>();
      const results: Array<{ path: string; line: number; col: number; match: string }> = [];
      for (const line of stdoutLines) {
        totalMatches++;
        const first = line.indexOf(':');
        if (first <= 0) continue;
        const secondColon = line.indexOf(':', first + 1);
        if (secondColon <= first) continue;
        const thirdColon = line.indexOf(':', secondColon + 1);
        if (thirdColon <= secondColon) continue;
        const filePath = line.slice(0, first);
        const lineStr = line.slice(first + 1, secondColon);
        const colStr = line.slice(secondColon + 1, thirdColon);
        const text = line.slice(thirdColon + 1);
        const ln = Number.parseInt(lineStr, 10);
        const col = Number.parseInt(colStr, 10);
        if (!Number.isFinite(ln) || !Number.isFinite(col)) continue;
        fileSet.add(filePath);
        if (results.length < options.maxResults)
          results.push({ path: filePath, line: ln, col, match: text });
      }

      const truncated = totalMatches > options.maxResults;
      const summary =
        totalMatches === 0
          ? 'No matches.'
          : truncated
            ? `Showing first ${options.maxResults} of ${totalMatches} matches (truncated=true).`
            : `Found ${totalMatches} matches.`;

      const yaml = [
        `status: ok`,
        `pattern: ${yamlQuote(pattern)}`,
        `mode: snippets`,
        `path: ${yamlQuote(searchPath)}`,
        `case: smart`,
        `fixed_strings: false`,
        `regex: true`,
        `truncated: ${truncated}`,
        `limits:`,
        `  max_results: ${options.maxResults}`,
        `totals:`,
        `  files_matched: ${fileSet.size}`,
        `  matches: ${totalMatches}`,
        `summary: ${yamlQuote(summary)}`,
        `results:`,
        ...results.map((r) =>
          [
            `  - path: ${yamlQuote(r.path)}`,
            `    line: ${r.line}`,
            `    col: ${r.col}`,
            `    match: ${yamlQuote(r.match)}`,
          ].join('\n'),
        ),
      ].join('\n');
      const content = formatYamlCodeBlock(yaml);
      return ok(content, [{ type: 'environment_msg', role: 'user', content }]);
    } catch (error: unknown) {
      const content = formatYamlCodeBlock(
        [
          `status: error`,
          `pattern: ${yamlQuote(pattern)}`,
          `mode: snippets`,
          `path: ${yamlQuote(searchPath)}`,
          `error: FAILED`,
          `summary: ${yamlQuote(error instanceof Error ? error.message : String(error))}`,
        ].join('\n'),
      );
      return failed(content, [{ type: 'environment_msg', role: 'user', content }]);
    }
  },
};
