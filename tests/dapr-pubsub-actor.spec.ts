import { Test, TestingModule } from '@nestjs/testing';
import { TestModule } from './e2e/test.module';
import { DaprClient, DaprPubSubStatusEnum, DaprServer } from '@dapr/dapr';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { sleep, waitForArrayLengthToBe, waitUntil } from './test.utils';
import { DaprActorClient, DaprPubSubClient } from '../lib';
import { StatelessPubSubActorInterface } from './src/stateless-pubsub.actor';
import { DaprEventEmitter } from '../lib/dapr-event-emitter.service';
import { SidecarContext } from '../lib/emulator/sidecar-context';

// Emulator mode: DAPR_TEST_MODE=emulator npm run test -- pubsub
// Real sidecar: DAPR_TEST_MODE=real npm run test -- pubsub
describe('DaprPubSubActor', () => {
  let sidecar: SidecarContext;
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let pubsubClient: DaprPubSubClient;
  let daprActorClient: DaprActorClient;
  let daprEventEmitter: DaprEventEmitter;

  const runId = randomUUID();
  let messages = [];

  beforeAll(async () => {
    sidecar = await SidecarContext.start();

    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    daprServer = testingModule.get(DaprServer);
    daprClient = testingModule.get(DaprClient);
    pubsubClient = testingModule.get(DaprPubSubClient);
    daprActorClient = testingModule.get(DaprActorClient);
    daprEventEmitter = testingModule.get(DaprEventEmitter);
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
        const eventName = data.type ?? data.eventName ?? data.event ?? data.topic;
        const results = await daprEventEmitter.emitAsync(eventName, data);
        // If results are undefined, then we should retry (either no subscribers or an error)
        if (results === undefined) {
          return DaprPubSubStatusEnum.RETRY;
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
    if (sidecar.ports.mode !== 'emulator') await sleep(500, 2);
  });

  beforeEach(() => {
    messages = [];
    expect(messages.length).toEqual(0);
  });

  describe('PubSub', () => {
    it('should publish an event', async () => {
      const message = {
        type: 'com.example.event',
        producerId: 'test-1',
        id: randomUUID(),
        time: new Date().toISOString(),
        otherIds: ['test-1', 'test-1'],
        run: runId,
      };
      await pubsubClient.publish('pubsub', 'test-1', 'events', message);
      expect(await waitForArrayLengthToBe(messages, 1, 10000)).toBe(true);
      expect(messages.length).toEqual(1);

      // The actor receives the event 4 times: increment + handleEvent for producerId,
      // and handleEvent for each of the 2 otherIds (all 'test-1')
      const actor = daprActorClient.getActor(StatelessPubSubActorInterface, 'test-1');
      await actor.reset();
      expect(await waitUntil(async () => (await actor.getMessages()).length >= 4, 10000, 50)).toBe(true);
      expect((await actor.getMessages()).length).toEqual(4);
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
