# os 工具参考

## 模板（工具）

### 阅读方式

- "工具契约（Schema）" 为参数/返回的权威来源。

### 单工具字段顺序

1. 用途
2. 调用签名
3. 参数（参见 schema）
4. 前置条件
5. 成功信号
6. 失败/错误
7. 可直接执行示例
8. 常见误用

## 工具列表

### 1. shell_cmd

执行 Shell 命令。

**参数：**

- `command`（必需）：要执行的命令
- `shell`（可选）：执行时使用的 shell（默认：`bash`）
- `bufferSize`（可选）：滚动缓冲区保留的最大行数
- `timeoutSeconds`（可选）：超时秒数；超时后转为守护进程追踪

**返回：**

```yaml
status: ok|error
command: <执行的命令>
exit_code: <退出码>
stdout: <标准输出>
stderr: <标准错误>
executed_at: <执行时间戳>
```

### 2. stop_daemon

停止守护进程。

**参数：**

- `pid`（必需）：守护进程 PID（数字）

**返回：**

```yaml
status: ok|error
pid: <守护进程 PID>
stopped_at: <停止时间戳>
```

**错误：**

- `DAEMON_NOT_FOUND`：守护进程不存在
- `DAEMON_NOT_RUNNING`：守护进程未运行

### 3. get_daemon_output

获取守护进程输出。

**参数：**

- `pid`（必需）：守护进程 PID（数字）

**返回：**

```yaml
status: ok|error
pid: <守护进程 PID>
output: <进程输出>
retrieved_at: <获取时间戳>
```

### 4. env_get

获取环境变量。

**参数：**

- `key`（必需）：环境变量名称

**返回：**

```yaml
status: ok|error
key: <环境变量名称>
value: <环境变量值>
retrieved_at: <获取时间戳>
```

**错误：**

- `ENV_NOT_FOUND`：环境变量不存在

### 5. env_set

设置环境变量。

**参数：**

- `key`（必需）：环境变量名称
- `value`（必需）：环境变量值

**返回：**

```yaml
status: ok|error
key: <环境变量名称>
value: <环境变量值>
set_at: <设置时间戳>
```

### 6. env_unset

删除环境变量。

**参数：**

- `key`（必需）：环境变量名称

**返回：**

```yaml
status: ok|error
key: <环境变量名称>
unset_at: <删除时间戳>
```

## 使用示例

### 执行 Shell 命令

```typescript
shell_cmd({
  command: 'ls -la /home/user',
  timeoutSeconds: 10,
});
```

### 停止守护进程

```typescript
stop_daemon({
  pid: 12345,
});
```

### 获取守护进程输出

```typescript
get_daemon_output({
  pid: 12345,
});
```

### 获取环境变量

```typescript
env_get({
  key: 'PATH',
});
```

### 设置环境变量

```typescript
env_set({
  key: 'MY_VAR',
  value: 'hello',
});
```

### 删除环境变量

```typescript
env_unset({
  key: 'MY_VAR',
});
```

## YAML 输出契约

所有工具的输出都使用 YAML 格式，便于程序化处理：

- `status`：操作状态，`ok` 表示成功，`error` 表示失败
- 其他字段：具体操作的附加信息

错误时返回：

```yaml
status: error
error_code: <错误代码>
message: <错误消息>
```
