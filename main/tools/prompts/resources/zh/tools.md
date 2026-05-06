# resources 工具参考

### list_resources

列出可用 resources 与 resource templates。可选过滤参数：`serverId`、`query`、`kind`。

### fetch_resource

按 `resourceId` 读取资源。对于 `resource_template` 条目，需传入 `arguments`，并为
`list_resources` 展示的模板变量提供字符串值。
