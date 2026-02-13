### Core Concepts

### 1. Runtime Workspace (rtws)

Runtime Workspace (rtws) is Dominds' runtime working directory, used for storing dialog-related files and data.

### 2. Read-Only Restriction

The ws_read toolset provides only read functionality, cannot modify or delete files.

**Advantages:**

- Avoid accidental operations causing file corruption
- Improve security
- Simplify permission management

### 3. Ripgrep Search

Ripgrep (rg) is an efficient text search tool, supporting regular expressions and various filtering options.

**Common options:**

- `-i`: Ignore case
- `-n`: Show line numbers
- `-l`: Show only filenames
- `-C`: Show context lines

### Tool Overview

| Tool             | Function                             |
| ---------------- | ------------------------------------ |
| list_dir         | List directory contents              |
| read_file        | Read file contents                   |
| ripgrep_files    | Search files containing matches      |
| ripgrep_snippets | Search and display matching snippets |
| ripgrep_count    | Count matches                        |
| ripgrep_fixed    | Fixed string search                  |
| ripgrep_search   | Advanced rg search                   |

### Best Practices

### 1. Directory Listing

- Use `list_dir` to view directory structure
- Understand project organization

### 2. File Reading

- Use `read_file` to view file contents
- Supports line numbers and line ranges

### 3. Content Searching

- Use `ripgrep_snippets` to find code locations
- Use `ripgrep_count` to count matches

### Limitations and Notes

1. Can only read files within rtws
2. Cannot write or delete files
3. Some system files may not be accessible
