# Apple 容器网络配置（macOS 26）

Apple Container 的 vmnet 网络需要手动配置才能让容器访问互联网。如果不配置，容器只能与宿主机通信，无法访问外部服务（DNS、HTTPS、API）。

## 快速设置

运行以下两条命令（需要 `sudo`）：

```bash
# 1. 启用 IP 转发，让宿主机路由容器流量
sudo sysctl -w net.inet.ip.forwarding=1

# 2. 启用 NAT，让容器流量通过你的互联网接口进行地址转换
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -
```

> **注意：** 将 `en0` 替换为你的活动互联网接口。使用以下命令检查：`route get 8.8.8.8 | grep interface`

## 持久化配置

这些设置在重启后会重置。要使其永久生效：

**IP 转发** — 添加到 `/etc/sysctl.conf`：
```
net.inet.ip.forwarding=1
```

**NAT 规则** — 添加到 `/etc/pf.conf`（在任何现有规则之前）：
```
nat on en0 from 192.168.64.0/24 to any -> (en0)
```

然后重新加载：`sudo pfctl -f /etc/pf.conf`

## IPv6 DNS 问题

默认情况下，DNS 解析器会先返回 IPv6（AAAA）记录，再返回 IPv4（A）记录。由于我们的 NAT 只处理 IPv4，容器内的 Node.js 应用会先尝试 IPv6 而失败。

容器镜像和运行器通过以下配置优先使用 IPv4：
```
NODE_OPTIONS=--dns-result-order=ipv4first
```

这在 `Dockerfile` 中设置，并通过 `container-runner.ts` 中的 `-e` 标志传递。

## 验证

```bash
# 检查 IP 转发是否启用
sysctl net.inet.ip.forwarding
# 预期：net.inet.ip.forwarding: 1

# 测试容器互联网访问
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
# 预期：404

# 检查桥接接口（仅在容器运行时存在）
ifconfig bridge100
```

## 故障排查

| 症状 | 原因 | 解决方法 |
|------|------|----------|
| `curl: (28) Connection timed out` | IP 转发未启用 | `sudo sysctl -w net.inet.ip.forwarding=1` |
| HTTP 正常，HTTPS 超时 | IPv6 DNS 解析 | 添加 `NODE_OPTIONS=--dns-result-order=ipv4first` |
| `Could not resolve host` | DNS 未转发 | 检查 bridge100 是否存在，验证 pfctl NAT 规则 |
| 容器输出后挂起 | agent-runner 中缺少 `process.exit(0)` | 重建容器镜像 |

## 工作原理

```
容器 VM (192.168.64.x)
    │
    ├── eth0 → 网关 192.168.64.1
    │
bridge100 (192.168.64.1) ← 宿主机桥接，由 vmnet 在容器运行时创建
    │
    ├── IP 转发 (sysctl) 从 bridge100 路由数据包到 en0
    │
    ├── NAT (pfctl) 将 192.168.64.0/24 地址转换为 en0 的 IP
    │
en0（你的 WiFi/以太网）→ 互联网
```

## 参考资料

- [apple/container#469](https://github.com/apple/container/issues/469) — macOS 26 上容器无法访问网络
- [apple/container#656](https://github.com/apple/container/issues/656) — 构建时无法访问互联网 URL
