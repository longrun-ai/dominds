// Shared utility functions for the frontend

// Utility function to greet users
export function greet(name: string): string {
  return `Hello, ${name}! Welcome to Dominds.`;
}

// Utility function to get WebSocket URL
export function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const { hostname, port } = window.location;

  return `${protocol}//${hostname}${port ? `:${port}` : ''}/ws`;
}
