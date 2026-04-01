# daemon runner 与可恢复 scrollback 设计

英文版：[English](./daemon-cmd-runner.md)

本文定义 `os` 工具中 daemon 机制的新设计，用于解决一个明确缺陷：Dominds 主进程异常退出并重启后，虽然还能凭 reminder 重新识别出先前的 daemon，但旧实现里的 stdout/stderr scrollback buffer 已经随主进程内存一起丢失，`get_daemon_output` 因而失效。

这次设计不做兼容层，也不保留双轨实现。目标不是“在现有内存态 tracking 上补丁式修复”，而是把 daemon 托管、scrollback 持有、日志读取、停止控制这一整条链路改成一套可以跨主进程重连恢复的机制。

本文是设计文档，不讨论具体代码拆分与实现排期。

---

## 目标

- 让 daemon 的 stdout/stderr scrollback 在 Dominds 主进程崩溃重启后仍可读取。
- 把 daemon 的真实 owner 从 Dominds 主进程迁移到独立 `cmd_runner` 进程。
- 统一短命令与长命令执行链路，避免“先由主进程跑，超时后再升级成 daemon”这种中途切换。
- 简化 `get_daemon_output` 工具契约，让一次调用即可同时看到 `stdout` 与 `stderr`。
- 明确 interactive stdin 当前不支持，避免命令误以为可从 Dominds 主进程终端读取输入。

## 非目标

- 本轮不引入 PTY。
- 本轮不提供“向 daemon stdin 喂数据”的工具 API。
- 本轮不设计跨机器、跨用户、跨宿主机的远程守护协议。
- 本轮不保留旧 reminder meta 与旧 daemon tracking 的兼容恢复路径。

---

## 核心结论

### 1. 采用 `1 daemon : 1 runner`

每一个通过 `shell_cmd` 进入 daemon 托管语义的命令，都由一个独立的 `cmd_runner` 进程负责：

- 创建目标 shell / command 子进程
- 持有该子进程的 `stdout` / `stderr` pipe
- 维护 scrollback buffer
- 对外提供状态查询、日志读取、停止请求

runner 与其托管的 daemon 绑定生死：

- daemon 正常退出，runner 随之退出
- daemon 被 `stop_daemon` 停止后，runner 也应退出
- runner 不做全局常驻服务，不做多 daemon 复用

这样做的意义是把“真正拥有日志流与滚动缓冲区的主体”从 Dominds 主进程中剥离出去。主进程即便崩溃，runner 只要还活着，日志查询能力就还在。

### 2. 所有 `shell_cmd` 一律从一开始就经由 runner 执行

不再允许以下旧路径：

- Dominds 主进程自己 `spawn`
- 主进程自己监听 `stdout` / `stderr`
- 运行超时后才把它“视作 daemon”

新设计下，不论命令最终是短命还是长命，都先由 runner 执行：

- 若命令在超时前结束，runner 汇总输出后直接返回结果并退出
- 若命令超时，则返回“已作为 daemon 启动”，同时写入 reminder meta，runner 继续托管该命令

这样才能保证 pipe ownership、scrollback owner、stop owner 始终一致。

### 3. Unix 下默认让 runner 成为 process group leader

runner 自己作为进程组 leader，daemon 默认继承该 pgid。这样 `stop_daemon` 的兜底清理可以直接面向整个进程组。

这不是说“优雅停止靠杀进程组”，而是：

- **优雅停止主路径：** runner 直接向 daemon pid 发信号
- **兜底清理：** 若 daemon 未在预期时间内退出，Dominds 主进程再面向整个 pg 杀一轮
- **逃逸容忍：** 如果 daemon 主动改了 pgid，允许它作为逃逸手段存在；此时兜底还应再补一轮直接面向 daemon pid 的 kill

---

## 总体结构

### 运行角色

有三个角色：

- **Dominds 主进程**
  - 处理工具调用
  - 维护 reminder
  - 在重启后依据 reminder 恢复对 runner 的连接
- **cmd_runner**
  - 真正执行 shell 命令
  - 维护 scrollback buffer
  - 提供本地 IPC 服务
- **daemon command**
  - 真正业务命令
  - 被 runner 托管

### 所有权边界

