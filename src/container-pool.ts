/**
 * Container Pool Manager for NanoClaw.
 *
 * Simplified design:
 * - Same chatJid reuses the same container
 * - 15-minute idle timeout auto-shutdown
 * - No process tracking (not needed)
 * - Async cleanup (non-blocking)
 */
import { logger } from './logger.js';
import {
  isContainerRunning,
  containerExists,
  removeContainer,
  stopContainer,
} from './container-runtime.js';
import {
  CONTAINER_POOL_ENABLED,
  CONTAINER_AUTO_SHUTDOWN_MS,
} from './config.js';
import type { RegisteredGroup } from './types.js';
import { resolveGroupIpcPath } from './group-folder.js';
import fs from 'fs';
import path from 'path';

export interface PooledContainer {
  name: string;
  groupJid: string;
  groupFolder: string;
  lastActivity: number;
  isActive: boolean;
  shutdownTimer: ReturnType<typeof setTimeout> | null;
  healthy?: boolean;
  lastHealthCheck?: number;
}

export interface ContainerAcquireResult {
  containerName: string;
  isNew: boolean;
}

class ContainerPool {
  private containers = new Map<string, PooledContainer>();
  private globalCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupLocks = new Set<string>(); // Prevent concurrent cleanup for same chatJid

  /** Check if the pool is enabled. */
  get enabled(): boolean {
    return CONTAINER_POOL_ENABLED;
  }

  /** Get current pool size. */
  get size(): number {
    return this.containers.size;
  }

  /**
   * Get a container from the pool or prepare for creation.
   *
   * Returns:
   * - isNew: true → need to create new container (docker run)
   * - isNew: false → container exists and running, can reuse
   *
   * This method is synchronous for fast path (reuse), but may trigger
   * async cleanup if existing container is unhealthy.
   */
  acquire(
    group: RegisteredGroup,
    chatJid: string,
    containerName: string,
  ): ContainerAcquireResult {
    if (!this.enabled) {
      return { containerName, isNew: true };
    }

    const existing = this.containers.get(chatJid);

    // Fast path: container exists and is running - reuse it
    if (existing && isContainerRunning(containerName)) {
      this.cancelShutdownTimer(chatJid);
      existing.lastActivity = Date.now();
      existing.isActive = true;
      logger.info(
        { chatJid, containerName },
        'Reusing existing container from pool',
      );
      return { containerName, isNew: false };
    }

    // Container doesn't exist or is stopped - need to create new
    if (existing) {
      logger.info(
        { chatJid, containerName },
        'Existing container stopped, removing before creating new',
      );
      // Cancel any pending shutdown timer
      this.cancelShutdownTimer(chatJid);
      // Remove from memory immediately
      this.containers.delete(chatJid);
      // MUST cleanup synchronously - docker run will fail if old container exists
      // Using `docker rm -f` which stops+removes in one step
      this.syncCleanupContainer(containerName);
    }

    // Register new container entry
    const pooled: PooledContainer = {
      name: containerName,
      groupJid: chatJid,
      groupFolder: group.folder,
      lastActivity: Date.now(),
      isActive: true,
      shutdownTimer: null,
    };
    this.containers.set(chatJid, pooled);

    logger.info(
      { chatJid, containerName, poolSize: this.containers.size },
      'Creating new container',
    );
    return { containerName, isNew: true };
  }

  /**
   * Schedule async cleanup of a stopped container.
   * Non-blocking - cleanup happens in background.
   */
  private scheduleCleanup(chatJid: string, containerName: string): void {
    // Prevent duplicate cleanup for same container
    if (this.cleanupLocks.has(containerName)) {
      return;
    }
    this.cleanupLocks.add(containerName);

    // Use setImmediate to run cleanup in next tick (non-blocking)
    setImmediate(() => {
      this.cleanupContainer(containerName)
        .finally(() => {
          this.cleanupLocks.delete(containerName);
        });
    });
  }

  /**
   * Synchronous cleanup - MUST be used before spawning new container.
   * Prevents "container name already in use" race condition.
   */
  private syncCleanupContainer(containerName: string): void {
    try {
      // `docker rm -f` stops and removes in one step
      removeContainer(containerName);
      logger.debug({ containerName }, 'Sync cleaned up container');
    } catch (err) {
      logger.warn({ containerName, err }, 'Failed to sync cleanup container');
    }
  }

  /**
   * Async cleanup of a container from Docker.
   * Used for non-blocking cleanup (e.g., idle timeout eviction).
   */
  private async cleanupContainer(containerName: string): Promise<void> {
    try {
      // Stop if running
      if (isContainerRunning(containerName)) {
        stopContainer(containerName);
      }
      // Remove (may take a moment)
      removeContainer(containerName);
      logger.debug({ containerName }, 'Cleaned up stopped container');
    } catch (err) {
      logger.warn({ containerName, err }, 'Failed to cleanup container');
    }
  }

