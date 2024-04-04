import { CommunicationProtocolEnum, LogLevel } from '@dapr/dapr';
import { Module } from '@nestjs/common';
import { DaprModule } from '../../lib';
import { StatelessCounterActor } from '../src/stateless-counter.actor';
import { CounterActor } from '../src/counter.actor';
import { CacheService } from '../src/cache.service';
import { CounterController } from './counter.controller';
import { ContextAwareActor } from '../src/context-aware.actor';
import { StatelessPubSubActor } from '../src/stateless-pubsub.actor';
import { ClsModule } from 'nestjs-cls';
import { DaprContextProvider } from '../../lib/dapr.module';
import { registerTracerProvider } from '../trace.setup';
import { DAPR_CORRELATION_ID_KEY, DAPR_TRACE_ID_KEY } from '../../lib/dapr-context-service';

registerTracerProvider('http://localhost:4318/v1/traces');

@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        setup: (cls, req, res) => {
          if (req.headers['X-Correlation-ID']) {
            cls.set(DAPR_CORRELATION_ID_KEY, req.headers['X-Correlation-ID']);
          }
          if (req.headers['traceparent']) {
            cls.set(DAPR_TRACE_ID_KEY, req.headers['traceparent']);
          }
        },
      },
    }),
    DaprModule.register({
      serverHost: '127.0.0.1',
      serverPort: process.env.PORT ?? '3001',
      communicationProtocol: CommunicationProtocolEnum.HTTP,
      clientOptions: {
        daprHost: '127.0.0.1',
        daprPort: process.env.DAPR_PORT ?? '3500',
        communicationProtocol: CommunicationProtocolEnum.HTTP,
        logger: {
          level: LogLevel.Verbose,
        },
        isKeepAlive: true,
        actor: {
          reentrancy: {
            enabled: true,
            maxStackDepth: 32,
          },
          drainRebalancedActors: true,
          actorIdleTimeout: '30s',
          actorScanInterval: '30s',
        },
      },
      actorOptions: {
        allowInternalCalls: true,
      },
      logging: {
        enabled: true,
      },
      contextProvider: DaprContextProvider.NestCLS,
    }),
  ],
  controllers: [CounterController],
  providers: [CacheService, StatelessCounterActor, CounterActor, ContextAwareActor, StatelessPubSubActor],
})
export class TestModule {}
