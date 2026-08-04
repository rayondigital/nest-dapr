import { compressValue, decompressValue, isCompressedEnvelope } from '../lib';
import {
  dehydrateStateValue,
  hydrateStateValue,
  isSerializableType,
  StateCodecOptions,
} from '../lib/state/state-codec';

// Unit tests for the transport-agnostic state codec (hydrate/dehydrate).
//
// These mirror the pipeline-ordering, compression, default-value, and
// serialize/deserialize-hook cases in tests/stateful-actor-compression.spec.ts,
// but call the codec functions directly with no actor/state-manager scaffolding
// at all — pure input/output assertions.

interface IState {
  fromJSON(json: any): this;
  toJSON(): any;
}

class Counter implements IState {
  count = 0;
  label = '';

  toJSON(): any {
    return { count: this.count, label: this.label };
  }

  fromJSON(json: any): this {
    this.count = json.count;
    this.label = json.label;
    return this;
  }
}

class NotSerializable {
  count = 0;
}

function counterOptions(overrides: Partial<StateCodecOptions> = {}): StateCodecOptions {
  return { type: Counter, ...overrides };
}

describe('state-codec', () => {
  describe('isSerializableType', () => {
    it('is true for a type with both fromJSON and toJSON', () => {
      expect(isSerializableType(Counter)).toBe(true);
    });

    it('is false for a type without fromJSON/toJSON', () => {
      expect(isSerializableType(NotSerializable)).toBe(false);
    });

    it('is false for undefined', () => {
      expect(isSerializableType(undefined)).toBe(false);
    });
  });

  describe('dehydrateStateValue (write path)', () => {
    it('compresses when compressed=true', async () => {
      const c = new Counter();
      c.count = 5;
      c.label = 'x';

      const stored = await dehydrateStateValue(c, counterOptions({ compressed: true }));

      expect(isCompressedEnvelope(stored)).toBe(true);
      expect(await decompressValue(stored as any)).toEqual({ count: 5, label: 'x' });
    });

    it('stores the plain serialized value when compressed=false', async () => {
      const c = new Counter();
      c.count = 3;

      const stored = await dehydrateStateValue(c, counterOptions({ compressed: false }));

      expect(isCompressedEnvelope(stored)).toBe(false);
      expect(stored).toEqual({ count: 3, label: '' });
    });

    it('does not compress an undefined value', async () => {
      const stored = await dehydrateStateValue(undefined, counterOptions({ compressed: true }));
      expect(stored).toBeUndefined();
    });

    it('auto-detects serializability from the value when `serializable` is omitted', async () => {
      const c = new Counter();
      c.count = 1;
      c.label = 'auto';

      // No `serializable` set at all — should still call toJSON because the
      // value itself has one.
      const stored = await dehydrateStateValue(c, { type: undefined });

      expect(stored).toEqual({ count: 1, label: 'auto' });
    });

    it('respects an explicit serializable=false override even when the value has toJSON', async () => {
      const c = new Counter();
      c.count = 9;

      const stored = await dehydrateStateValue(c, counterOptions({ serializable: false }));

      // toJSON is skipped; the raw instance is passed straight through to serializeFn/compress/store
      expect(stored).toBe(c);
    });

    it('applies the full pipeline in order: toJSON -> serializeFn -> compress', async () => {
      const serializeFn = jest.fn((v: any) => ({ wrapped: v }));
      const c = new Counter();
      c.count = 1;
      c.label = 'a';

      const stored = await dehydrateStateValue(c, counterOptions({ compressed: true, serializeFn }));

      expect(serializeFn).toHaveBeenCalledWith({ count: 1, label: 'a' });
      expect(isCompressedEnvelope(stored)).toBe(true);
      expect(await decompressValue(stored as any)).toEqual({ wrapped: { count: 1, label: 'a' } });
    });

    it('supports a non-serializable plain object with serialize + compression', async () => {
      const serializeFn = jest.fn((v: any) => ({ ...v, _ser: true }));

      const stored = await dehydrateStateValue(
        { a: 1, b: 2 },
        { type: Object, serializable: false, compressed: true, serializeFn },
      );

      expect(isCompressedEnvelope(stored)).toBe(true);
      expect(await decompressValue(stored as any)).toEqual({ a: 1, b: 2, _ser: true });
    });
  });

  describe('hydrateStateValue (read path)', () => {
    it('round-trips a compressed serializable value back into its type', async () => {
      const envelope = await compressValue({ count: 9, label: 'z' });

      const value = await hydrateStateValue<Counter>(envelope, counterOptions({ compressed: true }));

      expect(value).toBeInstanceOf(Counter);
      expect(value.count).toBe(9);
      expect(value.label).toBe('z');
    });

    it('decompresses an existing envelope even when compressed=false (turn-off case)', async () => {
      const envelope = await compressValue({ count: 11, label: 'legacy' });

      const value = await hydrateStateValue<Counter>(envelope, counterOptions({ compressed: false }));

      expect(value).toBeInstanceOf(Counter);
      expect(value.count).toBe(11);
    });

    it('reads legacy uncompressed data when compressed=true (turn-on case)', async () => {
      const value = await hydrateStateValue<Counter>({ count: 7, label: 'plain' }, counterOptions({ compressed: true }));

      expect(value).toBeInstanceOf(Counter);
      expect(value.count).toBe(7);
    });

    it('auto-detects serializability from `type` when `serializable` is omitted', async () => {
      const value = await hydrateStateValue<Counter>({ count: 2, label: 'auto' }, { type: Counter });

      expect(value).toBeInstanceOf(Counter);
      expect(value.count).toBe(2);
    });

    it('falls back to the raw value when the type is not instantiable and not serializable', async () => {
      const value = await hydrateStateValue<string>('secret-value', { type: undefined, serializable: false });
      expect(value).toBe('secret-value');
    });

    it('applies the full pipeline in order: decompress -> deserializeFn -> fromJSON', async () => {
      const deserializeFn = jest.fn((v: any) => v.wrapped);
      const envelope = await compressValue({ wrapped: { count: 4, label: 'b' } });

      const value = await hydrateStateValue<Counter>(
        envelope,
        counterOptions({ compressed: true, deserializeFn }),
      );

      expect(deserializeFn).toHaveBeenCalledWith({ wrapped: { count: 4, label: 'b' } });
      expect(value).toBeInstanceOf(Counter);
      expect(value.count).toBe(4);
      expect(value.label).toBe('b');
    });

    it('standalone deserializeFn (non-serializable) without compression', async () => {
      const deserializeFn = jest.fn((v: any) => {
        const { _ser, ...rest } = v;
        return rest;
      });

      const value = await hydrateStateValue<any>(
        { a: 1, b: 2, _ser: true },
        { type: Object, serializable: false, deserializeFn },
      );

      expect(deserializeFn).toHaveBeenCalledWith({ a: 1, b: 2, _ser: true });
      expect(value).toEqual({ a: 1, b: 2 });
    });
  });

  describe('hydrateStateValue defaults (state absent)', () => {
    it('uses a static defaultValue', async () => {
      const value = await hydrateStateValue<number>(undefined, { type: Number, defaultValue: 42 });
      expect(value).toBe(42);
    });

    it('invokes a function defaultValue', async () => {
      const factory = jest.fn(() => ({ created: true }));
      const value = await hydrateStateValue<any>(undefined, { type: Object, defaultValue: factory });
      expect(factory).toHaveBeenCalled();
      expect(value).toEqual({ created: true });
    });

    it('news up an instance of the type when there is no default', async () => {
      const value = await hydrateStateValue<Counter>(undefined, { type: Counter });
      expect(value).toBeInstanceOf(Counter);
      expect(value.count).toBe(0);
    });

    it('returns undefined when there is no default and the type cannot be instantiated', async () => {
      const value = await hydrateStateValue<any>(undefined, { type: undefined });
      expect(value).toBeUndefined();
    });
  });

  describe('round-trip symmetry', () => {
    it('dehydrate -> hydrate returns an equivalent instance, compressed', async () => {
      const original = new Counter();
      original.count = 6;
      original.label = 'round-trip';

      const options = counterOptions({ compressed: true });
      const stored = await dehydrateStateValue(original, options);
      const restored = await hydrateStateValue<Counter>(stored, options);

      expect(restored).toBeInstanceOf(Counter);
      expect(restored.count).toBe(original.count);
      expect(restored.label).toBe(original.label);
    });

    it('dehydrate -> hydrate returns an equivalent plain object, uncompressed', async () => {
      const original = { name: 'jeremy', roles: ['admin', 'user'] };
      const options: StateCodecOptions = { type: Object, serializable: false };

      const stored = await dehydrateStateValue(original, options);
      const restored = await hydrateStateValue<any>(stored, options);

      expect(restored).toEqual(original);
    });
  });
});
