import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { Mediator } from './mediator.service';
import { ClsModule } from 'nestjs-cls';

@Global()
@Module({
  imports: [CqrsModule, ClsModule],
  providers: [Mediator],
  exports: [Mediator],
})
export class MediatorModule {}
