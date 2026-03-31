/**
 * Module: tool
 *
 * Tool type definitions and argument validation helpers.
 * Dominds tools are function tools (`func`) only.
 *
 * NOTE: "tellask" is reserved for teammate tellasks / dialog orchestration and is
 * not a tool type.
 */
import type {
  JsonArray as KernelJsonArray,
  JsonObject as KernelJsonObject,
  JsonPrimitive as KernelJsonPrimitive,
  JsonSchema as KernelJsonSchema,
  JsonValue as KernelJsonValue,
  ReminderUpdateResult as KernelReminderUpdateResult,
  ToolArguments as KernelToolArguments,
  ToolCallOutput as KernelToolCallOutput,
} from '@longrun-ai/kernel/app-json';
import type { I18nText } from '@longrun-ai/kernel/types/i18n';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import type { Dialog } from './dialog';
import type { ChatMessage } from './llm/client';
import { Team } from './team';

export type JsonPrimitive = KernelJsonPrimitive;

export type JsonValue = KernelJsonValue;

export type JsonObject = KernelJsonObject;

export type JsonArray = KernelJsonArray;

export type ToolArguments = KernelToolArguments;

// Full JSON Schema (passthrough) shape used by MCP tools and supported LLM providers.
// Dominds does not attempt to statically model every JSON Schema keyword at the type level.
export type JsonSchema = KernelJsonSchema;

export interface FuncTool {
  readonly type: 'func';
  readonly name: string;
  readonly description?: string;
  readonly descriptionI18n?: I18nText;
  // JSON Schema for parameters of this tool
  readonly parameters: JsonSchema;
  // How the driver validates function-tool arguments before invoking the tool.
  // - 'dominds': validate using Dominds' built-in minimal validator (best-effort).
  // - 'passthrough': accept any JSON object (used by MCP tools).
  readonly argsValidation?: 'dominds' | 'passthrough';
  // args is a structured object adhering to parameters schema
  call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput>;
}

export type Tool = FuncTool;

export type ToolCallOutput = KernelToolCallOutput;

export interface ReminderOptions {
  readonly echoback?: boolean;
  readonly scope?: ReminderScope;
}

export type ReminderScope = 'dialog' | 'agent_shared';

export type ReminderPriority = 'high' | 'medium' | 'low';

// Reminder-related interfaces
export interface Reminder extends ReminderOptions {
  readonly id: string;
  readonly content: string;
  // `owner.name` is the only stable identity that survives persistence and rehydration.
  // Framework code may route by owner name, but must not depend on owner object identity.
  readonly owner?: ReminderOwner;
  // Owner metadata is an opaque black box to Dominds framework code.
  // The framework may persist/transport it, but must not inspect or reinterpret it
  // unless it has first established that the reminder belongs to that owner.
  readonly meta?: JsonValue;
  readonly createdAt?: string;
  readonly priority?: ReminderPriority;
}

export function reminderEchoBackEnabled(reminder: Reminder): boolean {
  return reminder.echoback !== false;
}

export function reminderIsVirtual(reminder: Reminder): boolean {
  return !reminderEchoBackEnabled(reminder);
}

export function reminderIsListed(reminder: Reminder): boolean {
  return reminderEchoBackEnabled(reminder);
}

export function generateReminderId(): string {
  let id = '';
  while (id.length < 8) {
    id += generateShortId();
  }
  return id.slice(0, 8);
}

function ensureReminderId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : generateReminderId();
}

export function materializeReminder(
  input: Readonly<{
    id?: string;
    content: string;
    owner?: ReminderOwner;
    meta?: JsonValue;
    echoback?: boolean;
    scope?: ReminderScope;
    createdAt?: string;
    priority?: ReminderPriority;
  }>,
): Reminder {
  return {
    id: ensureReminderId(input.id),
    content: input.content,
    owner: input.owner,
    meta: input.meta,
    echoback: input.echoback,
    scope: input.scope ?? 'dialog',
    createdAt: input.createdAt,
    priority: input.priority,
  };
}

