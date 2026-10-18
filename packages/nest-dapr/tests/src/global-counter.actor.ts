import { IState, StatefulActor } from '../../lib/actors/stateful.actor';
import { DaprActor, State } from '../../lib';
import { trace } from '@opentelemetry/api';

export abstract class GlobalCounterActorInterface {
  abstract increment(): Promise<void>;
  abstract getCounter(): Promise<number>;
  abstract reset(): Promise<void>;
}

export class GlobalCounterState implements IState {
  counter: number = 0;

  fromJSON(json: any) {
    this.counter = json.counter;
    return this;
  }

  toJSON(): any {
    return {
      counter: this.counter,
    };
  }
}

@DaprActor({
  interfaceType: GlobalCounterActorInterface,
})
export class GlobalCounterActor extends StatefulActor implements GlobalCounterActorInterface {
  @State({
    defaultValue: () => new GlobalCounterState(),
  })
  state: GlobalCounterState;

  async onActivate(): Promise<void> {
    return super.onActivate();
  }

  async increment(): Promise<void> {
    this.state.counter++;

    // Emit a span for this operation
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent('increment', { counter: this.state.counter });
      span.end();
    }

    await this.saveState();
  }

  async getCounter(): Promise<number> {
    return this.state.counter ?? 0;
  }

  async reset(): Promise<void> {
    this.state.counter = 0;
    await this.saveState();
  }
}
