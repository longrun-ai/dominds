/**
 * E2E Test Helper - DEFINITIVE IMPLEMENTATIONS
 * Source: dominds-app.tsx, running-dialog-list.ts, dominds-dialog-container.ts, dominds-q4h-input.ts
 *
 * PRINCIPLE: Use component public methods where available, otherwise use exact ID-based selectors.
 */

// ============================================
// SELECTORS - DEFINITIVE
// ============================================

const sel = {
  // App root
  app: 'dominds-app',

  // Q4H Input component (dominds-q4h-input.ts)
  q4hInputHost: 'dominds-q4h-input',
  textarea: '.message-input',
  sendBtn: '.send-button',

  // Dialog container (dominds-dialog-container.ts)
  dialogHost: '#dialog-container',
  userMsg: '.generation-bubble[data-user-msg-id]',
  genBubble: '.generation-bubble',
  genCompleted: '.generation-bubble.completed',
  genNotCompleted: '.generation-bubble:not(.completed)',
  teammateBubble: '.message.teammate',
  teammateContent: '.teammate-content',
  teammateLabel: '.teammate-label',
  teammateHeadline: '.teammate-headline',
  teammateDivider: '.teammate-response-divider',
  teammateIndicator: '.response-indicator',
  markdownSection: 'dominds-markdown-section',
  markdownContent: '.markdown-content',
  author: '.bubble-author, .author',
  thinkingCompleted: '.thinking-section.completed',
  markdownCompleted: '.markdown-section.completed',
  markdownContent: '.markdown-content',
  codeSection: '.codeblock-section',
  codeCompleted: '.codeblock-section.completed',
  codeTitle: '.codeblock-title',
  codeContent: '.codeblock-content',

  // Dialog creation (dominds-app.tsx)
  newDialogBtn: '#new-dialog-btn',
  teammateSelect: '#teammate-select',
  taskDocInput: '#task-doc-input',
  createBtn: '#create-dialog-btn',
  dialogModal: '.create-dialog-modal',

  // Dialog list (running-dialog-list.ts)
  sidebar: '.sidebar',
  dialogList: 'running-dialog-list',
  dialogListContainer: '#dialog-list',
  dialogItem: '.dialog-item',

  // Reminders widget (dominds-app.tsx)
  remindersToggle: '#toolbar-reminders-toggle',
  remindersWidget: '#reminders-widget',
  remindersContent: '#reminders-widget-content',
  remindersClose: '#reminders-widget-close',

  // Q4H panel (dominds-app.tsx)
  q4hPanel: '.q4h-panel-container',
  q4hToggleBar: '.q4h-toggle-bar',
  q4hResizeHandle: '.q4h-resize-handle',
  q4hContent: '.q4h-content',
  q4hBadge: '.q4h-badge',
  q4hPanelHost: 'dominds-q4h-panel',
  q4hGoToSiteBtn: '.q4h-goto-site-btn',
};

// ============================================
// Load DOM Observation Utilities (REQUIRED)
// ============================================

let domObs = null;
if (typeof window !== 'undefined' && typeof window.__domObservation__ === 'object') {
  domObs = window.__domObservation__;
} else {
  throw new Error('dom-observation-utils.js must be loaded before e2e-test-helper.js');
}

// ============================================
// Console Error Tracking
// ============================================

let __consoleErrors__ = [];

// Known non-critical protocol error patterns to ignore
const IGNORED_ERROR_PATTERNS = [
  // Tool call events (renamed from call_* to tool_call_*)
  'tool_call_headline_chunk_evt',
  'tool_call_body_start_evt',
  'tool_call_finish_evt',
  'tool_call_start_evt',
  'tool_call_finish_evt',
  // Teammate call events
  'teammate_call_headline_chunk_evt',
  'teammate_call_body_start_evt',
  'teammate_call_finish_evt',
  'teammate_call_start_evt',
  'teammate_call_finish_evt',
];

// Console error interceptor
(function () {
  const originalError = console.error.bind(console);
  console.error = function (...args) {
    __consoleErrors__.push({
      timestamp: Date.now(),
      message: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
    });
    originalError.apply(console, args);
  };
})();

/**
 * Checks for console errors and optionally clears them.
 * @param {Object} options - Options object
 * @param {boolean} [options.clear=true] - Whether to clear errors after checking
 * @param {number} [options.threshold=0] - Maximum allowed errors before throwing
 * @returns {Array<{timestamp: number, message: string}>} The collected errors
 * @throws {Error} If error count exceeds threshold
 */
function checkConsoleErrors(options = {}) {
  const { clear = true, threshold = 0 } = options;

  // Filter out known non-critical protocol errors
  const filteredErrors = __consoleErrors__.filter((error) => {
    const message = error.message;
    return !IGNORED_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
  });

  const errors = [...filteredErrors];
  if (clear) __consoleErrors__ = [];
  if (errors.length > threshold) {
    throw new Error(
      `Console errors detected (${errors.length}):\n` +
        errors.map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.message}`).join('\n'),
    );
  }
  return errors;
}

// ============================================
// Shadow DOM Accessors
// ============================================

function getAppShadow() {
  const app = document.querySelector(sel.app);
  return app && app.shadowRoot ? app.shadowRoot : null;
}

function getApp() {
  return document.querySelector(sel.app);
}

function getInputArea() {
  return document.querySelector('dominds-app')?.shadowRoot?.querySelector('dominds-q4h-input');
}

/**
 * Waits for a dialog to be selected and ready for input.
 * The input is NOT usable when no dialog is selected (common E2E state).
 * MUST be called before every fillAndSend() to prevent failures.
 * @param {number} [maxRetries=15] - Maximum retry attempts
 * @param {number} [delayMs=300] - Delay between retries in milliseconds
 * @returns {Promise<boolean>} True when input is ready
 * @throws {Error} If input is not ready after max retries
 */
async function waitForInputEnabled(maxRetries = 15, delayMs = 300) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const app = getApp();
    if (!app) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const inputArea = getInputArea();
    if (!inputArea || !inputArea.shadowRoot) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const textarea = inputArea.shadowRoot.querySelector('.message-input');
    if (!textarea) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    // Check if input is usable - textarea must be visible and interactive
    const isVisible = textarea.offsetParent !== null;
    const hasValue = textarea.value !== undefined;
    const isEditable = !textarea.disabled && !textarea.readOnly;

    // Also verify a dialog is selected (check app state)
    const hasCurrentDialog = app.getCurrentDialogInfo?.() !== null;

    if (isVisible && hasValue && isEditable && hasCurrentDialog) {
      return true;
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Input not ready after ${maxRetries} attempts - no dialog selected or dialog not loaded`,
  );
}

function getDialogContainer() {
  return document.querySelector('dominds-app')?.shadowRoot?.querySelector('#dialog-container');
}

function getDialogList() {
  return document.querySelector('dominds-app')?.shadowRoot?.querySelector('running-dialog-list');
}

function getDialogListShadow() {
  const dialogList = getDialogList();
  return dialogList && dialogList.shadowRoot ? dialogList.shadowRoot : null;
}

function getMessageContainer() {
  const dialogContainer = getDialogContainer();
  if (!dialogContainer || !dialogContainer.shadowRoot) return null;
  return dialogContainer.shadowRoot.querySelector('.messages');
}

function getTeammateMessages() {
  const container = getMessageContainer();
  if (!container) return [];
  return Array.from(container.querySelectorAll('.message.teammate'));
}

function getTeammateMessageCount() {
  return getTeammateMessages().length;
}

function getTeammateResponseDetails() {
  return getTeammateMessages().map((node, index) => {
    const authorName =
      node.querySelector('.author-name')?.textContent?.trim() ||
      node.querySelector('.author')?.textContent?.trim() ||
      '';
    if (!authorName) {
      throw new Error('getTeammateResponseDetails: Missing teammate author name');
    }
    const responseIndicator = node.querySelector(sel.teammateIndicator)?.textContent?.trim() || '';
    if (!responseIndicator || !responseIndicator.includes('→')) {
      throw new Error(
        `getTeammateResponseDetails: Unexpected response indicator "${responseIndicator}"`,
      );
    }
    const requesterLabel = responseIndicator.split('→')[1]?.trim() || '';
    if (!requesterLabel) {
      throw new Error('getTeammateResponseDetails: Missing requester label in response indicator');
    }
    const bubbleHeadLine = node.querySelector(sel.teammateHeadline)?.textContent?.trim() || '';
    const callSiteId = parseCallSiteId(node.getAttribute('data-call-site-id'));
    const callId = node.getAttribute('data-call-id') || '';
    const calleeDialogId = node.getAttribute('data-callee-dialog-id') || '';
    const markdownSection = node.querySelector(sel.markdownSection);
    const markdownContent = markdownSection?.querySelector(sel.markdownContent);
    const rawMarkdown = markdownContent?.getAttribute('data-raw-md') || '';
    const renderedText = markdownContent?.innerText?.trim() || '';
    if (!rawMarkdown.trim()) {
      throw new Error('getTeammateResponseDetails: Missing response markdown content');
    }
    const rawLines = rawMarkdown.split('\n');
    let narrativeIndex = -1;
    for (let i = 0; i < rawLines.length; i += 1) {
      if (rawLines[i].trim() !== '') {
        narrativeIndex = i;
        break;
      }
    }
    if (narrativeIndex < 0) {
      throw new Error('getTeammateResponseDetails: Missing narrative line');
    }
    const narrativeLine = rawLines[narrativeIndex].trim();
    if (!narrativeLine.startsWith('Hi @') || !narrativeLine.includes('provided response')) {
      throw new Error(
        `getTeammateResponseDetails: Narrative line malformed "${narrativeLine}"`,
      );
    }
    const originalCallMarker = 'to your original call:';
    const markerIndex = rawLines.findIndex((line) => line.trim() === originalCallMarker);
    if (markerIndex < 0) {
      throw new Error('getTeammateResponseDetails: Missing original call marker');
    }
    const stripQuotePrefix = (line) => (line.startsWith('> ') ? line.slice(2) : line);
    const responseLines = rawLines
      .slice(narrativeIndex + 1, markerIndex)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .map((line) => stripQuotePrefix(line.trim()));
    if (responseLines.length === 0) {
      throw new Error('getTeammateResponseDetails: Missing response body section');
    }
    const responseBody = responseLines.join('\n');
    const callLines = rawLines
      .slice(markerIndex + 1)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .map((line) => stripQuotePrefix(line.trim()));
    const callHeadLine = callLines.join('\n').trim() || bubbleHeadLine;
    return {
      index,
      authorName,
      responseIndicator,
      requesterLabel,
      bubbleHeadLine,
      callHeadLine,
      narrativeLine,
      responseBody,
      rawMarkdown,
      renderedText,
      callSiteId,
      callId,
      calleeDialogId,
    };
  });
}

