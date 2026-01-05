import { AbstractActor, DaprPubSubStatusEnum, DaprServer, WorkflowRuntime } from '@dapr/dapr';
import Class from '@dapr/dapr/types/Class';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
  Type,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, ModuleRef } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { DaprActorClient } from './actors/dapr-actor-client.service';
import { NestActorManager } from './actors/nest-actor-manager';
import { DaprContextService } from './dapr-context-service';
import { DaprMetadataAccessor } from './dapr-metadata.accessor';
import { DAPR_MODULE_OPTIONS_TOKEN, DaprContextProvider, DaprModuleOptions } from './dapr.module';
import { DaprPubSubClient } from './pubsub/dapr-pubsub-client.service';
import { DaprWorkflowClient } from './workflow/dapr-workflow-client.service';
import { lazyWorkflow, Workflow } from './workflow/workflow';
import { lazyActivity, WorkflowActivity } from './workflow/workflow-activity';

@Injectable()
export class DaprLoader implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DaprLoader.name);
  private workflowRuntime: WorkflowRuntime;

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly daprServer: DaprServer,
    private readonly daprMetadataAccessor: DaprMetadataAccessor,
    @Inject(DAPR_MODULE_OPTIONS_TOKEN)
    private readonly options: DaprModuleOptions,
    private readonly daprActorClient: DaprActorClient,
    private readonly moduleRef: ModuleRef,
    private readonly contextService: DaprContextService,
    private readonly pubSubClient: DaprPubSubClient,
    private readonly workflowClient: DaprWorkflowClient,
    private readonly actorManager: NestActorManager,
  ) {}

  async onModuleInit() {
    if (this.options.handlers?.onInitialized) {
      await this.options.handlers.onInitialized(this.options);
    }
  }

  async onApplicationBootstrap() {
    this.logger.log('Dapr initializing');

    const isEnabled = !this.options.disabled;
    const isActorsEnabled = this.options.actorOptions?.enabled ?? true;
    const isWorkflowEnabled = this.options.workflowOptions?.enabled ?? false;

    // Hook into Dapr functions (patch them to support context propagation, reentrancy, otel, etc.)
    if (isActorsEnabled) {
      // Hook into the Dapr Actor Manager
      this.actorManager.setup(this.moduleRef, this.options);
      // Setup CLS/ALS for async context propagation
      if (this.options.contextProvider !== DaprContextProvider.None) {
        this.actorManager.setupCSLWrapper(this.options, this.contextService);
      }
      if (this.options.clientOptions?.actor?.reentrancy?.enabled) {
        this.actorManager.setupReentrancy(this.options);
      }
      // Setup the actor client (based on the options provided)
      if (this.options.actorOptions) {
        this.daprActorClient.setAllowInternalCalls(this.options.actorOptions?.allowInternalCalls ?? false);
      }
    }

    if (isActorsEnabled && isEnabled) {
      this.logger.log('Registering Dapr actors');
      await this.daprServer.actor.init();
    }

    if (isWorkflowEnabled) {
      // Setup the Workflow Runtime
      this.workflowRuntime = new WorkflowRuntime({
        daprHost: this.options.serverHost,
        daprPort: this.options.workflowOptions?.daprPort ?? '3501',
      });
    }

    if (this.options.pubsubOptions?.defaultName) {
      this.pubSubClient.setDefaultName(this.options.pubsubOptions.defaultName);
    }

    await this.loadDaprHandlers(isActorsEnabled, isWorkflowEnabled);

    if (isEnabled && this.options.serverPort !== '0') {
      this.logger.log('Starting Dapr server');

      if (this.options.catchErrors) {
        // We need to add error handling middleware to the Dapr server
        const server = this.daprServer.daprServer.getServer(); // Express JS
        if (server) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          server.use((err, req, res, next) => {
            // Catch any errors, log them and return a 500
            if (err) {
              this.logger.error(err, err.stack, 'DaprServer');
              res.status(500).send(err);
            }
          });
        }
      }

      // Allow middleware to be run before the server starts
      if (this.options.handlers?.onServerStarting) {
        await this.options.handlers.onServerStarting(this.daprServer);
      }

      await this.daprServer.start();
      this.logger.log('Dapr server started');
    }

    if (isEnabled && isWorkflowEnabled) {
      this.logger.log('Starting Dapr workflow runtime');
      await this.workflowRuntime.start();
      await this.workflowClient.start({
        daprHost: this.options.serverHost,
        daprPort: this.options.workflowOptions.daprPort ?? '3501',
      });
    }

    if (this.options.handlers?.onServerStarted) {
      await this.options.handlers.onServerStarted(this.daprServer);
    }

    if (!isActorsEnabled || !isEnabled) return;

    const registeredActors = await this.daprServer.actor.getRegisteredActors();
    if (registeredActors.length > 0) {
      this.logger.log(`Registered Actors: ${registeredActors.join(', ')}`);
    }
  }

  async onApplicationShutdown() {
    if (this.workflowRuntime && this.options.workflowOptions.enabled) {
      this.logger.log('Stopping Dapr workflow runtime');
      try {
        await this.workflowRuntime.stop();
        await this.workflowClient.stop();
      } catch {
        // Ignore errors
      } finally {
        this.logger.log('Dapr workflow runtime stopped');
      }
    }

    this.logger.log('Stopping Dapr server');
    try {
      if (!this.options.disabled) {
        await this.daprServer.stop();
      }
    } catch {
      // Ignore errors
    } finally {
      this.logger.log('Dapr server stopped');
    }
  }

  async loadDaprHandlers(isActorsEnabled: boolean, isWorkflowEnabled: boolean) {
    const providers = this.discoveryService.getProviders();

    // Find and register actors
    if (isActorsEnabled) {
      for (const instanceWrapper of providers.filter(
        (wrapper) =>
          wrapper.isDependencyTreeStatic() &&
          wrapper.metatype &&
          this.daprMetadataAccessor.getDaprActorMetadata(wrapper.metatype),
      )) {
        await this.registerActor(instanceWrapper.metatype);
      }
    }

    // Find and register pubsub and binding handlers
    const controllers = this.discoveryService.getControllers();
    for (const instanceWrapper of [...providers, ...controllers]
      .filter((wrapper) => wrapper.isDependencyTreeStatic())
      .filter((wrapper) => wrapper.instance)) {
      await this.registerHandlers(instanceWrapper);
    }

    // Find and register workflow activities
    if (isWorkflowEnabled) {
      for (const instanceWrapper of providers.filter(
        (wrapper) =>
          wrapper.isDependencyTreeStatic() &&
          wrapper.metatype &&
          this.daprMetadataAccessor.getDaprActivityMetadata(wrapper.metatype),
      )) {
        await this.registerActivity(instanceWrapper.metatype);
      }

      // Find and register workflow orchestrations
      for (const instanceWrapper of providers.filter(
        (wrapper) =>
          wrapper.isDependencyTreeStatic() &&
          wrapper.metatype &&
          this.daprMetadataAccessor.getDaprWorkflowMetadata(wrapper.metatype),
      )) {
        await this.registerWorkflow(instanceWrapper.metatype);
      }
    }
  }

  private async subscribeToDaprPubSubEventIfListener(instance: Record<string, any>, methodKey: string) {
    const daprPubSubMetadata = this.daprMetadataAccessor.getDaprPubSubHandlerMetadata(instance[methodKey]);
    if (!daprPubSubMetadata) {
      return;
    }
    const name = daprPubSubMetadata.name ?? this.options.pubsubOptions?.defaultName;
    const { topicName, route } = daprPubSubMetadata;

    this.logger.log(`Subscribing to Dapr: ${name}, Topic: ${topicName}${route ? ' on route ' + route : ''}`);
    await this.daprServer.pubsub.subscribe(
      name,
      topicName,
      async (data: any) => {
        try {
          // The first argument will be the data.
          // The method invoked can be a void method or return a DaprPubSubStatusEnum value
          const result = await instance[methodKey].call(instance, data);
          // If the result is a DaprPubSubStatusEnum then return it, otherwise assume success
          if (result && result in DaprPubSubStatusEnum) {
            return result;
          }
          // If no exception has occurred, then return success
          return DaprPubSubStatusEnum.SUCCESS;
        } catch (err) {
          this.logger.error(err, `Error in pubsub handler ${topicName}`);
          // If there is an error handler then use it.
          if (this.options.pubsubOptions?.onError) {
            const response = this.options.pubsubOptions?.onError(name, topicName, err);
            if (response == DaprPubSubStatusEnum.RETRY) {
              this.logger.log(`Retrying pubsub handler ${topicName} operation`);
            } else if (response == DaprPubSubStatusEnum.DROP) {
              this.logger.debug(`Dropping message from ${topicName}`);
            }
            return response;
          }
          // The safest default return type is retry.
          this.logger.log(`Retrying pubsub handler ${topicName} operation`);
          return DaprPubSubStatusEnum.RETRY;
        }
      },
      route,
    );
  }

  private async subscribeToDaprBindingEventIfListener(instance: Record<string, any>, methodKey: string) {
    const daprBindingMetadata = this.daprMetadataAccessor.getDaprBindingHandlerMetadata(instance[methodKey]);
    if (!daprBindingMetadata) {
      return;
    }
    const { name } = daprBindingMetadata;

    this.logger.log(`Registering Dapr binding: ${name}`);
    await this.daprServer.binding.receive(name, async (data: any) => {
      await instance[methodKey].call(instance, data);
    });
  }

  private async registerHandlers(instanceWrapper: InstanceWrapper) {
    const instance = instanceWrapper.instance;
    const prototype = Object.getPrototypeOf(instance) || {};
    this.metadataScanner.scanFromPrototype(instance, prototype, async (methodKey: string) => {
      await this.subscribeToDaprPubSubEventIfListener(instance, methodKey);
      await this.subscribeToDaprBindingEventIfListener(instance, methodKey);
    });
  }

  private async registerActivity<T>(activityType: Type<T> | Function) {
    if (!activityType) return;

    const metadata = this.daprMetadataAccessor.getDaprActivityMetadata(activityType);
    const activityTypeName = metadata.name ?? activityType.name ?? activityType.constructor.name;

    // Check that the activity type has a run method
    if (!activityType.prototype.run) {
      this.logger.error(`Activity ${activityTypeName} does not have a run method`);
      return;
    }

    this.logger.log(`Registering Dapr Activity: ${activityTypeName}`);
    this.workflowRuntime.registerActivityWithName(
      activityTypeName,
      lazyActivity(this.moduleRef, activityType as Type<WorkflowActivity>),
    );
  }

  private async registerWorkflow<T>(workflowType: Type<T> | Function) {
    if (!workflowType) return;

    const metadata = this.daprMetadataAccessor.getDaprWorkflowMetadata(workflowType);
    const workflowTypeName = metadata.name ?? workflowType.name ?? workflowType.constructor.name;

    // Check that the workflow type has a run method
    if (!workflowType.prototype.run) {
      this.logger.error(`Workflow ${workflowTypeName} does not have a run method`);
      return;
    }

    this.logger.log(`Registering Dapr Workflow: ${workflowTypeName}`);
    this.workflowRuntime.registerWorkflowWithName(
      workflowTypeName,
      lazyWorkflow(this.moduleRef, workflowType as Type<Workflow>),
    );
  }

  private async registerActor<T>(actorType: Type<T> | Function) {
    if (!actorType) return;

    // We need to get the @DaprActor decorator metadata
    const daprActorMetadata = this.daprMetadataAccessor.getDaprActorMetadata(actorType);
    const actorTypeName = actorType.name ?? actorType.constructor.name;
    const interfaceTypeName =
      daprActorMetadata?.interfaceType?.name ?? daprActorMetadata?.interfaceType?.constructor.name;

    await this.daprServer.actor.registerActor(actorType as Class<AbstractActor>);

    this.logger.log(`Registering Dapr Actor: ${actorTypeName} of type ${interfaceTypeName ?? 'unknown'}`);

    // Register the base actor type as a client
    this.daprActorClient.register(actorTypeName, actorType, this.daprServer.client);
    // If an interface is provided, register the interface as a client
    if (daprActorMetadata.interfaceType) {
      this.daprActorClient.registerInterface(actorType, daprActorMetadata.interfaceType, this.daprServer.client);
    }
    return actorTypeName;
  }
}