  /**
   * Update activity timestamp (called on each output).
   */
  touch(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  /**
   * Mark container as idle after processing completes.
   * Starts the auto-shutdown timer (15 minutes by default).
   */
  release(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (!entry) return;

    entry.isActive = false;
    entry.lastActivity = Date.now();

    // Cancel any existing timer first
    this.cancelShutdownTimer(chatJid);

    // Clean up stale IPC files (older than 5 minutes)
    this.cleanupStaleIpcFiles(chatJid);

    // Start auto-shutdown timer
    entry.shutdownTimer = setTimeout(() => {
      this.evict(chatJid);
    }, CONTAINER_AUTO_SHUTDOWN_MS);

    logger.info(
      {
        chatJid,
        containerName: entry.name,
        shutdownMs: CONTAINER_AUTO_SHUTDOWN_MS,
      },
      'Container marked idle, auto-shutdown scheduled',
    );
  }

  /** Clean up IPC files older than 5 minutes. */
  private cleanupStaleIpcFiles(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (!entry) return;

    const ipcInputDir = resolveGroupIpcPath(entry.groupFolder);
    const inputDir = path.join(ipcInputDir, 'input');

    if (!fs.existsSync(inputDir)) return;

    const files = fs.readdirSync(inputDir);
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(inputDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < fiveMinAgo) {
          fs.unlinkSync(filePath);
          logger.debug({ file, chatJid }, 'Cleaned up stale IPC file');
        }
      } catch (err) {
        logger.warn({ file, chatJid, err }, 'Failed to cleanup IPC file');
      }
    }
  }

  /** Cancel a pending shutdown timer. */
  private cancelShutdownTimer(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (entry?.shutdownTimer) {
      clearTimeout(entry.shutdownTimer);
      entry.shutdownTimer = null;
    }
  }

  /** Remove a container from pool and Docker. */
  evict(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (!entry) return;

    // Remove from memory first (prevents reuse during cleanup)
    this.containers.delete(chatJid);
    this.cancelShutdownTimer(chatJid);

    const containerName = entry.name;

    // Async cleanup (non-blocking)
    this.cleanupContainer(containerName)
      .then(() => {
        logger.info({ chatJid, containerName }, 'Evicted container from pool');
      })
      .catch((err) => {
        logger.warn({ chatJid, containerName, err }, 'Failed to evict container');
      });
  }

  /** Start the global cleanup timer (orphan detection). */
  startGlobalCleanupTimer(): void {
    if (!this.enabled || this.globalCleanupTimer) return;

    this.globalCleanupTimer = setInterval(() => {
      this.cleanupOrphans();
    }, 60000); // check every minute

    logger.info('Container pool orphan cleanup timer started');
  }

  /** Stop the global cleanup timer. */
  stopGlobalCleanupTimer(): void {
    if (this.globalCleanupTimer) {
      clearInterval(this.globalCleanupTimer);
      this.globalCleanupTimer = null;
    }
  }

  /** Shutdown the pool - stop all containers. */
  async shutdown(): Promise<void> {
    this.stopGlobalCleanupTimer();

    const chatJids = Array.from(this.containers.keys());
    for (const chatJid of chatJids) {
      this.evict(chatJid);
    }
    this.containers.clear();

    logger.info('Container pool shut down');
  }

  /** Clean up any orphaned containers not tracked by this pool. */
  cleanupOrphans(): void {
    const trackedNames = new Set(
      Array.from(this.containers.values()).map((c) => c.name),
    );

    // Get all nanoclaw containers (running only - listNanoclawContainers uses docker ps without -a)
    const { listNanoclawContainers } = require('./container-runtime.js');
    const allContainers = listNanoclawContainers();

    for (const name of allContainers) {
      if (!trackedNames.has(name)) {
        logger.info({ name }, 'Removing orphaned container');
        this.cleanupContainer(name).catch(() => {});
      }
    }
  }

  /** Get pool stats for monitoring. */
  getStats(): {
    total: number;
    active: number;
    idle: number;
    containers: Array<{ name: string; idleMs: number; isActive: boolean }>;
  } {
    const now = Date.now();
    let active = 0;
    let idle = 0;
    const containers: Array<{
      name: string;
      idleMs: number;
      isActive: boolean;
    }> = [];

    for (const [, entry] of this.containers) {
      if (entry.isActive) active++;
      else idle++;
      containers.push({
        name: entry.name,
        idleMs: now - entry.lastActivity,
        isActive: entry.isActive,
      });
    }

    return { total: this.containers.size, active, idle, containers };
  }
}

// Singleton instance
export const containerPool = new ContainerPool();
