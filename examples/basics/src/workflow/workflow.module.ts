import { Module } from '@nestjs/common';
import { GreetingActivity } from './greeting.activity';
import { GreetingWorkflow } from './greeting.workflow';
import { ShoutActivity } from './shout.activity';
import { WorkflowController } from './workflow.controller';

@Module({
  controllers: [WorkflowController],
  providers: [GreetingWorkflow, GreetingActivity, ShoutActivity],
})
export class GreetingWorkflowModule {}
