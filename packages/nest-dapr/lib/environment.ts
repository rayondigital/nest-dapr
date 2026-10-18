import { CommunicationProtocolEnum } from '@dapr/dapr';
import { DaprModuleOptions } from './dapr.module';

// Dapr sidecar defaults (match the Dapr CLI / Kubernetes sidecar injector).
export const DEFAULT_DAPR_HOST = '127.0.0.1';
export const DEFAULT_DAPR_HTTP_PORT = '3500';
export const DEFAULT_DAPR_GRPC_PORT = '50001';

export function parseDaprCommunicationProtocol(value: string | undefined): CommunicationProtocolEnum {
  if (!value) return CommunicationProtocolEnum.HTTP;
  if (value.toLowerCase() === 'grpc') return CommunicationProtocolEnum.GRPC;
  return CommunicationProtocolEnum.HTTP;
}

export function getDaprPort(communicationProtocol: CommunicationProtocolEnum): string {
  switch (communicationProtocol) {
    case CommunicationProtocolEnum.GRPC:
      return process.env.DAPR_GRPC_PORT ?? DEFAULT_DAPR_GRPC_PORT;
    default:
      return process.env.DAPR_HTTP_PORT ?? process.env.DAPR_PORT ?? DEFAULT_DAPR_HTTP_PORT;
  }
}

/**
 * Resolves the sidecar endpoint used by the workflow runtime and client.
 * Workflows only talk to the sidecar's gRPC API, so this never falls back to the HTTP port
 * and never uses `serverHost`/`serverPort` (which are the app's own callback server).
 */
export function resolveWorkflowEndpoint(options: DaprModuleOptions): { daprHost: string; daprPort: string } {
  return {
    daprHost: options.workflowOptions?.daprHost ?? options.clientOptions?.daprHost ?? DEFAULT_DAPR_HOST,
    daprPort: options.workflowOptions?.daprPort ?? process.env.DAPR_GRPC_PORT ?? DEFAULT_DAPR_GRPC_PORT,
  };
}
