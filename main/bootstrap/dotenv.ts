import * as fs from 'fs';
import * as path from 'path';

type ParseResult =
  | Readonly<{ kind: 'skip' }>
  | Readonly<{ kind: 'error'; reason: 'missing_equals' | 'empty_key' | 'invalid_key' }>
  | Readonly<{ kind: 'entry'; key: string; value: string }>;

function isEnvKeyValid(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function unescapeDoubleQuoted(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += '\\';
      continue;
    }
    i++;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === '\\') out += '\\';
    else if (next === '"') out += '"';
    else out += next;
  }
  return out;
}

function stripInlineCommentFromUnquotedValue(raw: string): string {
  // Strip `# ...` only when it is preceded by whitespace.
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '#') continue;
    if (i === 0) return '';
    const prev = raw[i - 1];
    if (prev === ' ' || prev === '\t') return raw.slice(0, i).trimEnd();
  }
  return raw.trimEnd();
}

function parseLine(line: string): ParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'skip' };
  if (trimmed.startsWith('#')) return { kind: 'skip' };

  const withoutExport = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trim()
    : trimmed;

  const equalsIndex = withoutExport.indexOf('=');
  if (equalsIndex < 0) return { kind: 'error', reason: 'missing_equals' };

  const rawKey = withoutExport.slice(0, equalsIndex).trim();
  if (rawKey.length === 0) return { kind: 'error', reason: 'empty_key' };
  if (!isEnvKeyValid(rawKey)) return { kind: 'error', reason: 'invalid_key' };

  let rawValue = withoutExport.slice(equalsIndex + 1).trim();
  if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
    rawValue = unescapeDoubleQuoted(rawValue.slice(1, -1));
  } else if (rawValue.length >= 2 && rawValue.startsWith("'") && rawValue.endsWith("'")) {
    rawValue = rawValue.slice(1, -1);
  } else {
    rawValue = stripInlineCommentFromUnquotedValue(rawValue);
  }

  return { kind: 'entry', key: rawKey, value: rawValue };
}

export type DotenvLoadResult = Readonly<{
  cwd: string;
  loadedFiles: ReadonlyArray<'.env' | '.env.local'>;
  errors: ReadonlyArray<
    Readonly<{
      file: '.env' | '.env.local';
      lineNumber: number;
      raw: string;
      reason: 'missing_equals' | 'empty_key' | 'invalid_key';
    }>
  >;
}>;

export function loadRtwsDotenv(params?: Readonly<{ cwd?: string }>): DotenvLoadResult {
  const cwd = params && typeof params.cwd === 'string' ? params.cwd : process.cwd();

  const files: ReadonlyArray<'.env' | '.env.local'> = ['.env', '.env.local'];
  const loadedFiles: Array<'.env' | '.env.local'> = [];
  const errors: Array<{
    file: '.env' | '.env.local';
    lineNumber: number;
    raw: string;
    reason: 'missing_equals' | 'empty_key' | 'invalid_key';
  }> = [];

  for (const file of files) {
    const absPath = path.join(cwd, file);
    if (!fs.existsSync(absPath)) continue;
    loadedFiles.push(file);

    const content = fs.readFileSync(absPath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const parsed = parseLine(raw);
      if (parsed.kind === 'skip') continue;
      if (parsed.kind === 'error') {
        errors.push({ file, lineNumber: i + 1, raw, reason: parsed.reason });
        continue;
      }
      if (parsed.kind === 'entry') {
        process.env[parsed.key] = parsed.value;
        continue;
      }
      const _exhaustive: never = parsed;
      throw new Error(`Unexpected dotenv parse result: ${String(_exhaustive)}`);
    }
  }

  return { cwd, loadedFiles, errors };
}
