# ws_mod 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景分类

| 场景               | 推荐工具                | 说明                 |
| ------------------ | ----------------------- | -------------------- |
| 我想查看文件内容   | `read_file`             | 带行号装饰，可选范围 |
| 我想搜索定位       | `ripgrep_snippets`      | 按关键词定位锚点     |
| 我想创建新文件     | `create_new_file`       | 允许空内容           |
| 我想覆盖整个文件   | `overwrite_entire_file` | 需要提供旧文件快照   |
| 我想小改几行       | `file_range_edit`       | 按精确行号范围直接写 |
| 我想在文件末尾追加 | `file_append`           | 追加到 EOF           |
| 我想在某行后插入   | `file_insert_after`     | 按锚点插入           |
| 我想在某行前插入   | `file_insert_before`    | 按锚点插入           |
| 我想替换整块内容   | `file_block_replace`    | 双锚点块替换         |

## 复制即用示例

### 末尾追加

```text
Call the function tool `file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\n- Use file_range_edit for precise ranges; use file_block_replace for anchor-delimited blocks.\n" }
```

### 行号范围替换

`content` 可为空字符串表示删除：

```text
Call the function tool `file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\nNew line 11\n" }
```

### 锚点后插入

```text
Call the function tool `file_insert_after` with:
{ "path": "config.yaml", "anchor": "database:", "content": "  host: localhost\n  port: 5432\n" }
```

### 锚点前插入

```text
Call the function tool `file_insert_before` with:
{ "path": "config.yaml", "anchor": "---", "content": "# Configuration\n" }
```

### 双锚点块替换

```text
Call the function tool `file_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\nNEW BLOCK LINE 2\n" }
```

### 创建空文件

```text
Call the function tool `create_new_file` with:
{ "path": "new-dir/new-file.md", "content": "" }
```

### 整文件覆盖

```text
Call the function tool `read_file` with:
{ "path": "README.md" }
```

然后用返回的 `total_lines` 和 `size_bytes`：

```text
Call the function tool `overwrite_entire_file` with:
{ "path": "README.md", "content": "# New Content\n...", "known_old_total_lines": 42, "known_old_total_bytes": 1234 }
```

## 选择工具的决策树

1. **是否要创建新文件？**
   - 是 → `create_new_file`
   - 否 → 继续

2. **是否要完全覆盖旧内容？**
   - 是 → `read_file` 获取快照 → `overwrite_entire_file`
   - 否 → 继续

3. **是否知道具体行号？**
   - 是 → `file_range_edit`
   - 否 → 继续

4. **是否可以用锚点定位？**
   - 是 → 根据场景选择 `file_insert_after/before` 或 `file_block_replace`
   - 否 → 考虑用 `ripgrep_snippets` 先定位锚点
