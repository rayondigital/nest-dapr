import { CommunicationProtocolEnum, DaprClient, DaprPubSubStatusEnum, DaprServer } from '@dapr/dapr';
import { DaprClientOptions } from '@dapr/dapr/types/DaprClientOptions';
import { DynamicModule, Module, ModuleMetadata, Provider, Scope, Type } from '@nestjs/common';
import { DiscoveryModule, Reflector } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ActorRuntimeService } from './actors/actor-runtime.service';
import { DaprActorClient } from './actors/dapr-actor-client.service';
import { NestActorManager } from './actors/nest-actor-manager';
import { DaprContextService } from './dapr-context-service';
import { DaprEventEmitter } from './dapr-event-emitter.service';
import { DaprEventSubscriberLoader } from './dapr-event-subscriber.loader';
import { DaprMetadataAccessor } from './dapr-metadata.accessor';
import { DaprLoader } from './dapr.loader';
import { DaprLockClient } from './lock/dapr-lock-client.service';
import { DaprPubSubClient } from './pubsub/dapr-pubsub-client.service';
import { DaprStateClient } from './state/dapr-state-client.service';
import { DaprWorkflowClient } from './workflow/dapr-workflow-client.service';

export const DAPR_MODULE_OPTIONS_TOKEN = 'DAPR_MODULE_OPTIONS_TOKEN';

export interface DaprModuleOptions {
  serverHost?: string;
  serverPort?: string;
  serverGrpcPort?: string;
  communicationProtocol?: CommunicationProtocolEnum;
  clientOptions?: Partial<DaprClientOptions>;
  actorOptions?: DaprModuleActorOptions;
  workflowOptions?: DaprModuleWorkflowOptions;
  pubsubOptions?: DaprModulePubSubOptions;
  disabled?: boolean;
  contextProvider?: DaprContextProvider;
  logging?: DaprModuleLoggingOptions;
  catchErrors?: boolean;
  extraProviders?: Provider[];
  handlers?: DaprModuleHandlers;
}

export interface DaprModuleHandlers {
  onInitialized?: (options?: DaprModuleOptions) => Promise<void>;
  onServerStarting?: (server: DaprServer) => Promise<void>;
  onServerStarted?: (server: DaprServer) => Promise<void>;
}

export interface DaprModuleLoggingOptions {
  enabled: boolean;
}

export interface DaprModuleActorOptions {
  enabled: boolean;
  allowInternalCalls?: boolean; // Allow actors to call internally within the same process
}

export interface DaprModuleWorkflowOptions {
  enabled: boolean;
  /** Sidecar host for the workflow gRPC API. Defaults to `clientOptions.daprHost`, then 127.0.0.1. */
  daprHost?: string;
  /** Sidecar gRPC port (not the HTTP port). Defaults to DAPR_GRPC_PORT, then 50001. */
  daprPort?: string;
}

export interface DaprModulePubSubOptions {
  defaultName?: string;
  onError?: (name: string, topicName: string, error: any) => DaprPubSubStatusEnum;
}

export enum DaprContextProvider {
  None = 'none',
  ALS = 'als',
  NestCLS = 'nest-cls',
}

export interface DaprModuleOptionsFactory {
  createDaprModuleOptions(): Promise<DaprModuleOptions> | DaprModuleOptions;
}

// Reentrancy is enabled by default, with a max stack depth of 6 calls (which is a sensible default).
// See https://docs.dapr.io/developing-applications/building-blocks/actors/actors-runtime-config/
export const DEFAULT_ACTOR_REENTRANCY_MAX_STACK_DEPTH = 6;
export const DEFAULT_ACTOR_IDLE_TIMEOUT = '15m';
export const DEFAULT_ACTOR_SCAN_INTERVAL = '1m';

export function normalizeDaprModuleOptions(options?: DaprModuleOptions): DaprModuleOptions {
  const normalized = options ?? {};
  // Setup default options for actor clients if not provided.
  if (!normalized.clientOptions) {
    normalized.clientOptions = {};
  }
  if (!normalized.clientOptions.actor) {
    normalized.clientOptions.actor = {
      reentrancy: {
        enabled: true,
        maxStackDepth: DEFAULT_ACTOR_REENTRANCY_MAX_STACK_DEPTH,
      },
      actorIdleTimeout: DEFAULT_ACTOR_IDLE_TIMEOUT,
      actorScanInterval: DEFAULT_ACTOR_SCAN_INTERVAL,
    };
  }
  // Setup default options for workflows if not provided.
  if (!normalized.workflowOptions) {
    normalized.workflowOptions = {
      enabled: true,
    };
  }
  return normalized;
}

