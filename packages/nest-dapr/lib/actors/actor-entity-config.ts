import * as ActorsUtil from '@dapr/dapr/utils/Actors.util';

export interface ActorEntityConfig {
  entities: string[];
  actorIdleTimeout?: string;
  drainOngoingCallTimeout?: string;
}

export const entityConfigCache: ActorEntityConfig[] = [];

const _original = ActorsUtil.getRegisteredActorResponse;
(ActorsUtil as any).getRegisteredActorResponse = function (entities: string[], options: any) {
  const response = _original(entities, options);
  if (entityConfigCache.length > 0) {
    response.entitiesConfig = entityConfigCache;
  }
  return response;
};
