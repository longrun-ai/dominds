# personal_memory 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景 1：维护代码入口地图

### 场景描述

把自己反复会用到的代码入口、关键文件和调用线索沉淀下来，减少下次重新摸索的成本。

### 示例

**保存入口地图**

```typescript
add_personal_memory({
  path: 'project/dominds-entry-map',
  content:
    '## Dominds 入口地图\n\n- team 管理入口: dominds/main/tools/team_mgmt.ts\n- team_mgmt 手册总入口: dominds/main/tools/team_mgmt-manual.ts\n- 通用工具集注册: dominds/main/tools/builtins.ts\n- 手册 prompt 片段: dominds/main/tools/prompts/**',
});
```

**补充定位线索**

```typescript
replace_personal_memory({
  path: 'project/dominds-entry-map',
  content:
    '## Dominds 入口地图\n\n- team 管理入口: dominds/main/tools/team_mgmt.ts\n- team_mgmt 手册总入口: dominds/main/tools/team_mgmt-manual.ts\n- 通用工具集注册: dominds/main/tools/builtins.ts\n- 手册 prompt 片段: dominds/main/tools/prompts/**\n- 若要追 man 渲染入口，先看 buildToolsetManualTools / renderTeamMgmtGuideContent',
});
```

## 场景 2：沉淀排障关键词模板

### 场景描述

保存对自己长期有效的排障检索套路，避免每次都从零开始想搜索词。

### 示例

**保存排障模板**

```typescript
add_personal_memory({
  path: 'debug/team-mgmt-search-queries',
  content:
    '## team_mgmt 排障检索模板\n\n- 查手册章节来源: renderTeamManual|renderMindsManual|renderPermissionsManual\n- 查 prompt 片段来源: rg -n "principles|scenarios" dominds/main/tools/prompts\n- 查 manual 相关测试: rg -n "team_mgmt-manual|toolsets/manual" dominds/tests',
});
```

**更新模板**

```typescript
replace_personal_memory({
  path: 'debug/team-mgmt-search-queries',
  content:
    '## team_mgmt 排障检索模板\n\n- 查手册章节来源: renderTeamManual|renderMindsManual|renderPermissionsManual\n- 查 prompt 片段来源: rg -n "principles|scenarios|index" dominds/main/tools/prompts\n- 查 manual 相关测试: rg -n "team_mgmt-manual|toolsets/manual|memory" dominds/tests',
});
```

## 场景 3：沉淀外部检索策略

### 场景描述

把自己长期常用的外部检索方法整理成索引，便于未来快速复用。

### 示例

**保存检索策略**

```typescript
add_personal_memory({
  path: 'research/search-strategies',
  content:
    '## 常用检索策略\n\n- 查官方手册优先看 docs / 官方仓库 / runtime source-of-truth\n- 查 UI 文案来源优先搜 i18n 文件和组件 render 点\n- 查协议/类型定义优先搜 shared/types 和消费端入口',
});
```

**补充说明**

```typescript
replace_personal_memory({
  path: 'research/search-strategies',
  content:
    '## 常用检索策略\n\n- 查官方手册优先看 docs / 官方仓库 / runtime source-of-truth\n- 查 UI 文案来源优先搜 i18n 文件和组件 render 点\n- 查协议/类型定义优先搜 shared/types 和消费端入口\n- 只有当知识已经稳定可复用时才写回记忆；任务内临时发现不要默认入库',
});
```

## 场景 4：记录个人长期工作偏好

### 场景描述

保存只对你自己长期稳定有效的工作方式偏好，帮助后续生成更一致。

### 示例

```typescript
add_personal_memory({
  path: 'preferences/working-style',
  content:
    '## 我的长期工作偏好\n\n- 先定位 source-of-truth，再动文案\n- 修改手册类内容时，中英文一起维护，中文语义优先\n- 优先用 rg 搜入口，再读最小必要上下文',
});
```

## 场景 5：清理过时记忆

### 场景描述

定期删除已经失效、被新文档替代、或不再会复用的个人记忆，避免上下文噪音。

### 示例

```typescript
drop_personal_memory({
  path: 'project/old-entry-map',
});
```

或者使用 `clear_personal_memory` 清空所有记忆（谨慎使用）：

```typescript
clear_personal_memory({});
```
