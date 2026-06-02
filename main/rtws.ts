/**
 * rtws (runtime workspace) root helpers.
 *
 * Dominds treats the backend process cwd as the rtws root for the process lifetime.
 */
export function domindsRtwsRootAbs(): string {
  return process.cwd();
}
