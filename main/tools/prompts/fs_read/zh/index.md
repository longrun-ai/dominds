fs_read 是 Dominds 的本机文件系统只读工具集，用于读取和搜索 rtws 之外的文件：

- 目录查看
- 文件读取
- 符号链接检查
- 内容搜索

## 状态

- 状态：已实现
- 主要实现文件：
  - 工具实现：`dominds/main/tools/fs.ts`、`dominds/main/tools/txt.ts`、`dominds/main/tools/picture.ts`、`dominds/main/tools/ripgrep.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`

## 与 ws_read 的区别

`fs_read` 提供与 `ws_read` 相同的只读能力，但不要求路径必须位于 rtws 内。