export interface DaprModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useExisting?: Type<DaprModuleOptionsFactory>;
  useClass?: Type<DaprModuleOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<DaprModuleOptions> | DaprModuleOptions;
  inject?: any[];
  extraProviders?: Provider[];
}

@Module({})
export class DaprModule {
  static register(options?: DaprModuleOptions): DynamicModule {
    const normalizedOptions = normalizeDaprModuleOptions(options);
    return {
      global: true,
      module: DaprModule,
      imports: [DiscoveryModule, ClsModule],
      providers: [
        { provide: DAPR_MODULE_OPTIONS_TOKEN, useValue: normalizedOptions },
        {
          provide: DaprServer,
          scope: Scope.DEFAULT,
          useValue: new DaprServer({
            serverHost: normalizedOptions.serverHost,
            serverPort: normalizedOptions.serverPort,
            clientOptions: normalizedOptions.clientOptions,
            communicationProtocol: normalizedOptions.communicationProtocol,
          }),
        },
        {
          provide: DaprClient,
          scope: Scope.DEFAULT,
          useFactory: (daprServer: DaprServer) => daprServer.client,
          inject: [DaprServer],
        },
        NestActorManager,
        DaprLoader,
        DaprMetadataAccessor,
        DaprEventSubscriberLoader,
        DaprContextService,
        DaprActorClient,
        DaprPubSubClient,
        DaprWorkflowClient,
        DaprLockClient,
        DaprStateClient,
        DaprEventEmitter,
        ActorRuntimeService,
        Reflector,
        ...(normalizedOptions.extraProviders || []),
      ],
      exports: [
        DaprClient,
        DaprPubSubClient,
        DaprMetadataAccessor,
        DaprContextService,
        ActorRuntimeService,
        DaprActorClient,
        DaprWorkflowClient,
        DaprLockClient,
        DaprStateClient,
        DaprEventSubscriberLoader,
        DaprEventEmitter,
      ],
    };
  }

  static registerAsync(options: DaprModuleAsyncOptions): DynamicModule {
    return {
      global: true,
      module: DaprModule,
      imports: [...(options.imports || []), DiscoveryModule],
      providers: [
        ...this.createAsyncProviders(options),
        {
          provide: DaprServer,
          scope: Scope.DEFAULT,
          useFactory: ({ serverHost, serverPort, communicationProtocol, clientOptions }: DaprModuleOptions) =>
            new DaprServer({
              serverHost,
              serverPort,
              clientOptions,
              communicationProtocol,
            }),
          inject: [DAPR_MODULE_OPTIONS_TOKEN],
        },
        {
          provide: DaprClient,
          scope: Scope.DEFAULT,
          useFactory: (daprServer: DaprServer) => daprServer.client,
          inject: [DaprServer],
        },
        NestActorManager,
        DaprLoader,
        DaprMetadataAccessor,
        DaprEventSubscriberLoader,
        DaprContextService,
        DaprActorClient,
        DaprPubSubClient,
        DaprWorkflowClient,
        DaprLockClient,
        DaprStateClient,
        DaprEventEmitter,
        ActorRuntimeService,
        Reflector,
        ...(options.extraProviders || []),
      ],
      exports: [
        DaprClient,
        DaprMetadataAccessor,
        DaprPubSubClient,
        DaprContextService,
        ActorRuntimeService,
        DaprActorClient,
        DaprWorkflowClient,
        DaprLockClient,
        DaprStateClient,
        DaprEventSubscriberLoader,
        DaprEventEmitter,
      ],
    };
  }

  private static createAsyncProviders(options: DaprModuleAsyncOptions): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: options.useClass,
        useClass: options.useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(options: DaprModuleAsyncOptions): Provider {
    if (options.useFactory) {
      return {
        provide: DAPR_MODULE_OPTIONS_TOKEN,
        useFactory: async (...args: any[]) => normalizeDaprModuleOptions(await options.useFactory(...args)),
        inject: options.inject || [],
      };
    }
    return {
      provide: DAPR_MODULE_OPTIONS_TOKEN,
      useFactory: async (optionsFactory: DaprModuleOptionsFactory) =>
        normalizeDaprModuleOptions(await optionsFactory.createDaprModuleOptions()),
      inject: [options.useExisting || options.useClass],
    };
  }
}
