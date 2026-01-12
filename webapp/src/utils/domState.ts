/**
 * DOM State Management Utilities
 *
 * These utilities help manage state that has been moved from the Redux store
 * to DOM data attributes, serving as the single source of truth for UI state.
 */

/**
 * Get data attribute value from element
 */
export function getDomData(element: Element, key: string): string | null {
  return element.getAttribute(`data-${key}`);
}

/**
 * Set data attribute value on element
 */
export function setDomData(element: Element, key: string, value: string): void {
  element.setAttribute(`data-${key}`, value);
}

/**
 * Remove data attribute from element
 */
export function removeDomData(element: Element, key: string): void {
  element.removeAttribute(`data-${key}`);
}

/**
 * Get JSON data attribute and parse it
 */
export function getDomDataJson<T>(element: Element, key: string, defaultValue: T): T {
  const value = getDomData(element, key);
  if (value === null) return defaultValue;

  try {
    return JSON.parse(value);
  } catch {
    console.warn('Failed to parse JSON data attribute, returning default');
    return defaultValue;
  }
}

/**
 * Set JSON data attribute with stringified value
 */
export function setDomDataJson<T>(element: Element, key: string, value: T): void {
  setDomData(element, key, JSON.stringify(value));
}

/**
 * UI State Keys that should be stored in DOM data attributes
 */
export const DOM_STATE_KEYS = {
  SIDEBAR_OPEN: 'sidebar-open',
  SEARCH_QUERY: 'search-query',
  FILTERS: 'filters',
  CURRENT_DIALOG_ID: 'current-dialog-id',
  CURRENT_ROOT_DIALOG_ID: 'current-root-dialog-id',
  THEME: 'theme',
} as const;

/**
 * Get sidebar open state from DOM
 */
export function getSidebarOpen(element: Element = document.body): boolean {
  return getDomData(element, DOM_STATE_KEYS.SIDEBAR_OPEN) === 'true';
}

/**
 * Set sidebar open state in DOM
 */
export function setSidebarOpen(open: boolean, element: Element = document.body): void {
  setDomData(element, DOM_STATE_KEYS.SIDEBAR_OPEN, open.toString());
}

/**
 * Get search query from DOM
 */
export function getSearchQuery(element: Element = document.body): string {
  return getDomData(element, DOM_STATE_KEYS.SEARCH_QUERY) || '';
}

/**
 * Set search query in DOM
 */
export function setSearchQuery(query: string, element: Element = document.body): void {
  setDomData(element, DOM_STATE_KEYS.SEARCH_QUERY, query);
}

/**
 * Get filters from DOM
 */
export function getFilters(element: Element = document.body) {
  return getDomDataJson(element, DOM_STATE_KEYS.FILTERS, {});
}

/**
 * Set filters in DOM
 */
export function setFilters(filters: any, element: Element = document.body): void {
  setDomDataJson(element, DOM_STATE_KEYS.FILTERS, filters);
}

/**
 * Get current dialog ID from DOM
 */
export function getCurrentDialogId(element: Element = document.body): string | null {
  return getDomData(element, DOM_STATE_KEYS.CURRENT_DIALOG_ID);
}

/**
 * Set current dialog ID in DOM
 */
export function setCurrentDialogId(
  dialogId: string | null,
  element: Element = document.body,
): void {
  if (dialogId) {
    setDomData(element, DOM_STATE_KEYS.CURRENT_DIALOG_ID, dialogId);
  } else {
    removeDomData(element, DOM_STATE_KEYS.CURRENT_DIALOG_ID);
  }
}

/**
 * Get current root dialog ID from DOM
 */
export function getCurrentRootDialogId(element: Element = document.body): string | null {
  return getDomData(element, DOM_STATE_KEYS.CURRENT_ROOT_DIALOG_ID);
}

/**
 * Set current root dialog ID in DOM
 */
export function setCurrentRootDialogId(
  rootDialogId: string | null,
  element: Element = document.body,
): void {
  if (rootDialogId) {
    setDomData(element, DOM_STATE_KEYS.CURRENT_ROOT_DIALOG_ID, rootDialogId);
  } else {
    removeDomData(element, DOM_STATE_KEYS.CURRENT_ROOT_DIALOG_ID);
  }
}

/**
 * Get theme from DOM
 */
export function getTheme(element: Element = document.documentElement): 'light' | 'dark' | 'auto' {
  const theme = getDomData(element, DOM_STATE_KEYS.THEME);
  return (theme as 'light' | 'dark' | 'auto') || 'auto';
}

/**
 * Set theme in DOM
 */
export function setTheme(
  theme: 'light' | 'dark' | 'auto',
  element: Element = document.documentElement,
): void {
  setDomData(element, DOM_STATE_KEYS.THEME, theme);
}
