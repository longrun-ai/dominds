### Tool List

### 1. list_dir

List directory contents.

**Parameters:**

- `path` (optional): Directory path (default current directory)

**Returns:**

```yaml
status: ok|error
path: <directory path>
entries:
  - name: <file name>
    type: <file|dir>
    size: <size>
    modified: <modification time>
```

### 2. read_file

Read file contents.

**Parameters:**

- `path` (required): File path
- `max_lines` (optional): Maximum lines (default 500)
- `range` (optional): Line range (e.g., "10~50")
- `show_linenos` (optional): Show line numbers (default true)

**Returns:**

```yaml
status: ok
path: <file path>
total_lines: <total lines>
size_bytes: <file size>
content: |
  <file content>
```

### 3. ripgrep_files

Search files containing matches.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path
- `globs` (optional): File filter patterns
- `case` (optional): Case mode

**Returns:**

```yaml
status: ok
pattern: <search pattern>
files_matched: <matched file count>
matches:
  - path: <file path>
```

### 4. ripgrep_snippets

Search and display matching snippets.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path
- `context_before` (optional): Lines to show before match
- `context_after` (optional): Lines to show after match

**Returns:**

```yaml
status: ok
pattern: <search pattern>
matches:
  - path: <file path>
    line: <line number>
    content: <matching content>
```

### 5. ripgrep_count

Count matches.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path

**Returns:**

```yaml
status: ok
pattern: <search pattern>
counts:
  - path: <file path>
    count: <match count>
```

### 6. ripgrep_fixed

Fixed string search.

**Parameters:**

- `literal` (required): Search string
- `path` (optional): Search path

**Returns:**

```yaml
status: ok
literal: <search string>
matches: <match list>
```

### 7. ripgrep_search

Advanced rg search.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path
- `rg_args` (optional): Additional rg arguments

**Returns:**

```yaml
status: ok
pattern: <search pattern>
results: <search results>
```

### YAML Output Contract

All tool outputs use YAML format for programmatic processing:

- `status`: Operation status, `ok` for success, `error` for failure
- Other fields: Additional information for specific operations
