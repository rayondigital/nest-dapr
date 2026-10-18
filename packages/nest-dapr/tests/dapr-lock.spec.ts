import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DaprClient, DaprServer } from '@dapr/dapr';
import { LockStatus } from '@dapr/dapr/types/lock/UnlockResponse';
import { DaprLockAcquisitionError, DaprLockClient } from '../lib';
import { SidecarContext } from '../lib/emulator/sidecar-context';
import { TestModule } from './e2e/test.module';

// Emulator mode: DAPR_TEST_MODE=emulator pnpm test -- lock
// Real sidecar: DAPR_TEST_MODE=real pnpm test -- lock
describe('DaprLockClient', () => {
  let sidecar: SidecarContext;
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let lockClient: DaprLockClient;

  beforeAll(async () => {
    sidecar = await SidecarContext.start();

    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = testingModule.createNestApplication();
    await app.init();
    await app.listen(0);
    daprServer = app.get<DaprServer>(DaprServer);
    daprClient = testingModule.get(DaprClient);
    lockClient = testingModule.get(DaprLockClient);
    expect(daprClient).toBeDefined();
    expect(lockClient).toBeDefined();
  });

  it('should acquire and release a lock', async () => {
    const resourceId = `resource-${randomUUID()}`;
    const owner = randomUUID();

    const lockResponse = await lockClient.lock(resourceId, owner, 30);
    expect(lockResponse.success).toBe(true);

    const unlockResponse = await lockClient.unlock(resourceId, owner);
    expect(unlockResponse.status).toBe(LockStatus.Success);
  });

  it('should fail to acquire a lock already held by another owner', async () => {
    const resourceId = `resource-${randomUUID()}`;
    const firstOwner = randomUUID();
    const secondOwner = randomUUID();

    const firstResponse = await lockClient.lock(resourceId, firstOwner, 30);
    expect(firstResponse.success).toBe(true);

    const secondResponse = await lockClient.lock(resourceId, secondOwner, 30);
    expect(secondResponse.success).toBe(false);

    await lockClient.unlock(resourceId, firstOwner);
  });

  it('should not allow unlocking a lock owned by another owner', async () => {
    const resourceId = `resource-${randomUUID()}`;
    const owner = randomUUID();
    const impostor = randomUUID();

    await lockClient.lock(resourceId, owner, 30);

    const unlockResponse = await lockClient.unlock(resourceId, impostor);
    expect(unlockResponse.status).toBe(LockStatus.LockBelongsToOthers);

    await lockClient.unlock(resourceId, owner);
  });

  it('tryLock should resolve to a boolean', async () => {
    const resourceId = `resource-${randomUUID()}`;
    const owner = randomUUID();

    const acquired = await lockClient.tryLock(resourceId, owner, 30);
    expect(acquired).toBe(true);

    await lockClient.unlock(resourceId, owner);
  });

  describe('withLock', () => {
    it('should run the callback while holding the lock, then release it', async () => {
      const resourceId = `resource-${randomUUID()}`;
      let ranInsideLock = false;

      const result = await lockClient.withLock(resourceId, async () => {
        ranInsideLock = true;
        // The lock should be held for another owner while the callback runs
        const contendingResponse = await lockClient.lock(resourceId, randomUUID(), 30);
        expect(contendingResponse.success).toBe(false);
        return 'done';
      });

      expect(ranInsideLock).toBe(true);
      expect(result).toBe('done');

      // The lock should be released once withLock completes
      const owner = randomUUID();
      const postResponse = await lockClient.lock(resourceId, owner, 30);
      expect(postResponse.success).toBe(true);
      await lockClient.unlock(resourceId, owner);
    });

    it('should release the lock even if the callback throws', async () => {
      const resourceId = `resource-${randomUUID()}`;

      await expect(
        lockClient.withLock(resourceId, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const owner = randomUUID();
      const postResponse = await lockClient.lock(resourceId, owner, 30);
      expect(postResponse.success).toBe(true);
      await lockClient.unlock(resourceId, owner);
    });

    it('should throw DaprLockAcquisitionError if the lock is already held', async () => {
      const resourceId = `resource-${randomUUID()}`;
      const owner = randomUUID();

      await lockClient.lock(resourceId, owner, 30);

      await expect(lockClient.withLock(resourceId, async () => 'unreachable')).rejects.toThrow(
        DaprLockAcquisitionError,
      );

      await lockClient.unlock(resourceId, owner);
    });
  });

  afterAll(async () => {
    await daprClient?.stop();
    await app.close();
    await app.getHttpServer().close();
    await daprServer.stop();
    await sidecar?.stop();
  });
});
