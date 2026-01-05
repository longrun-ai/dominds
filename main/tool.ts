/**
 * Module: tool
 *
 * Tool type definitions and argument validation helpers.
 * Supports function tools (`func`) and texting tools (`texter`).
 */
import type { Dialog } from './dialog';
import type { ChatMessage } from './llm/client';
import { Team } from './team';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type JsonObject = { [key: string]: JsonValue };

export type JsonArray = JsonValue[];

export type ToolArguments = JsonObject;

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  items?: JsonSchemaProperty; // for arrays
  properties?: Record<string, JsonSchemaProperty>; // for objects
  required?: string[]; // for nested objects
  additionalProperties?: boolean;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface FuncTool {
  readonly type: 'func';
  readonly name: string;
  readonly description?: string;
  // JSON Schema for parameters of this tool
  readonly parameters: JsonSchema;
  // args is a structured object adhering to parameters schema
  call(dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<string>;
}

export interface TextingTool {
  readonly type: 'texter';
  readonly name: string;
  readonly usageDescription: string;
  call(
    dlg: Dialog,
    caller: Team.Member,
    headLine: string,
    inputBody: string,
  ): Promise<TextingToolCallResult>;
  readonly backfeeding: boolean;
}

export type TextingToolCallResult =
  | {
      status: 'completed';
      result?: string;
      messages?: ChatMessage[];
    }
  | {
      status: 'failed';
      result: string;
      messages?: ChatMessage[];
    };

export type Tool = FuncTool | TextingTool;

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
  if (schema.type !== 'object') {
    return { ok: false, error: 'Schema root must be an object' };
  }
  if (!isRecord(args)) {
    return { ok: false, error: 'Arguments must be an object' };
  }

  if (Array.isArray(args)) {
    return { ok: false, error: 'Arguments must be an object' };
  }

  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const allowAdditional = schema.additionalProperties !== false; // default allow

  // required fields
  for (const key of required) {
    if (!(key in args)) return { ok: false, error: `Missing required field: ${key}` };
  }

  // validate each provided field
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) {
      if (!allowAdditional) {
        return { ok: false, error: `Unexpected field: ${key}` };
      }
      continue;
    }
    const res = validateValue(propSchema, value, key);
    if (!res.ok) return res;
  }

  return { ok: true };
}

function validateValue(
  schema: JsonSchemaProperty,
  value: unknown,
  path: string,
): { ok: true } | { ok: false; error: string } {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return { ok: false, error: `Field ${path} must be a string` };
      return { ok: true };
    case 'number':
      if (typeof value !== 'number') return { ok: false, error: `Field ${path} must be a number` };
      return { ok: true };
    case 'boolean':
      if (typeof value !== 'boolean')
        return { ok: false, error: `Field ${path} must be a boolean` };
      return { ok: true };
    case 'array':
      if (!Array.isArray(value)) return { ok: false, error: `Field ${path} must be an array` };
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const r = validateValue(schema.items, value[i], `${path}[${i}]`);
          if (!r.ok) return r;
        }
      }
      return { ok: true };
    case 'object':
      if (!isRecord(value) || Array.isArray(value)) {
        return { ok: false, error: `Field ${path} must be an object` };
      }
      const props = schema.properties || {};
      const required = new Set(schema.required || []);
      const allowAdditional = schema.additionalProperties !== false; // default allow
      for (const key of required) {
        if (!(key in value)) {
          return { ok: false, error: `Missing required field: ${path}.${key}` };
        }
      }
      for (const [k, v] of Object.entries(value)) {
        const subSchema = props[k];
        if (!subSchema) {
          if (!allowAdditional) return { ok: false, error: `Unexpected field: ${path}.${k}` };
          continue;
        }
        const r = validateValue(subSchema, v, `${path}.${k}`);
        if (!r.ok) return r;
      }
      return { ok: true };
    default:
      return { ok: false, error: `Unsupported schema type at ${path}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
