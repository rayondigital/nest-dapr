import { DaprClient } from '@dapr/dapr';
import { KeyValueType } from '@dapr/dapr/types/KeyValue.type';
import { KeyValuePairType } from '@dapr/dapr/types/KeyValuePair.type';
import { OperationType } from '@dapr/dapr/types/Operation.type';
import { IRequestMetadata } from '@dapr/dapr/types/RequestMetadata.type';
import { StateDeleteOptions } from '@dapr/dapr/types/state/StateDeleteOptions.type';
import { StateGetBulkOptions } from '@dapr/dapr/types/state/StateGetBulkOptions.type';
import { StateGetOptions } from '@dapr/dapr/types/state/StateGetOptions.type';
import { StateSaveOptions } from '@dapr/dapr/types/state/StateSaveOptions.type';
import { StateSaveResponseType } from '@dapr/dapr/types/state/StateSaveResponseType';
import { Injectable, Type } from '@nestjs/common';
import { dehydrateStateValue, hydrateStateValue, StateCodecOptions } from './state-codec';

/**
 * A thin NestJS-friendly wrapper around the Dapr JS SDK's State Management API.
 * @see https://docs.dapr.io/developing-applications/building-blocks/state-management/
 */
@Injectable()
export class DaprStateClient {
  private defaultName = 'statestore';

  constructor(private readonly daprClient: DaprClient) {}

  setDefaultName(name: string) {
    this.defaultName = name;
  }

  /**
   * Retrieves a single, raw state value. No decompression, no hydration —
   * exactly what the SDK/state store returns. For a typed, compression-aware
   * read, see `getObject`.
   */
  async getRawValue(
    key: string,
    options?: Partial<StateGetOptions>,
    storeName?: string,
  ): Promise<KeyValueType | string> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.state.get(storeName, key, options);
  }

  /**
   * Saves a single, raw state value. Sugar over `save()`, which always takes
   * an array even for one key. No compression, no hydration — for a typed,
   * compression-aware write, see `saveObject`.
   */
  async setRawValue(
    key: string,
    value: unknown,
    options?: StateSaveOptions,
    storeName?: string,
  ): Promise<StateSaveResponseType> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.state.save(storeName, [{ key, value }], options);
  }

  /**
   * Retrieves multiple state values in one call.
   */
  async getBulk(keys: string[], options?: StateGetBulkOptions, storeName?: string): Promise<KeyValueType[]> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.state.getBulk(storeName, keys, options);
  }

  /**
   * Saves one or more state values.
   */
  async save(
    stateObjects: KeyValuePairType[],
    options?: StateSaveOptions,
    storeName?: string,
  ): Promise<StateSaveResponseType> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.state.save(storeName, stateObjects, options);
  }

  /**
   * Deletes a single state value.
   */
  async delete(key: string, options?: Partial<StateDeleteOptions>, storeName?: string): Promise<StateSaveResponseType> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.state.delete(storeName, key, options);
  }

  /**
   * Performs a transactional (atomic) multi-key state update.
   */
  async transaction(
    operations: OperationType[],
    metadata?: IRequestMetadata | null,
    storeName?: string,
  ): Promise<void> {
    if (!storeName) storeName = this.defaultName;
    return this.daprClient.state.transaction(storeName, operations, metadata);
  }

  /**
   * Retrieves and hydrates a single typed state value: `getRawValue()` followed
   * by `hydrateStateValue()`. Transparently decompresses (if the stored value
   * is a compression envelope) and instantiates `type` via `fromJSON` when it
   * looks serializable — none of which `getRawValue` does on its own.
   *
   * `serializable` is auto-detected from `type` unless overridden in `options`.
   */
  async getObject<T>(
    key: string,
    type: Type<T> | Function,
    options?: Partial<Omit<StateCodecOptions, 'type'>>,
    storeName?: string,
  ): Promise<T> {
    const rawValue = await this.getRawValue(key, undefined, storeName);
    // The single-key GET endpoint returns '' (not undefined) for a missing
    // key — unlike getBulk, which uses null. hydrateStateValue only treats
    // `undefined` as absent, so normalize here rather than surprise callers
    // with a "hydrated" empty string.
    return hydrateStateValue<T>(rawValue === '' ? undefined : rawValue, { ...options, type });
  }

  /**
   * Dehydrates and saves a single typed state value: `dehydrateStateValue()`
   * followed by `setRawValue()`. Calls `toJSON()` when the value looks
   * serializable and gzip-envelopes it when `options.compressed` is set —
   * none of which `setRawValue` does on its own.
   *
   * Unlike `getObject`, no `type` is needed: serializability is auto-detected
   * from the value itself (`typeof value.toJSON === 'function'`) unless
   * overridden in `options`.
   */
  async saveObject(
    key: string,
    value: unknown,
    options?: Partial<Omit<StateCodecOptions, 'type'>>,
    storeName?: string,
  ): Promise<StateSaveResponseType> {
    const dehydrated = await dehydrateStateValue(value, { ...options, type: undefined });
    return this.setRawValue(key, dehydrated, undefined, storeName);
  }
}
