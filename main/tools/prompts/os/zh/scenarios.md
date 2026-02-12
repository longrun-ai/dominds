# os 使用场景

## 场景 1：文件操作

### 场景描述

使用 Shell 命令进行文件操作。

### 示例

```typescript
// 列出目录内容
shell_cmd({
  command: 'ls -la',
});

// 创建目录
shell_cmd({
  command: 'mkdir -p /path/to/directory',
});

// 查看文件内容
shell_cmd({
  command: 'cat /path/to/file',
});
```

## 场景 2：Git 操作

### 场景描述

使用 Git 进行版本控制操作。

### 示例

```typescript
// 查看 Git 状态
shell_cmd({
  command: 'git status',
});

// 创建提交
shell_cmd({
  command: "git add -A && git commit -m 'Update docs'",
});

// 查看提交历史
shell_cmd({
  command: 'git log --oneline -10',
});
```

## 场景 3：进程管理

### 场景描述

管理长时间运行的进程。

### 示例

```typescript
// 查看运行中的进程
shell_cmd({
  command: 'ps aux | grep node',
});

// 停止特定进程
shell_cmd({
  command: 'kill -TERM <pid>',
});
```

## 场景 4：环境变量操作

### 场景描述

管理环境变量。

### 示例

```typescript
// 查看所有环境变量
env_get({
  key: 'PATH',
});

// 设置项目环境变量
env_set({
  key: 'NODE_ENV',
  value: 'production',
});

// 删除环境变量
env_unset({
  key: 'DEBUG',
});
```

## 场景 5：构建和测试

### 场景描述

执行项目构建和测试。

### 示例

```typescript
// 安装依赖
shell_cmd({
  command: 'pnpm install',
});

// 运行构建
shell_cmd({
  command: 'pnpm build',
});

// 运行测试
shell_cmd({
  command: 'pnpm test',
});
```

## 场景 6：守护进程管理

### 场景描述

启动和管理守护进程。

### 示例

```typescript
// 注意：守护进程管理需要特定接口
// 获取守护进程状态
get_daemon_output({
  pid: 12345,
});

// 停止守护进程
stop_daemon({
  pid: 12345,
});
```

## 场景 7：系统信息

### 场景描述

获取系统信息。

### 示例

```typescript
// 查看系统版本
shell_cmd({
  command: 'uname -a',
});

// 查看磁盘空间
shell_cmd({
  command: 'df -h',
});

// 查看内存使用
shell_cmd({
  command: 'free -m',
});
```
