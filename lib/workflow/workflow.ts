import { TWorkflow, WorkflowContext } from '@dapr/dapr';
import { Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { WorkflowActivity } from './workflow-activity';

export interface Workflow<TResult = unknown, TInput = unknown> {
  run(context: WorkflowContext, input: TInput): AsyncGenerator<unknown, TResult> | TResult;
}

export function lazyWorkflow<
  TInput = unknown,
  TResult = unknown,
  TClass extends {
    run(context: WorkflowContext, input: TInput): AsyncGenerator<unknown, TResult> | TResult;
  } = any,
>(moduleRef: ModuleRef, klass: Type<TClass>): TWorkflow {
  let instance: TClass | undefined;
  return function (ctx: WorkflowContext, input: TInput) {
    if (!instance) {
      instance = moduleRef.get(klass, { strict: false });
    }
    return instance.run(ctx, input);
  } as unknown as TWorkflow;
}

type ActivityInput<C extends Type<WorkflowActivity>> = Parameters<InstanceType<C>['run']>[1];

type ActivityOutput<C extends Type<WorkflowActivity>> = Awaited<ReturnType<InstanceType<C>['run']>>;

declare module '@dapr/dapr' {
  interface WorkflowContext {
    callActivity<C extends Type<WorkflowActivity>>(
      activityClass: C,
      input: ActivityInput<C>,
    ): Promise<ActivityOutput<C>>;
  }
}

export function expect<T>(value: unknown) {
  return value as T;
}
