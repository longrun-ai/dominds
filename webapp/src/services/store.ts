/**
 * State Management Store for Dominds WebUI
 * Centralized state management with reactive updates and persistence
 */

// Frontend-only connection state types (moved from wire protocol)
export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnecting';

export interface ConnectionState {
  status: ConnectionStatus;
  lastConnected?: Date;
  error?: string;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'auto';
  language: string;
  notifications: boolean;
  compactMode: boolean;
  sidebarWidth: number;
}

export interface AppState {
  // Connection state (managed dynamically, no persistence)
  connection: ConnectionState;

  // Streaming state is handled directly by components via event types - no central tracking needed

  // Loading states (runtime only, not persisted)
  loading: {
    dialogs: boolean;
    messages: boolean;
    teamMembers: boolean;
  };

  // Error states (runtime only, not persisted)
  errors: {
    dialogs?: string;
    messages?: string;
    teamMembers?: string;
    connection?: string;
  };

  // UI settings (only settings that should persist locally)
  settings: AppSettings;
}

export type StoreSubscriber<T> = (state: T, prevState: T) => void;
export type StoreSelector<T, R> = (state: T) => R;
export type StoreUpdater<T> = (state: T) => Partial<T> | T | void;

class Store<T extends Record<string, any>> {
  private state: T;
  private subscribers: Set<StoreSubscriber<T>> = new Set();
  private history: T[] = [];
  private maxHistorySize = 50;

  constructor(initialState: T) {
    this.state = this.cloneState(initialState);
  }

  /**
   * Get current state
   */
  public getState(): Readonly<T> {
    return this.state;
  }

  /**
   * Get a specific part of the state using a selector
   */
  public get<R>(selector: StoreSelector<T, R>): R {
    return selector(this.state);
  }