export function cloneReminder(reminder: Reminder): Reminder {
  return materializeReminder({
    id: reminder.id,
    content: reminder.content,
    owner: reminder.owner,
    meta: reminder.meta,
    echoback: reminder.echoback,
    scope: reminder.scope,
    createdAt: reminder.createdAt,
    priority: reminder.priority,
  });
}

export function getReminderOwnerName(reminder: Pick<Reminder, 'owner'>): string | undefined {
  return reminder.owner?.name;
}

export function reminderOwnedBy(reminder: Reminder, owner: ReminderOwner | string): boolean {
  const ownerName = typeof owner === 'string' ? owner : owner.name;
  return getReminderOwnerName(reminder) === ownerName;
}

export type ReminderTreatment = 'drop' | 'keep' | 'update';

export type ReminderUpdateResult = KernelReminderUpdateResult;

export interface ReminderOwner {
  readonly name: string;
  // Reminder owners own the full meaning of their reminder metadata. Framework code must
  // treat owner metadata as opaque and only route by `owner.name`.
  // Called before LLM generation to update reminders owned by this tool
  updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult>;
  // Called to render a reminder from a dialog as a ChatMessage to show to ai
  renderReminder(dlg: Dialog, reminder: Reminder): Promise<ChatMessage>;
}

export function validateArgs(
  schema: JsonSchema,
  args: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!isRecord(args)) {
    return { ok: false, error: 'Arguments must be an object' };
  }

  if (Array.isArray(args)) {
    return { ok: false, error: 'Arguments must be an object' };
  }

  const schemaType = isRecord(schema) && 'type' in schema ? schema.type : undefined;
  if (schemaType !== undefined && schemaType !== 'object') {
    return { ok: false, error: 'Schema root must be an object' };
  }

  const propertiesValue =
    isRecord(schema) && 'properties' in schema ? schema.properties : undefined;
  const properties = isRecord(propertiesValue) ? (propertiesValue as Record<string, unknown>) : {};

  const requiredValue = isRecord(schema) && 'required' in schema ? schema.required : undefined;
  const required =
    Array.isArray(requiredValue) && requiredValue.every((v) => typeof v === 'string')
      ? new Set(requiredValue)
      : new Set<string>();

  const additionalPropertiesValue =
    isRecord(schema) && 'additionalProperties' in schema ? schema.additionalProperties : undefined;
  const allowAdditional =
    additionalPropertiesValue === false
      ? false
      : additionalPropertiesValue === true || additionalPropertiesValue === undefined
        ? true
        : true; // schema additionalProperties is allowed (not deeply validated)

  // required fields
  for (const key of required) {
    if (!(key in args)) return { ok: false, error: `Missing required field: ${key}` };
  }

  // validate each provided field
  for (const [key, value] of Object.entries(args)) {
    const propSchemaUnknown = properties[key];
    if (propSchemaUnknown === undefined) {
      if (!allowAdditional) {
        return { ok: false, error: `Unexpected field: ${key}` };
      }
      continue;
    }
    const res = validateValue(propSchemaUnknown, value, key);
    if (!res.ok) return res;
  }

  return { ok: true };
}

