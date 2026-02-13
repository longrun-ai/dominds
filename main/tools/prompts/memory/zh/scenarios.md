# memory 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景 1：任务进度跟踪

### 场景描述

在长时间任务中，需要持久化任务进度，以便重启后继续。

### 示例

**添加任务列表**

```typescript
add_memory({
  path: 'project/i18n-tasks',
  content:
    '## 待办任务\n\n- [ ] 创建 ws_mod 手册\n- [ ] 创建 team_mgmt 手册\n- [ ] 创建 memory 手册\n- [ ] 创建 control 手册\n\n## 进行中\n- [ ] 创建 ws_mod 手册 [100%]',
});
```

**更新任务进度**

```typescript
replace_memory({
  path: 'project/i18n-tasks',
  content:
    '## 待办任务\n\n- [ ] 创建 team_mgmt 手册\n- [ ] 创建 memory 手册\n- [ ] 创建 control 手册\n\n## 已完成\n- [x] 创建 ws_mod 手册\n\n## 进行中\n- [ ] 创建 team_mgmt 手册 [50%]',
});
```

## 场景 2：用户偏好存储

### 场景描述

保存用户偏好设置，例如编程语言、主题等。

### 示例

**保存用户偏好**

```typescript
add_memory({
  path: 'user/preferences',
  content:
    '## 用户偏好\n\n- 编程语言: TypeScript\n- 代码风格: strict\n- 主题: dark\n- 自动保存: true',
});
```

**更新偏好**

```typescript
replace_memory({
  path: 'user/preferences',
  content:
    '## 用户偏好\n\n- 编程语言: TypeScript\n- 代码风格: strict\n- 主题: light\n- 自动保存: true',
});
```

## 场景 3：上下文信息保存

### 场景描述

在复杂任务中，保存重要的上下文信息，避免重复查询。

### 示例

**保存 API 信息**

```typescript
add_memory({
  path: 'context/api-endpoints',
  content:
    '## API 端点\n\n- 用户登录: POST /api/auth/login\n- 获取用户信息: GET /api/user/info\n- 更新用户设置: PUT /api/user/settings\n\n## 认证\n- 使用 Bearer Token\n- 有效期: 24 小时',
});
```

**保存技术栈**

```typescript
add_memory({
  path: 'context/tech-stack',
  content:
    '## 技术栈\n\n- 前端: React + TypeScript\n- 后端: Node.js + Express\n- 数据库: PostgreSQL\n- 缓存: Redis',
});
```

## 场景 4：会议记录

### 场景描述

保存会议要点和决策。

### 示例

```typescript
add_memory({
  path: 'meeting/2024-01-15',
  content:
    '## 会议纪要: 2024-01-15\n\n### 参与者\n- @fullstack\n- @i18n\n- @ux\n\n### 议题\n1. i18n 手册创建计划\n2. man 函数 UX 改进\n\n### 决策\n- 优先创建 ws_mod 和 team_mgmt 手册\n- man 函数支持模糊匹配\n\n### 待办\n- @i18n: 创建 memory 手册\n- @fullstack: 优化 man 函数',
});
```

## 场景 5：知识库

### 场景描述

建立个人知识库，保存学习笔记。

### 示例

```typescript
add_memory({
  path: 'knowledge/typescript-tips',
  content:
    '## TypeScript 技巧\n\n### 1. 类型推断\nconst x = 1; // 类型推断为 number\n\n### 2. 接口 vs 类型\n- 接口: 可扩展，适合对象类型\n- 类型: 支持联合类型、交叉类型\n\n### 3. strict 模式\n启用 strict 模式可以获得更好的类型安全',
});
```

## 场景 6：临时笔记

### 场景描述

临时保存需要稍后处理的信息。

### 示例

```typescript
add_memory({
  path: 'scratchpad/temp-notes',
  content:
    '## 临时笔记\n\n- TODO: 检查 team.yaml 配置\n- TODO: 验证 man 函数类型\n- TODO: 更新差遣牒进度',
});
```

**处理完后删除**

```typescript
drop_memory({
  path: 'scratchpad/temp-notes',
});
```

## 场景 7：清理过时记忆

### 场景描述

定期清理不再需要的记忆。

### 示例

```typescript
// 查看当前所有记忆（智能体可读取）
// 逐个删除不需要的记忆
drop_memory({
  path: 'project/old-feature',
});
```

或者使用 `clear_memory` 清空所有记忆（谨慎使用）：

```typescript
clear_memory({});
```
