# ws_read 使用场景

## 场景 1：查看目录结构

### 场景描述

查看项目目录结构。

### 示例

```typescript
list_dir({
  path: 'dominds',
});
```

## 场景 2：读取文件内容

### 场景描述

读取特定文件的内容。

### 示例

```typescript
read_file({
  path: 'dominds/docs/README.md',
});

// 读取部分内容
read_file({
  path: 'dominds/docs/README.md',
  range: '1~50',
});
```

## 场景 3：搜索代码

### 场景描述

在代码中搜索特定内容。

### 示例

```typescript
// 搜索包含 "TODO" 的文件
ripgrep_files({
  pattern: 'TODO',
  path: 'dominds',
});

// 搜索并显示片段
ripgrep_snippets({
  pattern: 'TODO',
  path: 'dominds',
  context_after: 2,
});
```

## 场景 4：统计匹配数量

### 场景描述

统计匹配出现的次数。

### 示例

```typescript
ripgrep_count({
  pattern: 'function',
  path: 'dominds/main',
});
```

## 场景 5：固定字符串搜索

### 场景描述

搜索精确的字符串。

### 示例

```typescript
ripgrep_fixed({
  literal: 'TODO:',
  path: 'dominds',
});
```

## 场景 6：按文件类型搜索

### 场景描述

在特定类型的文件中搜索。

### 示例

```typescript
ripgrep_files({
  pattern: 'TODO',
  path: 'dominds',
  globs: ['*.ts', '*.tsx'],
});
```

## 场景 7：代码审查

### 场景描述

查找特定代码模式进行审查。

### 示例

```typescript
// 查找所有 console.log
ripgrep_snippets({
  pattern: 'console\\.log',
  path: 'dominds',
  context_before: 1,
  context_after: 1,
});
```
