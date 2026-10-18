import { WorkflowActivityContext } from '@dapr/dapr';
import { DaprActivity, WorkflowActivity } from '@rayondigital/nest-dapr';

@DaprActivity()
export class ShoutActivity implements WorkflowActivity<string, string> {
  async run(
    context: WorkflowActivityContext,
    message: string,
  ): Promise<string> {
    return message.toUpperCase();
  }
}
