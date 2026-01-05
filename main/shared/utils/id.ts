/**
 * Module: id
 *
 * Utility functions for generating short unique identifiers
 * Used across frontend and backend for msgId generation
 */

/// <reference types="node" />

/**
 * Generate a short random ID (6 characters)
 * Format: alphanumeric string derived from Math.random()
 * Used for: msgId (frontend), callId (backend)
 */
export function generateShortId(): string {
  return Math.random().toString(36).substring(2, 8);
}
