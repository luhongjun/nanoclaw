# NanoClaw 部署指南

从零开始安装和部署 NanoClaw 到本地环境，完成从 `git clone` 到服务运行的完整闭环。

---

## 系统要求

| 组件 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | 20+ | 主机运行时 |
| npm | 9+ | 包管理 |
| Docker / Containers | 最新版 | 容器运行时（agent 隔离执行） |
| Git | 2.30+ | 代码克隆 |

### 支持的平台

| 平台 | 服务管理 | 状态 |
|------|---------|------|
| macOS | launchd | ✅ 完整支持 |
| Linux (systemd) | systemd --user | ✅ 完整支持 |
| Windows (WSL2) | systemd / 手动 | ✅ 支持 |

---

## 快速开始（10 分钟）

```bash
# 1. 克隆仓库
git clone https://github.com/luhongjun/nanoclaw.git
cd nanoclaw

# 2. 安装依赖
npm install

# 3. 构建项目
npm run build

# 4. 构建容器镜像
bash container/build.sh

# 5. 运行设置向导
npx tsx setup/index.ts --step timezone
npx tsx setup/index.ts --step environment
npx tsx setup/index.ts --step container
npx tsx setup/index.ts --step groups
npx tsx setup/index.ts --step mounts
npx tsx setup/index.ts --step service

# 6. 启动服务
# macOS
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux
systemctl --user start nanoclaw

# 验证状态
# macOS
launchctl list | grep nanoclaw

# Linux
systemctl --user status nanoclaw
```

---

## 详细步骤

### 步骤 1：克隆仓库

```bash
git clone https://github.com/luhongjun/nanoclaw.git
cd nanoclaw
```

**验证：**
```bash
ls -la
# 应看到：package.json, src/, container/, setup/, docs/
```

---

### 步骤 2：安装依赖

```bash
npm install
```

**验证：**
```bash
node --version
# 输出：v20.x.x 或更高

npm list --depth=0
# 应看到：better-sqlite3, ws, cron-parser 等依赖
```

---

### 步骤 3：构建项目

```bash
npm run build
```

**验证：**
```bash
ls dist/
# 应看到：index.js, channels/, db.js, router.js 等编译后的文件
```

---

### 步骤 4：构建容器镜像

```bash
bash container/build.sh
```

**验证：**
```bash
# Docker
docker images | grep nanoclaw-agent

# 或 Apple Container / Containers
container images list | grep nanoclaw-agent
```

预期输出：
```
nanoclaw-agent    latest    xxxxx    2 days ago    1.2GB
```

---

### 步骤 5：配置环境变量

创建 `.env` 文件在项目根目录：

```bash
cat > .env << 'EOF'
# 助手名称（触发词为 @名称）
ASSISTANT_NAME=Andy

# Claude 认证（二选一）
# 选项 1: Claude 订阅 OAuth 令牌
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# 选项 2: 按量付费 API 密钥
# ANTHROPIC_API_KEY=sk-ant-api03-...

# 容器镜像名称
CONTAINER_IMAGE=nanoclaw-agent:latest

# 最大并发容器数
MAX_CONCURRENT_CONTAINERS=5

# 容器超时（毫秒，默认 30 分钟）
CONTAINER_TIMEOUT=1800000

# 空闲超时（毫秒，容器保持活动的时间）
IDLE_TIMEOUT=1800000
EOF
```

**验证：**
```bash
cat .env
# 确认 CLAUDE_CODE_OAUTH_TOKEN 或 ANTHROPIC_API_KEY 已设置
```

---

### 步骤 6：初始化数据库和目录

```bash
# 设置时区
npx tsx setup/index.ts --step timezone

# 初始化环境变量副本
npx tsx setup/index.ts --step environment

# 初始化容器配置
npx tsx setup/index.ts --step container

# 创建组目录结构
npx tsx setup/index.ts --step groups

# 配置挂载权限
npx tsx setup/index.ts --step mounts
```

**验证：**
```bash
# 检查数据库文件
ls -la store/messages.db

# 检查组目录
ls -la groups/
# 应看到：CLAUDE.md（全局内存）

# 检查数据目录
ls -la data/
# 应看到：sessions/, env/, ipc/
```

---

### 步骤 7：配置系统服务

#### macOS (launchd)

```bash
# 替换 plist 中的占位符
sed -i '' "s|{{PROJECT_ROOT}}|$(pwd)|g" launchd/com.nanoclaw.plist
sed -i '' "s|{{NODE_PATH}}|$(which node)|g" launchd/com.nanoclaw.plist
sed -i '' "s|{{HOME}}|$HOME|g" launchd/com.nanoclaw.plist

# 复制到 LaunchAgents 目录
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# 加载服务
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**验证：**
```bash
launchctl list | grep nanoclaw
# 输出：PID    0    com.nanoclaw（PID 为数字表示运行中）
```

#### Linux (systemd)

创建服务文件：

```bash
cat > ~/.config/systemd/user/nanoclaw.service << EOF
[Unit]
Description=NanoClaw Personal Assistant
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
ExecStart=$(which node) dist/index.js
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=ASSISTANT_NAME=Andy
Restart=always
RestartSec=10
StandardOutput=append:$(pwd)/logs/nanoclaw.log
StandardError=append:$(pwd)/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
EOF

# 重新加载 systemd 配置
systemctl --user daemon-reload

# 启用并启动服务
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
```

**验证：**
```bash
systemctl --user status nanoclaw
# 应看到：Active: active (running)
```

#### Windows (WSL2)

在 WSL2 中按 Linux 步骤执行，或使用手动运行：

```bash
# 手动运行（前台）
npm start

