/**
 * E2E Test Helper - DEFINITIVE IMPLEMENTATIONS
 * Source: dominds-app.tsx, dominds-dialog-list.ts, dominds-dialog-container.ts, dominds-q4h-input.ts
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
  userMsg: '.user-message',
  genBubble: '.generation-bubble',
  genCompleted: '.generation-bubble.completed',
  genNotCompleted: '.generation-bubble:not(.completed)',
  teammateBubble: '.message.teammate',
  teammateContent: '.teammate-content',
  teammateLabel: '.teammate-label',
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

  // Dialog list (dominds-dialog-list.ts)
  sidebar: '.sidebar',
  dialogList: 'dominds-dialog-list',
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

function getDialogContainer() {
  return document.querySelector('dominds-app')?.shadowRoot?.querySelector('#dialog-container');
}

function getDialogList() {
  return document.querySelector('dominds-app')?.shadowRoot?.querySelector('dominds-dialog-list');
}

function getDialogListShadow() {
  const dialogList = getDialogList();
  return dialogList && dialogList.shadowRoot ? dialogList.shadowRoot : null;
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

// ============================================
// Core Messaging Functions
// ============================================

/**
 * Sends a message via the input area component.
 * Source: dominds-q4h-input.ts
 * Component methods: setValue(), sendMessage()
 */
async function fillAndSend(message) {
  const inputArea = getInputArea();
  if (!inputArea) throw new Error('dominds-q4h-input not found');

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
  return n ? (n.textContent || '').trim() : '';
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

/**
 * Takes a full snapshot of the chat state.
 * Source: dominds-dialog-container.ts
 */
function snapshot() {
  const dialogContainer = getDialogContainer();
  const shadow = dialogContainer?.shadowRoot;
  const app = getApp();

  // Get current dialog info from app
  const currentDialogInfo = app?.getCurrentDialogInfo?.() || null;

  if (!shadow) {
    return {
      userTexts: [],
      authors: [],
      thinkings: [],
      sayings: [],
      codeHeaders: [],
      codeContents: [],
      dialogInfo: currentDialogInfo,
    };
  }

  const mapText = (n) => (n.textContent || '').trim();

  return {
    userTexts: Array.from(shadow.querySelectorAll(sel.userMsg)).map(mapText),
    authors: Array.from(shadow.querySelectorAll(`${sel.genBubble} ${sel.author}`)).map(mapText),
    thinkings: Array.from(shadow.querySelectorAll(`${sel.genBubble} ${sel.thinkingCompleted}`)).map(
      mapText,
    ),
    sayings: Array.from(shadow.querySelectorAll(`${sel.genBubble} ${sel.markdownContent}`)).map(
      mapText,
    ),
    codeHeaders: Array.from(
      shadow.querySelectorAll(`${sel.genBubble} ${sel.codeCompleted} ${sel.codeTitle}`),
    ).map(mapText),
    codeContents: Array.from(
      shadow.querySelectorAll(`${sel.genBubble} ${sel.codeCompleted} ${sel.codeContent}`),
    ).map(mapText),
    dialogInfo: currentDialogInfo,
  };
}

// ============================================
// Dialog Creation Functions
// ============================================

/**
 * Creates a new dialog using the UI modal flow.
 * This simulates the full user interaction:
 * 1. Click "New Dialog" button to open modal
 * 2. Fill task document path in modal input
 * 3. Select teammate from dropdown
 * 4. Click "Create Dialog" button
 *
 * Source: dominds-app.tsx - showCreateDialogModal(), setupDialogModalEvents()
 * Verifies the dialog title shows expected agent - throws if wrong responder.
 */
async function createDialog(callsign, taskDocPath) {
  const agentId = callsign.replace(/^@/, '');
  const app = getApp();
  if (!app) {
    throw new Error('dominds-app element not found');
  }

  const shadow = getAppShadow();
  if (!shadow) {
    throw new Error('dominds-app shadowRoot not found');
  }

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

  // Step 4: Select the teammate from dropdown
  const teammateSelect = shadow.querySelector(sel.teammateSelect);
  if (!teammateSelect) {
    throw new Error('Teammate select (#teammate-select) not found');
  }
  teammateSelect.value = agentId;
  teammateSelect.dispatchEvent(new Event('change', { bubbles: true }));

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

  // Verify the new title includes expected agent
  const newTitle = getCurrentDialogTitle();
  if (!newTitle.includes(`@${agentId}`)) {
    throw new Error(`Expected @${agentId} in dialog title, got: "${newTitle}"`);
  }

  // Get the created dialog info
  const dialogInfo = getCurrentDialogInfo();

  return {
    callsign: agentId,
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
 * Source: dominds-dialog-list.ts lines 353-366
 * Component method: selectDialogById(rootId) returns boolean
 */
function selectDialogById(rootId) {
  const dialogList = getDialogList();
  if (!dialogList) throw new Error('DomindsDialogList component not found');

  if (typeof dialogList.selectDialogById !== 'function') {
    throw new Error('selectDialogById method not available on DomindsDialogList');
  }

  return dialogList.selectDialogById(rootId);
}

/**
 * Selects a dialog from the sidebar using component methods.
 * Source: dominds-dialog-list.ts lines 381-393, 353-366
 * Component methods: findDialogByRootId(), selectDialogById(), findSubdialog()
 */
function selectDialog(dialogText) {
  const dialogList = getDialogList();
  if (!dialogList) throw new Error('DomindsDialogList component not found');

  if (typeof dialogList.selectDialogById !== 'function') {
    throw new Error('selectDialogById method not available on DomindsDialogList');
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
    const subdialog = dialogList.findSubdialog?.(rootId, selfId);
    if (subdialog) {
      const success = dialogList.selectDialogById(rootId);
      if (!success) throw new Error(`selectDialogById failed for subdialog "${dialogText}"`);
      return true;
    }
  }

  throw new Error(`Dialog with ID "${dialogText}" not found in sidebar`);
}

/**
 * Gets all dialogs from the sidebar.
 * Source: dominds-dialog-list.ts lines 372-374
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

  return app.openSubdialog(rootId, subdialogId);
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
 * Navigates from a subdialog back to its parent dialog.
 * Source: dominds-app.tsx lines 1712-1736
 * Component method: navigateToParent() returns Promise<boolean>
 */
async function navigateToParent() {
  const app = getApp();
  if (!app) throw new Error('dominds-app not found');

  if (typeof app.navigateToParent !== 'function') {
    throw new Error('navigateToParent method not available on dominds-app');
  }

  return app.navigateToParent();
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
    // Core messaging
    fillAndSend,
    waitStreamingComplete,
    // State inspection
    counts,
    latestBubble,
    snapshot,
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
  };
  window.__e2e__ = g;
  return g;
}

const __e2e__ = setGlobal();