  /**
   * Subscribe to state changes
   */
  public subscribe(subscriber: StoreSubscriber<T>): () => void {
    this.subscribers.add(subscriber);

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Update state with a function
   */
  public update(updater: StoreUpdater<T>): void {
    const prevState = this.cloneState(this.state);
    const updates = updater(this.state);

    if (updates && typeof updates === 'object') {
      this.state = this.mergeStates(this.state, updates as Partial<T>);
      this.notifySubscribers(prevState);
    }
  }

  /**
   * Set state directly (for simple updates)
   */
  public set(partialState: Partial<T>): void {
    const prevState = this.cloneState(this.state);
    this.state = this.mergeStates(this.state, partialState);
    this.notifySubscribers(prevState);
  }

  /**
   * Replace entire state
   */
  public replace(newState: T): void {
    const prevState = this.cloneState(this.state);
    this.state = this.cloneState(newState);
    this.notifySubscribers(prevState);
  }

  /**
   * Reset to initial state
   */
  public reset(initialState: T): void {
    const prevState = this.cloneState(this.state);
    this.state = this.cloneState(initialState);
    this.history = [];
    this.notifySubscribers(prevState);
  }

  /**
   * Get state history for undo/redo functionality
   */
  public getHistory(): Readonly<T>[] {
    return [...this.history];
  }

  /**
   * Undo last change
   */
  public undo(): boolean {
    if (this.history.length === 0) return false;

    const prevState = this.cloneState(this.state);
    this.state = this.history.pop()!;
    this.notifySubscribers(prevState);
    return true;
  }

  /**
   * Get computed value (memoized selector)
   */
  public compute<R>(selector: StoreSelector<T, R>, dependencies: any[] = []): R {
    // Simple dependency tracking - in a real implementation you'd want
    // more sophisticated change detection
    return selector(this.state);
  }

  /**
   * Private helper methods
   */
  private notifySubscribers(prevState: T): void {
    // Save to history
    this.history.push(prevState);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    // Notify all subscribers
    this.subscribers.forEach((subscriber) => {
      try {
        subscriber(this.state, prevState);
      } catch (error) {
        console.error('Error in store subscriber:', error);
      }
    });
  }

  private cloneState(state: T): T {
    return JSON.parse(JSON.stringify(state));
  }

  private mergeStates(current: T, updates: Partial<T>): T {
    const merged = { ...current };

    for (const key in updates) {
      if (updates.hasOwnProperty(key)) {
        const currentValue = current[key];
        const updateValue = updates[key];

        // Deep merge for objects, shallow for primitives
        if (this.isObject(currentValue) && this.isObject(updateValue)) {
          (merged as any)[key] = this.mergeStates(currentValue as any, updateValue as any);
        } else {
          (merged as any)[key] = updateValue;
        }
      }
    }

    return merged;
  }

  private isObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}

// Default application state
const createDefaultState = (): AppState => ({
  connection: {
    status: 'disconnected',
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
  },

  settings: {
    theme: 'auto',
    language: 'en',
    notifications: true,
    compactMode: false,
    sidebarWidth: 300,
  },

  loading: {
    dialogs: false,
    messages: false,
    teamMembers: false,
  },

  errors: {},
});

// Global store instance
let globalStore: Store<AppState> | null = null;

export function getStore(initialState?: Partial<AppState>): Store<AppState> {
  if (!globalStore) {
    const defaultState = createDefaultState();
    if (initialState) {
      globalStore = new Store({ ...defaultState, ...initialState });
    } else {
      globalStore = new Store(defaultState);
    }
  }
  return globalStore;
}

// Specialized store methods for common operations
export const storeActions = {
  // Connection actions
  setConnectionState: (store: Store<AppState>, connection: Partial<ConnectionState>) => {
    store.update((state) => ({
      connection: { ...state.connection, ...connection },
      errors: { ...state.errors, connection: undefined },
    }));
  },

  setConnectionError: (store: Store<AppState>, error: string) => {
    store.update((state) => ({
      errors: { ...state.errors, connection: error },
    }));
  },

  // Dialog and message actions removed - these should be managed via DOM and backend APIs

  // Streaming actions removed - streaming is now handled directly by components via event types
  // Team actions removed - should be managed via backend APIs

  updateSettings: (store: Store<AppState>, settings: Partial<AppSettings>) => {
    store.update((state) => ({
      settings: { ...state.settings, ...settings },
    }));
  },

  // Loading actions
  setLoading: (store: Store<AppState>, type: keyof AppState['loading'], loading: boolean) => {
    store.update((state) => ({
      loading: { ...state.loading, [type]: loading },
    }));
  },

  // Error actions
  setError: (store: Store<AppState>, type: keyof AppState['errors'], error: string | undefined) => {
    store.update((state) => ({
      errors: { ...state.errors, [type]: error },
    }));
  },

  // Search and filter actions removed - should be managed via DOM data attributes
};

// Utility hooks for common state selections
export const storeSelectors = {
  // Connection selectors
  isConnected: (state: AppState) => state.connection.status === 'connected',
  isConnecting: (state: AppState) =>
    state.connection.status === 'connecting' || state.connection.status === 'reconnecting',
  connectionStatus: (state: AppState) => state.connection.status,

  // Dialog and message selectors removed - should be managed via DOM and backend APIs

  // UI selectors
  theme: (state: AppState) => state.settings.theme,
  isLoading: (state: AppState) => Object.values(state.loading).some((loading) => loading),

  // Error selectors
  hasErrors: (state: AppState) => Object.values(state.errors).some((error) => error !== undefined),
};

// Persistence utilities - only persist settings, everything else restored from backend
export const storePersistence = {
  saveToLocalStorage: (store: Store<AppState>, key: string = 'dominds-app-state') => {
    try {
      const state = store.getState();
      // Only persist settings - no runtime state (connection, loading, errors) or streaming
      const persistedState = {
        settings: state.settings,
        connection: {
          // Only persist non-sensitive connection preferences
          status: 'disconnected', // Always start disconnected
          reconnectAttempts: 0,
          maxReconnectAttempts: state.connection.maxReconnectAttempts,
        },
      };
      localStorage.setItem(key, JSON.stringify(persistedState));
    } catch (error) {
      console.warn('Failed to save state to localStorage:', error);
    }
  },

  loadFromLocalStorage: (key: string = 'dominds-app-state'): Partial<AppState> | null => {
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only restore settings and basic connection config
        return {
          settings: parsed.settings,
          connection: {
            status: 'disconnected', // Always start disconnected
            reconnectAttempts: 0,
            maxReconnectAttempts: parsed.connection?.maxReconnectAttempts || 5,
          },
        };
      }
    } catch (error) {
      console.warn('Failed to load state from localStorage:', error);
    }
    return null;
  },

  clearFromLocalStorage: (key: string = 'dominds-app-state') => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn('Failed to clear state from localStorage:', error);
    }
  },
};

// Export the store class for advanced usage
export { Store };

// Default export with singleton instance
export default getStore();
