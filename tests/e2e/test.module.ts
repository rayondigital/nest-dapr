import { CommunicationProtocolEnum, LogLevel } from '@dapr/dapr';
import { ClsModule } from 'nestjs-cls';
import { Module } from '@nestjs/common';
import { DaprModule } from '../../lib';
import { DaprModuleOptions } from '../../lib/dapr.module';
import { StatelessCounterActor } from '../src/stateless-counter.actor';
import { CounterActor } from '../src/counter.actor';
import { CacheService } from '../src/cache.service';
import { CounterController } from './counter.controller';
import { ContextAwareActor } from '../src/context-aware.actor';
import { StatelessPubSubActor } from '../src/stateless-pubsub.actor';
import { DaprContextProvider } from '../../lib';
import { DAPR_CORRELATION_ID_KEY, DAPR_TRACE_ID_KEY } from '../../lib/dapr-context-service';
import { CreateEntityActivity, GetEntityActivity, HelloActivity, HelloWorkflow } from '../src/hello-workflow';
import { EntityService } from '../src/entity.service';
import { StatefulReminderActor } from '../src/stateful-reminder.actor';
import { GlobalCounterActor } from '../src/global-counter.actor';
import { parseDaprCommunicationProtocol, getDaprPort } from '../../lib/environment';

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
    // registerAsync with useFactory so env vars are read at compile() time,
    // not at import time — this allows SidecarContext.start() to set them first.
    DaprModule.registerAsync({
      imports: [],
      useFactory: (): DaprModuleOptions => {
        // Determine the communication protocol
        const serverCommunicationProtocol = parseDaprCommunicationProtocol(
          process.env.DAPR_SERVER_COMMUNICATION_PROTOCOL,
        );
        const clientCommunicationProtocol = parseDaprCommunicationProtocol(
          process.env.DAPR_CLIENT_COMMUNICATION_PROTOCOL,
        );
        const clientPort = getDaprPort(clientCommunicationProtocol);

        return {
          serverHost: '127.0.0.1',
          serverPort: process.env.DAPR_SERVER_PORT ?? '3001',
          communicationProtocol: serverCommunicationProtocol,
          clientOptions: {
            daprHost: '127.0.0.1',
            daprPort: clientPort,
            communicationProtocol: clientCommunicationProtocol,
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
            enabled: true,
            allowInternalCalls: false,
          },
          workflowOptions: {
            enabled: process.env.DAPR_WORKFLOW_ENABLED === 'true',
            daprPort: process.env.DAPR_GRPC_PORT ?? '3501',
          },
          logging: {
            enabled: true,
          },
          contextProvider: DaprContextProvider.NestCLS,
        };
      },
    }),
  ],
  controllers: [CounterController],
  providers: [
    EntityService,
    CacheService,
    StatelessCounterActor,
    CounterActor,
    StatefulReminderActor,
    ContextAwareActor,
    GlobalCounterActor,
    StatelessPubSubActor,
    HelloActivity,
    CreateEntityActivity,
    GetEntityActivity,
    HelloWorkflow,
  ],
})
export class TestModule {}
