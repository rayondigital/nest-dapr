import { Injectable, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  DAPR_ACTOR_METADATA,
  DAPR_BINDING_METADATA,
  DAPR_PUBSUB_METADATA,
  DAPR_ACTOR_EVENT_METADATA,
  DAPR_ACTIVITY_METADATA,
  DAPR_WORKFLOW_METADATA,
} from './constants';
import { DaprActivityMetadata } from './dapr-activity.decorator';
import { DaprActorOnEventMetadata } from './dapr-actor-on-event.decorator';
import { DaprActorMetadata } from './dapr-actor.decorator';
import { DaprBindingMetadata } from './dapr-binding.decorator';
import { DaprPubSubMetadata } from './dapr-pubsub.decorator';
import { DaprWorkflowMetadata } from './dapr-workflow.decorator';

@Injectable()
export class DaprMetadataAccessor {
  constructor(private readonly reflector: Reflector) {}

  getDaprPubSubHandlerMetadata(target: Type<unknown>): DaprPubSubMetadata | undefined {
    return this.reflector.get(DAPR_PUBSUB_METADATA, target);
  }

  getDaprBindingHandlerMetadata(target: Type<unknown>): DaprBindingMetadata | undefined {
    return this.reflector.get(DAPR_BINDING_METADATA, target);
  }

  getDaprActorMetadata(target: Function | Type<unknown>): DaprActorMetadata | undefined {
    return this.reflector.get<DaprActorMetadata>(DAPR_ACTOR_METADATA, target);
  }

  getDaprActivityMetadata(target: Function | Type<unknown>): DaprActivityMetadata | undefined {
    return this.reflector.get<DaprActorMetadata>(DAPR_ACTIVITY_METADATA, target);
  }

  getDaprWorkflowMetadata(target: Function | Type<unknown>): DaprWorkflowMetadata | undefined {
    return this.reflector.get<DaprActorMetadata>(DAPR_WORKFLOW_METADATA, target);
  }

  getDaprEventHandlerMetadata(target: Type<unknown>): DaprActorOnEventMetadata<any>[] | undefined {
    // Circumvent a crash that comes from reflect-metadata if it is
    // given a non-object non-function target to reflect upon.
    if (!target || (typeof target !== 'function' && typeof target !== 'object')) {
      return undefined;
    }

    const metadata = this.reflector.get(DAPR_ACTOR_EVENT_METADATA, target);
    if (!metadata) {
      return undefined;
    }
    return Array.isArray(metadata) ? metadata : [metadata];
  }
}
