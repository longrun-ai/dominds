/**
 * Setup env inputs hold the runtime value, not the shell/dotenv literal.
 *
 * Paste-time normalization handles the common copied sources:
 * - shell rc / dotenv snippets: `"sk-..."`, `'sk-...'`, `"C:\\Users\\A"`
 * - Windows Explorer paths: `"C:\Users\A"`, `"\\server\share"`
 *
 * Only the paste layer does this. The backend write API intentionally assumes it receives the
 * already-normalized runtime value and only serializes that value to dotenv/shell syntax.
 */
export function normalizeSetupEnvValueInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 2) return input;

  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return input;
  if (!trimmed.endsWith(quote)) return input;

  const inner = trimmed.slice(1, -1);
  if (inner.includes('\n') || inner.includes('\r')) return input;

  if (quote === '"') {
    if (isRawWindowsPath(inner)) return inner;
    return unquoteDoubleQuotedSetupEnvValue(inner);
  }

  return inner;
}

function isRawWindowsPath(value: string): boolean {
  // Explorer copies raw path separators. Do not treat the leading `\\` of a UNC path as an escape.
  if (/^[A-Za-z]:[\\/](?![\\/])/.test(value)) return true;
  return /^\\\\[^\\/]/.test(value);
}

function unquoteDoubleQuotedSetupEnvValue(value: string): string {
  // Keep this intentionally smaller than a full dotenv parser: setup inputs are single-line keys
  // and paths, so only unwrap syntax escapes. Do not turn `\n` into a real newline on paste.
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

    if (next === '"' || next === '\\' || next === '$' || next === '`') {
      out += next;
      i++;
      continue;
    }

    out += ch;
  }
  return out;
}
