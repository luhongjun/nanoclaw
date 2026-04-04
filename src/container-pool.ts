/**
 * Container Pool Manager for NanoClaw.
 * Manages a pool of persistent containers with auto-shutdown capability.
 */
import { ChildProcess } from 'child_process';
import { logger } from './logger.js';
import {
  isContainerRunning,
  removeContainer,
  stopContainer,
  listNanoclawContainers,
} from './container-runtime.js';
import {
  CONTAINER_POOL_ENABLED,
  CONTAINER_AUTO_SHUTDOWN_MS,
} from './config.js';
import type { RegisteredGroup } from './types.js';

export interface PooledContainer {
  name: string;
  groupJid: string;
  groupFolder: string;
  lastActivity: number;
  process: ChildProcess | null;
  isActive: boolean; // true while processing a message
  shutdownTimer: ReturnType<typeof setTimeout> | null; // auto-shutdown timer
}

export interface ContainerAcquireResult {
  containerName: string;
  isNew: boolean;
  process: ChildProcess | null;
}

class ContainerPool {
  private containers = new Map<string, PooledContainer>();
  private globalCleanupTimer: ReturnType<typeof setInterval> | null =
    null;

  /** Check if the pool is enabled. */
  get enabled(): boolean {
    return CONTAINER_POOL_ENABLED;
  }

  /** Get current pool size. */
  get size(): number {
    return this.containers.size;
  }

  /** Get a container from the pool or mark for creation. */
  acquire(
    group: RegisteredGroup,
    chatJid: string,
    containerName: string,
  ): ContainerAcquireResult {
    if (!this.enabled) {
      return { containerName, isNew: true, process: null };
    }

    const existing = this.containers.get(chatJid);

    // Check if existing container is healthy
    if (existing && existing.process && isContainerRunning(containerName)) {
      // Cancel any pending shutdown
      this.cancelShutdownTimer(chatJid);
      existing.lastActivity = Date.now();
      existing.isActive = true;
      logger.info(
        { chatJid, containerName },
        'Reusing existing container from pool',
      );
      return { containerName, isNew: false, process: existing.process };
    }

    // Container doesn't exist or unhealthy - will create new
    if (existing) {
      logger.info(
        { chatJid, containerName },
        'Existing container unhealthy, will recreate'
      );
      this.containers.delete(chatJid);
    }

    // Register new container entry
    const pooled: PooledContainer = {
      name: containerName,
      groupJid: chatJid,
      groupFolder: group.folder,
      lastActivity: Date.now(),
      process: null, // will be set by registerProcess
      isActive: true,
      shutdownTimer: null,
    };
    this.containers.set(chatJid, pooled);

    logger.info(
      { chatJid, containerName, poolSize: this.containers.size },
      'Creating new container'
    );
    return { containerName, isNew: true, process: null };
  }

  /** Register the process handle after container creation. */
  registerProcess(chatJid: string, process: ChildProcess): void {
    const entry = this.containers.get(chatJid);
    if (entry) {
      entry.process = process;
    }
  }

  /** Update activity timestamp (called on each output). */
  touch(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  /** mark container as idle after processing completes - start auto-shutdown timer. */
  release(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (entry) {
      entry.isActive = false;
      entry.lastActivity = Date.now();
      // Start auto-shutdown timer
      entry.shutdownTimer = setTimeout(() => {
        this.evict(chatJid).catch(() => {
          // Already evicted or error during eviction
        });
      }, CONTAINER_AUTO_SHUTDOWN_MS);
      logger.info(
        { chatJid, containerName: entry.name, shutdownMs: CONTAINER_AUTO_SHUTDOWN_MS },
        'Container marked idle, auto-shutdown scheduled',
      );
    }
  }

  /** Cancel a pending shutdown timer. */
  private cancelShutdownTimer(chatJid: string): void {
    const entry = this.containers.get(chatJid);
    if (entry?.shutdownTimer) {
      clearTimeout(entry.shutdownTimer);
      entry.shutdownTimer = null;
      logger.info({ chatJid }, 'Auto-shutdown cancelled - container being reused');
    }
  }

  /** remove a container from the pool and stop it. */
  async evict(chatJid: string): Promise<void> {
    const entry = this.containers.get(chatJid);
    if (!entry) return;

    this.containers.delete(chatJid);

    try {
      if (isContainerRunning(entry.name)) {
        stopContainer(entry.name);
        removeContainer(entry.name);
        logger.info(
          { chatJid, containerName: entry.name },
          'Evicted container from pool',
        );
      }
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to evict container');
    }
  }

  /** start the global cleanup timer (orphan detection). */
  startGlobalCleanupTimer(): void {
    if (!this.enabled || this.globalCleanupTimer) return;

    this.globalCleanupTimer = setInterval(() => {
      this.cleanupOrphans();
    }, 60000); // check every minute

    logger.info('Container pool orphan cleanup timer started');
  }

  /** stop the global cleanup timer. */
  stopGlobalCleanupTimer(): void {
    if (this.globalCleanupTimer) {
      clearInterval(this.globalCleanupTimer);
      this.globalCleanupTimer = null;
    }
  }

  /** Shutdown the pool - stop all containers. */
  async shutdown(): Promise<void> {
    this.stopGlobalCleanupTimer();

    const evictPromises = Array.from(this.containers.keys()).map((chatJid) =>
      this.evict(chatJid),
    );

    await Promise.allSettled(evictPromises);
    this.containers.clear();

    logger.info('Container pool shut down');
  }

  /** Clean up any orphaned containers not tracked by this pool. */
  cleanupOrphans(): void {
    const trackedNames = new Set(
      Array.from(this.containers.values()).map((c) => c.name),
    );
    const allContainers = listNanoclawContainers();

    for (const name of allContainers) {
      if (!trackedNames.has(name)) {
        try {
          stopContainer(name);
          removeContainer(name);
          logger.info({ name }, 'Removed orphaned container');
        } catch (err) {
          logger.warn({ name, err }, 'Failed to remove orphaned container');
        }
      }
    }
  }

  /** Get pool stats for monitoring. */
  getStats(): {
    total: number;
    active: number
    idle: number
    containers: Array<{ name: string; idleMs: number; isActive: boolean }>;
  } {
    const now = Date.now();
    let active = 0;
    let idle = 0;
    const containers: Array<{ name: string; idleMs: number; isActive: boolean }> =
      [];

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
