import { randomUUID } from 'crypto';
import { DaprClient } from '@dapr/dapr';
import { LockResponse } from '@dapr/dapr/types/lock/LockResponse';
import { LockStatus, UnlockResponse } from '@dapr/dapr/types/lock/UnlockResponse';
import { Injectable, Logger } from '@nestjs/common';

export interface WithLockOptions {
  /** Name of the lock store component. Defaults to the value set via setDefaultName (or 'lockstore'). */
  storeName?: string;
  /** Unique identifier for the lock owner. Defaults to a random UUID generated per call. */
  lockOwner?: string;
  /** Seconds until the lock automatically expires if not released. Defaults to 60. */
  expiryInSeconds?: number;
}

export class DaprLockAcquisitionError extends Error {
  constructor(readonly storeName: string, readonly resourceId: string) {
    super(`Unable to acquire lock for resource "${resourceId}" on lock store "${storeName}"`);
    this.name = 'DaprLockAcquisitionError';
  }
}

/**
 * A thin NestJS-friendly wrapper around the Dapr JS SDK's Distributed Lock API.
 * @see https://docs.dapr.io/developing-applications/building-blocks/distributed-lock/
 */
@Injectable()
export class DaprLockClient {
  private readonly logger = new Logger(DaprLockClient.name);

  private defaultName = 'lockstore';

  constructor(private readonly daprClient: DaprClient) {}

  setDefaultName(name: string) {
    this.defaultName = name;
  }

  /**
   * Attempts to acquire a distributed lock for a resource.
   *
   * @param resourceId - A unique identifier for the resource to lock. Other clients must use the
   * same resourceId to contend for the same lock.
   * @param lockOwner - A unique identifier for the owner acquiring the lock, used to prevent
   * unauthorized lock release.
   * @param expiryInSeconds - The duration in seconds after which the lock automatically expires
   * if not explicitly released.
   * @param storeName - The name of the lock store component. Defaults to the configured default name.
   */
  async lock(
    resourceId: string,
    lockOwner: string,
    expiryInSeconds: number,
    storeName?: string,
  ): Promise<LockResponse> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.lock.lock(storeName, resourceId, lockOwner, expiryInSeconds);
  }

  /**
   * Releases a previously acquired distributed lock.
   *
   * @param resourceId - The resource identifier for the lock to release.
   * @param lockOwner - The owner identifier used when acquiring the lock. Must match for the unlock to succeed.
   * @param storeName - The name of the lock store component. Defaults to the configured default name.
   */
  async unlock(resourceId: string, lockOwner: string, storeName?: string): Promise<UnlockResponse> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.lock.unlock(storeName, resourceId, lockOwner);
  }

  /**
   * Attempts to acquire a distributed lock, returning a simple boolean instead of a LockResponse.
   */
  async tryLock(resourceId: string, lockOwner: string, expiryInSeconds: number, storeName?: string): Promise<boolean> {
    const response = await this.lock(resourceId, lockOwner, expiryInSeconds, storeName);
    return response?.success === true;
  }

  /**
   * Acquires a distributed lock, runs the provided callback, and releases the lock once it settles
   * (whether it resolves or throws). Throws DaprLockAcquisitionError if the lock could not be acquired.
   *
   * @example
   * ```typescript
   * const result = await lockClient.withLock('order-42', async () => {
   *   // Critical section protected by the distributed lock
   *   return await processOrder('order-42');
   * });
   * ```
   */
  async withLock<T>(resourceId: string, fn: () => Promise<T>, options?: WithLockOptions): Promise<T> {
    const storeName = options?.storeName ?? this.defaultName;
    const lockOwner = options?.lockOwner ?? randomUUID();
    const expiryInSeconds = options?.expiryInSeconds ?? 60;

    const response = await this.daprClient.lock.lock(storeName, resourceId, lockOwner, expiryInSeconds);
    if (!response?.success) {
      throw new DaprLockAcquisitionError(storeName, resourceId);
    }

    try {
      return await fn();
    } finally {
      try {
        const unlockResponse = await this.daprClient.lock.unlock(storeName, resourceId, lockOwner);
        if (unlockResponse?.status !== undefined && unlockResponse.status !== LockStatus.Success) {
          this.logger.warn(
            `Unlock of resource "${resourceId}" on lock store "${storeName}" returned status ${
              LockStatus[unlockResponse.status]
            }`,
          );
        }
      } catch (error) {
        this.logger.error(`Failed to release lock for resource "${resourceId}" on lock store "${storeName}"`, error);
      }
    }
  }
}
