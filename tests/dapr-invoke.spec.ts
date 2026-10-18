import { Test, TestingModule } from '@nestjs/testing';
import { TestModule } from './e2e/test.module';
import { DaprClient, DaprServer, HttpMethod } from '@dapr/dapr';
import { INestApplication } from '@nestjs/common';
import { SidecarContext } from '../lib/emulator/sidecar-context';

// Verifies @DaprHandler-decorated methods can be reached via Dapr Service Invocation
// (the sidecar's /v1.0/invoke/:appId/method/:path route, forwarded to the app).
//
// Emulator mode: DAPR_TEST_MODE=emulator pnpm test -- invoke
// Real sidecar:  DAPR_TEST_MODE=real pnpm test -- invoke
describe('DaprHandler (Service Invocation)', () => {
  let sidecar: SidecarContext;
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;

  // Matches the `--app-id testing` used to start the real sidecar in package.json's test scripts.
  // Ignored by the in-process emulator, which always forwards to its own single app.
  const appId = 'testing';

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
    expect(daprClient).toBeDefined();
  });

  it('should invoke a handler and return its result', async () => {
    const response: any = await daprClient.invoker.invoke(appId, 'test-hello', HttpMethod.GET);
    expect(response).toEqual({ hello: 'world' });
  });

  it('should pass the request body through to the handler', async () => {
    const response: any = await daprClient.invoker.invoke(appId, 'test-echo', HttpMethod.POST, {
      hello: 'world',
    });
    expect(response.echoed).toEqual({ hello: 'world' });
  });

  it('should reject invocation of an unregistered method', async () => {
    await expect(daprClient.invoker.invoke(appId, 'test-does-not-exist', HttpMethod.GET)).rejects.toBeDefined();
  });

  afterAll(async () => {
    await daprClient?.stop();
    await app.close();
    await app.getHttpServer().close();
    await daprServer.stop();
    await sidecar?.stop();
  });
});
