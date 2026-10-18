import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DaprClient, DaprServer } from '@dapr/dapr';
import { DaprStateClient, isCompressedEnvelope } from '../lib';
import { SidecarContext } from '../lib/emulator/sidecar-context';
import { TestModule } from './e2e/test.module';

class Widget {
  id = '';
  count = 0;

  toJSON(): any {
    return { id: this.id, count: this.count };
  }

  fromJSON(json: any): this {
    this.id = json.id;
    this.count = json.count;
    return this;
  }
}

// Emulator mode: DAPR_TEST_MODE=emulator pnpm test -- dapr-state
// Real sidecar: DAPR_TEST_MODE=real pnpm test -- dapr-state
describe('DaprStateClient', () => {
  let sidecar: SidecarContext;
  let testingModule: TestingModule;
  let app: INestApplication;
  let daprServer: DaprServer;
  let daprClient: DaprClient;
  let stateClient: DaprStateClient;

  beforeAll(async () => {
    sidecar = await SidecarContext.start();

    testingModule = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = testingModule.createNestApplication();
    await app.init();
    await app.listen(0);
    daprServer = app.get<DaprServer>(DaprServer);
    daprClient = testingModule.get(DaprClient);
    stateClient = testingModule.get(DaprStateClient);
    expect(daprClient).toBeDefined();
    expect(stateClient).toBeDefined();
  });

  describe('getRawValue / setRawValue', () => {
    it('round-trips a single value', async () => {
      const key = `key-${randomUUID()}`;
      await stateClient.setRawValue(key, { hello: 'world' });

      const value = await stateClient.getRawValue(key);
      expect(value).toEqual({ hello: 'world' });

      await stateClient.delete(key);
    });

    it('returns an empty value for a missing key', async () => {
      const value = await stateClient.getRawValue(`missing-${randomUUID()}`);
      expect(value === '' || value === undefined).toBe(true);
    });
  });

  describe('save / getBulk / delete', () => {
    it('saves and bulk-reads multiple keys', async () => {
      const k1 = `bulk-${randomUUID()}`;
      const k2 = `bulk-${randomUUID()}`;

      await stateClient.save([
        { key: k1, value: { n: 1 } },
        { key: k2, value: { n: 2 } },
      ]);

      const values = await stateClient.getBulk([k1, k2]);
      expect(values).toHaveLength(2);
      const byKey = Object.fromEntries(values.map((v: any) => [v.key, v.data]));
      expect(byKey[k1]).toEqual({ n: 1 });
      expect(byKey[k2]).toEqual({ n: 2 });

      await stateClient.delete(k1);
      await stateClient.delete(k2);

      const afterDelete = await stateClient.getRawValue(k1);
      expect(afterDelete === '' || afterDelete === undefined).toBe(true);
    });
  });

  describe('transaction', () => {
    it('applies upsert and delete operations atomically', async () => {
      const upsertKey = `tx-${randomUUID()}`;
      const deleteKey = `tx-${randomUUID()}`;
      await stateClient.setRawValue(deleteKey, { toBeDeleted: true });

      await stateClient.transaction([
        { operation: 'upsert', request: { key: upsertKey, value: { n: 1 } } },
        { operation: 'delete', request: { key: deleteKey } },
      ]);

      const upserted = await stateClient.getRawValue(upsertKey);
      expect(upserted).toEqual({ n: 1 });

      const deleted = await stateClient.getRawValue(deleteKey);
      expect(deleted === '' || deleted === undefined).toBe(true);

      await stateClient.delete(upsertKey);
    });
  });

  describe('getObject / saveObject', () => {
    it('round-trips a serializable (toJSON/fromJSON) instance with no options', async () => {
      const key = `obj-${randomUUID()}`;
      const widget = new Widget();
      widget.id = 'w-1';
      widget.count = 5;

      await stateClient.saveObject(key, widget);
      const restored = await stateClient.getObject<Widget>(key, Widget);

      expect(restored).toBeInstanceOf(Widget);
      expect(restored.id).toBe('w-1');
      expect(restored.count).toBe(5);

      await stateClient.delete(key);
    });

    it('round-trips a number as a real primitive, not a boxed Number', async () => {
      const key = `obj-num-${randomUUID()}`;
      await stateClient.saveObject(key, 42);
      const restored = await stateClient.getObject<number>(key, Number);
      expect(restored).toBe(42);
      expect(typeof restored).toBe('number');
      await stateClient.delete(key);
    });

    it('round-trips a Date correctly, not as today\'s date', async () => {
      const key = `obj-date-${randomUUID()}`;
      const original = new Date('2024-01-01T00:00:00.000Z');
      await stateClient.saveObject(key, original);
      const restored = await stateClient.getObject<Date>(key, Date);
      expect(restored).toBeInstanceOf(Date);
      expect(restored.getTime()).toBe(original.getTime());
      await stateClient.delete(key);
    });

    it('round-trips a plain (non-serializable) object', async () => {
      const key = `obj-plain-${randomUUID()}`;
      const value = { name: 'jeremy', roles: ['admin', 'user'] };

      await stateClient.saveObject(key, value);
      const restored = await stateClient.getObject<typeof value>(key, Object);

      expect(restored).toEqual(value);

      await stateClient.delete(key);
    });

    it('compresses on save and transparently decompresses on read', async () => {
      const key = `obj-gz-${randomUUID()}`;
      const widget = new Widget();
      widget.id = 'w-2';
      widget.count = 9;

      await stateClient.saveObject(key, widget, { compressed: true });

      // Prove it's actually stored compressed (getRawValue does no hydration).
      const raw = await stateClient.getRawValue(key);
      expect(isCompressedEnvelope(raw)).toBe(true);

      const restored = await stateClient.getObject<Widget>(key, Widget);
      expect(restored).toBeInstanceOf(Widget);
      expect(restored.id).toBe('w-2');
      expect(restored.count).toBe(9);

      await stateClient.delete(key);
    });

    it('falls back to a fresh instance when the key does not exist', async () => {
      const restored = await stateClient.getObject<Widget>(`obj-missing-${randomUUID()}`, Widget);
      expect(restored).toBeInstanceOf(Widget);
      expect(restored.count).toBe(0);
    });
  });

  describe('setDefaultName', () => {
    it('uses the overridden default store name', async () => {
      const key = `default-name-${randomUUID()}`;
      stateClient.setDefaultName('statestore');
      await stateClient.setRawValue(key, 'value-under-default-name');
      const value = await stateClient.getRawValue(key);
      expect(value).toEqual('value-under-default-name');
      await stateClient.delete(key);
    });
  });

  afterAll(async () => {
    await daprClient?.stop();
    await app.close();
    await app.getHttpServer().close();
    await daprServer.stop();
    await sidecar?.stop();
  });
});
