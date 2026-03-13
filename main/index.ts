/**
 * Module: index
 *
 * Narrow public import surface for early kernel-style consumers.
 *
 * This is not yet a full kernel/shell package split. Only symbols re-exported here
 * are intended as the first public contract; all other `main/**` paths remain private.
 */

export * from './apps-host/app-host-contract';
export * from './apps/app-json';
export * from './shared/evt';
export * from './shared/team_mgmt-manual';
export * from './shared/types/dialog';
export * from './shared/types/i18n';
export * from './shared/types/language';
export * from './shared/types/problems';
export * from './shared/types/q4h';
export * from './shared/types/run-state';
export * from './shared/types/setup';
export * from './shared/types/snippets';
export * from './shared/types/storage';
export * from './shared/types/tools-registry';
export * from './shared/types/wire';
export * from './shared/utils/time';
