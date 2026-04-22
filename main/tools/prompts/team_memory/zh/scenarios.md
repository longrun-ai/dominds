# team_memory 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景 1：团队编码规范

### 场景描述

保存团队统一的编码规范，所有成员可见。

### 示例

```typescript
add_team_memory({
  path: 'team/conventions/code-style',
  content:
    '## TypeScript 编码规范\n\n### 命名规则\n- 变量/函数: camelCase\n- 类/接口: PascalCase\n- 常量: UPPER_SNAKE_CASE\n\n### 类型规则\n- 禁止使用 any 类型\n- 优先使用 interface 而非 type\n- 必须使用 strict 模式\n\n### 代码组织\n- 单文件不超过 200 行\n- 导出按功能分组\n- 注释使用 JSDoc 格式',
});
```

## 场景 2：项目架构决策

### 场景描述

记录架构决策记录（ADR），便于新成员了解技术选型。

### 示例

```typescript
add_team_memory({
  path: 'team/adr/001-database',
  content:
    '## ADR-001: 使用 PostgreSQL 作为主数据库\n\n### 状态: 已批准\n\n### 决策\n选择 PostgreSQL 作为主数据库存储。\n\n### 理由\n- 丰富的 JSON 支持\n- 强大的事务支持\n- 成熟的生态\n\n### 后果\n- 需要管理数据库迁移\n- 需要定期备份策略',
});
```

## 场景 3：API 文档共享

### 场景描述

共享 API 接口文档，团队成员都可以查看和更新。

### 示例

````typescript
add_team_memory({
  path: 'team/api/auth',
  content:
    '## 认证 API\n\n### 登录\nPOST /api/auth/login\n\nRequest:\n```json\n{\n  "username": "string",\n  "password": "string"\n}\n```\n\nResponse:\n```json\n{\n  "token": "string",\n  "expiresIn": 86400\n}\n```\n\n### 刷新令牌\nPOST /api/auth/refresh',
});
````

## 场景 4：共享发布/值班不变量

### 场景描述

记录跨成员长期共用的发布或值班规则，而不是某一次任务的临时状态。

### 示例

```typescript
add_team_memory({
  path: 'team/ops/release-invariants',
  content:
    '## 发布不变量\n\n- 合并影响 wire protocol 的改动前，必须同步检查前端消费者\n- 发布前必须确认关键回归路径和回滚入口\n- 发生线上异常时，先固定时间线和证据，再讨论修复策略',
});
```

## 场景 5：技术栈文档

### 场景描述

记录项目使用的技术栈和依赖版本。

### 示例

```typescript
add_team_memory({
  path: 'team/tech-stack',
  content:
    '## 技术栈\n\n### 前端\n- React 18.2.0\n- TypeScript 5.3.0\n- Vite 5.0.0\n\n### 后端\n- Node.js 20.10.0\n- Express 4.18.0\n- PostgreSQL 15.0\n\n### 开发工具\n- ESLint 8.55.0\n- Prettier 3.1.0\n- Jest 29.7.0',
});
```

## 场景 6：团队术语表

### 场景描述

维护跨成员共享的术语和固定说法，减少沟通偏差。

### 示例

```typescript
add_team_memory({
  path: 'team/glossary/dialog-terms',
  content:
    '## 对话术语\n\n- 用户面向文案优先使用：主线对话 / 支线对话\n- 实现上下文可使用：main dialog / sideDialog / askerDialog\n- 不要把实现术语直接裸露到用户可见 copy',
});
```

## 场景 7：维护团队知识库

### 场景描述

团队共享的知识库，包括常见问题解决方案。

### 示例

```typescript
add_team_memory({
  path: 'team/kb/docker-debug',
  content:
    '## Docker 调试技巧\n\n### 查看容器日志\ndocker logs <container_id>\n\n### 进入容器调试\ndocker exec -it <container_id> sh\n\n### 检查容器网络\ndocker network inspect <network_name>\n\n### 常见问题\n- 端口冲突: 检查 docker-compose.yml 端口映射\n- 内存不足: 调整 docker-compose.yml memory 限制',
});
```