function getLatestTeammateResponseDetails() {
  const all = getTeammateResponseDetails();
  return all.length > 0 ? all[all.length - 1] : null;
}

function getVisibleMessageNodes() {
  const container = getMessageContainer();
  if (!container) return [];
  return Array.from(container.children);
}

function getVisibleMessageTexts() {
  return getVisibleMessageNodes()
    .map((node) => (node.textContent || '').trim())
    .filter((text) => text.length > 0);
}

function findVisibleMessageContainingAll(needles, options = {}) {
  const list = Array.isArray(needles) ? needles : [needles];
  const caseInsensitive = options.caseInsensitive === true;
  const normalizedNeedles = list.map((n) =>
    caseInsensitive ? String(n).toLowerCase() : String(n),
  );
  const nodes = getVisibleMessageNodes();
  for (let i = 0; i < nodes.length; i++) {
    const text = (nodes[i].textContent || '').trim();
    if (!text) continue;
    const haystack = caseInsensitive ? text.toLowerCase() : text;
    const matchesAll = normalizedNeedles.every((needle) => haystack.includes(needle));
    if (matchesAll) {
      return { index: i, text };
    }
  }
  return null;
}

// ============================================
// Utility
// ============================================

async function waitUntil(fn, timeoutMs = 15000, intervalMs = 100) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fn()) return resolve(true);
      } catch (err) {
        console.warn('Oops!', err);
      }
      if (Date.now() - start >= timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function isElementVisible(el) {
  return !!(el && el.offsetParent !== null);
}

function escapeCssValue(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(String(value));
  }
  return String(value).replace(/["\\]/g, '\\$&');
}

// ============================================
// Core Messaging Functions
// ============================================

/**
 * Sends a message via the input area component.
 * Source: dominds-q4h-input.ts
 * Component methods: setValue(), sendMessage()
 * @throws {Error} If input is disabled or no dialog is selected
 */
async function fillAndSend(message) {
  const app = getApp();
  const inputArea = getInputArea();

  if (!inputArea || !inputArea.shadowRoot) {
    throw new Error('dominds-q4h-input not found');
  }

  const textarea = inputArea.shadowRoot.querySelector('.message-input');
  if (!textarea) {
    throw new Error('Input textarea not found');
  }

  // Check if input is usable
  const isDisabled = textarea.disabled || textarea.readOnly;
  const hasCurrentDialog = app?.getCurrentDialogInfo?.() !== null;

  if (isDisabled || !hasCurrentDialog) {
    throw new Error(
      `Input is disabled - no dialog selected or dialog not loaded. ` +
        `Use createDialog() first, or selectDialog() to load an existing dialog. ` +
        `Did you forget to call waitForInputEnabled() before fillAndSend()?`,
    );
  }

  if (typeof inputArea.setValue !== 'function') {
    throw new Error('Input area does not have setValue method');
  }
  if (typeof inputArea.sendMessage !== 'function') {
    throw new Error('Input area does not have sendMessage method');
  }

  inputArea.setValue(message);
  const result = await inputArea.sendMessage();

  if (!result.success) {
    throw new Error(result.error || 'sendMessage failed');
  }

  checkConsoleErrors({ threshold: 0 });
  return result.msgId;
}

/**
 * Wait for the generation bubble to complete.
 * Source: dominds-dialog-container.ts lines 414-461, 1380
 * Completion indicator: generation-bubble has .completed class
 */
async function waitStreamingComplete(msgId, timeoutMs = 60000) {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  if (!shadow) return false;

  const result = await waitUntil(() => {
    // First check user message bubble completion
    const userMsg = shadow.querySelector(`.user-message[data-user-msg-id="${msgId}"]`);
    if (userMsg) {
      const bubble = userMsg.closest('.generation-bubble');
      if (bubble && bubble.classList.contains('completed')) {
        return true;
      }
    }
    const userBubble = shadow.querySelector(`.generation-bubble[data-user-msg-id="${msgId}"]`);
    if (userBubble && userBubble.classList.contains('completed')) {
      return true;
    }

    // Fallback: check for any completed bubble with no incomplete ones
    const completedBubble = shadow.querySelector(sel.genCompleted);
    if (completedBubble) {
      const incomplete = shadow.querySelectorAll(sel.genNotCompleted);
      if (incomplete.length === 0) {
        return true;
      }
    }

    return false;
  }, timeoutMs);

  checkConsoleErrors({ threshold: 0 });
  return result;
}

/**
 * Gets the latest user message text.
 * Source: dominds-dialog-container.ts line 1414
 */
function latestUserText() {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  if (!shadow) return '';

  const nodes = Array.from(shadow.querySelectorAll(sel.userMsg));
  const n = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  if (!n) {
    return '';
  }
  const raw = n.getAttribute ? n.getAttribute('data-raw-user-msg') : null;
  if (raw) {
    return raw.trim();
  }
  if (n.classList?.contains('generation-bubble')) {
    const body = n.querySelector('.bubble-body');
    if (!body) return '';
    const parts = [];
    for (const child of Array.from(body.children)) {
      if (child.classList.contains('user-response-divider')) {
        break;
      }
      const text = child.textContent?.trim() || '';
      if (text) {
        parts.push(text);
      }
    }
    return parts.join('\n').trim();
  }
  return (n.textContent || '').trim();
}

/**
 * Checks if all bubbles are complete.
 * Source: dominds-dialog-container.ts lines 451-452
 */
function noLingering() {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  if (!shadow) return true;
  return shadow.querySelectorAll(sel.genNotCompleted).length === 0;
}

/**
 * Returns counts of messages and bubbles.
 * Source: dominds-dialog-container.ts
 */
function counts() {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  if (!shadow) return { userCount: 0, bubbleCount: 0, incompleteCount: 0 };

  return {
    userCount: shadow.querySelectorAll(sel.userMsg).length,
    bubbleCount: shadow.querySelectorAll(sel.genBubble).length,
    incompleteCount: shadow.querySelectorAll(sel.genNotCompleted).length,
  };
}

/**
 * Gets the latest assistant bubble element.
 * Source: dominds-dialog-container.ts line 1348
 */
function latestBubble() {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  if (!shadow) return null;

  const list = Array.from(shadow.querySelectorAll(sel.genBubble));
  return list.length > 0 ? list[list.length - 1] : null;
}

// ============================================
// DomindsUI Class - UI State Snapshot
// ============================================

/**
 * DomindsUI represents a snapshot of the Dominds application state.
 * The tester agent observes these instances and compares them using reportDeltaTo().
 */
class DomindsUI {
  constructor(data) {
    this.timestamp = data.timestamp;
    this.appExists = data.appExists;
    this.shadowExists = data.shadowExists;

    // 1. HEADER region
    this.header = data.header;

    // 2. SIDEBAR / DIALOG LIST
    this.sidebar = data.sidebar;

    // 3. CURRENT DIALOG INFO (toolbar area)
    this.currentDialog = data.currentDialog;

    // 4. CHAT AREA / MESSAGES
    this.chat = data.chat;

    // 5. INPUT AREA
    this.input = data.input;

    // 6. Q4H PANEL
    this.q4h = data.q4h;

    // 7. REMINDERS WIDGET
    this.reminders = data.reminders;

    // 8. MODALS
    this.modals = data.modals;

    // 9. CONNECTION STATUS
    this.connection = data.connection;

    // 10. TOASTS (if any)
    this.toasts = data.toasts;
  }

  /**
   * Report the delta between this snapshot and a previous one.
   * @param {DomindsUI} prev - Previous UI snapshot to compare against
   * @returns {string} Human-readable delta report
   */
  reportDeltaTo(prev) {
    if (!prev) {
      return formatFullState(this);
    }

    const delta = computeDeltaForClass(prev, this);
    if (delta.changes.length === 0) {
      return `=== UI STATE (NO CHANGES) ===
${formatFullState(this)}`;
    }

    const changeLines = delta.changes.map((c) => {
      if (c.path === 'currentDialog.title') {
        return `  • Dialog title: "${c.previous}" → "${c.current}"`;
      }
      if (c.path === 'chat.messageCount') {
        return `  • Messages: ${c.previous} → ${c.current}`;
      }
      if (c.path === 'chat.visibleMessageCount') {
        return `  • Visible messages: ${c.previous} → ${c.current}`;
      }
      if (c.path === 'q4h.count') {
        return `  • Q4H questions: ${c.previous} → ${c.current}`;
      }
      if (c.path === 'reminders.count') {
        return `  • Reminders: ${c.previous} → ${c.current}`;
      }
      if (c.path === 'sidebar.dialogListLoaded') {
        return `  • Sidebar list: ${c.current ? 'loaded' : 'missing'}`;
      }
      if (c.path === 'sidebar.dialogCount') {
        return `  • Sidebar dialogs: ${c.previous} → ${c.current}`;
      }
      if (c.path === 'sidebar.taskGroupCount') {
        return `  • Sidebar tasks: ${c.previous} → ${c.current}`;
      }
      if (c.path === 'sidebar.visibleNodeTitles') {
        return `  • Sidebar visible: ${summarizeListDelta(c.previous, c.current)}`;
      }
      if (c.path === 'sidebar.selectedDialogTitle') {
        return `  • Sidebar selection: "${c.previous || ''}" → "${c.current || ''}"`;
      }
      if (c.path === 'modals.anyModalVisible') {
        return `  • Modal: ${c.current ? 'OPENED' : 'CLOSED'}`;
      }
      if (c.path === 'connection.connected') {
        return `  • Connection: ${c.current ? 'Connected' : 'Disconnected'}`;
      }
      return `  • ${c.path}: ${JSON.stringify(c.previous)} → ${JSON.stringify(c.current)}`;
    });

    return `=== UI STATE CHANGED (${delta.changes.length} change${delta.changes.length > 1 ? 's' : ''}) ===
${changeLines.join('\n')}

=== CURRENT STATE ===
${formatFullState(this)}`;
  }
}

/**
 * Takes a comprehensive snapshot of the Dominds UI state.
 * Returns a DomindsUI instance for observation and delta comparison.
 *
 * @returns {DomindsUI} UI state snapshot
 */
function snapshotDomindsUI() {
  const app = getApp();
  const shadow = getAppShadow();

  // Capture all UI state
  const data = {
    timestamp: Date.now(),
    appExists: !!app,
    shadowExists: !!shadow,

    // 1. HEADER region
    header: captureHeaderState(shadow),

    // 2. SIDEBAR / DIALOG LIST
    sidebar: captureSidebarState(shadow),

    // 3. CURRENT DIALOG INFO (toolbar area)
    currentDialog: captureCurrentDialogState(shadow, app),

    // 4. CHAT AREA / MESSAGES
    chat: captureChatState(shadow),

    // 5. INPUT AREA
    input: captureInputState(shadow),

    // 6. Q4H PANEL
    q4h: captureQ4HState(shadow, app),

    // 7. REMINDERS WIDGET
    reminders: captureRemindersState(shadow),

    // 8. MODALS
    modals: captureModalsState(shadow),

    // 9. CONNECTION STATUS
    connection: captureConnectionState(app, shadow),

    // 10. TOASTS (if any)
    toasts: captureToastsState(shadow),
  };

  return new DomindsUI(data);
}

// ============================================
// Capture functions for each UI region
// ============================================

function captureHeaderState(shadow) {
  if (!shadow) return { exists: false };

  const header = shadow.querySelector('.header');
  return {
    exists: !!header,
    workspace: header?.querySelector('.workspace-indicator')?.textContent?.trim() || null,
    themeToggle: header?.querySelector('#theme-toggle-btn')?.textContent?.trim() || null,
  };
}

function captureSidebarState(shadow) {
  if (!shadow) return { exists: false };

  const sidebar = shadow.querySelector('.sidebar');
  const listShadow = getDialogListShadow();

  if (!listShadow) {
    return {
      exists: !!sidebar,
      dialogListLoaded: false,
      dialogCount: 0,
      taskGroupCount: 0,
      taskGroups: [],
      dialogs: [],
      visibleNodeTitles: [],
      selectedDialogTitle: null,
      newDialogBtnExists: !!shadow.querySelector('#new-dialog-btn'),
    };
  }

  // Capture dialog tree structure from the running dialog list shadow DOM
  const allDialogItems = Array.from(listShadow.querySelectorAll('.dialog-item') || []);
  const allTaskGroups = Array.from(listShadow.querySelectorAll('.task-group') || []);
  const dialogItems = allDialogItems.filter((item) => isElementVisible(item));
  const taskGroups = allTaskGroups.filter((group) => {
    const title = group.querySelector('.task-title');
    return title ? isElementVisible(title) : isElementVisible(group);
  });

  const dialogs = dialogItems.map((item) => {
    const toggle = item.querySelector('[data-action="toggle-root"]');
    const title = item.querySelector('.dialog-title');
    const status = item.querySelector('.dialog-status');
    const timestamp = item.querySelector('.dialog-time');
    const subdialogCount = item.querySelector('.dialog-count');
    const toggleText = toggle?.textContent?.trim() || '';
    const isSubdialog = item.classList.contains('sub-dialog');
    const level = isSubdialog ? '3' : '2';
    const countText = subdialogCount?.textContent?.trim() || '';
    const countValue = Number(countText);

    return {
      title: title?.textContent?.trim() || '',
      status: status?.textContent?.trim() || '',
      timestamp: timestamp?.textContent?.trim() || '',
      subdialogs: countText,
      expanded: !isSubdialog && toggleText === '▼',
      hasSubdialogs: !isSubdialog && Number.isFinite(countValue) ? countValue > 0 : false,
      level,
      rootId: item.getAttribute('data-root-id') || '',
      selfId: item.getAttribute('data-self-id') || '',
    };
  });

  const taskGroupsInfo = taskGroups.map((group) => {
    const title = group.querySelector('.task-title');
    const text = title?.querySelector('.task-title-left span');
    const count = title?.querySelector('.dialog-count');
    const toggle = title?.querySelector('[data-action="toggle-task"]');

    return {
      path: title?.getAttribute('data-task-path') || text?.textContent?.trim() || '',
      count: count?.textContent?.trim() || '',
      expanded: toggle?.textContent?.trim() === '▼',
    };
  });

  const orderedNodes = Array.from(listShadow.querySelectorAll('.task-title, .dialog-item') || []);
  const visibleNodeTitles = orderedNodes
    .filter((node) => isElementVisible(node))
    .map((node) => {
      if (node.classList.contains('task-title')) {
        const text = node.getAttribute('data-task-path') || node.textContent?.trim() || '';
        return text ? `Task: ${text}` : 'Task: (unnamed)';
      }
      const title = node.querySelector('.dialog-title')?.textContent?.trim() || '';
      const isSubdialog = node.classList.contains('sub-dialog');
      const prefix = isSubdialog ? 'Subdialog' : 'Dialog';
      return title ? `${prefix}: ${title}` : `${prefix}: (untitled)`;
    });

  // Find currently selected dialog in sidebar
  const selectedItem = listShadow.querySelector('.dialog-item.selected, .dialog-item.active');

  return {
    exists: !!sidebar,
    dialogListLoaded: true,
    dialogCount: dialogItems.length,
    taskGroupCount: taskGroups.length,
    taskGroups: taskGroupsInfo,
    dialogs,
    visibleNodeTitles,
    selectedDialogTitle: selectedItem?.querySelector('.dialog-title')?.textContent?.trim() || null,
    newDialogBtnExists: !!shadow.querySelector('#new-dialog-btn'),
  };
}

function captureCurrentDialogState(shadow, app) {
  if (!shadow) return { exists: false };

  // Use app method for reliable info
  const dialogInfo = app?.getCurrentDialogInfo?.() || null;

  // Fallback: check DOM for title
  const titleEl = shadow.querySelector('#current-dialog-title');
  const titleText = titleEl?.textContent?.trim() || '';

  // Round navigation state
  const prevBtn = shadow.querySelector('#toolbar-prev');
  const nextBtn = shadow.querySelector('#toolbar-next');
  const roundText = shadow.querySelector('#round-nav span');

  // Check if dialog is actually loaded (not placeholder)
  const hasRealDialog = titleText !== '' && titleText !== 'Select or create a dialog to start';

  return {
    exists: true,
    title: titleText,
    hasRealDialog,
    placeholder: titleText === 'Select or create a dialog to start',
    dialogInfo,
    round: roundText?.textContent?.trim() || '',
    prevEnabled: !prevBtn?.hasAttribute?.('disabled'),
    nextEnabled: !nextBtn?.hasAttribute?.('disabled'),
  };
}

function captureChatState(shadow) {
  if (!shadow) return { exists: false };

  const container = shadow.querySelector('dominds-dialog-container');
  const containerShadow = container?.shadowRoot;

  if (!containerShadow) {
    return {
      exists: !!container,
      messageCount: 0,
      messages: [],
    };
  }

  const bubbles = containerShadow.querySelectorAll('.generation-bubble') || [];
  const messageContainer = containerShadow.querySelector('.messages');
  const messageNodes = messageContainer ? Array.from(messageContainer.children) : [];
  const userMessages =
    containerShadow.querySelectorAll(
      '.user-message, .message.user, .generation-bubble[data-user-msg-id]',
    ) || [];

  const messages = Array.from(bubbles).map((bubble) => {
    const author = bubble.querySelector('.bubble-author')?.textContent?.trim() || '';
    const thinking = bubble.querySelector('.thinking-section')?.textContent?.trim() || '';
    const markdown = bubble.querySelector('.markdown-section')?.textContent?.trim() || '';
    const hasFuncCall = bubble.querySelector('.func-call-section');
    const funcTitle = bubble.querySelector('.func-call-title')?.textContent?.trim() || '';
    const funcNameMatch = funcTitle.match(/^Function:\\s*(.+)$/);
    const funcName = funcNameMatch ? funcNameMatch[1].trim() : funcTitle;
    const callingSection = bubble.querySelector('.calling-section.teammate-call');
    const callingHeadline =
      callingSection?.querySelector('.calling-headline')?.textContent?.trim() || '';
    const firstMention = callingSection?.getAttribute('data-first-mention') || '';

    // Check completion state
    const thinkingCompleted = bubble.querySelector('.thinking-section.completed');
    const markdownCompleted = bubble.querySelector('.markdown-section.completed');

    return {
      type: 'generation',
      author,
      hasThinking: !!thinking,
      thinkingPreview: thinking.slice(0, 100) + (thinking.length > 100 ? '...' : ''),
      hasMarkdown: !!markdown,
      markdownPreview: markdown.slice(0, 200) + (markdown.length > 200 ? '...' : ''),
      hasFuncCall: !!hasFuncCall,
      funcName: funcName || null,
      hasTeammate: !!callingSection,
      teammateLabel: callingHeadline || firstMention || '',
      thinkingCompleted: !!thinkingCompleted,
      markdownCompleted: !!markdownCompleted,
    };
  });

  const visibleMessages = messageNodes.map((node) => {
    if (node.classList.contains('generation-bubble')) {
      const author = node.querySelector('.bubble-author')?.textContent?.trim() || '';
      const markdownSections = Array.from(node.querySelectorAll('.markdown-section'))
        .map((section) => section.textContent?.trim() || '')
        .filter((text) => text.length > 0);
      let content = '';
      if (markdownSections.length === 1) {
        content = markdownSections[0];
      } else if (markdownSections.length > 1) {
        const first = markdownSections[0];
        const last = markdownSections[markdownSections.length - 1];
        content = first === last ? first : `${first}\n${last}`;
      }
      return {
        // Treat generation bubbles as assistant messages for scenario-level checks.
        type: 'assistant',
        author,
        preview: content.slice(0, 120) + (content.length > 120 ? '...' : ''),
      };
    }
    if (node.classList.contains('message')) {
      const author =
        node.querySelector('.author-name')?.textContent?.trim() ||
        node.querySelector('.author')?.textContent?.trim() ||
        '';
      const type = node.classList.contains('teammate')
        ? 'teammate'
        : node.classList.contains('tool')
          ? 'tool'
          : node.classList.contains('assistant')
            ? 'assistant'
            : node.classList.contains('user')
              ? 'user'
              : node.classList.contains('system')
                ? 'system'
                : node.classList.contains('calling')
                  ? 'calling'
                  : node.classList.contains('subdialog')
                    ? 'subdialog'
                    : 'message';
      const contentEl =
        node.querySelector('.teammate-content') ||
        node.querySelector('.content') ||
        node.querySelector('.bubble-body') ||
        node;
      let contentText = contentEl?.innerText?.trim() || contentEl?.textContent?.trim() || '';
      const nodeText = node.innerText?.trim() || node.textContent?.trim() || '';
      if (nodeText.length > contentText.length + 20) {
        contentText = nodeText;
      }
      if (contentText.length > 80) {
        contentText = contentText.replace(/(\.(?:md|txt|rst))(?!\s|$)/g, '$1\n');
      }
      let previewText = contentText;
      if (type === 'teammate') {
        const lines = contentText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (lines.length > 1) {
          previewText = `${lines[0]}\n${lines[lines.length - 1]}`;
        }
      } else if (type === 'assistant') {
        const lines = contentText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (lines.length > 1) {
          previewText = `${lines[0]}\n${lines[lines.length - 1]}`;
        }
      }
      return {
        type,
        author,
        preview: previewText.length > 200 ? previewText.slice(0, 200) + '...' : previewText,
      };
    }
    const text = node.textContent?.trim() || '';
    return {
      type: 'other',
      author: '',
      preview: text.slice(0, 120) + (text.length > 120 ? '...' : ''),
    };
  });

  return {
    exists: true,
    messageCount: bubbles.length,
    userMessageCount: userMessages.length,
    messages,
    latestMessage: messages[messages.length - 1] || null,
    pendingTeammateCalls: getPendingTeammateCalls().length,
    visibleMessageCount: messageNodes.length,
    visibleMessages,
  };
}

function captureInputState(shadow) {
  if (!shadow) return { exists: false };

  const inputArea = getInputArea();
  if (!inputArea) return { exists: false };

  const inputShadow = inputArea.shadowRoot;
  if (!inputShadow) return { exists: true, shadowMissing: true };

  const textarea = inputShadow.querySelector('.message-input');
  const sendBtn = inputShadow.querySelector('.send-button');

  return {
    exists: true,
    textareaExists: !!textarea,
    textareaVisible: textarea?.offsetParent !== null,
    textareaEnabled: !textarea?.disabled && !textarea?.readOnly,
    textareaPlaceholder: textarea?.placeholder || '',
    sendBtnExists: !!sendBtn,
    sendBtnEnabled: !sendBtn?.disabled,
  };
}

function captureQ4HState(shadow, app) {
  if (!shadow) return { exists: false };

  const inputArea = getInputArea();
  const inputShadow = inputArea?.shadowRoot;

  // Get count from app
  const count = app?.q4hQuestions?.length || 0;

  // Check if Q4H section is expanded
  const q4hSection = inputShadow?.querySelector('.question-list');
  const isExpanded = q4hSection?.offsetParent !== null && q4hSection?.children?.length > 0;

  // Get question cards
  const questionCards = inputShadow?.querySelectorAll('.q4h-question-card') || [];
  const questions = Array.from(questionCards).map((card) => {
    const headline = card.querySelector('.q4h-question-headline')?.textContent?.trim() || '';
    const content = card.querySelector('.q4h-question-content')?.textContent?.trim() || '';
    const timestamp = card.querySelector('.q4h-question-timestamp')?.textContent?.trim() || '';
    const isChecked = card.querySelector('.q4h-checkbox-check');

    return {
      headline: headline.slice(0, 100) + (headline.length > 100 ? '...' : ''),
      contentPreview: content.slice(0, 150) + (content.length > 150 ? '...' : ''),
      timestamp,
      checked: !!isChecked,
    };
  });

  // Q4H panel in chat area (alternative view)
  const q4hPanel = shadow.querySelector('dominds-q4h-panel');
  const q4hPanelShadow = q4hPanel?.shadowRoot;

  return {
    exists: true,
    count,
    isExpanded,
    questionCount: questions.length,
    questions,
    panelExists: !!q4hPanel,
    panelExpanded: !!q4hPanelShadow?.querySelector('.q4h-panel-container.expanded'),
  };
}

function captureRemindersState(shadow) {
  if (!shadow) return { exists: false };

  const widget = shadow.querySelector('#reminders-widget');
  const content = shadow.querySelector('#reminders-widget-content');
  const toggle = shadow.querySelector('#toolbar-reminders-toggle');

  // Get count from toggle
  const toggleBadge = toggle?.querySelector('span');
  const countText = toggleBadge?.textContent?.trim() || '0';
  const count = parseInt(countText, 10) || 0;

  const isVisible = widget?.offsetParent !== null;

  // Capture reminder items if visible
  let reminders = [];
  if (isVisible && content) {
    const items = content.querySelectorAll('.reminder-item') || [];
    reminders = Array.from(items).map((item) => {
      const index = item.querySelector('.reminder-index')?.textContent?.trim() || '';
      const text = item.querySelector('.reminder-content')?.textContent?.trim() || '';
      return { index, text: text.slice(0, 100) + (text.length > 100 ? '...' : '') };
    });
  }

  return {
    exists: true,
    count,
    isVisible,
    hasReminders: reminders.length > 0,
    reminderCount: reminders.length,
    reminders,
    closeBtnExists: !!shadow.querySelector('#reminders-widget-close'),
  };
}

function captureModalsState(shadow) {
  if (!shadow) return { exists: false };

  const createDialogModal = shadow.querySelector('.create-dialog-modal');
  const teamMembersModal = document.querySelector('.modal-overlay');

  const createDialogModalVisible = isElementVisible(createDialogModal);
  const teamMembersModalVisible = isElementVisible(teamMembersModal);

  return {
    exists: true,
    createDialogModalVisible,
    teamMembersModalVisible,
    anyModalVisible: createDialogModalVisible || teamMembersModalVisible,
  };
}

function captureConnectionState(app, shadow) {
  if (!app) return { exists: false };

  const statusEl = shadow?.querySelector('dominds-connection-status');
  const appState = app.connectionState || null;
  const appStatus = appState && typeof appState.status === 'string' ? appState.status : '';
  const appError = appState && typeof appState.error === 'string' ? appState.error : '';
  const statusAttr = statusEl?.getAttribute('status') || '';
  const statusText = statusAttr || appStatus || statusEl?.textContent?.trim() || '';

  return {
    exists: true,
    statusText,
    connected:
      statusAttr === 'connected' || appStatus === 'connected' || statusText === 'connected',
    error: statusEl?.getAttribute('error') || appError || null,
  };
}

function captureToastsState(shadow) {
  if (!shadow) return { exists: false };

  const toasts = shadow.querySelectorAll('.toast') || [];
  return {
    exists: true,
    count: toasts.length,
    toasts: Array.from(toasts).map((t) => ({
      text: t.textContent?.trim()?.slice(0, 100) || '',
      type: t.classList.contains('error')
        ? 'error'
        : t.classList.contains('warning')
          ? 'warning'
          : 'info',
    })),
  };
}

// ============================================
// Delta computation
// ============================================

function computeDeltaForClass(previous, current) {
  const delta = { changes: [] };

  // Helper to detect changes
  const detectChange = (path, prevVal, currVal) => {
    const prevStr = JSON.stringify(prevVal);
    const currStr = JSON.stringify(currVal);
    if (prevStr !== currStr) {
      delta.changes.push({
        path,
        previous: prevVal,
        current: currVal,
      });
    }
  };

  // Compare key fields
  detectChange(
    'currentDialog.hasRealDialog',
    previous.currentDialog?.hasRealDialog,
    current.currentDialog?.hasRealDialog,
  );
  detectChange('currentDialog.title', previous.currentDialog?.title, current.currentDialog?.title);
  detectChange('currentDialog.round', previous.currentDialog?.round, current.currentDialog?.round);

  detectChange('chat.messageCount', previous.chat?.messageCount, current.chat?.messageCount);
  detectChange(
    'chat.visibleMessageCount',
    previous.chat?.visibleMessageCount,
    current.chat?.visibleMessageCount,
  );
  detectChange(
    'chat.latestMessage.author',
    previous.chat?.latestMessage?.author,
    current.chat?.latestMessage?.author,
  );
  detectChange(
    'chat.pendingTeammateCalls',
    previous.chat?.pendingTeammateCalls,
    current.chat?.pendingTeammateCalls,
  );

  detectChange(
    'input.textareaEnabled',
    previous.input?.textareaEnabled,
    current.input?.textareaEnabled,
  );
  detectChange(
    'input.textareaVisible',
    previous.input?.textareaVisible,
    current.input?.textareaVisible,
  );

  detectChange('q4h.count', previous.q4h?.count, current.q4h?.count);
  detectChange('q4h.isExpanded', previous.q4h?.isExpanded, current.q4h?.isExpanded);

  detectChange('reminders.count', previous.reminders?.count, current.reminders?.count);
  detectChange('reminders.isVisible', previous.reminders?.isVisible, current.reminders?.isVisible);

  detectChange(
    'modals.anyModalVisible',
    previous.modals?.anyModalVisible,
    current.modals?.anyModalVisible,
  );

  detectChange(
    'sidebar.selectedDialogTitle',
    previous.sidebar?.selectedDialogTitle,
    current.sidebar?.selectedDialogTitle,
  );
  detectChange(
    'sidebar.dialogListLoaded',
    previous.sidebar?.dialogListLoaded,
    current.sidebar?.dialogListLoaded,
  );
  detectChange('sidebar.dialogCount', previous.sidebar?.dialogCount, current.sidebar?.dialogCount);
  detectChange(
    'sidebar.taskGroupCount',
    previous.sidebar?.taskGroupCount,
    current.sidebar?.taskGroupCount,
  );
  detectChange(
    'sidebar.visibleNodeTitles',
    previous.sidebar?.visibleNodeTitles,
    current.sidebar?.visibleNodeTitles,
  );

  detectChange(
    'connection.connected',
    previous.connection?.connected,
    current.connection?.connected,
  );

  detectChange('toasts.count', previous.toasts?.count, current.toasts?.count);

  return delta;
}

// ============================================
// Human-readable state formatting
// ============================================

function formatList(items, maxItems = 6) {
  if (!Array.isArray(items) || items.length === 0) return '[]';
  const slice = items.slice(0, maxItems);
  const suffix = items.length > maxItems ? ` +${items.length - maxItems} more` : '';
  return `[${slice.join(' | ')}]${suffix}`;
}

function summarizeListDelta(previous, current) {
  const prev = Array.isArray(previous) ? previous : [];
  const curr = Array.isArray(current) ? current : [];
  const prevSet = new Set(prev);
  const currSet = new Set(curr);
  const added = curr.filter((item) => !prevSet.has(item));
  const removed = prev.filter((item) => !currSet.has(item));
  const orderChanged =
    added.length === 0 && removed.length === 0 && prev.join('|') !== curr.join('|');

  const parts = [];
  if (added.length > 0) parts.push(`+${formatList(added, 4)}`);
  if (removed.length > 0) parts.push(`-${formatList(removed, 4)}`);
  if (orderChanged) parts.push('order changed');
  if (parts.length === 0) return 'unchanged';
  return parts.join(' ');
}

function formatFullState(state) {
  const lines = [];

  // Current dialog (most important)
  if (state.currentDialog?.hasRealDialog) {
    lines.push(`  📂 Dialog: "${state.currentDialog.title}"`);
    if (state.currentDialog.round) {
      lines.push(`     Round: ${state.currentDialog.round}`);
    }
  } else {
    lines.push(`  📂 No dialog selected`);
  }

  // Chat messages
  const chatState = state.chat || null;
  const messageCount =
    chatState && typeof chatState.messageCount === 'number' ? chatState.messageCount : 0;
  const visibleCount =
    chatState && typeof chatState.visibleMessageCount === 'number'
      ? chatState.visibleMessageCount
      : 0;
  const visibleMessages =
    chatState && Array.isArray(chatState.visibleMessages) ? chatState.visibleMessages : [];
  const latestVisible =
    visibleMessages.length > 0 ? visibleMessages[visibleMessages.length - 1] : null;
  const latestVisibleAuthor = latestVisible && latestVisible.author ? latestVisible.author : '';
  const latestMessageAuthor =
    chatState && chatState.latestMessage && chatState.latestMessage.author
      ? chatState.latestMessage.author
      : '?';

  if (messageCount > 0 || visibleCount > 0) {
    const latestAuthor = latestVisibleAuthor || latestMessageAuthor || '?';
    lines.push(
      `  💬 ${visibleCount} visible message(s) (bubbles: ${messageCount}), latest: @${latestAuthor}`,
    );
  } else {
    lines.push(`  💬 No messages yet`);
  }

  // Sidebar / dialog list
  if (state.sidebar?.exists) {
    if (state.sidebar.dialogListLoaded === false) {
      lines.push(`  📚 Sidebar: dialog list not loaded`);
    } else {
      const dialogCount = state.sidebar.dialogCount || 0;
      const taskCount = state.sidebar.taskGroupCount || 0;
      lines.push(`  📚 Sidebar: ${dialogCount} dialog(s), ${taskCount} task group(s)`);
      if (
        Array.isArray(state.sidebar.visibleNodeTitles) &&
        state.sidebar.visibleNodeTitles.length
      ) {
        lines.push(`     Visible: ${formatList(state.sidebar.visibleNodeTitles, 6)}`);
      }
    }
  }

  // Input state
  const inputStatus = state.input?.textareaEnabled ? 'enabled' : 'disabled';
  lines.push(`  ✏️  Input: ${inputStatus}`);

  // Q4H
  if (state.q4h?.count > 0) {
    lines.push(
      `  ❓ Q4H: ${state.q4h.count} question(s) ${state.q4h.isExpanded ? '[expanded]' : '[collapsed]'}`,
    );
  } else {
    lines.push(`  ❓ Q4H: 0`);
  }

  // Reminders
  if (state.reminders?.isVisible) {
    lines.push(`  🔔 Reminders: ${state.reminders.count} [VISIBLE]`);
  } else {
    lines.push(`  🔔 Reminders: ${state.reminders.count} [hidden]`);
  }

  // Connection
  lines.push(
    `  ${state.connection?.connected ? '🟢' : '🔴'} Connection: ${state.connection?.statusText || 'unknown'}`,
  );

  // Modals
  if (state.modals?.anyModalVisible) {
    lines.push(`  ⚠️  Modal open`);
  }

  return lines.join('\n');
}

// ============================================
// Dialog Creation Functions
// ============================================

/**
 * Creates a new dialog using the UI modal flow.
 * This simulates the full user interaction:
 * 1. Click "New Dialog" button to open modal
 * 2. Fill task document path in modal input
 * 3. Select teammate from dropdown (optional - uses default if omitted)
 * 4. Click "Create Dialog" button
 *
 * @param {string} taskDocPath - Path to the task document (e.g., 'cmds-test.md')
 * @param {string} [callsign] - Optional teammate callsign (e.g., '@cmdr', '@dijiang').
 *                             If omitted, uses the rt team's default responder.
 * @returns {Promise<{callsign: string, taskDocPath: string, dialogId: string, rootId: string, created: boolean}>}
 *
 * Source: dominds-app.tsx - showCreateDialogModal(), setupDialogModalEvents()
 */
async function createDialog(taskDocPath, callsign) {
  const app = getApp();
  if (!app) {
    throw new Error('dominds-app element not found');
  }

  try {
    await waitUntil(() => Array.isArray(app.teamMembers) && app.teamMembers.length > 0, 7000);
  } catch {
    throw new Error(
      'No team members available. If .minds/team.yaml is missing, ensure an LLM provider API key env var is set so the adhoc team can be created.',
    );
  }

  const shadow = getAppShadow();
  if (!shadow) {
    throw new Error('dominds-app shadowRoot not found');
  }

  // Extract agentId from callsign if provided (e.g., '@cmdr' -> 'cmdr')
  const agentId = callsign ? callsign.replace(/^@/, '') : null;

  // Capture original title
  const originalTitle = getCurrentDialogTitle();

  // Step 1: Click "New Dialog" button to open modal
  const newDialogBtn = shadow.querySelector(sel.newDialogBtn);
  if (!newDialogBtn) {
    throw new Error('New Dialog button (#new-dialog-btn) not found');
  }
  newDialogBtn.click();

  // Step 2: Wait for modal to appear
  await waitUntil(() => {
    const modal = shadow.querySelector(sel.dialogModal);
    return modal !== null;
  }, 3000);

  const modal = shadow.querySelector(sel.dialogModal);
  if (!modal) {
    throw new Error('Create Dialog modal (.create-dialog-modal) did not appear');
  }

  // Step 3: Fill the task document path
  const taskInput = shadow.querySelector(sel.taskDocInput);
  if (!taskInput) {
    throw new Error('Task doc input (#task-doc-input) not found');
  }
  taskInput.value = taskDocPath;
  // Trigger input event for autocomplete to work properly
  taskInput.dispatchEvent(new Event('input', { bubbles: true }));

  // Step 4: Select the teammate from dropdown (only if callsign provided)
  if (agentId) {
    const teammateSelect = shadow.querySelector(sel.teammateSelect);
    if (!teammateSelect) {
      throw new Error('Teammate select (#teammate-select) not found');
    }
    teammateSelect.value = agentId;
    teammateSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Step 5: Click "Create Dialog" button
  const createBtn = shadow.querySelector(sel.createBtn);
  if (!createBtn) {
    throw new Error('Create Dialog button (#create-dialog-btn) not found');
  }
  createBtn.click();

  // Wait for modal to be removed and title to change
  await waitUntil(() => {
    const modalStillExists = shadow.querySelector(sel.dialogModal);
    const newTitle = getCurrentDialogTitle();
    return !modalStillExists && newTitle !== originalTitle;
  }, 5000);

  // Get the final title and extract actual agent from it
  const newTitle = getCurrentDialogTitle();

  // Extract agent callsign from title (format: "@agentId - taskName" or similar)
  const actualAgentMatch = newTitle.match(/^@(\w+)/);
  const actualAgentId = actualAgentMatch ? actualAgentMatch[1] : null;

  // Verify the agent if callsign was specified
  if (agentId && actualAgentId !== agentId) {
    throw new Error(`Expected @${agentId} in dialog title, got: "${newTitle}"`);
  }

  // Get the created dialog info
  const dialogInfo = getCurrentDialogInfo();

  return {
    callsign: actualAgentId,
    taskDocPath,
    dialogId: dialogInfo?.selfId || dialogInfo?.rootId,
    rootId: dialogInfo?.rootId,
    created: true,
  };
}

// ============================================
// Dialog Selection Functions
// ============================================

/**
 * Selects a dialog from the sidebar by ID.
 * Source: running-dialog-list.ts
 * Component method: selectDialogById(rootId) returns boolean
 */
function selectDialogById(rootId) {
  const dialogList = getDialogList();
  if (!dialogList) throw new Error('RunningDialogList component not found');

  if (typeof dialogList.selectDialogById !== 'function') {
    throw new Error('selectDialogById method not available on RunningDialogList');
  }

  return dialogList.selectDialogById(rootId);
}

/**
 * Selects a dialog from the sidebar using component methods.
 * Source: running-dialog-list.ts, dominds-app.tsx
 * Component methods: findDialogByRootId(), selectDialogById(), findSubdialog()
 */
async function selectDialog(dialogText) {
  const dialogList = getDialogList();
  if (!dialogList) throw new Error('RunningDialogList component not found');

  if (typeof dialogList.selectDialogById !== 'function') {
    throw new Error('selectDialogById method not available on RunningDialogList');
  }

  // Try to find by root ID first
  const dialog = dialogList.findDialogByRootId?.(dialogText);
  if (dialog) {
    const success = dialogList.selectDialogById(dialogText);
    if (!success) throw new Error(`selectDialogById failed for "${dialogText}"`);
    return true;
  }

  // Try to find subdialog (format: "rootId:selfId")
  if (dialogText.includes(':')) {
    const [rootId, selfId] = dialogText.split(':');
    await ensureSubdialogsLoaded(rootId);
    const subdialog = dialogList.findSubdialog?.(rootId, selfId);
    if (subdialog) {
      const opened = await openSubdialog(rootId, selfId);
      if (!opened) throw new Error(`openSubdialog failed for "${dialogText}"`);
      return true;
    }
  }

  throw new Error(`Dialog with ID "${dialogText}" not found in sidebar`);
}

/**
 * Gets all dialogs from the sidebar.
 * Source: running-dialog-list.ts
 * Component method: getAllDialogs() returns ApiRootDialogResponse[]
 */
function getAllDialogs() {
  const dialogList = getDialogList();
  if (!dialogList) return [];

  if (typeof dialogList.getAllDialogs === 'function') {
    return dialogList.getAllDialogs();
  }

  // Fallback to DOM traversal
  const shadow = getDialogListShadow();
  if (!shadow) return [];
  return Array.from(shadow.querySelectorAll('.dialog-item'));
}

// ============================================
// Subdialog Navigation Functions
// ============================================

/**
 * Ensure subdialogs for a root dialog are loaded (lazy loading aware).
 * Attempts backend load via dominds-app if available; falls back to expanding the root dialog.
 */
async function ensureSubdialogsLoaded(rootId, timeoutMs = 8000) {
  const app = getApp();
  if (!app) throw new Error('dominds-app not found');

  const dialogList = getDialogList();
  if (typeof app.ensureSubdialogsLoaded === 'function') {
    await app.ensureSubdialogsLoaded(rootId);
  }

  // Ensure task group + root are expanded in the UI so subdialogs are visible.
  const listShadow = getDialogListShadow();
  if (listShadow) {
    const rootDialogData = Array.isArray(app.dialogs)
      ? app.dialogs.find((d) => d.rootId === rootId && !d.selfId)
      : null;
    const taskPath = rootDialogData?.taskDocPath;
    if (taskPath) {
      const taskTitle = listShadow.querySelector(
        `.task-title[data-task-path="${escapeCssValue(taskPath)}"]`,
      );
      const taskToggle = taskTitle?.querySelector('[data-action="toggle-task"]');
      if (taskToggle && taskToggle.textContent?.trim() === '▶') {
        taskToggle.click();
      }
    }

    const rootItem = listShadow.querySelector(
      `.dialog-item.root-dialog[data-root-id="${escapeCssValue(rootId)}"]`,
    );
    const rootToggle = rootItem?.querySelector('[data-action="toggle-root"]');
    if (rootToggle && rootToggle.textContent?.trim() === '▶') {
      rootToggle.click();
    }
  }

  try {
    await waitUntil(() => {
      const dialogs = getAllDialogs();
      if (!Array.isArray(dialogs) || dialogs.length === 0) return false;
      const rootDialog = dialogs.find(
        (d) => d && typeof d.rootId === 'string' && d.rootId === rootId && !d.selfId,
      );
      const expectedCount =
        rootDialog && typeof rootDialog.subdialogCount === 'number' ? rootDialog.subdialogCount : 0;
      if (expectedCount === 0) return true;
      return dialogs.some(
        (d) => d && d.supdialogId === rootId && typeof d.selfId === 'string' && d.selfId !== '',
      );
    }, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a subdialog using the component's direct method.
 * Source: dominds-app.tsx lines 1738-1756
 * Component method: openSubdialog(rootId, subdialogId) returns Promise<boolean>
 */
async function openSubdialog(rootId, subdialogId) {
  const app = getApp();
  if (!app) throw new Error('dominds-app not found');

  if (typeof app.openSubdialog !== 'function') {
    throw new Error('openSubdialog method not available on dominds-app');
  }

  let opened = await app.openSubdialog(rootId, subdialogId);
  if (!opened) {
    await ensureSubdialogsLoaded(rootId);
    opened = await app.openSubdialog(rootId, subdialogId);
  }
  return opened;
}

/**
 * Gets the subdialog hierarchy from parent to current.
 * Source: dominds-app.tsx lines 1666-1709, 1712-1736
 * Uses: getCurrentDialogInfo(), app.dialogs[]
 */
function getSubdialogHierarchy() {
  const app = getApp();
  if (!app) throw new Error('dominds-app not found');

  const hierarchy = [];
  let current = app.getCurrentDialogInfo?.();

  while (current) {
    hierarchy.unshift({
      selfId: current.selfId || current.rootId,
      rootId: current.rootId,
      agentId: current.agentId || '',
    });

    // Check if this is a subdialog (selfId !== rootId)
    if (current.selfId !== current.rootId) {
      // Try to find parent in app.dialogs using supdialogId
      const currentDialogData = app.dialogs?.find(
        (d) => d.rootId === current.rootId && d.selfId === current.selfId,
      );

      if (currentDialogData?.supdialogId) {
        const parentDialog = app.dialogs?.find((d) => d.rootId === currentDialogData.supdialogId);
        if (parentDialog) {
          current = {
            selfId: parentDialog.selfId || parentDialog.rootId,
            rootId: parentDialog.rootId,
            agentId: parentDialog.agentId,
          };
          continue;
        }
      }
    }

    // No more parent
    break;
  }

  return hierarchy;
}

/**
 * Navigates from a subdialog back to its supdialog.
 * Source: dominds-app.tsx lines 1712-1736
 * Component method: navigateToParent() returns Promise<boolean>
 */
async function navigateToParent() {
  const app = getApp();
  if (!app) throw new Error('dominds-app not found');

  if (typeof app.navigateToParent !== 'function') {
    throw new Error('navigateToParent method not available on dominds-app');
  }

  const navigated = await app.navigateToParent();
  if (!navigated) return false;

  // Allow time for dialog history to stream in after navigation.
  try {
    await waitUntil(() => {
      const shadow = getAppShadow();
      if (!shadow) return false;
      const chat = captureChatState(shadow);
      return typeof chat.visibleMessageCount === 'number' && chat.visibleMessageCount > 0;
    }, 5000);
  } catch (_err) {
    // Non-fatal: some dialogs legitimately have no messages.
  }

  return true;
}

/**
 * Gets the current dialog info from the component.
 * Source: dominds-app.tsx lines 1666-1709
 * Component method: getCurrentDialogInfo() returns DialogInfo | null
 */
function getCurrentDialogInfo() {
  const app = getApp();
  if (!app) throw new Error('dominds-app not found');

  if (typeof app.getCurrentDialogInfo !== 'function') {
    throw new Error('getCurrentDialogInfo method not available on dominds-app');
  }

  return app.getCurrentDialogInfo();
}

/**
 * Gets the current dialog title text from #current-dialog-title element.
 * Element is in app's Shadow DOM.
 * @returns {string} The dialog title text (e.g., "@cmdr - task-name")
 */
function getCurrentDialogTitle() {
  const shadow = getAppShadow();
  if (!shadow) return '';
  const titleEl = shadow.querySelector('#current-dialog-title');
  return titleEl ? (titleEl.textContent || '').trim() : '';
}

/**
 * Gets the current Q4H count.
 */
function getQ4HCount() {
  const app = getApp();
  if (!app) return 0;
  return app.q4hQuestions?.length || 0;
}

/**
 * Opens the Q4H panel by clicking the toggle bar.
 */
async function openQ4HPanel() {
  const shadow = getAppShadow();
  if (!shadow) throw new Error('App shadow not found');

  const panel = shadow.querySelector(sel.q4hPanel);
  if (!panel) return;

  const isExpanded = panel.classList.contains('expanded');
  if (isExpanded) return;

  const toggle = shadow.querySelector(sel.q4hToggleBar);
  if (toggle) {
    toggle.click();
    await waitUntil(() => panel.classList.contains('expanded'));
  }
}

/**
 * Gets the Q4H panel height.
 */
function getQ4HPanelHeight() {
  const shadow = getAppShadow();
  if (!shadow) return 0;
  const panel = shadow.querySelector(sel.q4hPanel);
  return panel ? panel.offsetHeight : 0;
}

/**
 * Simulates dragging the Q4H resize handle.
 * @param {number} deltaY - Pixels to drag (negative for up/larger)
 */
async function dragQ4HResizeHandle(deltaY) {
  const shadow = getAppShadow();
  if (!shadow) throw new Error('App shadow not found');

  const handle = shadow.querySelector(sel.q4hResizeHandle);
  if (!handle) throw new Error('Q4H resize handle not found');

  const rect = handle.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;

  // Dispatch mousedown
  handle.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      clientX: startX,
      clientY: startY,
    }),
  );

  // Dispatch mousemove
  window.dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      clientX: startX,
      clientY: startY + deltaY,
    }),
  );

  // Dispatch mouseup
  window.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
    }),
  );

  // Give some time for state update
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Navigates to the call site of a specific Q4H question.
 * @param {string} questionId - The ID of the question to navigate to
 */
