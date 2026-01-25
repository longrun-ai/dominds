/**
 * Module: tool
 *
 * Tool type definitions and argument validation helpers.
 * Dominds tools are function tools (`func`) only.
 *
 * NOTE: "tellask" is reserved for teammate tellasks / dialog orchestration and is
 * not a tool type.
 */
import type { Dialog } from './dialog';
import type { ChatMessage } from './llm/client';
import type { I18nText } from './shared/types/i18n';
import { Team } from './team';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type JsonObject = { [key: string]: JsonValue };

export type JsonArray = JsonValue[];

export type ToolArguments = JsonObject;

// Full JSON Schema (passthrough) shape used by MCP tools and supported LLM providers.
// Dominds does not attempt to statically model every JSON Schema keyword at the type level.
export type JsonSchema = Record<string, unknown>;

export interface FuncTool {
  readonly type: 'func';
  readonly name: string;
  readonly description?: string;
  readonly descriptionI18n?: I18nText;
  // JSON Schema for parameters of this tool
  readonly parameters: JsonSchema;
  // How the driver validates tool-call arguments before invoking the tool.
  // - 'dominds': validate using Dominds' built-in minimal validator (best-effort).
  // - 'passthrough': accept any JSON object (used by MCP tools).
  readonly argsValidation?: 'dominds' | 'passthrough';
  // args is a structured object adhering to parameters schema
  call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string>;
}

export type Tool = FuncTool;

// Reminder-related interfaces
export interface Reminder {
  readonly content: string;
  readonly owner?: ReminderOwner;
  readonly meta?: JsonValue;
}

export type ReminderTreatment = 'drop' | 'keep' | 'update';

export interface ReminderUpdateResult {
  treatment: ReminderTreatment;
  updatedContent?: string; // Required when treatment is 'update'
  updatedMeta?: JsonValue; // Optional when treatment is 'update'
}

export interface ReminderOwner {
  readonly name: string;
  // Called before LLM generation to update reminders owned by this tool
  updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult>;
  // Called to render a reminder from a dialog as a ChatMessage to show to ai
  renderReminder(dlg: Dialog, reminder: Reminder, index: number): Promise<ChatMessage>;
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

function validateValue(
  schema: unknown,
  value: unknown,
  path: string,
): { ok: true } | { ok: false; error: string } {
  if (!isRecord(schema)) {
    // Unknown schema shape: don't block execution.
    return { ok: true };
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
