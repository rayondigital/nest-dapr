import { Injectable, Scope, SetMetadata, Type } from '@nestjs/common';
import { DAPR_ACTIVITY_METADATA } from './constants';

/**
 * `@DaprActivity` decorator metadata
 */
export interface DaprActivityMetadata {
  /**
   * Name of Activity. If not provided, the class name will be used.
   */
  name?: string;
}

/**
 * Dapr Activity decorator.
 * Registers the class as an Activity and also as an injectable service.
 * All Activities are singleton's and cannot directly hold state.
 *
 * @param options Options of the Activity
 */
export function DaprActivity(options?: DaprActivityMetadata): ClassDecorator {
  return (target) => {
    SetMetadata(DAPR_ACTIVITY_METADATA, {
      name: options?.name,
    })(target);
    Injectable({ scope: Scope.DEFAULT })(target); // All Activities are singleton
  };
}

export function getActivityMetadata(target: Type<any>): DaprActivityMetadata {
  return Reflect.getMetadata(DAPR_ACTIVITY_METADATA, target);
}
