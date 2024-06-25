import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { CounterActor } from './counter.actor';
import { GlobalCounterActor } from './global-counter.actor';
import { ClsModule } from 'nestjs-cls';
import { DaprModule } from '@rayondigital/nest-dapr';

export const Actors = [CounterActor, GlobalCounterActor];

@Module({
  imports: [CqrsModule, ClsModule, DaprModule],
  providers: [...Actors],
})
export class ActorModule {}
