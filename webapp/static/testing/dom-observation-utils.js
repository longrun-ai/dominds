/**
 * DOM Observation Utilities for E2E Testing
 *
 * Provides MutationObserver-based wait utilities that respond immediately
 * when DOM changes occur, replacing inefficient polling with event-driven waits.
 */

/**
 * Core wait function that uses MutationObserver to detect DOM changes.
 *
 * @param {Function} conditionFn - Function that returns truthy when condition is met
 * @param {Object} options - Configuration options
 * @param {number} options.timeoutMs - Maximum wait time (default: 10000)
 * @param {MutationObserverInit} options.observeOptions - What to observe (default: { childList: true, subtree: true })
 * @param {Node} options.root - Root node to observe (default: document.body)
 * @returns {Promise<any>} The truthy value from conditionFn, or throws on timeout
 */
async function waitForDomChange(conditionFn, options = {}) {
  const {
    timeoutMs = 10000,
    observeOptions = { childList: true, subtree: true },
    root = document.body,
  } = options;

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    // Check immediately first - avoids observer overhead if already satisfied
    try {
      const result = conditionFn();
      if (result) {
        resolve(result);
        return;
      }
    } catch (err) {
      // Condition function may throw while DOM is unstable
    }

    const observer = new MutationObserver(() => {
      try {
        const result = conditionFn();
        if (result) {
          observer.disconnect();
          resolve(result);
        }
      } catch (err) {
        // Ignore errors during mutation checking
      }
    });

    observer.observe(root, observeOptions);

    // Fallback timeout to prevent hanging
    const timeoutId = setTimeout(() => {
      observer.disconnect();
      try {
        const result = conditionFn();
        if (result) {
          resolve(result);
        } else {
          reject(new Error(`waitForDomChange timed out after ${timeoutMs}ms`));
        }
      } catch (err) {
        reject(new Error(`waitForDomChange timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Clean up timeout if observer resolves first
    observer.callback = () => {
      // This is a no-op; actual logic is in the observer callback above
      // The real cleanup happens in the resolve/reject paths
    };
  });
}

/**
 * Wait for an element to appear in the DOM.
 *
 * @param {string} selector - CSS selector for the element
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<Element|null>} The found element, or null if timeout
 */
async function waitForElement(selector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    return await waitForDomChange(() => document.querySelector(selector), {
      ...options,
      timeoutMs,
    });
  } catch (err) {
    return null;
  }
}

/**
 * Wait for an element to be added to the DOM (throws on timeout).
 *
 * @param {string} selector - CSS selector for the element
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<Element>} The found element
 * @throws {Error} If element not found within timeout
 */
async function waitForElementAdded(selector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  return waitForDomChange(
    () => {
      const el = document.querySelector(selector);
      if (!el) return false;
      // Element exists and is connected to DOM
      return el.isConnected ? el : false;
    },
    { ...options, timeoutMs },
  );
}

/**
 * Wait for an element to be removed from the DOM.
 *
 * @param {string} selector - CSS selector for the element
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<boolean>} True when element is gone
 */
async function waitForElementGone(selector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  return waitForDomChange(() => !document.querySelector(selector), { ...options, timeoutMs });
}

/**
 * Wait for an element's attribute to have a specific value.
 *
 * @param {string} selector - CSS selector for the element
 * @param {string} attributeName - Attribute to watch
 * @param {string|Function} expectedValue - Expected value or predicate function
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<string>} The attribute value when matched
 */
async function waitForAttribute(selector, attributeName, expectedValue, options = {}) {
  const isFunc = typeof expectedValue === 'function';
  const timeoutMs = options.timeoutMs ?? 5000;

  return waitForDomChange(
    () => {
      const el = document.querySelector(selector);
      if (!el) return false;

      const value = el.getAttribute(attributeName);
      if (isFunc) {
        return expectedValue(value) ? value : false;
      }
      return value === expectedValue ? value : false;
    },
    {
      ...options,
      timeoutMs,
      observeOptions: { attributes: true, subtree: true },
    },
  );
}

/**
 * Wait for an element to have a specific class.
 *
 * @param {string} selector - CSS selector for the element
 * @param {string} className - Class name to wait for
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<boolean>} True when class is present
 */
async function waitForClass(selector, className, options = {}) {
  return waitForAttribute(selector, 'class', (cls) => cls && cls.includes(className), options);
}

/**
 * Wait for an element to be visible (has dimensions and not display:none).
 *
 * @param {string} selector - CSS selector for the element
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<Element>} The visible element
 */
async function waitForVisible(selector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  return waitForDomChange(
    () => {
      const el = document.querySelector(selector);
      if (!el) return false;

      const style = window.getComputedStyle(el);
      const isVisible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        el.offsetWidth > 0 &&
        el.offsetHeight > 0;

      return isVisible ? el : false;
    },
    { ...options, timeoutMs, observeOptions: { attributes: true, childList: true, subtree: true } },
  );
}

/**
 * Wait for an element to be hidden (display:none or visibility:hidden).
 *
 * @param {string} selector - CSS selector for the element
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<boolean>} True when element is hidden
 */
async function waitForHidden(selector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  return waitForDomChange(
    () => {
      const el = document.querySelector(selector);
      if (!el) return true; // Element is gone = hidden

      const style = window.getComputedStyle(el);
      const isHidden =
        style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';

      return isHidden;
    },
    { ...options, timeoutMs, observeOptions: { attributes: true, childList: true, subtree: true } },
  );
}

/**
 * Wait for text content to appear in an element.
 *
 * @param {string} selector - CSS selector for the element
 * @param {string|RegExp|Function} text - Text to wait for
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<string>} The matched text
 */
async function waitForText(selector, text, options = {}) {
  const isFunction = typeof text === 'function';
  const isRegex = text instanceof RegExp;
  const timeoutMs = options.timeoutMs ?? 5000;

  return waitForDomChange(
    () => {
      const el = document.querySelector(selector);
      if (!el) return false;

      const content = el.textContent || '';
      if (isFunction) {
        return text(content) ? content : false;
      }
      if (isRegex) {
        return text.test(content) ? content : false;
      }
      return content.includes(text) ? content : false;
    },
    {
      ...options,
      timeoutMs,
      observeOptions: { characterData: true, childList: true, subtree: true },
    },
  );
}

// ============================================
// Modal-Specific Utilities
// ============================================

/**
 * Wait for a modal dialog to open (appear in DOM).
 *
 * @param {string} modalSelector - CSS selector for the modal
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<Element>} The opened modal element
 */
async function waitForModalOpen(modalSelector, options = {}) {
  return waitForElementAdded(modalSelector, options);
}

/**
 * Wait for a modal dialog to close (removed from DOM or hidden).
 *
 * @param {string} modalSelector - CSS selector for the modal
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<boolean>} True when modal is closed
 */
async function waitForModalClose(modalSelector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;

  // First try: check if element is gone
  const elementGone = await waitForElementGone(modalSelector, {
    ...options,
    timeoutMs: Math.min(timeoutMs, 2000),
  });
  if (elementGone) return true;

  // Second try: check if element is hidden
  return waitForHidden(modalSelector, { ...options, timeoutMs: timeoutMs - 2000 });
}

/**
 * Wait for a select element's value to change to the expected value.
 *
 * @param {string} selectSelector - CSS selector for the select element
 * @param {string} expectedValue - Expected option value
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<string>} The selected value
 */
async function waitForSelectValue(selectSelector, expectedValue, options = {}) {
  return waitForAttribute(selectSelector, 'value', expectedValue, options);
}

// ============================================
// Shadow DOM Utilities
// ============================================

/**
 * Wait for an element in Shadow DOM to appear.
 *
 * @param {string} hostSelector - CSS selector for the shadow host
 * @param {string} shadowSelector - CSS selector within shadow DOM
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<Element|null>} The found element in shadow DOM
 */
async function waitForShadowElement(hostSelector, shadowSelector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  try {
    return await waitForDomChange(
      () => {
        const host = document.querySelector(hostSelector);
        if (!host || !host.shadowRoot) return false;
        return host.shadowRoot.querySelector(shadowSelector);
      },
      { ...options, timeoutMs },
    );
  } catch (err) {
    return null;
  }
}

/**
 * Wait for an element in nested Shadow DOM (double-shadow).
 *
 * @param {string[]} hostSelectors - Array of selectors for each shadow host level
 * @param {string} targetSelector - Final selector within deepest shadow DOM
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<Element|null>} The found element
 */
async function waitForNestedShadowElement(hostSelectors, targetSelector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;

  return waitForDomChange(
    () => {
      let current = document;

      for (const selector of hostSelectors) {
        if (current instanceof Document) {
          current = current.querySelector(selector);
        } else if (current instanceof HTMLElement && current.shadowRoot) {
          current = current.shadowRoot.querySelector(selector);
        }
        if (!current) return false;
      }

      if (current instanceof HTMLElement && current.shadowRoot) {
        return current.shadowRoot.querySelector(targetSelector);
      }
      return false;
    },
    { ...options, timeoutMs },
  );
}

/**
 * Wait for an element in Shadow DOM to be hidden (not found or display:none).
 *
 * @param {string} hostSelector - CSS selector for the shadow host
 * @param {string} shadowSelector - CSS selector within shadow DOM
 * @param {Object} options - waitForDomChange options
 * @returns {Promise<boolean>} True when element is hidden/not found
 */
async function waitForShadowElementHidden(hostSelector, shadowSelector, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  return waitForDomChange(
    () => {
      const host = document.querySelector(hostSelector);
      if (!host || !host.shadowRoot) return true; // Host gone = hidden
      const el = host.shadowRoot.querySelector(shadowSelector);
      if (!el) return true; // Element not found = hidden

      // Check if element is hidden via styles
      const style = window.getComputedStyle(el);
      const isHidden =
        style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      return isHidden;
    },
    { ...options, timeoutMs },
  );
}

// ============================================
// Export
// ============================================

const domObservationUtils = {
  waitForDomChange,
  waitForElement,
  waitForElementAdded,
  waitForElementGone,
  waitForAttribute,
  waitForClass,
  waitForVisible,
  waitForHidden,
  waitForText,
  waitForModalOpen,
  waitForModalClose,
  waitForSelectValue,
  waitForShadowElement,
  waitForNestedShadowElement,
  waitForShadowElementHidden,
};

// Export to window for E2E testing
if (typeof window !== 'undefined') {
  window.__domObservation__ = domObservationUtils;
}

// Also export as module for bundlers
if (typeof module !== 'undefined' && module.exports) {
  module.exports = domObservationUtils;
}
