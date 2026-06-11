import { IState, StatefulActor } from '../lib';
import { StateProperty } from '../lib/dapr-actor-state.decorator';
import { compressValue, decompressValue, isCompressedEnvelope } from '../lib';

// Unit tests for StatefulActor's compress/serialize state pipeline.
//
// The real actor persists through getStateManager() (a Dapr ActorStateManager).
// We mock that with an in-memory store that mirrors the real semantics:
//   - getState THROWS when a key is missing (see ActorStateManager.getState)
//   - containsState reports presence
// This lets us drive the full read/write pipeline with no Dapr runtime.

class InMemoryStateManager {
  store = new Map<string, any>();

  getState = jest.fn(async (key: string) => {
    if (!this.store.has(key)) {
      throw new Error(`Actor state with name ${key} was not found`);
    }
    return this.store.get(key);
  });

  setState = jest.fn(async (key: string, value: any) => {
    this.store.set(key, value);
  });

  removeState = jest.fn(async (key: string) => {
    if (!this.store.has(key)) {
      throw new Error(`The actor state with name ${key} was not found`);
    }
    this.store.delete(key);
  });

  containsState = jest.fn(async (key: string) => this.store.has(key));

  saveState = jest.fn(async () => {
    // no-op: commit point
  });

  clearCache = jest.fn(async () => {
    // no-op
  });
}

// Build a StatefulActor instance without running the heavy AbstractActor
// constructor (which needs a real DaprClient). TS `private` is compile-time
// only, so we can wire the internals directly at runtime.
function createActor(properties: StateProperty[]) {
  const actor: any = Object.create(StatefulActor.prototype);
  const sm = new InMemoryStateManager();
  actor.stateManager = sm; // getStateManager() returns this.stateManager
  actor.logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
  actor.statePropertiesInternal = properties;
  return { actor, sm };
}

// A serializable @State-style value object (has toJSON/fromJSON, see IState).
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

function counterProp(overrides: Partial<StateProperty> = {}): StateProperty {
  return {
    key: 'counter',
    name: 'counter',
    type: Counter,
    serializable: true,
    compressed: false,
    ...overrides,
  };
}

