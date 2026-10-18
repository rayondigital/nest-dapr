import { DaprWorkflowClient as WorkflowClient, WorkflowState } from '@dapr/dapr';
import { WorkflowClientOptions } from '@dapr/dapr/types/workflow/WorkflowClientOption';
import { Injectable, Type } from '@nestjs/common';
import { WorkflowInput } from './workflow';

/** A Wrapper for the Dapr Workflow Client, which provides a mechanism to stop the GRPC channel. */
@Injectable()
export class DaprWorkflowClient {
  client?: WorkflowClient;

  async start(options?: Partial<WorkflowClientOptions>) {
    this.client = new WorkflowClient(options);
  }

  /**
   * Schedules a new workflow using the DurableTask client.
   *
   * @param {TWorkflow | string} workflow - The Workflow or the name of the workflow to be scheduled.
   * @param {any} [input] - The input to be provided to the scheduled workflow.
   * @param {string} [instanceId] - An optional unique identifier for the workflow instance.
   * @param {Date} [startAt] - An optional date and time at which the workflow should start.
   * @return {Promise<string>} A Promise resolving to the unique ID of the scheduled workflow instance.
   */
  async scheduleNewWorkflow(workflowName: string, input?: any, instanceId?: string, startAt?: Date): Promise<string>;
  async scheduleNewWorkflow<C extends Type<any>>(
    workflowClass: C,
    input: WorkflowInput<C>,
    instanceId?: string,
    startAt?: Date,
  ): Promise<string>;
  async scheduleNewWorkflow(wf: any, input?: any, instanceId?: string, startAt?: Date): Promise<string> {
    return this.client.scheduleNewWorkflow(wf, input, instanceId, startAt);
  }
  /**
   * Terminates the workflow associated with the provided instance id.
   *
   * @param {string} workflowInstanceId - Workflow instance id to terminate.
   * @param {any} output - The optional output to set for the terminated workflow instance.
   */
  async terminateWorkflow(workflowInstanceId: string, output: any): Promise<void> {
    await this.client?.terminateWorkflow(workflowInstanceId, output);
  }
  /**
   * Fetches workflow instance metadata from the configured durable store.
   *
   * @param {string} workflowInstanceId - The unique identifier of the workflow instance to fetch.
   * @param {boolean} getInputsAndOutputs - Indicates whether to fetch the workflow instance's
   *                                       inputs, outputs, and custom status (true) or omit them (false).
   * @returns {Promise<WorkflowState | undefined>} A Promise that resolves to a metadata record describing
   *                                              the workflow instance and its execution status, or undefined
   *                                              if the instance is not found.
   */
  async getWorkflowState(workflowInstanceId: string, getInputsAndOutputs: boolean): Promise<WorkflowState | undefined> {
    return this.client?.getWorkflowState(workflowInstanceId, getInputsAndOutputs);
  }
  /**
   * Waits for a workflow to start running and returns a {@link WorkflowState} object
   * containing metadata about the started instance, and optionally, its input, output,
   * and custom status payloads.
   *
   * A "started" workflow instance refers to any instance not in the Pending state.
   *
   * If a workflow instance is already running when this method is called, it returns immediately.
   *
   * @param {string} workflowInstanceId - The unique identifier of the workflow instance to wait for.
   * @param {boolean} fetchPayloads - Indicates whether to fetch the workflow instance's
   *                                  inputs, outputs (true) or omit them (false).
   * @param {number} timeoutInSeconds - The amount of time, in seconds, to wait for the workflow instance to start.
   * @returns {Promise<WorkflowState | undefined>} A Promise that resolves to the workflow instance metadata
   *                                               or undefined if no such instance is found.
   */
  async waitForWorkflowStart(
    workflowInstanceId: string,
    fetchPayloads?: boolean,
    timeoutInSeconds?: number,
  ): Promise<WorkflowState | undefined> {
    return this.client?.waitForWorkflowStart(workflowInstanceId, fetchPayloads, timeoutInSeconds);
  }
  /**
   * Waits for a workflow to complete running and returns a {@link WorkflowState} object
   * containing metadata about the completed instance, and optionally, its input, output,
   * and custom status payloads.
   *
   * A "completed" workflow instance refers to any instance in one of the terminal states.
   * For example, the Completed, Failed, or Terminated states.
   *
   * If a workflow instance is already running when this method is called, it returns immediately.
   *
   * @param {string} workflowInstanceId - The unique identifier of the workflow instance to wait for.
   * @param {boolean} fetchPayloads - Indicates whether to fetch the workflow instance's
   *                                  inputs, outputs (true) or omit them (false).
   * @param {number} timeoutInSeconds - The amount of time, in seconds, to wait for the workflow instance to complete. Defaults to 60 seconds.
   * @returns {Promise<WorkflowState | undefined>} A Promise that resolves to the workflow instance metadata
   *                                               or undefined if no such instance is found.
   */
  async waitForWorkflowCompletion(
    workflowInstanceId: string,
    fetchPayloads?: boolean,
    timeoutInSeconds?: number,
  ): Promise<WorkflowState | undefined> {
    return this.client?.waitForWorkflowCompletion(workflowInstanceId, fetchPayloads, timeoutInSeconds);
  }
  /**
   * Sends an event notification message to an awaiting workflow instance.
   *
   * This method triggers the specified event in a running workflow instance,
   * allowing the workflow to respond to the event if it has defined event handlers.
   *
   * @param {string} workflowInstanceId - The unique identifier of the workflow instance that will handle the event.
   * @param {string} eventName - The name of the event. Event names are case-insensitive.
   * @param {any} [eventPayload] - An optional serializable data payload to include with the event.
   */
  async raiseEvent(workflowInstanceId: string, eventName: string, eventPayload?: any): Promise<void> {
    await this.client?.raiseEvent(workflowInstanceId, eventName, eventPayload);
  }
  /**
   * Purges the workflow instance state from the workflow state store.
   *
   * This method removes the persisted state associated with a workflow instance from the state store.
   *
   * @param {string} workflowInstanceId - The unique identifier of the workflow instance to purge.
   * @return {Promise<boolean>} A Promise that resolves to true if the workflow state was found and purged successfully, otherwise false.
   */
  async purgeWorkflow(workflowInstanceId: string): Promise<boolean> {
    return this.client?.purgeWorkflow(workflowInstanceId);
  }
  /**
   * This method suspends a workflow instance, halting processing of it until resumeWorkflow is used to
   * resume the workflow.
   * @param {string} workflowInstanceId - The unique identifier of the workflow instance to suspend.
   */
  async suspendWorkflow(workflowInstanceId: string): Promise<void> {
    await this.client?.suspendWorkflow(workflowInstanceId);
  }
  /**
   * This method resumes a workflow instance that was suspended via suspendWorkflow.
   * @param {string} workflowInstanceId - The unique identifier of the workflow instance to resume.
   */
  async resumeWorkflow(workflowInstanceId: string): Promise<void> {
    await this.client?.resumeWorkflow(workflowInstanceId);
  }
  /**
   * Closes the inner DurableTask client and shutdown the GRPC channel.
   */
  async stop() {
    await this.client?.stop();
  }
}
