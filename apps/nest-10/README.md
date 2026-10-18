# nest-10: nest-dapr example (NestJS 10)

Demonstrates Dapr integration with NestJS

## Getting Started

This example is a pnpm workspace member of the root `nest-dapr` repo, and depends on `@rayondigital/nest-dapr`
via `workspace:*` — so it always runs against the local library source, not the published npm package.
This makes it the easiest way to reproduce and fix library issues live:

```bash
# From the repo root
pnpm install         # installs & links workspace members (only needed once, or after adding deps)
pnpm build           # builds packages/nest-dapr, then this app
cd apps/nest-10
pnpm start:dapr:memory
```

After changing anything under `packages/nest-dapr/lib`, just re-run `pnpm build` at the repo root and restart the app —
no republish or reinstall needed.

## Dapr Setup

Ensure Dapr Cli is installed. See https://docs.dapr.io/getting-started/install-dapr-cli/
```bash
winget install Dapr.CLI
# OR
brew install dapr/tap/dapr-cli
```

You can use Dapr locally or Docker compose using 
```bash
dapr init
```

To use docker compose & Dapr

```bash
docker compose up
```

## Run the application

The ports are:

| Service              | Port |
|----------------------| --- |
| NestJS               | 3000 |
| Dapr (NodeJS) | 3001 |
| Dapr Sidecar         | 3500 |
| Dapr Sidecar (gRPC, workflows) | 3501 |

The quickest way to run locally, with no external dependencies (in-memory pubsub/state store):

```bash
pnpm start:dapr:memory
```

Or against Redis pubsub/state via `./components` (see `docker-compose.yml` for Redis/Azurite):

```bash
pnpm start:dapr
# equivalent to:
dapr run --app-id basics --app-protocol http --app-port 3001 --dapr-http-port 3500 --dapr-grpc-port 3501 pnpm start
```

## PubSub test

Invoke endpoint to publish message

```bash
curl -X POST localhost:3000/pubsub
```

Observe handler received message

## Resiliency

Un-comment the `BadRequestException` throw to simulate handler failure

Observe retries defined in the resilience policy


## Actor test

Invoke the counter endpoint to increment the counter

```bash
curl -X POST localhost:3000/counter/counter-1/increment
```

Observe the counter value

```bash
curl localhost:3000/counter/counter-1
```

Observer the global counter value

```bash
curl localhost:3000/counter/global
```

## Workflow test

`GreetingWorkflow` (see `src/workflow`) demonstrates a simple workflow with a human-in-the-loop step: it calls
an activity to build a greeting, then pauses and waits for an `approve` event before calling a second activity
to shout it back, then completes.

Start the workflow:

```bash
curl -X POST localhost:3000/workflow/greeting -H "Content-Type: application/json" -d '{"name":"World"}'
# {"instanceId":"<id>"}
```

Check its status — it should be parked waiting for approval:

```bash
curl localhost:3000/workflow/<id>
# {"runtimeStatus":0,"customStatus":"waiting-for-approval",...}
```

Approve it to let it continue:

```bash
curl -X POST localhost:3000/workflow/<id>/events/approve
```

Check its status again — it should now be completed:

```bash
curl localhost:3000/workflow/<id>
# {"runtimeStatus":1,"customStatus":"done","output":"HELLO, WORLD!",...}
```