# 或使用 nohup 后台运行
nohup npm start > nanoclaw.log 2>&1 &
```

---

### 步骤 8：验证安装

```bash
# 1. 检查服务状态
# macOS
launchctl list | grep nanoclaw

# Linux
systemctl --user status nanoclaw

# 2. 检查日志
tail -f logs/nanoclaw.log

# 3. 检查通道连接
grep 'Connected\|Channel' logs/nanoclaw.log | tail -10

# 4. 检查组加载
grep 'groupCount\|Registered group' logs/nanoclaw.log | tail -5
```

**预期日志输出：**
```
[INFO] Connected to WhatsApp
[INFO] Channel ready: whatsapp
[INFO] Registered 1 groups
[INFO] Message loop started
[INFO] Scheduler loop started
```

---

## 通道配置

NanoClaw 使用技能系统添加通道。安装后运行相应技能：

### WhatsApp

```bash
# 应用 WhatsApp 技能
npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp

# 重新构建
npm run build

# 认证（二选一）
# 方式 1: QR 码扫描
npx tsx src/whatsapp-auth.ts

# 方式 2: 配对码
npx tsx src/whatsapp-auth.ts --pairing-code --phone +8613800138000

# 注册聊天
npx tsx setup/index.ts --step register \
  --jid "8613800138000@s.whatsapp.net" \
  --name "我的聊天" \
  --trigger "@Andy" \
  --folder "whatsapp_main" \
  --channel whatsapp \
  --assistant-name "Andy" \
  --is-main \
  --no-trigger-required
```

### Telegram

```bash
# 应用 Telegram 技能
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram

# 重新构建
npm run build

# 配置 .env（添加以下行）
echo "TELEGRAM_BOT_TOKEN=your_bot_token_here" >> .env

# 注册聊天（替换为你的聊天 ID）
npx tsx setup/index.ts --step register \
  --jid "tg:123456789" \
  --name "我的聊天" \
  --trigger "@Andy" \
  --folder "telegram_main" \
  --channel telegram \
  --assistant-name "Andy" \
  --is-main \
  --no-trigger-required
```

**获取 Telegram Chat ID：**
1. 发送任意消息给你的机器人
2. 访问：`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. 查找 `chat.id` 字段

---

## 常用命令

### 服务管理

```bash
# macOS
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist    # 启动
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # 停止
launchctl kickstart -k gui/$(id -u)/com.nanoclaw            # 重启

# Linux
systemctl --user start nanoclaw      # 启动
systemctl --user stop nanoclaw       # 停止
systemctl --user restart nanoclaw    # 重启
systemctl --user status nanoclaw     # 状态
```

### 日志查看

```bash
# 实时日志
tail -f logs/nanoclaw.log

# 错误日志
tail -f logs/nanoclaw.error.log

# 搜索特定内容
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20
```

### 容器管理

```bash
# 查看运行中的容器
docker ps | grep nanoclaw

# 查看所有容器（包括已停止）
docker ps -a | grep nanoclaw

# 重建容器镜像
bash container/build.sh

# 清理旧镜像
docker image prune -f
```

### 数据库操作

```bash
# 查看注册的组
sqlite3 store/messages.db "SELECT * FROM registered_groups;"

# 查看会话
sqlite3 store/messages.db "SELECT * FROM sessions;"

# 查看最近消息
sqlite3 store/messages.db "SELECT id, sender, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT 10;"

# 查看定时任务
sqlite3 store/messages.db "SELECT * FROM scheduled_tasks;"
```

---

## 故障排查

### 服务无法启动

```bash
# 检查 Node.js 版本
node --version
# 必须是 20+

# 检查依赖是否安装
npm install

# 检查构建是否成功
npm run build

# 手动运行查看错误
node dist/index.js
```

### 容器构建失败

```bash
# 检查 Docker 是否运行
docker info

# 清理构建缓存
docker builder prune -f

# 重新构建
bash container/build.sh

# 检查镜像是否生成
docker images | grep nanoclaw-agent
```

### 通道连接失败

```bash
# 检查认证文件
ls -la store/auth/

# WhatsApp 重新认证
rm -rf store/auth/
npx tsx src/whatsapp-auth.ts

# Telegram 检查令牌
cat .env | grep TELEGRAM_BOT_TOKEN
```

### 数据库错误

```bash
# 备份数据库
cp store/messages.db store/messages.db.backup

# 检查数据库完整性
sqlite3 store/messages.db "PRAGMA integrity_check;"

# 如有问题，删除并重新创建（会丢失数据！）
rm store/messages.db
node dist/index.js  # 会自动创建新数据库
```

---

## 验收清单

- [ ] Node.js 20+ 已安装
- [ ] npm install 成功
- [ ] npm run build 成功（dist/ 目录有输出）
- [ ] 容器镜像构建成功（docker images 看到 nanoclaw-agent）
- [ ] .env 文件已创建并配置认证
- [ ] 数据库初始化成功（store/messages.db 存在）
- [ ] 系统服务已配置并运行
- [ ] 日志显示通道已连接
- [ ] 至少注册一个聊天组

---

## 下一步

安装完成后：

1. **添加更多通道** — 运行 `/add-telegram`、`/add-slack` 等技能
2. **配置定时任务** — 让 Claude 提醒你开会、发送日报等
3. **自定义行为** — 修改 `src/config.ts` 调整触发词、轮询间隔等
4. **贡献技能** — 创建你的 `/add-signal` 等技能并 PR 回上游

---

## 技术支持

- 官方文档：[docs.nanoclaw.dev](https://docs.nanoclaw.dev)
- GitHub Issues: [luhongjun/nanoclaw/issues](https://github.com/luhongjun/nanoclaw/issues)
- 本地调试：运行 `npm run dev` 获取详细日志
