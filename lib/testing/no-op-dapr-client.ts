import { CommunicationProtocolEnum, DaprClientOptions } from '@dapr/dapr';
import { Injectable } from '@nestjs/common';

@Injectable()
export class NoOpDaprClient {
  options: DaprClientOptions;
  constructor() {
    this.options = {
      daprHost: 'localhost',
      daprPort: '3500',
      communicationProtocol: CommunicationProtocolEnum.HTTP,
      actor: {
        actorIdleTimeout: '30000',
        actorScanInterval: '10000',
        reentrancy: {
          enabled: true,
          maxStackDepth: 32,
        },
      },
    };
  }
}
