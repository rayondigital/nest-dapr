import { WorkflowActivityContext } from '@dapr/dapr';
import { DaprActivity, WorkflowActivity } from '@rayondigital/nest-dapr';

@DaprActivity()
export class GreetingActivity implements WorkflowActivity<string, string> {
  async run(context: WorkflowActivityContext, name: string): Promise<string> {
    return `Hello, ${name}!`;
  }
}