async function goToQ4HCallSite(questionId) {
  const shadow = getAppShadow();
  if (!shadow) throw new Error('App shadow not found');

  // Find the panel host
  const panelHost = shadow.querySelector(sel.q4hPanelHost);
  if (!panelHost || !panelHost.shadowRoot) throw new Error('Q4H panel host or shadow not found');

  const btn = panelHost.shadowRoot.querySelector(
    `${sel.q4hGoToSiteBtn}[data-question-id="${questionId}"]`,
  );
  if (!btn) throw new Error(`Go to call site button for question ${questionId} not found`);

  btn.click();

  // Wait for potential dialog switch and scroll
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * Gets all Q4H questions across all dialogs.
 */
function getQ4HList() {
  const app = getApp();
  if (!app) return [];
  return app.q4hQuestions || [];
}

/**
 * Selects a Q4H question by ID.
 */
function selectQ4HQuestion(questionId) {
  const shadow = getAppShadow();
  if (!shadow) return false;

  const panelHost = shadow.querySelector(sel.q4hPanelHost);
  if (!panelHost || !panelHost.shadowRoot) return false;

  const card = panelHost.shadowRoot.querySelector(
    `.q4h-question-card[data-question-id="${questionId}"]`,
  );
  if (!card) return false;

  const headline = card.querySelector('.q4h-question-headline');
  if (headline) {
    headline.click();
    return true;
  }
  return false;
}

// ============================================
// Reminders Widget Functions
// ============================================

/**
 * Opens the reminders widget.
 * Source: dominds-app.tsx lines 1092, 1300, 2966-2992
 * Toggle ID: #toolbar-reminders-toggle
 */
function openReminders() {
  const app = getApp();
  if (!app || !app.shadowRoot) throw new Error('dominds-app or shadowRoot not found');

  const toggle = app.shadowRoot.querySelector('#toolbar-reminders-toggle');
  if (!toggle) throw new Error('Reminders toggle button (#toolbar-reminders-toggle) not found');

  toggle.click();

  // Widget is dynamically created
  return app.shadowRoot.querySelector('#reminders-widget');
}

/**
 * Closes the reminders widget.
 * Source: dominds-app.tsx lines 1110, 2984, 172-179
 * Close button ID: #reminders-widget-close
 */
function closeReminders() {
  const app = getApp();
  if (!app || !app.shadowRoot) throw new Error('dominds-app or shadowRoot not found');

  // Try close button first
  const closeBtn = app.shadowRoot.querySelector('#reminders-widget-close');
  if (closeBtn) {
    closeBtn.click();
    return true;
  }

  // Fallback: toggle again
  const toggle = app.shadowRoot.querySelector('#toolbar-reminders-toggle');
  if (toggle) {
    toggle.click();
    return true;
  }

  throw new Error('Could not close reminders widget');
}

/**
 * Toggles the reminders widget open/close state.
 * Source: dominds-app.tsx lines 1092, 2966-2992
 */
function toggleReminders() {
  const app = getApp();
  if (!app || !app.shadowRoot) throw new Error('dominds-app or shadowRoot not found');

  const toggle = app.shadowRoot.querySelector('#toolbar-reminders-toggle');
  if (!toggle) throw new Error('Reminders toggle button not found');

  const widget = app.shadowRoot.querySelector('#reminders-widget');
  const isOpen = widget && widget.style.display !== 'none' && !widget.hasAttribute('hidden');

  toggle.click();
  return !isOpen;
}

/**
 * Gets the current content of the reminders widget.
 * Source: dominds-app.tsx lines 1114, 2988
 * Content ID: #reminders-widget-content
 * Note: Widget must be open and rendered before calling this function.
 */
function getRemindersContent() {
  const app = getApp();
  if (!app || !app.shadowRoot) return '';

  // First ensure widget is open
  const widget = app.shadowRoot.querySelector('#reminders-widget');
  if (!widget || widget.hasAttribute('hidden') || widget.style.display === 'none') {
    // Widget is not open, try to open it
    const toggle = app.shadowRoot.querySelector('#toolbar-reminders-toggle');
    if (toggle) {
      toggle.click();
    }
    return '';
  }

  const content = app.shadowRoot.querySelector('#reminders-widget-content');
  if (!content) return '';

  return (content.textContent || '').trim();
}

/**
 * Gets the current reminder count from the app state.
 * Accesses app.toolbarReminders directly for accurate count.
 * @returns {number} Current reminder count (0 if none)
 */
function getRemindersCount() {
  const app = getApp();
  if (!app) return 0;

  // Access the app's internal toolbarReminders array (private field but accessible in JS)
  const reminders = app.toolbarReminders;
  if (!reminders || !Array.isArray(reminders)) return 0;

  return reminders.length;
}

/**
 * Gets the reminders widget element for direct access.
 * Source: dominds-app.tsx lines 2966-2992
 * @returns {HTMLElement|null} The reminders widget element
 */
function getRemindersWidget() {
  const app = getApp();
  if (!app || !app.shadowRoot) return null;
  return app.shadowRoot.querySelector('#reminders-widget');
}

/**
 * Gets the reminders component for method access.
 * @returns {HTMLElement|null} The dominds-reminders element if available
 */
function getRemindersComponent() {
  const widget = getRemindersWidget();
  if (!widget) return null;
  return widget.querySelector('dominds-reminders') || widget;
}

/**
 * Waits until the reminder count matches the expected count.
 * Uses polling with configurable timeout.
 * @param {number} expectedCount - The count to wait for
 * @param {number} [timeoutMs=10000] - Maximum wait time in milliseconds
 * @returns {Promise<boolean>} True if count reached, false if timeout
 */
async function waitForRemindersCount(expectedCount, timeoutMs = 10000) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      try {
        const currentCount = getRemindersCount();
        if (currentCount === expectedCount) {
          return resolve(true);
        }
      } catch (err) {
        console.warn('Error checking reminder count:', err);
      }

      if (Date.now() - startTime >= timeoutMs) {
        console.log(
          `waitForRemindersCount timeout: expected=${expectedCount}, got=${getRemindersCount()}`,
        );
        return resolve(false);
      }

      setTimeout(check, 100);
    };

    check();
  });
}

