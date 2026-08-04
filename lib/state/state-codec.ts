import { Type } from '@nestjs/common';
import { compressValue, maybeDecompressValue } from '../compression';

/**
 * Options describing how a single state value should be converted to/from
 * its wire representation. Deliberately transport-agnostic: nothing here
 * knows about ActorStateManager, DaprClient, or any specific store — these
 * functions only ever transform a value, never fetch or persist one.
 */
export interface StateCodecOptions {
  type: Function | Type<any> | undefined;
  defaultValue?: any | (() => any);
  /**
   * Whether the value should be treated as an IState (has toJSON/fromJSON).
   * When omitted, this is auto-detected — from `type` on the read side
   * (`isSerializableType`), from the value itself on the write side (does it
   * have a `toJSON` function). An explicit true/false always overrides the
   * auto-detection.
   */
  serializable?: boolean;
  /** Write-side only: whether to gzip-envelope the value before it's stored. */
  compressed?: boolean;
  serializeFn?: (value: any) => any;
  deserializeFn?: (value: any) => any;
}

/**
 * True if `type` looks like an IState: its prototype has both `fromJSON` and
 * `toJSON`. Used as the default for `serializable` when hydrating and not
 * explicitly overridden by `StateCodecOptions.serializable`.
 */
export function isSerializableType(type: Function | Type<any> | undefined): boolean {
  if (!type || !type.prototype) return false;
  return typeof type.prototype['fromJSON'] === 'function' && typeof type.prototype['toJSON'] === 'function';
}

/**
 * Converts a raw value read from a state store back into its typed form.
 *
 * Pipeline (innermost -> outermost transform applied while reading):
 * decompress (always attempted, safe no-op if not an envelope) -> deserializeFn -> fromJSON/instantiate.
 *
 * If `rawValue` is `undefined` (nothing stored), falls back to `options.defaultValue`
 * (calling it if it's a function) or, failing that, a fresh instance of `options.type`.
 */
export async function hydrateStateValue<T>(rawValue: unknown, options: StateCodecOptions): Promise<T> {
  // Unconditionally attempt to unwrap a compression envelope. This is a
  // structural check (isCompressedEnvelope), not gated by `options.compressed`,
  // so callers never need to pre-decompress before calling this and turning
  // compression on/off never breaks reads of previously-written data.
  let value = await maybeDecompressValue(rawValue);

  if (value === undefined) {
    if (typeof options.defaultValue === 'function') {
      return options.defaultValue();
    }
    if (options.defaultValue !== undefined) {
      return options.defaultValue;
    }
    return createInstanceOfType(options.type);
  }

  if (options.deserializeFn) {
    value = options.deserializeFn(value);
  }
  const instance = createInstanceFromRawValue(options, value);
  return instance !== undefined ? instance : (value as T);
}

/**
 * Converts a typed value into its wire representation, ready to be persisted.
 *
 * Pipeline (innermost -> outermost, mirrors hydrateStateValue in reverse):
 * toJSON -> serializeFn -> compress. Compression is always the last step, so
 * the envelope sits directly next to the actual store write.
 */
export async function dehydrateStateValue(value: unknown, options: StateCodecOptions): Promise<unknown> {
  if (value !== undefined) {
    const hasToJSON = typeof (value as any)?.toJSON === 'function';
    const serializable = options.serializable ?? hasToJSON;
    if (serializable && hasToJSON) {
      value = (value as any).toJSON();
    }
  }
  if (value !== undefined && options.serializeFn) {
    value = options.serializeFn(value);
  }
  if (value !== undefined && options.compressed) {
    value = await compressValue(value);
  }
  return value;
}

function createInstanceFromRawValue(options: StateCodecOptions, rawValue?: any) {
  // This function is a little complex, but we're trying to be as nice to the
  // end user as possible: honor an explicit `serializable`, otherwise infer
  // it from whether `type` looks like an IState.
  try {
    const serializable = options.serializable ?? isSerializableType(options.type);
    if (serializable) {
      let instance: any;
      if (typeof options.defaultValue === 'function') {
        instance = options.defaultValue();
      } else {
        instance = createInstanceOfType(options.type);
      }
      if (instance?.fromJSON) {
        return instance.fromJSON(rawValue) ?? instance;
      } else if (instance !== undefined) {
        // For each of the raw value's properties, set the instance property of the same name
        for (const key of Object.keys(rawValue)) {
          instance[key] = rawValue[key];
        }
        return instance;
      }
    } else {
      // We don't know if the type is serializable, so lets just try to new up an instance
      // This is the safest default the user is likely to want.
      let instance: any;
      if (typeof options.defaultValue === 'function') {
        instance = options.defaultValue();
      } else if (options.type) {
        instance = createInstanceOfType(options.type);
      }
      if (instance !== undefined) {
        for (const key of Object.keys(rawValue)) {
          instance[key] = rawValue[key];
        }
        return instance;
      }
    }
  } catch (e) {
    return undefined;
  }
}

function createInstanceOfType<T>(type: Function | Type<any> | undefined): T {
  try {
    return new (type as new () => T)();
  } catch (e) {
    // If we get an error, then it is likely that the type does not have a default constructor
    // Or cannot be instantiated up using the `new` keyword, so lets just return undefined
    return undefined as T;
  }
}
