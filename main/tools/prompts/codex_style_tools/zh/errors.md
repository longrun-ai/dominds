# codex_style_tools 错误处理

## 模板（错误）

### 错误行动链（必填）

1. 触发条件
2. 检测信号
3. 恢复步骤
4. 成功判据
5. 升级路径（可选）

## 错误代码

### PATCH_INVALID

**描述：** 补丁格式无效。

**原因：**

- 补丁格式不符合 unified diff 格式
- 补丁无法应用到目标文件

**解决方案：**

- 检查补丁格式是否正确
- 确保补丁与目标文件匹配

### FILE_NOT_FOUND

**描述：** 目标文件不存在。

**原因：**

- 文件路径错误
- 文件已被删除

**解决方案：**

- 检查文件路径是否正确
- 确认文件是否存在

### COMMAND_NOT_ALLOWED

**描述：** 命令不允许执行。

**原因：**

- 命令被识别为修改操作
- 命令不在允许列表中

**解决方案：**

- 使用只读命令
- 检查命令是否在白名单中

## 常见问题

### Q: apply_patch 失败怎么办？

A: 检查以下内容：

1. 补丁格式是否正确
2. 目标文件是否存在
3. 补丁是否与文件内容匹配

### Q: readonly_shell 可以执行哪些命令？

A: 仅允许以下命令前缀（完整清单）：

```
cat, rg, sed, ls, nl, wc, head, tail, stat, file, uname, whoami, id, echo, pwd, which, date,
diff, realpath, readlink, printf, cut, sort, uniq, tr, awk, shasum, sha256sum, md5sum, uuid,
git show, git status, git diff, git log, git blame, find, tree, jq, true
```

另外允许（附加规则）：

- 仅版本探针：`node --version|-v`、`python3 --version|-V`
- `git -C <相对路径> <show|status|diff|log|blame> ...`
- `cd <相对路径> && <允许命令...>`（或 `||`）
- 链式命令 `|` / `&&` / `||` 会逐段校验
- `node -e` / `python3 -c` 这类脚本执行一律拒绝

### Q: update_plan 有什么限制？

A: update_plan 主要是增量更新，建议：

- 保持计划简洁
- 定期更新

### Q: 为什么命令被拒绝执行？

A: 可能原因：

1. 命令被识别为修改操作
2. 命令不在允许列表中
3. 命令有安全风险

### Q: 如何查看可用的只读命令？

A: 以上清单即为完整白名单；若命令被拒绝，错误提示会回显完整白名单和被拒的子命令段。
