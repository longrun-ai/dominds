import type { LanguageCode } from '../../shared/types/language';
import type { FuncTool } from '../../tool';

type JsonObject = Record<string, unknown>;

type JsonSchemaObject = JsonObject & {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
};

type JsonSchemaProperty = JsonObject & {
  type?: unknown;
  enum?: unknown;
  description?: unknown;
};

type SchemaField = {
  name: string;
  type: string;
  required: boolean;
  defaultValue: string;
  constraints: string;
  description: string;
};

type SchemaToolSpec = {
  name: string;
  description: string;
  fields: SchemaField[];
  requiredFields: string[];
};

const NO_DATA: Record<LanguageCode, string> = {
  en: '(none)',
  zh: '（无）',
};

const SCHEMA_TITLE: Record<LanguageCode, string> = {
  en: 'Generated Tool Contract (from schema)',
  zh: '自动生成的工具契约（来自 schema）',
};

const FIELD_HEADERS: Record<
  LanguageCode,
  readonly [name: string, type: string, required: string, defaultValue: string, constraints: string]
> = {
  en: ['Name', 'Type', 'Required', 'Default', 'Constraints'],
  zh: ['名称', '类型', '必填', '默认值', '约束'],
};

const REQUIRED_LABEL: Record<LanguageCode, string> = { en: 'yes', zh: '是' };
const OPTIONAL_LABEL: Record<LanguageCode, string> = { en: 'no', zh: '否' };

export function buildSchemaToolsSection(
  language: LanguageCode,
  tools: readonly FuncTool[],
): string {
  const lines: string[] = [`## ${SCHEMA_TITLE[language]}`, ''];
  const sortedSpecs = tools
    .map((tool) => describeTool(tool, language))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const spec of sortedSpecs) {
    lines.push(`### \`${spec.name}\``);
    if (spec.description !== '') {
      lines.push('');
      lines.push(spec.description);
    }

    const headers = FIELD_HEADERS[language];
    lines.push('');
    lines.push(`| ${headers[0]} | ${headers[1]} | ${headers[2]} | ${headers[3]} | ${headers[4]} |`);
    lines.push('| --- | --- | --- | --- | --- |');

    if (spec.fields.length === 0) {
      lines.push(
        `| ${NO_DATA[language]} | ${NO_DATA[language]} | ${OPTIONAL_LABEL[language]} | ${NO_DATA[language]} | ${NO_DATA[language]} |`,
      );
    } else {
      for (const field of spec.fields) {
        lines.push(
          `| \`${field.name}\` | \`${field.type}\` | ${field.required ? REQUIRED_LABEL[language] : OPTIONAL_LABEL[language]} | ${field.defaultValue} | ${field.constraints} |`,
        );
      }
    }

    lines.push('');
    lines.push(renderMinimalCallBlock(spec, language));
    lines.push('');
  }

  return trimTrailingBlankLines(lines).join('\n');
}

function describeTool(tool: FuncTool, language: LanguageCode): SchemaToolSpec {
  const schema = toSchemaObject(tool.parameters);
  const requiredSet = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === 'string')
      : [],
  );
  const properties = toObjectRecord(schema.properties);
  const fields: SchemaField[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const property = toSchemaProperty(value);
    fields.push({
      name,
      type: describeType(property.type),
      required: requiredSet.has(name),
      defaultValue: NO_DATA[language],
      constraints: describeConstraints(property, language),
      description: typeof property.description === 'string' ? property.description : '',
    });
  }

  const description = pickToolDescription(tool, language);
  return {
    name: tool.name,
    description,
    fields,
    requiredFields: [...requiredSet],
  };
}

function pickToolDescription(tool: FuncTool, language: LanguageCode): string {
  const localized = tool.descriptionI18n?.[language];
  if (typeof localized === 'string' && localized.trim() !== '') {
    return localized.trim();
  }
  if (typeof tool.description === 'string' && tool.description.trim() !== '') {
    return tool.description.trim();
  }
  return '';
}

function renderMinimalCallBlock(spec: SchemaToolSpec, language: LanguageCode): string {
  const goalTitle = language === 'zh' ? '目标' : 'Goal';
  const preconditionsTitle = language === 'zh' ? '前置条件' : 'Preconditions';
  const callTitle = language === 'zh' ? '调用' : 'Call';
  const expectedTitle = language === 'zh' ? '预期信号' : 'Expected Signal';
  const onFailureTitle = language === 'zh' ? '失败时' : 'On Failure';

  const args: Record<string, unknown> = {};
  for (const field of spec.requiredFields) {
    args[field] = `<${field}>`;
  }

  const lines: string[] = ['```text'];
  lines.push(`# ${goalTitle}`);
  lines.push(
    language === 'zh'
      ? `调用 \`${spec.name}\` 并验证最小参数契约。`
      : `Call \`${spec.name}\` with the minimum required arguments.`,
  );
  lines.push('');
  lines.push(`# ${preconditionsTitle}`);
  lines.push(
    language === 'zh'
      ? '确认当前成员具备该 toolset 访问权限。'
      : 'Ensure caller has access to this toolset.',
  );
  lines.push('');
  lines.push(`# ${callTitle}`);
  lines.push(
    language === 'zh'
      ? `按以下参数调用函数工具 \`${spec.name}\`：`
      : `Call the function tool \`${spec.name}\` with:`,
  );
  lines.push(JSON.stringify(args, null, 2));
  lines.push('');
  lines.push(`# ${expectedTitle}`);
  lines.push(
    language === 'zh'
      ? '返回 YAML/文本结果，且无参数校验错误。'
      : 'Returns YAML/text output without argument validation errors.',
  );
  lines.push('');
  lines.push(`# ${onFailureTitle}`);
  lines.push(
    language === 'zh'
      ? '检查缺失字段与字段类型，再按 schema 重试。'
      : 'Check missing fields and field types, then retry against the schema contract.',
  );
  lines.push('```');
  return lines.join('\n');
}

function describeType(typeValue: unknown): string {
  if (typeof typeValue === 'string' && typeValue.trim() !== '') {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    const out = typeValue.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (out.length > 0) {
      return out.join('|');
    }
  }
  return 'unknown';
}

function describeConstraints(property: JsonSchemaProperty, language: LanguageCode): string {
  const parts: string[] = [];
  if (Array.isArray(property.enum) && property.enum.length > 0) {
    const values = property.enum.map((v) => JSON.stringify(v)).join(', ');
    parts.push(`enum: ${values}`);
  }
  if (parts.length === 0) {
    return NO_DATA[language];
  }
  return parts.join('; ');
}

function toSchemaObject(value: unknown): JsonSchemaObject {
  return toObjectRecord(value) as JsonSchemaObject;
}

function toSchemaProperty(value: unknown): JsonSchemaProperty {
  return toObjectRecord(value) as JsonSchemaProperty;
}

function toObjectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') {
    end -= 1;
  }
  return lines.slice(0, end);
}
