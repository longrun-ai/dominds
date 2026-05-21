export function setProcessTitle(title: string): void {
  const normalizedTitle = title.trim();
  if (normalizedTitle === '') return;
  process.title = normalizedTitle;
}

export function setRtwsProcessTitle(rtwsRootAbs: string = process.cwd()): void {
  setProcessTitle(`Dominds: ${rtwsRootAbs}`);
}
