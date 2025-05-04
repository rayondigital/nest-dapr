import { TWorkflow, WorkflowContext, WorkflowState } from '@dapr/dapr';
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

export type WorkflowInput<C extends Type<any>> =
  // Parameters<[ctx, input?, ...]>
  Parameters<InstanceType<C>['run']> extends [any, infer P, ...any[]] ? P : void;

export type WorkflowReturn<C extends Type<any>> = ReturnType<InstanceType<C>['run']> extends AsyncGenerator<
  any,
  infer R,
  any
>
  ? R
  : Awaited<ReturnType<InstanceType<C>['run']>>;

export type ActivityInput<C extends Type<WorkflowActivity>> = Parameters<InstanceType<C>['run']>[1];

export type ActivityOutput<C extends Type<WorkflowActivity>> = Awaited<ReturnType<InstanceType<C>['run']>>;

declare module '@dapr/dapr' {
  interface WorkflowContext {
    callActivity<C extends Type<WorkflowActivity>>(
      activityClass: C,
      input: ActivityInput<C>,
    ): Promise<ActivityOutput<C>>;
  }
}

/**
 * Type assertion function to assert the type of value.
 *
 * Usage:
 *   const value = expect<HelloWorkflow>(state);
 */
export function expect<T>(value: unknown) {
  return value as T;
}

/**
 * Extract the *typed* output value from a WorkflowState.
 *
 * Usage:
 *   const value = workflowOutput(HelloWorkflow, state);
 */
export function workflowOutput<C extends Type<any>>(workflowType: C, state: WorkflowState): WorkflowReturn<C> {
  const raw = state.serializedOutput;
  return raw
    ? (JSON.parse(raw) as WorkflowReturn<C>) // ← strongly-typed
    : (undefined as unknown as WorkflowReturn<C>);
}

/**
 * Extract the *typed* input value from a WorkflowState.
 *
 * Usage:
 *   const value = workflowInput(HelloWorkflow, state);
 */
export function workflowInput<C extends Type<any>>(workflowType: C, state: WorkflowState): WorkflowInput<C> {
  const raw = state.serializedInput;
  return raw
    ? (JSON.parse(raw) as WorkflowInput<C>) // ← strongly-typed
    : (undefined as unknown as WorkflowInput<C>);
}
