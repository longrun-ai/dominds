/**
 * Module: shared/types/tellask
 *
 * Shared types for Tellask ("诉请") call blocks.
 * Kept in shared/types so both backend and webapp can depend on it.
 */

export type TellaskMalformedReason = 'missing_mention_prefix' | 'invalid_mention_id';

export type TellaskCallValidation =
  | { kind: 'valid'; firstMention: string }
  | { kind: 'malformed'; reason: TellaskMalformedReason };
