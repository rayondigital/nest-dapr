import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { DaprClient, DaprServer } from '@dapr/dapr';
import { DaprModule } from '../lib';
import { DAPR_MODULE_OPTIONS_TOKEN, DaprModuleOptions } from '../lib/dapr.module';
import { TestSyncModule } from './module/test-sync.module';
import { TestAsyncModule, TestAsyncUseClassModule } from './module/test-async.module';

// Regression coverage for a crash reported against the README's minimal usage:
//   imports: [DaprModule.register()]
// which threw "TypeError: undefined is not an object (evaluating 'options.clientOptions')"
// because `options` (and `options.clientOptions`) were assumed to always be provided.
//
// These are pure DI-wiring tests: they only `compile()` a testing module (never `app.init()`),
// so no Dapr sidecar/emulator is required — they just prove that calling `register()` /
// `registerAsync()` and resolving the resulting providers doesn't throw.
describe('DaprModule', () => {
  describe('register', () => {
    it('does not throw when called with no arguments (README minimal example)', () => {
      expect(() => DaprModule.register()).not.toThrow();
    });

    it('does not throw when called with an empty options object', () => {
      expect(() => DaprModule.register({})).not.toThrow();
    });

    it('compiles a Nest module using the README minimal example and resolves providers', async () => {
      const testingModule = await Test.createTestingModule({
        imports: [TestSyncModule],
      }).compile();

      expect(testingModule.get(DaprServer)).toBeInstanceOf(DaprServer);
      expect(testingModule.get(DaprClient)).toBeInstanceOf(DaprClient);
    });

    it('defaults clientOptions.actor (reentrancy) when clientOptions is not provided', async () => {
      const testingModule = await Test.createTestingModule({
        imports: [ClsModule.forRoot({ global: true }), DaprModule.register()],
      }).compile();

      const options = testingModule.get<DaprModuleOptions>(DAPR_MODULE_OPTIONS_TOKEN);
      expect(options.clientOptions).toBeDefined();
      expect(options.clientOptions.actor).toEqual({
        reentrancy: { enabled: true, maxStackDepth: 6 },
        actorIdleTimeout: '15m',
        actorScanInterval: '1m',
      });
      expect(options.workflowOptions).toEqual({ enabled: true });
    });

    it('preserves user-provided clientOptions.actor instead of overriding it', async () => {
      const testingModule = await Test.createTestingModule({
        imports: [
          ClsModule.forRoot({ global: true }),
          DaprModule.register({
            clientOptions: {
              actor: {
                reentrancy: { enabled: false, maxStackDepth: 32 },
              },
            },
          }),
        ],
      }).compile();

      const options = testingModule.get<DaprModuleOptions>(DAPR_MODULE_OPTIONS_TOKEN);
      expect(options.clientOptions.actor).toEqual({
        reentrancy: { enabled: false, maxStackDepth: 32 },
      });
    });
  });

  describe('registerAsync', () => {
    it('does not throw when called with only a useFactory (no imports, no clientOptions)', () => {
      expect(() =>
        DaprModule.registerAsync({
          useFactory: (): DaprModuleOptions => ({}),
        }),
      ).not.toThrow();
    });

    it('compiles a Nest module using a minimal useFactory and resolves providers', async () => {
      const testingModule = await Test.createTestingModule({
        imports: [TestAsyncModule],
      }).compile();

      expect(testingModule.get(DaprServer)).toBeInstanceOf(DaprServer);
      expect(testingModule.get(DaprClient)).toBeInstanceOf(DaprClient);
    });

    it('applies the same clientOptions.actor / workflowOptions defaults as register()', async () => {
      const testingModule = await Test.createTestingModule({
        imports: [TestAsyncModule],
      }).compile();

      const options = testingModule.get<DaprModuleOptions>(DAPR_MODULE_OPTIONS_TOKEN);
      expect(options.clientOptions).toBeDefined();
      expect(options.clientOptions.actor).toEqual({
        reentrancy: { enabled: true, maxStackDepth: 6 },
        actorIdleTimeout: '15m',
        actorScanInterval: '1m',
      });
      expect(options.workflowOptions).toEqual({ enabled: true });
    });

    it('compiles a Nest module using useClass and resolves providers', async () => {
      const testingModule = await Test.createTestingModule({
        imports: [TestAsyncUseClassModule],
      }).compile();

      expect(testingModule.get(DaprServer)).toBeInstanceOf(DaprServer);
      expect(testingModule.get(DaprClient)).toBeInstanceOf(DaprClient);

      const options = testingModule.get<DaprModuleOptions>(DAPR_MODULE_OPTIONS_TOKEN);
      expect(options.clientOptions.actor).toBeDefined();
    });

    it('propagates useFactory-provided clientOptions untouched', async () => {
      const testingModule = await Test.createTestingModule({
        imports: [
          ClsModule.forRoot({ global: true }),
          DaprModule.registerAsync({
            useFactory: (): DaprModuleOptions => ({
              clientOptions: {
                daprHost: '10.0.0.5',
              },
            }),
          }),
        ],
      }).compile();

      const options = testingModule.get<DaprModuleOptions>(DAPR_MODULE_OPTIONS_TOKEN);
      expect(options.clientOptions.daprHost).toBe('10.0.0.5');
      // Defaults still get filled in around the user-provided value.
      expect(options.clientOptions.actor).toBeDefined();
    });
  });
});