- `stdout` / `stderr` buffer 的 single source of truth 在 runner
- Dominds 主进程不再保存 daemon 运行期日志缓冲的权威副本
- reminder 只保存恢复连接和 stale 判定所需的元信息

---

## 工具契约调整

## `get_daemon_output`

### 旧契约

- 参数：`pid`，可选 `stream: "stdout" | "stderr"`
- 一次只能看一个流

### 新契约

- 参数：
  - `pid: number`
  - `stdout?: boolean`
  - `stderr?: boolean`

### 语义

- 两个参数都省略时，默认 `stdout=true` 且 `stderr=true`
- 显式传 `stdout=false, stderr=false` 时，直接报错
- 返回顺序固定为 `stdout` 在前、`stderr` 在后
- 每个流各自带自己的标题、内容、scroll notice
- 未请求的流不展示

### 取舍理由

- daemon 调试场景里，绝大多数时候需要同时看两个流
- 双 bool 比单选枚举更适合表达“看其中一个 / 看两个 / 明确排除某一个”
- 不保留旧 `stream` 参数兼容层，避免工具契约双轨

## `stop_daemon`

`stop_daemon` 的职责不变，但内部控制链路改为：

1. 主进程连接 runner
2. runner 直接对 daemon pid 发优雅停止信号
3. 等待短暂宽限期
4. 若未退出，主进程对整个 pg 做兜底 kill
5. 若需要，再补一轮直接对 daemon pid kill
6. 清理 reminder 与本地 tracking 状态

这里“对 daemon pid 发信号”是主路径，不是后备手段。

---

## IPC 设计

### 传输介质

- Linux：优先 `${XDG_RUNTIME_DIR}`；若不可用，再退化到可写临时目录；endpoint 名称中包含 daemon pid
- macOS：使用 `${TMPDIR}` 下的 socket 路径；准确路径直接写入 reminder meta，不依赖重启后重新推导
- Windows：使用全局 named pipe 命名

约定重点是：

- **endpoint 的精确路径/名称必须写入 reminder meta**
- 主进程恢复时优先信任 meta 里的 endpoint，而不是靠平台规则重新猜

不建议把 Linux 默认路径写死为 `/run/...` 根目录，因为普通用户进程通常并不具备在那里直接创建 socket 的权限。

### 协议风格

v1 采用简单本地请求-响应协议即可，不做长连接订阅。

建议 runner 支持以下请求：

- `ping`
- `get_status`
- `get_output`
- `stop`

建议响应中始终带上：

- `ok`
- `daemonPid`
- `runnerPid`
- `startTime`
- `daemonCommandLine`

其中 `ping` / `get_status` 的作用不只是“证明 endpoint 可连”，还要让主进程确认“这个 endpoint 对应的确实是当初那个 daemon”。

### `get_output` 请求

请求体语义建议与工具契约对齐：

- `stdout: boolean`
- `stderr: boolean`

响应体应分别返回：

- `stdout.content`
- `stdout.linesScrolledOut`
- `stderr.content`
- `stderr.linesScrolledOut`

不要把两个流合并成单一文本再返回，否则主进程就失去精确展示与错误诊断能力。

---

## reminder meta 契约

daemon reminder 至少应保存以下字段：

- `kind: "daemon"`
- `daemonPid`
- `runnerPid`
- `runnerEndpoint`
- `initialCommandLine`
- `daemonCommandLine`
- `shell`
- `startTime`
- `processGroupId`
- `originDialogId`
- `completed?`
- `lastUpdated?`

其中：

- `daemonPid` 是工具层面和用户认知里的主标识
- `runnerEndpoint` 是重连 runner 的一手信息
- `runnerPid` 与 `processGroupId` 用于 stop 与 stale 清理辅助
- `daemonCommandLine + startTime` 用于抵御 pid reuse

本设计不引入 `authToken`。恢复能力既然必须跨主进程存在，token 最终也必须落到可恢复状态里；在这种约束下，它对本地同用户攻击面的收益有限，不值得让协议与 meta 额外复杂化。安全边界主要依赖本机可达性与 endpoint 文件权限。

---

## stale 判定与清理

主进程在使用 daemon reminder 时，按以下顺序恢复：

