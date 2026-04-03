# 在 Docker 沙盒中运行 NanoClaw（手动设置）

本指南逐步介绍从头开始设置 Docker 沙盒中的 NanoClaw — 无安装脚本，无预构建的 fork。你将克隆上游仓库，应用必要的补丁，并在完全的管理程序级隔离中运行 agent。

## 架构

```
主机（macOS / Windows WSL）
└── Docker 沙盒（带有隔离内核的微 VM）
    ├── NanoClaw 进程 (Node.js)
    │   ├── 通道适配器 (WhatsApp, Telegram 等)
    │   └── 容器生成器 → 嵌套 Docker 守护进程
    └── Docker-in-Docker
        └── nanoclaw-agent 容器
            └── Claude Agent SDK
```

每个 agent 在其自己的容器内运行，在完全隔离于主机的微 VM 内。两层隔离：每个 agent 容器 + VM 边界。

沙盒在 `host.docker.internal:3128` 提供 MITM 代理，自动处理网络访问并注入你的 Anthropic API 密钥。

> **注意：** 本指南基于在 macOS（Apple Silicon）上经验证运行的设置，使用 WhatsApp。其他通道（Telegram、Slack 等）和环境（Windows WSL）可能需要针对其特定 HTTP/WebSocket 客户端的额外代理补丁。核心补丁（容器运行器、凭证代理、Dockerfile）普遍适用 — 特定于通道的代理配置各不相同。

## 前提条件

