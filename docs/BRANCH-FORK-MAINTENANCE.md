# 分支与 Fork 维护指南

## 结构

**`qwibitai/nanoclaw`**（上游）— 核心引擎，包含技能定义（`.claude/skills/`）。`main` 分支上没有通道代码。

**通道 Fork**（`nanoclaw-whatsapp`、`nanoclaw-telegram`、`nanoclaw-slack` 等）— 每个 Fork = 上游 + 一个通道的代码。用户克隆上游，然后合并 Fork 到他们的克隆中以添加通道。

**上游的 `skill/*` 和 `feat/*` 分支** — 添加与通道无关的功能（例如 `skill/compact`、`skill/apple-container`）。用户将这些合并到他们的克隆中以添加功能。特定于通道的技能分支（如 `skill/whatsapp`、`skill/telegram`）是旧的，与 Fork 重复。

## 用户如何添加功能

```
用户克隆上游 main
  ├── 合并 nanoclaw-whatsapp fork  → 添加 WhatsApp
  ├── 合并 skill/compact branch    → 添加 /compact 命令
  └── 合并 skill/apple-container   → 切换到 Apple Container
```

## 合并方向

```
上游 main ──→ 通道 Fork          （向前合并，保持 Fork 更新）
上游 main ──→ skill 分支         （向前合并，保持分支更新）
```

Fork 和技能分支携带应用的代码更改。用户将它们合并到自己的克隆/Fork 中以添加功能。它们永远不会被合并回上游 `main`。

## 向前合并过程

```bash
# 在你的本地 nanoclaw 检出中
git checkout main && git pull

# 对于 Fork：
git fetch nanoclaw-whatsapp
git checkout -B whatsapp-merge nanoclaw-whatsapp/main
git merge main
# 解决冲突（见下文）
# 删除仅上游的工作流（每次合并后重新添加，因为 main 有它们）：
git rm .github/workflows/bump-version.yml .github/workflows/update-tokens.yml 2>/dev/null
git push nanoclaw-whatsapp HEAD:main
git checkout main && git branch -D whatsapp-merge

# 对于技能分支：
git checkout -B skill/compact origin/skill/compact
git merge main
# 解决冲突（见下文）
git push origin skill/compact
git checkout main && git branch -D skill/compact
```

## 冲突解决

相同的文件每次都会冲突：

| 文件 | 解决方法 |
|------|----------|
| `package.json` | 采用 main 的版本 + 保留 Fork/分支特定的依赖 |
| `package-lock.json` | `git checkout main -- package-lock.json && npm install` |
| `.env.example` | 合并：main 的条目 + Fork/分支特定的条目 |
| `repo-tokens/badge.svg` | 采用 main 的版本（自动生成） |

源代码更改（如 `src/types.ts`、`src/index.ts`）通常会自动合并，但如果双方修改相同的行可能会冲突。**每次向前合并后务必构建和测试** — 即使 git 报告没有冲突，自动合并的代码也可能静默出错（例如引用已重命名的函数或使用已删除的参数）。

## 何时向前合并

在任何 main 更改触及共享文件（`package.json`、`src/index.ts`、`CLAUDE.md` 等）之后。小频率的合并 = 微不足道的冲突。大频率的合并 = 痛苦的。

## Fork 设置

创建新通道 Fork 时：

1. Fork `nanoclaw` 到 `nanoclaw-{channel}`
2. 删除仅上游的工作流：`bump-version.yml`、`update-tokens.yml`
3. 添加通道代码、依赖、环境变量
4. 立即向前合并 main 以建立干净的基线

## 依赖关系

Fork 和分支在上游的基础上添加自己的依赖。当上游添加或删除依赖时，在下次向前合并后验证 Fork/分支仍能构建 — 传递依赖更改可能会破坏下游代码。
