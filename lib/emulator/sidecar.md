# Dapr Sidecar Emulator

An in-process Express server that emulates the Dapr HTTP sidecar API. Intended for testing without a real Dapr runtime or Docker.

## Usage

```typescript
import { DaprSidecarEmulator } from './sidecar';

const sidecar = new DaprSidecarEmulator({
  host: '127.0.0.1',
  port: 3500,      // where the emulator listens (DAPR_HTTP_PORT)
  appHost: '127.0.0.1',
  appPort: 3000,   // where your NestJS app listens
});

await sidecar.start();
// ... run tests ...
await sidecar.stop();
```

Set environment variables before bootstrapping your NestJS app:

```
DAPR_HTTP_PORT=3500
DAPR_GRPC_PORT=3501   # emulator does not handle gRPC, but the SDK reads this
DAPR_SIDECAR_HOST=127.0.0.1
```

## Emulated routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1.0/healthz` | Health check — returns 200 so the SDK considers the sidecar ready |
| `GET` | `/v1.0/metadata` | Returns app ID and empty component list |
| `POST` | `/v1.0/state/:store` | Save state (array of `{key, value}` items) |
| `GET` | `/v1.0/state/:store/:key` | Get a single state value |
| `DELETE` | `/v1.0/state/:store/:key` | Delete a state key |
| `POST` | `/v1.0/state/:store/bulk` | Bulk get by key array |
| `POST` | `/v1.0/shutdown` | Stops the emulator |
| `POST` | `/v1.0/actors/:type/:id/method/:method` | Proxies actor method call to app (`PUT /actors/...`) |
| `POST` | `/v1.0/actors/:type/:id/state` | Saves actor state (upsert / delete operations) |
| `GET` | `/v1.0/actors/:type/:id/state/:key` | Reads a single actor state key |
| `POST` | `/v1.0/actors/:type/:id/reminders/:name` | Registers a reminder |
| `DELETE` | `/v1.0/actors/:type/:id/reminders/:name` | Cancels a reminder |
| `POST` | `/v1.0/actors/:type/:id/timers/:name` | Registers a timer |
| `DELETE` | `/v1.0/actors/:type/:id/timers/:name` | Cancels a timer |
| `POST` | `/v1.0/publish/:pubsubName/:topic` | Publishes a message; fans out to matching subscribers |
| `POST` | `/v1.0-alpha1/publish/bulk/:pubsubName/:topic` | Bulk publish |

## Actor invocation locking

Concurrent calls to the same actor instance are serialised with `async-lock` (per `actorType::actorId` key), matching real Dapr turn-based concurrency. Reminder and timer callbacks also acquire this lock before calling the app.

## PubSub dispatch

On each publish the emulator calls `GET /dapr/subscribe` on the app to discover subscriptions, then `POST`s to the matched route with `{ data: <payload> }`. Topic wildcards `+` (single segment) and `#` (multi-segment) are supported.

## Duration format

`dueTime`, `period`, and `ttl` fields accept:

- Plain milliseconds: `"500"`
- Duration strings: `"1h30m"`, `"500ms"`, `"10s"`, `"2m30s"`

## Limitations

- gRPC is not emulated — use HTTP mode in the Dapr SDK.
- State store is in-memory only — no TTL, no etag enforcement, no transactions.
- Secrets, configuration, bindings, and workflow APIs are not implemented.
- No distributed tracing headers are injected (passthrough only).
