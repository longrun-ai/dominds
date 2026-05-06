# resources 错误处理

- 缺少 `resourceId`：先调用 `list_resources`。
- 静态 resource 带了 `arguments`：移除 arguments。
- 模板 resource 缺少变量：按 `list_resources` 展示的变量补齐。
- 读取失败：检查 MCP server 状态与配置。
