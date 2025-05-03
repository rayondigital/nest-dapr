import { Test, TestingModule } from '@nestjs/testing';
import { TestModule } from './e2e/test.module';
import { DaprClient, DaprServer, DaprWorkflowClient } from '@dapr/dapr';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { sleep } from './test.utils';

// To run inside Dapr use:
// dapr run --app-id nest-dapr --app-protocol http --app-port 3001 --dapr-http-port 3500 --dapr-grpc-port 3501 --log-level debug --resources-path ./tests/components
// npm run test -- workflow
describe('DaprWorkflow', () => {
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = testingModule.createNestApplication();
    await app.init();
    await app.listen(3000);
    daprServer = app.get<DaprServer>(DaprServer);
    daprClient = testingModule.get(DaprClient);
    expect(daprClient).toBeDefined();
  });

  describe('WorkflowClient', () => {
    it('should execute simple workflow', async () => {
      const workflowClient = new DaprWorkflowClient({
        daprHost: 'localhost',
        daprPort: process.env.DAPR_GRPC_PORT ?? '3501',
      });

      // Schedule a new orchestration
      const uuid = randomUUID();
      const id = await workflowClient.scheduleNewWorkflow('HelloWorkflow', null, uuid);
      console.log(`Orchestration scheduled with ID: ${id}`);
      expect(id).toEqual(uuid);
      const createdAt = new Date();

      await sleep(250);

      await workflowClient.raiseEvent(id, 'next', { input: 'next' });

      // Wait for orchestration completion
      const state = await workflowClient.waitForWorkflowCompletion(id, undefined, 5);
      const diff = state.lastUpdatedAt.getTime() - createdAt.getTime();
      const ms = Math.abs(diff);
      console.log(`Orchestration completed! Result: ${state?.serializedOutput}, Time ${ms}`);
    });
  });

  afterAll(async () => {
    await daprClient?.stop();
    await app.close();
    await app.getHttpServer().close();
    await daprServer.stop();
  });
});
