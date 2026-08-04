import { ActorId, DaprClient } from '@dapr/dapr';
import { Inject, Logger } from '@nestjs/common';
import { maybeDecompressValue } from '../compression';
import { DAPR_ACTOR_STATE_METADATA } from '../constants';
import { StateProperty } from '../dapr-actor-state.decorator';
import { DaprContextService } from '../dapr-context-service';
import { dehydrateStateValue, hydrateStateValue } from '../state/state-codec';
import { AbstractActor } from './abstract-actor';
import { DaprActorClient } from './dapr-actor-client.service';

export interface IState {
  fromJSON(json: any): this;
  toJSON(): any;
}

export class StatefulActor extends AbstractActor {
  private statePropertiesInternal: StateProperty[];

  @Inject()
  protected readonly client: DaprActorClient;
  @Inject()
  protected readonly contextService: DaprContextService;

  protected logger: Logger;

  constructor(daprClient: DaprClient, id: ActorId) {
    super(daprClient, id);
    this.logger = new Logger(this.constructor.name);
  }

  async onActivate(): Promise<void> {
    this.statePropertiesInternal =
      (Reflect.getMetadata(DAPR_ACTOR_STATE_METADATA, this.constructor) as StateProperty[]) || [];
    await super.onActivate();
    await this.getAllState();
  }

  protected logMessage(message: any, level: 'log' | 'error' | 'warn' | 'debug' = 'log') {
    switch (level) {
      case 'log':
        this.logger.log(message, this.constructor.name);
        break;
      case 'error': {
        const stack = message.stack ?? new Error().stack;
        this.logger.error(message, stack, this.constructor.name);
        break;
      }
      case 'warn':
        this.logger.warn(message, this.constructor.name);
        break;
      case 'debug':
        this.logger.debug(message, this.constructor.name);
        break;
    }
  }

  protected log(message: any, ...optionalParams: [...any, string?]) {
    this.logger.log(message, ...optionalParams);
  }

  protected verbose(message: any, ...optionalParams: [...any, string?]) {
    this.logger.verbose(message, ...optionalParams);
  }

  protected warn(message: any, ...optionalParams: [...any, string?]) {
    this.logger.warn(message, ...optionalParams);
  }

  protected async setStateValue<T>(stateName: string, value: T): Promise<void> {
    await this.getStateManager<T>().setState(stateName, value);
  }

  protected async removeStateValue(stateName: string): Promise<void> {
    await this.getStateManager().removeState(stateName);
  }

  protected async saveState(): Promise<void> {
    await this.setAllStateFromPropertiesInternal();
    await this.getStateManager().saveState();
  }

  protected async clearState(): Promise<void> {
    for (const property of this.statePropertiesInternal) {
      await this.removeStateValue(property.name);
    }
  }

  protected async getAllState() {
    for (const property of this.statePropertiesInternal) {
      await this.loadStatePropertyInternal(property);
    }
  }

  private async loadStatePropertyInternal(property: StateProperty) {
    // getStateValue already transparently unwraps any compression envelope, and
    // hydrateStateValue attempts it again defensively — a harmless no-op here.
    const rawValue = await this.getStateValue(property.name);
    (this as any)[property.key] = await hydrateStateValue(rawValue, property);
  }

  private async setAllStateFromPropertiesInternal() {
    // Iterate over all @State properties and set their inner state manager values.
    for (const property of this.statePropertiesInternal) {
      const value = await dehydrateStateValue((this as any)[property.key], property);
      await this.setStateValue(property.name, value);
    }
  }

  protected async getStateValue<T>(stateName: string, defaultValue?: T): Promise<T | undefined> {
    try {
      const value = await this.getStateManager<T>().getState(stateName);
      if (value === undefined) {
        return defaultValue;
      }
      // Transparently unwrap a compression envelope if present. This is driven by
      // the value's shape, not by the `compressed` flag, so values written while
      // compression was enabled stay readable even after it is turned off again.
      // Non-envelope values (and anything that only looks like one) pass through
      // unchanged, so turning compression on/off carries no downside either way.
      return (await maybeDecompressValue(value)) as T;
    } catch (e) {
      // Before we return the value, lets just check that there is no existing entry
      const exists = await this.getStateManager().containsState(stateName);
      if (!exists) {
        return defaultValue;
      }
      // There is an existing item that we are unable to obtain
      throw e;
    }
  }
}
