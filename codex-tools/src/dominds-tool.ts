export type ToolArguments = Readonly<Record<string, unknown>>;

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface FuncTool {
  readonly type: 'func';
  readonly name: string;
  readonly description?: string;
  readonly parameters: JsonSchema;
  call(dlg: unknown, caller: unknown, args: ToolArguments): Promise<string>;
}
