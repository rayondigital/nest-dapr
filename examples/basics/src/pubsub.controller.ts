import { DaprClient } from '@dapr/dapr';
import { Controller, Logger, Param, Post } from '@nestjs/common';
import { Message } from './message';
import { DaprPubSub, DaprPubSubClient } from '@rayondigital/nest-dapr';

@Controller()
export class PubsubController {
  private readonly logger = new Logger(PubsubController.name);

  constructor(
    readonly daprClient: DaprClient,
    readonly daprPubSubClient: DaprPubSubClient,
  ) {
    this.logger.log(`Dapr Client running on ${daprClient.options.daprPort}`);
  }

  @Post('pubsub/:topic')
  async pubsub(@Param('topic') topic = 'events') {
    const message: Message = { hello: Date.now().toString() };
    console.log('message', message);
    await this.daprPubSubClient.publish('123', topic, message);
  }

  @DaprPubSub({ name: 'eventhub-pubsub', topicName: 'events' })
  pubSubHandler(message: Message): void {
    console.log(message);
    this.logger.log(`Received topic message:`, message);
  }
}
