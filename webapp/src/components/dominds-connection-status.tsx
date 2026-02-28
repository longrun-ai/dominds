/**
 * Connection Status Indicator Component
 * Displays WebSocket connection status with visual indicators and controls
 */

import type { ConnectionStatus } from '@/services/store';
import { getUiStrings } from '../i18n/ui';
import { getWebSocketManager } from '../services/websocket.js';
import { normalizeLanguageCode, type LanguageCode } from '../shared/types/language';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';

export class DomindsConnectionStatus extends HTMLElement {
  private static readonly INITIAL_DISCONNECTED_GRACE_MS = 1200;
  private wsManager = getWebSocketManager();
  private reconnectButton: HTMLButtonElement | null = null;
  private uiLanguage: LanguageCode = 'en';
  private mountedAtMs = 0;
  private firstConnStateEventSeen = false;
  private initialStatusRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.mountedAtMs = Date.now();
    this.firstConnStateEventSeen = false;
    this.render();
    this.setupEventListeners();
    const raw = this.getAttribute('ui-language') || '';
    const parsed = normalizeLanguageCode(raw);
    this.uiLanguage = parsed ?? 'en';
    const initial = this.wsManager.getConnectionState();
    if (!this.hasAttribute('status')) {
      this.setAttribute('status', initial.status);
    }
    if (initial.error && !this.hasAttribute('error')) {
      this.setAttribute('error', initial.error);
    }
    this.updateDisplay();
    this.scheduleInitialStatusRefresh();
    const sub = this.wsManager.subscribeToConnectionState();
    (async () => {
      for await (const state of sub.stream()) {
        this.firstConnStateEventSeen = true;
        this.setAttribute('status', state.status);
        if (state.error) this.setAttribute('error', state.error);
        else this.removeAttribute('error');
      }
    })();
  }

  disconnectedCallback(): void {
    if (this.initialStatusRefreshTimer) {
      clearTimeout(this.initialStatusRefreshTimer);
      this.initialStatusRefreshTimer = null;
    }
  }

  static get observedAttributes(): string[] {
    return ['status', 'error', 'ui-language'];
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue !== newValue && this.shadowRoot) {
      if (name === 'ui-language') {
        const parsed = normalizeLanguageCode(newValue || '');
        this.uiLanguage = parsed ?? 'en';
      }
      this.updateDisplay();
    }
  }

  public render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;

    this.reconnectButton = this.shadowRoot.querySelector('#reconnect-btn');
  }

  public getStyles(): string {
    return `
      ${ICON_MASK_BASE_CSS}
      :host {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .status-container {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 9px;
        font-weight: 500;
        cursor: default;
        user-select: none;
        transition: all 0.2s ease;
      }

      .status-connected {
        background: var(--dominds-success-bg, #d4edda);
        color: var(--dominds-success, #155724);
        border: 1px solid var(--dominds-success-border, #c3e6cb);
      }

      .status-connecting {
        background: var(--dominds-warning-bg, #fff3cd);
        color: var(--dominds-warning, #856404);
        border: 1px solid var(--dominds-warning-border, #ffeaa7);
      }

      .status-disconnected {
        background: var(--dominds-danger-bg, #f8d7da);
        color: var(--dominds-danger, #721c24);
        border: 1px solid var(--dominds-danger-border, #f5c6cb);
      }

      .status-error {
        background: var(--dominds-danger-bg, #f8d7da);
        color: var(--dominds-danger, #721c24);
        border: 1px solid var(--dominds-danger-border, #f5c6cb);
      }

      .status-reconnecting {
        background: var(--dominds-info-bg, #cce7ff);
        color: var(--dominds-info, #004085);
        border: 1px solid var(--dominds-info-border, #99d1ff);
      }

      .status-indicator {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
        animation: pulse 2s infinite;
      }

      .indicator-connected {
        background: var(--dominds-success, #28a745);
      }

      .indicator-connecting {
        background: var(--dominds-warning, #ffc107);
        animation: pulse 1s infinite;
      }

      .indicator-disconnected {
        background: var(--dominds-danger, #dc3545);
      }

      .indicator-error {
        background: var(--dominds-danger, #dc3545);
        animation: pulse 0.5s infinite;
      }

      .indicator-reconnecting {
        background: var(--dominds-info, #007bff);
        animation: pulse 1.5s infinite;
      }

      @keyframes pulse {
        0%, 100% { 
          opacity: 1; 
          transform: scale(1);
        }
        50% { 
          opacity: 0.6; 
          transform: scale(1.1);
        }
      }

      .status-text {
        font-weight: 500;
        white-space: nowrap;
      }

      .status-details {
        font-size: 5px;
        opacity: 0.8;
        margin-left: 2px;
      }

      .reconnect-btn {
        margin-left: 5px;
        width: 16px;
        height: 16px;
        padding: 0;
        border: 1px solid currentColor;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        opacity: 0.7;
      }

      .reconnect-btn .icon-mask {
        width: 10px;
        height: 10px;
        --icon-mask: ${ICON_MASK_URLS.refresh};
      }

      .reconnect-btn:hover {
        opacity: 1;
        transform: scale(1.05);
      }

      .reconnect-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }

      .error-tooltip {
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: var(--dominds-danger, #721c24);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 5px;
        white-space: nowrap;
        z-index: 1000;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
        margin-bottom: 6px;
      }

      .error-tooltip::after {
        content: '';
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        border: 4px solid transparent;
        border-top-color: var(--dominds-danger, #721c24);
      }

      .status-container:hover .error-tooltip {
        opacity: 1;
      }

      .last-connected {
        font-size: 5px;
        opacity: 0.6;
        margin-left: 4px;
      }
    `;
  }

  public getHTML(): string {
    return `
      <div class="status-container" id="status-container">
        <div class="status-indicator" id="status-indicator"></div>
        <div class="status-text" id="status-text"></div>
        <div class="status-details" id="status-details"></div>
        <button class="reconnect-btn" id="reconnect-btn" title="Reconnect to server" aria-label="Reconnect to server">
          <span class="icon-mask" aria-hidden="true"></span>
        </button>
        <div class="error-tooltip" id="error-tooltip"></div>
      </div>
    `;
  }

  private setupEventListeners(): void {
    if (this.reconnectButton) {
      this.reconnectButton.addEventListener('click', () => this.handleReconnect());
    }
  }

  private updateDisplay(): void {
    if (!this.shadowRoot) {
      return;
    }

    const rawStatus = (this.getAttribute('status') as ConnectionStatus) || 'disconnected';
    const error = this.getAttribute('error') || '';
    const status = this.getDisplayStatus(rawStatus, error);

    const container = this.shadowRoot.querySelector('#status-container') as HTMLElement;
    const indicator = this.shadowRoot.querySelector('#status-indicator') as HTMLElement;
    const text = this.shadowRoot.querySelector('#status-text') as HTMLElement;
    const details = this.shadowRoot.querySelector('#status-details') as HTMLElement;
    const tooltip = this.shadowRoot.querySelector('#error-tooltip') as HTMLElement;

    if (!container || !indicator || !text || !details) {
      return;
    }

    // Update container classes
    container.className = `status-container status-${status}`;

    // Update indicator
    indicator.className = `status-indicator indicator-${status}`;

    // Update text and details
    const statusInfo = this.getStatusInfo(status);
    text.textContent = statusInfo.text;
    details.textContent = statusInfo.details;

    // Update reconnect button visibility and state
    if (this.reconnectButton) {
      const t = getUiStrings(this.uiLanguage);
      this.reconnectButton.title = t.connectionReconnectToServerTitle;
      this.reconnectButton.setAttribute('aria-label', t.connectionReconnectToServerTitle);
      this.reconnectButton.style.display =
        status === 'error' || status === 'disconnected' ? 'inline-flex' : 'none';
      this.reconnectButton.disabled = status === 'connecting' || status === 'reconnecting';
    }

    // Update error tooltip
    if (error && tooltip) {
      tooltip.textContent = error;
      tooltip.style.display = error ? 'block' : 'none';
    } else if (tooltip) {
      tooltip.style.display = 'none';
    }

    // Add additional visual feedback
    this.addVisualFeedback(status);
  }

  private scheduleInitialStatusRefresh(): void {
    if (this.initialStatusRefreshTimer) {
      clearTimeout(this.initialStatusRefreshTimer);
      this.initialStatusRefreshTimer = null;
    }
    this.initialStatusRefreshTimer = setTimeout(() => {
      this.initialStatusRefreshTimer = null;
      this.updateDisplay();
    }, DomindsConnectionStatus.INITIAL_DISCONNECTED_GRACE_MS + 20);
  }

  private getDisplayStatus(status: ConnectionStatus, error: string): ConnectionStatus {
    if (status !== 'disconnected') return status;
    if (error.trim() !== '') return status;
    if (this.firstConnStateEventSeen) return status;
    const elapsed = Date.now() - this.mountedAtMs;
    if (elapsed < DomindsConnectionStatus.INITIAL_DISCONNECTED_GRACE_MS) {
      return 'connecting';
    }
    return status;
  }

  private getStatusInfo(status: ConnectionStatus): { text: string; details: string } {
    const t = getUiStrings(this.uiLanguage);
    switch (status) {
      case 'connected':
        return {
          text: t.connectionConnected,
          details: '',
        };
      case 'connecting':
        return {
          text: t.connectionConnecting,
          details: '...',
        };
      case 'disconnected':
        return {
          text: t.connectionDisconnected,
          details: '',
        };
      case 'error':
        return {
          text: t.connectionError,
          details: t.connectionFailedDetails,
        };
      case 'reconnecting':
        return {
          text: t.connectionReconnecting,
          details: `(${this.getReconnectAttempts()}/5)`,
        };
      default:
        return {
          text: 'Unknown',
          details: '',
        };
    }
  }

  private getReconnectAttempts(): number {
    const state = this.wsManager.getConnectionState();
    return state.reconnectAttempts;
  }

  private addVisualFeedback(status: ConnectionStatus): void {
    if (!this.shadowRoot) return;

    const container = this.shadowRoot.querySelector('#status-container') as HTMLElement;
    if (!container) return;

    // Remove any existing animation classes
    container.classList.remove('shake', 'glow');

    switch (status) {
      case 'error':
        // Add shake animation for errors
        container.style.animation = 'shake 0.5s ease-in-out';
        setTimeout(() => {
          container.style.animation = '';
        }, 500);
        break;
      case 'connected':
        // Add glow effect for successful connection
        container.style.animation = 'glow 2s ease-in-out';
        setTimeout(() => {
          container.style.animation = '';
        }, 2000);
        break;
    }
  }

  private async handleReconnect(): Promise<void> {
    if (this.reconnectButton) {
      this.reconnectButton.disabled = true;
      this.reconnectButton.textContent = '⏳';
    }

    try {
      await this.wsManager.connect();
    } catch (error) {
      console.error('Manual reconnect failed:', error);
    } finally {
      // Reset button after a short delay
      setTimeout(() => {
        if (this.reconnectButton) {
          this.reconnectButton.disabled = false;
          this.reconnectButton.textContent = '🔄';
        }
      }, 1000);
    }
  }
}

// Register the custom element
if (!customElements.get('dominds-connection-status')) {
  customElements.define('dominds-connection-status', DomindsConnectionStatus);
}

// Add CSS animations to the document
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-4px); }
    75% { transform: translateX(4px); }
  }

  @keyframes glow {
    0%, 100% { box-shadow: 0 0 5px rgba(40, 167, 69, 0.3); }
    50% { box-shadow: 0 0 15px rgba(40, 167, 69, 0.6); }
  }
`;
document.head.appendChild(style);