function isJsonPrimitiveValue(value: unknown): value is JsonPrimitive {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function formatJsonPrimitiveValue(value: JsonPrimitive): string {
  return JSON.stringify(value);
}

function describeShortValue(value: unknown): string {
  if (isJsonPrimitiveValue(value)) return formatJsonPrimitiveValue(value);
  if (Array.isArray(value)) return '[array]';
  if (typeof value === 'object' && value !== null) return '[object]';
  return JSON.stringify(value);
}

function formatEnumAllowedList(values: readonly JsonPrimitive[], maxShown: number): string {
  const shown = values.slice(0, Math.max(0, Math.floor(maxShown)));
  const shownText = shown.map((v) => formatJsonPrimitiveValue(v)).join(', ');
  const remaining = values.length - shown.length;
  if (remaining <= 0) return shownText;
  return shownText.length > 0
    ? `${shownText}, ... (+${remaining} more)`
    : `... (+${remaining} more)`;
}

function validateValue(
  schema: unknown,
  value: unknown,
  path: string,
): { ok: true } | { ok: false; error: string } {
  if (!isRecord(schema)) {
    // Unknown schema shape: don't block execution.
    return { ok: true };
  }

  // Best-effort const validation (only supports primitive const).
  // For complex/object const, keep permissive behavior.
  if ('const' in schema && isJsonPrimitiveValue(schema.const)) {
    const expected = schema.const;
    if (!isJsonPrimitiveValue(value) || value !== expected) {
      return {
        ok: false,
        error: `Field ${path} must be ${formatJsonPrimitiveValue(expected)}; got ${describeShortValue(value)}`,
      };
    }
  }

  // Best-effort enum validation (only supports primitive enums).
  // For complex/object enums, keep permissive behavior.
  if ('enum' in schema && Array.isArray(schema.enum)) {
    const enumValues = schema.enum;
    const allPrimitive = enumValues.every((v) => isJsonPrimitiveValue(v));
    if (allPrimitive) {
      const allowedValues = enumValues as JsonPrimitive[];
      const allowed = isJsonPrimitiveValue(value) && allowedValues.some((v) => v === value);
      if (!allowed) {
        const allowedText = formatEnumAllowedList(allowedValues, 10);
        return {
          ok: false,
          error: `Field ${path} must be one of ${allowedText}; got ${describeShortValue(value)}`,
        };
      }
    }
  }

  const typeValue = 'type' in schema ? schema.type : undefined;
  const schemaType =
    typeof typeValue === 'string'
      ? typeValue
      : Array.isArray(typeValue) && typeValue.every((t) => typeof t === 'string')
        ? typeValue
        : undefined;

  if (schemaType === undefined) {
    // Unknown/omitted type: permissive.
    return { ok: true };
  }

  const acceptsType = (t: string): boolean => {
    switch (t) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'null':
        return value === null;
      case 'array': {
        if (!Array.isArray(value)) return false;
        if (!('items' in schema)) return true;
        const itemsSchema = schema.items;
        if (itemsSchema === undefined) return true;
        if (Array.isArray(itemsSchema)) {
          // Tuple validation: validate corresponding indices when schema exists.
          for (let i = 0; i < Math.min(itemsSchema.length, value.length); i++) {
            const r = validateValue(itemsSchema[i], value[i], `${path}[${i}]`);
            if (!r.ok) return false;
          }
          return true;
        }
        for (let i = 0; i < value.length; i++) {
          const r = validateValue(itemsSchema, value[i], `${path}[${i}]`);
          if (!r.ok) return false;
        }
        return true;
      }
      case 'object': {
        if (!isRecord(value) || Array.isArray(value)) return false;
        const propsValue = 'properties' in schema ? schema.properties : undefined;
        const props = isRecord(propsValue) ? (propsValue as Record<string, unknown>) : {};
        const requiredValue = 'required' in schema ? schema.required : undefined;
        const required =
          Array.isArray(requiredValue) && requiredValue.every((v) => typeof v === 'string')
            ? new Set(requiredValue)
            : new Set<string>();
        const additionalPropertiesValue =
          'additionalProperties' in schema ? schema.additionalProperties : undefined;
        const allowAdditional =
          additionalPropertiesValue === false
            ? false
            : additionalPropertiesValue === true || additionalPropertiesValue === undefined
              ? true
              : true;
        for (const key of required) {
          if (!(key in value)) {
            return false;
          }
        }
        for (const [k, v] of Object.entries(value)) {
          const subSchema = props[k];
          if (subSchema === undefined) {
            if (!allowAdditional) return false;
            continue;
          }
          const r = validateValue(subSchema, v, `${path}.${k}`);
          if (!r.ok) return false;
        }
        return true;
      }
      default:
        return true;
    }
  };

  if (Array.isArray(schemaType)) {
    for (const t of schemaType) {
      if (acceptsType(t)) {
        return { ok: true };
      }
    }
    return { ok: false, error: `Field ${path} does not match expected type` };
  }

  if (!acceptsType(schemaType)) {
    return { ok: false, error: `Field ${path} does not match expected type` };
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