- **Docker Desktop v4.40+** 支持沙盒
- **Anthropic API 密钥**（沙盒代理管理注入）
- **Telegram**：来自 [@BotFather](https://t.me/BotFather) 的机器人令牌和你的聊天 ID
- **WhatsApp**：安装了 WhatsApp 的手机

验证沙盒支持：
```bash
docker sandbox version
```

## 步骤 1：创建沙盒

在主机上：

```bash
# 创建工作目录
mkdir -p ~/nanoclaw-workspace

# 创建挂载了工作区的 shell 沙盒
docker sandbox create shell ~/nanoclaw-workspace
```

如果你使用 WhatsApp，配置代理旁路，这样 WhatsApp 的 Noise 协议不会被 MITM 检查：

```bash
docker sandbox network proxy shell-nanoclaw-workspace \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

Telegram 不需要代理旁路。

进入沙盒：
```bash
docker sandbox run shell-nanoclaw-workspace
```

## 步骤 2：安装前提条件

在沙盒内：

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
npm config set strict-ssl false
```

## 步骤 3：克隆和安装 NanoClaw

NanoClaw 必须位于工作目录内 — Docker-in-Docker 只能从共享的工作区路径进行绑定挂载。

```bash
# 首先克隆到 home（virtiofs 在克隆期间可能损坏 git pack 文件）
cd ~
git clone https://github.com/qwibitai/nanoclaw.git

# 替换为你的工作区路径（传递给 `docker sandbox create` 的主机路径）
WORKSPACE=/Users/you/nanoclaw-workspace

# 移入工作区，这样 DinD 挂载可以工作
mv nanoclaw "$WORKSPACE/nanoclaw"
cd "$WORKSPACE/nanoclaw"

# 安装依赖
npm install
npm install https-proxy-agent
```

## 步骤 4：应用代理和沙盒补丁

NanoClaw 需要几个补丁才能在 Docker 沙盒内工作。这些处理代理路由、CA 证书和 Docker-in-Docker 挂载限制。

### 4a. Dockerfile — 容器镜像构建的代理参数

`docker build` 内的 `npm install` 失败并显示 `SELF_SIGNED_CERT_IN_CHAIN`，因为沙盒的 MITM 代理呈现自己的证书。在 `container/Dockerfile` 中添加代理构建参数：

在 `FROM` 行后添加这些行：

```dockerfile
# 接受代理构建参数
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NODE_EXTRA_CA_CERTS
ARG npm_config_strict_ssl=true
RUN npm config set strict-ssl ${npm_config_strict_ssl}
```

在 `RUN npm install` 行后：

```dockerfile
RUN npm config set strict-ssl true
```

### 4b. 构建脚本 — 转发代理参数

修补 `container/build.sh` 将代理环境变量传递给 `docker build`：

添加这些 `--build-arg` 标志到 `docker build` 命令：

```bash
--build-arg http_proxy="${http_proxy:-$HTTP_PROXY}" \
--build-arg https_proxy="${https_proxy:-$HTTPS_PROXY}" \
--build-arg no_proxy="${no_proxy:-$NO_PROXY}" \
--build-arg npm_config_strict_ssl=false \
```

### 4c. 容器运行器 — 代理转发、CA 证书挂载、/dev/null 修复

对 `src/container-runner.ts` 的三个更改：

**替换 `/dev/null` 遮蔽挂载。** 沙盒拒绝 `/dev/null` 绑定挂载。找到 `.env` 被遮蔽挂载到 `/dev/null` 的地方，并用空文件替换它：

```typescript
// 创建一个空文件来遮蔽 .env（Docker 沙盒拒绝 /dev/null 挂载）
const emptyEnvPath = path.join(DATA_DIR, 'empty-env');
if (!fs.existsSync(emptyEnvPath)) fs.writeFileSync(emptyEnvPath, '');
// 在挂载中使用 emptyEnvPath 而不是'/dev/null'
```

**转发代理环境变量** 到生成的 agent 容器。为 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及其小写变体添加 `-e` 标志。

**挂载 CA 证书。** 如果设置了 `NODE_EXTRA_CA_CERTS` 或 `SSL_CERT_FILE`，将证书复制到项目目录中并挂载到 agent 容器中：

```typescript
const caCertSrc = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
if (caCertSrc) {
  const certDir = path.join(DATA_DIR, 'ca-cert');
  fs.mkdirSync(certDir, { recursive: true });
  fs.copyFileSync(caCertSrc, path.join(certDir, 'proxy-ca.crt'));
  // 挂载：certDir -> /workspace/ca-cert（只读）
  // 在容器中设置 NODE_EXTRA_CA_CERTS=/workspace/ca-cert/proxy-ca.crt
}
```

### 4d. 容器运行时 — 防止自终止

在 `src/container-runtime.ts` 中，`cleanupOrphans()` 函数通过 `nanoclaw-` 前缀匹配容器。在沙盒内，沙盒容器本身可能匹配（例如 `nanoclaw-docker-sandbox`）。过滤掉当前主机名：

```typescript
// 在 cleanupOrphans() 中，从要停止的容器列表中过滤出 os.hostname()
```

### 4e. 凭证代理 — 通过 MITM 代理路由

在 `src/credential-proxy.ts` 中，上游 API 请求需要通过沙盒代理。为出站请求添加 `HttpsProxyAgent`：

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const upstreamAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
// 将 upstreamAgent 传递给 https.request() 选项
```

### 4f. 设置脚本 — 代理构建参数

修补 `setup/container.ts` 以传递与 `build.sh`（步骤 4b）相同的代理 `--build-arg` 标志。

## 步骤 5：构建

```bash
npm run build
bash container/build.sh
```

## 步骤 6：添加通道

### Telegram

```bash
# 应用 Telegram 技能
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram

# 应用技能后重建
npm run build

# 配置 .env
cat > .env << EOF
TELEGRAM_BOT_TOKEN=<你的 BotFather 令牌>
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# 注册你的聊天
npx tsx setup/index.ts --step register \
  --jid "tg:<你的聊天-ID>" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "telegram_main" \
  --channel telegram \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**查找聊天 ID：** 发送任何消息给你的机器人，然后：
```bash
curl -s --proxy $HTTPS_PROXY "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool
```

**Telegram 在组中：** 在 @BotFather 中禁用组隐私（`/mybots` > 机器人设置 > 组隐私 > 关闭），然后移除并重新添加机器人。

**重要：** 如果 Telegram 技能创建 `src/channels/telegram.ts`，你需要为代理支持修补它。添加 `HttpsProxyAgent` 并通过 `baseFetchConfig.agent` 传递给 grammy 的 `Bot` 构造函数。然后重建。

### WhatsApp

确保你已经在 [步骤 1](#步骤 1-创建沙盒) 中配置了代理旁路。

```bash
# 应用 WhatsApp 技能
npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp

# 重建
npm run build

# 配置 .env
cat > .env << EOF
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

# 认证（选择一个）：

# QR 码 — 用 WhatsApp 相机扫描：
npx tsx src/whatsapp-auth.ts

# 或配对码 — 在 WhatsApp > 链接设备 > 用电话号码链接中输入：
npx tsx src/whatsapp-auth.ts --pairing-code --phone <电话号码无前缀>

# 注册你的聊天（JID = 你的电话号码 + @s.whatsapp.net）
npx tsx setup/index.ts --step register \
  --jid "<电话>@s.whatsapp.net" \
  --name "My Chat" \
  --trigger "@nanoclaw" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "nanoclaw" \
  --is-main \
  --no-trigger-required
```

**重要：** WhatsApp 技能文件（`src/channels/whatsapp.ts` 和 `src/whatsapp-auth.ts`）也需要代理补丁 — 为 WebSocket 连接添加 `HttpsProxyAgent` 和代理感知版本获取。然后重建。

### 两个通道

应用两个技能，都为代理支持修补两个，合并 `.env` 变量，并分别注册每个聊天。

## 步骤 7：运行

```bash
npm start
```

你不需要手动设置 `ANTHROPIC_API_KEY`。沙盒代理拦截请求并自动用真实密钥替换 `proxy-managed`。

## 网络详情

### 代理如何工作

来自沙盒的所有流量通过主机代理路由到 `host.docker.internal:3128`：

```
Agent 容器 → DinD 桥 → 沙盒 VM → host.docker.internal:3128 → 主机代理 → api.anthropic.com
```

**"旁路"并不意味着流量跳过代理。** 它意味着代理传递流量而不进行 MITM 检查。Node.js 不会自动使用 `HTTP_PROXY` 环境变量 — 你需要在每个 HTTP/WebSocket 客户端中显式配置 `HttpsProxyAgent`。

### DinD 挂载的共享路径

只有工作目录可用于 Docker-in-Docker 绑定挂载。工作区外的路径失败并显示"路径未共享"：
- `/dev/null` → 用项目目录中的空文件替换
- `/usr/local/share/ca-certificates/` → 将证书复制到项目目录
- `/home/agent/` → 克隆到工作区而不是

### Git 克隆和 virtiofs

工作区通过 virtiofs 挂载。Git 的 pack 文件处理在克隆期间可能在 virtiofs 上损坏。变通方法：首先克隆到非工作区路径，然后 `mv` 进去。

## 故障排除

### npm install 失败并显示 SELF_SIGNED_CERT_IN_CHAIN
```bash
npm config set strict-ssl false
```

### 容器构建失败并出现代理错误
```bash
docker build \
  --build-arg http_proxy=$http_proxy \
  --build-arg https_proxy=$https_proxy \
  -t nanoclaw-agent:latest container/
```

### Agent 容器失败并显示"path not shared"
所有绑定挂载的路径必须在工作区下。检查：
- NanoClaw 是否克隆到工作区？（不是`/home/agent/`）
- CA 证书是否复制到项目根目录？
- 是否创建了空`.env` 遮蔽文件？

### Agent 容器无法访问 Anthropic API
验证代理环境变量是否转发给 agent 容器。检查容器日志是否有 `HTTP_PROXY=http://host.docker.internal:3128`。

### WhatsApp 错误 405
版本获取返回过时的版本。确保应用了代理感知 `fetchWaVersionViaProxy` 补丁 — 它通过 `HttpsProxyAgent` 获取 `sw.js` 并解析 `client_revision`。

### WhatsApp"连接失败"立即
代理旁路未配置。从**主机**运行：
```bash
docker sandbox network proxy <沙盒名称> \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

### Telegram 机器人不接收消息
1. 检查 grammy 代理补丁是否应用（在 `src/channels/telegram.ts` 中查找 `HttpsProxyAgent`）
2. 如果在组中使用，检查 @BotFather 中的组隐私是否已禁用

### Git 克隆失败并显示"inflate: data stream error"
克隆到非工作区路径，然后移动：
```bash
cd ~ && git clone https://github.com/qwibitai/nanoclaw.git && mv nanoclaw /path/to/workspace/nanoclaw
```

### WhatsApp QR 码不显示
在沙盒内交互式运行认证命令（不要通过`docker sandbox exec` 管道）：
```bash
docker sandbox run shell-nanoclaw-workspace
# 然后在内部：
npx tsx src/whatsapp-auth.ts
```
