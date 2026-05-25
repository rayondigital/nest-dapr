import { Test, TestingModule } from '@nestjs/testing';
import { TestModule } from './e2e/test.module';
import { DaprClient, DaprServer } from '@dapr/dapr';
import { INestApplication } from '@nestjs/common';
import { StatelessCounterActorInterface } from './src/stateless-counter.actor';
import { DaprActorClient } from '../lib/actors/dapr-actor-client.service';
import { SerializableError } from '../lib';
import { SidecarContext } from '../lib/emulator/sidecar-context';

// Emulator mode (default): npm run test
// Real sidecar: DAPR_TEST_MODE=real npm run test
describe('DaprActor', () => {
  let sidecar: SidecarContext;
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let daprActorClient: DaprActorClient;

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
    daprActorClient = testingModule.get(DaprActorClient);

    expect(daprClient).toBeDefined();
    expect(daprActorClient).toBeDefined();
  });

  describe('callActor', () => {
    it('should call an actor and return a serializable error', async () => {
      const actor = daprActorClient.getActor(StatelessCounterActorInterface, 'stateless-1');
      let error: SerializableError;
      try {
        await actor.throwSerializableError();
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      expect(error).toBeInstanceOf(SerializableError);
      expect(error.message).toContain('This is a serializable error');
      expect(error.statusCode).toBe(400);
    });

    it('should call an actor and it should throw an error', async () => {
      const actor = daprActorClient.getActor(StatelessCounterActorInterface, 'stateless-1');
      try {
        await actor.throwError();
      } catch (error) {
        expect(error).toBeDefined();
        expect(error.message).toBeDefined();
        expect(error.message).toContain('error from actor service');
      }
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
