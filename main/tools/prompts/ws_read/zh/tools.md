### 工具列表

#### 1. list_dir

列出目录内容。

**参数：**

- `path`（可选）：目录路径（默认当前目录）

**返回：**

```yaml
status: ok|error
path: <目录路径>
entries:
  - name: <文件名>
    type: <file|dir>
    size: <大小>
    modified: <修改时间>
```

#### 2. read_file

读取文件内容。

**参数：**

- `path`（必需）：文件路径
- `max_lines`（可选）：最大行数（默认 500）
- `range`（可选）：行范围（如 "10~50"）
- `show_linenos`（可选）：是否显示行号（默认 true）

**返回：**

```yaml
status: ok
path: <文件路径>
total_lines: <总行数>
size_bytes: <文件大小>
content: |
  <文件内容>
```

#### 3. ripgrep_files

搜索包含匹配的文件。

**参数：**

- `pattern`（必需）：搜索模式
- `path`（可选）：搜索路径
- `globs`（可选）：文件过滤模式
- `case`（可选）：大小写模式

**返回：**

```yaml
status: ok
pattern: <搜索模式>
files_matched: <匹配文件数>
matches:
  - path: <文件路径>
```

#### 4. ripgrep_snippets

搜索并显示匹配片段。

**参数：**

- `pattern`（必需）：搜索模式
- `path`（可选）：搜索路径
- `context_before`（可选）：显示匹配前的行数
- `context_after`（可选）：显示匹配后的行数

**返回：**

```yaml
status: ok
pattern: <搜索模式>
matches:
  - path: <文件路径>
    line: <行号>
    content: <匹配内容>
```

#### 5. ripgrep_count

统计匹配数量。

**参数：**

- `pattern`（必需）：搜索模式
- `path`（可选）：搜索路径

**返回：**

```yaml
status: ok
pattern: <搜索模式>
counts:
  - path: <文件路径>
    count: <匹配数>
```

#### 6. ripgrep_fixed

固定字符串搜索。

**参数：**

- `literal`（必需）：搜索字符串
- `path`（可选）：搜索路径

**返回：**

```yaml
status: ok
literal: <搜索字符串>
matches: <匹配列表>
```

#### 7. ripgrep_search

使用 rg 高级搜索。

**参数：**

- `pattern`（必需）：搜索模式
- `path`（可选）：搜索路径
- `rg_args`（可选）：rg 额外参数

**返回：**

```yaml
status: ok
pattern: <搜索模式>
results: <搜索结果>
```

### YAML 输出契约

所有工具的输出都使用 YAML 格式，便于程序化处理：

- `status`：操作状态，`ok` 表示成功，`error` 表示失败
- 其他字段：具体操作的附加信息
