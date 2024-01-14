import { randomUUID } from 'crypto';
import { AbstractActor, ActorId, DaprClient } from '@dapr/dapr';
import ActorReminderData from '@dapr/dapr/actors/runtime/ActorReminderData';
import ActorTimerData from '@dapr/dapr/actors/runtime/ActorTimerData';
import BufferSerializer from '@dapr/dapr/actors/runtime/BufferSerializer';
import Class from '@dapr/dapr/types/Class';
import { Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { extractContext, resolveDependencies } from '../actors/nest.utils';
import { DAPR_CORRELATION_ID_KEY, DaprContextService } from '../dapr-context-service';
import { NoOpDaprClient } from './no-op-dapr-client';

const REMINDER_METHOD_NAME = 'receiveReminder'; // the callback method name for the reminder

export class TestActorManager<T> {
  readonly serializer: BufferSerializer = new BufferSerializer();
  private actors: Map<string, AbstractActor>;
  private type: Class<T> | Type<T>;

  constructor(
    type: Class<T> | Type<T>,
    private readonly daprClient: DaprClient | NoOpDaprClient,
    private readonly moduleRef?: ModuleRef,
    private readonly contextService?: DaprContextService,
  ) {
    this.type = type;
    this.actors = new Map();
  }

  async createActor(actorId: string | ActorId): Promise<T> {
    if (!this.actors.has(actorId.toString())) {
      const id = new ActorId(actorId.toString());
      const actor = new this.type(this.daprClient, id) as any;
      actor.id = id;
      actor.type = this.type;
      await resolveDependencies(this.moduleRef, actor);
      await this.activateActor(actorId, actor);
      this.actors.set(actorId.toString(), actor);
    }
    return this.actors.get(actorId.toString()) as T;
  }

  async activateActor(actorId: string | ActorId, actor: any): Promise<void> {
    if (actor.onActivate) {
      if (!actor.id) {
        actor.id = new ActorId(actorId.toString());
      }
      await actor.onActivate();
    }
  }

  async deactivateActor(actorId: string | ActorId): Promise<void> {
    const actor = this.actors.get(actorId.toString());
    if (actor?.onDeactivate) {
      await actor.onDeactivate();
    }
    this.actors.delete(actorId.toString());
  }

  async getActiveActor(actorId: string | ActorId): Promise<T> {
    if (!this.actors.has(actorId.toString())) {
      return await this.createActor(actorId);
    }
    return this.actors.get(actorId.toString()) as T;
  }

  async invoke(actorId: string | ActorId, actorMethodName: string, requestBody?: Buffer): Promise<any> {
    const requestBodyDeserialized = this.serializer.deserialize(requestBody || Buffer.from(''));
    return await this.callActorMethod(actorId, actorMethodName, requestBodyDeserialized);
  }

  // Implement fireReminder and fireTimer similarly, based on your application's needs

  async callActorMethod(actorId: string | ActorId, actorMethodName: string, args: any): Promise<Buffer> {
    const actor = await this.getActiveActor(actorId);
    if (!actor) {
      throw new Error(`Actor ${actorId} not found`);
    }
    if (this.contextService) {
      const clsService = this.contextService.getService();
      return await clsService.run(async () => {
        this.contextService.setIdIfNotDefined();
        // Try to extract the context from the data object
        // This method will remove any context from the data object (destructive)
        const context = extractContext(args);
        // If we have found a context object, set it in the CLS
        if (context) {
          this.contextService.set(context);
          // Attempt to set the correlation ID from the context
          const correlationId = context[DAPR_CORRELATION_ID_KEY] ?? randomUUID();
          if (correlationId) {
            this.contextService.setCorrelationId(correlationId);
          }
        }
        return await this.callActorMethodInternal(actorId, actor, actorMethodName, args);
      });
    }

    return await this.callActorMethodInternal(actorId, actor, actorMethodName, args);
  }

  async callActorMethodInternal(
    actorId: string | ActorId,
    actor: AbstractActor | T,
    actorMethodName: string,
    args: any,
  ): Promise<Buffer> {
    if (typeof actor[actorMethodName] === 'function') {
      if (Array.isArray(args)) {
        return actor[actorMethodName](...args);
      } else {
        return actor[actorMethodName](args);
      }
    }
    throw new Error(`Method ${actorMethodName} not found on actor ${actorId}`);
  }

  async fireReminder(actorId: string | ActorId, reminderName: string, requestBody?: Buffer): Promise<void> {
    const requestBodyDeserialized = this.serializer.deserialize(requestBody || Buffer.from(''));
    const reminderData = ActorReminderData.fromObject(reminderName, requestBodyDeserialized as object);
    await this.callActorMethod(actorId, REMINDER_METHOD_NAME, reminderData.state);
  }

  async fireTimer(actorId: string | ActorId, timerName: string, requestBody?: Buffer): Promise<void> {
    const requestBodyDeserialized = this.serializer.deserialize(requestBody || Buffer.from(''));
    const timerData = ActorTimerData.fromObject(timerName, requestBodyDeserialized as object);
    await this.callActorMethod(actorId, timerData.callback, timerData.state);
  }
}