/**
 * Waits until no reminder operations are pending.
 * Checks for widget stability by monitoring app state.
 * @param {number} [timeoutMs=5000] - Maximum wait time in milliseconds
 * @param {number} [intervalMs=200] - Polling interval
 * @returns {Promise<boolean>} True if stable, false if timeout
 */
async function waitUntilReminderStable(timeoutMs = 5000, intervalMs = 200) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      try {
        // Check if widget is open and content is stable
        const widget = getRemindersWidget();
        if (!widget || widget.hasAttribute('hidden') || widget.style.display === 'none') {
          // Widget is closed, consider stable
          return resolve(true);
        }

        // Widget is open - check for any pending operations
        // Use DOM observation utility if available
        if (domObs && typeof domObs.isObserving === 'function' && domObs.isObserving()) {
          // DOM is stable
          return resolve(true);
        }

        // Additional stability checks
        const content = getRemindersContent();
        if (content && content.length > 0) {
          // Content appears loaded
          return resolve(true);
        }
      } catch (err) {
        console.warn('Error checking reminder stability:', err);
      }

      if (Date.now() - startTime >= timeoutMs) {
        console.log('waitUntilReminderStable timeout');
        return resolve(false);
      }

      setTimeout(check, intervalMs);
    };

    check();
  });
}

