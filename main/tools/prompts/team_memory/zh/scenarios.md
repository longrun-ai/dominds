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
add_shared_memory({
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
add_shared_memory({
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
add_shared_memory({
  path: 'team/api/auth',
  content:
    '## 认证 API\n\n### 登录\nPOST /api/auth/login\n\nRequest:\n```json\n{\n  "username": "string",\n  "password": "string"\n}\n```\n\nResponse:\n```json\n{\n  "token": "string",\n  "expiresIn": 86400\n}\n```\n\n### 刷新令牌\nPOST /api/auth/refresh',
});
````

## 场景 4：当前迭代状态

### 场景描述

共享当前迭代的状态，包括任务进度和阻塞问题。

### 示例

```typescript
add_shared_memory({
  path: 'team/sprint/current',
  content:
    '## Sprint 15 状态\n\n### 进度\n- 已完成: 8/15 个任务\n- 进行中: 4 个任务\n- 待开始: 3 个任务\n\n### 阻塞问题\n- API 规范文档待确认（@alice 负责）\n\n### 发布安排\n- 目标日期: 2024-02-01\n- 回归测试: 2024-01-30',
});
```

## 场景 5：技术栈文档

### 场景描述

记录项目使用的技术栈和依赖版本。

### 示例

```typescript
add_shared_memory({
  path: 'team/tech-stack',
  content:
    '## 技术栈\n\n### 前端\n- React 18.2.0\n- TypeScript 5.3.0\n- Vite 5.0.0\n\n### 后端\n- Node.js 20.10.0\n- Express 4.18.0\n- PostgreSQL 15.0\n\n### 开发工具\n- ESLint 8.55.0\n- Prettier 3.1.0\n- Jest 29.7.0',
});
```

## 场景 6：团队成员信息

### 场景描述

记录团队成员的职责和联系方式。

### 示例

```typescript
add_shared_memory({
  path: 'team/members',
  content:
    '## 团队成员\n\n### @fullstack\n- 职责: 后端开发、API 设计\n- 专长: Node.js, PostgreSQL\n\n### @i18n\n- 职责: 国际化、文档\n- 专长: 多语言、内容策略\n\n### @ux\n- 职责: 用户体验、设计\n- 专长: UI/UX、Figma',
});
```

## 场景 7：维护团队知识库

### 场景描述

团队共享的知识库，包括常见问题解决方案。

### 示例

```typescript
add_shared_memory({
  path: 'team/kb/docker-debug',
  content:
    '## Docker 调试技巧\n\n### 查看容器日志\ndocker logs <container_id>\n\n### 进入容器调试\ndocker exec -it <container_id> sh\n\n### 检查容器网络\ndocker network inspect <network_name>\n\n### 常见问题\n- 端口冲突: 检查 docker-compose.yml 端口映射\n- 内存不足: 调整 docker-compose.yml memory 限制',
});
```
