import { Temporal } from '@dapr/dapr';
import { DaprActor, IState, State, StatefulActor } from '../../lib';

export abstract class StatefulReminderActorInterface {
  abstract schedule(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract reset(): Promise<void>;
  abstract getCounter(): Promise<number>;
}

export class ReminderState implements IState {
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
  interfaceType: StatefulReminderActorInterface,
})
export class StatefulReminderActor extends StatefulActor implements StatefulReminderActorInterface {
  @State({
    defaultValue: () => new ReminderState(),
  })
  state: ReminderState;

  async schedule() {
    // Schedule a reminder to run every 5 seconds
    this.state.counter = 0;
    await this.saveState();

    await this.registerActorReminder(
      'reminder',
      Temporal.Duration.from({ seconds: 1 }),
      Temporal.Duration.from({ seconds: 2 }),
      Temporal.Duration.from({ seconds: 30 }),
      'reminder-state',
    );
  }

  async reset() {
    this.state.counter = 0;
    await this.saveState();
  }

  async getCounter() {
    return this.state.counter;
  }

  async receiveReminder(payload: any): Promise<void> {
    console.log(payload);
    this.state.counter++;
    await this.saveState();

    throw new Error(
      "This should not create infinite retries, and prevent the timer from being rescheduled for it's next run.",
    );
  }

  async stop(): Promise<void> {
    await this.unregisterActorReminder('reminder');
  }
}
