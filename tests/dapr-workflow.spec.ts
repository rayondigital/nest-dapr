import { Test, TestingModule } from '@nestjs/testing';
import { TestModule } from './e2e/test.module';
import { DaprClient, DaprServer } from '@dapr/dapr';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { sleep } from './test.utils';
import { DaprWorkflowClient } from '../lib/workflow/dapr-workflow-client.service';
import { HelloWorkflow } from './src/hello-workflow';
import { workflowOutput } from '../lib/workflow/workflow';

// To run inside Dapr use:
// dapr run --app-id nest-dapr --app-protocol http --app-port 3001 --dapr-http-port 3500 --dapr-grpc-port 3501 --log-level debug --resources-path ./tests/components
// npm run test -- workflow
describe('DaprWorkflow', () => {
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let workflowClient: DaprWorkflowClient;

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = testingModule.createNestApplication();
    await app.init();
    await app.listen(3000);
    daprServer = app.get<DaprServer>(DaprServer);
    daprClient = testingModule.get(DaprClient);
    workflowClient = testingModule.get(DaprWorkflowClient);
    expect(daprClient).toBeDefined();
  });

  describe('WorkflowClient', () => {
    it('should execute simple workflow', async () => {
      // Schedule a new orchestration
      const uuid = randomUUID();
      const id = await workflowClient.scheduleNewWorkflow(HelloWorkflow, 'Hello', uuid);
      console.log(`Orchestration scheduled with ID: ${id}`);
      expect(id).toEqual(uuid);
      const createdAt = new Date();

      await sleep(250);

      await workflowClient.raiseEvent(id, 'next', { input: 'next' });

      // Wait for orchestration completion
      const state = await workflowClient.waitForWorkflowCompletion(id, undefined, 5);
      const diff = state.lastUpdatedAt.getTime() - createdAt.getTime();
      const ms = Math.abs(diff);

      const value = workflowOutput(HelloWorkflow, state);
      console.log(`Orchestration completed! Result: ${value}, Time ${ms}`);
    });
  });

  afterAll(async () => {
    await daprClient?.stop();
    await workflowClient?.stop();
    await app.close();
    await app.getHttpServer().close();
    await daprServer.stop();
  });
});
