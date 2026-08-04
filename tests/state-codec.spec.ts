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

  describe('hydrateStateValue with primitive/Date types (regression: no silent boxing/corruption)', () => {
    it('returns the real primitive for Number, not a boxed Number wrapper', async () => {
      const value = await hydrateStateValue<number>(42, { type: Number });
      expect(value).toBe(42);
      expect(typeof value).toBe('number');
    });

    it('returns the real primitive for String, not a boxed String wrapper', async () => {
      const value = await hydrateStateValue<string>('hello', { type: String });
      expect(value).toBe('hello');
      expect(typeof value).toBe('string');
    });

    it('returns the real primitive for Boolean, not a boxed Boolean wrapper', async () => {
      const value = await hydrateStateValue<boolean>(true, { type: Boolean });
      expect(value).toBe(true);
      expect(typeof value).toBe('boolean');
    });

    it('reconstructs the exact Date, not today\'s date with garbage properties', async () => {
      const iso = '2024-01-01T00:00:00.000Z';
      const value = await hydrateStateValue<Date>(iso, { type: Date });
      expect(value).toBeInstanceOf(Date);
      expect(value.toISOString()).toBe(iso);
      expect(Object.keys(value)).toHaveLength(0);
    });

    it('still reconstructs arrays correctly (object-shaped, unaffected by the primitive guard)', async () => {
      const value = await hydrateStateValue<string[]>(['a', 'b', 'c'], { type: Array });
      expect(value).toEqual(['a', 'b', 'c']);
    });

    it('falls back to the raw value for a non-object, non-special-cased raw value with a type', async () => {
      // e.g. a plain object `type` used on a raw value that isn't object-shaped
      const value = await hydrateStateValue<any>(42, { type: Object });
      expect(value).toBe(42);
    });

    // `type` is coerced, not just used to avoid boxing — this is what lets a
    // stored value written under an older shape (e.g. a string) come back
    // correctly typed once the declared type changes (e.g. to a number),
    // without any extra migration code. See the "type migration" describe
    // block below for the full scenario this enables.
    it('coerces a raw string into a real number when type is Number', async () => {
      const hydrated = await hydrateStateValue<number>('42', { type: Number });
      expect(typeof hydrated).toBe('number');
      expect(hydrated).toBe(42);
    });

    it('coerces a raw number into a real string when type is String', async () => {
      const hydrated = await hydrateStateValue<string>(42, { type: String });
      expect(typeof hydrated).toBe('string');
      expect(hydrated).toBe('42');
    });

    it('coerces the string forms "true"/"false" correctly, avoiding the Boolean("false") === true trap', async () => {
      // Boolean("false") is `true` in plain JS — any non-empty string is truthy.
      // A naive coercion here would silently invert a stored `false`.
      expect(await hydrateStateValue<boolean>('false', { type: Boolean })).toBe(false);
      expect(await hydrateStateValue<boolean>('true', { type: Boolean })).toBe(true);
      // Actual booleans and other values still coerce sensibly.
      expect(await hydrateStateValue<boolean>(false, { type: Boolean })).toBe(false);
      expect(await hydrateStateValue<boolean>(1, { type: Boolean })).toBe(true);
      expect(await hydrateStateValue<boolean>(0, { type: Boolean })).toBe(false);
    });

    it('a coerced value round-trips through a subsequent save as the new type, not the old one', async () => {
      const hydrated = await hydrateStateValue<number>('42', { type: Number });
      const savedAgain = await dehydrateStateValue(hydrated, { type: undefined });
      expect(typeof savedAgain).toBe('number');
      expect(savedAgain).toBe(42);
    });
  });

  describe('type migration across versions (e.g. v1 stored a string, v2 declares it as a number)', () => {
    it('reads old string-shaped data correctly once the declared type changes to Number', async () => {
      // Simulates data written by an older version of the code, before the
      // @State()/getObject `type` was changed from String to Number.
      const legacyStoredValue = '42';

      const readByNewCode = await hydrateStateValue<number>(legacyStoredValue, { type: Number });
      expect(readByNewCode).toBe(42);
      expect(typeof readByNewCode).toBe('number');

      // The next save re-persists it under the new type — no explicit
      // migration step required, no `deserializeFn` needed for this case.
      const rewritten = await dehydrateStateValue(readByNewCode, { type: undefined });
      expect(rewritten).toBe(42);
      expect(typeof rewritten).toBe('number');
    });

    it('uses deserializeFn for migrations coercion cannot handle (shape changes, not just primitive type changes)', async () => {
      // e.g. v1 stored { amount: number } in cents; v2's class expects
      // { amountInDollars: number }. This is a shape change, not something
      // Number/String/Boolean/Date coercion can bridge — deserializeFn is the
      // supported hook for exactly this.
      class Price {
        amountInDollars = 0;
        fromJSON(json: any): this {
          this.amountInDollars = json.amountInDollars;
          return this;
        }
        toJSON() {
          return { amountInDollars: this.amountInDollars };
        }
      }

      const legacyShape = { amount: 250 }; // v1: cents, different field name
      const deserializeFn = (raw: any) =>
        'amount' in raw ? { amountInDollars: raw.amount / 100 } : raw;

      const migrated = await hydrateStateValue<Price>(legacyShape, { type: Price, deserializeFn });
      expect(migrated).toBeInstanceOf(Price);
      expect(migrated.amountInDollars).toBe(2.5);
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
