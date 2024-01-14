import { AbstractActor, ActorId, DaprClient } from '@dapr/dapr';
import IClient from '@dapr/dapr/interfaces/Client/IClient';
import Class from '@dapr/dapr/types/Class';
import { ActorRuntimeOptions } from '@dapr/dapr/types/actors/ActorRuntimeOptions';
import { Injectable, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DaprContextService } from '../dapr-context-service';
import { TestActorManager } from './test-actor-manager';

@Injectable()
export class TestActorRuntime {
  private static instance: TestActorRuntime;

  private actorManagers: Map<string, TestActorManager<any>>;
  private actorTypes: Map<string, Class<any> | Type | Function> = new Map();
  private actorInterfaces: Map<string, string> = new Map();

  constructor(
    private readonly daprClient: DaprClient,
    private readonly moduleRef?: ModuleRef,
    private readonly contextService?: DaprContextService,
  ) {
    this.actorManagers = new Map<string, TestActorManager<any>>();
  }

  static getInstanceByDaprClient(daprClient: DaprClient): TestActorRuntime {
    if (!TestActorRuntime.instance) {
      TestActorRuntime.instance = new TestActorRuntime(daprClient);
    }
    return TestActorRuntime.instance;
  }

  static getInstance(client: IClient): TestActorRuntime {
    if (!TestActorRuntime.instance) {
      const daprClient = DaprClient.create(client);
      TestActorRuntime.instance = new TestActorRuntime(daprClient);
    }
    return TestActorRuntime.instance;
  }

  registerActor<T extends AbstractActor>(actorCls: Class<T> | Type<T>): void {
    // Create an ActorManager if it hasn't been registered yet
    if (!this.actorManagers.has(actorCls.name)) {
      this.actorTypes.set(actorCls.name ?? actorCls.constructor.name, actorCls);
      this.actorManagers.set(
        actorCls.name,
        new TestActorManager<T>(actorCls, this.daprClient, this.moduleRef, this.contextService),
      );
    }
  }

  getRegisteredActorTypes(): string[] {
    return Array.from(this.actorManagers.keys());
  }

  getActorRuntimeOptions(): ActorRuntimeOptions {
    return this.daprClient.options.actor ?? {};
  }

  setActorRuntimeOptions(options: ActorRuntimeOptions): void {
    this.daprClient.options.actor = options;
  }

  clearActorManagers(): void {
    this.actorManagers = new Map<string, TestActorManager<any>>();
  }

  getActorManager<T extends AbstractActor>(actorTypeName: string): TestActorManager<T> {
    const actorManager = this.actorManagers.get(actorTypeName);

    if (!actorManager) {
      throw new Error(`ACTOR_TYPE_${actorTypeName}_NOT_REGISTERED`);
    }

    // We need to cast to ActorManager<T> since Map actorManagers
    // is initialized with ActorManager<any> since we don't know the type there
    return actorManager as TestActorManager<T>;
  }

  /**
   * Invokes a method on the actor from the runtime
   * This method will open the manager for the actor type and get the matching object
   * It will then invoke the method on this object
   *
   * @param actorTypeName
   * @param actorId
   * @param actorMethodName
   * @param payload
   * @returns
   */
  async invoke(actorTypeName: string, actorId: string, actorMethodName: string, requestBody?: Buffer): Promise<Buffer> {
    const actorIdObj = new ActorId(actorId);
    const manager = this.getActorManager(actorTypeName);
    return await manager.invoke(actorIdObj, actorMethodName, requestBody);
  }

  /**
   * Fires a reminder for the actor
   *
   * @param actorTypeName the name fo the actor type
   * @param actorId the actor id
   * @param name the name of the reminder
   * @param requestBody the body passed to the reminder callback
   */
  async fireReminder(actorTypeName: string, actorId: string, name: string, requestBody?: Buffer) {
    const actorIdObj = new ActorId(actorId);
    const manager = this.getActorManager(actorTypeName);
    return await manager.fireReminder(actorIdObj, name, requestBody);
  }

  /**
   * Fires a timer for the actor
   *
   * @param actorTypeName the name fo the actor type
   * @param actorId the actor id
   * @param name the name of the timer
   * @param requestBody the body passed to the timer callback
   */
  async fireTimer(actorTypeName: string, actorId: string, name: string, requestBody?: Buffer) {
    const actorIdObj = new ActorId(actorId);
    const manager = this.getActorManager(actorTypeName);
    return await manager.fireTimer(actorIdObj, name, requestBody);
  }

  async deactivate(actorTypeName: string, actorId: string): Promise<void> {
    const actorIdObj = new ActorId(actorId);
    const manager = this.getActorManager(actorTypeName);
    return await manager.deactivateActor(actorIdObj);
  }
}
