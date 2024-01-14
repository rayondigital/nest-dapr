import { randomUUID } from 'crypto';
import { AbstractActor, ActorId } from '@dapr/dapr';
import ActorClientHTTP from '@dapr/dapr/actors/client/ActorClient/ActorClientHTTP';
import ActorManager from '@dapr/dapr/actors/runtime/ActorManager';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DAPR_CORRELATION_ID_KEY, DaprContextService } from '../dapr-context-service';
import { DaprModuleActorOptions } from '../dapr.module';
import { extractContext, resolveDependencies } from './nest.utils';

@Injectable()
export class NestActorManager {
  setup(
    moduleRef: ModuleRef,
    options: DaprModuleActorOptions,
    onActivateFn?: (actorId: ActorId, instance: AbstractActor) => Promise<void>,
  ) {
    // The original create actor method
    const originalCreateActor = ActorManager.prototype.createActor;

    // We need replace/patch the original createActor method to resolve dependencies from the Nest Dependency Injection container
    ActorManager.prototype.createActor = async function (actorId: ActorId) {
      // Call the original createActor method
      const instance = (await originalCreateActor.bind(this)(actorId)) as AbstractActor;
      if (options?.typeNamePrefix) {
        // This is where we override the Actor Type Name at runtime
        // This means it may differ from the instance/ctor name.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        instance['actorType'] = `${options.typeNamePrefix}${instance.actorType}`;
      }

      // Attempt to resolve dependencies from the Nest Dependency Injection container
      try {
        await resolveDependencies(moduleRef, instance);
        if (onActivateFn) {
          await onActivateFn(actorId, instance);
        }
      } catch (error) {
        console.error(error);
        throw error;
      }
      return instance;
    };
  }

  setupReentrancy() {
    // Here we are patching the ActorClientHTTP to support reentrancy using the `Dapr-Reentrancy-Id` header
    // All subsequent calls in a request chain must use the same correlation/reentrancy ID for the reentrancy to work
    ActorClientHTTP.prototype.invoke = async function (
      actorType: string,
      actorId: ActorId,
      methodName: string,
      body: any,
      reentrancyId?: string,
    ) {
      const urlSafeId = encodeURIComponent(actorId.getId());
      const result = await this.client.execute(`/actors/${actorType}/${urlSafeId}/method/${methodName}`, {
        method: 'POST', // we always use POST calls for Invoking (ref: https://github.com/dapr/js-sdk/pull/137#discussion_r772636068)
        body,
        headers: {
          'Dapr-Reentrancy-Id': reentrancyId,
        },
      });
      return result as object;
    };
  }

  setupCSLWrapper(
    contextService: DaprContextService,
    invokeWrapperFn?: (
      actorId: ActorId,
      methodName: string,
      data: any,
      method: (actorId: ActorId, methodName: string, data: any) => Promise<any>,
    ) => Promise<any>,
  ) {
    // Here we are setting up CLS to work with the Dapr ActorManager
    const clsService = contextService.getService();
    if (!clsService) {
      throw new Error(`Unable to resolve a CLS from the NestJS DI container`);
    }

    // The original invoke actor method call
    const originalCallActor = ActorManager.prototype.callActorMethod;

    // Create a new callActor method that wraps CLS
    ActorManager.prototype.callActorMethod = async function (actorId: ActorId, methodName: string, data: any) {
      // Try catch, log and rethrow any errors
      try {
        return await clsService.run(async () => {
          contextService.setIdIfNotDefined();
          // Try to extract the context from the data object
          // This method will remove any context from the data object (destructive)
          const context = extractContext(data);
          // If we have found a context object, set it in the CLS
          if (context) {
            contextService.set(context);
            // Attempt to set the correlation ID from the context
            const correlationId = context[DAPR_CORRELATION_ID_KEY] ?? randomUUID();
            if (correlationId) {
              contextService.setCorrelationId(correlationId);
            }
          }

          if (invokeWrapperFn) {
            return await invokeWrapperFn(actorId, methodName, data, originalCallActor.bind(this));
          } else {
            return await originalCallActor.bind(this)(actorId, methodName, data);
          }
        });
      } catch (error) {
        Logger.error(`Error invoking actor method ${actorId}/${methodName}`);
        Logger.error(error);
        throw error;
      }
    };
  }
}

export interface ActorMethodInvocation {
  actorId: ActorId;
  method: string;
  data: any;
}