/**
 * Waits for widget animations to complete.
 * @param {number} [timeoutMs=3000] - Maximum wait time in milliseconds
 * @returns {Promise<boolean>} True if animations completed or no widget
 */
async function waitForWidgetStable(timeoutMs = 3000) {
  const startTime = Date.now();
  const app = getApp();

  return new Promise((resolve) => {
    const check = () => {
      try {
        const widget = getRemindersWidget();
        if (!widget) return resolve(true);

        // Check if widget is fully visible (not mid-transition)
        const style = window.getComputedStyle(widget);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return resolve(true);
        }

        // Widget is visible - check if toggle is responsive
        const toggle = app?.shadowRoot?.querySelector('#toolbar-reminders-toggle');
        if (toggle && toggle.offsetParent !== null) {
          return resolve(true);
        }
      } catch (err) {
        console.warn('Error checking widget stability:', err);
      }

      if (Date.now() - startTime >= timeoutMs) {
        console.log('waitForWidgetStable timeout');
        return resolve(false);
      }

      setTimeout(check, 100);
    };

    check();
  });
}

/**
 * Waits until no console errors appear.
 * Useful for waiting for error handling to complete.
 * @param {number} [timeoutMs=5000] - Maximum wait time in milliseconds
 * @returns {Promise<boolean>} True if no errors, false if timeout
 */
