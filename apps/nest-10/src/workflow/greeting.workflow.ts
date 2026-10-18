import { WorkflowContext } from '@dapr/dapr';
import { DaprWorkflow, expect, Workflow } from '@rayondigital/nest-dapr';
import { GreetingActivity } from './greeting.activity';
import { ShoutActivity } from './shout.activity';

// Demonstrates a human-in-the-loop step: the workflow pauses after greeting and waits
// for an "approve" event (see WorkflowController.raiseEvent) before shouting the result.
@DaprWorkflow()
export class GreetingWorkflow implements Workflow<string, string> {
  async *run(
    ctx: WorkflowContext,
    name: string,
  ): AsyncGenerator<unknown, string> {
    ctx.setCustomStatus('greeting');
    const greeting = expect<string>(
      yield ctx.callActivity(GreetingActivity, name),
    );

    ctx.setCustomStatus('waiting-for-approval');
    yield ctx.waitForExternalEvent('approve');

    ctx.setCustomStatus('shouting');
    const shouted = expect<string>(
      yield ctx.callActivity(ShoutActivity, greeting),
    );

    ctx.setCustomStatus('done');
    return shouted;
  }
}
