import { KeyValueType } from '@dapr/dapr/types/KeyValue.type';
import { SetMetadata } from '@nestjs/common';
import { DAPR_PUBSUB_METADATA } from './constants';

/**
 * `@DaprBinding` decorator metadata
 */
export interface DaprPubSubMetadata {
  /**
   * Name of pubsub component.
   */
  name: string;

  /**
   * Topic name to subscribe.
   */
  topicName: string;

  /**
   * Route to use.
   */
  route?: string;

  /**
   * Optional metadata to pass with the pubsub message.
   * See https://docs.dapr.io/reference/components-reference/supported-pubsub/setup-azure-servicebus-topics/
   */
  metadata?: KeyValueType;
}

/**
 * Dapr pubsub decorator.
 * Subscribes to Dapr pubsub topics.
 *
 * @param options name, topic and route (optional)
 */
export const DaprPubSub = (options: DaprPubSubMetadata): MethodDecorator => SetMetadata(DAPR_PUBSUB_METADATA, options);
