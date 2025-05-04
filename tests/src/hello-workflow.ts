import { DaprActivity } from '../../lib/dapr-activity.decorator';
import { WorkflowActivityContext, WorkflowContext } from '@dapr/dapr';
import { WorkflowActivity } from '../../lib/workflow/workflow-activity';
import { DaprWorkflow } from '../../lib/dapr-workflow.decorator';
import { expect, Workflow } from '../../lib/workflow/workflow';
import { CacheService } from './cache.service';
import { Inject } from '@nestjs/common';
import { Entity, EntityService } from './entity.service';

@DaprActivity()
export class HelloActivity implements WorkflowActivity<string, string> {
  async run(context: WorkflowActivityContext, name: string): Promise<string> {
    return `Hello ${name}!`;
  }
}

@DaprActivity()
export class CreateEntityActivity implements WorkflowActivity<string, Entity> {
  @Inject()
  private readonly entityService: EntityService;

  constructor(private readonly cacheService: CacheService) {}

  async run(context: WorkflowActivityContext, id: string): Promise<Entity> {
    const entity: Entity = { id: id, createdAt: new Date(), lastUpdatedAt: new Date(), status: 'created', data: {} };
    await this.entityService.update(entity);
    console.log('entity', entity);
    return entity;
  }
}

@DaprActivity()
export class GetEntityActivity implements WorkflowActivity<string, Entity> {
  @Inject()
  private readonly entityService: EntityService;

  constructor(private readonly cacheService: CacheService) {}

  async run(context: WorkflowActivityContext, id: string): Promise<Entity> {
    const entity = await this.entityService.get(id);
    console.log('entity', entity);
    return entity;
  }
}

@DaprWorkflow()
export class HelloWorkflow implements Workflow<string[], string> {
  async *run(ctx: WorkflowContext, input: string): AsyncGenerator<unknown, string[]> {
    const cities: string[] = [];

    let entity = expect<Entity>(yield ctx.callActivity(CreateEntityActivity, '12345'));
    ctx.setCustomStatus('Entity');

    entity = expect<Entity>(yield ctx.callActivity(GetEntityActivity, '12345'));
    console.log('entity', entity);
    ctx.setCustomStatus('Entity');

    const result1 = expect<string>(yield ctx.callActivity(HelloActivity, 'Tokyo'));
    ctx.setCustomStatus('Tokyo');

    const event = yield ctx.waitForExternalEvent('next');
    console.log('event', event);

    const result2 = expect<string>(yield ctx.callActivity(HelloActivity, 'Seattle'));
    ctx.setCustomStatus('Seattle');

    const result3 = expect<string>(yield ctx.callActivity(HelloActivity, 'London'));
    ctx.setCustomStatus('London');

    return cities;
  }
}
