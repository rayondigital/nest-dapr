import { randomBytes } from 'crypto';
import { context, propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DaprClient, DaprServer } from '@dapr/dapr';
import { ClsService } from 'nestjs-cls';
import { TestModule } from './e2e/test.module';
import { DaprActorClient } from '../lib/actors/dapr-actor-client.service';
import { DaprContextService } from '../lib';
import { ContextAwareActorInterface } from './src/context-aware.actor';
import { SidecarContext } from '../lib/emulator/sidecar-context';
import { ZipkinTraceCollector } from './zipkin-trace-collector';

// Verifies trace propagation across an actor -> actor -> actor chain and that the
// spans nest correctly (downstream calls are children of the calling actor's span,
// not flattened under the root).
//
// Self-contained: an in-process ZipkinTraceCollector receives the sidecar's spans,
// so no external backend (Zipkin/SigNoz/OTLP collector) is needed — the full trace
// tree is printed to the test output AND asserted. Run under a real sidecar pointed
// at the collector via tests/components/tracing.config.yaml:
//
//   $env:DAPR_TEST_MODE='real'
//   dapr run --app-id testing --app-protocol http --app-port 3001 `
//     --dapr-http-port 3500 --dapr-grpc-port 3501 `
//     --resources-path ./tests/components --config ./tests/components/tracing.config.yaml `
//     -- npx jest --runInBand tracing
describe('DaprTracing', () => {
  const COLLECTOR_PORT = 9499;

  let collector: ZipkinTraceCollector;
  let contextManager: AsyncLocalStorageContextManager;
  let sidecar: SidecarContext;
  let testingModule: TestingModule;
  let app: INestApplication;
  let contextService: ClsService;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let daprActorClient: DaprActorClient;
  let daprContextService: DaprContextService;

  beforeAll(async () => {
    // Register an OTel context manager + W3C propagator (no SDK/exporter, so no span
    // emission or network noise). This lets the lib extract the inbound sidecar
    // traceparent and propagate this hop's span on outgoing calls, so the sidecar
    // nests downstream actor/service calls instead of flattening them under the root.
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    collector = new ZipkinTraceCollector(COLLECTOR_PORT);
    await collector.start();

    sidecar = await SidecarContext.start();

    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = testingModule.createNestApplication();
    await app.init();
    await app.listen(0);
    daprServer = app.get<DaprServer>(DaprServer);
    contextService = app.get<ClsService>(ClsService);
    daprClient = testingModule.get(DaprClient);
    daprActorClient = testingModule.get(DaprActorClient);
    daprContextService = testingModule.get(DaprContextService);
  }, 60000);

  it('propagates one trace id and nests spans across an actor -> actor -> actor chain', async () => {
    // A known, sampled W3C traceparent so we can find the trace in the collector.
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const traceparent = `00-${traceId}-${spanId}-01`;

    const report = await contextService.run(async () => {
      daprContextService.setCorrelationIdIfNotDefined();
      daprContextService.setTraceId(traceparent);
      daprContextService.set({
        correlationID: daprContextService.getCorrelationId(),
        userID: 'user-1',
        tenantID: 'tenant-1',
      });

      const actor = daprActorClient.getActor(ContextAwareActorInterface, 'trace-root-1');
      return await actor.runTraced();
    });

    // Layer 1 — every hop observed the same underlying trace id (in-process).
    expect(extractTraceId(report.self)).toBe(traceId);
    expect(extractTraceId(report.nested)).toBe(traceId);
    expect(extractTraceId(report.counter)).toBe(traceId);

    if (sidecar.ports.mode !== 'real') {
      console.warn('Skipping span-export assertions (emulator mode does not emit spans).');
      return;
    }

    // Layer 2 — the sidecar exported a connected trace to the collector.
    const spans = await collector.waitForSpans(traceId, 3);
    console.log(`\nTrace ${traceId} (${spans.length} spans):\n${collector.renderTree(traceId)}\n`);
    expect(spans.length).toBeGreaterThanOrEqual(3);

    // Layer 3 — the spans nest correctly. The two calls made from inside
    // runTraced() must be children of the runTraced span, not siblings of it.
    const runTraced = collector.findSpanByName(traceId, 'runtraced');
    const nestedPing = collector.findSpanByName(traceId, 'contextawareactor/getobservedtraceid');
    const counterCall = collector.findSpanByName(traceId, 'statelesscounteractor/getobservedtraceid');

    expect(runTraced).toBeDefined();
    expect(nestedPing).toBeDefined();
    expect(counterCall).toBeDefined();

    expect(nestedPing!.parentId).toBe(runTraced!.id);
    expect(counterCall!.parentId).toBe(runTraced!.id);
  }, 40000);

  afterAll(async () => {
    await daprClient?.stop();
    await app?.close();
    await app?.getHttpServer().close();
    await daprServer?.stop();
    await sidecar?.stop();
    await collector?.stop();
    contextManager?.disable();
  });
});

/** Extracts the 32-hex trace id from a W3C traceparent (00-traceId-spanId-flags). */
function extractTraceId(traceparent?: string): string | undefined {
  if (!traceparent) return undefined;
  const parts = traceparent.split('-');
  return parts.length >= 2 ? parts[1] : traceparent;
}