async function waitForNoConsoleErrors(timeoutMs = 5000) {
  const startTime = Date.now();
  const initialErrors = __consoleErrors__.length;

  return new Promise((resolve) => {
    const check = () => {
      const currentErrors = __consoleErrors__.length;

      // Check if errors have settled (no new errors for a bit)
      if (currentErrors === initialErrors) {
        return resolve(true);
      }

      if (Date.now() - startTime >= timeoutMs) {
        console.log('waitForNoConsoleErrors timeout');
        return resolve(false);
      }

      setTimeout(check, 200);
    };

    check();
  });
}

// ============================================
// Q4H (Questions for Human) Helper Functions
// ============================================

/**
 * Gets the current Q4H badge count from the input area
 * Source: dominds-q4h-input.ts - getQuestionCount() method
 * @returns {number} Current Q4H count (0 if none)
 */
function getQ4HCountFromInput() {
  const inputArea = getInputArea();
  if (!inputArea) return 0;

  if (typeof inputArea.getQuestionCount === 'function') {
    return inputArea.getQuestionCount();
  }

  // Fallback: count question cards
  const shadow = inputArea.shadowRoot;
  if (!shadow) return 0;

  const countEl = shadow.querySelector('.q4h-count-badge');
  if (!countEl) return 0;

  const count = parseInt(countEl.textContent || '0', 10);
  return isNaN(count) ? 0 : count;
}

