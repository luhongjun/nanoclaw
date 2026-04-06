# Container Pool 改进实现计划

## goal
增强容器池的消息可靠性:
- 添加 IPC 消息检查机制, 防止消息丢失
- 添加 IPC 文件顺序保证, 防止消息乱序
- 添加超时清理, 防止积压
- 添加健康状态缓存, 优化性能

## architecture
- **IPC 检查**: 在发送 IPC 消息前, 检查 `input/` 目录是否有未处理的消息文件
- **顺序保证**: 使用时间戳 + 序号 + 随机数生成唯一文件名
- **超时清理**: 容器空闲时清理超过 5 分钟的 IPC 文件
- **健康缓存**: 可选地, 缓存容器健康状态, 减少不必要的检查

## tech stack
- **Node.js** TypeScript
- **fs** 文件系统操作
- **child_process** 执行 Docker 命令

## task structure
### Task 1: IPC 消息顺序保证
**Files:**
- Modify: `src/container-runner.ts`

**Changes:**
- 修改 `msg-${Date.now()}.json` 文件名生成逻辑
- 添加序号 + 随机数保证唯一性

```typescript
// Before:
const ipcFileName = `msg-${Date.now()}.json`;

// After:
const sequence = Date.now().toString(36).padStart(6, '0');
const random = Math.random().toString(36).substring(2, 8);
const ipcFileName = `msg-${sequence}-${random}.json`;
```

- [ ] **Step 1: Write failing test**

Create test for IPC 文件名唯一性

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` expect failure
Expected: Test fails because IPC file name may冲突

- [ ] **Step 3: Write minimal implementation**

修改 `container-runner.ts` 中的文件名生成逻辑

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: Test passes

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts tests/container-runner.test.ts
git commit -m "feat(ipc): add sequence number to filename for uniqueness"
```

### Task 2: IPC 检查机制
**Files:**
- Modify: `src/container-runner.ts`

**Changes:**
- 在 IPC 发送逻辑前添加检查
- 检查 `input/` 目录是否有未处理的消息文件
- 如果有, 返回错误提示

```typescript
// 新增逻辑
if (fs.existsSync(inputDir)) {
  const pendingFiles = fs.readdirSync(inputDir);
  if (pendingFiles.length > 0) {
    logger.warn({ group: group.name, pendingCount: pendingFiles.length }, 'IPC messages pending');
    return {
      status: 'error',
      result: null,
      error: 'AI 正在分析中，请稍后再发送消息',
    };
  }
}
```

- [ ] **Step 1: Write failing test**

Create test for IPC 检查逻辑
- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` expect failure
Expected: Test fails because IPC check returns error
- [ ] **Step 3: Write minimal implementation**

修改 `container-runner.ts` 添加 IPC 检查逻辑
- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: Test passes
- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(ipc): add pending message check"
```

### Task 3: 超时 IPC 文件清理
**Files:**
- Modify: `src/container-pool.ts`

**Changes:**
- 在 `release()` 方法中添加超时清理逻辑

```typescript
// 新增逻辑
// 清理超过 5 分钟的 IPC 输入文件
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

- [ ] **Step 1: Write failing test**

Create test for超时清理逻辑
- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` expect failure
Expected: Test fails because no cleanup occurs
- [ ] **Step 3: Write minimal implementation**

修改 `container-pool.ts` 添加超时清理逻辑
- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: Test passes
- [ ] **Step 5: Commit**

```bash
git add src/container-pool.ts
git commit -m "feat(pool): cleanup stale IPC files on release"
```

### Task 4: 嶩康状态缓存 (可选优化)
**Files:**
- Modify: `src/container-pool.ts`

**Changes:**
- 添加 `healthy` 和 `lastHealthCheck` 字段到 `PooledContainer` 接口
- 更新相关方法使用这些字段

- 可选地添加健康检查方法

- [ ] **Step 1: Write minimal implementation**

修改接口和方法
- [ ] **Step 2: Commit (no tests for optional optimization)**

```bash
git add src/container-pool.ts
git commit -m "feat(pool): add container health state tracking"
```

---
