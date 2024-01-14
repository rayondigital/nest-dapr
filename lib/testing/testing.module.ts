import { Module } from '@nestjs/common';
import { NoOpDaprClient } from './no-op-dapr-client';
import { TestActorManager } from './test-actor-manager';

@Module({
  providers: [TestActorManager, NoOpDaprClient],
  exports: [TestActorManager],
})
export class DaprTestingModule {}