1. 读取 reminder meta 中的 `runnerEndpoint`
2. 尝试连接 runner 并发出 `ping` / `get_status`
3. 若响应中的 `daemonPid`、`daemonCommandLine`、`startTime` 与 reminder 匹配，则视为健康 runner
4. 若 endpoint 无法连接，则检查 `daemonPid` 当前对应的 OS 进程
5. 若该进程不存在，则视为 daemon 已结束，drop reminder
6. 若该进程存在，且命令行与启动时间仍与 reminder 相符，则视为 **stale daemon**
7. 对 stale daemon 做清理性 kill，然后 drop reminder
8. 若 pid 已被其他无关进程复用，或命令行/启动时间不匹配，则不得误杀，应直接把原 reminder 视为失效并 drop

这里的关键判断是：

- **可连接的 runner** 才算真正“可恢复”
- **仅剩 daemon 进程但没有 runner**，不是“继续沿用”，而是 stale

因为 scrollback buffer owner 是 runner，不是 daemon 本身。只剩 daemon 存活时，旧日志读取能力已经不可恢复。

---

## scrollback 语义

runner 维护两个独立滚动缓冲区：

- `stdout`
- `stderr`

缓冲策略沿用“按行滚动保留”的语义即可：

- 每个流单独计算 `linesScrolledOut`
- `get_daemon_output` 返回时分别显示
- reminder 状态快照也分别展示

只要 runner 还活着，主进程重连后就仍能读到同一份缓冲区；不再存在“主进程重启导致日志历史立即失忆”的问题。

---

## stdin 政策

本轮明确将 daemon/std shell 命令视为**非交互执行**：

- runner 启动命令时，`stdin` 一律设为 `ignore`
- 不继承 Dominds 主进程的终端
- 不提供输入转发 API
- 不尝试维持“好像能交互，但其实没有人喂数据”的半交互状态

这样做比旧实现更干净：

- 命令若依赖 stdin，会立即看到 EOF 或按其自身逻辑报错
- 命令不会因为等不到输入而无意义挂起
- 语义上也更符合当前 `os` 工具能力边界

未来若需要支持交互命令，应另起一轮设计：

- 使用 PTY 作为 stdin/stdout/stderr 容器
- 暴露明确的输入写入 API
- 在工具层显式区分“普通 shell 命令”和“交互终端会话”

---

## 失败语义

新设计必须 loud by default，不允许静默降级成“无输出”。

典型场景：

- runner 连不上
- reminder 里的 pid 仍活着但 runner 已消失
- runner 返回的 daemon 身份信息与 reminder 不匹配
- 请求 `stdout=false, stderr=false`
- stop 后 daemon 仍拒绝退出

这些情况都应给出明确错误或状态说明，至少在运行时日志与工具输出层面做到可诊断。尤其是：

- “runner 不可达但 daemon 还活着”必须暴露为 stale / unrecoverable，而不是伪装成空日志
- “pid 被复用成别的进程”必须显式识别，不能误把陌生进程当成旧 daemon

---

## 实施边界

本次重构应一次性完成以下替换：

- `shell_cmd` 的 daemon 路径改由 runner 托管
- `get_daemon_output` 改为双 bool 契约
- `stop_daemon` 改为 runner-aware stop 链路
- daemon reminder meta 改为 runner-aware 契约
- 主进程内存态 daemon scrollback owner 逻辑整体删除

不引入：

- 老 `stream` 参数兼容层
- 老 reminder meta 的长期兼容恢复
- “主进程内存 buffer + runner buffer” 双写双读

旧实现下已经存在的 daemon reminder，在新实现落地后的处理原则应是：**不尝试恢复其历史 scrollback；在首次接触时按旧契约不可恢复对象处理并尽快清理。**

---

## 设计摘要

这次改造的本质，不是给 `get_daemon_output` 补一个“崩溃后再猜一猜日志在哪”的修补逻辑，而是重新定义 daemon 机制的 owner：

- **命令执行 owner**：runner
- **scrollback owner**：runner
- **停止控制 owner**：runner 为主，主进程兜底
- **状态恢复 owner**：主进程凭 reminder 重连 runner

只有把 owner 边界彻底搬对，主进程崩溃重启后的日志恢复能力才会真正成立。
