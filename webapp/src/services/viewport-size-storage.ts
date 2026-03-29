export type ViewportScopedRectSize = {
  widthPx: number;
  heightPx: number;
};

function getViewportBucketKey(): string {
  return `${Math.floor(window.innerWidth)}x${Math.floor(window.innerHeight)}`;
}

function getViewportScopedStorageKey(baseKey: string): string {
  return `${baseKey}:${getViewportBucketKey()}`;
}

function parseStoredPositiveInteger(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  const asInt = Math.floor(parsed);
  if (asInt <= 0) return null;
  return asInt;
}

export function loadViewportScopedNumber(baseKey: string): number | null {
  try {
    return parseStoredPositiveInteger(localStorage.getItem(getViewportScopedStorageKey(baseKey)));
  } catch (error: unknown) {
    console.warn(`Failed to read viewport-scoped number for '${baseKey}' from localStorage`, error);
    return null;
  }
}

export function saveViewportScopedNumber(baseKey: string, value: number): void {
  try {
    localStorage.setItem(getViewportScopedStorageKey(baseKey), String(Math.floor(value)));
  } catch (error: unknown) {
    console.warn(
      `Failed to persist viewport-scoped number for '${baseKey}' to localStorage`,
      error,
    );
  }
}

export function loadViewportScopedRectSize(baseKey: string): ViewportScopedRectSize | null {
  try {
    const raw = localStorage.getItem(getViewportScopedStorageKey(baseKey));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const widthPx = parseStoredPositiveInteger(
      typeof record.widthPx === 'number' ? String(record.widthPx) : null,
    );
    const heightPx = parseStoredPositiveInteger(
      typeof record.heightPx === 'number' ? String(record.heightPx) : null,
    );
    if (widthPx === null || heightPx === null) return null;
    return { widthPx, heightPx };
  } catch (error: unknown) {
    console.warn(
      `Failed to read viewport-scoped rect size for '${baseKey}' from localStorage`,
      error,
    );
    return null;
  }
}

export function saveViewportScopedRectSize(baseKey: string, size: ViewportScopedRectSize): void {
  try {
    const payload: ViewportScopedRectSize = {
      widthPx: Math.floor(size.widthPx),
      heightPx: Math.floor(size.heightPx),
    };
    localStorage.setItem(getViewportScopedStorageKey(baseKey), JSON.stringify(payload));
  } catch (error: unknown) {
    console.warn(
      `Failed to persist viewport-scoped rect size for '${baseKey}' to localStorage`,
      error,
    );
  }
}
