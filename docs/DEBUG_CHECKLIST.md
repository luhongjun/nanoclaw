# NanoClaw 调试检查清单

## 已知问题（2026-02-08）

### 1. [已修复] 从过时的树位置恢复分支
当 agent 团队生成子 agent CLI 进程时，它们写入同一个会话 JSONL。在随后的 `query()` 恢复时，CLI 读取 JSONL 但可能会选择一个过时的分支提示（在子 agent 活动之前），导致 agent 的响应落到一个主机从未收到 `result` 的分支上。**修复**：传递 `resumeSessionAt` 与最后一条 assistant 消息的 UUID，以明确锚定每次恢复。

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT（两者都是 30 分钟）
两个定时器同时触发，因此容器总是通过硬 SIGKILL（代码 137）退出，而不是优雅的 `_close` 哨兵关闭。空闲超时应该更短（例如 5 分钟），以便容器在消息之间降级，而容器超时保持在 30 分钟作为安全网。

### 3. 在 agent 成功之前游标已前进
`processGroupMessages` 在 agent 运行之前前进 `lastAgentTimestamp`。如果容器超时，重试会发现没有消息（游标已经过去）。消息在超时时永久丢失。

### 4. Kubernetes 镜像垃圾回收删除 nanoclaw-agent 镜像

**症状**：`Container exited with code 125: pull access denied for nanoclaw-agent` — 容器镜像过夜或几小时后消失，即使你刚刚构建它。

**原因**：如果容器运行时启用了 Kubernetes（Rancher Desktop 默认启用它），kubelet 会在磁盘使用率超过 85% 时运行镜像垃圾回收。NanoClaw 容器是临时的（运行后退出），所以 `nanoclaw-agent:latest` 从没有被运行中的容器保护。kubelet 将其视为未使用并删除它 — 通常在没有消息处理时过夜发生。其他镜像（docker-compose 服务）存活是因为它们有长期运行的容器引用它们。

**修复**：如果不需要 Kubernetes，请禁用它：
```bash
# Rancher Desktop
rdctl set --kubernetes-enabled=false

# 然后重建容器镜像
./container/build.sh
```

**诊断**：检查 k3s 日志以查找镜像 GC 活动：
```bash
grep -i "nanoclaw" ~/Library/Logs/rancher-desktop/k3s.log
# 查找："Removing image to free bytes" 与 nanoclaw-agent 镜像 ID
```

检查 NanoClaw 日志以查找镜像状态：
```bash
grep -E "image found|image NOT found|image missing" logs/nanoclaw.log
```

如果需要启用 Kubernetes，将 `CONTAINER_IMAGE` 设置为存储在注册表中的镜像，kubelet 不会 GC，或提高 GC 阈值。

## 快速状态检查

```bash
# 1. 服务是否运行？
launchctl list | grep nanoclaw
# 预期：PID  0  com.nanoclaw（PID = 运行，"-" = 未运行，非零退出 = 崩溃）

# 2. 有任何运行中的容器吗？
docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. 有任何停止/孤立的容器吗？
docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. 日志中最近的错误？
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. 通道是否连接？（查找最后的连接事件）
grep -E 'Connected|Connection closed|connection.*close|channel.*ready' logs/nanoclaw.log | tail -5

# 6. 组是否加载？
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## 会话转录分支

```bash
# 检查会话调试日志中的并发 CLI 进程
ls -la data/sessions/<group>/.claude/debug/

# 计算处理消息的唯一 SDK 进程数
# 每个 .txt 文件 = 一个 CLI 子进程。多个 = 并发查询。

# 检查转录中的 parentUuid 分支
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## 容器超时调查

```bash
# 检查最近的超时
grep -E 'Container timeout|timed out' logs/nanoclaw.log | tail -10

# 检查超时容器的日志文件
ls -lt groups/*/logs/container-*.log | head -10

# 读取最近的容器日志（替换路径）
cat groups/<group>/logs/container-<timestamp>.log

# 检查是否安排了重试以及发生了什么
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent 无响应

```bash
# 检查是否从通道接收到消息
grep 'New messages' logs/nanoclaw.log | tail -10

# 检查是否处理了消息（生成了容器）
grep -E 'Processing messages|Spawning container' logs/nanoclaw.log | tail -10

# 检查消息是否被传送到活动容器
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# 检查队列状态 — 有任何活动容器吗？
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# 检查 lastAgentTimestamp 与最新消息时间戳
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## 容器挂载问题

```bash
# 检查挂载验证日志（在容器生成时显示）
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# 验证挂载允许列表是否可读
cat ~/.config/nanoclaw/mount-allowlist.json

# 检查数据库中组的 container_config
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# 测试运行容器以检查挂载（空运行）
# 将 <group-folder> 替换为组的文件夹名称
docker run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## 通道认证问题

```bash
# 检查是否请求了 QR 码（意味着认证过期）
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# 检查认证文件是否存在
ls -la store/auth/

# 如果需要重新认证
npm run auth
```

## 服务管理

```bash
# 重启服务
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 查看实时日志
tail -f logs/nanoclaw.log

# 停止服务（注意 — 运行中的容器被分离，不会被杀死）
launchctl bootout gui/$(id -u)/com.nanoclaw

# 启动服务
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# 代码更改后重建
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
