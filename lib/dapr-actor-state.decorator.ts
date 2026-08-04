import { DAPR_ACTOR_STATE_METADATA } from './constants';
import { isSerializableType, StateCodecOptions } from './state/state-codec';

export interface StateProperty extends StateCodecOptions {
  key: string | symbol;
  name: string;
}

export function State(options?: {
  defaultValue?: any;
  name?: string;
  compressed?: boolean;
  serialize?: (value: any) => any;
  deserialize?: (value: any) => any;
}): PropertyDecorator {
  return (target, propertyKey) => {
    const properties: StateProperty[] = Reflect.getMetadata(DAPR_ACTOR_STATE_METADATA, target.constructor) || [];
    // Get the type of the property (might be useful for conversions later)
    const type = Reflect.getMetadata('design:type', target, propertyKey);
    properties.push({
      key: propertyKey,
      name: options?.name ?? propertyKey.toString(),
      type,
      defaultValue: options?.defaultValue,
      // Check to see if the type is serializable (See IState): does it have both `fromJSON` and `toJSON`?
      serializable: isSerializableType(type),
      compressed: options?.compressed ?? false,
      deserializeFn: options?.deserialize,
      serializeFn: options?.serialize,
    });
    Reflect.defineMetadata(DAPR_ACTOR_STATE_METADATA, properties, target.constructor);
  };
}
