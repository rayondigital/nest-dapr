import { Scope, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';

export async function resolveDependencies(moduleRef: ModuleRef, instance: any): Promise<void> {
  const type = instance.constructor;
  try {
    const injector = moduleRef['injector'];
    const wrapper = new InstanceWrapper({
      name: type && type.name,
      metatype: type,
      isResolved: false,
      scope: Scope.TRANSIENT,
      durable: true,
    });

    const properties = injector.reflectProperties(wrapper.metatype as Type<any>);
    for (const item of properties) {
      if ('type' in item && item.type) {
        const propertyType = item.type as Type<any>;
        const resolved = await moduleRef.get(propertyType, { strict: false });
        if (resolved) {
          instance[item.key] = resolved;
        }
      }
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export function extractContext(data: any): any {
  if (!data) return undefined;
  // The context object should always be the last item in the array
  if (Array.isArray(data)) {
    const lastItem = data[data.length - 1];
    if (lastItem['$t'] === 'ctx') {
      // Remove this item from the array
      data.pop();
      return lastItem;
    }
  }
  // Perhaps the context is the entire object?
  if (data['$t'] === 'ctx') {
    // Copy the context object and remove it from the data object
    const context = Object.assign({}, data);
    data = undefined;
    return context;
  }
  // Allow embedding the context as a property
  if (data['$ctx']) {
    const context = Object.assign({}, data['$ctx']);
    data['$ctx'] = undefined;
    return context;
  }
  return undefined;
}
