import { HttpMethod } from '@dapr/dapr';
import { SetMetadata } from '@nestjs/common';
import { DAPR_HANDLER_METADATA } from './constants';

/**
 * `@DaprHandler` decorator metadata
 */
export interface DaprHandlerMetadata {
  /**
   * The method name/path that remote services invoke via Dapr Service Invocation.
   * Corresponds to the `methodName` used in `client.invoker.invoke()` on the caller's side.
   */
  path: string;

  /**
   * The HTTP verb this handler accepts. Defaults to the Dapr JS SDK's own default (GET).
   * Ignored when the Dapr server is running in gRPC-only mode.
   */
  method?: HttpMethod;
}

/**
 * Dapr Service Invocation decorator.
 * Registers a handler for incoming service-to-service invocations
 * (https://docs.dapr.io/developing-applications/building-blocks/service-invocation/).
 *
 * The decorated method receives a `DaprInvokerCallbackContent` (body, query, headers & metadata)
 * and may return a value (serialized back to the caller) or void.
 *
 * @param options path (Dapr method name) and optional HTTP method (defaults to GET)
 */
export const DaprHandler = (options: DaprHandlerMetadata): MethodDecorator =>
  SetMetadata(DAPR_HANDLER_METADATA, {
    ...options,
    method: options.method ?? HttpMethod.GET,
  } as DaprHandlerMetadata);
