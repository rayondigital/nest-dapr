import { AbstractActor } from '@dapr/dapr';
import { DaprActor, DaprContextService, SerializableError } from '../../lib';
import { Inject } from '@nestjs/common';
import { DaprActorOnEvent } from '../../lib/dapr-actor-on-event.decorator';

export abstract class StatelessCounterActorInterface {
  abstract increment(): Promise<void>;
  abstract getCounter(): Promise<number>;
  abstract throwSerializableError(): Promise<void>;
  abstract throwError(): Promise<void>;
  abstract reset(): Promise<void>;
}

@DaprActor({
  interfaceType: StatelessCounterActorInterface,
})
export class StatelessCounterActor extends AbstractActor implements StatelessCounterActorInterface {
  @Inject()
  private readonly contextService: DaprContextService;

  counter: number = 0;

  @DaprActorOnEvent('com.example.*', (payload: any) => payload.producerId)
  async increment(): Promise<void> {
    const existingContext = this.contextService.get<any>();

    console.log('existingContext', existingContext);
    console.log('correlationID', existingContext?.correlationID);
    this.counter++;
  }

  async getCounter(): Promise<number> {
    const existingContext = this.contextService.get<any>();

    console.log('existingContext', existingContext);
    console.log('correlationID', existingContext?.correlationID);
    return this.counter;
  }

  async reset(): Promise<void> {
    this.counter = 0;
  }

  async throwSerializableError(): Promise<void> {
    // This will result in HTTP 400 (Bad Request) and will propagate to the client
    throw new SerializableError('This is a serializable error. This should propagate to the client side.', 400);
  }

  async throwError(): Promise<void> {
    // This will result in HTTP 500 (Internal Server Error)
    throw new Error('This is a non-serializable error. This will occur on the server side.');
  }
}
