# 技能作为分支

## 概述

本文档介绍**功能技能** — 通过 git 分支合并添加功能的技能。这是最复杂的技能类型，也是 NanoClaw 扩展的主要方式。

NanoClaw 总共有四种类型的技能。参见 [CONTRIBUTING.md](../CONTRIBUTING.md) 获取完整的分类：

| 类型 | 位置 | 工作原理 |
|------|----------|-------------|
| **功能**（本文档） | `.claude/skills/` + `skill/*` 分支 | SKILL.md 有指令；代码在分支上，通过 `git merge` 应用 |
| **实用** | `.claude/skills/<name>/` 带代码文件 | 自包含工具；代码在技能目录中，安装时复制到位 |
| **操作** | `main` 上的 `.claude/skills/` | 仅指令的工作流（setup、debug、update） |
| **容器** | `container/skills/` | 在 agent 容器内运行时加载 |

---

功能技能作为 git 分支分布在上游仓库上。应用技能就是 `git merge`。更新核心就是 `git merge`。一切都是标准的 git。

这取代了以前的 `skills-engine/` 系统（三方文件合并、`.nanoclaw/` 状态、清单文件、重放、备份/恢复）与简单的 git 操作和 Claude 用于冲突解决。

## 工作原理

### 仓库结构

上游仓库（`qwibitai/nanoclaw`）维护：

- `main` — 核心 NanoClaw（无技能代码）
- `skill/discord` — main + Discord 集成
- `skill/telegram` — main + Telegram 集成
- `skill/slack` — main + Slack 集成
- `skill/gmail` — main + Gmail 集成
- 等等。

每个技能分支包含该技能的所有代码更改：新文件、修改的源文件、更新的 `package.json` 依赖、`.env.example` 添加 — 所有一切。无清单，无结构化操作，无单独的 `add/` 和 `modify/` 目录。

### 技能发现和安装

技能分为两类：

**操作技能**（在 `main` 上，始终可用）：
- `/setup`、`/debug`、`/update-nanoclaw`、`/customize`、`/update-skills`
- 这些是指令仅有的 SKILL.md 文件 — 无代码更改，只是工作流
- 在 `main` 上的 `.claude/skills/` 中，每个用户立即可用

**功能技能**（在市场上，按需安装）：
- `/add-discord`、`/add-telegram`、`/add-slack`、`/add-gmail` 等
- 每个都有 SKILL.md 带有设置指令和相应的 `skill/*` 分支带有代码
- 位于市场仓库（`qwibitai/nanoclaw-skills`）中

用户从不直接与市场交互。操作技能 `/setup` 和 `/customize` 透明地处理插件安装：

```bash
# Claude 在幕后运行这个 — 用户看不到
claude plugin install nanoclaw-skills@nanoclaw-skills --scope project
```

技能在 `claude plugin install` 后热加载 — 无需重启。这意味着 `/setup` 可以安装市场插件，然后立即运行任何功能技能，都在一个会话中。

### 选择性技能安装

`/setup` 询问用户想要什么通道，然后只提供相关技能：

1. "你想使用哪些消息通道？" → Discord、Telegram、Slack、WhatsApp
2. 用户选择 Telegram → Claude 安装插件并运行 `/add-telegram`
3. Telegram 设置好后："想为 Telegram 添加 Agent Swarm 支持吗？" → 提供 `/add-telegram-swarm`
4. "想启用社区技能吗？" → 安装社区市场插件

依赖技能（例如 `telegram-swarm` 依赖于 `telegram`）仅在其父级安装后才提供。`/customize` 在设置后添加时遵循相同的模式。

### 市场配置

NanoClaw 的 `.claude/settings.json` 注册官方市场：

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

市场仓库使用 Claude Code 的插件结构：

