import { Injectable, Scope, SetMetadata, Type } from '@nestjs/common';
import { DAPR_WORKFLOW_METADATA } from './constants';

/**
 * `@DaprWorkflow` decorator metadata
 */
export interface DaprWorkflowMetadata {
  /**
   * Name of Workflow. If not provided, the class name will be used.
   */
  name?: string;
}

/**
 * Dapr Workflow decorator.
 * Registers the class as a Workflow and also as an injectable service.
 * All Workflows dependencies are treated as singletons.
 *
 * @param options Options of the Workflow
 */
export function DaprWorkflow(options?: DaprWorkflowMetadata): ClassDecorator {
  return (target) => {
    SetMetadata(DAPR_WORKFLOW_METADATA, {
      name: options?.name,
    })(target);
    Injectable({ scope: Scope.DEFAULT })(target); // All Workflows are treated as singletons
  };
}

export function getWorkflowMetadata(target: Type<any>): DaprWorkflowMetadata {
  return Reflect.getMetadata(DAPR_WORKFLOW_METADATA, target);
}
