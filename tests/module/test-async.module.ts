import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { DaprModule } from '../../lib';
import { DaprModuleOptions, DaprModuleOptionsFactory } from '../../lib/dapr.module';

/**
 * Mirrors the async README example, but trimmed to the bare minimum: a `useFactory`
 * that returns an empty options object (no `clientOptions`, no `imports`). Exercises the
 * same option-defaulting path as `TestSyncModule` via the `registerAsync()` code path instead.
 */
@Module({
  imports: [
    ClsModule.forRoot({ global: true }),
    DaprModule.registerAsync({
      useFactory: (): DaprModuleOptions => ({}),
    }),
  ],
})
export class TestAsyncModule {}

export class TestDaprModuleOptionsFactory implements DaprModuleOptionsFactory {
  createDaprModuleOptions(): DaprModuleOptions {
    return {};
  }
}

/**
 * Same as TestAsyncModule but exercises the `useClass` branch of `registerAsync()`
 * rather than `useFactory`.
 */
@Module({
  imports: [
    ClsModule.forRoot({ global: true }),
    DaprModule.registerAsync({
      useClass: TestDaprModuleOptionsFactory,
    }),
  ],
})
export class TestAsyncUseClassModule {}
