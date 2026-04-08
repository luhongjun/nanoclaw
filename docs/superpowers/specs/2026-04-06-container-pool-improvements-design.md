# Container Pool 改进设计

## 问题分析

经过对 `container-pool.ts`, `container-runner.ts`, `group-queue.ts` 的代码审查, 发现以下问题:
### 问题 1: Pool 模式 IPC 消息无确��机制 (严重 🔴)
**场景**: 用户连续发送两条消息
**现象**:
1. 第一条消息创建容器并处理
2. 容器运行中, 收到第二条消息
3. 第二条通过 IPC 发送给运行中的容器
4. `runContainerAgent` 立即返回 `success` (container-runner.ts:382-387)
5. **问题**: 无法确认 IPC 消���是否被处理
**风险**:
- 消息可能丢失 (容器崩溃/未读取)
- 用户体验差 (不知道消息是否发送成功)
- 无重试机制
### 问题 2: IPC 消息顺序无保证 (中等 🟡)
**场景**: 快速发送多条消息
**现象**:
1. IPC 文件名: `msg-${Date.now()}.json`
2. `Date.now()` 毫秒级, 可能重复
3. 文件系统读取顺序不保证
**风险**:
- 消息可能乱序处理
- 对话上下文混乱
### 问题 3: 容器健康检查简单 (低 🟢)
**场景**: 容器进程存在但内部服务崩溃
**现象**:
1. `isContainerRunning()` 只检查进程状态
2. 不检查容器内部服务健康
3. 僵尸容器可能接收新消息
**风险**:
- 消息发送到僵尸容器
- 超时等待
---
## 改进方案
基于用户反馈, 采用 **简化版方案**:
- **不引入复杂的队列/确认机制**
- **直接丢失消息并返回明确的错误提示**
- **用户友好**: "AI 正在分析中，请稍后"
### 改动 1: IPC 消息顺序保证
**文件**: `container-runner.ts:378`
**改进前**:
```typescript
const ipcFileName = `msg-${Date.now()}.json`;
```
**改进后**:
```typescript
// 使用序号 + 时间戳 + 随机数保证唯一性
const sequence = Date.now().toString(36).padStart(6, '0'); // 6位序号
const random = Math.random().toString(36).substring(2, 8); // 6位随机
const ipcFileName = `msg-${sequence}-${random}.json`;
```
**效果**:
- 序号保证唯一性
- 6位随机防止极端情况冲突
### 改动 2: IPC 检查机制
**文件**: `container-runner.ts:362-387`
**改进前**:
```typescript
if (CONTAINER_POOL_ENABLED && !acquired.isNew) {
  // Send message to existing container via IPC
  fs.writeFileSync(ipcFilePath, JSON.stringify(ipcMessage));
  return { status: 'success', result: null, newSessionId: undefined };
}
```
**改进后**:
```typescript
if (CONTAINER_POOL_ENABLED && !acquired.isNew) {
  // 1. 检查是否有未处理的 IPC 消息
  const ipcInputDir = resolveGroupIpcPath(group.folder);
  const inputDir = path.join(ipcInputDir, 'input');
  
  if (fs.existsSync(inputDir)) {
    const pendingFiles = fs.readdirSync(inputDir);
    if (pendingFiles.length > 0) {
      // 有未处理消息, 返回错误提示
      logger.warn({ group: group.name, pendingCount: pendingFiles.length }, 'IPC messages pending');
      return {
        status: 'error',
        result: null,
        error: 'AI 正在分析中，请稍后再发送消息',
      };
    }
  }
  
  // 2. 发送新消息 (使用改进的文件名)
  // ... 原有的发送逻辑 ...
}
```
**错误提示文案**: "AI 正在分析中，请稍后再发送消息"
### 改动 3: 清理超时 IPC 文件
**文件**: `container-pool.ts` `release()` 方法
**新增代码**:
```typescript
// 清理超过 5 分钟的 IPC 输入文件 (可能遗留)
const ipcInputDir = resolveGroupIpcPath(entry.groupFolder);
const inputDir = path.join(ipcInputDir, 'input');
if (fs.existsSync(inputDir)) {
  const files = fs.readdirSync(inputDir);
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < fiveMinAgo) {
      fs.unlinkSync(filePath);
    }
  }
}
```
**效果**: 定期清理可能阻塞的消息文件
### 改动 4: 容器健康状态缓存 (可选优化)
**文件**: `container-pool.ts`
**新增接口字段**:
```typescript
interface PooledContainer {
  // ... 现有字段 ...
  healthy?: boolean;  // 新增: 容器健康状态
  lastHealthCheck?: number;  // 新增: 上次检查时间
}
```
**效果**: 可以跟踪容器健康状态, 减少不必要的 docker ps 查询
---
## 改动文件清单
| 文件 | 改动类型 | 改动量 |
|------|----------|--------|
| `container-runner.ts` | 修改 | ~30 行 |
| `container-pool.ts` | 修改 | ~20 行 |
### 测试要点
1. **IPC 检查**: 快速发送两条消息, 第二条应返回错误提示
2. **顺序保证**: 检查生成的文件名是否唯一
3. **超时清理**: 棣查 5 分钟前的文件是否被清理
4. **健康状态**: 缓存是否正确更新
