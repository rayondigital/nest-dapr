import { Test, TestingModule } from '@nestjs/testing';
import { TestModule } from './e2e/test.module';
import { DaprClient, DaprPubSubStatusEnum, DaprServer } from '@dapr/dapr';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { sleep, waitForArrayLengthToBe } from './test.utils';
import { DaprPubSubClient } from '../lib';
import { SidecarContext } from '../lib/emulator/sidecar-context';
import { DEFAULT_PUBSUB_RETRY_POLICY } from '../lib/emulator/sidecar';

// The real sidecar uses pubsubRetry in tests/components/resiliency.yaml (3 retries, 1s apart).
// The emulator keeps the same retry count but redelivers much faster.
const REAL_RETRY_INTERVAL_MS = 1000;

// Emulator mode: DAPR_TEST_MODE=emulator pnpm test -- pubsub
// Real sidecar: DAPR_TEST_MODE=real pnpm test -- pubsub
describe('DaprPubSub', () => {
  let sidecar: SidecarContext;
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let pubsubClient: DaprPubSubClient;

  const runId = randomUUID();
  let messages = [];
  let handlerFn: (data: any) => Promise<DaprPubSubStatusEnum>;
  // How long to wait after the last expected delivery to prove no further redelivery happens
  let settleMs: number;

  beforeAll(async () => {
    sidecar = await SidecarContext.start();
    const isEmulator = sidecar.ports.mode === 'emulator';
    settleMs = 5 * (isEmulator ? DEFAULT_PUBSUB_RETRY_POLICY.intervalMs : REAL_RETRY_INTERVAL_MS);

    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    daprServer = testingModule.get(DaprServer);
    daprClient = testingModule.get(DaprClient);
    pubsubClient = testingModule.get(DaprPubSubClient);
    expect(daprClient).toBeDefined();
    expect(pubsubClient).toBeDefined();

    // Subscribe before app.init() starts the Dapr server, otherwise the sidecar may read
    // the app's subscription list before this subscription exists and never deliver to it.
    await daprServer.pubsub.subscribe('pubsub', 'events', async (data: any) => {
      console.log('Received message', data);
      if (data.run !== runId) {
        // This must be a message from a previous test run
        return DaprPubSubStatusEnum.SUCCESS;
      }
      messages.push(data);
      try {
        if (handlerFn) {
          return handlerFn(data);
        }
      } catch (e) {
        return DaprPubSubStatusEnum.RETRY;
      }
      return DaprPubSubStatusEnum.SUCCESS;
    });

    app = testingModule.createNestApplication();
    await app.init();
    await app.listen(0);
    // Drain any messages left over from a previous run (only a real, long-lived sidecar has them)
    if (!isEmulator) await sleep(500, 2);
  });

  beforeEach(() => {
    handlerFn = undefined;
    messages = [];
    expect(messages.length).toEqual(0);
  });

  describe('PubSub', () => {
    it('should publish an event', async () => {
      const message = { type: 'event', id: randomUUID(), time: new Date().toISOString(), run: runId };
      await pubsubClient.publish('pubsub', 'test-1', 'events', message);
      expect(await waitForArrayLengthToBe(messages, 1, 10000)).toBe(true);
      expect(messages.length).toEqual(1);
    });

    it('should publish an event, and it should fail to process 3 times', async () => {
      handlerFn = async (data: any) => {
        const firstMessageAttempts = messages.filter((m) => m.id === 1).length;
        if (data.id === 1 && firstMessageAttempts < 3) {
          return DaprPubSubStatusEnum.RETRY;
        }
        return DaprPubSubStatusEnum.SUCCESS;
      };
      const firstMessage = {
        type: 'event',
        id: 1,
        time: new Date().toISOString(),
        run: runId,
      };
      await pubsubClient.publish('pubsub', 'test-2', 'events', firstMessage);

      // The first message is retried twice, then succeeds on the 3rd delivery
      expect(await waitForArrayLengthToBe(messages, 3, 10000)).toBe(true);

      const secondMessage = {
        type: 'event',
        id: 2,
        time: new Date().toISOString(),
        run: runId,
      };
      await pubsubClient.publish('pubsub', 'test-2', 'events', secondMessage);
      expect(await waitForArrayLengthToBe(messages, 4, 10000)).toBe(true);
      expect(messages.filter((m) => m.id === 1).length).toEqual(3);
      expect(messages.filter((m) => m.id === 2).length).toEqual(1);
    });

    it('should publish an event, and it should fail to process', async () => {
      handlerFn = async (data: any) => {
        return DaprPubSubStatusEnum.RETRY;
      };
      const firstMessage = {
        type: 'event',
        id: 3,
        time: new Date().toISOString(),
        run: runId,
      };
      await pubsubClient.publish('pubsub', 'test-3', 'events', firstMessage);
      // pubsubRetry in tests/components/resiliency.yaml allows 3 retries: 1 delivery + 3 retries
      expect(await waitForArrayLengthToBe(messages, 4, 10000)).toBe(true);
      // All the received messages should be the same original message
      expect(messages.every((m) => m.id === firstMessage.id)).toBeTruthy();
      // Wait a few retry intervals longer to ensure the message is not redelivered beyond the retry policy
      await sleep(settleMs);
      expect(messages.length).toEqual(4);
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
