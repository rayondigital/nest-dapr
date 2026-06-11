import { CommunicationProtocolEnum } from '@dapr/dapr';

export function parseDaprCommunicationProtocol(value: string | undefined): CommunicationProtocolEnum {
  if (!value) return CommunicationProtocolEnum.HTTP;
  if (value.toLowerCase() === 'grpc') return CommunicationProtocolEnum.GRPC;
  return CommunicationProtocolEnum.HTTP;
}

export function getDaprPort(communicationProtocol: CommunicationProtocolEnum): string {
  switch (communicationProtocol) {
    case CommunicationProtocolEnum.GRPC:
      return process.env.DAPR_GRPC_PORT ?? '3501';
    default:
      return process.env.DAPR_PORT ?? '3500';
  }
}
