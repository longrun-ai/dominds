export function markdownQuote(lines: string): string {
  return lines
    .split('\n')
    .map((line: string) => `> ${line}`)
    .join('\n');
}
