import { Injectable, Scope, SetMetadata, Type } from '@nestjs/common';
import { DAPR_ACTOR_METADATA } from './constants';

/**
 * `@DaprActor` decorator metadata
 */
export interface DaprActorMetadata {
  /**
   * Interface type (typically an abstract class as it will not be erased at runtime)
   */
  interfaceType: Type<any> | Function;
  /**
   * Name of actor.
   */
  name?: string;
  /**
   * Name of actor used by State Manager.
   */
  stateName?: string;
  /**
   * How long to wait before deactivating an idle actor instance.
   * Uses Go duration format, e.g. "1h", "30m", "10s".
   * Overrides the global actorIdleTimeout for this actor type.
   */
  idleTimeout?: string;
  /**
   * How long to wait for an in-flight actor method to complete during draining.
   * Uses Go duration format, e.g. "30s", "1m".
   * Overrides the global drainOngoingCallTimeout for this actor type.
   */
  drainOngoingCallTimeout?: string;
}

/**
 * Dapr Actor decorator.
 * Registers the class as an actor and also as an injectable service.
 *
 * @param options Options of the actor and its interface.
 */
export function DaprActor(options: DaprActorMetadata): ClassDecorator {
  return (target) => {
    SetMetadata(DAPR_ACTOR_METADATA, {
      name: options.name ?? target.constructor.name,
      stateName: options.stateName,
      interfaceType: options.interfaceType,
      idleTimeout: options.idleTimeout,
      drainOngoingCallTimeout: options.drainOngoingCallTimeout,
    })(target);
    Injectable({ scope: Scope.TRANSIENT })(target); // All actors are transient
  };
}

export function getActorMetadata(target: Type<any>): DaprActorMetadata {
  return Reflect.getMetadata(DAPR_ACTOR_METADATA, target);
}
