import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { DaprModule } from '../../lib';

/**
 * Reproduces the README's minimal `DaprModule.register()` usage verbatim
 * (no options object at all). This is the exact shape that previously crashed with
 * "TypeError: undefined is not an object (evaluating 'options.clientOptions')"
 * because `DaprModule.register()` is invoked as soon as this module is loaded.
 */
@Module({
  imports: [ClsModule.forRoot({ global: true }), DaprModule.register()],
})
export class TestSyncModule {}
