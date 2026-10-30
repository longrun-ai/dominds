### Tool List

### 1. list_dir

List directory contents.

**Parameters:**

- `path` (optional): Directory path (default current directory)

**Returns:**

Lists entries in a human-readable Markdown table, with filesystem details appropriate to each entry and any symlink notice. A failed listing is an explained failure, not an empty successful directory.

### 2. read_symlink

Read a symlink target without following it.

**Parameters:**

- `path` (required): Symlink path

**Returns:**

Reports the symlink path and its target without following that target. Inspect the actual result before treating a path as a regular file.

### 3. read_file

Read file contents.

**Parameters:**

- `path` (required): File path
- `max_lines` (optional): Maximum lines (default 500)
- `range` (optional): Line range (e.g., "10~50")
- `show_linenos` (optional): Show line numbers (default true)

**Returns:**

Returns a YAML header with file and displayed-line metadata, followed by Markdown explanation and a separate code block containing the selected text. The text is not a YAML `content` field. Check the range and truncation metadata before claiming that the whole file was read.

### 4. read_picture

Read a workspace image and attach it to the next LLM context as an image.

**Parameters:**

- `path` (required): Image path. Supported extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`

**Returns:**

Attaches the image to the next LLM context and returns information identifying the image/artifact. A text receipt is not a textual rendering of the image; use the attached image for visual inspection.

### 5. ripgrep_files

Search files containing matches.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path
- `globs` (optional): File filter patterns
- `case` (optional): Case mode

**Returns:**

Returns matched paths in `results`, with counts under `totals` and diagnostics describing limits or incomplete scope. For example, `totals.files_matched` is the count of matching files; no matches alone is not an execution failure.

### 6. ripgrep_snippets

Search and display matching snippets.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path
- `context_before` (optional): Lines to show before match
- `context_after` (optional): Lines to show after match

**Returns:**

Returns `results` containing file/line information, matching text and requested context, plus limits and diagnostics. Inspect the actual match and context fields instead of assuming the result is a full file.

### 7. ripgrep_count

Count matches.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path

**Returns:**

Returns per-file counts in `results`, with aggregate counts, limits and diagnostics. Report partial scope when some requested paths could not be inspected.

### 8. ripgrep_fixed

Fixed string search.

**Parameters:**

- `literal` (required): Search string
- `path` (optional): Search path

**Returns:**

Treats the input as a literal query and forwards to the selected result mode. The query is represented as `pattern` with fixed-string matching; the results follow the chosen files, snippets or count mode, rather than a separate universal `literal`/`matches` schema.

### 9. ripgrep_search

Advanced rg search.

**Parameters:**

- `pattern` (required): Search pattern
- `path` (optional): Search path
- `rg_args` (optional): Additional rg arguments

**Returns:**

Returns normalized snippets output with its counts, results, limits and diagnostics. Extra raw arguments remain subject to the wrapper's safety policy; they do not grant wider filesystem access.

### Reading Results

The examples above show selected fields; they are not complete output schemas for every tool.

- Read the tool outcome and any emitted `status`, `error`, limits and diagnostics before using the result. A search may report `partial_failure` when only part of the requested scope was inspected; no matches by itself is not an execution failure.
- `read_file` returns a structured YAML header followed by a Markdown explanation and the selected file content. Its read failures can be explanatory text rather than a universal YAML error record.
- Ripgrep tools commonly return a YAML code block with counts, results and diagnostics. Inspect truncation and partial-path failures before claiming that a search was exhaustive.
- Keep returned paths, ranges and counters with the evidence. Do not parse the entire mixed text as one YAML document or assume the same fields or error codes across tools.
