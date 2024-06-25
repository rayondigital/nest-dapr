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
    })(target);
    Injectable({ scope: Scope.TRANSIENT })(target); // All actors are transient
  };
}

export function getActorMetadata(target: Type<any>): DaprActorMetadata {
  return Reflect.getMetadata(DAPR_ACTOR_METADATA, target);
}
