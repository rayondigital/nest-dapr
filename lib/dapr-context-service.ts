import { randomBytes, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';

export const DAPR_CONTEXT_KEY = 'context';
export const DAPR_CORRELATION_ID_KEY = 'correlationId';
export const DAPR_TRACE_ID_KEY = 'traceId';

@Injectable()
export class DaprContextService {
  constructor(private readonly cls: ClsService) {}

  getService(): ClsService {
    // See https://papooch.github.io/nestjs-cls/features-and-use-cases/breakin-out-of-di
    return this.cls ?? ClsServiceManager.getClsService();
  }

  getId() {
    try {
      return this.getService().getId();
    } catch (error) {
      // We don't want to throw an error if the context is not set.
      return undefined;
    }
  }

  setIdIfNotDefined(id?: string) {
    this.setByKeyIfNotDefined(CLS_ID, id ?? randomUUID().toString());
  }

  getCorrelationId(createIfNotDefined = false) {
    const byKey = this.getByKey<string>(DAPR_CORRELATION_ID_KEY);
    if (byKey) return byKey;
    const context = this.get<any>();
    if (context && context[DAPR_CORRELATION_ID_KEY]) {
      return context[DAPR_CORRELATION_ID_KEY];
    }
    if (createIfNotDefined) return this.setCorrelationIdIfNotDefined();
    return undefined;
  }

  getTraceId(createIfNotDefined = false) {
    const byKey = this.getByKey<string>(DAPR_TRACE_ID_KEY);
    if (byKey) return byKey;
    const context = this.get<any>();
    if (context && context[DAPR_TRACE_ID_KEY]) {
      return context[DAPR_TRACE_ID_KEY];
    }
    if (createIfNotDefined) return this.setTraceIdIfNotDefined();
    return undefined;
  }

  setCorrelationId(value?: string) {
    this.setByKey(DAPR_CORRELATION_ID_KEY, value ?? randomUUID().toString());
  }

  setCorrelationIdIfNotDefined(value?: string): string {
    if (!value) value = randomUUID().toString();
    this.setByKeyIfNotDefined(DAPR_CORRELATION_ID_KEY, value);
    return value;
  }

  setTraceId(value: string) {
    this.setByKey(DAPR_TRACE_ID_KEY, value ?? randomUUID().toString());
  }

  setTraceIdIfNotDefined(value?: string): string {
    if (!value) value = this.randomTraceId();
    this.setByKeyIfNotDefined(DAPR_TRACE_ID_KEY, value);
    return value;
  }

  setByKey<T>(key: string | symbol, value: T) {
    this.getService().set(key, value);
  }

  setByKeyIfNotDefined<T>(key: string | symbol, value: T) {
    try {
      this.getService().setIfUndefined(key, value);
    } catch (error) {
      // We don't want to throw an error if the context key is not set.
      return undefined;
    }
  }

  set<T>(value: T) {
    this.setByKey(DAPR_CONTEXT_KEY, value);
  }

  getByKey<T>(key: string): T | undefined {
    try {
      return (this.getService().get<T>(key) as T) ?? undefined;
    } catch (error) {
      // We don't want to throw an error if the context key is not set.
      return undefined;
    }
  }

  get<T>(): T | undefined {
    try {
      const contextObject: any = this.getByKey<T>(DAPR_CONTEXT_KEY);
      // Add the correlation ID if it's not already set
      if (!contextObject[DAPR_CORRELATION_ID_KEY]) {
        contextObject[DAPR_CORRELATION_ID_KEY] = this.getByKey<string>(DAPR_CORRELATION_ID_KEY);
      }
      // Add the trace ID if it's not already set
      if (!contextObject[DAPR_TRACE_ID_KEY]) {
        contextObject[DAPR_TRACE_ID_KEY] = this.getByKey<string>(DAPR_TRACE_ID_KEY);
      }
      return contextObject;
    } catch (error) {
      // We don't want to throw an error if the context is not set.
      return undefined;
    }
  }

  private randomTraceId(): string {
    // Only use in the absence of an existing trace
    const version = '00'; // Current version
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const traceFlags = '01'; // Recorded
    return `${version}-${traceId}-${spanId}-${traceFlags}`;
  }
}