```
qwibitai/nanoclaw-skills/
  .claude-plugin/
    marketplace.json              # 插件目录
  plugins/
    nanoclaw-skills/              # 捆绑所有官方技能的单个插件
      .claude-plugin/
        plugin.json               # 插件清单
      skills/
        add-discord/
          SKILL.md                # 设置指令；步骤 1 是"合并分支"
        add-telegram/
          SKILL.md
        add-slack/
          SKILL.md
        ...
```

多个技能捆绑在一个插件中 — 安装 `nanoclaw-skills` 使所有功能技能立即可用。单个技能不需要单独安装。

每个 SKILL.md 告诉 Claude 合并相应的技能分支作为步骤 1，然后遍历交互式设置（创建机器人、获取令牌、配置环境变量等）。

### 应用技能

用户运行 `/add-discord`（通过市场发现）。Claude 遵循 SKILL.md：

1. `git fetch upstream skill/discord`
2. `git merge upstream/skill/discord`
3. 交互式设置（创建机器人、获取令牌、配置环境变量等）

或手动：

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
```

### 应用多个技能

```bash
git merge upstream/skill/discord
git merge upstream/skill/telegram
```

Git 处理组合。如果两个技能修改相同的行，这是真正的冲突，Claude 解决它。

### 更新核心

```bash
git fetch upstream main
git merge upstream/main
```

由于技能分支与 main 保持合并向前（参见 CI 部分），用户合并的技能更改和上游更改有适当的共同祖先。

### 检查技能更新

合并了技能分支的用户可以检查更新。对于每个 `upstream/skill/*` 分支，检查分支是否有不在用户 HEAD 中的提交：

```bash
git fetch upstream
for branch in $(git branch -r | grep 'upstream/skill/'); do
  # 检查用户是否在某个时候合并了这个技能
  merge_base=$(git merge-base HEAD "$branch" 2>/dev/null) || continue
  # 检查技能分支是否有超出用户的新提交
  if ! git merge-base --is-ancestor "$branch" HEAD 2>/dev/null; then
    echo "$branch 有更新可用"
  fi
done
```

这不需要状态 — 它使用 git 历史来确定哪些技能以前合并过，以及它们是否有新提交。

此逻辑有两种提供方式：
- 内置于 `/update-nanoclaw` — 合并 main 后，可选检查技能更新
- 独立 `/update-skills` — 独立检查和合并技能更新

### 冲突解决

在任何合并步骤，可能会出现冲突。Claude 解决它们 — 读取冲突的文件，理解双方的意图，并产生正确的结果。这就是为什么分支方法在规模上可行：以前需要人类判断的冲突解决现在自动化了。

### 技能依赖

有些技能依赖于其他技能。例如，`skill/telegram-swarm` 需要 `skill/telegram`。依赖技能分支从其父技能分支分支，而不是从 `main`。

这意味着 `skill/telegram-swarm` 包括 telegram 的所有更改加上它自己的添加。当用户合并 `skill/telegram-swarm` 时，他们获得两者 — 不需要单独合并 telegram。

依赖在 git 历史中是隐式的 — `git merge-base --is-ancestor` 确定一个技能分支是否是另一个的祖先。不需要单独的依赖文件。

### 卸载技能

```bash
# 查找合并提交
git log --merges --oneline | grep discord

# 还原它
git revert -m 1 <合并提交>
```

这会创建一个撤销技能更改的新提交。Claude 可以处理整个流程。

如果用户自合并以来修改了技能的代码（顶部的自定义更改），还原可能会冲突 — Claude 解决它。

如果用户后来想重新应用技能，他们需要还原还原（git 将还原的更改视为"已应用并撤销"）。Claude 也处理这个。

## CI：保持技能分支最新

GitHub Action 在每次推送到 `main` 时运行：

1. 列出所有 `skill/*` 分支
2. 对于每个技能分支，将 `main` 合并到其中（合并向前，不是变基）
3. 在合并结果上运行构建和测试
4. 如果测试通过，推送更新的技能分支
5. 如果技能失败（冲突、构建错误、测试失败），打开 GitHub 问题以手动解决

**为什么合并向前而不是变基：**
- 无需强制推送 — 为已经合并技能的用户保留历史
- 用户可以重新合并技能分支以获取技能更新（错误修复、改进）
- Git 在整个合并图中有适当的共同祖先

**为什么这可以扩展：** 有几百个技能和每天几个 main 提交，CI 成本是微不足道的。Haiku 又快又便宜。这种方法在一两年前还不可行，现在实用是因为 Claude 可以大规模解决冲突。

## 安装流程

### 新用户（推荐）

1. 在 GitHub 上 fork `qwibitai/nanoclaw`（点击 Fork 按钮）
2. 克隆你的 fork：
   ```bash
   git clone https://github.com/<你>/nanoclaw.git
   cd nanoclaw
   ```
3. 运行 Claude Code：
   ```bash
   claude
   ```
4. 运行 `/setup` — Claude 处理依赖、认证、容器设置、服务配置，并添加 `upstream` 远程（如果不存在）

推荐 fork 是因为它为用户提供一个远程来推送他们的自定义。仅克隆适用于尝试但不提供远程备份。

### 从克隆迁移的现有用户

以前运行过 `git clone https://github.com/qwibitai/nanoclaw.git` 并有本地自定义的用户：

1. 在 GitHub 上 fork `qwibitai/nanoclaw`
2. 重新路由远程：
   ```bash
   git remote rename origin upstream
   git remote add origin https://github.com/<你>/nanoclaw.git
   git push --force origin main
   ```
   需要 `--force` 因为新鲜的 fork 的 main 在上游的最新位置，但用户想要他们的（可能落后）版本。刚创建的 fork 没有什么可失去的。
3. 从现在开始，`origin` = 他们的 fork，`upstream` = qwibitai/nanoclaw

### 从旧技能引擎迁移的现有用户

以前通过 `skills-engine/` 系统应用技能的用户在其树中有技能代码但没有链接到技能分支的合并提交。Git 不知道这些更改来自技能，所以在顶部合并技能分支可能会冲突或重复。

**对于未来的新技能：** 只需像平常一样合并技能分支。没问题。

**对于现有的旧引擎技能**，两个迁移路径：

**选项 A：每个技能重新应用（保留你的 fork）**
1. 对于每个旧引擎技能：识别并还原旧更改，然后新鲜合并技能分支
2. Claude 协助识别要还原的内容并解决任何冲突
3. 自定义修改（非技能更改）保留

**选项 B：重新开始（最干净）**
1. 从上游创建新的 fork
2. 合并你想要的技能分支
3. 手动重新应用你的自定义（非技能）更改
4. Claude 通过比较你的旧 fork 和新 fork 来识别自定义更改

在这两种情况下：
- 删除 `.nanoclaw/` 目录（不再需要）
- `skills-engine/` 代码将从上游移除，一旦所有技能迁移
- `/update-skills` 只跟踪通过分支合并应用的技能 — 旧引擎技能不会出现在更新检查中

## 用户工作流

### 自定义更改

用户直接在其 main 分支上进行自定义更改。这是标准的 fork 工作流 — 他们的 `main` 就是他们的自定义版本。

```bash
# 进行更改
vim src/config.ts
git commit -am "将触发词更改为@Bob"
git push origin main
```

自定义更改、技能和核心更新都共存于他们的 main 分支上。Git 在每个合并步骤处理三方合并，因为它可以通过合并历史追踪共同祖先。

### 应用技能

在 Claude Code 中运行 `/add-discord`（通过市场插件发现），或手动：

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
# 遵循设置指令进行配置
git push origin main
```

如果用户在合并技能分支时落后于上游的 main，合并可能也会带来一些核心更改（因为技能分支与 main 合并向前）。这通常没问题 — 他们获得兼容版本的所有东西。

### 更新核心

```bash
git fetch upstream main
git merge upstream/main
git push origin main
```

这与现有的 `/update-nanoclaw` 技能的合并路径相同。

### 更新技能

运行 `/update-skills` 或让 `/update-nanoclaw` 在核心更新后检查。对于每个以前合并的技能分支有新提交，Claude 提供合并更新。

### 贡献回上游

想要向 upstream 提交 PR 的用户：

```bash
git fetch upstream main
git checkout -b my-fix upstream/main
# 进行更改
git push origin my-fix
# 从 my-fix 创建 PR 到 qwibitai/nanoclaw:main
```

标准 fork 贡献工作流。他们的自定义更改留在他们的 main 上，不会泄露到 PR 中。

## 贡献技能

下面的流程是针对**功能技能**（基于分支）。对于实用技能（自包含工具）和容器技能，贡献者打开 PR 直接将文件添加到 `.claude/skills/<name>/` 或 `container/skills/<name>/` — 无需分支提取。参见 [CONTRIBUTING.md](../CONTRIBUTING.md) 获取所有技能类型。

### 贡献者流程（功能技能）

1. fork `qwibitai/nanoclaw`
2. 从 `main` 分支
3. 进行代码更改（新通道文件、修改的集成点、更新的 package.json、.env.example 添加等）
4. 打开 PR 到 `main`

贡献者打开正常的 PR — 他们不需要知道技能分支或市场仓库。他们只是进行代码更改并提交。

### 维护者流程

当技能 PR 被审查和批准时：

1. 从 PR 的提交创建 `skill/<name>` 分支：
   ```bash
   git fetch origin pull/<PR_NUMBER>/head:skill/<name>
   git push origin skill/<name>
   ```
2. 强制推送到贡献者的 PR 分支，用单个提交替换它，将贡献者添加到 `CONTRIBUTORS.md`（移除所有代码更改）
3. 将精简的 PR 合并到 `main`（仅添加贡献者）
4. 将技能的 SKILL.md 添加到市场仓库（`qwibitai/nanoclaw-skills`）

这样：
- 贡献者获得合并荣誉（他们的 PR 被合并）
- 他们自动添加到 CONTRIBUTORS.md
- 技能分支从他们的工作中创建
- `main` 保持干净（无技能代码）
- 贡献者只需要做一件事：打开带有代码更改的 PR

**注意：** GitHub PR 从 fork 默认勾选"允许维护者编辑"，所以维护者可以推送到贡献者的 PR 分支。

### 技能 SKILL.md

贡献者可以提供 SKILL.md（在 PR 中或单独）。这进入市场仓库并包含：

1. Frontmatter（名称、描述、触发器）
2. 步骤 1：合并技能分支
3. 步骤 2-N：交互式设置（创建机器人、获取令牌、配置环境变量等）

如果贡献者不提供 SKILL.md，维护者根据 PR 编写一个。

## 社区市场

任何人都可以维护自己的带有技能分支的 fork 和自己的市场仓库。这实现了社区驱动的技能生态系统，无需上游仓库的写入权限。

### 工作原理

社区贡献者：

1. 维护 NanoClaw 的 fork（例如 `alice/nanoclaw`）
2. 在其 fork 上创建带有自定义技能的 `skill/*` 分支
3. 创建市场仓库（例如 `alice/nanoclaw-skills`），带有 `.claude-plugin/marketplace.json` 和插件结构

### 添加社区市场

如果社区贡献者值得信任，他们可以打开 PR 将他们的市场添加到 NanoClaw 的 `.claude/settings.json`：

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    },
    "alice-nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "alice/nanoclaw-skills"
      }
    }
  }
}
```

一旦合并，所有 NanoClaw 用户自动发现社区市场与官方市场一起。

### 安装社区技能

`/setup` 和 `/customize` 询问用户是否想启用社区技能。如果是，Claude 通过 `claude plugin install` 安装社区市场插件：

```bash
claude plugin install alice-skills@alice-nanoclaw-skills --scope project
```

社区技能热加载并立即可用 — 无需重启。依赖技能仅在其先决条件满足后才提供（例如 Telegram 社区附加组件仅在 Telegram 安装后）。

用户也可以通过 `/plugin` 手动浏览和安装社区插件。

### 这个系统的属性

- **无需看门人。** 任何人都可以在其 fork 上创建技能，无需许可。他们只需要批准才能列入自动发现的市场。
- **多个市场共存。** 用户在 `/plugin` 中看到来自所有信任市场的技能。
- **社区技能使用相同的合并模式。** SKILL.md 只指向不同的远程：
  ```bash
  git remote add alice https://github.com/alice/nanoclaw.git
  git fetch alice skill/my-cool-feature
  git merge alice/skill/my-cool-feature
  ```
- **用户也可以手动添加市场。** 即使未列在 settings.json 中，用户可以运行 `/plugin marketplace add alice/nanoclaw-skills` 从任何来源发现技能。
- **CI 是每个 fork。** 每个社区维护者运行自己的 CI 以保持其技能分支合并向前。他们可以使用与上游仓库相同的 GitHub Action。

## 风味

风味是 NanoClaw 的精心策划的 fork — 技能、自定义更改和配置的组合，针对特定用例（例如"NanoClaw for Sales"、"NanoClaw Minimal"、"NanoClaw for Developers"）。

### 创建风味

1. fork `qwibitai/nanoclaw`
2. 合并你想要的技能
3. 进行自定义更改（触发词、提示、集成等）
4. 你的 fork 的 `main` 就是风味

### 安装风味

在 `/setup` 期间，在配置发生之前向用户提供风味选择。设置技能从仓库中的 `flavors.yaml` 读取（与上游一起提供，始终保持最新）并提供选项：

AskUserQuestion："从风味或默认 NanoClaw 开始？"
- 默认 NanoClaw
- NanoClaw for Sales — Gmail + Slack + CRM（由 alice 维护）
- NanoClaw Minimal — 仅 Telegram，轻量级（由 bob 维护）

如果选择风味：

```bash
git remote add <风味名称> https://github.com/alice/nanoclaw.git
git fetch <风味名称> main
git merge <风味名称>/main
```

然后正常继续设置（依赖、认证、容器、服务）。

**此选择仅在新鲜 fork 时提供** — 当用户的 main 匹配或接近上游的 main 且无本地提交时。如果 `/setup` 检测到显著的本地更改（在现有安装上重新运行设置），它跳过风味选择，直接进入配置。

安装后，用户的 fork 有三个远程：
- `origin` — 他们的 fork（推送自定义到这里）
- `upstream` — `qwibitai/nanoclaw`（核心更新）
- `<风味名称>` — 风味 fork（风味更新）

### 更新风味

```bash
git fetch <风味名称> main
git merge <风味名称>/main
```

风味维护者保持其 fork 更新（合并上游、更新技能）。用户拉取风味更新的方式与拉取核心更新相同。

### 风味注册表

`flavors.yaml` 位于上游仓库：

```yaml
flavors:
  - name: NanoClaw for Sales
    repo: alice/nanoclaw
    description: Gmail + Slack + CRM 集成，每日管道摘要
    maintainer: alice

  - name: NanoClaw Minimal
    repo: bob/nanoclaw
    description: 仅 Telegram，无容器开销
    maintainer: bob
```

任何人都可以 PR 添加他们的风味。文件在 `/setup` 运行时在本地可用，因为它是克隆仓库的一部分。

### 可发现性

- **设置期间** — 风味选择在初始设置流程中提供
- **`/browse-flavors` 技能** — 随时读取 `flavors.yaml` 并提供选项
- **GitHub topics** — 风味 fork 可以用 `nanoclaw-flavor` 标签搜索
- **Discord / 网站** — 社区策划列表

## 迁移

从旧技能引擎到分支的迁移已完成。所有功能技能现在位于 `skill/*` 分支上，技能引擎已被移除。

### 技能分支

| 分支 | 基础 | 描述 |
|--------|------|-------------|
| `skill/whatsapp` | `main` | WhatsApp 通道 |
| `skill/telegram` | `main` | Telegram 通道 |
| `skill/slack` | `main` | Slack 通道 |
| `skill/discord` | `main` | Discord 通道 |
| `skill/gmail` | `main` | Gmail 通道 |
| `skill/voice-transcription` | `skill/whatsapp` | OpenAI Whisper 语音转录 |
| `skill/image-vision` | `skill/whatsapp` | 图像附件处理 |
| `skill/pdf-reader` | `skill/whatsapp` | PDF 附件阅读 |
| `skill/local-whisper` | `skill/voice-transcription` | 本地 whisper.cpp 转录 |
| `skill/ollama-tool` | `main` | Ollama MCP 服务器用于本地模型 |
| `skill/apple-container` | `main` | Apple Container 运行时 |
| `skill/reactions` | `main` | WhatsApp 表情符号反应 |

### 移除了什么

- `skills-engine/` 目录（整个引擎）
- `scripts/apply-skill.ts`、`scripts/uninstall-skill.ts`、`scripts/rebase.ts`
- `scripts/fix-skill-drift.ts`、`scripts/validate-all-skills.ts`
- `.github/workflows/skill-drift.yml`、`.github/workflows/skill-pr.yml`
- 来自技能目录的所有 `add/`、`modify/`、`tests/`、`manifest.yaml`
- `.nanoclaw/` 状态目录

操作技能（`setup`、`debug`、`update-nanoclaw`、`customize`、`update-skills`）保留在 `main` 的 `.claude/skills/` 中。

## 变化什么

### README 快速开始

之前：
```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
claude
```

之后：
```
1. 在 GitHub 上 fork qwibitai/nanoclaw
2. git clone https://github.com/<你>/nanoclaw.git
3. cd nanoclaw
4. claude
5. /setup
```

### 设置技能（`/setup`）

设置流程更新：

- 检查 `upstream` 远程是否存在；如果不存在，添加它：`git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- 检查 `origin` 是否指向用户的 fork（不是 qwibitai）。如果指向 qwibitai，指导他们通过 fork 迁移。
- **安装市场插件：** `claude plugin install nanoclaw-skills@nanoclaw-skills --scope project` — 使所有功能技能可用（热加载，无需重启）
- **询问添加哪些通道：** 提供通道选项（Discord、Telegram、Slack、WhatsApp、Gmail），运行相应的 `/add-*` 技能用于选定的通道
- **提供依赖技能：** 通道设置好后，提供相关的附加组件（例如 Telegram 后的 Agent Swarm，WhatsApp 后的语音转录）
- **可选启用社区市场：** 询问用户是否想要社区技能，安装这些市场插件

### `.claude/settings.json`

市场配置，以便官方市场自动注册：

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

### main 上的技能目录

`main` 上的 `.claude/skills/` 目录仅保留操作技能（setup、debug、update-nanoclaw、customize、update-skills）。功能技能（add-discord、add-telegram 等）位于市场仓库，通过 `/setup` 或 `/customize` 期间的 `claude plugin install` 安装。

### 技能引擎移除

以下可以移除：

- `skills-engine/` — 整个目录（应用、合并、重放、状态、备份等）
- `scripts/apply-skill.ts`
- `scripts/uninstall-skill.ts`
- `scripts/fix-skill-drift.ts`
- `scripts/validate-all-skills.ts`
- `.nanoclaw/` — 状态目录
- 来自所有技能目录的 `add/` 和 `modify/` 子目录
- 在 main 的 `.claude/skills/` 中的功能技能 SKILL.md 文件（它们现在位于市场）

操作技能（`setup`、`debug`、`update-nanoclaw`、`customize`、`update-skills`）保留在 `main` 的 `.claude/skills/` 中。

### 新基础设施

- **市场仓库**（`qwibitai/nanoclaw-skills`）— 捆绑所有功能技能的 SKILL.md 文件的单个 Claude Code 插件
- **CI GitHub Action** — 在每次推送到 `main` 时将 `main` 合并到所有 `skill/*` 分支，使用 Claude（Haiku）进行冲突解决
- **`/update-skills` 技能** — 使用 git 历史检查和合并技能分支更新
- **`CONTRIBUTORS.md`** — 跟踪技能贡献者

### 更新技能（`/update-nanoclaw`）

更新技能使用基于分支的方法变得更简单。旧技能引擎需要在合并核心更新后重放所有应用的技能 — 整个步骤消失。技能更改已经在用户的 git 历史中，所以 `git merge upstream/main` 就可以工作。

**保持不变的：**
- 预检（干净的工作树、上游远程）
- 备份分支 + 标签
- 预览（git log、git diff、文件桶）
- 合并/樱桃拣选/变基选项
- 冲突预览（干运行合并）
- 冲突解决
- 构建 + 测试验证
- 回滚指令

**移除的：**
- 技能重放步骤（旧技能引擎在核心更新后重新应用技能所需）
- 重新运行结构化操作（npm 依赖、环境变量 — 这些现在是 git 历史的一部分）

**添加的：**
- 最后可选步骤："检查技能更新？"运行 `/update-skills` 逻辑
- 检查任何以前合并的技能分支是否有新提交（技能本身的错误修复、改进 — 不仅仅是与 main 的合并向前）

**为什么用户在核心更新后不需要重新合并技能：**
当用户合并技能分支时，这些更改成为其 git 历史的一部分。当他们后来合并 `upstream/main` 时，git 执行正常的三方合并 — 树中的技能更改未触及，只引入核心更改。合并向前 CI 确保技能分支与最新的 main 兼容，但那是针对新鲜应用技能的新用户。已经合并技能的用户不需要做任何事情。

用户只需要重新合并技能分支，如果技能本身更新了（不仅仅是与 main 的合并向前）。`/update-skills` 检查检测到这一点。

## Discord 公告

### 对于现有用户

> **技能现在是 git 分支**
>
> 我们简化了 NanoClaw 中技能的工作方式。技能现在是 git 分支，你合并它们，而不是自定义技能引擎。
>
> **这对你意味着什么：**
> - 应用技能：`git fetch upstream skill/discord && git merge upstream/skill/discord`
> - 更新核心：`git fetch upstream main && git merge upstream/main`
> - 检查技能更新：`/update-skills`
> - 不再有 `.nanoclaw/` 状态目录或技能引擎
>
> **我们现在推荐 fork 而不是克隆。** 这为你提供一个远程来推送你的自定义。
>
> **如果你当前有带本地更改的克隆**，迁移到 fork：
> 1. 在 GitHub 上 fork `qwibitai/nanoclaw`
> 2. 运行：
>    ```
>    git remote rename origin upstream
>    git remote add origin https://github.com/<你>/nanoclaw.git
>    git push --force origin main
>    ```
>    这即使你远远落后也有效 — 只需推送你当前的状态。
>
> **如果你以前通过旧系统应用技能**，你的代码更改已经在你的工作树中 — 无需重做。你可以删除 `.nanoclaw/` 目录。未来的技能和更新使用基于分支的方法。
>
> **发现技能：** 技能现在通过 Claude Code 的插件市场提供。在 Claude Code 中运行 `/plugin` 浏览和安装可用的技能。

### 对于技能贡献者

> **贡献技能**
>
> 要贡献技能：
> 1. fork `qwibitai/nanoclaw`
> 2. 从 `main` 分支并进行代码更改
> 3. 打开常规的 PR
>
> 就这样。我们将从你的 PR 创建 `skill/<name>` 分支，将你添加到 CONTRIBUTORS.md，并将 SKILL.md 添加到市场。CI 使用 Claude 自动将技能分支与 main 合并向前，自动解决任何冲突。
>
> **想运行你自己的技能市场？** 在你的 fork 上维护技能分支并创建市场仓库。打开 PR 将其添加到 NanoClaw 的自动发现市场 — 或用户可以通过 `/plugin marketplace add` 手动添加它。
