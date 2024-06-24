import { Injectable, Logger } from '@nestjs/common';
import { DaprPubSub } from '@rayondigital/nest-dapr';

@Injectable()
export class PubSubReceiverService {
  private readonly logger = new Logger(PubSubReceiverService.name);

  // @DaprPubSub('eventhub-pubsub', 'events')
  pubSubHandler(message: any): void {
    console.log(message);
    this.logger.log(`Received topic message:`, message);
  }
}
