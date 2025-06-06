import { Module } from '@nestjs/common';
import { PubsubController } from './pubsub.controller';
import { CommunicationProtocolEnum, DaprPubSubStatusEnum } from '@dapr/dapr';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DaprContextProvider, DaprModule } from '@rayondigital/nest-dapr';
import { CounterController } from './counter.controller';
import { CqrsModule } from '@nestjs/cqrs';
import { CounterModule } from './counter/counter.module';
import { ActorModule } from './actors/actor.module';
import { MediatorModule } from './mediator/mediator.module';
import { ClsModule } from 'nestjs-cls';
import { PubSubReceiverService } from './pubsub.service';

@Module({
  imports: [
    ClsModule.forRoot({
      middleware: {
        mount: true,
        generateId: true,
      },
      global: true,
    }),
    CqrsModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    DaprModule.registerAsync({
      useFactory: (configService: ConfigService) => {
        return {
          onError: () => DaprPubSubStatusEnum.RETRY,
          serverHost: configService.get('DAPR_SERVER_HOST') ?? 'localhost',
          serverPort: configService.get('DAPR_SERVER_PORT') ?? '3001',
          clientOptions: {
            daprHost: configService.get('DAPR_HOST'),
            daprPort: configService.get('DAPR_PORT'),
            communicationProtocol:
              configService.get('DAPR_COMMUNICATION_PROTOCOL') ??
              CommunicationProtocolEnum.HTTP,
            actor: {
              reentrancy: {
                enabled: true,
                maxStackDepth: 32,
              },
              actorIdleTimeout: '1m',
              actorScanInterval: '30s',
            },
            contextProvider: DaprContextProvider.NestCLS,
            catchErrors: true,
          },
          communicationProtocol:
            configService.get('DAPR_COMMUNICATION_PROTOCOL') ??
            CommunicationProtocolEnum.HTTP,
        };
      },
      imports: [ClsModule, ConfigModule],
      inject: [ConfigService],
    }),
    MediatorModule,
    ActorModule,
    CounterModule,
  ],
  providers: [PubSubReceiverService],
  controllers: [PubsubController, CounterController],
})
export class AppModule {}
