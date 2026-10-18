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
  // Primitive wrappers and Date can never be reconstructed by the "new up an
  // instance, then copy the raw value's own keys onto it" strategy below —
  // for a stored number/string/boolean that produces a boxed empty wrapper
  // (e.g. `new Number()` -> 0), and for Date it produces *today's* date with
  // garbage numeric-indexed properties copied from the ISO string. Coerce to
  // the declared type directly instead, so `type` is honored, not just used
  // to avoid boxing — a raw value that doesn't already match (e.g. a stored
  // string "42" requested as Number) comes back correctly typed.
  if (options.type === Number) {
    return Number(rawValue);
  }
  if (options.type === String) {
    return String(rawValue);
  }
  if (options.type === Boolean) {
    // Boolean(rawValue) is unsafe for strings: Boolean("false") is `true` in
    // JS (any non-empty string is truthy). Map the two string forms Dapr's
    // own JSON round-trip could plausibly produce explicitly; anything else
    // (an actual boolean, or something else entirely) falls through to the
    // normal coercion.
    if (rawValue === 'false') return false;
    if (rawValue === 'true') return true;
    return Boolean(rawValue);
  }
  if (options.type === Date) {
    return new Date(rawValue);
  }
  // Anything else that isn't itself object-shaped (a plain object or array)
  // can't be reconstructed by copying keys onto a fresh instance either.
  // Returning undefined here lets the caller (hydrateStateValue) fall back
  // to the raw value as-is, instead of silently producing a wrong instance.
  if (rawValue === null || typeof rawValue !== 'object') {
    return undefined;
  }

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