/**
 * Gets all Q4H questions from the input area component
 * Source: dominds-q4h-input.ts - getQuestions() method
 * @returns {Array<{id: string, headLine: string, bodyContent: string, askedAt: string}>} Array of Q4H questions
 */
function getQ4HListFromInput() {
  const inputArea = getInputArea();
  if (!inputArea) return [];

  if (typeof inputArea.getQuestions === 'function') {
    return inputArea.getQuestions();
  }

  return [];
}

/**
 * Gets the active Q4H question IDs
 * Useful for verifying which questions are pending
 * @returns {string[]} Array of pending question IDs
 */
function getPendingQ4HIds() {
  const questions = getQ4HList();
  return questions.map((q) => q.id);
}

/**
 * Selects a Q4H question in the component
 * Source: dominds-q4h-input.ts - selectQuestion() method
 * @param {string} questionId - The question ID to select
 * @returns {boolean} True if selection succeeded
 */
function selectQ4HQuestionFromInput(questionId) {
  const inputArea = getInputArea();
  if (!inputArea) throw new Error('dominds-q4h-input not found');

  if (typeof inputArea.selectQuestion !== 'function') {
    throw new Error('selectQuestion method not available');
  }

  inputArea.selectQuestion(questionId);
  return true;
}

/**
 * Gets the currently selected Q4H question ID
 * Source: dominds-q4h-input.ts - getSelectedQuestionId() method
 * @returns {string|null} Selected question ID or null
 */
function getSelectedQ4HQuestionId() {
  const inputArea = getInputArea();
  if (!inputArea) return null;

  if (typeof inputArea.getSelectedQuestionId === 'function') {
    return inputArea.getSelectedQuestionId();
  }

  return null;
}

/**
 * Answers a Q4H question inline
 * Uses the component's setValue() and sendMessage() with active question
 * @param {string} answer - The user's answer text
 * @returns {Promise<string>} The message ID of the answer
 */
async function answerQ4H(answer) {
  const inputArea = getInputArea();
  if (!inputArea) throw new Error('dominds-q4h-input not found');

  // Verify there's an active question
  if (inputArea.getQuestionCount !== undefined && inputArea.getQuestionCount() === 0) {
    throw new Error('No active Q4H to answer');
  }

  if (typeof inputArea.setValue !== 'function') {
    throw new Error('Input area does not have setValue method');
  }

  inputArea.setValue(answer);
  const result = await inputArea.sendMessage();

  if (!result.success) {
    throw new Error(result.error || 'sendMessage failed for Q4H answer');
  }

  checkConsoleErrors({ threshold: 0 });
  return result.msgId;
}

// ============================================
// Agent Function Call Detection & Nudging
// ============================================

/**
 * Detects if the last assistant message contains a function call.
 * Looks for .func-call-section elements which contain the function name in .func-call-title
 * @param {string} [toolName] - Optional tool name to check for (e.g., 'shell_cmd')
 * @returns {Object} Result with hasFuncCall (boolean) and funcCallInfo (object)
 */
