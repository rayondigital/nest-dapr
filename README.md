[![npm version](https://badge.fury.io/js/@rayondigital%2Fnest-dapr.svg)](https://badge.fury.io/js/@rayondigital%2Fnest-dapr)

# NestJS + Dapr
Develop NestJs microservices using [Dapr](https://dapr.io/) pubsub, actors and bindings.

# Description

Dapr Module for [Nest](https://github.com/nestjs/nest) built on top of the latest [Dapr JS SDK](https://github.com/dapr/js-sdk).
Additional monkey patches are applied to the SDK to support NestJS dependency injection, decorators, observability and lifecycle hooks.


# Supported features
- [x] [Actors](https://docs.dapr.io/developing-applications/building-blocks/actors/actors-overview/)
- [x] [PubSub](https://docs.dapr.io/developing-applications/building-blocks/pubsub/pubsub-overview/)
- [x] [Bindings](https://docs.dapr.io/developing-applications/building-blocks/bindings/bindings-overview/)
- [x] [Workflows](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/)
- [x] [Distributed Lock](https://docs.dapr.io/developing-applications/building-blocks/distributed-lock/)
- [x] [State](https://docs.dapr.io/developing-applications/building-blocks/state-management/state-management-overview/)
- [ ] [Service Invocation](https://docs.dapr.io/developing-applications/building-blocks/service-invocation/service-invocation-overview/)


# Installation

```bash
npm i @rayondigital/nest-dapr
```

## Peer dependencies

This library depends on:
- `nestjs-cls`
- `eventemitter2`
- `rxjs`
- `@opentelemetry/api`

`nest-dapr` declares its NestJS-ecosystem dependencies as [peer dependencies](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#peerdependencies) rather than bundling its own copies, so your app shares a single instance of them — this matters in particular for `nestjs-cls`, whose context propagation depends on there being exactly one shared instance across your app.

Depending on your package manager, peer dependencies aren't always installed automatically. `nestjs-cls`, `eventemitter2` and `@opentelemetry/api` are required from the moment you import `DaprModule` (not optional), so if you hit `Cannot find module 'nestjs-cls'` or similar, install them explicitly:

```bash
npm i nestjs-cls eventemitter2 @opentelemetry/api
```

A standard Nest project (scaffolded via `nest new`) already provides the remaining peer dependencies — `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` and `rxjs`.

# Requirements

Install [Dapr](https://dapr.io/) as per getting started [guide](https://docs.dapr.io/getting-started/). Ensure Dapr is running with

```bash
dapr --version
```

Output:

```
CLI version: 1.15.1
Runtime version: 1.15.4
```

# Quick start

The following scaffolds a [Nest](https://github.com/nestjs/nest) project with the [nest-dapr](https://www.npmjs.com/package/@rayondigital/nest-dapr) package and demonstrates using Nest with Dapr using actors and [RabbitMQ](https://www.rabbitmq.com/) pubsub bindings.

Install Nest [CLI](https://docs.nestjs.com/cli/overview)

```bash
npm install -g @nestjs/cli
```

Scaffold Nest project

```
nest new nest-dapr
cd nest-dapr/
```

Install [nest-dapr](https://www.npmjs.com/package/@rayondigital/nest-dapr) package

```bash
npm i --save @rayondigital/nest-dapr
```

Import `DaprModule` in `AppModule` class

```typescript
@Module({
  imports: [DaprModule.register()],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

Import `DaprClient` from `@dapr/dapr` package and add dependency to `AppController` class

```typescript
import { DaprClient } from '@dapr/dapr';
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly daprClient: DaprClient,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
```

## Actors

> Note: Actors communicate via HTTP and require the Dapr sidecar to be running with HTTP enabled. See [DaprServer](#dapr-server) section for more information.
> The port for HTTP is set in the `DAPR_HTTP_PORT` environment variable.
> Actors may communicate over gRPC in the future, but this is not yet supported.

Create actors and connect them to your NestJS application using the `@DaprActor` decorator.
This decorator takes in the interface of the actor, and marks the Actor as transient inside the NestJS
dependency injection container.
Ensure your actor classes are added to the `providers` array of your NestJS module.

```typescript
// You must expose your actors interface as an abstract class because Typescript interfaces are not available at runtime (erasure).
// Having the interface as an abstract class allows us to call the actor by only knowing the interface type.
export abstract class CounterActorInterface {
  abstract increment(): Promise<number>;
  abstract getCounter(): Promise<number>;
}

@DaprActor({
  interfaceType: CounterActorInterface,
})
export class CounterActor
  extends StatefulActor
  implements CounterActorInterface
{
  // You can inject other NestJS services into your actor.
  // Only Singleton services are supported at this time.
  @Inject(CacheService)
  private readonly cacheService: CacheService;

  counter: number;

  async onActivate(): Promise<void> {
    this.counter = await this.getState('counter', 0);
    return super.onActivate();
  }

  async increment(): Promise<number> {
    this.counter++;
    // Use a NestJS service as an example.
    // Share in memory state between actors on this node.
    // You probably will never want to do this, but we're just demonstrating a singleton service.
    await this.cacheService.increment('total');

    await this.setState('counter', this.counter);
    await this.saveState();
    return this.counter;
  }

  async getCounter(): Promise<number> {
    return this.counter;
  }
}
```

### Actor Client

This module provides the `DaprActorClient` which is a NestJS service.
It can be injected into controllers, services, handlers and other actors.
It acts as a proxy service to the actors, and allows you to call methods on the actors - similar to the Orleans GrainFactory.

```typescript
@Controller()
export class CounterController {
  constructor(
    private readonly actorClient: DaprActorClient,
  ) {}

  @Get(":id")
  async increment(@Param("id") id: string): Promise<string> {
    const value = await this.actorClient
      .getActor(CounterActorInterface, id)
      .increment();
    return `Counter incremented to ${value}`;
  }
}
```

## Workflows

> Note: Workflows communicate via GRPC and require the Dapr sidecar to be running with GRPC enabled. See [DaprServer](#dapr-server) section for more information.
> The port for GRPC is set in the `DAPR_GRPC_PORT` environment variable.

Workflows and Activities are annotated with the `@DaprWorkflow` and `@DaprActivity` decorators respectively.
When added to the `providers` array of a NestJS module, they are automatically registered with the Dapr server.

Note: Take care to ensure that your activities are stateless, and idempotent.
Be very careful with the state, and services you have inside your workflows.


```typescript   
@DaprActivity()
export class HelloActivity implements WorkflowActivity<string, string> {
  async run(context: WorkflowActivityContext, name: string): Promise<string> {
    return `Hello ${name}!`;
  }
}

@DaprActivity()
export class CreateEntityActivity implements WorkflowActivity<string, Entity> {
  @Inject()
  private readonly entityService: EntityService;

  constructor(private readonly cacheService: CacheService) {}

  async run(context: WorkflowActivityContext, id: string): Promise<Entity> {
    const entity: Entity = { id: id, createdAt: new Date(), lastUpdatedAt: new Date(), status: 'created', data: {} };
    await this.entityService.update(entity);
    console.log('entity', entity);
    return entity;
  }
}

@DaprActivity()
export class GetEntityActivity implements WorkflowActivity<string, Entity> {
  @Inject()
  private readonly entityService: EntityService;

  constructor(private readonly cacheService: CacheService) {}

  async run(context: WorkflowActivityContext, id: string): Promise<Entity> {
    const entity = await this.entityService.get(id);
    console.log('entity', entity);
    return entity;
  }
}

@DaprWorkflow()
export class HelloWorkflow implements Workflow<string[], string> {
  async *run(ctx: WorkflowContext, input: string): AsyncGenerator<unknown, string[]> {
    const cities: string[] = [];

    let entity = expect<Entity>(yield ctx.callActivity(CreateEntityActivity, '12345'));
    ctx.setCustomStatus('Entity');

    entity = expect<Entity>(yield ctx.callActivity(GetEntityActivity, '12345'));
    console.log('entity', entity);
    ctx.setCustomStatus('Entity');

    const result1 = expect<string>(yield ctx.callActivity(HelloActivity, 'Tokyo'));
    ctx.setCustomStatus('Tokyo');

    const event = yield ctx.waitForExternalEvent('next');
    console.log('event', event);

    const result2 = expect<string>(yield ctx.callActivity(HelloActivity, 'Seattle'));
    ctx.setCustomStatus('Seattle');

    const result3 = expect<string>(yield ctx.callActivity(HelloActivity, 'London'));
    ctx.setCustomStatus('London');

    return cities;
  }
}
```

### Workflow Client

```typescript
@Controller()
export class WorkflowController {
  constructor(
    private readonly workflowClient: DaprWorkflowClient,
  ) {}

  @Get(":id")
  async start(@Param("id") uuid: string): Promise<string> {
    const id = await workflowClient.scheduleNewWorkflow(HelloWorkflow, 'Hello', uuid);
    // Workflow is started, and the id is returned.
    // You can wait for the workflow to start and get the initial state.
    const initialState = await workflowClient.waitForWorkflowStart(id, undefined, 15);
    
    // You can raise events
    // await workflowClient.raiseEvent(id, 'next', { input: 'next' });
    
    // Optionally you can also wait for it to complete.
    // const state = await workflowClient.waitForWorkflowCompletion(id, undefined, 15);
    // Use the workflowOutput helper to get typed variables
    // const value = workflowOutput(HelloWorkflow, state);
    return { 
      id: id,
      state: initialState
    }
  }
}
```

## Distributed Lock

`DaprLockClient` is a thin NestJS-friendly wrapper around the Dapr JS SDK's [Distributed Lock API](https://docs.dapr.io/developing-applications/building-blocks/distributed-lock/), injectable via DI like any other Nest provider.

```typescript
@Injectable()
export class OrderService {
  constructor(private readonly lockClient: DaprLockClient) {}

  async processOrder(orderId: string) {
    // Acquires the lock, runs the callback, and always releases the lock afterwards
    // (even if the callback throws). Throws DaprLockAcquisitionError if the lock
    // is already held by someone else.
    return this.lockClient.withLock(
      orderId,
      async () => {
        // Critical section protected by the distributed lock
        return this.doProcessOrder(orderId);
      },
      { expiryInSeconds: 30, storeName: 'lockstore' },
    );
  }

  async tryProcessOrder(orderId: string) {
    // Or manage the lock manually
    const lockOwner = randomUUID();
    const acquired = await this.lockClient.tryLock(orderId, lockOwner, 30);
    if (!acquired) {
      return false;
    }
    try {
      await this.doProcessOrder(orderId);
    } finally {
      await this.lockClient.unlock(orderId, lockOwner);
    }
    return true;
  }
}
```

The default lock store name (`lockstore`) can be changed via `lockClient.setDefaultName('my-lock-store')`, or overridden per-call via the `storeName` argument/option.

## State Management

`DaprStateClient` is a thin NestJS-friendly wrapper around the Dapr JS SDK's [State Management API](https://docs.dapr.io/developing-applications/building-blocks/state-management/), injectable via DI like any other Nest provider.

It has two tiers of methods:
- **Raw** (`getRawValue`, `setRawValue`, `getBulk`, `save`, `delete`, `transaction`) — exactly what the SDK returns, no decompression, no hydration.
- **Typed** (`getObject`, `saveObject`) — compression-aware, and will call `toJSON`/`fromJSON` on your value automatically if it looks like one.

```typescript
class Order implements IState {
  id: string;
  total: number;

  toJSON() {
    return { id: this.id, total: this.total };
  }

  fromJSON(json: any): this {
    this.id = json.id;
    this.total = json.total;
    return this;
  }
}

@Injectable()
export class OrderService {
  constructor(private readonly stateClient: DaprStateClient) {}

  async saveOrder(order: Order) {
    // Calls order.toJSON() automatically, and gzip-compresses it before saving
    await this.stateClient.saveObject(order.id, order, { compressed: true });
  }

  async getOrder(id: string): Promise<Order> {
    // Decompresses (if needed) and calls Order.fromJSON() to restore the type
    return this.stateClient.getObject(id, Order);
  }

  async getOrderRaw(id: string) {
    // No hydration — exactly what the state store returns
    return this.stateClient.getRawValue(id);
  }
}
```

The default state store name (`statestore`) can be changed via `stateClient.setDefaultName('my-state-store')`, or overridden per-call via the `storeName` argument.

> Note: `query()` is intentionally not exposed. Only a handful of state store components support querying, and Dapr has flagged the entire state-query feature for deprecation in a future release.

## PubSub

Create pubsub & topic names used for pubsub operations and message interface

```typescript
const pubSubName = 'my-pubsub';
const topicName = 'my-topic';

interface Message {
  hello: string;
}

@Controller()
```

Create endpoint to publish topic message

```typescript
@Post('pubsub')
async pubsub(): Promise<boolean> {
  const message: Message = { hello: 'world' };

  return this.daprClient.pubsub.publish(pubSubName, topicName, message);
}
```

Create pubsub handler which will subscribe to the topic and log the received message

```typescript
@DaprPubSub(pubSubName, topicName)
pubSubHandler(message: Message): void {
  console.log(`Received topic:${topicName} message:`, message);
}
```

Create Dapr [pubsub](https://docs.dapr.io/developing-applications/building-blocks/pubsub/) component in `components` folder

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: my-pubsub
  namespace: default
spec:
  type: pubsub.rabbitmq
  version: v1
  metadata:
  - name: host
    value: amqp://guest:guest@localhost:5674
```
Save file as `components/rabbitmq-pubsub.yaml`

Create `docker-compose.yml` in the project root used to run [RabbitMQ](https://www.rabbitmq.com/)

```yaml
version: '3.9'
services:
  pubsub:
    image: rabbitmq:3-management-alpine
    ports:
      - 5674:5672
      - 15674:15672
```

Start RabbitMQ

```bash
docker-compose up
```

Create script to bootstrap your Nest project using Dapr sidecar. Update `package.json` and add script

```json
"scripts": {
  ..
  "start:dapr": "dapr run --app-id nest-dapr --app-protocol http --app-port 50001 --dapr-http-port 50000 --components-path ./components npm run start"
},
```

Start Nest app with Dapr

```bash
npm run start:dapr
```

Invoke endpoint to publish the message

```bash
curl -X POST localhost:3000/pubsub
```

This should publish a message to RabbitMQ which should be consumed by the handler and written to the console:

```
== APP == Received topic:my-topic message: { hello: 'world' }
```

Full example

```typescript
import { DaprClient } from '@dapr/dapr';
import { DaprPubSub } from '@rayondigital/nest-dapr';
import { Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service';

const pubSubName = 'my-pubsub';
const topicName = 'my-topic';

interface Message {
  hello: string;
}

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly daprClient: DaprClient,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('pubsub')
  async pubsub(): Promise<boolean> {
    const message: Message = { hello: 'world' };

    return this.daprClient.pubsub.publish(pubSubName, topicName, message);
  }

  @DaprPubSub(pubSubName, topicName)
  pubSubHandler(message: Message): void {
    console.log(`Received topic:${topicName} message:`, message);
  }
}
```

# DaprModule

`DaprModule` is a global Nest [Module](https://docs.nestjs.com/modules) used to register `DaprServer` & `DaprClient` as [providers](https://docs.nestjs.com/providers) within your project. It also registers all your handlers which listen to Dapr pubsub and input bindings so that when messages are received by Dapr, they are forwarded to the handler. Handler registration occurs during the `onApplicationBootstrap` lifecycle hook.

To use `nest-dapr`, import the `DaprModule` into the root `AppModule` and run the `register()` static method.

```typescript
@Module({
  imports: [DaprModule.register()],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

`register()` takes an optional `DaprModuleOptions` object which allows passing arguments to `DaprServer` instance.

```typescript
export interface DaprModuleOptions {
  serverHost?: string;
  serverPort?: string;
  daprHost?: string;
  daprPort?: string;
  communicationProtocol?: CommunicationProtocolEnum;
  clientOptions?: DaprClientOptions;
}
```

See Dapr JS [docs](https://docs.dapr.io/developing-applications/sdks/js/js-server/) for more information about these arguments.

## Async configuration

You can pass your options asynchronously instead of statically. In this case, use the `registerAsync()` method, which provides several ways to deal with async configuration. One of which is to use a factory function:

```typescript
DaprModule.registerAsync({
  imports: [ConfigModule],
  useFactory: (configService: ConfigService) => ({
    serverHost: configService.get('DAPR_SERVER_HOST'),
    serverPort: configService.get('DAPR_SERVER_PORT'),
    daprHost: configService.get('DAPR_HOST'),
    daprPort: configService.get('DAPR_PORT'),
    communicationProtocol: CommunicationProtocolEnum.GRPC,
    clientOptions: {
      logger: {
        level: LogLevel.Verbose,
      },
    },
  }),
  inject: [ConfigService],
})
```

# DaprServer & DaprClient providers

`DaprModule` registers [DaprServer](https://docs.dapr.io/developing-applications/sdks/js/js-server/) and [DaprClient](https://docs.dapr.io/developing-applications/sdks/js/js-client/) as Nest [providers](https://docs.nestjs.com/providers). These can be injected into your controllers and services like any other provider.

```typescript
import { DaprClient } from '@dapr/dapr';
import { Controller, Post } from '@nestjs/common';

@Controller()
export class AppController {
  constructor(readonly daprClient: DaprClient) {}

  @Post()
  async pubsub(): Promise<boolean> {
    return this.daprClient.pubsub.publish('my-pub-sub', 'my-topic', {
      hello: 'world',
    });
  }
}
```

# Dapr decorators

`nest-dapr` provides two TypeScript [decorators](https://www.typescriptlang.org/docs/handbook/decorators.html#decorators) which are used to declaratively configure subscriptions and bindings. These are used by `DaprModule` in conjunction with the handler method to define the handler implementations.

## DaprPubSub decorator

`DaprPubSub` decorator is used to set-up a handler for receiving pubsub topic messages. The handler has 3 arguments (`name`, `topicName` & `route`). `name` specifies the pubsub component `name` as defined in the Dapr component `metadata` section. `topicName` is the name of the pubsub topic. Route is an optional argument and defines possible [routing](https://docs.dapr.io/developing-applications/building-blocks/pubsub/howto-route-messages/) values.

Example:

```typescript
@DaprPubSub('my-pubsub', 'my-topic')
pubSubHandler(message: any): void {
  console.log('Received message:', message);
}
```

RabbitMQ pubsub Component:

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: my-pubsub
  namespace: default
spec:
  type: pubsub.rabbitmq
  version: v1
  metadata:
  - name: host
    value: amqp://guest:guest@localhost:5674
```

Publish message:

```typescript
await this.daprClient.pubsub.publish('my-pubsub', 'my-topic', { hello: 'world' });
```

In this example the handler `pubSubHandler` method will receive messages from the `my-topic` topic through the `my-pubsub` component which in this case is RabbitMQ.

## DaprBinding decorator

`DaprBinding` decorator is used to set-up a handler for receiving input binding data. The handler has one argument `name` which specifies the binding component `name` as defined in the Dapr component `metadata` section.

Example:

```typescript
@DaprBinding('my-queue-binding')
bindingHandler(message: any): void {
  coneole.log('Received message:', message);
}
```

RabbitMQ binding component:

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: my-queue-binding
  namespace: default
spec:
  type: bindings.rabbitmq
  version: v1
  metadata:
  - name: queueName
    value: queue1
  - name: host
    value: amqp://guest:guest@localhost:5674
  - name: durable
    value: true
  - name: deleteWhenUnused
    value: false
  - name: ttlInSeconds
    value: 60
  - name: prefetchCount
    value: 0
  - name: exclusive
    value: false
  - name: maxPriority
    value: 5
  - name: contentType
    value: "text/plain"
```

Send message:

```typescript
await this.daprClient.binding.send('my-queue-binding', 'create', { hello: 'world' });
```

In this example the handler `bindingHandler` method will receive messages from the `queue1` queue defined in the `my-queue-binding` component which in this case is RabbitMQ.

## Writing handlers

`DaprModule` uses reflection to register all handlers found either in [Controller](https://docs.nestjs.com/controllers) or [Provider](https://docs.nestjs.com/providers) classes. These classes must be registered in a Nest [module](https://docs.nestjs.com/modules). Providers must be decorated with the `@Injectable()` decorator at the class level. Once this is done and your provider is added to your module's [providers] array then `nest-dapr` will use Nest dependency injection container to resolve the provider instance and call your handler when the message is received.

Here's an example of a [Provider](https://docs.nestjs.com/providers) containing a Dapr handler.

```typescript
import { DaprPubSub } from '@rayondigital/nest-dapr';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  @DaprPubSub('my-pubsub', 'my-topic')
  pubSubHandler(message: any): void {
    this.logger.log(`Received topic message:`, message);
  }
}
```

# Examples

| Example | Description                                                             |
|---|-------------------------------------------------------------------------|
| [Basics](examples/basics/README.md) | Demonstrates a very basic actors, pubsub & input binding using RabbitMQ |

# Dapr Server

Whilst testing you will need to run a Dapr sidecar:

- HTTP Transport `dapr run --app-id nest-dapr --app-protocol http --dapr-http-port 3500 --app-port 3001 --log-level debug`
- gRPC Transport `dapr run --app-id nest-dapr --app-protocol grpc --dapr-grpc-port 3501 --app-port 3001 --log-level debug`
- Dual Mode (HTTP and gRPC) `dapr run --app-id nest-dapr --dapr-http-port 3500 --dapr-grpc-port 3501 --app-port 3001 --app-protocol grpc --app-protocol http`

For testing components are defined in tests/components:

```shell
dapr run --app-id testing --app-protocol http --app-port 3001 --dapr-http-port 3500 --dapr-grpc-port 3501 --resources-path ./tests/components
```

Note: On Windows the dapr sidecar may need to be run in an administrator terminal.

# Troubleshooting

[Dapr](https://dapr.io/) is a complex set of tools and services and must be set-up and deployed carefully to ensure your system operates correctly. 
This library is merely integration using the existing Dapr [js-sdk](https://github.com/dapr/js-sdk). 
If things are not working out for you please review:
- Your configuration
- Your Dapr local environment
- Your port numbers and hostnames
- Dapr & SDK documentation
- The tests and examples in this project

If you find that both Dapr and the Javascript SDK is both working fine but `nest-dapr` is not working in some way, 
please file an issue and state clearly the problem and provide a reproducible code example. 
Filing an issue with something like: "It doesn't work" is likely to be ignored or removed.

# Credits/Contributions :heart:

Thanks to:

- [@dbc-tech/nest-dapr](https://github.com/nad-au/nest-dapr) - We forked from this repository
- [nad-au](https://github.com/nad-au) - Worked on pubsub and initial integration
- [dapr-nestjs-pubsub](https://github.com/avifatal/dapr-nestjs-pubsub) - The original library
- [@dapr/dapr](https://github.com/dapr/js-sdk) - Development team
- [Nest](https://github.com/nestjs/nest) - Development team

# Licence

Released under the [MIT](LICENSE) license. No warranty expressed or implied.