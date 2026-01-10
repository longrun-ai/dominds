export function base64UrlEncode(input: Uint8Array): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Buffer {
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = normalized.length % 4;
  if (padLength !== 0) {
    normalized += '='.repeat(4 - padLength);
  }
  return Buffer.from(normalized, 'base64');
}
