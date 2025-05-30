import { Test, TestingModule } from '@nestjs/testing';
import { TestModule } from './e2e/test.module';
import { DaprClient, DaprServer } from '@dapr/dapr';
import { INestApplication } from '@nestjs/common';
import { DaprActorClient } from '../lib/actors/dapr-actor-client.service';
import { CacheService } from './src/cache.service';
import { StatefulReminderActorInterface } from './src/stateful-reminder.actor';
import { sleep } from './test.utils';

// To run inside Dapr use:
// dapr run --app-id nest-dapr --dapr-http-port 3500 --app-port 3001 --log-level debug -- npm run test -- reminder
describe('DaprActorReminder', () => {
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let daprActorClient: DaprActorClient;
  let cacheService: CacheService;

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = testingModule.createNestApplication();
    await app.init();
    await app.listen(3000);
    daprServer = app.get<DaprServer>(DaprServer);
    daprClient = testingModule.get(DaprClient);
    cacheService = testingModule.get(CacheService);
    daprActorClient = testingModule.get(DaprActorClient);

    expect(daprClient).toBeDefined();
    expect(cacheService).toBeDefined();
    expect(daprActorClient).toBeDefined();
  });

  describe('waitForReminder', () => {
    it('should schedule and wait for reminder', async () => {
      const actor = daprActorClient.getActor(StatefulReminderActorInterface, 'reminder-1');
      await actor.reset();

      const initialValue = await actor.getCounter();
      expect(initialValue).toBeDefined();
      expect(initialValue).toEqual(0);

      await actor.schedule();

      // Wait 10 seconds for the reminder to trigger 3 times
      await sleep(1000, 10);

      const value = await actor.getCounter();
      expect(value).toBeDefined();
      expect(value).toBeGreaterThanOrEqual(3);
    });
  });

  afterAll(async () => {
    await daprClient?.stop();
    await app.close();
    await app.getHttpServer().close();
    await daprServer.stop();
  });
});
