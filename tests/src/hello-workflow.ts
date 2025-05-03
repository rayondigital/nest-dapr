import { DaprActivity } from '../../lib/dapr-activity.decorator';
import { WorkflowActivityContext, WorkflowContext } from '@dapr/dapr';
import { WorkflowActivity } from '../../lib/workflow/workflow-activity';
import { DaprWorkflow } from '../../lib/dapr-workflow.decorator';
import { expect, Workflow } from '../../lib/workflow/workflow';

@DaprActivity()
export class HelloActivity implements WorkflowActivity<string, string> {
  async run(context: WorkflowActivityContext, name: string): Promise<string> {
    return `Hello ${name}!`;
  }
}

@DaprWorkflow()
export class HelloWorkflow implements Workflow<string[]> {
  async *run(ctx: WorkflowContext): AsyncGenerator<unknown, string[]> {
    const cities: string[] = [];

    const result1 = expect<string>(yield ctx.callActivity(HelloActivity, 'Tokyo'));
    cities.push(result1);
    console.log(ctx.getCurrentUtcDateTime());
    ctx.setCustomStatus('Tokyo');

    const event = yield ctx.waitForExternalEvent('next');
    console.log('event', event);

    const result2 = expect<string>(yield ctx.callActivity(HelloActivity, 'Seattle'));
    cities.push(result2);
    console.log(ctx.getCurrentUtcDateTime());
    ctx.setCustomStatus('Seattle');

    const result3 = expect<string>(yield ctx.callActivity(HelloActivity, 'London'));
    cities.push(result3);
    console.log(ctx.getCurrentUtcDateTime());
    ctx.setCustomStatus('London');

    return cities;
  }
}
