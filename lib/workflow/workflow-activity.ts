import { WorkflowActivityContext } from '@dapr/dapr';
import { TWorkflowActivity } from '@dapr/dapr/types/workflow/Activity.type';
import { Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

export interface WorkflowActivity<TInput = unknown, TResult = unknown> {
  run(context: WorkflowActivityContext, input: TInput): Promise<TResult>;
}

export function lazyActivity<
  TInput = unknown,
  TResult = unknown,
  TClass extends {
    run(ctx: WorkflowActivityContext, input: TInput): Promise<TResult>;
  } = any,
>(moduleRef: ModuleRef, klass: Type<TClass>): TWorkflowActivity<TInput, TResult> {
  let instance: TClass | undefined;
  //@ts-expect-error Return type is not compatible with the original function
  return async function (ctx: WorkflowActivityContext, input: TInput): Promise<TOutput> {
    if (!instance) {
      instance = moduleRef.get(klass, { strict: false });
    }
    return instance.run(ctx, input);
  };
}
