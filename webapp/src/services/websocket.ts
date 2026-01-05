/**
 * WebSocket Client Manager for Dominds WebUI
 * Handles connection management, message queuing, and protocol communication
 * Uses Pub/Sub Chan for event management
 */

import type { ConnectionState } from '@/services/store';
import { createPubChan, createSubChan, PubChan, SubChan } from '../shared/evt';
import type { ErrorMessage, WebSocketMessage } from '../shared/types';
import { getWebSocketUrl } from '../utils';
// StreamHandler removed - streaming is now handled directly by event type matching

// WebSocket Client Configuration
export interface WebSocketConfig {
  url: string;
  protocols?: string[];
  reconnectInterval: number;
  maxReconnectAttempts: number;
  heartbeatInterval: number;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private connectionState: ConnectionState = {
    status: 'disconnected',
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
  };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private messageId = 0;

  // PubChan instances for backend event management
  private backendEvtsChan: PubChan<WebSocketMessage> = createPubChan<WebSocketMessage>();
  private connPubChan: PubChan<ConnectionState> = createPubChan<ConnectionState>();

  constructor(config: WebSocketConfig) {
    this.config = config;
    this.generateMessageId = this.generateMessageId.bind(this);
  }

  /**
   * Connect to WebSocket server
   */
  public async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.debug('WebSocket already connected');
      return;
    }

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      console.debug('WebSocket connection already in progress');
      return;
    }

    this.updateConnectionState({ status: 'connecting' });

    try {
      const wsUrl = this.config.url.replace(/^http/, 'ws');
      this.ws = new WebSocket(wsUrl, this.config.protocols);

      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
      this.ws.onerror = this.handleError.bind(this);

      // Set connection timeout (reduced to 5 seconds)
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          console.warn('WebSocket connection timeout');
          this.handleError(new Error('Connection timeout'));
        }
      }, 5000);
    } catch (error) {
      console.error('❌ Failed to create WebSocket connection:', error);
      this.updateConnectionState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  public disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.updateConnectionState({ status: 'disconnected', reconnectAttempts: 0 });
  }

  /**
   * Send a raw message to the server
   */
  public sendRaw(message: { type: string; [key: string]: unknown }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected, cannot send message');
      return;
    }

    try {
      const jsonMessage = JSON.stringify(message);
      this.ws.send(jsonMessage);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }

  /**
   * Get current connection state
   */
  public getConnectionState(): ConnectionState {
    return { ...this.connectionState };
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // (Pub/Sub)Chan Management

  /**
   * Subscribe to backend events
   */
  public subscribeToBackendEvents(): SubChan<WebSocketMessage> {
    return createSubChan<WebSocketMessage>(this.backendEvtsChan);
  }

  public subscribeToConnectionState(): SubChan<ConnectionState> {
    return createSubChan<ConnectionState>(this.connPubChan);
  }

  // Private methods

  private handleOpen(): void {
    this.updateConnectionState({
      status: 'connected',
      lastConnected: new Date(),
      reconnectAttempts: 0,
    });
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: WebSocketMessage = JSON.parse(event.data);
      this.processMessage(message);
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.updateConnectionState({ status: 'disconnected' });

    // Attempt to reconnect unless it was a clean close (code 1000)
    if (event.code !== 1000) {
      console.warn('Abnormal close detected, scheduling reconnect');
      this.scheduleReconnect();
    }
  }

  private handleError(error: Event | Error): void {
    console.error('WebSocket error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown WebSocket error';
    this.updateConnectionState({
      status: 'error',
      error: errorMessage,
    });
  }

  private processMessage(message: WebSocketMessage): void {
    // Use (Pub/Sub)Chan for pub/sub event distribution
    // All dialog events are now sent directly as TypedDialogEvent (part of WebSocketMessage)
    const d = (message as { dialog?: { selfId?: unknown; rootId?: unknown } }).dialog;
    if (d && (typeof d.selfId !== 'string' || typeof d.rootId !== 'string')) {
      console.error('Invalid message dialog identifiers: selfId/rootId must be strings', message);
      return;
    }

    // Handle different message types with specialized handling
    switch (message.type) {
      case 'welcome':
        console.debug('Server welcome:', message.message);
        break;

      case 'error':
        const errorMsg: ErrorMessage = message;
        console.error('Server error:', errorMsg.message);
        console.error('Full error message:', JSON.stringify(message, null, 2));
        // Re-emit the error through the backend events channel for components to handle
        this.distributeMessage(message);
        break;

      default:
        this.distributeMessage(message);
        break;
    }
  }

  private distributeMessage(message: WebSocketMessage): void {
    // Distribute message to backend events channel
    this.backendEvtsChan.write(message);
  }

  private updateConnectionState(updates: Partial<ConnectionState>): void {
    const oldState = { ...this.connectionState };
    this.connectionState = { ...this.connectionState, ...updates };
    this.connPubChan.write({ ...this.connectionState });
  }

  private scheduleReconnect(): void {
    if (this.connectionState.reconnectAttempts >= this.connectionState.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.connectionState.reconnectAttempts), 30000);

    this.updateConnectionState({
      status: 'reconnecting',
      reconnectAttempts: this.connectionState.reconnectAttempts + 1,
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Generic retry wrapper with exponential backoff
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    operationName: string = 'operation',
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === maxRetries) {
          console.error(`${operationName} failed after ${maxRetries} attempts:`, lastError.message);
          throw new Error(`${operationName} failed: ${lastError.message}`);
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.warn(
          `${operationName} attempt ${attempt} failed, retrying in ${delay}ms:`,
          lastError.message,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  private generateMessageId(): string {
    return `msg_${++this.messageId}_${Date.now()}`;
  }
}

// Default WebSocket configuration
export const DEFAULT_WEBSOCKET_CONFIG: WebSocketConfig = {
  url: 'ws://localhost:5556',
  reconnectInterval: 5000,
  maxReconnectAttempts: 5,
  heartbeatInterval: 30000, // 30秒心跳间隔
};

// Singleton instance for global use
let globalWebSocketManager: WebSocketManager | null = null;

export function getWebSocketManager(config?: Partial<WebSocketConfig>): WebSocketManager {
  if (!globalWebSocketManager) {
    const finalConfig = {
      ...DEFAULT_WEBSOCKET_CONFIG,
      url: getWebSocketUrl(),
      ...config,
    };
    globalWebSocketManager = new WebSocketManager(finalConfig);
  }
  return globalWebSocketManager;
}
