import { AbstractActor } from '@dapr/dapr';
import { DaprActor, DaprActorClient, DaprContextService } from '../../lib';
import { Inject } from '@nestjs/common';
import { StatelessCounterActorInterface } from './stateless-counter.actor';

export interface TraceReport {
  self: string;
  nested: string;
  counter: string;
}

export abstract class ContextAwareActorInterface {
  abstract run(): Promise<string>;
  abstract ping(): Promise<string>;
  // Returns the trace ID observed in this actor's propagated context.
  abstract getObservedTraceId(): Promise<string>;
  // Fans out to a nested actor and a stateless counter actor, returning the
  // trace ID each hop observed so a test can assert they all share one trace.
  abstract runTraced(): Promise<TraceReport>;
}

@DaprActor({
  interfaceType: ContextAwareActorInterface,
})
export class ContextAwareActor extends AbstractActor implements ContextAwareActorInterface {
  @Inject()
  private readonly client: DaprActorClient;

  @Inject()
  private readonly contextService: DaprContextService;

  async run(): Promise<string> {
    const existingContext = this.contextService.get<any>();

    console.log('existingContext', existingContext);
    console.log('correlationID', existingContext?.correlationID);

    const nested = this.client.getActor(ContextAwareActorInterface, 'nested-context-2');
    await nested.ping();

    const counter = this.client.getActor(StatelessCounterActorInterface, 'counter-1');
    await counter.reset();
    const previousValue = await counter.getCounter();

    // Increment 3 times
    await counter.increment();
    await counter.increment();
    await counter.increment();

    const value = await counter.getCounter();
    console.log('counter', value);

    expect(value).toBe(previousValue + 3);

    return existingContext?.correlationID;
  }

  async ping(): Promise<string> {
    const existingContext = this.contextService.get<any>();

    console.log('existingContext', existingContext);
    console.log('correlationID', existingContext?.correlationID);

    return existingContext?.correlationID;
  }

  async getObservedTraceId(): Promise<string> {
    return this.contextService.getTraceId();
  }

  async runTraced(): Promise<TraceReport> {
    const self = this.contextService.getTraceId();

    // actor -> actor hop
    const nested = this.client.getActor(ContextAwareActorInterface, 'nested-trace-2');
    const nestedTraceId = await nested.getObservedTraceId();

    // actor -> actor (different type) hop
    const counter = this.client.getActor(StatelessCounterActorInterface, 'counter-trace-1');
    const counterTraceId = await counter.getObservedTraceId();

    return { self, nested: nestedTraceId, counter: counterTraceId };
  }
}