function detectFuncCall(toolName) {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  if (!shadow) {
    return { hasFuncCall: false, toolName: null, index: -1 };
  }

  // Look for func-call-section elements in the dialog
  const funcCallSections = shadow.querySelectorAll('.func-call-section');

  if (funcCallSections.length === 0) {
    return { hasFuncCall: false, toolName: null, index: -1 };
  }

  // Get the last func-call-section
  const lastIndex = funcCallSections.length - 1;
  const lastSection = funcCallSections[lastIndex];

  // Extract function name from func-call-title element
  const titleEl = lastSection.querySelector('.func-call-title');
  const titleText = titleEl ? (titleEl.textContent || '').trim() : '';

  // Extract arguments from func-call-arguments element
  const argsEl = lastSection.querySelector('.func-call-arguments');
  const argsText = argsEl ? (argsEl.textContent || '').trim() : '';

  // Extract result from func-call-result element (if visible)
  const resultEl = lastSection.querySelector('.func-call-result');
  const resultText =
    resultEl && resultEl.style.display !== 'none' ? (resultEl.textContent || '').trim() : '';

  // Extract the function name from "Function: name" format
  const funcNameMatch = titleText.match(/^Function:\s*(.+)$/);
  const funcName = funcNameMatch ? funcNameMatch[1].trim() : '';

  if (toolName) {
    // Check if the last func call is for the specified tool
    const hasTool = funcName === toolName || titleText.includes(toolName);
    return {
      hasFuncCall: hasTool,
      toolName: hasTool ? funcName : null,
      index: hasTool ? lastIndex : -1,
      header: hasTool ? titleText : null,
      content: hasTool ? argsText : null,
      result: hasTool ? resultText : null,
      funcName: hasTool ? funcName : null,
    };
  }

  return {
    hasFuncCall: true,
    toolName: funcName || null,
    index: lastIndex,
    header: titleText,
    content: argsText,
    result: resultText,
    funcName,
  };
}

/**
 * Gets all pending teammate calls (calls still waiting for response).
 * @returns {Array<{element: HTMLElement, firstMention: string, isHuman: boolean, callSiteId: number | null}>}
 */
function getPendingTeammateCalls() {
  return getTeammateCallingSections().filter((item) => {
    const el = item.element;
    return !el.classList.contains('completed');
  });
}

function parseCallSiteId(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMention(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .trim();
}

function getTeamMemberIds() {
  const app = getApp();
  return Array.isArray(app?.teamMembers) ? app.teamMembers.map((m) => m.id) : [];
}

function isTeammateMention(firstMention) {
  const normalized = normalizeMention(firstMention);
  if (!normalized) return false;
  return getTeamMemberIds().includes(normalized);
}

function extractCallSiteIdFromSection(el) {
  const callSiteId = parseCallSiteId(el.getAttribute('data-call-site-id'));
  if (callSiteId !== null) return callSiteId;
  return parseCallSiteId(el.getAttribute('data-genseq'));
}

function getTeammateCallingSections() {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  if (!shadow) return [];
  const sections = shadow.querySelectorAll('.calling-section');
  return Array.from(sections)
    .map((el) => {
      const firstMention = el.getAttribute('data-first-mention') || '';
      const isTeammate = el.classList.contains('teammate-call') || isTeammateMention(firstMention);
      if (!isTeammate) return null;
      return {
        element: el,
        firstMention,
        isHuman: el.getAttribute('data-is-human') === 'true',
        callSiteId: extractCallSiteIdFromSection(el),
      };
    })
    .filter((item) => item !== null);
}

function getTeammateCallSites() {
  return getTeammateCallingSections();
}

function getLatestTeammateCallSiteId() {
  const sites = getTeammateCallSites();
  let latest = null;
  for (const site of sites) {
    if (typeof site.callSiteId !== 'number') continue;
    if (latest === null || site.callSiteId > latest) {
      latest = site.callSiteId;
    }
  }
  return latest;
}

/**
 * Waits for a new teammate call site to appear after a known call-site ID.
 * @param {Object} options - Options object
 * @param {number} [options.timeoutMs=60000] - Maximum wait time
 * @param {number} [options.after] - Only return call sites with ID > after
 * @param {string} [options.firstMention] - Optional filter for @mention (e.g., "@cmdr")
 * @returns {Promise<number | null>} Call-site ID, or null on timeout
 */
async function waitForTeammateCallSiteId(options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000;
  const after = typeof options.after === 'number' ? options.after : -Infinity;
  const firstMention = typeof options.firstMention === 'string' ? options.firstMention : '';
  const expectedMention = normalizeMention(firstMention);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      const sites = getTeammateCallSites();
      let latest = null;
      for (const site of sites) {
        if (typeof site.callSiteId !== 'number') continue;
        if (site.callSiteId <= after) continue;
        if (expectedMention && normalizeMention(site.firstMention) !== expectedMention) continue;
        if (latest === null || site.callSiteId > latest) {
          latest = site.callSiteId;
        }
      }

      if (latest !== null) return resolve(latest);
      if (Date.now() - startTime >= timeoutMs) {
        console.log(
          `waitForTeammateCallSiteId timeout: after=${after}, mention=${firstMention || '*'}`,
        );
        return resolve(null);
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/**
 * Waits for all pending teammate calls to complete.
 * @param {number} [timeoutMs=60000] - Maximum wait time
 * @returns {Promise<boolean>} True if completed, false if timeout
 */
async function waitForPendingTeammateCalls(timeoutMs = 60000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const pendingCalls = getPendingTeammateCalls();
      if (pendingCalls.length === 0) return resolve(true);
      if (Date.now() - startTime >= timeoutMs) {
        console.log(`waitForPendingTeammateCalls timeout: ${pendingCalls.length} pending`);
        return resolve(false);
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/**
 * Waits for the visible message list to reach a minimum count.
 * Useful when teammate responses render as .message.* entries.
 * @param {number} minCount - Minimum visible messages in .messages container
 * @param {number} [timeoutMs=60000] - Maximum wait time
 * @returns {Promise<boolean>} True if count reached, false if timeout
 */
async function waitForVisibleMessageCount(minCount, timeoutMs = 60000) {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const container = getMessageContainer();
      const count = container ? container.children.length : 0;
      if (count >= minCount) return resolve(true);
      if (Date.now() - startTime >= timeoutMs) {
        console.log(`waitForVisibleMessageCount timeout: expected>=${minCount}, got ${count}`);
        return resolve(false);
      }
      setTimeout(check, 100);
    };
    check();
  });
}

/**
 * Waits for a teammate response bubble with non-trivial content.
 * @param {Object} options - Options object
 * @param {number} [options.timeoutMs=60000] - Maximum wait time
 * @param {number} [options.minChars=12] - Minimum text length to consider complete
 * @param {number} [options.initialCount] - Initial teammate message count (defaults to current)
 * @param {number} [options.minNew=1] - Minimum number of new teammate messages to wait for
 * @param {number} [options.callSiteId] - Require response bubble to match call-site ID
 * @returns {Promise<boolean>} True if a new response appears, false if timeout
 */
async function waitForTeammateResponse(options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000;
  const minChars = typeof options.minChars === 'number' ? options.minChars : 1;
  const initialCount =
    typeof options.initialCount === 'number' ? options.initialCount : getTeammateMessageCount();
  const minNew = typeof options.minNew === 'number' ? options.minNew : 1;
  const callSiteId = typeof options.callSiteId === 'number' ? options.callSiteId : null;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      try {
        const messages = getTeammateMessages();
        if (messages.length >= initialCount + minNew) {
          const newMessages = messages.slice(initialCount);
          const contentMessages = [];
          for (const message of newMessages) {
            const contentEl = message.querySelector('.teammate-content');
            if (!contentEl) continue;
            const text = (contentEl.textContent || '').trim();
            if (text.length < minChars) continue;
            const messageCallSiteId = parseCallSiteId(message.getAttribute('data-call-site-id'));
            contentMessages.push({ messageCallSiteId, text });
            if (callSiteId !== null && messageCallSiteId === callSiteId) {
              return resolve(true);
            }
          }
          if (callSiteId === null) {
            if (contentMessages.length > 0) {
              return resolve(true);
            }
            return;
          }
          if (contentMessages.length === 1) {
            console.log(
              'waitForTeammateResponse fallback: single content message, accepting despite call-site mismatch',
            );
            return resolve(true);
          }
          const ids = contentMessages
            .map((item) => item.messageCallSiteId)
            .filter((id) => id !== null);
          if (ids.length === 0 && contentMessages.length > 0) {
            console.log(
              'waitForTeammateResponse fallback: content has no call-site ids, accepting',
            );
            return resolve(true);
          }
        }
      } catch (err) {
        console.warn('Error checking teammate response:', err);
      }

      if (Date.now() - startTime >= timeoutMs) {
        const newCount = getTeammateMessageCount() - initialCount;
        console.log(`waitForTeammateResponse timeout: expected+${minNew}, got +${newCount}`);
        return resolve(false);
      }

      setTimeout(check, 150);
    };
    check();
  });
}

// ============================================
// Export to window.__e2e__
// ============================================

function setGlobal() {
  const g = {
    // Selectors
    sel,
    // Shadow DOM accessors
    getAppShadow,
    getApp,
    getInputArea,
    getDialogContainer,
    getDialogList,
    getDialogListShadow,
    getMessageContainer,
    getTeammateMessageCount,
    getTeammateResponseDetails,
    getLatestTeammateResponseDetails,
    getVisibleMessageTexts,
    findVisibleMessageContainingAll,
    // Core messaging
    fillAndSend,
    waitStreamingComplete,
    waitForInputEnabled,
    // State inspection - NEW: snapshotDomindsUI for delta-based UI observation
    snapshotDomindsUI,
    DomindsUI, // Class for UI snapshots with reportDeltaTo() method
    noLingering,
    latestUserText,
    waitUntil,
    // Function call detection
    detectFuncCall,
    // Dialog creation
    createDialog,
    // Dialog selection
    selectDialog,
    selectDialogById,
    getAllDialogs,
    // Subdialog navigation
    ensureSubdialogsLoaded,
    openSubdialog,
    getSubdialogHierarchy,
    navigateToParent,
    getCurrentDialogInfo,
    getCurrentDialogTitle,
    // Reminders widget
    openReminders,
    closeReminders,
    getRemindersContent,
    toggleReminders,
    getRemindersCount,
    getRemindersWidget,
    getRemindersComponent,
    waitForRemindersCount,
    waitUntilReminderStable,
    waitForWidgetStable,
    waitForNoConsoleErrors,
    // Q4H helpers
    getQ4HCount,
    getQ4HList,
    getPendingQ4HIds,
    selectQ4HQuestion,
    getSelectedQ4HQuestionId,
    answerQ4H,
    // Console error tracking
    checkConsoleErrors,
    // Error state accessor for MCP Playwright
    get __consoleErrors__() {
      return [...__consoleErrors__];
    },
    // DOM observation utilities
    domObs,
    // Teammate calls
    getPendingTeammateCalls,
    getLatestTeammateCallSiteId,
    waitForPendingTeammateCalls,
    waitForTeammateCallSiteId,
    waitForVisibleMessageCount,
    waitForTeammateResponse,
  };
  window.__e2e__ = g;
  return g;
}

const __e2e__ = setGlobal();
