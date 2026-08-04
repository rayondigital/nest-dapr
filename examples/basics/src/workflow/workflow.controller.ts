import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { DaprWorkflowClient, workflowOutput } from '@rayondigital/nest-dapr';
import { GreetingWorkflow } from './greeting.workflow';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflowClient: DaprWorkflowClient) {}

  @Post('greeting')
  @HttpCode(201)
  async start(@Body('name') name?: string): Promise<{ instanceId: string }> {
    const instanceId = await this.workflowClient.scheduleNewWorkflow(
      GreetingWorkflow,
      name ?? 'World',
    );
    return { instanceId };
  }

  @Get(':instanceId')
  async status(@Param('instanceId') instanceId: string) {
    const state = await this.workflowClient.getWorkflowState(instanceId, true);
    if (!state) {
      throw new NotFoundException(`Workflow instance ${instanceId} not found`);
    }

    return {
      instanceId: state.instanceId,
      name: state.name,
      runtimeStatus: state.runtimeStatus,
      customStatus: state.customStatus,
      createdAt: state.createdAt,
      lastUpdatedAt: state.lastUpdatedAt,
      output: workflowOutput(GreetingWorkflow, state),
    };
  }

  // Human-in-the-loop: GreetingWorkflow pauses after greeting and waits for this event
  // (named "approve" in this demo) before it will continue on to the shout activity.
  @Post(':instanceId/events/:eventName')
  @HttpCode(202)
  async raiseEvent(
    @Param('instanceId') instanceId: string,
    @Param('eventName') eventName: string,
    @Body() payload?: unknown,
  ): Promise<{ instanceId: string; eventName: string }> {
    await this.workflowClient.raiseEvent(instanceId, eventName, payload);
    return { instanceId, eventName };
  }
}