describe('StatefulActor compression pipeline', () => {
  describe('write path', () => {
    it('stores a compression envelope when compressed=true', async () => {
      const { actor, sm } = createActor([counterProp({ compressed: true })]);
      const c = new Counter();
      c.count = 5;
      c.label = 'x';
      actor.counter = c;

      await actor.saveState();

      const stored = sm.store.get('counter');
      expect(isCompressedEnvelope(stored)).toBe(true);
      // The envelope wraps the toJSON() output
      expect(await decompressValue(stored)).toEqual({ count: 5, label: 'x' });
      // saveState commits via the state manager
      expect(sm.saveState).toHaveBeenCalledTimes(1);
    });

    it('stores the plain serialized value when compressed=false', async () => {
      const { actor, sm } = createActor([counterProp({ compressed: false })]);
      const c = new Counter();
      c.count = 3;
      actor.counter = c;

      await actor.saveState();

      const stored = sm.store.get('counter');
      expect(isCompressedEnvelope(stored)).toBe(false);
      expect(stored).toEqual({ count: 3, label: '' });
    });

    it('does not compress an undefined value', async () => {
      const { actor, sm } = createActor([counterProp({ compressed: true })]);
      actor.counter = undefined;

      await actor.saveState();

      expect(sm.setState).toHaveBeenCalledWith('counter', undefined);
      expect(isCompressedEnvelope(sm.store.get('counter'))).toBe(false);
    });

    it('commits state (setState) before saving (saveState)', async () => {
      const { actor, sm } = createActor([counterProp({ compressed: true })]);
      actor.counter = new Counter();

      await actor.saveState();

      const setOrder = sm.setState.mock.invocationCallOrder[0];
      const saveOrder = sm.saveState.mock.invocationCallOrder[0];
      expect(setOrder).toBeLessThan(saveOrder);
    });
  });

  describe('compression disabled (compressed=false)', () => {
    it('stores the value as-is and round-trips it without ever using an envelope', async () => {
      const props = [counterProp({ compressed: false })];

      const writer = createActor(props);
      const c = new Counter();
      c.count = 6;
      c.label = 'no-gz';
      writer.actor.counter = c;
      await writer.actor.saveState();

      // Nothing compressed: the raw serialized value is stored
      const stored = writer.sm.store.get('counter');
      expect(isCompressedEnvelope(stored)).toBe(false);
      expect(stored).toEqual({ count: 6, label: 'no-gz' });

      // Reads back cleanly
      const reader = createActor(props);
      reader.sm.store = writer.sm.store;
      await reader.actor.getAllState();
      expect(reader.actor.counter).toBeInstanceOf(Counter);
      expect(reader.actor.counter.count).toBe(6);
      expect(reader.actor.counter.label).toBe('no-gz');
    });
  });

  describe('read path', () => {
    it('round-trips a compressed serializable value back into its type', async () => {
      const props = [counterProp({ compressed: true })];

      // Write with one actor...
      const writer = createActor(props);
      const c = new Counter();
      c.count = 9;
      c.label = 'z';
      writer.actor.counter = c;
      await writer.actor.saveState();

      // ...read with a fresh actor sharing the same backing store.
      const reader = createActor(props);
      reader.sm.store = writer.sm.store;
      await reader.actor.getAllState();

      expect(reader.actor.counter).toBeInstanceOf(Counter);
      expect(reader.actor.counter.count).toBe(9);
      expect(reader.actor.counter.label).toBe('z');
    });

    it('TURN-OFF: still decompresses an existing envelope when compressed=false', async () => {
      // Data was written while compression was enabled; flag is now off.
      const { actor, sm } = createActor([counterProp({ compressed: false })]);
      sm.store.set('counter', await compressValue({ count: 11, label: 'legacy' }));

      await actor.getAllState();

      expect(actor.counter).toBeInstanceOf(Counter);
      expect(actor.counter.count).toBe(11);
      expect(actor.counter.label).toBe('legacy');
    });

    it('round-trips a compressed primitive via the raw fallback', async () => {
      // A non-serializable property with no instantiable type: the read pipeline
      // decompresses, then falls back to assigning the raw value directly.
      const props: StateProperty[] = [
        { key: 'token', name: 'token', type: undefined as any, serializable: false, compressed: true },
      ];
      const { actor, sm } = createActor(props);
      actor.token = 'secret-value';

      await actor.saveState();
      expect(isCompressedEnvelope(sm.store.get('token'))).toBe(true);

      const reader = createActor(props);
      reader.sm.store = sm.store;
      await reader.actor.getAllState();
      expect(reader.actor.token).toBe('secret-value');
    });

    it('TURN-ON: reads legacy uncompressed data when compressed=true', async () => {
      // Data was written before compression existed; flag is now on.
      const { actor, sm } = createActor([counterProp({ compressed: true })]);
      sm.store.set('counter', { count: 7, label: 'plain' });

      await actor.getAllState();

      expect(actor.counter).toBeInstanceOf(Counter);
      expect(actor.counter.count).toBe(7);
      expect(actor.counter.label).toBe('plain');
    });
  });

  // The common case: a value object that uses toJSON/fromJSON and NO custom
  // serialize/deserialize functions. Users typically pick one mechanism or the
  // other, so these test the serializable path entirely on its own.
  describe('toJSON / fromJSON (serializable, no custom transforms)', () => {
    it('uncompressed: toJSON produces the stored value, fromJSON restores it', async () => {
      const toJSONSpy = jest.spyOn(Counter.prototype, 'toJSON');
      const fromJSONSpy = jest.spyOn(Counter.prototype, 'fromJSON');
      try {
        const props = [counterProp({ compressed: false })];

        const writer = createActor(props);
        const c = new Counter();
        c.count = 8;
        c.label = 'plain';
        writer.actor.counter = c;
        await writer.actor.saveState();

        // toJSON produced the stored representation; nothing is compressed
        expect(toJSONSpy).toHaveBeenCalled();
        const stored = writer.sm.store.get('counter');
        expect(isCompressedEnvelope(stored)).toBe(false);
        expect(stored).toEqual({ count: 8, label: 'plain' });

        const reader = createActor(props);
        reader.sm.store = writer.sm.store;
        await reader.actor.getAllState();

        // fromJSON received the exact stored plain value
        expect(fromJSONSpy).toHaveBeenCalledWith({ count: 8, label: 'plain' });
        expect(reader.actor.counter).toBeInstanceOf(Counter);
        expect(reader.actor.counter.count).toBe(8);
        expect(reader.actor.counter.label).toBe('plain');
      } finally {
        toJSONSpy.mockRestore();
        fromJSONSpy.mockRestore();
      }
    });

    it('compressed: the toJSON output is what gets compressed, fromJSON gets the decompressed value', async () => {
      const fromJSONSpy = jest.spyOn(Counter.prototype, 'fromJSON');
      try {
        const props = [counterProp({ compressed: true })];

        const writer = createActor(props);
        const c = new Counter();
        c.count = 2;
        c.label = 'gz';
        writer.actor.counter = c;
        await writer.actor.saveState();

        const stored = writer.sm.store.get('counter');
        expect(isCompressedEnvelope(stored)).toBe(true);
        // With no serializeFn in play, the compressed payload is exactly toJSON()
        expect(await decompressValue(stored)).toEqual({ count: 2, label: 'gz' });

        const reader = createActor(props);
        reader.sm.store = writer.sm.store;
        await reader.actor.getAllState();

        // fromJSON receives the decompressed value, not the envelope
        expect(fromJSONSpy).toHaveBeenCalledWith({ count: 2, label: 'gz' });
        expect(reader.actor.counter).toBeInstanceOf(Counter);
        expect(reader.actor.counter.count).toBe(2);
        expect(reader.actor.counter.label).toBe('gz');
      } finally {
        fromJSONSpy.mockRestore();
      }
    });
  });

  // Plain objects: no toJSON/fromJSON, no serializeFn/deserializeFn. The value
  // is stored and restored as-is (optionally through gzip). This is the simplest
  // possible @State usage and must work without any serialization hooks.
  describe('plain objects (no toJSON/fromJSON, no transforms)', () => {
    const plainProp = (compressed: boolean): StateProperty => ({
      key: 'profile',
      name: 'profile',
      type: Object,
      serializable: false,
      compressed,
    });

    it('uncompressed: stores and restores a plain object verbatim', async () => {
      const props = [plainProp(false)];
      const writer = createActor(props);
      writer.actor.profile = { name: 'jeremy', roles: ['admin', 'user'], meta: { active: true } };
      await writer.actor.saveState();

      const stored = writer.sm.store.get('profile');
      expect(isCompressedEnvelope(stored)).toBe(false);
      expect(stored).toEqual({ name: 'jeremy', roles: ['admin', 'user'], meta: { active: true } });

      const reader = createActor(props);
      reader.sm.store = writer.sm.store;
      await reader.actor.getAllState();
      expect(reader.actor.profile).toEqual({ name: 'jeremy', roles: ['admin', 'user'], meta: { active: true } });
    });

    it('compressed: round-trips a plain object through gzip', async () => {
      const props = [plainProp(true)];
      const writer = createActor(props);
      writer.actor.profile = { name: 'jeremy', roles: ['admin', 'user'], meta: { active: true } };
      await writer.actor.saveState();

      const stored = writer.sm.store.get('profile');
      expect(isCompressedEnvelope(stored)).toBe(true);
      expect(await decompressValue(stored)).toEqual({
        name: 'jeremy',
        roles: ['admin', 'user'],
        meta: { active: true },
      });

      const reader = createActor(props);
      reader.sm.store = writer.sm.store;
      await reader.actor.getAllState();
      expect(reader.actor.profile).toEqual({ name: 'jeremy', roles: ['admin', 'user'], meta: { active: true } });
    });

    it('TURN-OFF still works for plain objects: decompresses an existing envelope when compressed=false', async () => {
      const props = [plainProp(false)];
      const { actor, sm } = createActor(props);
      sm.store.set('profile', await compressValue({ name: 'legacy', roles: [] }));

      await actor.getAllState();
      expect(actor.profile).toEqual({ name: 'legacy', roles: [] });
    });
  });

  // These tests intentionally combine a serializable type (toJSON/fromJSON) WITH
  // custom serialize/deserialize functions. Users rarely use both at once, but
  // pairing them is the clearest way to assert the exact pipeline ordering.
  describe('serialize / deserialize transforms', () => {
    it('applies the full write pipeline in order: toJSON -> serializeFn -> compress', async () => {
      const serializeFn = jest.fn((v: any) => ({ wrapped: v }));
      const props: StateProperty[] = [counterProp({ compressed: true, serializeFn })];
      const { actor, sm } = createActor(props);
      const c = new Counter();
      c.count = 1;
      c.label = 'a';
      actor.counter = c;

      await actor.saveState();

      // serializeFn received the post-toJSON value
      expect(serializeFn).toHaveBeenCalledWith({ count: 1, label: 'a' });
      const stored = sm.store.get('counter');
      expect(isCompressedEnvelope(stored)).toBe(true);
      // The envelope wraps the serializeFn output
      expect(await decompressValue(stored)).toEqual({ wrapped: { count: 1, label: 'a' } });
    });

    it('applies the full read pipeline in order: decompress -> deserializeFn -> fromJSON', async () => {
      const deserializeFn = jest.fn((v: any) => v.wrapped);
      const props: StateProperty[] = [counterProp({ compressed: true, deserializeFn })];
      const { actor, sm } = createActor(props);
      // Stored value is a compressed envelope wrapping the serialized shape.
      sm.store.set('counter', await compressValue({ wrapped: { count: 4, label: 'b' } }));

      await actor.getAllState();

      // deserializeFn received the decompressed value
      expect(deserializeFn).toHaveBeenCalledWith({ wrapped: { count: 4, label: 'b' } });
      expect(actor.counter).toBeInstanceOf(Counter);
      expect(actor.counter.count).toBe(4);
      expect(actor.counter.label).toBe('b');
    });

    it('standalone serializeFn/deserializeFn (non-serializable) WITHOUT compression', async () => {
      // The other common case: custom transforms only, no toJSON/fromJSON, no gzip.
      const serializeFn = jest.fn((v: any) => ({ ...v, _ser: true }));
      const deserializeFn = jest.fn((v: any) => {
        const { _ser, ...rest } = v;
        return rest;
      });
      const props: StateProperty[] = [
        { key: 'data', name: 'data', type: Object, serializable: false, compressed: false, serializeFn, deserializeFn },
      ];
      const { actor, sm } = createActor(props);
      actor.data = { a: 1, b: 2 };

      await actor.saveState();
      const stored = sm.store.get('data');
      // No compression: the serializeFn output is stored verbatim
      expect(isCompressedEnvelope(stored)).toBe(false);
      expect(stored).toEqual({ a: 1, b: 2, _ser: true });

      const reader = createActor(props);
      reader.sm.store = sm.store;
      await reader.actor.getAllState();
      expect(deserializeFn).toHaveBeenCalledWith({ a: 1, b: 2, _ser: true });
      expect(reader.actor.data).toEqual({ a: 1, b: 2 });
    });

    it('supports a non-serializable plain object with serialize/deserialize + compression', async () => {
      const serializeFn = jest.fn((v: any) => ({ ...v, _ser: true }));
      const deserializeFn = jest.fn((v: any) => {
        const { _ser, ...rest } = v;
        return rest;
      });
      const props: StateProperty[] = [
        { key: 'data', name: 'data', type: Object, serializable: false, compressed: true, serializeFn, deserializeFn },
      ];
      const { actor, sm } = createActor(props);
      actor.data = { a: 1, b: 2 };

      await actor.saveState();
      const stored = sm.store.get('data');
      expect(isCompressedEnvelope(stored)).toBe(true);
      expect(await decompressValue(stored)).toEqual({ a: 1, b: 2, _ser: true });

      // Read it back with a fresh actor over the same store
      const reader = createActor(props);
      reader.sm.store = sm.store;
      await reader.actor.getAllState();
      expect(deserializeFn).toHaveBeenCalledWith({ a: 1, b: 2, _ser: true });
      expect(reader.actor.data).toEqual({ a: 1, b: 2 });
    });
  });

  describe('default values when state is absent', () => {
    it('uses a static defaultValue', async () => {
      const { actor } = createActor([
        { key: 'count', name: 'count', type: Number, serializable: false, compressed: false, defaultValue: 42 },
      ]);
      await actor.getAllState();
      expect(actor.count).toBe(42);
    });

    it('invokes a function defaultValue', async () => {
      const factory = jest.fn(() => ({ created: true }));
      const { actor } = createActor([
        { key: 'obj', name: 'obj', type: Object, serializable: false, compressed: false, defaultValue: factory },
      ]);
      await actor.getAllState();
      expect(factory).toHaveBeenCalled();
      expect(actor.obj).toEqual({ created: true });
    });

    it('news up an instance of the type when there is no default', async () => {
      const { actor } = createActor([counterProp({ compressed: true })]);
      await actor.getAllState();
      expect(actor.counter).toBeInstanceOf(Counter);
      expect(actor.counter.count).toBe(0);
    });
  });

  describe('getStateValue', () => {
    it('transparently decompresses an envelope on a direct read', async () => {
      const { actor, sm } = createActor([]);
      sm.store.set('k', await compressValue({ hi: 'there' }));
      const value = await actor.getStateValue('k');
      expect(value).toEqual({ hi: 'there' });
    });

    it('returns the default when the key is missing', async () => {
      const { actor, sm } = createActor([]);
      const value = await actor.getStateValue('missing', 'fallback');
      expect(value).toBe('fallback');
      expect(sm.containsState).toHaveBeenCalledWith('missing');
    });

    it('returns the default when getState resolves undefined', async () => {
      const { actor, sm } = createActor([]);
      sm.getState.mockResolvedValueOnce(undefined);
      const value = await actor.getStateValue('k', 'def');
      expect(value).toBe('def');
    });

    it('rethrows when getState fails but the key exists', async () => {
      const { actor, sm } = createActor([]);
      sm.getState.mockImplementationOnce(async () => {
        throw new Error('boom');
      });
      sm.containsState.mockResolvedValueOnce(true);
      await expect(actor.getStateValue('k')).rejects.toThrow('boom');
    });
  });

  describe('setStateValue / removeStateValue / clearState', () => {
    it('setStateValue writes through to the state manager', async () => {
      const { actor, sm } = createActor([]);
      await actor.setStateValue('a', 123);
      expect(sm.store.get('a')).toBe(123);
    });

    it('removeStateValue deletes from the state manager', async () => {
      const { actor, sm } = createActor([]);
      sm.store.set('a', 1);
      await actor.removeStateValue('a');
      expect(sm.store.has('a')).toBe(false);
    });

    it('clearState removes every declared property', async () => {
      const props: StateProperty[] = [
        { key: 'a', name: 'a', type: Number, serializable: false, compressed: false },
        { key: 'b', name: 'b', type: Number, serializable: false, compressed: false },
      ];
      const { actor, sm } = createActor(props);
      sm.store.set('a', 1);
      sm.store.set('b', 2);

      await actor.clearState();

      expect(sm.store.has('a')).toBe(false);
      expect(sm.store.has('b')).toBe(false);
      expect(sm.removeState).toHaveBeenCalledTimes(2);
    });
  });
});
